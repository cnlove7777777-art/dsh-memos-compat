import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import type { HostLlmBridge } from "../../../core/llm/host-bridge.js";
import {
  DshHistoryWorker,
  type HistoryConfig,
} from "../../../adapters/deepseek-harness/history.js";
import type { HistoryTurn } from "../../../adapters/deepseek-harness/history-readers.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "memos-history-worker-"));
  homes.push(home);
  return home;
}

async function tempFileOutside(name: string): Promise<string> {
  const outside = await mkdtemp(join(tmpdir(), "memos-history-outside-"));
  homes.push(outside);
  const path = join(outside, name);
  await writeFile(path, "{}\n");
  return path;
}

function turn(index: number, ts = Date.now()): HistoryTurn {
  return {
    source: "codex",
    sessionId: "synthetic-session",
    turnKey: `codex:synthetic-session:${index}:deadbeefdeadbeef`,
    userText: `synthetic question ${index}`,
    agentText: `synthetic answer ${index}`,
    ts,
    sourceRef: `/synthetic/rollout.jsonl:${index}`,
    cwd: "/synthetic",
  };
}

function config(home: string, maxTurns?: number) {
  const codexRoot = join(home, "codex");
  const dshRoot = join(home, "dsh");
  const value: HistoryConfig = {
    enabled: true,
    codexRoot,
    dshRoot,
    recentDays: 7,
    backgroundModel: { provider: "local", model: "synthetic" },
    remote: { enabled: false, url: "", tokenFile: "" },
  };
  return { value, codexRoot, dshRoot, maxTurns };
}

async function historyFile(codexRoot: string, name: string): Promise<string> {
  const now = new Date();
  const dir = join(
    codexRoot,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  );
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, "{}\n");
  return path;
}

function coreFake(options: {
  existing?: Set<string>;
  imported?: number;
  importThrows?: boolean;
  embeddingFails?: boolean;
} = {}) {
  const existing = options.existing ?? new Set<string>();
  const getTrace = vi.fn(async (id: string) => existing.has(id) ? { id } : null);
  const importBundle = vi.fn(async (bundle: { traces?: Array<{ id: string }> }) => {
    if (options.importThrows) throw new Error("synthetic import failure");
    for (const trace of bundle.traces ?? []) existing.add(trace.id);
    return { imported: options.imported ?? 1, skipped: 0 };
  });
  const rebuildEmbeddings = vi.fn(async () => ({
    mode: "repair" as const,
    processed: 1,
    updated: 0,
    failed: options.embeddingFails ? 1 : 0,
    offset: 0,
    nextOffset: 0,
    done: true,
    statsBefore: stats(),
    statsAfter: stats(options.embeddingFails ? 0 : 1),
  }));
  return {
    core: {
      getTrace,
      importBundle,
      rebuildEmbeddings,
    } as unknown as MemoryCore,
    getTrace,
    importBundle,
    rebuildEmbeddings,
  };
}

function stats(ready = 1) {
  const kind = {
    totalSlots: 1,
    ready,
    missing: 0,
    dimMismatch: 0,
    needsRepair: 0,
  };
  return {
    dimension: 384,
    available: true,
    totalSlots: 1,
    ready,
    missing: 0,
    dimMismatch: 0,
    needsRepair: 0,
    byKind: {
      trace: kind,
      policy: { ...kind },
      world_model: { ...kind },
      skill: { ...kind },
    },
  };
}

function bridgeFake(options: {
  reject?: Error;
  onComplete?: () => Promise<void>;
} = {}) {
  const complete = vi.fn(async () => {
    if (options.onComplete) await options.onComplete();
    if (options.reject) throw options.reject;
    return {
      text: "{\"summary\":\"synthetic refined memory\"}",
      model: "synthetic",
      durationMs: 1,
    };
  });
  return {
    bridge: {
      id: "synthetic",
      complete,
    } as unknown as HostLlmBridge,
    complete,
  };
}

