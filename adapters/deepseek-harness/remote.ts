/** Read-only peer memory client for DSH. */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";

import type {
  RuntimeNamespace,
  RetrievalQueryDTO,
  RetrievalResultDTO,
  TraceDTO,
} from "../../agent-contract/dto.js";

export interface MemoryRemoteConfig {
  enabled: boolean;
  url: string;
  tokenFile: string;
  tunnelFile?: string;
}

export interface DshRemoteMemoryOptions {
  config: () => MemoryRemoteConfig;
  localPort: number;
  /** Test seam. Production uses node:child_process.spawn without a shell. */
  spawn?: typeof spawn;
  /** Test seam for the loopback health probe. */
  fetch?: typeof fetch;
  /** Test seam for tunnel configuration reads. */
  readFile?: typeof readFile;
}

interface TunnelConfig {
  identity: string;
  known_hosts: string;
  destination: string;
}

const MAX_SEARCH_TIMEOUT_MS = 2_800;
const MAX_DETAIL_TIMEOUT_MS = 1_800;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TUNNEL_HEALTH_TIMEOUT_MS = 500;
const TUNNEL_RETRY_DELAY_MS = 30_000;
const TUNNEL_STOP_GRACE_MS = 1_000;
const EXPECTED_REMOTE_NODE_ID = "nanopi";
const LOCAL_NODE_ID = "local-dsh";

const TUNNEL_HOST = "127.0.0.1";
const LOCAL_FORWARD_PORT = 18_794;
const REMOTE_FORWARD_PORT = 18_793;
const REMOTE_LOCAL_PORT = 18_801;

type JsonObject = Record<string, unknown>;

