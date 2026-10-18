/**
 * LAN candidate discovery for DSH memory peers.
 *
 * Discovery is deliberately separate from authentication. A result from this
 * module is only a candidate URL; callers must still perform the authenticated
 * peer health/challenge request before treating the endpoint as trusted.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createSocket,
  type RemoteInfo,
  type Socket,
} from "node:dgram";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

const PROTOCOL = "dsh-memos-discovery/1";
const DEFAULT_DISCOVERY_PORT = 18_802;
const MULTICAST_ADDRESS = "239.255.77.77";
const SCAN_INTERVAL_MS = 30_000;
const REBIND_BACKOFF_MS = 30_000;
const MESSAGE_WINDOW_MS = 60_000;
const FUTURE_SKEW_MS = 10_000;
const SEEN_TTL_MS = 120_000;
const PENDING_TTL_MS = 60_000;
const CANDIDATE_TTL_MS = 120_000;
const MAX_MESSAGE_BYTES = 2_048;
const MAX_SEEN_MESSAGES = 2_048;
const MAX_PENDING_PROBES = 64;
const CLOSE_GRACE_MS = 100;

export interface PeerCandidate {
  nodeId: string;
  url: string;
  lastSeenAt: number;
}

export interface PeerDiscoveryOptions {
  nodeId: string;
  port: number;
  discoveryPort?: number;
  key: () => Promise<string>;
  onPeer: (peer: PeerCandidate) => void;
  interfaces?: typeof networkInterfaces;
  socketFactory?: typeof createSocket;
  now?: () => number;
}

interface InterfaceTarget {
  address: string;
  broadcast?: string;
}

type MessageKind = "probe" | "response";

interface ProbeMessage {
  protocol: typeof PROTOCOL;
  kind: "probe";
  nodeId: string;
  port: number;
  nonce: string;
  ts: number;
  sig: string;
}

interface ResponseMessage {
  protocol: typeof PROTOCOL;
  kind: "response";
  nodeId: string;
  port: number;
  nonce: string;
  challenge: string;
  ts: number;
  sig: string;
}

type WireMessage = ProbeMessage | ResponseMessage;

interface UnsignedMessage {
  protocol: typeof PROTOCOL;
  kind: MessageKind;
  nodeId: string;
  port: number;
  nonce: string;
  ts: number;
  challenge?: string;
}

interface PendingProbe {
  expiresAt: number;
}

/**
 * Discovers candidate DSH peers on directly attached private LAN interfaces.
 * The class owns one UDP socket and one unref'ed scan timer while running.
 */
export class PeerDiscovery {
  private readonly nodeId: string;
  private readonly port: number;
  private readonly discoveryPort: number;
  private readonly key: () => Promise<string>;
  private readonly onPeer: (peer: PeerCandidate) => void;
  private readonly readInterfaces: typeof networkInterfaces;
  private readonly createSocketImpl: typeof createSocket;
  private readonly now: () => number;

  private running = false;
  private generation = 0;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private scanTask: Promise<void> | undefined;
  private socket: Socket | undefined;
  private socketMessageHandler:
    | ((message: Buffer, remote: RemoteInfo) => void)
    | undefined;
  private socketErrorHandler: (() => void) | undefined;
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private nextBindAttemptAt = 0;
  private targets: InterfaceTarget[] = [];
  private readonly joinedInterfaces = new Set<string>();
  private readonly candidates = new Map<string, PeerCandidate>();
  private readonly pendingProbes = new Map<string, PendingProbe>();
  private readonly seenMessages = new Map<string, number>();

