/**
 * better-sqlite3-compatible driver backed by Node/Electron's built-in
 * `node:sqlite`.
 *
 * Why this exists: DSH Desktop ships Electron's own Node runtime, and its
 * module version (ABI) does not always match the `better-sqlite3` prebuild
 * that npm installs for the plugin. On DSH 0.2.1-rc.2 (Electron 44.7, Node
 * 24.21, ABI 149) the installed `better-sqlite3@12` binary is ABI 127, so
 * `import BetterSqlite3 from "better-sqlite3"` fails with `ERR_DLOPEN_FAILED`
 * and MemOS cannot open its database at all.
 *
 * This module is used only as a fallback: `loadDriver()` tries the real
 * `better-sqlite3` first and only falls back here when it cannot be loaded.
 * It implements exactly the surface `core/storage/connection.ts` uses —
 * `prepare`/`run`/`get`/`all`/`iterate`, `exec`, `pragma`, `transaction`,
 * `unsafeMode`, `close` — and nothing else. It is not a general-purpose
 * better-sqlite3 replacement.
 *
 * Known limits (documented in README):
 *   - `iterate()` materializes the result set; `node:sqlite` exposes no
 *     streaming cursor. Fine for a new, small database; not a streaming
 *     implementation for a large corpus.
 *   - `unsafeMode()` is a no-op. `node:sqlite` does not enable
 *     SQLITE_DBCONFIG_DEFENSIVE, so `PRAGMA writable_schema` works without it.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Row shape as produced by node:sqlite before JSON/Float32 re-inflation. */
type Row = Record<string, unknown>;

/** Named or positional bind parameters, matching better-sqlite3's signature. */
type BindArgs = Record<string, unknown> | readonly unknown[];

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

/**
 * node:sqlite rejects a named-parameter object carrying keys the statement
 * does not declare, while better-sqlite3 silently ignores them. MemOS reuses
 * one params object across several SQL statements, so pass only the names
 * this statement actually declares.
 */
function filterNamedParameters(sql: string, args: BindArgs): unknown {
  if (Array.isArray(args) || typeof args !== "object" || args === null) return args;
  const source = args as Record<string, unknown>;
  const declared: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`@${escaped}\\b`).test(sql)) declared[key] = source[key];
  }
  return declared;
}

function invoke(
  statement: SqliteStatement,
  method: "run" | "get" | "all",
  sql: string,
  args?: BindArgs,
): unknown {
  const bound = args === undefined ? args : filterNamedParameters(sql, args);
  try {
    if (bound === undefined) return statement[method]();
    if (Array.isArray(bound)) return statement[method](...(bound as unknown[]));
    return statement[method](bound as Record<string, unknown>);
  } catch (error) {
    if (String((error as Error)?.message).includes("Unknown named parameter")) {
      (error as Error & { sql?: string; boundArgs?: unknown }).sql = sql;
      (error as Error & { boundArgs?: unknown }).boundArgs = args;
    }
    throw error;
  }
}

class DriverStatement {
  #statement: SqliteStatement;
  #db: DriverDatabase;
  #sql: string;

  constructor(statement: SqliteStatement, db: DriverDatabase, sql: string) {
    this.#statement = statement;
    this.#db = db;
    this.#sql = sql;
  }

  run(args?: BindArgs): { changes: number; lastInsertRowid: number | bigint } {
    const result = invoke(this.#statement, "run", this.#sql, args) as {
      changes?: number;
      lastInsertRowid?: number | bigint;
    };
    // node:sqlite reports a closed database lazily on the next call; keep the
    // handle's own `open` flag in sync so callers see it immediately.
    this.#db.open = true;
    return {
      changes: result.changes ?? 0,
      lastInsertRowid: result.lastInsertRowid ?? 0,
    };
  }

  get(args?: BindArgs): Row | undefined {
    const row = invoke(this.#statement, "get", this.#sql, args);
    return row === null || row === undefined ? undefined : (row as Row);
  }

  all(args?: BindArgs): Row[] {
    return invoke(this.#statement, "all", this.#sql, args) as Row[];
  }

  *iterate(args?: BindArgs): IterableIterator<Row> {
    // Compatibility only: node:sqlite has no streaming cursor here.
    for (const row of invoke(this.#statement, "all", this.#sql, args) as Row[]) {
      yield row;
    }
  }
}

export class DriverDatabase {
  #db: SqliteDatabase;
  open = true;

  constructor(file: string, options: { readonly?: boolean } = {}) {
    const nodeSqlite = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { open?: boolean; readOnly?: boolean },
      ) => SqliteDatabase;
    };
    this.#db = new nodeSqlite.DatabaseSync(file, {
      open: true,
      readOnly: Boolean(options.readonly),
    });
  }

  prepare(sql: string): DriverStatement {
    return new DriverStatement(this.#db.prepare(sql), this, sql);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  pragma(text: string): unknown[] {
    return this.#db.prepare(`PRAGMA ${text}`).all() as unknown[];
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): (...args: never[]) => unknown {
    return (...args: never[]) => {
      this.#db.exec("BEGIN");
      try {
        const result = fn(...args);
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // A failed ROLLBACK is already losing; surface the original error.
        }
        throw error;
      }
    };
  }

  unsafeMode(): void {
    // node:sqlite does not enable SQLITE_DBCONFIG_DEFENSIVE, so there is
    // nothing to turn off: `PRAGMA writable_schema` is already permitted.
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.#db.close();
  }
}

export default DriverDatabase;
