import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeRepos, openDb, runMigrations, type Repos, type StorageDb } from "../../../core/storage/index.js";
import {
  loadSqliteDriver,
  resetSqliteDriverCache,
} from "../../../core/storage/drivers/index.js";
import {
  PeerSyncStore,
  PEER_SYNC_MAX_PAGE_ITEMS,
  PEER_SYNC_PROTOCOL,
  type PeerSyncPage,
} from "../../../adapters/deepseek-harness/peer-sync.js";

interface Fixture {
  root: string;
  sourcePath: string;
  db: StorageDb;
  repos: Repos;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Best effort cleanup for the test process.
    }
  }
});

function vector(values: number[]): Float32Array {
  return new Float32Array(values);
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-peer-sync-"));
  const sourcePath = path.join(root, "memos.db");
  const db = openDb({ filepath: sourcePath, agent: "deepseek-harness" });
  runMigrations(db);
  const repos = makeRepos(db);
  cleanups.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sourcePath, db, repos };
}

function seedTrace(f: Fixture, id = "trace-1"): void {
  f.repos.sessions.upsert({
    id: "session-1",
    agent: "deepseek-harness",
    startedAt: 100,
    lastSeenAt: 100,
    meta: {},
  });
  f.repos.episodes.insert({
    id: "episode-1",
    sessionId: "session-1",
    startedAt: 100,
    endedAt: null,
    traceIds: [],
    rTask: null,
    status: "open",
  });
  f.repos.traces.insert({
    id,
    episodeId: "episode-1",
    sessionId: "session-1",
    ownerAgentKind: "deepseek-harness",
    ownerProfileId: "default",
    ownerWorkspaceId: null,
    ts: 100,
    userText: "Please inspect the memory sync implementation.",
    agentText: "The implementation is ready.",
    summary: "Memory sync implementation summary",
    tags: ["sync"],
    toolCalls: [],
    reflection: "bounded reflection",
    value: 0.5,
    alpha: 0.4,
    rHuman: null,
    priority: 0.7,
    vecSummary: vector([1, 0, 0]),
    vecAction: vector([0, 1, 0]),
    turnId: 100,
    schemaVersion: 1,
  });
}

function pageOf(store: PeerSyncStore, options: { cursor?: string; limit?: number } = {}): PeerSyncPage {
  return store.exportPage(options);
}

const EMBEDDING = "local/Xenova/all-MiniLM-L6-v2";

function openStore(f: Fixture, overrides: Partial<ConstructorParameters<typeof PeerSyncStore>[0]> = {}): PeerSyncStore {
  const value = new PeerSyncStore({
    home: f.root,
    dbPath: f.sourcePath,
    nodeId: "node-a",
    profileId: "default",
    embeddingModel: EMBEDDING,
    ...overrides,
  });
  cleanups.push(() => value.close());
  value.open();
  return value;
}

