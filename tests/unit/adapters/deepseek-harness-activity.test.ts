import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_MAX_MODEL_RECORDS,
  ACTIVITY_MAX_SYNC_RECORDS,
  ACTIVITY_MAX_FILE_BYTES,
  DshActivityLedger,
  sanitizeActivityText,
} from "../../../adapters/deepseek-harness/activity.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "memos-dsh-activity-"));
  homes.push(home);
  return home;
}

describe("DSH activity ledger", () => {
  it("counts only confirmed sync items while retaining failed attempts", async () => {
    const home = await tempHome();
    const ledger = new DshActivityLedger(home);
    await ledger.load();

    ledger.recordSync({
      operation: "receive_push",
      direction: "receive",
      outcome: "failure",
      route: "lan",
      peer: "desktop",
      receivedItems: 9,
      inserted: 9,
      errorCode: "peer_sync_import_failed",
    });
    ledger.recordSync({
      operation: "serve_pull",
      direction: "send",
      outcome: "success",
      route: "gateway",
      peer: "desktop",
      sentItems: 3,
    });
    ledger.recordSync({
      operation: "pull",
      direction: "receive",
      outcome: "success",
      route: "lan",
      peer: "nanopi",
      receivedItems: 2,
      inserted: 1,
      updated: 1,
    });
    const snapshot = await ledger.snapshot();

    expect(snapshot.totals.sync).toMatchObject({
      attempts: 3,
      successes: 2,
      failures: 1,
      sentItems: 3,
      receivedItems: 2,
      inserted: 1,
      updated: 1,
      skipped: 0,
    });
    expect(snapshot.recentSync[0]).toMatchObject({
      outcome: "failure",
      receivedItems: 9,
      inserted: 9,
      errorCode: "peer_sync_import_failed",
    });
    expect(snapshot.recentSync[1].route).toBe("gateway");
  });

  it("restores counters and checks files without credentials or original sessions", async () => {
    const home = await tempHome();
    const first = new DshActivityLedger(home);
    await first.load();
    first.recordSync({
      operation: "push",
      direction: "send",
      outcome: "success",
      route: "wan",
      peer: "nanopi-m4v2",
      sentItems: 4,
    });
    const request = first.beginModel({
      operation: "history.refine",
      provider: "deepseek",
      model: "chat",
      at: 1_000,
    });
    request.finish({ outcome: "success" });
    first.recordSummary({
      source: "dsh",
      provider: "deepseek",
      model: "chat",
      summary: "Project at /srv/board-data uses Bearer raw-secret and https://user:pass@example.test/x?token=abc123&ok=1",
    });
    await first.close();

    const second = new DshActivityLedger(home);
    await second.load();
    const snapshot = await second.snapshot();
    expect(snapshot.session.sync.attempts).toBe(0);
    expect(snapshot.session.model.requests).toBe(0);
    expect(snapshot.totals.sync).toMatchObject({ attempts: 1, sentItems: 4 });
    expect(snapshot.totals.model).toMatchObject({ requests: 1, successes: 1, pending: 0 });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/raw-secret|Bearer [^[]|pass@|\?token=abc123|\/srv\/board-data/);
    expect(serialized).not.toContain("original user prompt");
    expect(serialized).not.toContain("original assistant answer");
    expect(await readFile(join(home, "dsh-activity.json"), "utf8")).toContain("[local path]");
  });

  it("keeps hard record limits and resolves every persisted pending request on restart", async () => {
    const home = await tempHome();
    const ledger = new DshActivityLedger(home);
    await ledger.load();
    for (let index = 0; index < ACTIVITY_MAX_SYNC_RECORDS + 7; index++) {
      ledger.recordSync({
        operation: "push",
        direction: "send",
        outcome: "success",
        route: "lan",
        peer: `peer-${index}`,
      });
    }
    const pending = Array.from(
      { length: ACTIVITY_MAX_MODEL_RECORDS + 9 },
      (_, index) => ledger.beginModel({
        operation: "memory.core_text",
        provider: "provider",
        model: `model-${index}`,
      }),
    );
    await ledger.close();

    const restored = new DshActivityLedger(home);
    await restored.load();
    const snapshot = await restored.snapshot();
    expect(snapshot.recentSync).toHaveLength(ACTIVITY_MAX_SYNC_RECORDS);
    expect(snapshot.recentModels).toHaveLength(ACTIVITY_MAX_MODEL_RECORDS);
    expect(snapshot.totals.model).toMatchObject({
      requests: ACTIVITY_MAX_MODEL_RECORDS + 9,
      pending: 0,
      failures: ACTIVITY_MAX_MODEL_RECORDS + 9,
    });
    pending.forEach((_request, index) => {
      expect(snapshot.totals.model.failures).toBeGreaterThan(index);
    });
  });

  it("marks persistence degraded when the activity file cannot be written", async () => {
    const home = await tempHome();
    const ledger = new DshActivityLedger(home);
    await ledger.load();
    await mkdir(join(home, "dsh-activity.json"));
    ledger.recordSync({
      operation: "push", direction: "send", outcome: "success", route: "lan", sentItems: 2,
    });
    const snapshot = await ledger.snapshot();
    expect(snapshot.totals.sync.successes).toBe(1);
    expect(snapshot.persistence).toMatchObject({ status: "degraded", warning: "activity_write_failed" });
  });

  it("rejects an oversized activity file before parsing and does not rewrite it on read", async () => {
    const home = await tempHome();
    const path = join(home, "dsh-activity.json");
    const oversized = "x".repeat(ACTIVITY_MAX_FILE_BYTES + 1);
    await writeFile(path, oversized);
    const fresh = new DshActivityLedger(home);
    await fresh.load();
    expect((await fresh.snapshot()).persistence).toMatchObject({ status: "degraded" });
    expect(await readFile(path, "utf8")).toBe(oversized);
  });

  it("keeps a bounded activity snapshot on the existing settings API shape", async () => {
    const home = await tempHome();
    const ledger = new DshActivityLedger(home);
    await ledger.load();
    ledger.recordSync({
      operation: "serve_pull",
      direction: "send",
      outcome: "success",
      route: "gateway",
      peer: "desktop",
      sentItems: 1,
    });
    const snapshot = await ledger.snapshot();
    expect(snapshot.recentSync[0]).toMatchObject({
      route: "gateway",
      sentItems: 1,
      receivedItems: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    });
    expect(snapshot.definition.syncCounts).toContain("不代表客户端已确认收到");
  });
});

describe("activity text sanitization", () => {
  it("removes absolute paths and URL credentials while preserving useful text", () => {
    const text = sanitizeActivityText([
      "Checked /srv/board-data, /tmp/cache, /opt/app and /var/tmp/work.",
      "Opened https://user:password@example.test/path?token=abc123&view=local.",
      "Windows D:\\Users\\name\\secret.txt and api_key=xxxxxxxx.",
      "Marked project evidence without source paths.",
    ].join(" "));
    expect(text).toContain("[local path]");
    expect(text).toContain("https://example.test/path?token=[redacted]");
    expect(text).toContain("Marked project evidence");
    expect(text).not.toMatch(/\/srv|\/tmp|\/opt|\/var\/tmp|D:\\|user:password|abc123|xxxxxxxx/);
  });
});
