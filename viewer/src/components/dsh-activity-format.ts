import type { DshActivitySnapshot } from "./dsh-activity-types";

export function formatActivityTime(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function formatActivityDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** Defensive projection for a bounded, read-only activity response. */
export function safeActivitySnapshot(value: unknown): DshActivitySnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const totals = safeActivityTotals(value.totals);
  const session = safeActivityTotals(value.session);
  const definition = isRecord(value.definition) ? value.definition : {};
  const persistence = isRecord(value.persistence) ? value.persistence : {};
  if (!totals || !session) return null;
  const recentSync = Array.isArray(value.recentSync)
    ? value.recentSync.slice(0, 64).flatMap(row => {
        if (!isRecord(row) || !safeId(row.id) || !safeTime(row.at)) return [];
        const operation = safeSyncOperation(row.operation);
        const direction: DshActivitySnapshot["recentSync"][number]["direction"] | undefined =
          row.direction === "send" || row.direction === "receive"
          ? row.direction
          : undefined;
        const outcome: DshActivitySnapshot["recentSync"][number]["outcome"] | undefined =
          row.outcome === "success" || row.outcome === "failure"
          ? row.outcome
          : undefined;
        const route = safeRoute(row.route);
        if (!operation || !direction || !outcome || !route) return [];
        return [{
          id: safeId(row.id)!,
          at: safeTime(row.at)!,
          operation,
          direction,
          outcome,
          route,
          ...(safeText(row.peer) ? { peer: safeText(row.peer) } : {}),
          sentItems: safeCount(row.sentItems),
          receivedItems: safeCount(row.receivedItems),
          inserted: safeCount(row.inserted),
          updated: safeCount(row.updated),
          skipped: safeCount(row.skipped),
          ...(outcome === "failure" && safeCode(row.errorCode)
            ? { errorCode: safeCode(row.errorCode) }
            : {}),
        }];
      })
    : [];
  const recentModels = Array.isArray(value.recentModels)
    ? value.recentModels.slice(0, 64).flatMap(row => {
        if (!isRecord(row) || !safeId(row.id) || !safeTime(row.at)) return [];
        const outcome: DshActivitySnapshot["recentModels"][number]["outcome"] | undefined =
          row.outcome === "success" || row.outcome === "failure"
          || row.outcome === "pending" || row.outcome === "interrupted"
          ? row.outcome
          : undefined;
        const operation = safeId(row.operation);
        const provider = safeId(row.provider);
        const model = safeId(row.model);
        if (!outcome || !operation || !provider || !model) return [];
        return [{
          id: safeId(row.id)!,
          at: safeTime(row.at)!,
          ...(safeTime(row.completedAt) ? { completedAt: safeTime(row.completedAt) } : {}),
          durationMs: safeCount(row.durationMs),
          operation,
          provider,
          model,
          outcome,
          ...((outcome === "failure" || outcome === "interrupted") && safeCode(row.errorCode)
            ? { errorCode: safeCode(row.errorCode) }
            : {}),
        }];
      })
    : [];
  const recentSummaries = Array.isArray(value.recentSummaries)
    ? value.recentSummaries.slice(0, 32).flatMap(row => {
        if (!isRecord(row) || !safeId(row.id) || !safeTime(row.at)) return [];
        const source: DshActivitySnapshot["recentSummaries"][number]["source"] | undefined =
          row.source === "codex" || row.source === "dsh"
          ? row.source
          : undefined;
        const provider = safeId(row.provider);
        const model = safeId(row.model);
        const summary = safeText(row.summary);
        if (!source || !provider || !model || !summary) return [];
        return [{
          id: safeId(row.id)!,
          at: safeTime(row.at)!,
          source,
          provider,
          model,
          summary: summary.slice(0, 280),
        }];
      })
    : [];
  return {
    version: 1,
    trackingSince: safeTime(value.trackingSince) ?? 0,
    totals,
    session,
    recentSync,
    recentModels,
    recentSummaries,
    persistence: {
      status: persistence.status === "ready" ? "ready" : "degraded",
      ...(safeCode(persistence.warning) ? { warning: safeCode(persistence.warning) } : {}),
    },
    definition: {
      modelRequest: safeText(definition.modelRequest),
      syncCounts: safeText(definition.syncCounts),
      providerRetries: safeText(definition.providerRetries),
    },
  };
}

function safeActivityTotals(value: unknown): DshActivitySnapshot["totals"] | null {
  if (!isRecord(value) || !isRecord(value.sync) || !isRecord(value.model)) return null;
  return {
    sync: {
      attempts: safeCount(value.sync.attempts),
      successes: safeCount(value.sync.successes),
      failures: safeCount(value.sync.failures),
      sentItems: safeCount(value.sync.sentItems),
      receivedItems: safeCount(value.sync.receivedItems),
      inserted: safeCount(value.sync.inserted),
      updated: safeCount(value.sync.updated),
      skipped: safeCount(value.sync.skipped),
      ...(safeTime(value.sync.lastAttemptAt)
        ? { lastAttemptAt: safeTime(value.sync.lastAttemptAt) }
        : {}),
    },
    model: {
      requests: safeCount(value.model.requests),
      successes: safeCount(value.model.successes),
      failures: safeCount(value.model.failures),
      pending: safeCount(value.model.pending),
      totalDurationMs: safeCount(value.model.totalDurationMs),
      ...(safeTime(value.model.lastRequestAt)
        ? { lastRequestAt: safeTime(value.model.lastRequestAt) }
        : {}),
    },
    summaries: safeCount(value.summaries),
  };
}

function safeSyncOperation(value: unknown): DshActivitySnapshot["recentSync"][number]["operation"] | undefined {
  return value === "pull" || value === "push" || value === "serve_pull" || value === "receive_push"
    ? value
    : undefined;
}

function safeRoute(value: unknown): DshActivitySnapshot["recentSync"][number]["route"] | undefined {
  return value === "lan" || value === "wan" || value === "relay" || value === "gateway"
    ? value
    : undefined;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function safeTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[^\w.:/@+-]+/g, " ").trim().slice(0, 160);
  return text || undefined;
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(text) ? text : undefined;
}

function safeText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 500)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