  constructor(options: PeerDiscoveryOptions) {
    if (!isValidNodeId(options.nodeId)) {
      throw new TypeError("nodeId must be a non-empty printable identifier");
    }
    if (!isValidPort(options.port)) {
      throw new TypeError("port must be a valid TCP port");
    }
    const discoveryPort = options.discoveryPort ?? DEFAULT_DISCOVERY_PORT;
    if (!isValidPort(discoveryPort)) {
      throw new TypeError("discoveryPort must be a valid UDP port");
    }
    if (typeof options.key !== "function") {
      throw new TypeError("key must be a function");
    }
    if (typeof options.onPeer !== "function") {
      throw new TypeError("onPeer must be a function");
    }

    this.nodeId = options.nodeId;
    this.port = options.port;
    this.discoveryPort = discoveryPort;
    this.key = options.key;
    this.onPeer = options.onPeer;
    this.readInterfaces = options.interfaces ?? networkInterfaces;
    this.createSocketImpl = options.socketFactory ?? createSocket;
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts listening, performs an immediate scan, then probes every 30s.
   * A bind/socket failure leaves the timer installed so a later scan can
   * retry without turning discovery into a fatal dependency.
   */
  async start(): Promise<void> {
    if (this.startTask !== undefined) return await this.startTask;
    if (this.stopTask !== undefined) await this.stopTask;
    if (this.running) return;

    const task = this.startOwned();
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = undefined;
    }
  }

  /** Stops discovery and releases the socket, timer, probes and candidates. */
  async stop(): Promise<void> {
    if (this.stopTask !== undefined) return await this.stopTask;

    this.running = false;
    this.generation += 1;
    if (this.scanTimer !== undefined) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
    this.pendingProbes.clear();
    this.seenMessages.clear();
    this.candidates.clear();

    const task = this.stopOwned();
    this.stopTask = task;
    try {
      await task;
      await this.startTask?.catch(() => undefined);
    } finally {
      if (this.stopTask === task) this.stopTask = undefined;
    }
  }

  /** Sends a signed discovery probe on every eligible attached interface. */
  async scan(): Promise<void> {
    if (!this.running) return;
    if (this.scanTask !== undefined) return await this.scanTask;

    const task = this.performScan().catch(() => undefined);
    this.scanTask = task;
    try {
      await task;
    } finally {
      if (this.scanTask === task) this.scanTask = undefined;
    }
  }

