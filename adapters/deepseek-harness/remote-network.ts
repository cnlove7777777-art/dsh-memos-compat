/** Plugin-owned LAN/WAN transport. No shell commands or SSH processes. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeNamespace, RetrievalQueryDTO, RetrievalResultDTO, TraceDTO } from "../../agent-contract/dto.js";
import { PeerDiscovery, type PeerDiscoveryOptions } from "./discovery.js";
import { PeerRelay, type RelayCommand } from "./peer-relay.js";
import { PEER_PROTOCOL, PEER_PORT, peerBaseUrl, peerUrl, signPeerRequest, handshakeProof, readPeerJson, validNodeId, isPrivateAddress } from "./peer-protocol.js";
import { normalizeHit, normalizeTrace, normalizeLatency, deadlineFor, isJsonObject } from "./remote-normalize.js";
import type { PeerSyncStore } from "./peer-sync.js";
import { createPeerFetch, peerFetchFailure } from "./peer-fetch.js";

export interface MemoryRemoteConfig {
  enabled: boolean; url: string; tokenFile: string;
  /** Migration-only. This transport never launches a tunnel. */
  tunnelFile?: string;
  nodeId?: string; expectedNodeId?: string; lanDiscovery?: boolean; peerPort?: number;
  pollIntervalSeconds?: number; syncEnabled?: boolean; sessionFile?: string;
  hasPairingKey?: boolean; hasSession?: boolean;
}
export interface RemoteHealth { protocol: string; node_id: string; engine: { ok: boolean }; database_sync: boolean }
interface Route { url: string; nodeId: string; kind: "lan" | "wan"; connectedAt: number }
class PeerAuthError extends Error {}
export interface RemoteStatus {
  state: "disabled" | "discovering" | "connected" | "offline";
  route?: "lan" | "wan" | "offline"; url?: string; nodeId?: string;
  lastConnectedAt?: number; lastError?: string; sync?: unknown;
}
export interface DshRemoteMemoryOptions {
  config: () => MemoryRemoteConfig; localPort: number; home?: string; profileId?: string;
  fetch?: typeof fetch; readFile?: typeof readFile;
  peerHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  localSearch?: (query: string, signal?: AbortSignal) => Promise<RetrievalResultDTO>;
  localDetail?: (id: string) => Promise<TraceDTO | null>;
  sync?: PeerSyncStore;
  discoveryFactory?: (options: PeerDiscoveryOptions) => Pick<PeerDiscovery, "start" | "stop" | "scan">;
  embedQuery?: (query: string, signal?: AbortSignal, deadlineAt?: number) => Promise<{ model: string; values: number[] }>;
}
export async function readPeerToken(path: string, reader: typeof readFile = readFile): Promise<string> {
  try {
    if (!path || path !== path.trim()) throw new Error();
    const value = JSON.parse(await reader(path, "utf8"));
    if (typeof value.token !== "string" || !value.token || /\s/.test(value.token)) throw new Error();
    return value.token;
  } catch { throw new Error("Peer credential could not be read"); }
}

