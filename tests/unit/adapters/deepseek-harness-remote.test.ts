import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshRemoteMemory, readPeerToken } from "../../../adapters/deepseek-harness/remote.js";
import { createMemoryPeerHandler } from "../../../adapters/deepseek-harness/shared-memory.js";
import { PeerReplayGuard, signPeerRequest, peerUrl, peerBaseUrl, handshakeProof, peerResponseProof, PEER_PROTOCOL } from "../../../adapters/deepseek-harness/peer-protocol.js";
import { PeerRelay } from "../../../adapters/deepseek-harness/peer-relay.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { MemoryRemoteConfig } from "../../../adapters/deepseek-harness/remote.js";

const cleanups: Array<() => unknown> = [];
const key = "synthetic-paired-key-abcdefghijklmnopqrstuvwxyz";
const query = { agent: "deepseek-harness", query: "previous project" };
const trace = { id: "tr-real", episodeId: "ep-real", sessionId: "session-real", ts: 1700000000000,
  userText: "user", agentText: "answer", toolCalls: [], value: .5, alpha: .5, priority: .5, turnId: 1 };
const result = { query, hits: [{ tier: 2, refKind: "trace", refId: trace.id, score: .9, snippet: "previous project memory" }],
  injectedContext: "previous project memory", tierLatencyMs: { tier1: 0, tier2: 1, tier3: 0 } };
