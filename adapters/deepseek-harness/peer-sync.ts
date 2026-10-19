/**
 * Non-destructive MemOS peer mirror.
 *
 * The local `memos.db` remains the source of truth. Peer pages are imported
 * into a separate `peer-replicas.db` under the same home, and imported rows
 * are never re-exported. The wire format intentionally carries bounded memory
 * summaries, structure, provenance ids and vectors only; raw transcripts,
 * tool payloads, logs, configuration, credentials and absolute paths stay
 * local.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RetrievalHitDTO, TraceDTO } from "../../agent-contract/dto.js";
import { parseYaml } from "../../core/config/yaml.js";
import { normalizeNamespace } from "../../core/runtime/namespace.js";
import { openDb, type StorageDb } from "../../core/storage/index.js";

export const PEER_SYNC_PROTOCOL = "saya-memory-sync/1" as const;
export const PEER_SYNC_MAX_PAGE_ITEMS = 50;
export const PEER_SYNC_MAX_PAGE_BYTES = 1024 * 1024;
export const PEER_SYNC_MAX_VECTOR_VALUES = 16_384;

export type PeerSyncKind = "trace" | "policy" | "world_model" | "skill";

export interface PeerSyncVector {
  slot: string;
  model: string;
  dimension: number;
  values: number[];
}

export interface PeerSyncItem {
  kind: PeerSyncKind;
  id: string;
  /** Opaque remote trace id. Never a native session/episode id. */
  traceRef?: string;
  revision: string;
  payload: Record<string, unknown>;
  vectors: PeerSyncVector[];
}

export interface PeerSyncPage {
  protocol: typeof PEER_SYNC_PROTOCOL;
  nodeId: string;
  /** Source profile that owns every payload in this page. */
  profileId: string;
  items: PeerSyncItem[];
  nextCursor?: string;
  done: boolean;
}

export interface PeerSyncExportOptions {
  cursor?: string;
  limit?: number;
}

export interface PeerSyncStoreOptions {
  home: string;
  dbPath: string;
  nodeId: string;
  /** Receiving/runtime namespace. Source peers may use a different name. */
  profileId?: string;
  /**
   * Full embedding identity as `<provider>/<model>`. Pass the live
   * `core.health().embedder` value when available. When omitted, the
   * profile's own `config.yaml` is read. Unknown identities disable vectors.
   */
  embeddingModel?: string;
}

export interface PeerSearchVector {
  model: string;
  values: number[];
}

export interface PeerRetrievalHit extends RetrievalHitDTO {
  origin: "local" | "replica";
  originNode: string;
  sourceProfileId?: string;
  remoteId: string;
  replica?: boolean;
  vectorScore?: number;
}

export interface PeerTraceDetail extends TraceDTO {
  originNode: string;
  sourceProfileId?: string;
  remoteId: string;
  /** Client-visible opaque id; remoteId remains the native replica row id. */
  refId?: string;
  revision: string;
}

export interface PeerSyncStats {
  nodeId: string;
  profileId: string;
  sourceProfiles: string[];
  embeddingModel?: string;
  sourceDb: string;
  replicaDb: string;
  source: Record<PeerSyncKind, number>;
  replicas: Record<PeerSyncKind, number>;
  vectors: number;
  origins: Array<{ nodeId: string; items: number }>;
}

interface CursorState {
  version: 2;
  kind?: PeerSyncKind;
  id?: string;
  /** Starts a fresh full-table sweep on positive integers. */
  rev?: number;
}

interface ReplicaRow {
  profile_id: string;
  origin_node: string;
  source_profile_id: string;
  kind: PeerSyncKind;
  id: string;
  revision: string;
  payload_json: string;
  vectors_json: string;
  updated_at: number;
}

interface TableSpec {
  kind: PeerSyncKind;
  table: string;
  idColumn: string;
  updatedColumn: string;
  columns: string[];
}

const TABLE_SPECS: readonly TableSpec[] = [
  {
    kind: "trace",
    table: "traces",
    idColumn: "id",
    updatedColumn: "ts",
    columns: [
      "id",
      "ts",
      "summary",
      "user_text",
      "agent_text",
      "tags_json",
      "value",
      "alpha",
      "priority",
      "owner_agent_kind",
      "owner_profile_id",
      "owner_workspace_id",
      "vec_summary",
      "vec_action",
    ],
  },
  {
    kind: "policy",
    table: "policies",
    idColumn: "id",
    updatedColumn: "updated_at",
    columns: [
      "id",
      "title",
      "trigger",
      "procedure",
      "verification",
      "boundary",
      "support",
      "gain",
      "status",
      "experience_type",
      "evidence_polarity",
      "salience",
      "confidence",
      "decision_guidance_json",
      "source_episodes_json",
      "source_trace_ids_json",
      "created_at",
      "updated_at",
      "edited_at",
      "owner_agent_kind",
      "owner_profile_id",
      "owner_workspace_id",
      "vec",
    ],
  },
  {
    kind: "world_model",
    table: "world_model",
    idColumn: "id",
    updatedColumn: "updated_at",
    columns: [
      "id",
      "title",
      "body",
      "structure_json",
      "domain_tags_json",
      "policy_ids_json",
      "source_episodes_json",
      "confidence",
      "version",
      "status",
      "created_at",
      "updated_at",
      "edited_at",
      "owner_agent_kind",
      "owner_profile_id",
      "owner_workspace_id",
      "vec",
    ],
  },
  {
    kind: "skill",
    table: "skills",
    idColumn: "id",
    updatedColumn: "updated_at",
    columns: [
      "id",
      "name",
      "status",
      "invocation_guide",
      "procedure_json",
      "eta",
      "support",
      "gain",
      "trials_attempted",
      "trials_passed",
      "source_policies_json",
      "source_world_json",
      "evidence_anchors_json",
      "created_at",
      "updated_at",
      "version",
      "edited_at",
      "owner_agent_kind",
      "owner_profile_id",
      "owner_workspace_id",
      "vec",
    ],
  },
];

const CREDENTIAL_KEY =
  /(?:^|_)(?:api_?key|access_?key|secret|password|passwd|token|authorization|cookie|private_?key|credential)(?:$|_)/i;