async function worker(options: {
  home: string;
  codexRoot: string;
  dshRoot: string;
  turns: HistoryTurn[];
  core?: ReturnType<typeof coreFake>;
  bridge?: ReturnType<typeof bridgeFake>;
  route?: () => { provider: string; model: string } | undefined;
  maxTurns?: number;
  reader?: (path: string, source: "codex" | "dsh") => Promise<HistoryTurn[]>;
}) {
  const core = options.core ?? coreFake();
  const bridge = options.bridge ?? bridgeFake();
  const route = options.route ?? (() => ({ provider: "local", model: "synthetic" }));
  const reader = options.reader ?? vi.fn(async () => options.turns);
  const value = new DshHistoryWorker({
    home: options.home,
    profileId: "synthetic-profile",
    core: core.core,
    bridge: bridge.bridge,
    route,
    withRoute: async (_route, operation) => operation(),
    validateModel: async () => undefined,
    mcp: () => ({ enabled: false }),
    reader,
    maxTurns: options.maxTurns,
  });
  const workerConfig: HistoryConfig = {
    enabled: true,
    codexRoot: options.codexRoot,
    dshRoot: options.dshRoot,
    recentDays: 7,
    backgroundModel: { provider: "local", model: "synthetic" },
    remote: { enabled: false, url: "", tokenFile: "" },
  };
  const start = async (): Promise<void> => {
    value.config = workerConfig;
    await value.run();
  };
  const resume = async (): Promise<void> => {
    await value.load();
    value.config = workerConfig;
    await value.run();
  };
  return { worker: value, config: workerConfig, core, bridge, reader, start, resume };
}