function signedResponse(init: RequestInit, value: unknown, node = "server") {
  const body = JSON.stringify(value), nonce = new Headers(init.headers).get("X-Memory-Nonce")!;
  return new Response(body, { headers: { "Content-Type": "application/json", "X-Memory-Node": node,
    "X-Memory-Response-Signature": peerResponseProof(key, nonce, node, 200, body) } });
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function home() {
  const path = await mkdtemp(join(tmpdir(), "memos-network-")); cleanups.push(() => rm(path, { recursive: true, force: true }));
  const tokenFile = join(path, "key.json"); await writeFile(tokenFile, JSON.stringify({ token: key, session: "synthetic-webos-session" }));
  return { path, tokenFile };
}
async function listen(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: string; port: number }> {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const port = (server.address() as { port: number }).port; return { server, port, url: `http://127.0.0.1:${port}` };
}
async function paired() {
  const { path, tokenFile } = await home();
  const serverConfig: MemoryRemoteConfig = { enabled: true, url: "", tokenFile, nodeId: "server", expectedNodeId: "desktop", lanDiscovery: false };
  const serverRemote = new DshRemoteMemory({ config: () => serverConfig, localPort: 18801, home: join(path, "server") });
  const searchMemory = vi.fn().mockResolvedValue(result), getTrace = vi.fn().mockResolvedValue(trace);
  const handler = createMemoryPeerHandler({ core: { searchMemory, getTrace } as unknown as MemoryCore,
    config: () => serverConfig, profileId: "nanopi", remote: serverRemote });
  const endpoint = await listen((req, res) => { void handler(req, res); });
  const desktopConfig: MemoryRemoteConfig = { enabled: true, url: endpoint.url, tokenFile, nodeId: "desktop", expectedNodeId: "server", lanDiscovery: false };
  const desktop = new DshRemoteMemory({ config: () => desktopConfig, localPort: 18801, home: join(path, "desktop"),
    localSearch: async () => ({ ...result, injectedContext: "desktop source" }) as never,
    localDetail: async () => trace });
  cleanups.push(() => serverRemote.stop()); cleanups.push(() => desktop.stop());
  await serverRemote.start(); await desktop.start(); await desktop.connect();
  return { endpoint, serverRemote, desktop, searchMemory, getTrace, tokenFile };
}

describe("peer protocol and credential boundaries", () => {
  it("retains a public gateway path and rejects public cleartext or credential URLs", () => {
    expect(peerUrl("https://example.test/desktop/api/memory-peer", "/peer/sync/pull").href)
      .toBe("https://example.test/desktop/api/memory-peer/sync/pull");
    expect(peerUrl("example.test", "/peer/handshake").href).toBe("https://example.test/desktop/api/memory-peer/handshake");
    expect(peerUrl("http://192.168.76.1:18802", "/peer/detail").pathname).toBe("/peer/detail");
    for (const url of ["http://example.test", "https://user:secret@example.test", "https://example.test/?session=secret", "https://example.test/arbitrary"]) {
      expect(() => peerBaseUrl(url)).toThrow();
    }
  });
  it("rejects replay, tampered bodies, expired signatures and another node", () => {
    const now = Date.now(); const guard = new PeerReplayGuard();
    const signed = signPeerRequest(key, "desktop", "POST", "/peer/search", "{}", now);
    const headers = Object.fromEntries(Object.entries(signed).map(([k, v]) => [k.toLowerCase(), v]));
    expect(guard.verify(key, "POST", "/peer/search", "changed", headers, "desktop", now)).toBeUndefined();
    expect(guard.verify(key, "POST", "/peer/search", "{}", headers, "other", now)).toBeUndefined();
    expect(guard.verify(key, "POST", "/peer/search", "{}", headers, "desktop", now + 61000)).toBeUndefined();
    expect(guard.verify(key, "POST", "/peer/search", "{}", headers, "desktop", now)).toBe("desktop");
    expect(guard.verify(key, "POST", "/peer/search", "{}", headers, "desktop", now)).toBeUndefined();
  });
  it("keeps malformed credential contents out of errors", async () => {
    const { tokenFile } = await home(); expect(await readPeerToken(tokenFile)).toBe(key);
    await writeFile(tokenFile, "broken " + key);
    await expect(readPeerToken(tokenFile)).rejects.toThrow("Peer credential could not be read");
  });
  it("sends neither bearer nor login session on a LAN HTTP connection", async () => {
    const { tokenFile } = await home(); const fetchMock = vi.fn(async (_url, init) => {
      const headers = init.headers;
      expect(headers.Authorization).toBeUndefined(); expect(headers["X-WebOS-Session"]).toBeUndefined();
      expect(headers["X-Memory-Signature"]).toMatch(/^[a-f0-9]{64}$/);
      return signedResponse(init, result);
    });
    const client = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true,
      url: "http://192.168.76.1:18802", tokenFile, sessionFile: tokenFile, nodeId: "desktop" }), fetch: fetchMock as never });
    expect((await client.search(query)).hits[0].refId).toBe("remote~tr-real");
  });
  it("scopes a configured login session to the exact HTTPS gateway origin", async () => {
    const { tokenFile } = await home(); const fetchMock = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://example.test/desktop/api/memory-peer/search");
      expect(init.headers.Authorization).toBe(`Bearer ${key}`);
      expect(init.headers["X-WebOS-Session"]).toBe("synthetic-webos-session"); expect(init.redirect).toBe("error");
      return signedResponse(init, result);
    });
    const client = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true,
      url: "https://example.test/desktop/api/memory-peer", tokenFile, sessionFile: tokenFile }), fetch: fetchMock as never });
    await client.search(query); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("rejects oversized responses and preserves caller cancellation", async () => {
    const { tokenFile } = await home(); const config = () => ({ enabled: true, url: "http://127.0.0.1:18802", tokenFile });
    const oversized = new DshRemoteMemory({ localPort: 18801, config, fetch: vi.fn(async () => new Response("{}", {
      headers: { "Content-Length": "1048577" } })) as never });
    await expect(oversized.search(query)).rejects.toThrow(/large/);
    const controller = new AbortController(); controller.abort();
    const cancelled = new DshRemoteMemory({ localPort: 18801, config });
    await expect(cancelled.search(query, controller.signal)).rejects.toThrow();
  });
  it("allows a slower WAN response while preserving an earlier caller deadline", async () => {
    const { tokenFile } = await home();
    const fetchMock = vi.fn(async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const signal = init.signal as AbortSignal;
        const abort = () => { clearTimeout(timer); reject(new Error("cancelled")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 3100);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return signedResponse(init, result);
    });
    const client = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true,
      url: "https://example.test/desktop/api/memory-peer", tokenFile }), fetch: fetchMock as never });
    expect((await client.search(query)).hits).toHaveLength(1);
    await expect(client.search({ ...query, deadlineAt: Date.now() + 50 })).rejects.toThrow();
  });

  it("rejects a response altered after the authenticated request", async () => {
    const { tokenFile } = await home();
    const client = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true,
      url: "http://192.168.76.1:18802", tokenFile }), fetch: vi.fn(async (_url, init) => {
        const signed = signedResponse(init, result);
        return new Response(JSON.stringify({ ...result, injectedContext: "forged history" }), { headers: signed.headers });
      }) as never });
    await expect(client.search(query)).rejects.toThrow("Peer response authentication failed");
  });
  it("backs off rejected authentication but allows an explicit connection test", async () => {
    const { tokenFile } = await home(); const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    const remote = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true, nodeId: "desktop",
      url: "https://example.test", tokenFile, lanDiscovery: false }), fetch: fetchMock as never });
    cleanups.push(() => remote.stop()); await remote.start(); await remote.connect();
    const automatic = fetchMock.mock.calls.length; await remote.connect(false);
    expect(fetchMock).toHaveBeenCalledTimes(automatic);
    await remote.connect(); expect(fetchMock).toHaveBeenCalledTimes(automatic + 1);
    expect(remote.snapshot()).toMatchObject({ state: "offline", lastError: expect.stringMatching(/session or pairing key/i) });
  });
});