const CREDENTIAL_VALUE =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|((?:api[_-]?key|access[_-]?token|password|bindkey)\s*[=:]\s*["']?)[^\s"',;]{8,}/i;
const ABSOLUTE_PATH =
  /(?<![\w:/])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|root|srv|Users|tmp|var|etc|opt|mnt|Volumes|private)\/)[^\s"'`<>]*/g;
const SENSITIVE_KEY =
  /(?:^|_)(?:user_?text|agent_?text|session_?(?:id|key)|messages?|tool_?calls?|raw_?session|transcript)(?:$|_)/i;
const GLOBAL_ID = /^(?:session|episode):.+$/i;
const WINDOWS_ID_PATH = /^[A-Za-z]:[\\/]/;
const POSIX_HOME_PATH = /^(?:~[\\/]|\/(?:home|Users)\/)/;
const SEARCH_SCAN_LIMIT = 2_000;

export class PeerSyncStore {
  private source?: StorageDb;
  private replica?: StorageDb;
  private sourceTables = new Set<string>();
  private readonly replicaPath: string;
  private readonly profileId: string;
  private embeddingModel?: string;

  constructor(private readonly options: PeerSyncStoreOptions) {
    if (!options.home.trim()) throw new TypeError("PeerSyncStore home is required");
    if (!options.dbPath.trim()) throw new TypeError("PeerSyncStore dbPath is required");
    if (!validNodeId(options.nodeId)) throw new TypeError("PeerSyncStore nodeId is invalid");
    this.profileId = normalizeProfileId(normalizeNamespace({
      agentKind: "deepseek-harness",
      profileId: options.profileId,
    }).profileId);
    this.embeddingModel = normalizeEmbeddingModel(options.embeddingModel);
    if (options.embeddingModel !== undefined && !this.embeddingModel) {
      throw new TypeError("PeerSyncStore embeddingModel must be provider/model");
    }
    this.replicaPath = path.join(path.resolve(options.home), "peer-replicas.db");
  }

  open(): void {
    if (this.source) return;
    if (!fs.existsSync(this.options.dbPath)) {
      throw new Error("PeerSync source database does not exist");
    }
    if (!this.embeddingModel) {
      this.embeddingModel = readConfiguredEmbeddingModel(
        this.options.home,
        path.dirname(path.resolve(this.options.dbPath)),
      );
    }
    const source = openDb({ filepath: this.options.dbPath, agent: "deepseek-harness", readonly: true });
    let replica: StorageDb | undefined;
    try {
      fs.mkdirSync(path.dirname(this.replicaPath), { recursive: true });
      replica = openDb({ filepath: this.replicaPath, agent: "deepseek-harness", busyTimeoutMs: 5000 });
      this.installReplicaSchema(replica);
      this.source = source;
      this.replica = replica;
      this.sourceTables = new Set(
        source
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      );
    } catch (error) {
      replica?.close();
      source.close();
      throw error;
    }
  }

  close(): void {
    const replica = this.replica;
    const source = this.source;
    this.replica = undefined;
    this.source = undefined;
    this.sourceTables.clear();
    try {
      replica?.close();
    } finally {
      source?.close();
    }
  }

  exportPage(options: PeerSyncExportOptions = {}): PeerSyncPage {
    const source = this.requireSource();
    const requested = clampLimit(options.limit);
    const cursor = parseCursor(options.cursor);
    const pageLimit = PEER_SYNC_MAX_PAGE_BYTES - 512;
    const keys = this.sourceKeys(source, cursor, requested + 1);
    const more = keys.length > requested;
    const selectedKeys = keys.slice(0, requested);
    const items: PeerSyncItem[] = [];
    let bytes = 0;
    for (const key of selectedKeys) {
      const item = this.exportItem(source, key);
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
      if (bytes + itemBytes > pageLimit) {
        if (items.length === 0) throw new Error("PeerSync item exceeds the page byte limit");
        break;
      }
      bytes += itemBytes;
      items.push(item);
    }
    const last = items.length > 0
      ? selectedKeys[items.length - 1]
      : cursor?.kind && cursor.id
        ? { kind: cursor.kind, id: cursor.id }
        : undefined;
    const hasMore = items.length < selectedKeys.length || more;
    const page: PeerSyncPage = {
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: this.options.nodeId,
      profileId: this.profileId,
      items,
      done: !hasMore,
    };
    if (!hasMore && keys.length > 0) {
      const rev = (cursor?.rev ?? 0) + 1;
      page.nextCursor = encodeCursor({ version: 2, rev });
    } else if (last) {
      page.nextCursor = encodeCursor({ version: 2, kind: last.kind, id: last.id, rev: cursor?.rev });
    }
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > PEER_SYNC_MAX_PAGE_BYTES) {
      throw new Error("PeerSync page exceeds the response byte limit");
    }
    return page;
  }

  importPage(
    page: unknown,
    expectedNodeId: string,
    expectedSourceProfileId?: string,
  ): { inserted: number; updated: number; skipped: number } {
    const replica = this.requireReplica();
    const validated = validatePage(page, expectedNodeId, this.options.nodeId, expectedSourceProfileId);
    const upsert = replica.prepare(`
      INSERT INTO peer_items (
        profile_id, origin_node, source_profile_id, kind, id, revision, payload_json, vectors_json,
        source_updated_at, imported_at
      ) VALUES (
        @profile_id, @origin_node, @source_profile_id, @kind, @id, @revision, @payload_json, @vectors_json,
        @source_updated_at, @imported_at
      )
      ON CONFLICT(profile_id, origin_node, source_profile_id, kind, id) DO UPDATE SET
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        vectors_json = excluded.vectors_json,
        source_updated_at = excluded.source_updated_at,
        imported_at = excluded.imported_at
      WHERE excluded.revision <> peer_items.revision
         OR excluded.payload_json <> peer_items.payload_json
         OR excluded.vectors_json <> peer_items.vectors_json`);
    const exists = replica.prepare(
      "SELECT revision FROM peer_items WHERE profile_id = ? AND origin_node = ? AND source_profile_id = ? AND kind = ? AND id = ?",
    );
    const result = { inserted: 0, updated: 0, skipped: 0 };
    replica.tx(() => {
      for (const item of validated.items) {
        const previous = exists.get([
          this.profileId,
          validated.originNode,
          validated.sourceProfileId,
          item.kind,
          item.id,
        ]) as
          | { revision: string }
          | undefined;
        const payload = JSON.stringify(sanitizeForWire(item.payload));
        const vectors = JSON.stringify(sanitizeVectors(item.vectors));
        const run = upsert.run({
          profile_id: this.profileId,
          origin_node: validated.originNode,
          source_profile_id: validated.sourceProfileId,
          kind: item.kind,
          id: item.id,
          revision: item.revision,
          payload_json: payload,
          vectors_json: vectors,
          source_updated_at: item.sourceUpdatedAt,
          imported_at: Date.now(),
        });
        if (!previous) result.inserted++;
        else if (run.changes > 0) result.updated++;
        else result.skipped++;
      }
    });
    return result;
  }

  search(query: string, limit = 10, queryVector?: PeerSearchVector): PeerRetrievalHit[] {
    this.requireReplica();
    const text = query.trim().slice(0, 2_000);
    if (!text) return [];
    if (queryVector) {
      const queryModel = normalizeEmbeddingModel(queryVector.model);
      if (!this.embeddingModel || !queryModel || queryModel !== this.embeddingModel) {
        throw new TypeError(`Query vector model does not match ${this.embeddingModel ?? "a known embedding model"}`);
      }
    }
    const bounded = clampLimit(limit);
    const lexical = this.lexical(text, Math.max(20, bounded * 4));
    const vector = queryVector ? this.vectorSearch(queryVector, Math.max(20, bounded * 4)) : [];
    const merged = new Map<string, PeerRetrievalHit>();
    for (const hit of lexical) merged.set(hit.refId, hit);
    for (const hit of vector) {
      const current = merged.get(hit.refId);
      if (!current) merged.set(hit.refId, hit);
      else {
        current.score = Math.min(1, current.score + hit.score * 0.75);
        current.vectorScore = hit.vectorScore;
      }
    }
    return Array.from(merged.values())
      .sort((a, b) => b.score - a.score || a.refId.localeCompare(b.refId))
      .slice(0, bounded);
  }

  getTrace(id: string, nodeId?: string): PeerTraceDetail | null {
    const source = this.requireSource();
    const replica = this.requireReplica();
    if (id.startsWith("replica~")) {
      const rest = id.slice(8);
      const split = rest.indexOf("~");
      if (split <= 0) return null;
      return this.getReplicaTrace(rest.slice(split + 1), rest.slice(0, split));
    }
    if (nodeId && nodeId !== this.options.nodeId) {
      const replicaTrace = this.getReplicaTrace(id, nodeId);
      if (replicaTrace) return replicaTrace;
    }
    if (!this.sourceTables.has("traces")) return null;
    const profile = this.profilePredicate(source, "traces");
    const trace = source
      .prepare(`SELECT * FROM traces WHERE ${profile.sql} AND id = @id`)
      .get({ ...profile.params, id }) as Record<string, unknown> | undefined;
    if (!trace) return null;
    const vectors = buildVectors("trace", trace, this.embeddingModel);
    const payload = buildPayload("trace", trace);
    return this.traceDto(trace, payload, this.options.nodeId, id, revisionOf(
      safeInteger(trace["ts"]) ?? 0,
      payload,
      vectors,
    ));
  }

  stats(): PeerSyncStats {
    const source = this.requireSource();
    const replica = this.requireReplica();
    const emptyCounts = (): Record<PeerSyncKind, number> => ({
      trace: 0,
      policy: 0,
      world_model: 0,
      skill: 0,
    });
    const sourceCounts = emptyCounts();
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const profile = this.profilePredicate(source, spec.table);
      const row = source
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)} WHERE ${profile.sql}`)
        .get(profile.params) as { n: number };
      sourceCounts[spec.kind] = Number(row.n) || 0;
    }
    const replicaCounts = emptyCounts();
    for (const row of replica
      .prepare("SELECT kind, COUNT(*) AS n FROM peer_items WHERE profile_id = ? GROUP BY kind")
      .all([this.profileId]) as Array<{ kind: PeerSyncKind; n: number }>) {
      replicaCounts[row.kind] = Number(row.n) || 0;
    }
    const vectorCount = replica
      .prepare("SELECT COUNT(*) AS n FROM peer_vectors WHERE profile_id = ?")
      .get([this.profileId]) as { n: number };
    const origins = replica
      .prepare("SELECT origin_node AS nodeId, COUNT(*) AS items FROM peer_items WHERE profile_id = ? GROUP BY origin_node ORDER BY origin_node")
      .all([this.profileId]) as Array<{ nodeId: string; items: number }>;
    const sourceProfiles = replica
      .prepare("SELECT DISTINCT source_profile_id AS profileId FROM peer_items WHERE profile_id = ? ORDER BY source_profile_id")
      .all([this.profileId])
      .map(row => String((row as { profileId: unknown }).profileId));
    return {
      nodeId: this.options.nodeId,
      profileId: this.profileId,
      sourceProfiles,
      ...(this.embeddingModel ? { embeddingModel: this.embeddingModel } : {}),
      sourceDb: this.options.dbPath,
      replicaDb: this.replicaPath,
      source: sourceCounts,
      replicas: replicaCounts,
      vectors: Number(vectorCount.n) || 0,
      origins,
    };
  }

  private lexical(query: string, limit: number): PeerRetrievalHit[] {
    const source = this.requireSource();
    const replica = this.requireReplica();
    const hits: PeerRetrievalHit[] = [];
    for (const spec of TABLE_SPECS) {
      if (this.sourceTables.has(spec.table)) {
        const profile = this.profilePredicate(source, spec.table);
        for (const row of source
          .prepare(`SELECT * FROM ${quoteIdentifier(spec.table)} WHERE ${profile.sql} LIMIT ${SEARCH_SCAN_LIMIT}`)
          .all(profile.params) as Array<Record<string, unknown>>) {
          const payload = buildPayload(spec.kind, row);
          const score = lexicalScore(query, payload);
          if (score <= 0) continue;
          const id = safeString(row[spec.idColumn], 512);
          if (!id) continue;
          hits.push(this.hit("local", this.options.nodeId, spec.kind, id, score, payload));
        }
      }
    }
    for (const row of replica
      .prepare("SELECT * FROM peer_items WHERE profile_id = ? ORDER BY imported_at DESC LIMIT ?")
      .all([this.profileId, SEARCH_SCAN_LIMIT]) as ReplicaRow[]) {
      const payload = parseJsonObject(row.payload_json);
      const score = lexicalScore(query, payload);
      if (score <= 0) continue;
      hits.push(this.hit("replica", row.origin_node, row.kind, row.id, score, payload, row.source_profile_id));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private vectorSearch(query: PeerSearchVector, limit: number): PeerRetrievalHit[] {
    const queryModel = normalizeEmbeddingModel(query.model);
    if (!queryModel || query.values.length === 0) return [];
    if (!this.embeddingModel || queryModel !== this.embeddingModel) {
      throw new TypeError(`Query vector model does not match ${this.embeddingModel ?? "a known embedding model"}`);
    }
    if (!query.values.every(isFiniteFloat)) throw new TypeError("Query vector contains a non-finite value");
    const source = this.requireSource();
    const replica = this.requireReplica();
    const hits: PeerRetrievalHit[] = [];
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const profile = this.profilePredicate(source, spec.table);
      for (const row of source
        .prepare(`SELECT * FROM ${quoteIdentifier(spec.table)} WHERE ${profile.sql} LIMIT ${SEARCH_SCAN_LIMIT}`)
        .all(profile.params) as Array<Record<string, unknown>>) {
        for (const vector of buildVectors(spec.kind, row, this.embeddingModel)) {
          if (vector.model !== queryModel || vector.dimension !== query.values.length) continue;
          const score = cosine(query.values, vector.values);
          const id = safeString(row[spec.idColumn], 512);
          if (!id || score <= 0) continue;
          const hit = this.hit("local", this.options.nodeId, spec.kind, id, score, buildPayload(spec.kind, row));
          hit.vectorScore = score;
          hits.push(hit);
        }
      }
    }
    const vectors = replica
      .prepare("SELECT * FROM peer_vectors WHERE profile_id = ? AND model = ? AND dimension = ? LIMIT ?")
      .all([this.profileId, queryModel, query.values.length, SEARCH_SCAN_LIMIT]) as Array<{
        profile_id: string;
        origin_node: string;
        kind: PeerSyncKind;
        item_id: string;
        model: string;
        dimension: number;
        values_json: string;
      }>;
    for (const vector of vectors) {
      if (vector.model !== queryModel || vector.dimension !== query.values.length) continue;
      const values = JSON.parse(vector.values_json) as number[];
      const score = cosine(query.values, values);
      if (score <= 0) continue;
      const item = replica
        .prepare("SELECT payload_json, source_profile_id FROM peer_items WHERE profile_id = ? AND origin_node = ? AND kind = ? AND id = ? ORDER BY imported_at DESC LIMIT 1")
        .get([this.profileId, vector.origin_node, vector.kind, vector.item_id]) as
          | { payload_json: string; source_profile_id: string }
          | undefined;
      if (!item) continue;
      const hit = this.hit(
        "replica",
        vector.origin_node,
        vector.kind,
        vector.item_id,
        score,
        parseJsonObject(item.payload_json),
        item.source_profile_id,
      );
      hit.vectorScore = score;
      hits.push(hit);
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private hit(
    origin: "local" | "replica",
    originNode: string,
    kind: PeerSyncKind,
    id: string,
    score: number,
    payload: Record<string, unknown>,
    sourceProfileId?: string,
  ): PeerRetrievalHit {
    const remoteId = origin === "local" ? `remote~${id}` : `replica~${originNode}~${id}`;
    return {
      tier: kind === "skill" ? 1 : kind === "world_model" ? 3 : 2,
      refId: remoteId,
      refKind: kind === "world_model" ? "world-model" : kind === "policy" ? "experience" : kind,
      score: Math.max(0, Math.min(1, score)),
      snippet: `${snippetOf(payload)}${snippetOf(payload) ? "\n" : ""}replica~${originNode}~${id}`,
      ownerProfileId: this.profileId,
      origin,
      originNode,
      ...(sourceProfileId ? { sourceProfileId } : {}),
      remoteId,
      replica: origin === "replica",
    };
  }

  private getReplicaTrace(id: string, nodeId?: string): PeerTraceDetail | null {
    const replica = this.requireReplica();
    const row = (nodeId
      ? replica
          .prepare("SELECT * FROM peer_items WHERE profile_id = ? AND origin_node = ? AND kind = 'trace' AND id = ? ORDER BY imported_at DESC LIMIT 1")
          .get([this.profileId, nodeId, id])
      : replica
          .prepare("SELECT * FROM peer_items WHERE profile_id = ? AND kind = 'trace' AND id = ? ORDER BY imported_at DESC LIMIT 1")
          .get([this.profileId, id])) as ReplicaRow | undefined;
    if (!row) return null;
    const payload = parseJsonObject(row.payload_json);
    const detail = this.traceDto(
      { ...payload, id: row.id },
      payload,
      row.origin_node,
      `replica~${row.origin_node}~${row.id}`,
      row.revision,
      row.source_profile_id,
    );
    return {
      ...detail,
      ownerProfileId: this.profileId,
      refId: detail.remoteId,
    };
  }

  private traceDto(
    source: Record<string, unknown>,
    payload: Record<string, unknown>,
    originNode: string,
    remoteId: string,
    revision: string,
    sourceProfileId?: string,
  ): PeerTraceDetail {
    const id = safeString(source.id, 512) || safeString(payload.id, 512);
    const summary = safeString(payload.summary, 2_000);
    const agentText = summary || "Remote memory summary unavailable.";
    return {
      id,
      episodeId: safeString(source.episode_id, 512) || safeString(payload.episodeId, 512),
      sessionId: safeString(source.session_id, 512) || safeString(payload.sessionId, 512),
      ownerAgentKind: safeString(source.owner_agent_kind, 128) || "unknown",
      ownerProfileId: safeString(source.owner_profile_id, 128) || "default",
      ownerWorkspaceId: safeString(source.owner_workspace_id, 256) || null,
      ts: safeInteger(source.ts) ?? safeInteger(payload.ts) ?? 0,
      userText: "",
      agentText,
      summary: summary || null,
      tags: safeStringArray(payload.tags),
      toolCalls: [],
      value: safeNumber(payload.value),
      alpha: safeNumber(payload.alpha),
      priority: safeNumber(payload.priority),
      turnId: safeInteger(payload.ts) ?? 0,
      originNode,
      ...(sourceProfileId ? { sourceProfileId } : {}),
      remoteId,
      refId: remoteId,
      revision,
    };
  }

  private requireSource(): StorageDb {
    if (!this.source) throw new Error("PeerSyncStore is not open");
    return this.source;
  }

  private requireReplica(): StorageDb {
    if (!this.replica) throw new Error("PeerSyncStore is not open");
    return this.replica;
  }

  private installReplicaSchema(db: StorageDb): void {
    const version = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    if (Number(version?.user_version ?? 0) === 3) {
      this.ensureReplicaSchema(db);
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_items (
        profile_id TEXT NOT NULL DEFAULT 'default',
        origin_node TEXT NOT NULL,
        source_profile_id TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL CHECK (kind IN ('trace','policy','world_model','skill')),
        id TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        vectors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vectors_json)),
        source_updated_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, origin_node, source_profile_id, kind, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS peer_vectors (
        profile_id TEXT NOT NULL DEFAULT 'default',
        origin_node TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        values_json TEXT NOT NULL CHECK (json_valid(values_json)),
        PRIMARY KEY (profile_id, origin_node, kind, item_id, slot, model)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS peer_items_fts USING fts5(
        profile_id UNINDEXED,
        origin_node UNINDEXED,
        kind UNINDEXED,
        item_id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS peer_items_ai AFTER INSERT ON peer_items BEGIN
        INSERT INTO peer_items_fts(profile_id, origin_node, kind, item_id, text)
        VALUES (new.profile_id, new.origin_node, new.kind, new.id, new.payload_json);
      END;
      CREATE TRIGGER IF NOT EXISTS peer_items_au AFTER UPDATE ON peer_items BEGIN
        DELETE FROM peer_items_fts
         WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
        INSERT INTO peer_items_fts(profile_id, origin_node, kind, item_id, text)
        VALUES (new.profile_id, new.origin_node, new.kind, new.id, new.payload_json);
      END;
      CREATE TRIGGER IF NOT EXISTS peer_items_ad AFTER DELETE ON peer_items BEGIN
        DELETE FROM peer_items_fts
         WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
        DELETE FROM peer_vectors
         WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
      END;
      CREATE INDEX IF NOT EXISTS idx_peer_items_origin ON peer_items(profile_id, origin_node, kind, id);
      CREATE INDEX IF NOT EXISTS idx_peer_vectors_lookup ON peer_vectors(profile_id, model, dimension);
    `);
    migrateLegacyReplicaSchema(db);
    this.ensureReplicaSchema(db);
    db.exec("PRAGMA user_version = 3");
  }

  private ensureReplicaSchema(db: StorageDb): void {
    const itemColumns = tableColumns(db, "peer_items");
    const vectorColumns = tableColumns(db, "peer_vectors");
    const ftsColumns = tableColumns(db, "peer_items_fts");
    if (
      !itemColumns.has("profile_id") ||
      !vectorColumns.has("profile_id") ||
      !ftsColumns.has("profile_id") ||
      !itemColumns.has("source_profile_id")
    ) {
      throw new Error("PeerSync replica schema is incompatible");
    }
  }

  private sourceKeys(
    source: StorageDb,
    cursor: CursorState | undefined,
    limit: number,
  ): Array<{ kind: PeerSyncKind; id: string }> {
    const keys: Array<{ kind: PeerSyncKind; id: string }> = [];
    // `rev` without kind/id means the previous sweep completed. The next
    // request deliberately starts a fresh full-table pass so rows whose
    // timestamp never advances (notably value/alpha updates on traces) are
    // still compared by content revision.
    let active = !cursor || cursor.rev !== undefined;
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const started = !cursor || active || spec.kind === cursor.kind;
      if (!started) continue;
      const available = tableColumns(source, spec.table);
      if (!available.has(spec.idColumn)) continue;
      const profile = this.profilePredicate(source, spec.table);
      const after = cursor && spec.kind === cursor.kind ? `AND ${quoteIdentifier(spec.idColumn)} > @after_id` : "";
      const params: Record<string, unknown> = { key_limit: limit - keys.length, ...profile.params };
      if (after) params.after_id = cursor?.id;
      const rows = source
        .prepare(`
          SELECT ${quoteIdentifier(spec.idColumn)} AS id
            FROM ${quoteIdentifier(spec.table)}
           WHERE ${profile.sql} ${after}
           ORDER BY ${quoteIdentifier(spec.idColumn)} ASC
           LIMIT @key_limit`)
        .all(params) as Array<{ id: unknown }>;
      for (const row of rows) {
        const id = safeString(row.id, 512);
        if (id) keys.push({ kind: spec.kind, id });
      }
      if (cursor?.kind === spec.kind) active = true;
      if (keys.length >= limit) break;
    }
    return keys;
  }

  private exportItem(source: StorageDb, key: { kind: PeerSyncKind; id: string }): PeerSyncItem {
    const spec = TABLE_SPECS.find(candidate => candidate.kind === key.kind);
    if (!spec || !this.sourceTables.has(spec.table)) throw new Error("PeerSync source table is unavailable");
    const available = tableColumns(source, spec.table);
    const cols = spec.columns.filter(column => available.has(column));
    const payloadColumns = projectionColumns(cols, spec.kind);
    const vectorColumns = vectorFields(spec.kind).filter(column => available.has(column));
    const profile = this.profilePredicate(source, spec.table);
    const select = [
      ...payloadColumns.map(quoteIdentifier),
      ...vectorColumns.map(quoteIdentifier),
    ].join(", ");
    const row = source
      .prepare(`
        SELECT ${select || "1 AS empty"}
          FROM ${quoteIdentifier(spec.table)}
         WHERE ${profile.sql} AND ${quoteIdentifier(spec.idColumn)} = @id
         LIMIT 1`)
      .get({ ...profile.params, id: key.id }) as Record<string, unknown> | undefined;
    if (!row) throw new Error("PeerSync item disappeared during export");
    const payload = buildPayload(spec.kind, row);
    const vectors = buildVectors(spec.kind, row, this.embeddingModel);
    const updatedAt = payloadTime(payload);
    return {
      kind: key.kind,
      id: key.id,
      revision: revisionOf(updatedAt, payload, vectors),
      payload,
      vectors,
    };
  }

  private profilePredicate(source: StorageDb, table: string): { sql: string; params: Record<string, unknown> } {
    const columns = tableColumns(source, table);
    return columns.has("owner_profile_id") && columns.has("owner_agent_kind")
      ? {
          sql: "owner_agent_kind = @profile_agent_kind AND owner_profile_id = @profile_id",
          params: {
            profile_agent_kind: "deepseek-harness",
            profile_id: this.profileId,
          },
        }
      : { sql: "1 = 0", params: {} };
  }
}