class RemoteError extends Error {
  constructor(
    readonly code:
      | "remote_disabled"
      | "remote_config"
      | "remote_auth"
      | "remote_unreachable"
      | "remote_timeout"
      | "remote_response"
      | "remote_redirect",
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteHealth {
  protocol: string;
  node_id: string;
  engine: { ok: boolean };
  database_sync: boolean;
}

export async function readPeerToken(path: string): Promise<string> {
  if (typeof path !== "string" || !path.trim() || path !== path.trim()) {
    throw new RemoteError("remote_config", "Peer token path is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new RemoteError("remote_auth", "Peer token could not be read.");
  }
  if (!isJsonObject(parsed)) {
    throw new RemoteError("remote_auth", "Peer token file is invalid.");
  }
  const token = parsed["token"];
  if (
    typeof token !== "string" ||
    !token ||
    token !== token.trim() ||
    /\s/.test(token)
  ) {
    throw new RemoteError("remote_auth", "Peer token file is invalid.");
  }
  return token;
}

export class DshRemoteMemory {
  private tunnel: ChildProcess | undefined;
  private tunnelAttempt = 0;
  private tunnelGeneration = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private readonly config: () => MemoryRemoteConfig;
  private readonly spawn: typeof spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly readFileImpl: typeof readFile;

  constructor(private readonly options: DshRemoteMemoryOptions) {
    if (
      !Number.isInteger(options.localPort) ||
      options.localPort < 1 ||
      options.localPort > 65_535
    ) {
      throw new TypeError("localPort must be a valid TCP port");
    }
    this.config = options.config;
    this.spawn = options.spawn ?? spawn;
    this.fetchImpl = options.fetch ?? fetch;
    this.readFileImpl = options.readFile ?? readFile;
  }

  async search(
    query: RetrievalQueryDTO,
    signal?: AbortSignal,
  ): Promise<RetrievalResultDTO> {
    const config = this.requireEnabled();
    const token = await readPeerTokenWith(config.tokenFile, this.readFileImpl);
    const response = await this.request(
      config,
      token,
      "/peer/search",
      "POST",
      { query: query.query, topK: query.topK },
      signal,
      deadlineFor(query.deadlineAt),
    );
    if (!isJsonObject(response)) {
      throw new RemoteError("remote_response", "Peer search returned an invalid result.");
    }

    const rawHits = response["hits"];
    if (!Array.isArray(rawHits)) {
      throw new RemoteError("remote_response", "Peer search returned no hits list.");
    }
    const hits = rawHits.map((raw, index) => normalizeHit(raw, index));
    return {
      query,
      hits,
      injectedContext: typeof response["injectedContext"] === "string"
        ? response["injectedContext"]
        : "",
      tierLatencyMs: normalizeLatency(response["tierLatencyMs"]),
    };
  }

  async getTrace(
    id: string,
    signal?: AbortSignal,
    _namespace?: RuntimeNamespace,
  ): Promise<TraceDTO | null> {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
      throw new RemoteError("remote_config", "Trace id is invalid.");
    }
    const config = this.requireEnabled();
    const token = await readPeerTokenWith(config.tokenFile, this.readFileImpl);
    const tracePath = `/api/v1/memory/trace?id=${encodeURIComponent(id)}`;
    const response = await this.request(
      config,
      token,
      `/peer/detail?path=${encodeURIComponent(tracePath)}`,
      "GET",
      undefined,
      signal,
      MAX_DETAIL_TIMEOUT_MS,
    );
    if (!isJsonObject(response)) {
      throw new RemoteError("remote_response", "Peer detail returned an invalid result.");
    }
    // Older peer routes return a bare trace; the current DSH route returns
    // `{ trace }`. Accept both but still require a complete TraceDTO.
    const candidate = Object.hasOwn(response, "trace")
      ? response["trace"]
      : response;
    return normalizeTrace(candidate);
  }

  async start(): Promise<void> {
    if (this.startTask) return await this.startTask;
    if (this.tunnel !== undefined) return;
    this.stopping = false;
    const generation = ++this.tunnelGeneration;
    this.startTask = this.startOwnedTunnel(generation).finally(() => {
      if (this.startTask !== undefined) this.startTask = undefined;
    });
    return await this.startTask;
  }

  async stop(): Promise<void> {
    if (this.stopTask) return await this.stopTask;
    this.stopping = true;
    this.tunnelGeneration += 1;
    this.stopTask = this.stopOwnedTunnel().finally(() => {
      this.stopTask = undefined;
    });
    return await this.stopTask;
  }

  private async startOwnedTunnel(generation: number): Promise<void> {
    const config = this.config();
    if (!config.enabled || !config.tunnelFile) return;
    const tunnelConfig = await this.readTunnelConfig(config.tunnelFile);
    const token = await readPeerTokenWith(config.tokenFile, this.readFileImpl);

    const existing = await this.health(18_794, token);
    if (existing?.node_id === EXPECTED_REMOTE_NODE_ID) {
      // Reusing an existing forward says nothing about the reverse route.
      return;
    }
    if (this.stopping || generation !== this.tunnelGeneration) return;
    await this.spawnTunnel(tunnelConfig, generation);
  }

  private async spawnTunnel(
    config: TunnelConfig,
    generation: number,
  ): Promise<void> {
    const args = [
      "-N",
      "-T",
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "ConnectTimeout=6",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "UserKnownHostsFile=" + config.known_hosts,
      "-o", "HostKeyAlias=nanopi-m4v2",
      "-i", config.identity,
      "-L", `127.0.0.1:${LOCAL_FORWARD_PORT}:127.0.0.1:${REMOTE_LOCAL_PORT}`,
      "-R", `127.0.0.1:${REMOTE_FORWARD_PORT}:127.0.0.1:${this.options.localPort}`,
      config.destination,
    ];

    const attempt = ++this.tunnelAttempt;
    const child = this.spawn("ssh", args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    this.tunnel = child;

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        child.removeListener("exit", onEarlyExit);
        if (error) rejectSpawn(error);
        else resolveSpawn();
      };
      const onSpawn = (): void => finish();
      const onError = (): void => finish(
        new RemoteError("remote_unreachable", "SSH tunnel could not start."),
      );
      const onEarlyExit = (): void => finish(
        new RemoteError("remote_unreachable", "SSH tunnel exited during startup."),
      );

      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("exit", onEarlyExit);
    });

    if (this.stopping || generation !== this.tunnelGeneration) {
      this.terminateOwned(child);
      return;
    }
    child.once("exit", () => {
      if (this.tunnel !== child) return;
      this.tunnel = undefined;
      if (!this.stopping && generation === this.tunnelGeneration) {
        this.scheduleRetry(generation, attempt);
      }
    });
  }