describe("PeerSyncStore", () => {
  it("exports only summaries, structure and vector metadata", () => {
    const f = fixture();
    seedTrace(f);
    const store = openStore(f);

    const page = pageOf(store);
    expect(page.protocol).toBe(PEER_SYNC_PROTOCOL);
    expect(page.nodeId).toBe("node-a");
    expect(page.done).toBe(true);
    const trace = page.items.find((item) => item.id === "trace-1");
    expect(trace).toMatchObject({
      kind: "trace",
      revision: expect.any(String),
      payload: expect.objectContaining({ summary: "Memory sync implementation summary" }),
    });
    expect(trace?.payload).not.toHaveProperty("messages");
    expect(trace?.payload).not.toHaveProperty("toolCalls");
    expect(trace?.vectors).toEqual([
      { slot: "summary", model: EMBEDDING, dimension: 3, values: [1, 0, 0] },
      { slot: "action", model: EMBEDDING, dimension: 3, values: [0, 1, 0] },
    ]);
    expect(trace?.payload).not.toHaveProperty("userText");
    expect(trace?.payload).not.toHaveProperty("agentText");
    expect(JSON.stringify(page)).not.toContain("Please inspect the memory sync implementation.");
    expect(JSON.stringify(page)).not.toContain("The implementation is ready.");
    expect(JSON.stringify(page)).not.toContain(f.root);
  });

  it("reads the effective embedding identity from this profile's config", () => {
    const f = fixture();
    seedTrace(f);
    fs.writeFileSync(path.join(f.root, "config.yaml"), [
      "version: 1",
      "embedding:",
      "  provider: openai_compatible",
      "  model: text-embedding-3-small",
      "",
    ].join("\n"));
    const store = new PeerSyncStore({
      home: f.root,
      dbPath: f.sourcePath,
      nodeId: "node-a",
      profileId: "default",
    });
    cleanups.push(() => store.close());
    store.open();
    expect(store.stats().embeddingModel).toBe("openai_compatible/text-embedding-3-small");
    expect(store.exportPage().items.find(item => item.id === "trace-1")?.vectors)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ model: "openai_compatible/text-embedding-3-small" }),
      ]));
  });

  it("does not guess a vector model when no traceable identity is available", () => {
    const f = fixture();
    seedTrace(f);
    fs.writeFileSync(path.join(f.root, "config.yaml"), "version: 1\nembedding:\n  provider: ''\n");
    const store = new PeerSyncStore({
      home: f.root,
      dbPath: f.sourcePath,
      nodeId: "node-a",
      profileId: "default",
      embeddingModel: undefined,
    });
    cleanups.push(() => store.close());
    store.open();
    expect(store.stats().embeddingModel).toBeUndefined();
    expect(store.exportPage().items.find(item => item.id === "trace-1")?.vectors).toEqual([]);
    expect(() => store.search("memory", 10, {
      model: EMBEDDING,
      values: [1, 0, 0],
    })).toThrow(/known embedding model/i);
  });

  it("binds desktop to a differently named nanopi source profile without mixing local rows", () => {
    const f = fixture();
    seedTrace(f);
    f.repos.traces.insert({
      id: "trace-private",
      episodeId: "episode-1",
      sessionId: "session-1",
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "private",
      ownerWorkspaceId: null,
      ts: 101,
      userText: "private text",
      agentText: "private answer",
      summary: "private profile summary",
      tags: ["private"],
      toolCalls: [],
      reflection: null,
      value: 0.1,
      alpha: 0.2,
      rHuman: null,
      priority: 0.3,
      vecSummary: vector([0, 1, 0]),
      vecAction: null,
      turnId: 101,
      schemaVersion: 1,
    });
    f.repos.traces.insert({
      id: "trace-same-profile-other-agent",
      episodeId: "episode-1",
      sessionId: "session-1",
      ownerAgentKind: "openclaw",
      ownerProfileId: "private",
      ownerWorkspaceId: null,
      ts: 102,
      userText: "other agent text",
      agentText: "other agent answer",
      summary: "must not leave this agent",
      tags: [],
      toolCalls: [],
      reflection: null,
      value: 0,
      alpha: 0,
      rHuman: null,
      priority: 0,
      vecSummary: null,
      vecAction: null,
      turnId: 102,
      schemaVersion: 1,
    });
    const source = openStore(f, { profileId: "private", nodeId: "server-nanopi" });
    const desktop = openStore(f, { profileId: "desktop", nodeId: "desktop" });
    const otherDesktop = openStore(f, { profileId: "desktop-other", nodeId: "desktop-other" });
    expect(desktop.exportPage().items.some(item => item.id === "trace-private")).toBe(false);
    const page = source.exportPage();
    expect(page.profileId).toBe("private");
    expect(page.items.some(item => item.id === "trace-private")).toBe(true);
    expect(page.items.some(item => item.id === "trace-same-profile-other-agent")).toBe(false);
    expect(page.items.every(item => item.payload.ownerProfileId === "private")).toBe(true);
    expect(() => desktop.importPage(page, "server-nanopi", "nanopi")).toThrow(/profile/i);
    expect(desktop.importPage({
      ...page,
      items: page.items.map(item => ({
        ...item,
        id: `${item.id}-mirror`,
        revision: `${item.revision}-mirror`,
      })),
    }, "server-nanopi", "private").inserted).toBeGreaterThan(0);
    expect(desktop.stats().sourceProfiles).toEqual(["private"]);
    expect(desktop.search("private profile", 10).some(hit =>
      hit.refId.startsWith("replica~server-nanopi~")
      && hit.ownerProfileId === "desktop"
      && hit.sourceProfileId === "private"
    )).toBe(true);
    expect(desktop.getTrace("trace-private-mirror", "server-nanopi")).toMatchObject({
      ownerProfileId: "desktop",
      sourceProfileId: "private",
    });
    expect(desktop.getTrace("trace-private")).toBeNull();
    expect(otherDesktop.stats().replicas.trace).toBe(0);
    expect(otherDesktop.search("private profile", 10)).toEqual([]);
  });

  it("redacts credential-shaped fields and does not re-export imported pages", () => {
    const f = fixture();
    seedTrace(f);
    f.repos.policies.upsert({
      id: "policy-1",
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "Never expose api_key=sk-super-secret-value",
      trigger: "password=supersecret",
      procedure: "Use the local mirror.",
      verification: "Check the result.",
      boundary: "Do not upload /srv/private/memory.db",
      support: 1,
      gain: 0.2,
      status: "active",
      sourceEpisodeIds: [],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: vector([0.5, 0.5]),
      createdAt: 100,
      updatedAt: 100,
    });
    const store = openStore(f);
    const page = pageOf(store);
    expect(JSON.stringify(page)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(page)).not.toContain("supersecret");
    expect(JSON.stringify(page)).not.toContain("/srv/private");
    const imported = store.importPage({
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: "node-b",
      profileId: "default",
      done: true,
      items: [{
        kind: "policy",
        id: "remote-policy",
        revision: "r1",
        payload: {
          title: "remote",
          updatedAt: 200,
          ownerAgentKind: "deepseek-harness",
          ownerProfileId: "default",
        },
        vectors: [],
      }],
    }, "node-b", "default");
    expect(imported.inserted).toBe(1);
    const second = pageOf(store);
    expect(second.items.some((item) => item.id === "remote-policy")).toBe(false);
  });

  it("paginates, notices later updates, and resumes after reopening", () => {
    const f = fixture();
    seedTrace(f);
    for (let i = 0; i < 4; i++) {
      f.repos.skills.insert({
        id: `skill-${i}`,
        ownerAgentKind: "deepseek-harness",
        ownerProfileId: "default",
        ownerWorkspaceId: null,
        name: `skill-${i}`,
        status: "active",
        invocationGuide: `guide-${i}`,
        procedureJson: null,
        eta: 0.5,
        support: 1,
        gain: 0,
        trialsAttempted: 0,
        trialsPassed: 0,
        sourcePolicyIds: [],
        sourceWorldModelIds: [],
        evidenceAnchors: [],
        vec: vector([i + 1, 0]),
        createdAt: 100 + i,
        updatedAt: 100 + i,
        version: 1,
      });
    }
    const store = openStore(f);
    const first = pageOf(store, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.done).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    let second = pageOf(store, { cursor: first.nextCursor, limit: 50 });
    while (!second.done && second.nextCursor) {
      const next = pageOf(store, { cursor: second.nextCursor, limit: 50 });
      expect(next.items.length).toBeGreaterThan(0);
      second = next;
    }
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeTruthy();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size)
      .toBe(first.items.length + second.items.length);

    f.repos.traces.updateScore("trace-1", { value: 0.9, alpha: 0.8, priority: 1 });
    let sweepCursor = second.nextCursor;
    let sawUpdatedTrace = false;
    let sweepNext: string | undefined;
    for (let page = 0; page < PEER_SYNC_MAX_PAGE_ITEMS; page++) {
      const swept = pageOf(store, { cursor: sweepCursor, limit: PEER_SYNC_MAX_PAGE_ITEMS });
      sawUpdatedTrace ||= swept.items.some(item => item.id === "trace-1" && item.payload.value === 0.9);
      if (swept.done) {
        expect(swept.nextCursor).toBeTruthy();
        sweepNext = swept.nextCursor;
        break;
      }
      sweepCursor = swept.nextCursor;
    }
    expect(sawUpdatedTrace).toBe(true);
    expect(sweepNext).toBeTruthy();
    expect(pageOf(store, { cursor: sweepNext }).nextCursor).toBeTruthy();
    store.close();

    const reopened = new PeerSyncStore({
      home: f.root,
      dbPath: f.sourcePath,
      nodeId: "node-a",
      profileId: "default",
      embeddingModel: EMBEDDING,
    });
    cleanups.push(() => reopened.close());
    reopened.open();
    expect(reopened.stats().source.trace).toBe(1);
  });

  it("pages deterministically when different kinds share one timestamp", () => {
    const f = fixture();
    seedTrace(f);
    f.repos.policies.upsert({
      id: "policy-same-ts",
      ownerAgentKind: "deepseek-harness",
      ownerProfileId: "default",
      ownerWorkspaceId: null,
      title: "same timestamp policy",
      trigger: "",
      procedure: "",
      verification: "",
      boundary: "",
      support: 1,
      gain: 0,
      status: "active",
      sourceEpisodeIds: [],
      inducedBy: "test",
      decisionGuidance: { preference: [], antiPattern: [] },
      vec: null,
      createdAt: 100,
      updatedAt: 100,
    });
    const store = openStore(f);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const page = pageOf(store, { cursor, limit: 1 });
      seen.push(...page.items.map((item) => `${item.kind}:${item.id}`));
      if (page.done) break;
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("trace:trace-1");
    expect(seen).toContain("policy:policy-same-ts");
  });

  it("imports idempotently and rejects malicious or incompatible pages", () => {
    const f = fixture();
    seedTrace(f);
    const store = openStore(f);
    const remote: PeerSyncPage = {
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: "node-b",
      profileId: "default",
      done: true,
      items: [{
        kind: "trace",
        id: "trace-b",
        revision: "rev-1",
        payload: {
          summary: "remote summary",
          ts: 200,
          ownerAgentKind: "deepseek-harness",
          ownerProfileId: "default",
        },
        vectors: [{ slot: "summary", model: "m1", dimension: 2, values: [1, 0] }],
      }],
    };
    expect(store.importPage(remote, "node-b", "default")).toEqual({ inserted: 1, updated: 0, skipped: 0 });
    expect(store.importPage(remote, "node-b", "default")).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect(store.stats().replicas.trace).toBe(1);
    expect(() => store.importPage(remote, "node-c", "default")).toThrow(/node id/i);
    expect(() => store.importPage({ ...remote, profileId: "other" }, "node-b", "default"))
      .toThrow(/profile/i);
    expect(() => store.importPage({ ...remote, profileId: undefined }, "node-b", "default"))
      .toThrow(/profile/i);
    expect(() => store.importPage(remote, "node-b", "other")).toThrow(/profile/i);
    expect(() => store.importPage({ ...remote, protocol: "wrong" }, "node-b", "default")).toThrow(/protocol/i);
    expect(() => store.importPage({ ...remote, items: [{ ...remote.items[0], kind: "messages" }] }, "node-b", "default"))
      .toThrow(/kind/i);
    expect(() => store.importPage({
      ...remote,
      items: [{
        ...remote.items[0],
        vectors: [{ slot: "summary", model: "m1", dimension: 2, values: [1, Number.NaN] }],
      }],
    }, "node-b", "default")).toThrow(/non-finite/i);
    expect(store.stats().source.trace).toBe(1);
  });

  it("searches lexical and vector mirrors while preserving origin labels", () => {
    const f = fixture();
    seedTrace(f);
    const store = openStore(f);
    store.importPage({
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: "node-b",
      profileId: "default",
      done: true,
      items: [{
        kind: "trace",
        id: "trace-b",
        revision: "rev-b",
        payload: {
          summary: "remote memory sync summary",
          ts: 200,
          ownerAgentKind: "deepseek-harness",
          ownerProfileId: "default",
        },
        vectors: [{ slot: "summary", model: EMBEDDING, dimension: 3, values: [1, 0, 0] }],
      }],
    }, "node-b", "default");
    const hits = store.search("memory sync", 10, { model: EMBEDDING, values: [1, 0, 0] });
    expect(hits.some((hit) => hit.refId === "remote~trace-1" && hit.origin === "local")).toBe(true);
    expect(hits.some((hit) => hit.refId === "replica~node-b~trace-b" && hit.originNode === "node-b")).toBe(true);
    expect(() => store.search("memory sync", 10, { model: "other", values: [1, 0, 0] }))
      .toThrow(/does not match/i);
    expect(store.search("memory sync", 10, { model: EMBEDDING, values: [1, 0, 0] })
      .some((hit) => hit.vectorScore !== undefined)).toBe(true);
    expect(store.getTrace("trace-1")).toMatchObject({
      id: "trace-1",
      episodeId: "episode-1",
      sessionId: "session-1",
      agentText: "Memory sync implementation summary",
      toolCalls: [],
      turnId: 100,
      originNode: "node-a",
      remoteId: "trace-1",
    });
    expect(store.getTrace("replica~node-b~trace-b")).toMatchObject({
      id: "trace-b",
      agentText: "remote memory sync summary",
      originNode: "node-b",
      remoteId: "replica~node-b~trace-b",
      refId: "replica~node-b~trace-b",
    });
    expect(store.getTrace("trace-b", "node-b")).toMatchObject({
      id: "trace-b",
      originNode: "node-b",
      refId: "replica~node-b~trace-b",
    });
    expect(store.getTrace("trace-1", "node-b")).toMatchObject({ originNode: "node-a" });
  });

  it("skips absent source tables safely and enforces bounded page sizes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memos-peer-empty-"));
    const sourcePath = path.join(root, "memos.db");
    const db = openDb({ filepath: sourcePath, agent: "deepseek-harness" });
    db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    cleanups.push(() => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const store = new PeerSyncStore({
      home: root,
      dbPath: sourcePath,
      nodeId: "node-empty",
      profileId: "default",
    });
    cleanups.push(() => store.close());
    store.open();
    expect(store.exportPage()).toMatchObject({ protocol: PEER_SYNC_PROTOCOL, done: true, items: [] });
    expect(store.stats().source).toEqual({ trace: 0, policy: 0, world_model: 0, skill: 0 });
    expect(() => store.exportPage({ limit: 0 })).not.toThrow();
  });

  it("runs export and import through the node:sqlite fallback", () => {
    const previous = process.env["MEMOS_SQLITE_DRIVER"];
    process.env["MEMOS_SQLITE_DRIVER"] = "node:sqlite";
    resetSqliteDriverCache();
    cleanups.push(() => {
      if (previous === undefined) delete process.env["MEMOS_SQLITE_DRIVER"];
      else process.env["MEMOS_SQLITE_DRIVER"] = previous;
      resetSqliteDriverCache();
    });
    expect(loadSqliteDriver().engine).toBe("node:sqlite");
    const f = fixture();
    seedTrace(f);
    const store = new PeerSyncStore({
      home: f.root,
      dbPath: f.sourcePath,
      nodeId: "node-fallback",
      profileId: "default",
      embeddingModel: EMBEDDING,
    });
    cleanups.push(() => store.close());
    store.open();
    const page = store.exportPage({ limit: 20 });
    expect(page.items.some((item) => item.id === "trace-1")).toBe(true);
    expect(store.importPage({
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: "node-peer",
      profileId: "default",
      done: true,
      items: page.items.map((item) => ({
        ...item,
        id: `${item.id}-mirror`,
        revision: `${item.revision}-mirror`,
        payload: {
          ownerAgentKind: "deepseek-harness",
          ownerProfileId: "default",
          ...item.payload,
        },
      })),
    }, "node-peer", "default").inserted).toBeGreaterThan(0);
    expect(store.stats().replicas.trace).toBeGreaterThan(0);
  });
});