function validatePage(
  page: unknown,
  expectedNodeId: string,
  localNodeId: string,
  expectedSourceProfileId?: string,
): {
  originNode: string;
  sourceProfileId: string;
  items: Array<PeerSyncItem & { sourceUpdatedAt: number }>;
} {
  if (!page || typeof page !== "object" || Array.isArray(page)) throw new TypeError("Invalid peer page");
  const raw = page as Record<string, unknown>;
  if (raw.protocol !== PEER_SYNC_PROTOCOL) throw new TypeError("Unsupported peer protocol");
  if (!validNodeId(expectedNodeId)) throw new TypeError("Expected peer node id is invalid");
  if (raw.nodeId !== expectedNodeId) throw new TypeError("Peer node id does not match");
  if (raw.nodeId === localNodeId) throw new TypeError("Peer page must originate from another node");
  if (typeof raw.profileId !== "string" || !raw.profileId.trim()) {
    throw new TypeError("Peer page source profile is missing or invalid");
  }
  const sourceProfileId = normalizeProfileId(raw.profileId);
  if (expectedSourceProfileId !== undefined && sourceProfileId !== normalizeProfileId(expectedSourceProfileId)) {
    throw new TypeError("Peer page source profile does not match the paired peer");
  }
  if (typeof raw.done !== "boolean") throw new TypeError("Peer page done flag is invalid");
  if (!Array.isArray(raw.items) || raw.items.length > PEER_SYNC_MAX_PAGE_ITEMS) {
    throw new TypeError("Peer page item count is invalid");
  }
  if (raw.nextCursor !== undefined && (typeof raw.nextCursor !== "string" || raw.nextCursor.length > 1_024)) {
    throw new TypeError("Peer page cursor is invalid");
  }
  const ids = new Set<string>();
  const items = raw.items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid peer item");
    const item = value as Record<string, unknown>;
    if (!isKind(item.kind)) throw new TypeError("Invalid peer item kind");
    if (!safeString(item.id, 512)) throw new TypeError("Invalid peer item id");
    if (!safeString(item.revision, 512)) throw new TypeError("Invalid peer item revision");
    if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) {
      throw new TypeError("Invalid peer item payload");
    }
    if (!Array.isArray(item.vectors) || item.vectors.length > 16) throw new TypeError("Invalid peer item vectors");
    const key = `${item.kind}\u0000${item.id}`;
    if (ids.has(key)) throw new TypeError("Duplicate peer item");
    ids.add(key);
    const payload = sanitizeForWire(item.payload as Record<string, unknown>);
    if (!isRecord(payload)) throw new TypeError("Invalid peer item payload");
    const ownerAgentKind = payload.ownerAgentKind;
    const ownerProfileId = payload.ownerProfileId;
    if (typeof ownerProfileId !== "string" || normalizeProfileId(ownerProfileId) !== sourceProfileId) {
      throw new TypeError("Peer item profile does not match the page");
    }
    if (typeof ownerAgentKind !== "string" || !ownerAgentKind.trim()) {
      throw new TypeError("Peer item agent identity is missing");
    }
    const vectors = sanitizeVectors(item.vectors as unknown[]);
    const sourceUpdatedAt = payloadTime(payload);
    return {
      kind: item.kind,
      id: String(item.id),
      revision: String(item.revision),
      payload,
      vectors,
      sourceUpdatedAt,
    };
  });
  return { originNode: expectedNodeId, sourceProfileId, items };
}

