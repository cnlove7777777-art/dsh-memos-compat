import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSqliteDriver,
  resetSqliteDriverCache,
} from "../../../core/storage/drivers/index.js";
import { openDb, runMigrations } from "../../../core/storage/index.js";

/**
 * The DSH runtime cannot always load a `better-sqlite3` prebuild — DSH
 * Desktop ships Electron 44.7 / Node 24.21 (ABI 149), which the installed
 * `better-sqlite3@12` binary does not match. These tests pin the two
 * behaviours the DSH build depends on: the engine can be forced, and the
 * `node:sqlite` fallback speaks the same dialect the storage layer uses.
 */
describe("storage/sqlite driver selection", () => {
  let dir: string;
  let filepath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-driver-"));
    filepath = path.join(dir, "t.db");
    resetSqliteDriverCache();
  });

  afterEach(() => {
    resetSqliteDriverCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("honours an explicit engine override", () => {
    expect(loadSqliteDriver({ MEMOS_SQLITE_DRIVER: "node:sqlite" }).engine).toBe(
      "node:sqlite",
    );
    resetSqliteDriverCache();
    // better-sqlite3 is present in the test environment; asserting it here
    // keeps the override from silently masking a broken default path.
    expect(loadSqliteDriver({ MEMOS_SQLITE_DRIVER: "better-sqlite3" }).engine).toBe(
      "better-sqlite3",
    );
  });

  it("caches the resolved engine", () => {
    const first = loadSqliteDriver({});
    expect(loadSqliteDriver({ MEMOS_SQLITE_DRIVER: "node:sqlite" })).toBe(first);
  });

  it("runs every migration and full CRUD through the node:sqlite fallback", () => {
    const db = openDb({ filepath, agent: "deepseek-harness" });
    try {
      const applied = runMigrations(db);
      expect(applied.applied.length).toBeGreaterThan(0);
      expect(db.isReady()).toBe(true);

      // Named parameters with extra keys: the storage layer reuses one params
      // object across statements, and node:sqlite rejects undeclared names.
      db.prepare(
        `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json)
         VALUES (@id, @agent, @s, @l, '{}')`,
      ).run({ id: "s0", agent: "deepseek-harness", s: 1, l: 1, extra: "ignored" });
      expect(
        db.prepare<unknown, { id: string }>(
          `SELECT id FROM sessions WHERE agent=@agent`,
        ).get({ agent: "deepseek-harness" })?.id,
      ).toBe("s0");

      // Transactions commit and roll back.
      db.tx(() => {
        db.prepare(
          `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json)
           VALUES (@id, @agent, @s, @l, '{}')`,
        ).run({ id: "s1", agent: "deepseek-harness", s: 2, l: 2 });
      });
      expect(() =>
        db.tx(() => {
          db.prepare(
            `INSERT INTO sessions (id, agent, started_at, last_seen_at, meta_json)
             VALUES (@id, @agent, @s, @l, '{}')`,
          ).run({ id: "s2", agent: "deepseek-harness", s: 3, l: 3 });
          throw new Error("boom");
        }),
      ).toThrow(/boom/);
      const ids = db
        .prepare<unknown, { id: string }>(`SELECT id FROM sessions ORDER BY id`)
        .all()
        .map((r) => r.id);
      expect(ids).toEqual(["s0", "s1"]);

      // iterate() is materialized by the fallback; it must still yield rows.
      const iterated = [...db.prepare(`SELECT id FROM sessions ORDER BY id`).iterate()];
      expect(iterated).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
