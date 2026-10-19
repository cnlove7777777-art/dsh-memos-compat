import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { makeTmpDb, type TmpDbHandle } from "../../helpers/tmp-db.js";
import { PeerSyncStore } from "../../../adapters/deepseek-harness/peer-sync.js";
import { DshRemoteMemory, type MemoryRemoteConfig } from "../../../adapters/deepseek-harness/remote.js";
import { createMemoryPeerHandler } from "../../../adapters/deepseek-harness/shared-memory.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const model = "local/test-vector-model";
function source(profile: string, id: string): TmpDbHandle {
  const db = makeTmpDb({ agent: "deepseek-harness" }); cleanups.push(() => db.cleanup());
  db.repos.sessions.upsert({ id: "session", agent: "deepseek-harness", startedAt: 1, lastSeenAt: 1, meta: {} });
  db.repos.episodes.insert({ id: "episode", sessionId: "session", startedAt: 1, endedAt: null, traceIds: [], rTask: null, status: "open" });
  db.repos.traces.insert({ id, episodeId: "episode", sessionId: "session", ownerAgentKind: "deepseek-harness",
    ownerProfileId: profile, ownerWorkspaceId: null, ts: 1, userText: "Private original user text",
    agentText: "Private original assistant text", summary: "Project deployment fact", tags: [], toolCalls: [],
    reflection: null, value: .5, alpha: .5, priority: .5, rHuman: null,
    vecSummary: new Float32Array([1, 0, 0]), vecAction: null, turnId: 1, schemaVersion: 1 });
  return db;
}

it("synchronizes different DSH profiles bidirectionally and recalls a persisted remote vector offline", async () => {
  const desktopDb = source("desktop", "trace-desktop"), serverDb = source("nanopi", "trace-server");
  const credential = join(desktopDb.dir, "test-key.json");
  await writeFile(credential, JSON.stringify({ token: "synthetic-network-sync-pairing-key-abcdefghijklmnopqrstuvwxyz" }));
  const desktopStore = new PeerSyncStore({ home: desktopDb.dir, dbPath: desktopDb.filepath, nodeId: "desktop", profileId: "desktop", embeddingModel: model });
  const serverStore = new PeerSyncStore({ home: serverDb.dir, dbPath: serverDb.filepath, nodeId: "server", profileId: "nanopi", embeddingModel: model });
  desktopStore.open(); serverStore.open(); cleanups.push(() => desktopStore.close()); cleanups.push(() => serverStore.close());
  const serverConfig: MemoryRemoteConfig = { enabled: true, tokenFile: credential, url: "", lanDiscovery: false, syncEnabled: true, nodeId: "server", expectedNodeId: "desktop" };
  const server = new DshRemoteMemory({ config: () => serverConfig, localPort: 18801, profileId: "nanopi", sync: serverStore });
  cleanups.push(() => server.stop());
  const handler = createMemoryPeerHandler({ core: {} as MemoryCore, config: () => serverConfig, profileId: "nanopi", remote: server, sync: () => serverStore });
  const listener = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise<void>(resolve => { listener.close(() => resolve()); listener.closeAllConnections(); });
  cleanups.push(close);
  const config: MemoryRemoteConfig = { enabled: true, tokenFile: credential, url: `http://127.0.0.1:${(listener.address() as { port: number }).port}`,
    lanDiscovery: false, syncEnabled: true, nodeId: "desktop", expectedNodeId: "server" };
  const desktop = new DshRemoteMemory({ config: () => config, localPort: 18801, profileId: "desktop", sync: desktopStore,
    embedQuery: async () => ({ model, values: [1, 0, 0] }) });
  cleanups.push(() => desktop.stop()); await server.start(); await desktop.start(); await desktop.connect();
  expect(desktop.snapshot()).toMatchObject({ state: "connected", sync: { replicas: { trace: 1 }, vectors: 1 } });
  expect(serverStore.stats()).toMatchObject({ replicas: { trace: 1 }, vectors: 1, sourceProfiles: ["desktop"] });
  expect(desktopStore.stats().sourceProfiles).toEqual(["nanopi"]);
  expect(desktopDb.repos.traces.count()).toBe(1); expect(serverDb.repos.traces.count()).toBe(1);
  await desktop.connect(); expect(serverStore.stats().replicas.trace).toBe(1);
  await close(); desktopStore.close(); desktopStore.open();
  const recalled = await desktop.search({ agent: "deepseek-harness", query: "absent-lexical-term", deadlineAt: Date.now() + 2000 });
  expect(recalled.hits).toMatchObject([{ refId: "replica~server~trace-server", originNode: "server", sourceProfileId: "nanopi", vectorScore: 1 }]);
  expect(recalled.hits.some(hit => hit.refId.includes("trace-desktop"))).toBe(false);
  const detail = await desktop.getTrace(recalled.hits[0].refId);
  expect(detail).toMatchObject({ id: "trace-server", summary: "Project deployment fact", userText: "", agentText: "Project deployment fact" });
  expect(JSON.stringify(detail)).not.toContain("Private original");
});