function buildPayload(kind: PeerSyncKind, row: Record<string, unknown>): Record<string, unknown> {
  const owner = {
    ownerAgentKind: safeIdentifier(row["owner_agent_kind"], 128) || "unknown",
    ownerProfileId: safeIdentifier(row["owner_profile_id"], 128) || "default",
    ownerWorkspaceId: safeString(row["owner_workspace_id"], 256) || null,
  };
  if (kind === "trace") {
    return wireRecord({
      summary: safeString(row["summary"], 2_000) || null,
      tags: safeJsonArray(row["tags_json"]),
      value: safeNumber(row["value"]),
      alpha: safeNumber(row["alpha"]),
      priority: safeNumber(row["priority"]),
      ts: safeInteger(row["ts"]),
      ...owner,
    });
  }
  if (kind === "policy") {
    const guidance = parseJsonObject(row["decision_guidance_json"]);
    return wireRecord({
      title: safeString(row["title"], 512),
      trigger: safeString(row["trigger"], 2_000),
      procedure: safeString(row["procedure"], 4_000),
      verification: safeString(row["verification"], 2_000),
      boundary: safeString(row["boundary"], 2_000),
      support: safeInteger(row["support"]) ?? 0,
      gain: safeNumber(row["gain"]),
      status: safeString(row["status"], 32),
      experienceType: safeString(row["experience_type"], 64),
      evidencePolarity: safeString(row["evidence_polarity"], 32),
      salience: safeNumber(row["salience"]),
      confidence: safeNumber(row["confidence"]),
      preference: safeStringArray(guidance["preference"]),
      antiPattern: safeStringArray(guidance["antiPattern"]),
      sourceEpisodeIds: safeIdentifierArray(row["source_episodes_json"]),
      sourceTraceIds: safeIdentifierArray(row["source_trace_ids_json"]),
      createdAt: safeInteger(row["created_at"]),
      updatedAt: safeInteger(row["updated_at"]),
      editedAt: safeInteger(row["edited_at"]),
      ...owner,
    });
  }
  if (kind === "world_model") {
    return wireRecord({
      title: safeString(row["title"], 512),
      body: safeString(row["body"], 4_000),
      structure: parseJsonObject(row["structure_json"]),
      domainTags: safeJsonArray(row["domain_tags_json"]),
      policyIds: safeIdentifierArray(row["policy_ids_json"]),
      sourceEpisodeIds: safeIdentifierArray(row["source_episodes_json"]),
      confidence: safeNumber(row["confidence"]),
      version: safeInteger(row["version"]) ?? 1,
      status: safeString(row["status"], 32),
      createdAt: safeInteger(row["created_at"]),
      updatedAt: safeInteger(row["updated_at"]),
      editedAt: safeInteger(row["edited_at"]),
      ...owner,
    });
  }
  return wireRecord({
    name: safeString(row["name"], 512),
    status: safeString(row["status"], 32),
    invocationGuide: safeString(row["invocation_guide"], 4_000),
    procedure: wireRecord(parseJsonObject(row["procedure_json"])),
    eta: safeNumber(row["eta"]),
    support: safeInteger(row["support"]) ?? 0,
    gain: safeNumber(row["gain"]),
    trialsAttempted: safeInteger(row["trials_attempted"]) ?? 0,
    trialsPassed: safeInteger(row["trials_passed"]) ?? 0,
    sourcePolicyIds: safeIdentifierArray(row["source_policies_json"]),
    sourceWorldModelIds: safeIdentifierArray(row["source_world_json"]),
    evidenceAnchors: safeIdentifierArray(row["evidence_anchors_json"]),
    createdAt: safeInteger(row["created_at"]),
    updatedAt: safeInteger(row["updated_at"]),
    version: safeInteger(row["version"]) ?? 1,
    editedAt: safeInteger(row["edited_at"]),
    ...owner,
  });
}

