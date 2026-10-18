/**
 * SQLite engine selection.
 *
 * `better-sqlite3` is the primary engine and is loaded normally. When its
 * native prebuild cannot be loaded in the current runtime — which is what
 * happens on DSH Desktop, where Electron's Node ABI does not match the
 * prebuild npm installed — we fall back to the built-in `node:sqlite`
 * driver instead of failing to open the database.
 *
 * The fallback is resolved once and cached, because `import()` of a native
 * binding that throws is both slow and noisy on every call.
 */

import type BetterSqlite3 from "better-sqlite3";

import { DriverDatabase } from "./node-sqlite-driver.js";

export type { DriverDatabase };

/** The subset of the better-sqlite3 handle that `connection.ts` consumes. */
type BetterSqlite3Handle = new (
  filepath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => BetterSqlite3.Database;

export interface SqliteDriver {
  /** Which engine this driver wraps; surfaced in logs and diagnostics. */
  readonly engine: "better-sqlite3" | "node:sqlite";
  create(filepath: string, options: { readonly: boolean }): BetterSqlite3.Database;
}

let cached: SqliteDriver | undefined;

/**
 * Load `better-sqlite3` or, when its native module cannot be loaded, the
 * built-in `node:sqlite` fallback.
 *
 * @param env process environment, injectable for tests
 * @returns the engine to open the database with
 */
export function loadSqliteDriver(
  env: NodeJS.ProcessEnv = process.env,
): SqliteDriver {
  if (cached) return cached;
  cached = resolveDriver(env);
  return cached;
}

/** Drop the cached engine. Tests only. */
export function resetSqliteDriverCache(): void {
  cached = undefined;
}

function resolveDriver(env: NodeJS.ProcessEnv): SqliteDriver {
  const forced = env["MEMOS_SQLITE_DRIVER"]?.trim().toLowerCase();
  if (forced === "node:sqlite") return nodeSqliteDriver();
  if (forced === "better-sqlite3") return betterSqlite3Driver();
  try {
    return betterSqlite3Driver();
  } catch (error) {
    // A prebuild that cannot be dlopen'd (ABI mismatch, missing binary) is a
    // property of the runtime, not of the database. Falling back keeps MemOS
    // usable on a DSH whose Electron ABI npm cannot build for.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[memos] better-sqlite3 unavailable (${message}); ` +
        "falling back to node:sqlite.\n",
    );
    return nodeSqliteDriver();
  }
}

function betterSqlite3Driver(): SqliteDriver {
  // Required lazily so a module-load failure is catchable here rather than
  // crashing the whole plugin at import time.
  const mod = require("better-sqlite3") as
    | BetterSqlite3Handle
    | { default: BetterSqlite3Handle };
  const Ctor = typeof mod === "function" ? mod : mod.default;
  // The JS wrapper loads even when the native binding is missing or built
  // for the wrong ABI — `require()` succeeds and only `new Database()`
  // throws. Probe with an in-memory handle so an unusable prebuild is
  // detected here, where the fallback is still reachable.
  const probe = new Ctor(":memory:", {});
  probe.close();
  return {
    engine: "better-sqlite3",
    create: (filepath, options) =>
      new Ctor(filepath, {
        readonly: options.readonly,
        fileMustExist: options.readonly ? true : false,
      }) as unknown as BetterSqlite3.Database,
  };
}

function nodeSqliteDriver(): SqliteDriver {
  return {
    engine: "node:sqlite",
    create: (filepath, options) =>
      new DriverDatabase(filepath, {
        readonly: options.readonly,
      }) as unknown as BetterSqlite3.Database,
  };
}

// `createRequire` keeps this file loadable as ESM while still using CJS
// resolution for the native binding, which is how the rest of the plugin
// reaches `better-sqlite3`.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
