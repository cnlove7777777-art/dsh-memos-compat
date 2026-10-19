/** Bounded, credential-free activity receipts for MemOS sync and text-model work. */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { MemosError } from "../../agent-contract/errors.js";

export const ACTIVITY_FILE_NAME = "dsh-activity.json";
export const ACTIVITY_MAX_SYNC_RECORDS = 64;
export const ACTIVITY_MAX_MODEL_RECORDS = 64;
export const ACTIVITY_MAX_SUMMARIES = 32;
export const ACTIVITY_MAX_SUMMARY_CHARS = 280;
export const ACTIVITY_MAX_FILE_BYTES = 256 * 1024;

export type ActivitySyncOperation =
  | "pull"
  | "push"
  | "serve_pull"
  | "receive_push";
export type ActivitySyncDirection = "send" | "receive";
export type ActivityRoute = "lan" | "wan" | "relay" | "gateway";
export type ActivityOutcome = "success" | "failure" | "pending" | "interrupted";

export interface SyncActivityInput {
  operation: ActivitySyncOperation;
  direction: ActivitySyncDirection;
  outcome: "success" | "failure";
  route: ActivityRoute;
  peer?: string;
  sentItems?: number;
  receivedItems?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  errorCode?: string;
  at?: number;
}
export interface ModelActivityInput {
  operation: string;
  provider: string;
  model: string;
  at?: number;
}

export interface ModelActivityResult {
  outcome: "success" | "failure";
  errorCode?: string;
}

export interface SummaryActivityInput {
  source: "codex" | "dsh";
  provider: string;
  model: string;
  summary: string;
  at?: number;
}

export interface SyncActivityRecord {
  id: string;
  at: number;
  operation: ActivitySyncOperation;
  direction: ActivitySyncDirection;
  outcome: "success" | "failure";
  route: ActivityRoute;
  peer?: string;
  sentItems: number;
  receivedItems: number;
  inserted: number;
  updated: number;
  skipped: number;
  errorCode?: string;
}

export interface ModelActivityRecord {
  id: string;
  at: number;
  completedAt?: number;
  durationMs?: number;
  operation: string;
  provider: string;
  model: string;
  outcome: ActivityOutcome;
  errorCode?: string;
}

export interface SummaryActivityRecord {
  id: string;
  at: number;
  source: "codex" | "dsh";
  provider: string;
  model: string;
  summary: string;
}

export interface DshActivitySnapshot {
  version: 1;
  trackingSince: number;
  limits: {
    syncRecords: number;
    modelRecords: number;
    summaries: number;
    summaryChars: number;
    fileBytes: number;
  };
  definition: {
    modelRequest: string;
    syncCounts: string;
    providerRetries: string;
  };
  totals: {
    sync: {
      attempts: number;
      successes: number;
      failures: number;
      sentItems: number;
      receivedItems: number;
      inserted: number;
      updated: number;
      skipped: number;
      lastAttemptAt?: number;
    };
    model: {
      requests: number;
      successes: number;
      failures: number;
      pending: number;
      totalDurationMs: number;
      lastRequestAt?: number;
    };
    summaries: number;
  };
  session: {
    sync: DshActivitySnapshot["totals"]["sync"];
    model: DshActivitySnapshot["totals"]["model"];
    summaries: number;
  };
  recentSync: SyncActivityRecord[];
  recentModels: ModelActivityRecord[];
  recentSummaries: SummaryActivityRecord[];
  persistence: {
    status: "ready" | "degraded";
    warning?: string;
  };
}

interface PersistedActivity {
  version: 1;
  trackingSince: number;
  totals: DshActivitySnapshot["totals"];
  recentSync: SyncActivityRecord[];
  recentModels: ModelActivityRecord[];
  recentSummaries: SummaryActivityRecord[];
}

function freshTotals(): DshActivitySnapshot["totals"] {
  return {
    sync: {
      attempts: 0,
      successes: 0,
      failures: 0,
      sentItems: 0,
      receivedItems: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
    },
    model: {
      requests: 0,
      successes: 0,
      failures: 0,
      pending: 0,
      totalDurationMs: 0,
    },
    summaries: 0,
  };
}

function boundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function safeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function safeIdentifier(value: unknown, maximum = 128): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\w.:/@+-]+/g, " ")
    .trim()
    .slice(0, maximum);
}

/** Keep user-visible summary excerpts free of common credentials and local paths. */
export function sanitizeActivityText(value: unknown, maximum = ACTIVITY_MAX_SUMMARY_CHARS): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      "[private key redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[API key redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|bindkey|pairing[_-]?key|session)\s*[=:]\s*["']?)[^\s"',;]{4,}/gi,
      "$1[redacted]")
    .replace(/\b(?:token|cookie|authorization)\s*[=:]\s*["']?[^\s"',;]{4,}/gi,
      (match) => `${match.split(/[=:]/, 1)[0]}=[redacted]`)
    .replace(/\bhttps?:\/\/[^\s"'<>]*/gi, (value) => {
      try {
        const trailingPunctuation = value.match(/[.,;:!?]+$/)?.[0] ?? "";
        const URLText = trailingPunctuation ? value.slice(0, -trailingPunctuation.length) : value;
        const url = new URL(URLText);
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
          if (/(?:token|key|secret|password|session|auth|signature|credential)/i.test(key)) {
            url.searchParams.set(key, "[redacted]");
          }
        }
        return preserveUsefulQuery(url) + trailingPunctuation;
      } catch {
        return "[url redacted]";
      }
    })
    .replace(/\b[A-Za-z]:[\\/][^\s<>"|?*\r\n]+/g, "[local path]")
    .replace(/\b\\\\[^\\\s]+\\[^\s<>"|?*\r\n]+/g, "[local path]")
    .replace(/(?<!:)\/(?:Users|home|root|srv|tmp|opt|var\/tmp)(?:\/[^\s"'`]*)?|\/(?:usr|etc|private|data|mnt)\/[^\s"'`]*/g,
      "[local path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maximum));
}

function preserveUsefulQuery(url: URL): string {
  const rendered = url.toString();
  return rendered.replace(/%5Bredacted%5D/gi, "[redacted]");
}

/** Stable error labels only; exception messages never enter the activity ledger. */
export function activityErrorCode(error: unknown, fallback: string): string {
  if (MemosError.is(error) && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) return error.code;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code.toLowerCase();
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return fallback;
}

function safeSyncOperation(value: unknown): ActivitySyncOperation | undefined {
  return value === "pull" || value === "push" || value === "serve_pull" || value === "receive_push"
    ? value
    : undefined;
}

function safeDirection(value: unknown): ActivitySyncDirection | undefined {
  return value === "send" || value === "receive" ? value : undefined;
}

function safeRoute(value: unknown): ActivityRoute | undefined {
  return value === "lan" || value === "wan" || value === "relay" || value === "gateway"
    ? value
    : undefined;
}

function safeSyncOutcome(value: unknown): "success" | "failure" | undefined {
  return value === "success" || value === "failure" ? value : undefined;
}

function safeModelOutcome(value: unknown): ActivityOutcome | undefined {
  return value === "success" || value === "failure" || value === "pending" || value === "interrupted"
    ? value
    : undefined;
}

function safeSummarySource(value: unknown): "codex" | "dsh" | undefined {
  return value === "codex" || value === "dsh" ? value : undefined;
}

function normalizeSyncRecord(value: unknown): SyncActivityRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const operation = safeSyncOperation(raw.operation);
  const direction = safeDirection(raw.direction);
  const outcome = safeSyncOutcome(raw.outcome);
  const route = safeRoute(raw.route);
  const at = safeTime(raw.at);
  if (!operation || !direction || !outcome || !route || at === undefined) return undefined;
  const peer = safeIdentifier(raw.peer);
  const errorCode = outcome === "failure" ? safeIdentifier(raw.errorCode, 64) : undefined;
  return {
    id: safeIdentifier(raw.id, 64) || `sync-${at}-${operation}`,
    at,
    operation,
    direction,
    outcome,
    route,
    ...(peer ? { peer } : {}),
    sentItems: boundedInteger(raw.sentItems),
    receivedItems: boundedInteger(raw.receivedItems),
    inserted: boundedInteger(raw.inserted),
    updated: boundedInteger(raw.updated),
    skipped: boundedInteger(raw.skipped),
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeModelRecord(value: unknown): ModelActivityRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const outcome = safeModelOutcome(raw.outcome);
  const at = safeTime(raw.at);
  const operation = safeIdentifier(raw.operation);
  const provider = safeIdentifier(raw.provider);
  const model = safeIdentifier(raw.model);
  if (!outcome || at === undefined || !operation || !provider || !model) return undefined;
  const completedAt = safeTime(raw.completedAt);
  const durationMs = boundedInteger(raw.durationMs, 24 * 60 * 60 * 1000);
  const errorCode = outcome === "failure" || outcome === "interrupted"
    ? safeIdentifier(raw.errorCode, 64)
    : undefined;
  return {
    id: safeIdentifier(raw.id, 64) || `model-${at}-${operation}`,
    at,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(durationMs === 0 && completedAt === undefined ? {} : { durationMs }),
    operation,
    provider,
    model,
    outcome,
    ...(errorCode ? { errorCode } : {}),
  };
}

function normalizeSummaryRecord(value: unknown): SummaryActivityRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const source = safeSummarySource(raw.source);
  const at = safeTime(raw.at);
  const provider = safeIdentifier(raw.provider);
  const model = safeIdentifier(raw.model);
  const summary = sanitizeActivityText(raw.summary);
  if (!source || at === undefined || !provider || !model || !summary) return undefined;
  return {
    id: safeIdentifier(raw.id, 64) || `summary-${at}`,
    at,
    source,
    provider,
    model,
    summary,
  };
}

function normalizeTotals(value: unknown): DshActivitySnapshot["totals"] {
  const raw = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const sync = raw.sync && typeof raw.sync === "object"
    ? raw.sync as Record<string, unknown>
    : {};
  const model = raw.model && typeof raw.model === "object"
    ? raw.model as Record<string, unknown>
    : {};
  const totals = freshTotals();
  totals.sync.attempts = boundedInteger(sync.attempts);
  totals.sync.successes = boundedInteger(sync.successes);
  totals.sync.failures = boundedInteger(sync.failures);
  totals.sync.sentItems = boundedInteger(sync.sentItems);
  totals.sync.receivedItems = boundedInteger(sync.receivedItems);
  totals.sync.inserted = boundedInteger(sync.inserted);
  totals.sync.updated = boundedInteger(sync.updated);
  totals.sync.skipped = boundedInteger(sync.skipped);
  totals.sync.lastAttemptAt = safeTime(sync.lastAttemptAt);
  totals.model.requests = boundedInteger(model.requests);
  totals.model.successes = boundedInteger(model.successes);
  totals.model.failures = boundedInteger(model.failures);
  totals.model.pending = boundedInteger(model.pending);
  totals.model.totalDurationMs = boundedInteger(model.totalDurationMs);
  totals.model.lastRequestAt = safeTime(model.lastRequestAt);
  totals.summaries = boundedInteger(raw.summaries);
  return totals;
}

export class DshActivityLedger {
  private readonly path: string;
  private persisted: PersistedActivity;
  private writes: Promise<void> = Promise.resolve();
  private persistenceWarning?: string;
  private sessionTotals = freshTotals();

  constructor(private readonly home: string) {
    this.path = join(home, ACTIVITY_FILE_NAME);
    this.persisted = {
      version: 1,
      trackingSince: Date.now(),
      totals: freshTotals(),
      recentSync: [],
      recentModels: [],
      recentSummaries: [],
    };
  }

  async load(): Promise<void> {
    await fs.mkdir(this.home, { recursive: true });
    try {
      const handle = await fs.open(this.path, "r");
      let body: string;
      try {
        const buffer = Buffer.alloc(ACTIVITY_MAX_FILE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > ACTIVITY_MAX_FILE_BYTES) throw new Error("Activity file limit exceeded");
        body = buffer.subarray(0, length).toString("utf8");
      } finally { await handle.close(); }
      const raw = JSON.parse(body) as Record<string, unknown>;
      if (raw.version !== 1) throw new Error("Unsupported activity version");
      const trackingSince = safeTime(raw.trackingSince);
      if (trackingSince === undefined) throw new Error("Invalid activity start time");
      const recentSync = Array.isArray(raw.recentSync)
        ? raw.recentSync.slice(-ACTIVITY_MAX_SYNC_RECORDS)
          .map(normalizeSyncRecord)
          .filter((row): row is SyncActivityRecord => row !== undefined)
        : [];
      const recentModels = Array.isArray(raw.recentModels)
        ? raw.recentModels.slice(-ACTIVITY_MAX_MODEL_RECORDS)
          .map(normalizeModelRecord)
          .filter((row): row is ModelActivityRecord => row !== undefined)
          .map(row => row.outcome === "pending"
            ? { ...row, outcome: "interrupted" as const, completedAt: row.at, durationMs: 0,
                errorCode: "activity_interrupted" }
            : row)
        : [];
      const recentSummaries = Array.isArray(raw.recentSummaries)
        ? raw.recentSummaries.slice(-ACTIVITY_MAX_SUMMARIES)
          .map(normalizeSummaryRecord)
          .filter((row): row is SummaryActivityRecord => row !== undefined)
        : [];
      const totals = normalizeTotals(raw.totals);
      const pending = totals.model.pending;
      if (pending > 0) totals.model.pending = 0;
      if (pending > 0) totals.model.failures += pending;
      this.persisted = {
        version: 1,
        trackingSince,
        totals,
        recentSync,
        recentModels,
        recentSummaries,
      };
      this.persistenceWarning = undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") this.persistenceWarning = "activity_file_invalid";
    }
  }

  recordSync(input: SyncActivityInput): void {
    const record = normalizeSyncRecord({
      id: randomUUID(),
      at: input.at ?? Date.now(),
      operation: input.operation,
      direction: input.direction,
      outcome: input.outcome,
      route: input.route,
      peer: input.peer,
      sentItems: input.sentItems,
      receivedItems: input.receivedItems,
      inserted: input.inserted,
      updated: input.updated,
      skipped: input.skipped,
      errorCode: input.errorCode,
    });
    if (!record) return;
    const totals = this.persisted.totals.sync;
    totals.attempts++;
    totals.lastAttemptAt = record.at;
    const session = this.sessionTotals.sync;
    session.attempts++;
    session.lastAttemptAt = record.at;
    if (record.outcome === "success") {
      totals.successes++;
      session.successes++;
    } else {
      totals.failures++;
      session.failures++;
    }
    if (record.outcome === "success") {
      totals.sentItems += record.sentItems;
      totals.receivedItems += record.receivedItems;
      totals.inserted += record.inserted;
      totals.updated += record.updated;
      totals.skipped += record.skipped;
      session.sentItems += record.sentItems;
      session.receivedItems += record.receivedItems;
      session.inserted += record.inserted;
      session.updated += record.updated;
      session.skipped += record.skipped;
    }
    this.persisted.recentSync = trimRecords(
      [...this.persisted.recentSync, record],
      ACTIVITY_MAX_SYNC_RECORDS,
    );
    this.queuePersist();
  }

  beginModel(input: ModelActivityInput): { finish(result: ModelActivityResult): void } {
    const at = input.at ?? Date.now();
    const record = normalizeModelRecord({
      id: randomUUID(),
      at,
      operation: input.operation || "memory.text",
      provider: input.provider,
      model: input.model,
      outcome: "pending",
    });
    let settled = false;
    if (record) {
      this.persisted.totals.model.requests++;
      this.persisted.totals.model.pending++;
      this.persisted.totals.model.lastRequestAt = at;
      this.sessionTotals.model.requests++;
      this.sessionTotals.model.pending++;
      this.sessionTotals.model.lastRequestAt = at;
      this.persisted.recentModels = trimRecords(
        [...this.persisted.recentModels, record],
        ACTIVITY_MAX_MODEL_RECORDS,
        row => row.outcome === "pending",
      );
      this.queuePersist();
    }
    return {
      finish: (result): void => {
        if (settled) return;
        settled = true;
        if (!record) return;
        const completedAt = Date.now();
        record.outcome = result.outcome;
        record.completedAt = completedAt;
        record.durationMs = Math.max(0, completedAt - record.at);
        if (result.outcome === "failure") {
          record.errorCode = safeIdentifier(result.errorCode, 64) || "model_request_failed";
        } else {
          delete record.errorCode;
        }
        this.persisted.totals.model.pending = Math.max(
          0,
          this.persisted.totals.model.pending - 1,
        );
        this.sessionTotals.model.pending = Math.max(
          0,
          this.sessionTotals.model.pending - 1,
        );
        if (result.outcome === "success") {
          this.persisted.totals.model.successes++;
          this.persisted.totals.model.totalDurationMs += record.durationMs;
          this.sessionTotals.model.successes++;
          this.sessionTotals.model.totalDurationMs += record.durationMs;
        } else {
          this.persisted.totals.model.failures++;
          this.sessionTotals.model.failures++;
        }
        this.queuePersist();
      },
    };
  }

  recordSummary(input: SummaryActivityInput): void {
    const record = normalizeSummaryRecord({
      id: randomUUID(),
      at: input.at ?? Date.now(),
      source: input.source,
      provider: input.provider,
      model: input.model,
      summary: input.summary,
    });
    if (!record) return;
    this.persisted.totals.summaries++;
    this.sessionTotals.summaries++;
    this.persisted.recentSummaries = trimRecords(
      [...this.persisted.recentSummaries, record],
      ACTIVITY_MAX_SUMMARIES,
    );
    this.queuePersist();
  }

  async snapshot(): Promise<DshActivitySnapshot> {
    await this.flush();
    return structuredClone({
      version: 1 as const,
      trackingSince: this.persisted.trackingSince,
      limits: {
        syncRecords: ACTIVITY_MAX_SYNC_RECORDS,
        modelRecords: ACTIVITY_MAX_MODEL_RECORDS,
        summaries: ACTIVITY_MAX_SUMMARIES,
        summaryChars: ACTIVITY_MAX_SUMMARY_CHARS,
        fileBytes: ACTIVITY_MAX_FILE_BYTES,
      },
      definition: {
        modelRequest: "插件实际发起的一次 DSH 文字模型流请求",
        syncCounts: "发送/接收为本机成功发送或处理同步页的逻辑条目；服务端处理不代表客户端已确认收到；新增、更新、未变分别计数",
        providerRetries: "provider 内部重试不可由插件观测，不计入请求次数",
      },
      totals: this.persisted.totals,
      session: this.sessionTotals,
      recentSync: this.persisted.recentSync,
      recentModels: this.persisted.recentModels,
      recentSummaries: this.persisted.recentSummaries,
      persistence: {
        status: this.persistenceWarning ? "degraded" as const : "ready" as const,
        ...(this.persistenceWarning ? { warning: this.persistenceWarning } : {}),
      },
    });
  }

  async flush(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private queuePersist(): void {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      const body = JSON.stringify(this.persisted) + "\n";
      if (Buffer.byteLength(body, "utf8") > ACTIVITY_MAX_FILE_BYTES) {
        this.persistenceWarning = "activity_file_limit_exceeded";
        throw new Error("Activity file limit exceeded");
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        this.persistenceWarning = undefined;
        await fs.writeFile(temporary, body, { mode: 0o600 });
        await fs.rename(temporary, this.path);
        this.persistenceWarning = undefined;
      } catch {
        this.persistenceWarning = "activity_write_failed";
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    }).catch(() => {
      this.persistenceWarning = "activity_write_failed";
    });
  }
}

function trimRecords<T>(rows: T[], maximum: number, keep?: (row: T) => boolean): T[] {
  if (rows.length <= maximum) return rows;
  const result = [...rows];
  while (result.length > maximum) {
    const index = keep ? result.findIndex(row => !keep(row)) : 0;
    const removeAt = index >= 0 ? index : 0;
    result.splice(removeAt, 1);
  }
  return result;
}