function buildVectors(
  kind: PeerSyncKind,
  row: Record<string, unknown>,
  model: string | undefined,
): PeerSyncVector[] {
  if (!model) return [];
  const out: PeerSyncVector[] = [];
  const slots = vectorFields(kind);
  for (const slot of slots) {
    const vector = decodeVectorBlob(row[slot]);
    if (!vector) continue;
    out.push({
      slot: slot === "vec_summary" ? "summary" : slot === "vec_action" ? "action" : "content",
      model,
      dimension: vector.length,
      values: vector,
    });
  }
  return out;
}

function vectorFields(kind: PeerSyncKind): string[] {
  if (kind === "trace") return ["vec_summary", "vec_action"];
  return ["vec"];
}

function projectionColumns(columns: readonly string[], kind: PeerSyncKind): string[] {
  const blocked = new Set(["messages", "messages_json", "logs", "config", "raw_json"]);
  const vector = new Set(vectorFields(kind));
  return columns.filter((column) => !blocked.has(column) && !vector.has(column));
}

function revisionOf(updatedAt: number, payload: Record<string, unknown>, vectors: PeerSyncVector[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ updatedAt, payload, vectors }))
    .digest("hex");
}

function sanitizeForWire(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizeForWire(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
      out[key] = sanitizeForWire(child, depth + 1);
    }
    return out;
  }
  return null;
}