  /** Returns a defensive copy of the currently observed candidates. */
  snapshot(): PeerCandidate[] {
    this.prune(this.now());
    return [...this.candidates.values()]
      .map(peer => ({ ...peer }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.url.localeCompare(b.url));
  }

  private async startOwned(): Promise<void> {
    const generation = ++this.generation;
    this.running = true;
    this.candidates.clear();
    this.pendingProbes.clear();
    this.seenMessages.clear();
    this.joinedInterfaces.clear();
    this.targets = collectInterfaceTargets(this.readInterfaces);
    this.nextBindAttemptAt = 0;

    this.scanTimer = setInterval(() => {
      void this.scan();
    }, SCAN_INTERVAL_MS);
    this.scanTimer.unref?.();
    await this.scan();
  }

  private async stopOwned(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.joinedInterfaces.clear();
    this.nextBindAttemptAt = 0;
    if (socket === undefined) return;

    if (this.socketMessageHandler !== undefined) {
      socket.removeListener("message", this.socketMessageHandler);
      this.socketMessageHandler = undefined;
    }
    if (this.socketErrorHandler !== undefined) {
      socket.removeListener("error", this.socketErrorHandler);
      this.socketErrorHandler = undefined;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, CLOSE_GRACE_MS);
      timer.unref?.();
      try {
        socket.close(finish);
      } catch {
        finish();
      }
    });
  }

  private async ensureSocket(generation: number): Promise<boolean> {
    if (this.socket !== undefined) return true;
    if (!this.running || generation !== this.generation) return false;
    if (this.now() < this.nextBindAttemptAt) return false;

    let socket: Socket;
    try {
      socket = this.createSocketImpl({ type: "udp4", reuseAddr: true });
    } catch {
      this.nextBindAttemptAt = this.now() + REBIND_BACKOFF_MS;
      return false;
    }

    const messageHandler = (message: Buffer, remote: RemoteInfo): void => {
      if (this.socket !== socket) return;
      void this.handleMessage(message, remote, generation);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = (): void => {
          socket.removeListener("error", onError);
          resolve();
        };
        const onError = (): void => {
          socket.removeListener("listening", onListening);
          reject(new Error("UDP socket failed to bind"));
        };
        socket.once("listening", onListening);
        socket.once("error", onError);
        socket.bind({
          address: "0.0.0.0",
          port: this.discoveryPort,
          exclusive: false,
        });
      });
    } catch {
      try {
        socket.close();
      } catch {
        // Ignore a socket that never reached the bound state.
      }
      this.nextBindAttemptAt = this.now() + REBIND_BACKOFF_MS;
      return false;
    }

    if (!this.running || generation !== this.generation) {
      try {
        socket.close();
      } catch {
        // The start was superseded by stop().
      }
      return false;
    }

    this.socket = socket;
    this.socketMessageHandler = messageHandler;
    this.socketErrorHandler = () => undefined;
    socket.on("message", messageHandler);
    // Runtime errors are non-fatal: stop() still owns the socket lifecycle.
    socket.on("error", this.socketErrorHandler);
    socket.unref?.();

    try {
      socket.setBroadcast(true);
    } catch {
      // Multicast remains available when broadcast is unsupported.
    }
    this.joinMulticastGroups(socket);
    return true;
  }

  private async performScan(): Promise<void> {
    const generation = this.generation;
    const now = this.now();
    this.prune(now);
    // Refresh DHCP/VPN interface changes on every probe.
    this.targets = collectInterfaceTargets(this.readInterfaces);
    if (this.targets.length === 0) return;
    if (!(await this.ensureSocket(generation))) return;
    const socket = this.socket;
    if (socket === undefined) return;
    this.joinMulticastGroups(socket);

    let secret: string;
    try {
      secret = await this.readSecret();
    } catch {
      return;
    }
    if (!this.running || generation !== this.generation) return;

    const unsigned: UnsignedMessage = {
      protocol: PROTOCOL,
      kind: "probe",
      nodeId: this.nodeId,
      port: this.port,
      nonce: randomNonce(),
      ts: now,
    };
    const message: ProbeMessage = {
      protocol: PROTOCOL,
      kind: "probe",
      nodeId: this.nodeId,
      port: this.port,
      nonce: unsigned.nonce,
      ts: now,
      sig: sign(unsigned, secret),
    };
    const bytes = Buffer.from(JSON.stringify(message), "utf8");
    this.pendingProbes.set(unsigned.nonce, { expiresAt: now + PENDING_TTL_MS });
    this.limitPendingProbes();

    for (const target of this.targets) {
      try {
        socket.setMulticastInterface(target.address);
      } catch {
        // Broadcast is still attempted below.
      }
      await this.send(socket, bytes, this.discoveryPort, MULTICAST_ADDRESS);
      if (target.broadcast !== undefined) {
        await this.send(socket, bytes, this.discoveryPort, target.broadcast);
      }
    }
  }

  private async handleMessage(
    bytes: Buffer,
    remote: RemoteInfo,
    generation: number,
  ): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_MESSAGE_BYTES) return;
    if (remote.port !== this.discoveryPort) return;

    const source = normalizePrivateAddress(remote.address);
    if (source === undefined) return;

    const message = parseMessage(bytes);
    if (message === undefined) return;
    const now = this.now();
    if (!isFresh(message.ts, now)) return;

    // Our own multicast/broadcast packets can loop back on Linux.
    if (message.nodeId === this.nodeId) return;

    let secret: string;
    try {
      secret = await this.readSecret();
    } catch {
      return;
    }
    if (!verify(message, secret)) return;
    if (!this.running || generation !== this.generation) return;

    // Signatures cover the nonce and timestamp, so this rejects replay even
    // when an attacker changes the source address or UDP source port.
    const replayKey = message.sig;
    if (this.seenMessages.has(replayKey)) return;
    this.seenMessages.set(replayKey, now + SEEN_TTL_MS);
    this.prune(now);

    if (message.kind === "probe") {
      this.observe(message.nodeId, source, message.port, now);
      await this.respond(message, source, remote.port, secret);
      return;
    }

    const pending = this.pendingProbes.get(message.challenge);
    if (pending === undefined || pending.expiresAt <= now) return;
    this.observe(message.nodeId, source, message.port, now);
  }

  private observe(nodeId: string, address: string, port: number, now: number): void {
    const peer: PeerCandidate = {
      nodeId,
      url: `http://${formatAddress(address)}:${port}`,
      lastSeenAt: now,
    };
    const previous = this.candidates.get(nodeId);
    this.candidates.set(nodeId, peer);
    if (previous?.url === peer.url) return;
    try {
      this.onPeer({ ...peer });
    } catch {
      // A consumer callback cannot break discovery.
    }
  }

  private async respond(
    probe: ProbeMessage,
    address: string,
    port: number,
    secret: string,
  ): Promise<void> {
    const unsigned: UnsignedMessage = {
      protocol: PROTOCOL,
      kind: "response",
      nodeId: this.nodeId,
      port: this.port,
      nonce: randomNonce(),
      challenge: probe.nonce,
      ts: this.now(),
    };
    const message: ResponseMessage = {
      protocol: PROTOCOL,
      kind: "response",
      nodeId: this.nodeId,
      port: this.port,
      nonce: unsigned.nonce,
      challenge: probe.nonce,
      ts: unsigned.ts,
      sig: sign(unsigned, secret),
    };
    const socket = this.socket;
    if (socket === undefined) return;
    await this.send(
      socket,
      Buffer.from(JSON.stringify(message), "utf8"),
      port,
      address,
    );
  }

  private async send(
    socket: Socket,
    bytes: Buffer,
    port: number,
    address: string,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        socket.send(bytes, 0, bytes.byteLength, port, address, () => resolve());
      } catch {
        resolve();
      }
    });
  }

  private joinMulticastGroups(socket: Socket): void {
    for (const target of this.targets) {
      if (this.joinedInterfaces.has(target.address)) continue;
      try {
        socket.addMembership(MULTICAST_ADDRESS, target.address);
        this.joinedInterfaces.add(target.address);
      } catch {
        // A failed join on one interface must not prevent other interfaces.
      }
    }
  }

  private async readSecret(): Promise<string> {
    const secret = await this.key();
    if (
      typeof secret !== "string" ||
      secret.length === 0 ||
      secret.length > 4_096
    ) {
      throw new Error("Discovery key is invalid");
    }
    return secret;
  }

  private prune(now: number): void {
    for (const [nonce, pending] of this.pendingProbes) {
      if (pending.expiresAt <= now) this.pendingProbes.delete(nonce);
    }
    for (const [key, expiresAt] of this.seenMessages) {
      if (expiresAt <= now) this.seenMessages.delete(key);
    }
    for (const [nodeId, peer] of this.candidates) {
      if (now - peer.lastSeenAt >= CANDIDATE_TTL_MS) {
        this.candidates.delete(nodeId);
      }
    }
    // Oldest-first insertion order keeps these maps bounded without a timer.
    while (this.seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this.seenMessages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenMessages.delete(oldest);
    }
  }

  private limitPendingProbes(): void {
    while (this.pendingProbes.size > MAX_PENDING_PROBES) {
      const oldest = this.pendingProbes.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.pendingProbes.delete(oldest);
    }
  }

}