describe("DshHistoryWorker synthetic lifecycle", () => {
  it("preserves full source references across a restart independently of short tags", async () => {
    const home = await tempHome(); const cfg = config(home);
    const path = await historyFile(cfg.codexRoot, "rollout-synthetic.jsonl");
    const fixture = { ...turn(1), sourceRef: `${path}:123` };
    const first = await worker({ home, codexRoot: cfg.codexRoot, dshRoot: cfg.dshRoot, turns: [fixture] });
    await first.start(); await first.worker.waitForIdle();
    const id = first.core.importBundle.mock.calls[0][0].traces![0].id;
    const next = await worker({ home, codexRoot: cfg.codexRoot, dshRoot: cfg.dshRoot, turns: [fixture], core: first.core });
    await next.worker.load();
    expect(next.worker.sourceFor(id)?.ref).toBe(`${path}:123`);
  });
  it("prioritizes only existing configured files from a local receipt", async () => {
    const home = await tempHome(); const cfg = config(home);
    const wanted = await historyFile(cfg.codexRoot, "rollout-wanted.jsonl");
    await historyFile(cfg.codexRoot, "rollout-other.jsonl");
    await writeFile(join(home, "dsh-history-priority.json"), JSON.stringify({ sourceFiles: [wanted] }));
    const f = await worker({ home, codexRoot: cfg.codexRoot, dshRoot: cfg.dshRoot, turns: [turn(1)] });
    await f.resume(); await f.worker.waitForIdle();
    expect(f.reader).toHaveBeenCalledOnce(); expect(f.reader).toHaveBeenCalledWith(wanted, "codex");
  });
  it("imports through the injected reader and becomes idempotent from its cursor", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-synthetic.jsonl");
    const fixture = turn(1);
    const first = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [fixture],
    });
    await first.start();
    await first.worker.waitForIdle();
    expect(first.core.importBundle).toHaveBeenCalledOnce();
    expect(first.core.importBundle.mock.calls[0][0].traces![0]).toMatchObject({ priority: 0.5, value: 0 });
    expect(first.bridge.complete).toHaveBeenCalledOnce();
    const cursor = JSON.parse(await readFile(join(home, "dsh-history-cursors.json"), "utf8"));
    expect(Object.keys(cursor.files)).toHaveLength(1);

    const second = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [fixture],
    });
    await second.resume();
    await second.worker.waitForIdle();
    expect(second.reader).not.toHaveBeenCalled();
    expect(second.core.importBundle).not.toHaveBeenCalled();
    expect(second.bridge.complete).not.toHaveBeenCalled();
  });

  it("denies an admin source outside configured roots without invoking the reader", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-inside.jsonl");
    const outside = await tempFileOutside("rollout-outside.jsonl");
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
    });
    run.worker.config = run.config;
    await run.worker.run({ sourceFiles: [outside] });
    await run.worker.waitForIdle();
    expect(run.reader).not.toHaveBeenCalled();
    expect(run.bridge.complete).not.toHaveBeenCalled();
  });

  it("accepts an admin source inside the configured recent root", async () => {
    const home = await tempHome();
    const cfg = config(home);
    const inside = await historyFile(cfg.codexRoot, "rollout-admin-inside.jsonl");
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
    });
    run.worker.config = run.config;
    await run.worker.run({ sourceFiles: [inside] });
    await run.worker.waitForIdle();
    expect(run.reader).toHaveBeenCalledOnce();
    expect(run.reader).toHaveBeenCalledWith(inside, "codex");
  });

  it("does not checkpoint a file whose remaining turns exceed the batch budget", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-budget.jsonl");
    const fixture = [turn(1), turn(2), turn(3)];
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: fixture,
      maxTurns: 1,
    });
    run.worker.config = { ...run.config, backgroundModel: undefined };
    await run.worker.run();
    await run.worker.waitForIdle();
    expect(run.core.importBundle).toHaveBeenCalledOnce();
    const cursor = JSON.parse(await readFile(join(home, "dsh-history-cursors.json"), "utf8"));
    expect(cursor.files).toEqual({});

    const resume = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: fixture,
      maxTurns: 10,
    });
    await resume.resume();
    await resume.worker.waitForIdle();
    expect(resume.core.getTrace).toHaveBeenCalled();
    expect(resume.core.importBundle).toHaveBeenCalledTimes(3);
  });

  it("returns promptly when no model route is available and never calls the bridge", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-no-model.jsonl");
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      route: () => undefined,
      bridge: bridgeFake(),
    });
    run.worker.config = { ...run.config, backgroundModel: undefined };
    const snapshot = await run.worker.run();
    expect(snapshot).toMatchObject({ status: { waitingForModel: true, running: true } });
    await run.worker.waitForIdle();
    expect(run.bridge.complete).not.toHaveBeenCalled();
  });

  it("uses the live model route for follow mode when no fixed model is saved", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-follow.jsonl");
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      route: () => ({ provider: "follow", model: "active-chat" }),
    });
    run.worker.config = { ...run.config, backgroundModel: undefined };
    await run.worker.run();
    await run.worker.waitForIdle();
    expect(run.bridge.complete).toHaveBeenCalledOnce();
    expect(run.core.importBundle).toHaveBeenCalledOnce();
  });

  it("does not checkpoint after a model failure and retries the turn", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-model-failure.jsonl");
    const failure = bridgeFake({ reject: new Error("synthetic model failure") });
    const failed = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      bridge: failure,
    });
    await failed.start();
    await failed.worker.waitForIdle();
    expect((await failed.worker.snapshot()) as { status: { lastError?: string } })
      .toMatchObject({ status: { lastError: expect.stringMatching(/maintenance failed/i) } });
    const cursorPath = join(home, "dsh-history-cursors.json");
    const cursor = await readFile(cursorPath, "utf8").catch(() => "{\"files\":{}}");
    expect(JSON.parse(cursor).files).toEqual({});

    const retryBridge = bridgeFake();
    const retry = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      bridge: retryBridge,
    });
    await retry.resume();
    await retry.worker.waitForIdle();
    expect(retryBridge.complete).toHaveBeenCalledOnce();
    expect(retry.core.importBundle).toHaveBeenCalledOnce();
  });

  it("keeps a completed cursor when embedding repair fails, then retries repair", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-embedding.jsonl");
    const firstCore = coreFake({ embeddingFails: true });
    const first = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      core: firstCore,
    });
    await first.start();
    await first.worker.waitForIdle();
    expect(firstCore.importBundle).toHaveBeenCalledOnce();
    const cursor = JSON.parse(await readFile(join(home, "dsh-history-cursors.json"), "utf8"));
    expect(Object.keys(cursor.files)).toHaveLength(1);

    const secondCore = coreFake();
    const second = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      core: secondCore,
    });
    await second.resume();
    await second.worker.waitForIdle();
    expect(secondCore.rebuildEmbeddings).toHaveBeenCalledOnce();
    expect(secondCore.importBundle).not.toHaveBeenCalled();
  });

  it("aborts an in-flight model call on stop and imports nothing after stop", async () => {
    const home = await tempHome();
    const cfg = config(home);
    await historyFile(cfg.codexRoot, "rollout-stop.jsonl");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const bridge = bridgeFake({ onComplete: () => waiting });
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
      bridge,
    });
    await run.start();
    await Promise.resolve();
    await run.worker.stop();
    release();
    await run.worker.waitForIdle();
    expect(run.core.importBundle).not.toHaveBeenCalled();
  });

  it("fails closed on corrupt settings until a valid save repairs them", async () => {
    const home = await tempHome();
    await writeFile(join(home, "dsh-history.json"), "{broken");
    const cfg = config(home);
    const run = await worker({
      home,
      codexRoot: cfg.codexRoot,
      dshRoot: cfg.dshRoot,
      turns: [turn(1)],
    });
    await run.worker.load();
    expect(run.worker.config.enabled).toBe(false);
    expect((await run.worker.snapshot()) as { status: { lastError?: string } })
      .toMatchObject({ status: { lastError: expect.stringMatching(/save to repair/i) } });

    await run.worker.save(cfg.value);
    expect(run.worker.config.enabled).toBe(true);
    const saved = JSON.parse(await readFile(join(home, "dsh-history.json"), "utf8"));
    expect(saved.config.enabled).toBe(true);
  });
});
