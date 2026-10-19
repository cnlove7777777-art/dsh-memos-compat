import type { RetrievalResultDTO, TraceDTO } from "../../agent-contract/dto.js";
const MAX_SEARCH_TIMEOUT_MS = 2800;
class RemoteError extends Error { constructor(_code: string, message: string) { super(message); } }
type JsonObject = Record<string, unknown>;
export function normalizeHit(raw: unknown, index: number): RetrievalResultDTO["hits"][number] {
  if (!isJsonObject(raw)) {
    throw new RemoteError("remote_response", `Peer hit ${index + 1} is invalid.`);
  }
  const refId = raw["refId"];
  const refKind = raw["refKind"];
  const tier = raw["tier"];
  const score = raw["score"];
  const snippet = raw["snippet"];
  if (
    typeof refId !== "string" ||
    !refId ||
    !isRefKind(refKind) ||
    (tier !== 1 && tier !== 2 && tier !== 3) ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    typeof snippet !== "string"
  ) {
    throw new RemoteError("remote_response", `Peer hit ${index + 1} is invalid.`);
  }
  return {
    tier,
    refKind,
    refId: `remote~${refId}`,
    score,
    snippet: `[Remote peer] ${snippet}`,
    ...(typeof raw["ownerAgentKind"] === "string"
      ? { ownerAgentKind: raw["ownerAgentKind"] }
      : {}),
    ...(typeof raw["ownerProfileId"] === "string"
      ? { ownerProfileId: raw["ownerProfileId"] }
      : {}),
    ...(typeof raw["ownerWorkspaceId"] === "string" || raw["ownerWorkspaceId"] === null
      ? { ownerWorkspaceId: raw["ownerWorkspaceId"] }
      : {}),
    ...(isShareScope(raw["shareScope"]) ? { shareScope: raw["shareScope"] } : {}),
    ...(typeof raw["sourceTraceId"] === "string"
      ? { sourceTraceId: raw["sourceTraceId"] }
      : {}),
  };
}

export function normalizeLatency(value: unknown): RetrievalResultDTO["tierLatencyMs"] {
  if (!isJsonObject(value)) return { tier1: 0, tier2: 0, tier3: 0 };
  return {
    tier1: finiteNonNegative(value["tier1"]),
    tier2: finiteNonNegative(value["tier2"]),
    tier3: finiteNonNegative(value["tier3"]),
  };
}

export function normalizeTrace(value: unknown): TraceDTO | null {
  if (value === null || value === undefined) return null;
  if (!isJsonObject(value)) {
    throw new RemoteError("remote_response", "Peer trace detail is invalid.");
  }

  const requiredStrings = [
    "id",
    "episodeId",
    "sessionId",
    "userText",
    "agentText",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string") {
      throw new RemoteError("remote_response", "Peer trace detail is invalid.");
    }
  }
  const numericFields = ["ts", "value", "alpha", "priority", "turnId"] as const;
  for (const key of numericFields) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new RemoteError("remote_response", "Peer trace detail is invalid.");
    }
  }
  if (!Array.isArray(value["toolCalls"])) {
    throw new RemoteError("remote_response", "Peer trace detail is invalid.");
  }

  return value as unknown as TraceDTO;
}

export function deadlineFor(deadlineAt: number | undefined): number {
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    return MAX_SEARCH_TIMEOUT_MS;
  }
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) {
    throw new RemoteError("remote_timeout", "Remote memory deadline expired.");
  }
  return Math.max(1, Math.min(MAX_SEARCH_TIMEOUT_MS, remaining));
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRefKind(value: unknown): value is RetrievalResultDTO["hits"][number]["refKind"] {
  return value === "skill" ||
    value === "trace" ||
    value === "episode" ||
    value === "experience" ||
    value === "world-model";
}

function isShareScope(value: unknown): value is "private" | "public" | "hub" {
  return value === "private" || value === "public" || value === "hub";
}

export function isJsonObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