function redactString(value: string): string {
  const credential = new RegExp(CREDENTIAL_VALUE.source, "gi");
  return value
    .replace(credential, (_match, assignment?: string) =>
      assignment ? `${assignment}[redacted]` : "[redacted]")
    .replace(new RegExp(ABSOLUTE_PATH.source, "g"), "[local path]");
}

function sanitizeVectors(values: readonly unknown[]): PeerSyncVector[] {
  const out: PeerSyncVector[] = [];
  for (const value of values.slice(0, 16)) {
    if (!value || typeof value !== "object") throw new TypeError("Invalid peer vector");
    const vector = value as Record<string, unknown>;
    const slot = safeString(vector.slot, 64);
    const model = safeString(vector.model, 256);
    const dimension = safeInteger(vector.dimension);
    const rawValues = vector.values;
    if (!slot || !model || dimension === undefined || dimension <= 0) {
      throw new TypeError("Invalid peer vector metadata");
    }
    if (dimension > PEER_SYNC_MAX_VECTOR_VALUES) throw new TypeError("Peer vector is too large");
    if (!Array.isArray(rawValues) || rawValues.length !== dimension) {
      throw new TypeError("Peer vector dimension mismatch");
    }
    if (!rawValues.every((item) => typeof item === "number" && isFiniteFloat(item))) {
      throw new TypeError("Peer vector contains a non-finite value");
    }
    out.push({ slot, model, dimension, values: rawValues as number[] });
  }
  return out;
}