describe("real HTTP peer routes", () => {
  it("recalls immediately after correcting credentials and explicitly reconnecting", async () => {
    const peer = await paired(); await peer.desktop.stop();
    const { tokenFile } = await home();
    await writeFile(tokenFile, JSON.stringify({ token: "synthetic-wrong-pairing-key-abcdefghijklmnopqrstuvwxyz" }));
    const remote = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true,
      url: peer.endpoint.url, tokenFile, nodeId: "desktop", expectedNodeId: "server", lanDiscovery: false }) });
    cleanups.push(() => remote.stop()); await remote.start();
    expect((await remote.connect()).state).toBe("offline");
    await expect(remote.search(query)).rejects.toThrow();

    await writeFile(tokenFile, JSON.stringify({ token: key }));
    expect((await remote.connect()).state).toBe("connected");
    expect((await remote.search(query)).hits[0].refId).toBe("remote~tr-real");
    expect(await remote.getTrace(trace.id)).toEqual(trace);
  });
  it("prefers discovered LAN and falls back to the configured gateway when LAN fails", async () => {
    const peer = await paired(); const { tokenFile } = await home(); let failLan = false;
    const calls: string[] = [];
    const client = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true, tokenFile,
      url: "https://gateway.test/desktop/api/memory-peer", nodeId: "desktop", expectedNodeId: "server" }),
      discoveryFactory: options => ({ start: async () => { options.onPeer({ nodeId: "server", url: peer.endpoint.url, lastSeenAt: Date.now() }); },
        stop: async () => {}, scan: async () => {} }),
      fetch: async (target, init) => {
        const url = new URL(String(target)); calls.push(url.origin);
        if (url.origin === peer.endpoint.url && failLan) throw new Error("LAN disconnected");
        if (url.hostname === "gateway.test") return fetch(peer.endpoint.url + url.pathname.replace("/desktop/api/memory-peer", "/peer"), init);
        return fetch(target, init);
      } });
    cleanups.push(() => client.stop()); await client.start(); await client.connect();
    expect(client.snapshot().route).toBe("lan");
    failLan = true; expect((await client.search(query)).hits[0].refId).toBe("remote~tr-real");
    expect(client.snapshot().route).toBe("wan"); expect(calls).toContain("https://gateway.test");
  });
  it("mutually handshakes, remembers identity and queries only the peer local core", async () => {
    const { desktop, searchMemory, getTrace } = await paired();
    expect(desktop.snapshot()).toMatchObject({ state: "connected", nodeId: "server" });
    expect((await desktop.search(query)).hits[0].refId).toBe("remote~tr-real");
    expect(await desktop.getTrace(trace.id)).toEqual(trace);
    expect(searchMemory.mock.calls[0][0].namespace.profileId).toBe("nanopi"); expect(getTrace).toHaveBeenCalledWith(trace.id);
  });
  it("returns reverse queries over the desktop outbound long poll, without a desktop listener", async () => {
    const { desktop, serverRemote } = await paired();
    await vi.waitFor(() => expect(serverRemote.relay.peer()).toBe("desktop"));
    const answer = await serverRemote.search(query); expect(answer.injectedContext).toBe("desktop source");
    expect(await serverRemote.getTrace(trace.id)).toEqual(trace); await desktop.stop();
    expect(desktop.snapshot().state).toBe("disabled");
  });
  it("requires signed auth for handshake, sync and reverse routes; never serves settings", async () => {
    const { endpoint } = await paired();
    for (const route of ["handshake", "sync/pull", "relay/poll"]) {
      const response = await fetch(`${endpoint.url}/peer/${route}`, { method: "POST", headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
    }
    expect((await fetch(`${endpoint.url}/api/v1/config`)).status).toBe(404);
    const body = JSON.stringify({ query: "project" });
    const signed = signPeerRequest(key, "desktop", "POST", "/peer/search", body);
    const request = () => fetch(`${endpoint.url}/peer/search`, { method: "POST", headers: { ...signed, "Content-Type": "application/json" }, body });
    expect((await request()).status).toBe(200); expect((await request()).status).toBe(401);
  });
  it("verifies challenge proof instead of trusting a health status or discovery announcement", async () => {
    const { tokenFile } = await home();
    const fake = await listen((req, res) => { req.resume(); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({
      protocol: PEER_PROTOCOL, node_id: "server", proof: handshakeProof("wrong-key", "wrong-challenge", "server") })); });
    const remote = new DshRemoteMemory({ localPort: 18801, config: () => ({ enabled: true, url: fake.url,
      tokenFile, lanDiscovery: false, nodeId: "desktop" }) });
    cleanups.push(() => remote.stop()); await remote.start(); expect((await remote.connect()).state).toBe("offline");
  });
});

describe("reverse queue", () => {
  it("restricts results to their authenticated peer and cancels on shutdown", async () => {
    const relay = new PeerRelay(); const poll = relay.poll("desktop", "lan");
    expect(relay.route()).toBe("lan");
    const pending = relay.request("detail", { id: "trace" });
    const commands = await poll;
    relay.results("other", [{ id: commands[0].id, ok: true, value: "forged" }]);
    relay.results("desktop", [{ id: commands[0].id, ok: true, value: "real" }]);
    expect(await pending).toBe("real");
    const cancelled = relay.request("search", { query: "project" });
    const rejection = expect(cancelled).rejects.toThrow("Peer stopped"); relay.stop(); await rejection;
  });
});