export class DshRemoteMemory {
  readonly relay = new PeerRelay();
  private route?: Route;
  private discovery?: Pick<PeerDiscovery, "start" | "stop" | "scan">;
  private listener?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private relayTask?: Promise<void>;
  private startTask?: Promise<void>;
  private connectTask?: Promise<RemoteStatus>;
  private stopped = true;
  private generation = 0;
  private identity = "";
  private pairedNode = "";
  private pairedProfile?: string;
  private candidates = new Map<string, { nodeId: string; url: string; lastSeenAt: number }>();
  private status: RemoteStatus = { state: "disabled" };
  private cursor?: string;
  private pushCursor?: string;
  private writes: Promise<void> = Promise.resolve();
  private syncStatus: { lastRunAt?: number; lastError?: string } = {};
  private authRetryAfter = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly transport: ReturnType<typeof createPeerFetch>;
  private readonly reader: typeof readFile;
  constructor(private readonly options: DshRemoteMemoryOptions) {
    this.transport = createPeerFetch({ fetch: options.fetch });
    this.fetchImpl = this.transport.fetch; this.reader = options.readFile ?? readFile;
  }
  async initialize(): Promise<void> { await this.load(); }
  setSync(store: PeerSyncStore | undefined): void { this.options.sync = store; }
  nodeId(): string { return this.options.config().nodeId || this.identity || "local-dsh"; }
  expectedNodeId(): string | undefined { return this.options.config().expectedNodeId || this.pairedNode || undefined; }
  expectedProfileId(): string | undefined { return this.pairedProfile; }
  snapshot(): RemoteStatus {
    const reverseNode = this.relay.peer();
    const stats = this.options.sync?.stats();
    const count = stats ? Object.values(stats.replicas).reduce((sum, value) => sum + value, 0) : 0;
    return { ...this.status, ...(!this.route && reverseNode ? { state: "connected" as const, route: this.relay.route(), nodeId: reverseNode } : {}),
      ...(!this.status.lastError && this.syncStatus.lastError ? { lastError: this.syncStatus.lastError } : {}),
      ...(stats ? { sync: { ...stats, ...this.syncStatus, synced: count,
        state: this.syncStatus.lastError ? "error" : this.syncStatus.lastRunAt || count ? "synced" : "idle" } } : {}) };
  }
  async acceptPeer(node: string, profileId?: unknown): Promise<void> {
    if (!validNodeId(node) || node === this.nodeId() || this.expectedNodeId() && this.expectedNodeId() !== node) throw new Error("Unexpected peer identity");
    if (profileId !== undefined && (typeof profileId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(profileId) ||
      this.pairedProfile && this.pairedProfile !== profileId)) throw new Error("Unexpected peer profile");
    if (!this.pairedNode || profileId !== undefined && !this.pairedProfile) {
      this.pairedNode = node; if (typeof profileId === "string") this.pairedProfile = profileId; await this.persist();
    }
  }
  async start(): Promise<void> {
    if (this.startTask) return this.startTask;
    const task = this.startOwned(); this.startTask = task;
    try { await task; } finally { if (this.startTask === task) this.startTask = undefined; }
  }
  private async startOwned(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false; this.generation++; this.authRetryAfter.clear();
    if (!this.options.config().enabled) { this.status = { state: "disabled" }; return; }
    this.controller = new AbortController(); const generation = this.generation; await this.load();
    if (this.stopped || generation !== this.generation) return;
    this.status = { state: "discovering", route: "offline" };
    try {
      if (this.options.peerHandler) {
        const server = createServer((req, res) => {
          void this.options.peerHandler!(req, res).catch(() => { if (!res.writableEnded) { res.writeHead(502); res.end(); } });
        });
        server.requestTimeout = 20_000; server.headersTimeout = 5_000; this.listener = server;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject); server.listen(this.options.config().peerPort ?? PEER_PORT, "0.0.0.0", () => {
            server.removeListener("error", reject); server.on("error", () => { this.status.lastError = "Peer listener unavailable"; }); resolve();
          });
        });
      }
    } catch { this.status.lastError = "Peer listener unavailable; outbound connection remains usable"; }
    if (this.options.config().lanDiscovery !== false) {
      try {
        this.discovery = (this.options.discoveryFactory ?? (options => new PeerDiscovery(options)))({ nodeId: this.nodeId(), port: this.options.config().peerPort ?? PEER_PORT,
          key: () => readPeerToken(this.options.config().tokenFile, this.reader),
          onPeer: peer => { this.candidates.set(peer.url, peer); if (this.route?.kind !== "lan") void this.connect(false).catch(() => undefined); } });
        await this.discovery.start();
      } catch { this.status.lastError = "LAN discovery unavailable; remote URL remains usable"; }
    }
    if (this.stopped || generation !== this.generation) return;
    this.timer = setInterval(() => { void this.connect(false).catch(() => undefined); }, Math.max(15, this.options.config().pollIntervalSeconds ?? 30) * 1000);
    this.timer.unref(); void this.connect(false).catch(() => undefined);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.generation++; this.controller?.abort(); clearInterval(this.timer); this.timer = undefined;
    this.relay.stop(); await this.discovery?.stop(); this.discovery = undefined;
    await this.startTask?.catch(() => undefined);
    if (this.listener) {
      const listener = this.listener; this.listener = undefined;
      await new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
    }
    await this.relayTask?.catch(() => undefined); await this.connectTask?.catch(() => undefined); await this.writes.catch(() => undefined);
    await this.transport.close();
    this.route = undefined; this.status = { state: "disabled" };
  }
  async connect(force = true): Promise<RemoteStatus> {
    if (this.connectTask) return this.connectTask;
    this.connectTask = this.discoverAndConnect(this.generation, force).finally(() => { this.connectTask = undefined; });
    return this.connectTask;
  }
  private async discoverAndConnect(generation: number, force: boolean): Promise<RemoteStatus> {
    const config = this.options.config(); if (!config.enabled || this.stopped) return this.snapshot();
    await this.discovery?.scan();
    const candidates = [...this.candidates.values()].filter(peer => Date.now() - peer.lastSeenAt < 90_000 &&
      (!this.expectedNodeId() || peer.nodeId === this.expectedNodeId())).slice(0, 8);
    const routes: Array<{ url: string; kind: "lan" | "wan" }> = candidates.map(peer => ({ url: peer.url, kind: "lan" }));
    if (config.url) routes.push({ url: config.url, kind: isPrivateAddress(peerBaseUrl(config.url).hostname) ? "lan" : "wan" });
    for (const candidate of routes) {
      if (this.stopped || generation !== this.generation) return this.snapshot();
      if (!force && (this.authRetryAfter.get(candidate.url) ?? 0) > Date.now()) continue;
      try {
        const challenge = randomBytes(24).toString("hex"), key = await readPeerToken(config.tokenFile, this.reader);
        const response = await this.requestAt(candidate.url, "/peer/handshake", { challenge, nodeId: this.nodeId(), profile_id: this.options.profileId || "default" }, undefined, candidate.kind === "wan" ? 8000 : 3000);
        if (!isJsonObject(response) || response.protocol !== PEER_PROTOCOL || !validNodeId(response.node_id) ||
          typeof response.proof !== "string" || !/^[a-f0-9]{64}$/.test(response.proof) ||
          !timingSafeEqual(Buffer.from(response.proof, "hex"), Buffer.from(handshakeProof(key, challenge, response.node_id), "hex"))) throw new Error("Peer handshake failed");
        await this.acceptPeer(response.node_id, response.profile_id);
        if (this.stopped || generation !== this.generation) return this.snapshot();
        this.authRetryAfter.delete(candidate.url);
        this.route = { ...candidate, nodeId: response.node_id, connectedAt: Date.now() };
        this.status = { state: "connected", route: candidate.kind, url: candidate.url, nodeId: response.node_id, lastConnectedAt: Date.now() };
        await this.persist(); this.startRelay();
        if (config.syncEnabled && this.options.sync) {
          if (response.database_sync === true) {
            try { await this.synchronize(); this.syncStatus = { lastRunAt: Date.now() }; }
            catch { this.syncStatus = { ...this.syncStatus, lastError: "Memory synchronization failed; queries remain available" }; }
          } else this.syncStatus.lastError = "Enable memory synchronization on the paired device";
        }
        return this.snapshot();
      } catch (error) {
        if (error instanceof PeerAuthError) this.authRetryAfter.set(candidate.url, Date.now() + 300_000);
        this.status.lastError = error instanceof PeerAuthError ? "Server session or pairing key rejected; update credentials and test again"
          : "Peer connection failed; check address, device identity, session and pairing key";
      }
    }
    this.route = undefined;
    this.status = { ...this.status, state: this.relay.peer() ? "connected" : "offline", route: "offline", url: undefined };
    return this.snapshot();
  }
  async search(query: RetrievalQueryDTO, signal?: AbortSignal): Promise<RetrievalResultDTO> {
    if (!this.options.config().enabled) throw new Error("Remote memory is disabled");
    try {
      const raw = await this.call("search", { query: query.query, topK: query.topK }, signal, deadlineFor(query.deadlineAt, this.hasWanRoute() ? 8000 : 2800));
      if (!isJsonObject(raw) || !Array.isArray(raw.hits)) throw new Error("Invalid peer search result");
      return { query, hits: raw.hits.slice(0, 50).map(normalizeHit), injectedContext: typeof raw.injectedContext === "string" ? raw.injectedContext : "",
        tierLatencyMs: normalizeLatency(raw.tierLatencyMs) };
    } catch (error) {
      if (signal?.aborted) throw error;
      let vector: { model: string; values: number[] } | undefined;
      if (this.options.config().syncEnabled && this.options.sync && this.options.embedQuery) {
        try { vector = await this.options.embedQuery(query.query, signal, query.deadlineAt); } catch { /* Lexical recall remains available. */ }
      }
      const store = this.options.config().syncEnabled ? this.options.sync : undefined;
      let hits: ReturnType<PeerSyncStore["search"]> | undefined = undefined;
      try { hits = store?.search(query.query, 10, vector, { replicasOnly: true }); }
      catch { hits = store?.search(query.query, 10, undefined, { replicasOnly: true }); }
      if (!hits?.length) throw error;
      return { query, hits, injectedContext: "[Offline peer replica; verify source and date]\n" + hits.map(hit => hit.snippet).join("\n"),
        tierLatencyMs: { tier1: 0, tier2: 0, tier3: 0 } };
    }
  }
  async getTrace(id: string, signal?: AbortSignal, _namespace?: RuntimeNamespace): Promise<TraceDTO | null> {
    if (!this.options.config().enabled) throw new Error("Remote memory is disabled");
    if (id.startsWith("replica~")) return this.options.sync?.getTrace(id) ?? null;
    try { const raw = await this.call("detail", { id }, signal, this.hasWanRoute() ? 8000 : 2800); return normalizeTrace(isJsonObject(raw) && "trace" in raw ? raw.trace : raw); }
    catch (error) {
      if (signal?.aborted) throw error;
      const trace = this.options.config().syncEnabled ? await this.options.sync?.getTrace(id, this.expectedNodeId()) : undefined;
      if (trace) return trace; throw error;
    }
  }
  private hasWanRoute(): boolean { return this.route?.kind === "wan" || this.options.config().url.startsWith("https:"); }
  private async call(kind: "search" | "detail", value: Record<string, unknown>, signal?: AbortSignal, timeout = 2800): Promise<unknown> {
    const end = Date.now() + timeout, configured = this.options.config().url;
    const routes = [...(this.route ? [this.route.url] : []), ...(configured && configured !== this.route?.url ? [configured] : [])];
    let failure: unknown = new Error("Remote peer is offline");
    for (const [index, url] of routes.entries()) {
      const remaining = end - Date.now(); if (remaining <= 0 || signal?.aborted) break;
      if ((this.authRetryAfter.get(url) ?? 0) > Date.now()) continue;
      try {
        const result = await this.requestAt(url, `/peer/${kind}`, value, signal, index < routes.length - 1 ? Math.min(800, remaining) : remaining);
        if (url !== this.route?.url) {
          const nodeId = this.expectedNodeId();
          if (nodeId) this.route = { url, nodeId, kind: isPrivateAddress(peerBaseUrl(url).hostname) ? "lan" : "wan", connectedAt: Date.now() };
          this.status = { state: "connected", route: this.route?.kind, url, nodeId, lastConnectedAt: Date.now() };
        }
        return result;
      } catch (error) {
        if (error instanceof PeerAuthError) this.authRetryAfter.set(url, Date.now() + 300_000);
        failure = error;
      }
    }
    if (!signal?.aborted && end > Date.now() && this.relay.peer()) return this.relay.request(kind, value,
      AbortSignal.any([AbortSignal.timeout(Math.max(1, end - Date.now())), ...(signal ? [signal] : [])]));
    throw failure;
  }
  async health(port: number, _token?: string): Promise<RemoteHealth | undefined> {
    try { return await this.requestAt(`http://127.0.0.1:${port}`, "/peer/health", undefined, undefined, 800, "GET") as RemoteHealth; }
    catch { return undefined; }
  }
  private startRelay(): void {
    if (this.relayTask || !this.options.localSearch || !this.options.localDetail) return;
    const generation = this.generation;
    this.relayTask = (async () => {
      while (!this.stopped && generation === this.generation && this.route) {
        const route = this.route;
        try {
          const response = await this.requestAt(route.url, "/peer/relay/poll", {}, this.controller?.signal, 13000);
          if (!isJsonObject(response) || !Array.isArray(response.commands) || response.commands.length > 4) throw new Error("Invalid reverse commands");
          if (response.commands.length) {
            const results = await Promise.all(response.commands.map(command => this.executeReverse(command)));
            await this.requestAt(route.url, "/peer/relay/results", { results }, this.controller?.signal, 3000);
          }
        } catch (error) {
          if (this.stopped || this.controller?.signal.aborted) return;
          if (error instanceof PeerAuthError) {
            this.authRetryAfter.set(route.url, Date.now() + 300_000);
            this.route = undefined; this.status = { state: "offline", route: "offline", lastError: "Server login session expired or peer key rejected" }; return;
          }
          await new Promise<void>(resolve => {
            const abort = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { this.controller?.signal.removeEventListener("abort", abort); resolve(); }, 2000);
            timer.unref(); this.controller?.signal.addEventListener("abort", abort, { once: true });
          });
        }
      }
    })().finally(() => { this.relayTask = undefined; });
  }
  private async executeReverse(command: RelayCommand): Promise<unknown> {
    const failure = { id: command?.id, ok: false };
    if (!command || typeof command.id !== "string" || !isJsonObject(command.value)) return failure;
    try {
      if (command.kind === "search" && typeof command.value.query === "string" && command.value.query.length <= 2000)
        return { id: command.id, ok: true, value: await this.options.localSearch!(command.value.query, this.controller?.signal) };
      if (command.kind === "detail" && typeof command.value.id === "string" && command.value.id.length <= 512)
        return { id: command.id, ok: true, value: { trace: await this.options.localDetail!(command.value.id) } };
    } catch { /* Historical queries cannot become remote commands. */ }
    return failure;
  }
  private async synchronize(): Promise<void> {
    const store = this.options.sync, route = this.route; if (!store || !route || this.stopped) return;
    const pulled = await this.requestAt(route.url, "/peer/sync/pull", { cursor: this.cursor, limit: 20 }, this.controller?.signal, 5000);
    await store.importPage(pulled as Parameters<PeerSyncStore["importPage"]>[0], route.nodeId, this.expectedProfileId());
    this.cursor = (pulled as { nextCursor?: string }).nextCursor;
    const push = await store.exportPage({ cursor: this.pushCursor, limit: 20 });
    await this.requestAt(route.url, "/peer/sync/push", push, this.controller?.signal, 5000);
    this.pushCursor = push.nextCursor; await this.persist();
  }
  private async requestAt(base: string, route: string, value?: unknown, signal?: AbortSignal, timeout = 2800, method = "POST"): Promise<unknown> {
    const config = this.options.config(), target = peerUrl(base, route), body = value === undefined ? "" : JSON.stringify(value);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Peer request too large");
    const key = await readPeerToken(config.tokenFile, this.reader);
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MemOS-DSH/2",
      ...signPeerRequest(key, this.nodeId(), method, route, body) };
    if (target.protocol === "https:") {
      headers.Authorization = `Bearer ${key}`;
      if (config.sessionFile) {
        try {
          const secret = JSON.parse(await this.reader(config.sessionFile, "utf8"));
          if (typeof secret.session !== "string" || /[\r\n]/.test(secret.session)) throw new Error();
          headers["X-WebOS-Session"] = secret.session;
        } catch { throw new Error("Remote login session is unavailable"); }
      }
    }
    const signals = [AbortSignal.timeout(timeout), ...(signal ? [signal] : []), ...(this.controller ? [this.controller.signal] : [])];
    let response: Response;
    try { response = await this.fetchImpl(target, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.any(signals), redirect: "error" }); }
    catch (error) { throw new Error(peerFetchFailure(error)); }
    if (!response.ok) { await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new PeerAuthError("Remote session or pairing key rejected");
      throw new Error("Remote request failed"); }
    if (response.headers.get("X-Memory-Node") === this.nodeId()) { await response.body?.cancel(); throw new Error("Peer URL points to this device"); }
    return readPeerJson(response, { key, nonce: headers["X-Memory-Nonce"], expectedNode: this.expectedNodeId() });
  }
  private async load(): Promise<void> {
    if (!this.options.home) { this.identity ||= `dsh-${randomUUID()}`; return; }
    await mkdir(this.options.home, { recursive: true });
    try {
      const state = JSON.parse(await this.reader(join(this.options.home, "peer-network.json"), "utf8"));
      if (validNodeId(state.nodeId)) this.identity = state.nodeId;
      if (validNodeId(state.pairedNode)) this.pairedNode = state.pairedNode;
      if (typeof state.pairedProfile === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(state.pairedProfile)) this.pairedProfile = state.pairedProfile;
      if (typeof state.cursor === "string") this.cursor = state.cursor;
      if (typeof state.pushCursor === "string") this.pushCursor = state.pushCursor;
      if (this.options.config().expectedNodeId && state.pairedNode !== this.options.config().expectedNodeId) {
        this.pairedNode = ""; this.pairedProfile = undefined; this.cursor = undefined; this.pushCursor = undefined; this.candidates.clear();
      }
      if (state.route?.kind === "lan" && validNodeId(state.route.nodeId) && typeof state.route.url === "string") {
        const remembered = peerBaseUrl(state.route.url);
        if (isPrivateAddress(remembered.hostname) && (!this.expectedNodeId() || this.expectedNodeId() === state.route.nodeId)) this.candidates.set(state.route.url, { nodeId: state.route.nodeId,
          url: state.route.url, lastSeenAt: Date.now() });
      }
    } catch { /* First start has no remembered peer. */ }
    this.identity ||= `dsh-${randomUUID()}`; await this.persist();
  }
  private async persist(): Promise<void> {
    if (!this.options.home) return;
    const state = { version: 1, nodeId: this.identity, pairedNode: this.pairedNode, pairedProfile: this.pairedProfile,
      cursor: this.cursor, pushCursor: this.pushCursor, route: this.route };
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const target = join(this.options.home!, "peer-network.json"), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state) + "\n", { mode: 0o600 }); await rename(temp, target);
    });
    return this.writes;
  }
}