function payloadTime(payload: Record<string, unknown>): number {
  for (const key of ["updatedAt", "editedAt", "createdAt", "ts"]) {
    const value = safeInteger(payload[key]);
    if (value !== undefined) return value;
  }
  return 0;
}

function lexicalScore(query: string, payload: Record<string, unknown>): number {
  const haystack = JSON.stringify(payload).toLocaleLowerCase();
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
  if (terms.length === 0) return 0;
  let matches = 0;
  for (const term of terms) if (haystack.includes(term)) matches++;
  return matches === 0 ? 0 : matches / terms.length;
}

function snippetOf(payload: Record<string, unknown>): string {
  const candidates = [
    payload.summary,
    payload.title,
    payload.name,
    payload.body,
    payload.invocationGuide,
    payload.trigger,
    payload.procedure,
  ];
  for (const value of candidates) {
    const text = safeString(value, 1_000);
    if (text) return text;
  }
  return "";
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

function decodeVectorBlob(value: unknown): number[] | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength % 4 !== 0) {
    return null;
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const floats = new Float32Array(copy.buffer);
  const out = Array.from(floats);
  return out.every(isFiniteFloat) ? out : null;
}

function safeString(value: unknown, max: number): string {
  return typeof value === "string" ? redactString(value).slice(0, max) : "";
}

function safeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => redactString(item)).slice(0, 128)
    : [];
}