function collectInterfaceTargets(
  readInterfaces: typeof networkInterfaces,
): InterfaceTarget[] {
  let interfaces: ReturnType<typeof networkInterfaces>;
  try {
    interfaces = readInterfaces();
  } catch {
    return [];
  }

  const targets: InterfaceTarget[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      const family = String(entry.family);
      if (family !== "IPv4" && family !== "4") continue;
      const address = normalizePrivateAddress(entry.address);
      if (address === undefined || seen.has(address)) continue;
      seen.add(address);
      targets.push({
        address,
        broadcast: directedBroadcast(address, entry.netmask),
      });
    }
  }
  return targets;
}

function directedBroadcast(address: string, netmask: string): string | undefined {
  const ip = ipv4ToInt(address);
  const mask = ipv4ToInt(netmask);
  if (ip === undefined || mask === undefined) return undefined;

  let zeroSeen = false;
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = ((mask >>> bit) & 1) === 1;
    if (set && zeroSeen) return undefined;
    if (set) prefix += 1;
    else zeroSeen = true;
  }
  if (prefix < 1 || prefix > 30) return undefined;

  const broadcast = intToIpv4((ip | (~mask >>> 0)) >>> 0);
  if (broadcast === address || broadcast === "255.255.255.255") return undefined;
  return normalizePrivateAddress(broadcast) === broadcast ? broadcast : undefined;
}

