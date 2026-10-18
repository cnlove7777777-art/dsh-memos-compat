import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { federateMemoryCore, createMemoryPeerHandler } from "../../../adapters/deepseek-harness/shared-memory.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const query = { agent: "deepseek-harness", query: "previous project" };
const result = (label: string) => ({ query, hits: [{ refId: label, refKind: "trace", tier: 2, score: 1, snippet: label }],
  injectedContext: label, tierLatencyMs: { tier1: 0, tier2: 1, tier3: 0 } });
describe("DSH shared memory", () => {
  it("keeps local recall when the remote fails and forwards cancellation", async () => {
    const local = result("local");
    const searchMemory = vi.fn().mockResolvedValue(local);
    const remoteSearch = vi.fn().mockRejectedValue(new Error("offline"));
    const core = federateMemoryCore({ searchMemory } as unknown as MemoryCore,
      { search: remoteSearch } as never, () => ({ enabled: true, url: "", tokenFile: "" }));
    const signal = new AbortController().signal;
    expect(await core.searchMemory(query, { signal })).toEqual(local);
    expect(remoteSearch).toHaveBeenCalledWith(query, signal);
  });
  it("includes later summaries from a matched history session to expose changed project facts", async () => {
    const local = result("tr_history_install");
    const core = federateMemoryCore({ searchMemory: vi.fn().mockResolvedValue(local),
      getTrace: vi.fn().mockResolvedValue({ sessionId: "history:dsh:source", ownerProfileId: "standard" }),
      listTraces: vi.fn().mockResolvedValue([{ id: "tr_history_update", ts: 1, summary: "The installed plugin was later updated to version 2" }]),
    } as unknown as MemoryCore, {} as never, () => ({ enabled: false, url: "", tokenFile: "" }));
    const found = await core.searchMemory(query);
    expect(found.injectedContext).toContain("tr_history_update");
    expect(found.injectedContext).toContain("later updated to version 2");
  });
  it("does not forward peer queries recursively and keeps credentials scoped", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "memos-peer-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const tokenFile = join(root, "peer.json");
    await fs.writeFile(tokenFile, JSON.stringify({ token: "synthetic-peer-test-credential-32chars" }));
    const searchMemory = vi.fn().mockResolvedValue(result("local"));
    const getTrace = vi.fn().mockResolvedValue({ id: "trace", sessionId: "source-session" });
    const handler = createMemoryPeerHandler({ core: { searchMemory, getTrace } as unknown as MemoryCore,
      profileId: "standard", config: () => ({ enabled: true, url: "http://127.0.0.1", tokenFile }) });
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.close(err => err ? reject(err) : resolve()); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/peer/search`, { method: "POST" })).status).toBe(401);
    expect(searchMemory).not.toHaveBeenCalled();
    const headers = { Authorization: "Bearer synthetic-peer-test-credential-32chars", "Content-Type": "application/json" };
    expect((await fetch(`${base}/peer/search`, { method: "POST", headers: { ...headers, Origin: "http://evil.test" }, body: JSON.stringify({ query: "project" }) })).status).toBe(403);
    const response = await fetch(`${base}/peer/search`, { method: "POST", headers, body: JSON.stringify({ query: "project" }) });
    expect(response.status).toBe(200);
    expect(searchMemory).toHaveBeenCalledTimes(1);
    expect(searchMemory.mock.calls[0][0].namespace.profileId).toBe("standard");
    const detail = await fetch(`${base}/peer/detail?path=${encodeURIComponent("/api/v1/memory/trace?id=trace")}`, { headers });
    expect(await detail.json()).toEqual({ trace: { id: "trace", sessionId: "source-session" } });
    const invalid = await fetch(`${base}/peer/detail?path=${encodeURIComponent("/api/v1/config")}`, { headers });
    expect(invalid.status).toBe(400);
    expect(getTrace).toHaveBeenCalledTimes(1);
  });
});