function safeIdentifierArray(value: unknown): string[] {
  return safeStringArray(value).filter(item => !GLOBAL_ID.test(item) && !isAbsolutePath(item));
}

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    return safeStringArray(JSON.parse(value));
  } catch {
    return [];
  }
}

function safeIdentifier(value: unknown, max: number): string {
  const text = safeString(value, max);
  return GLOBAL_ID.test(text) || isAbsolutePath(text) ? "" : text;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("\\\\") || WINDOWS_ID_PATH.test(value) || POSIX_HOME_PATH.test(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function wireRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeForWire(value);
  return isRecord(sanitized) ? sanitized : {};
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isFiniteFloat(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isKind(value: unknown): value is PeerSyncKind {
  return value === "trace" || value === "policy" || value === "world_model" || value === "skill";
}

function validNodeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(PEER_SYNC_MAX_PAGE_ITEMS, Math.trunc(value));
}

function encodeCursor(cursor: CursorState): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseCursor(raw: string | undefined): CursorState | undefined {
  if (!raw) return undefined;
  if (raw.length > 1_024) throw new TypeError("Peer cursor is too long");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorState>;
    const hasPage = isKind(parsed.kind) && Boolean(safeString(parsed.id, 512));
    const hasRev = safeInteger(parsed.rev) !== undefined;
    if (parsed.version !== 2 || (!hasPage && !hasRev)) {
      throw new Error("shape");
    }
    return {
      version: 2,
      ...(hasPage ? { kind: parsed.kind as PeerSyncKind, id: String(parsed.id) } : {}),
      ...(hasRev ? { rev: safeInteger(parsed.rev) } : {}),
    };
  } catch {
    throw new TypeError("Peer cursor is invalid");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function tableColumns(source: StorageDb, table: string): Set<string> {
  return new Set(
    source
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map(row => String((row as { name: unknown }).name)),
  );
}

function normalizeProfileId(value: string | undefined): string {
  const normalized = String(value ?? "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function normalizeEmbeddingModel(value: string | undefined): string | undefined {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  return /^[^/\s]+\/\S+$/.test(normalized) ? normalized : undefined;
}

function readConfiguredEmbeddingModel(home: string, dataDir: string): string | undefined {
  const candidates = [
    path.join(path.resolve(home), "config.yaml"),
    path.join(path.resolve(dataDir), "..", "config.yaml"),
  ];
  for (const configFile of candidates) {
    if (!fs.existsSync(configFile)) continue;
    try {
    const raw = parseYaml(fs.readFileSync(configFile, "utf8"), configFile);
    const embedding = isRecord(raw) && isRecord(raw.embedding) ? raw.embedding : undefined;
    // DEFAULT_CONFIG is not lineage: only fields persisted in this profile
    // may label existing vectors.
    if (!embedding) return undefined;
    const provider = typeof embedding.provider === "string" ? embedding.provider.trim() : "";
    const model = typeof embedding.model === "string" ? embedding.model.trim() : "";
    if (!provider || !model || embedding.dimensions !== undefined) return undefined;
    return normalizeEmbeddingModel(provider && model ? `${provider}/${model}` : undefined);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function migrateLegacyReplicaSchema(db: StorageDb): void {
  const itemColumns = tableColumns(db, "peer_items");
  const vectorColumns = tableColumns(db, "peer_vectors");
  const ftsColumns = tableColumns(db, "peer_items_fts");
  if (
    !itemColumns.has("profile_id") ||
    !vectorColumns.has("profile_id") ||
    !ftsColumns.has("profile_id") ||
    itemColumns.has("source_profile_id")
  ) return;
  const schemaVersion = Number(db.prepare("PRAGMA user_version").get() as unknown);
  if (schemaVersion === 1) throw new Error("PeerSync replica belongs to another profile");
  db.exec(`
    DROP TRIGGER IF EXISTS peer_items_ai;
    DROP TRIGGER IF EXISTS peer_items_au;
    DROP TRIGGER IF EXISTS peer_items_ad;
    DROP TABLE IF EXISTS peer_items_fts;
    DROP TABLE IF EXISTS peer_vectors;
    DROP TABLE IF EXISTS peer_items;
    PRAGMA user_version = 1;
  `);
  db.exec(`
    CREATE TABLE peer_items (
      profile_id TEXT NOT NULL DEFAULT 'default',
      origin_node TEXT NOT NULL,
      source_profile_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL CHECK (kind IN ('trace','policy','world_model','skill')),
      id TEXT NOT NULL,
      revision TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      vectors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vectors_json)),
      source_updated_at INTEGER NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (profile_id, origin_node, source_profile_id, kind, id)
    ) STRICT;
    CREATE TABLE peer_vectors (
      profile_id TEXT NOT NULL DEFAULT 'default',
      origin_node TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      values_json TEXT NOT NULL CHECK (json_valid(values_json)),
      PRIMARY KEY (profile_id, origin_node, kind, item_id, slot, model)
    ) STRICT;
    CREATE VIRTUAL TABLE peer_items_fts USING fts5(
      profile_id UNINDEXED,
      origin_node UNINDEXED,
      kind UNINDEXED,
      item_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
    CREATE TRIGGER peer_items_ai AFTER INSERT ON peer_items BEGIN
      INSERT INTO peer_items_fts(profile_id, origin_node, kind, item_id, text)
      VALUES (new.profile_id, new.origin_node, new.kind, new.id, new.payload_json);
    END;
    CREATE TRIGGER peer_items_au AFTER UPDATE ON peer_items BEGIN
      DELETE FROM peer_items_fts
       WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
      INSERT INTO peer_items_fts(profile_id, origin_node, kind, item_id, text)
      VALUES (new.profile_id, new.origin_node, new.kind, new.id, new.payload_json);
    END;
    CREATE TRIGGER peer_items_ad AFTER DELETE ON peer_items BEGIN
      DELETE FROM peer_items_fts
       WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
      DELETE FROM peer_vectors
       WHERE profile_id = old.profile_id AND origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
    END;
    CREATE INDEX idx_peer_items_origin ON peer_items(profile_id, origin_node, source_profile_id, kind, id);
    CREATE INDEX idx_peer_vectors_lookup ON peer_vectors(profile_id, model, dimension);
  `);
}