function parseMessage(bytes: Buffer): WireMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value["protocol"] !== PROTOCOL) return undefined;
  if (!hasOnlyKeys(value, value["kind"] === "response"
    ? ["protocol", "kind", "nodeId", "port", "nonce", "challenge", "ts", "sig"]
    : ["protocol", "kind", "nodeId", "port", "nonce", "ts", "sig"])) {
    return undefined;
  }

  const kind = value["kind"];
  const nodeId = value["nodeId"];
  const port = value["port"];
  const nonce = value["nonce"];
  const ts = value["ts"];
  const sig = value["sig"];
  const challenge = value["challenge"];
  if (
    (kind !== "probe" && kind !== "response") ||
    !isValidNodeId(nodeId) ||
    !isValidPort(port) ||
    !isNonce(nonce) ||
    typeof ts !== "number" ||
    !Number.isSafeInteger(ts) ||
    typeof sig !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(sig)
  ) {
    return undefined;
  }
  if (kind === "response" && !isNonce(challenge)) return undefined;

  if (kind === "probe") {
    return {
      protocol: PROTOCOL,
      kind,
      nodeId,
      port,
      nonce,
      ts: ts as number,
      sig,
    };
  }
  return {
    protocol: PROTOCOL,
    kind,
    nodeId,
    port,
    nonce,
    challenge: challenge as string,
    ts: ts as number,
    sig,
  };
}

function sign(message: UnsignedMessage, secret: string): string {
  return createHmac("sha256", secret)
    .update(canonicalMessage(message))
    .digest("base64url");
}

function verify(message: WireMessage, secret: string): boolean {
  const unsigned: UnsignedMessage = message.kind === "probe"
    ? {
        protocol: message.protocol,
        kind: message.kind,
        nodeId: message.nodeId,
        port: message.port,
        nonce: message.nonce,
        ts: message.ts,
      }
    : {
        protocol: message.protocol,
        kind: message.kind,
        nodeId: message.nodeId,
        port: message.port,
        nonce: message.nonce,
        challenge: message.challenge,
        ts: message.ts,
      };
  const expected = Buffer.from(sign(unsigned, secret), "ascii");
  const actual = Buffer.from(message.sig, "ascii");
  return expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual);
}

function canonicalMessage(message: UnsignedMessage): string {
  return JSON.stringify(message.challenge === undefined
    ? {
        protocol: message.protocol,
        kind: message.kind,
        nodeId: message.nodeId,
        port: message.port,
        nonce: message.nonce,
        ts: message.ts,
      }
    : {
        protocol: message.protocol,
        kind: message.kind,
        nodeId: message.nodeId,
        port: message.port,
        nonce: message.nonce,
        challenge: message.challenge,
        ts: message.ts,
      });
}

function isFresh(timestamp: number, now: number): boolean {
  return timestamp <= now + FUTURE_SKEW_MS && now - timestamp <= MESSAGE_WINDOW_MS;
}

function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

function isNonce(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidNodeId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535;
}

function normalizePrivateAddress(value: string): string | undefined {
  let address = value;
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (isIP(address) !== 4) return undefined;
  const numeric = ipv4ToInt(address);
  if (numeric === undefined) return undefined;

  const first = numeric >>> 24;
  const second = (numeric >>> 16) & 0xff;
  if (first === 10) return intToIpv4(numeric);
  if (first === 172 && second >= 16 && second <= 31) return intToIpv4(numeric);
  if (first === 192 && second === 168) return intToIpv4(numeric);
  if (first === 169 && second === 254) return intToIpv4(numeric);
  return undefined;
}

function formatAddress(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

function ipv4ToInt(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    result = ((result << 8) | octet) >>> 0;
  }
  return result >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    keys.every(key => expected.includes(key));
}
