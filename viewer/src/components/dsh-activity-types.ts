export interface DshActivityTotals {
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
}

export interface DshActivitySnapshot {
  version: 1;
  trackingSince: number;
  totals: DshActivityTotals;
  session: DshActivityTotals;
  recentSync: Array<{
    id: string;
    at: number;
    operation: "pull" | "push" | "serve_pull" | "receive_push";
    direction: "send" | "receive";
    outcome: "success" | "failure";
    route: "lan" | "wan" | "relay" | "gateway";
    peer?: string;
    sentItems: number;
    receivedItems: number;
    inserted: number;
    updated: number;
    skipped: number;
    errorCode?: string;
  }>;
  recentModels: Array<{
    id: string;
    at: number;
    completedAt?: number;
    durationMs?: number;
    operation: string;
    provider: string;
    model: string;
    outcome: "success" | "failure" | "pending" | "interrupted";
    errorCode?: string;
  }>;
  recentSummaries: Array<{
    id: string;
    at: number;
    source: "codex" | "dsh";
    provider: string;
    model: string;
    summary: string;
  }>;
  persistence: {
    status: "ready" | "degraded";
    warning?: string;
  };
  definition: {
    modelRequest: string;
    syncCounts: string;
    providerRetries: string;
  };
}