  private scheduleRetry(generation: number, attempt: number): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (
        this.stopping ||
        generation !== this.tunnelGeneration ||
        attempt !== this.tunnelAttempt
      ) return;
      void this.start().catch(() => {
        if (!this.stopping && generation === this.tunnelGeneration) {
          this.scheduleRetry(generation, attempt);
        }
      });
    }, TUNNEL_RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private async stopOwnedTunnel(): Promise<void> {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const child = this.tunnel;
    this.tunnel = undefined;
    if (child !== undefined) await this.terminateOwned(child);
  }

  private async terminateOwned(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await new Promise<void>((resolveExit) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", finish);
        resolveExit();
      };
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        finish();
      }, TUNNEL_STOP_GRACE_MS);
      timer.unref?.();
      child.once("exit", finish);
    });
  }

  async health(port: number, token?: string): Promise<RemoteHealth | undefined> {
    const auth = token ?? await this.readPeerToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TUNNEL_HEALTH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(
        `http://127.0.0.1:${port}/peer/health`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${auth}` },
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const value = await readJsonBounded(response);
      if (!isJsonObject(value)) return undefined;
      if (
        typeof value["protocol"] !== "string" ||
        typeof value["node_id"] !== "string" ||
        !isJsonObject(value["engine"]) ||
        typeof value["engine"]["ok"] !== "boolean" ||
        typeof value["database_sync"] !== "boolean"
      ) {
        return undefined;
      }
      return value as unknown as RemoteHealth;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readPeerToken(): Promise<string> {
    const config = this.requireEnabled();
    return await readPeerTokenWith(config.tokenFile, this.readFileImpl);
  }

  private requireEnabled(): MemoryRemoteConfig {
    const config = this.config();
    if (!config.enabled) {
      throw new RemoteError("remote_disabled", "Remote memory is disabled.");
    }
    validateRemoteConfig(config);
    return config;
  }

  private async readTunnelConfig(path: string): Promise<TunnelConfig> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.readFileImpl(path, "utf8"));
    } catch {
      throw new RemoteError("remote_config", "Tunnel configuration could not be read.");
    }
    if (!isJsonObject(parsed)) {
      throw new RemoteError("remote_config", "Tunnel configuration is invalid.");
    }
    const identity = parsed["identity"];
    const knownHosts = parsed["known_hosts"];
    const lastAddress = parsed["last_address"];
    const rawUser = parsed["user"] ?? parsed["username"];
    const user = rawUser === undefined ? "root" : rawUser;
    if (
      typeof identity !== "string" ||
      !identity.trim() ||
      typeof knownHosts !== "string" ||
      !knownHosts.trim() ||
      typeof lastAddress !== "string" ||
      !isSshAddress(lastAddress) ||
      typeof user !== "string" ||
      !isSshUser(user)
    ) {
      throw new RemoteError("remote_config", "Tunnel configuration is invalid.");
    }
    const base = dirname(resolve(path));
    const destination = normalizeSshDestination(user, lastAddress);
    return {
      identity: resolveConfiguredPath(base, identity),
      known_hosts: resolveConfiguredPath(base, knownHosts),
      destination,
    };
  }

  private async request(
    config: MemoryRemoteConfig,
    token: string,
    route: string,
    method: "GET" | "POST",
    body: unknown,
    signal?: AbortSignal,
    timeoutMs = MAX_DETAIL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Remote request timed out", "TimeoutError"));
    }, timeoutMs);
    timer.unref?.();

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(new URL(route, config.url), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) {
          throw new RemoteError("remote_timeout", "Remote memory request timed out.");
        }
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        if (isRedirectError(error)) {
          throw new RemoteError("remote_redirect", "Remote memory redirects are not allowed.");
        }
        throw new RemoteError("remote_unreachable", "Remote memory is unreachable.");
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new RemoteError("remote_auth", "Remote memory rejected authentication.");
        }
        throw new RemoteError("remote_response", "Remote memory request failed.");
      }
      return await readJsonBounded(response);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function validateRemoteConfig(config: MemoryRemoteConfig): void {
  if (!config || typeof config !== "object") {
    throw new RemoteError("remote_config", "Remote memory configuration is invalid.");
  }
  if (typeof config.tokenFile !== "string" || !config.tokenFile.trim()) {
    throw new RemoteError("remote_config", "Peer token path is invalid.");
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new RemoteError("remote_config", "Remote memory URL is invalid.");
  }
  const loopback = isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ""));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RemoteError("remote_config", "Remote memory URL is invalid.");
  }
}

async function readPeerTokenWith(
  path: string,
  reader: typeof readFile,
): Promise<string> {
  if (typeof path !== "string" || !path.trim() || path !== path.trim()) {
    throw new RemoteError("remote_config", "Peer token path is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await reader(path, "utf8"));
  } catch {
    throw new RemoteError("remote_auth", "Peer token could not be read.");
  }
  if (!isJsonObject(parsed)) {
    throw new RemoteError("remote_auth", "Peer token file is invalid.");
  }
  const token = parsed["token"];
  if (
    typeof token !== "string" ||
    !token ||
    token !== token.trim() ||
    /\s/.test(token)
  ) {
    throw new RemoteError("remote_auth", "Peer token file is invalid.");
  }
  return token;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new RemoteError("remote_response", "Remote memory response is too large.");
    }
  }
  if (!response.body) {
    throw new RemoteError("remote_response", "Remote memory returned an empty response.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RemoteError("remote_response", "Remote memory response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
    .toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new RemoteError("remote_response", "Remote memory returned invalid JSON.");
  }
}

function normalizeHit(raw: unknown, index: number): RetrievalResultDTO["hits"][number] {
  if (!isJsonObject(raw)) {
    throw new RemoteError("remote_response", `Peer hit ${index + 1} is invalid.`);
  }
  const refId = raw["refId"];
  const refKind = raw["refKind"];
  const tier = raw["tier"];
  const score = raw["score"];
  const snippet = raw["snippet"];
  if (
    typeof refId !== "string" ||
    !refId ||
    !isRefKind(refKind) ||
    (tier !== 1 && tier !== 2 && tier !== 3) ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    typeof snippet !== "string"
  ) {
    throw new RemoteError("remote_response", `Peer hit ${index + 1} is invalid.`);
  }
  return {
    tier,
    refKind,
    refId: `remote~${refId}`,
    score,
    snippet: `[Remote peer] ${snippet}`,
    ...(typeof raw["ownerAgentKind"] === "string"
      ? { ownerAgentKind: raw["ownerAgentKind"] }
      : {}),
    ...(typeof raw["ownerProfileId"] === "string"
      ? { ownerProfileId: raw["ownerProfileId"] }
      : {}),
    ...(typeof raw["ownerWorkspaceId"] === "string" || raw["ownerWorkspaceId"] === null
      ? { ownerWorkspaceId: raw["ownerWorkspaceId"] }
      : {}),
    ...(isShareScope(raw["shareScope"]) ? { shareScope: raw["shareScope"] } : {}),
    ...(typeof raw["sourceTraceId"] === "string"
      ? { sourceTraceId: raw["sourceTraceId"] }
      : {}),
  };
}

function normalizeLatency(value: unknown): RetrievalResultDTO["tierLatencyMs"] {
  if (!isJsonObject(value)) return { tier1: 0, tier2: 0, tier3: 0 };
  return {
    tier1: finiteNonNegative(value["tier1"]),
    tier2: finiteNonNegative(value["tier2"]),
    tier3: finiteNonNegative(value["tier3"]),
  };
}

function normalizeTrace(value: unknown): TraceDTO | null {
  if (value === null || value === undefined) return null;
  if (!isJsonObject(value)) {
    throw new RemoteError("remote_response", "Peer trace detail is invalid.");
  }

  const requiredStrings = [
    "id",
    "episodeId",
    "sessionId",
    "userText",
    "agentText",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string") {
      throw new RemoteError("remote_response", "Peer trace detail is invalid.");
    }
  }
  const numericFields = ["ts", "value", "alpha", "priority", "turnId"] as const;
  for (const key of numericFields) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new RemoteError("remote_response", "Peer trace detail is invalid.");
    }
  }
  if (!Array.isArray(value["toolCalls"])) {
    throw new RemoteError("remote_response", "Peer trace detail is invalid.");
  }

  return value as unknown as TraceDTO;
}

function deadlineFor(deadlineAt: number | undefined): number {
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    return MAX_SEARCH_TIMEOUT_MS;
  }
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) {
    throw new RemoteError("remote_timeout", "Remote memory deadline expired.");
  }
  return Math.max(1, Math.min(MAX_SEARCH_TIMEOUT_MS, remaining));
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRefKind(value: unknown): value is RetrievalResultDTO["hits"][number]["refKind"] {
  return value === "skill" ||
    value === "trace" ||
    value === "episode" ||
    value === "experience" ||
    value === "world-model";
}

function isShareScope(value: unknown): value is "private" | "public" | "hub" {
  return value === "private" || value === "public" || value === "hub";
}

function isRedirectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  if (candidate.name !== "TypeError") return false;
  const message = [
    candidate.message,
    candidate.cause?.message,
  ].filter((value): value is string => typeof value === "string").join(" ");
  return /redirect/i.test(message) ||
    candidate.cause?.code === "ERR_FR_REDIRECTION_FAILURE" ||
    candidate.cause?.code === "UND_ERR_REDIRECT";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost") return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith("127.");
  return version === 6 && (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

function isSshAddress(value: string): boolean {
  if (!value || value !== value.trim() || /\s/.test(value) || value.startsWith("-")) {
    return false;
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._:[\]-]+$/.test(value)) return true;
  return /^[A-Za-z0-9._:[\]-]+$/.test(value);
}

function isSshUser(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function normalizeSshDestination(user: string, address: string): string {
  return address.includes("@") ? address : `${user}@${address}`;
}

function resolveConfiguredPath(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
