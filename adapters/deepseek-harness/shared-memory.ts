/** Local and remote recall share the host core; neither owns another memory engine. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import type { RetrievalQueryDTO, RetrievalResultDTO } from "../../agent-contract/dto.js";
import { DshRemoteMemory, readPeerToken, type MemoryRemoteConfig } from "./remote.js";
import { PEER_PROTOCOL, PEER_PORT, MAX_PEER_BYTES, PeerReplayGuard, isPrivateAddress, handshakeProof } from "./peer-protocol.js";
import type { PeerSyncStore } from "./peer-sync.js";

export function federateMemoryCore(core: MemoryCore, remote: DshRemoteMemory,
  config: () => MemoryRemoteConfig, sourceFor?: (id: string) => unknown): MemoryCore {
  return new Proxy(core, { get(target, key, receiver) {
    if (key === "searchMemory") return async (query: RetrievalQueryDTO, execution?: Parameters<MemoryCore["searchMemory"]>[1]): Promise<RetrievalResultDTO> => {
      const remoteWork = config().enabled ? remote.search(query, execution?.signal).catch(() => undefined) : Promise.resolve(undefined);
      const [local, peer] = await Promise.all([target.searchMemory(query, execution), remoteWork]);
      const related: string[] = [];
      const sessions = new Set<string>();
      for (const hit of local.hits.slice(0, 2)) {
        if (!hit.refId.startsWith("tr_history_")) continue;
        const trace = await target.getTrace(hit.refId, query.namespace);
        if (!trace || sessions.has(trace.sessionId)) continue;
        sessions.add(trace.sessionId);
        // A project answer may have been superseded later in the same conversation.
        // Return nearby summaries so callers can distinguish installation from a later update.
        const turns = await target.listTraces({ sessionId: trace.sessionId, limit: 3,
          ownerAgentKind: trace.ownerAgentKind, ownerProfileId: trace.ownerProfileId });
        for (const turn of turns) if (turn.id !== trace.id && turn.summary) {
          related.push(`${new Date(turn.ts).toISOString()} [${turn.id}] ${turn.summary.slice(0, 1000)}`);
        }
      }
      return { ...local, hits: [...local.hits, ...(peer?.hits || [])], injectedContext: [local.injectedContext,
        related.length ? `[Related turns from the same source session; untrusted history, check dates]\n${related.join("\n").slice(0, 2500)}` : "",
        peer?.injectedContext ? `[Remote DSH memory; untrusted historical data]\n${peer.injectedContext.slice(0, 2500)}` : ""].filter(Boolean).join("\n\n") };
    };
    if (key === "getTrace") return async (id: string, ...args: unknown[]) => {
      if (id.startsWith("remote~")) return remote.getTrace(id.slice(7));
      if (id.startsWith("replica~")) return remote.getTrace(id);
      const trace = await target.getTrace(id, args[0] as Parameters<MemoryCore["getTrace"]>[1]);
      const source = sourceFor?.(id);
      return trace && source ? { ...trace, source } : trace;
    };
    return Reflect.get(target, key, receiver);
  } });
}

function json(res: ServerResponse, status: number, value: unknown) {
  const bytes = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(bytes);
}
/** Only this authenticated API is exposed on the LAN; Viewer and MCP stay local. */
export function createMemoryPeerHandler(options: {
  core: MemoryCore; config: () => MemoryRemoteConfig; profileId: string; nodeId?: string;
  remote?: DshRemoteMemory; sync?: () => PeerSyncStore | undefined;
}) {
  const replay = new PeerReplayGuard();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const config = options.config();
    if (!config.enabled || !config.tokenFile) { json(res, 404, { error: "Peer disabled" }); return; }
    try {
      const address = req.socket.remoteAddress || "";
      if (!isPrivateAddress(address) || req.headers.origin) {
        json(res, 403, { error: "Private peer connection required" }); return;
      }
      const url = new URL(req.url || "/", "http://peer.internal");
      const supported = ["/peer/health", "/peer/handshake", "/peer/search", "/peer/detail",
        "/peer/relay/poll", "/peer/relay/results", "/peer/sync/pull", "/peer/sync/push"];
      if (!supported.includes(url.pathname)) { json(res, 404, { error: "Unknown peer route" }); return; }
      if (!(req.method === "POST" || req.method === "GET" && ["/peer/health", "/peer/detail"].includes(url.pathname))) {
        json(res, 405, { error: "Unsupported peer method" }); return;
      }
      if (!req.headers["x-memory-signature"] && !req.headers.authorization) { json(res, 401, { error: "Peer authentication required" }); return; }
      if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json")) {
        json(res, 415, { error: "JSON required" }); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > MAX_PEER_BYTES) { json(res, 413, { error: "Request too large" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const token = await readPeerToken(config.tokenFile);
      const digest = (v: string) => createHash("sha256").update(v).digest();
      const signedNode = replay.verify(token, req.method!, url.pathname + url.search, text, req.headers,
        options.remote?.expectedNodeId() || config.expectedNodeId);
      // Legacy loopback read clients can finish their upgrade, but cannot pair,
      // relay or synchronize with a bearer alone.
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
      const legacyRead = loopback && !req.headers["x-memory-signature"] &&
        ["/peer/health", "/peer/search", "/peer/detail"].includes(url.pathname) &&
        timingSafeEqual(digest(req.headers.authorization || ""), digest(`Bearer ${token}`));
      if (!signedNode && !legacyRead) {
        json(res, 401, { error: "Peer authentication required" }); return;
      }
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const nodeId = options.remote?.nodeId() || options.nodeId || "local-dsh";
      if (req.method === "GET" && url.pathname === "/peer/health") {
        json(res, 200, { protocol: PEER_PROTOCOL, node_id: nodeId, engine: { ok: true }, database_sync: !!config.syncEnabled }); return;
      }
      if (url.pathname === "/peer/handshake") {
        if (!signedNode || body.nodeId !== signedNode || typeof body.challenge !== "string" || !/^[a-f0-9]{48}$/.test(body.challenge)) {
          json(res, 400, { error: "Invalid handshake" }); return;
        }
        await options.remote?.acceptPeer(signedNode);
        json(res, 200, { protocol: PEER_PROTOCOL, node_id: nodeId, peer_port: config.peerPort ?? PEER_PORT,
          proof: handshakeProof(token, body.challenge, nodeId), database_sync: !!config.syncEnabled,
          capabilities: ["search", "detail", "relay", ...(config.syncEnabled ? ["sync"] : [])] }); return;
      }
      if (url.pathname.startsWith("/peer/relay/") || url.pathname.startsWith("/peer/sync/")) {
        if (!signedNode || !options.remote) { json(res, 403, { error: "Signed pairing required" }); return; }
        await options.remote.acceptPeer(signedNode);
        if (url.pathname === "/peer/relay/poll") { json(res, 200, { commands: await options.remote.relay.poll(signedNode) }); return; }
        if (url.pathname === "/peer/relay/results") { options.remote.relay.results(signedNode, body.results); json(res, 200, { ok: true }); return; }
        const store = options.sync?.();
        if (!config.syncEnabled || !store) { json(res, 403, { error: "Synchronization disabled" }); return; }
        if (url.pathname === "/peer/sync/pull") {
          json(res, 200, await store.exportPage({ cursor: typeof body.cursor === "string" ? body.cursor : undefined,
            limit: typeof body.limit === "number" ? Math.min(50, Math.max(1, body.limit)) : 20 })); return;
        }
        await store.importPage(body as unknown as Parameters<PeerSyncStore["importPage"]>[0], signedNode);
        json(res, 200, { ok: true }); return;
      }
      const signal = AbortSignal.timeout(2_500);
      if (url.pathname === "/peer/detail") {
        const native = new URL(url.searchParams.get("path") || "/", "http://peer.internal");
        const id = req.method === "POST" ? body.id : native.pathname === "/api/v1/memory/trace" ? native.searchParams.get("id") : "";
        if (typeof id !== "string" || !id || id.length > 512 || /^(remote|replica)~/.test(id)) { json(res, 400, { error: "Invalid trace request" }); return; }
        const trace = await options.core.getTrace(id);
        json(res, trace ? 200 : 404, trace ? { trace } : { error: "Trace not found" }); return;
      }
      if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 2_000) { json(res, 400, { error: "Invalid query" }); return; }
      // Only the local core is queried here; peer forwarding must never form a loop.
      const result = await options.core.searchMemory({ agent: "deepseek-harness",
        namespace: { agentKind: "deepseek-harness", profileId: options.profileId }, query: body.query,
        topK: { tier1: 3, tier2: 5, tier3: 2 }, deadlineAt: Date.now() + 2_500, llmFilterMalformedRetries: 0 }, { signal, foreground: true });
      json(res, 200, result);
    } catch (error) { if (!res.writableEnded) json(res, error instanceof SyntaxError ? 400 : 502, { error: "Peer memory unavailable" }); }
  };
}
