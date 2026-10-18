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
  revision: string;
  payload: Record<string, unknown>;
  vectors: PeerSyncVector[];
}

export interface PeerSyncPage {
  protocol: typeof PEER_SYNC_PROTOCOL;
  nodeId: string;
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
}

export interface PeerSearchVector {
  model: string;
  values: number[];
}

export interface PeerRetrievalHit extends RetrievalHitDTO {
  origin: "local" | "replica";
  originNode: string;
  remoteId: string;
  replica?: boolean;
  vectorScore?: number;
}

export interface PeerTraceDetail extends TraceDTO {
  originNode: string;
  remoteId: string;
  revision: string;
}

export interface PeerSyncStats {
  nodeId: string;
  sourceDb: string;
  replicaDb: string;
  source: Record<PeerSyncKind, number>;
  replicas: Record<PeerSyncKind, number>;
  vectors: number;
  origins: Array<{ nodeId: string; items: number }>;
}

interface CursorState {
  updatedAt: number;
  kind: PeerSyncKind;
  id: string;
  sweep?: boolean;
}

interface CandidateRow {
  kind: PeerSyncKind;
  id: string;
  revision: string;
  updated_at: number;
  payload_json: string;
  vectors_json: string;
}

interface ReplicaRow {
  origin_node: string;
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

const KIND_ORDER: Record<PeerSyncKind, number> = {
  trace: 0,
  policy: 1,
  world_model: 2,
  skill: 3,
};

const CREDENTIAL_KEY =
  /(?:^|_)(?:api_?key|access_?key|secret|password|passwd|token|authorization|cookie|private_?key|credential)(?:$|_)/i;
const CREDENTIAL_VALUE =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|\bsk-[A-Za-z0-9_-]{16,}|((?:api[_-]?key|access[_-]?token|password|bindkey)\s*[=:]\s*["']?)[^\s"',;]{8,}/i;
const ABSOLUTE_PATH =
  /(?<![\w:/])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|root|srv|Users|tmp|var|etc|opt|mnt|Volumes|private)\/)[^\s"'`<>]*/g;
const SEARCH_SCAN_LIMIT = 2_000;

export class PeerSyncStore {
  private source?: StorageDb;
  private replica?: StorageDb;
  private sourceTables = new Set<string>();
  private readonly replicaPath: string;

  constructor(private readonly options: PeerSyncStoreOptions) {
    if (!options.home.trim()) throw new TypeError("PeerSyncStore home is required");
    if (!options.dbPath.trim()) throw new TypeError("PeerSyncStore dbPath is required");
    if (!validNodeId(options.nodeId)) throw new TypeError("PeerSyncStore nodeId is invalid");
    this.replicaPath = path.join(path.resolve(options.home), "peer-replicas.db");
  }

  open(): void {
    if (this.source) return;
    if (!fs.existsSync(this.options.dbPath)) {
      throw new Error("PeerSync source database does not exist");
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
    const candidates: CandidateRow[] = [];

    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const available = new Set(
        source
          .prepare(`PRAGMA table_info(${quoteIdentifier(spec.table)})`)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      );
      const cols = spec.columns.filter((column) => available.has(column));
      const updatedExpression = updatedExpressionFor(spec, available);
      if (!updatedExpression || !available.has(spec.idColumn)) continue;
      const payload = projectionColumns(cols, spec.kind);
      const vectors = vectorColumns(spec.kind).filter((column) => available.has(column));
      const cursorPredicate = cursor
        ? `AND (${updatedExpression} > @updated_at
             OR (${updatedExpression} = @updated_at AND ${quoteIdentifier(spec.idColumn)} > @id)
             OR (${updatedExpression} = @updated_at AND ${quoteIdentifier(spec.idColumn)} = @id
                 AND @kind > @kind_cursor))`
        : "";
      const params: Record<string, unknown> = {
        kind: KIND_ORDER[spec.kind],
        scan_limit: cursor
          ? requested + 1
          : Math.min(PEER_SYNC_MAX_PAGE_ITEMS * 4, requested + 1),
      };
      if (cursor) {
        params.updated_at = cursor.updatedAt;
        params.id = cursor.id;
        params.kind_cursor = KIND_ORDER[cursor.kind];
      }
      const select = [
        `${updatedExpression} AS peer_updated_at`,
        quoteIdentifier(spec.idColumn),
        ...payload.map(quoteIdentifier),
        ...vectors.map(quoteIdentifier),
      ].join(", ");
      const sql = `
        SELECT ${select}
          FROM ${quoteIdentifier(spec.table)}
         WHERE 1 = 1 ${cursorPredicate}
         ORDER BY peer_updated_at ASC, ${quoteIdentifier(spec.idColumn)} ASC
         LIMIT @scan_limit`;
      const rows = source.prepare(sql).all(params) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = safeString(row[spec.idColumn], 512);
        const updatedAt = safeInteger(row.peer_updated_at);
        if (!id || updatedAt === undefined) continue;
        const itemPayload = buildPayload(spec.kind, row);
        const itemVectors = buildVectors(spec.kind, row);
        const revision = revisionOf(updatedAt, itemPayload, itemVectors);
        candidates.push({
          kind: spec.kind,
          id,
          revision,
          updated_at: updatedAt,
          payload_json: JSON.stringify(itemPayload),
          vectors_json: JSON.stringify(itemVectors),
        });
      }
    }

    candidates.sort(compareCandidates);
    if (candidates.length === 0 && cursor?.sweep) {
      this.collectRevisionCandidates(source, candidates, requested);
    }
    const selected: PeerSyncItem[] = [];
    let bytes = 0;
    for (const candidate of candidates.slice(0, requested)) {
      const item: PeerSyncItem = {
        kind: candidate.kind,
        id: candidate.id,
        revision: candidate.revision,
        payload: JSON.parse(candidate.payload_json) as Record<string, unknown>,
        vectors: JSON.parse(candidate.vectors_json) as PeerSyncVector[],
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes + itemBytes > PEER_SYNC_MAX_PAGE_BYTES) {
        if (selected.length === 0) {
          throw new Error("PeerSync item exceeds the page byte limit");
        }
        break;
      }
      bytes += itemBytes;
      selected.push(item);
    }

    const selectedLast = selected.length > 0
      ? candidates.find((candidate) =>
          candidate.kind === selected[selected.length - 1]!.kind &&
          candidate.id === selected[selected.length - 1]!.id)
      : undefined;
    const cursorKey = selectedLast
      ? { updated_at: selectedLast.updated_at, kind: selectedLast.kind, id: selectedLast.id }
      : cursor
        ? { updated_at: cursor.updatedAt, kind: cursor.kind, id: cursor.id }
        : undefined;
    const hasMore = cursorKey
      ? this.hasExportCandidatesAfter(source, cursorKey)
      : false;
    const page: PeerSyncPage = {
      protocol: PEER_SYNC_PROTOCOL,
      nodeId: this.options.nodeId,
      items: selected,
      done: !hasMore,
    };
    if (cursorKey) page.nextCursor = encodeCursor({
      updatedAt: cursorKey.updated_at,
      kind: cursorKey.kind,
      id: cursorKey.id,
      sweep: !hasMore,
    });
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > PEER_SYNC_MAX_PAGE_BYTES) {
      throw new Error("PeerSync page exceeds the response byte limit");
    }
    return page;
  }

  importPage(page: unknown, expectedNodeId: string): { inserted: number; updated: number; skipped: number } {
    const replica = this.requireReplica();
    const validated = validatePage(page, expectedNodeId, this.options.nodeId);
    const upsert = replica.prepare(`
      INSERT INTO peer_items (
        origin_node, kind, id, revision, payload_json, vectors_json,
        source_updated_at, imported_at
      ) VALUES (
        @origin_node, @kind, @id, @revision, @payload_json, @vectors_json,
        @source_updated_at, @imported_at
      )
      ON CONFLICT(origin_node, kind, id) DO UPDATE SET
        revision = excluded.revision,
        payload_json = excluded.payload_json,
        vectors_json = excluded.vectors_json,
        source_updated_at = excluded.source_updated_at,
        imported_at = excluded.imported_at
      WHERE excluded.revision <> peer_items.revision
         OR excluded.payload_json <> peer_items.payload_json
         OR excluded.vectors_json <> peer_items.vectors_json`);
    const exists = replica.prepare(
      "SELECT revision FROM peer_items WHERE origin_node = ? AND kind = ? AND id = ?",
    );
    const result = { inserted: 0, updated: 0, skipped: 0 };
    replica.tx(() => {
      for (const item of validated.items) {
        const previous = exists.get([validated.originNode, item.kind, item.id]) as
          | { revision: string }
          | undefined;
        const payload = JSON.stringify(sanitizeForWire(item.payload));
        const vectors = JSON.stringify(sanitizeVectors(item.vectors));
        const run = upsert.run({
          origin_node: validated.originNode,
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
    if (id.startsWith("replica~")) {
      const rest = id.slice(8);
      const split = rest.indexOf("~");
      if (split <= 0) return null;
      return this.getReplicaTrace(rest.slice(split + 1), rest.slice(0, split));
    }
    if (nodeId && nodeId !== this.options.nodeId) return this.getReplicaTrace(id, nodeId);
    if (!this.sourceTables.has("traces")) return null;
    const trace = source
      .prepare("SELECT * FROM traces WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!trace) return null;
    const payload = buildPayload("trace", trace);
    return this.traceDto(trace, payload, this.options.nodeId, id, revisionOf(
      safeInteger(trace["ts"]) ?? 0,
      payload,
      buildVectors("trace", trace),
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
      const row = source
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(spec.table)}`)
        .get() as { n: number };
      sourceCounts[spec.kind] = Number(row.n) || 0;
    }
    const replicaCounts = emptyCounts();
    for (const row of replica
      .prepare("SELECT kind, COUNT(*) AS n FROM peer_items GROUP BY kind")
      .all() as Array<{ kind: PeerSyncKind; n: number }>) {
      replicaCounts[row.kind] = Number(row.n) || 0;
    }
    const vectorCount = replica
      .prepare("SELECT COUNT(*) AS n FROM peer_vectors")
      .get() as { n: number };
    const origins = replica
      .prepare("SELECT origin_node AS nodeId, COUNT(*) AS items FROM peer_items GROUP BY origin_node ORDER BY origin_node")
      .all() as Array<{ nodeId: string; items: number }>;
    return {
      nodeId: this.options.nodeId,
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
        for (const row of source
          .prepare(`SELECT * FROM ${quoteIdentifier(spec.table)} LIMIT ${SEARCH_SCAN_LIMIT}`)
          .all() as Array<Record<string, unknown>>) {
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
      .prepare("SELECT * FROM peer_items ORDER BY imported_at DESC LIMIT ?")
      .all([SEARCH_SCAN_LIMIT]) as ReplicaRow[]) {
      const payload = parseJsonObject(row.payload_json);
      const score = lexicalScore(query, payload);
      if (score <= 0) continue;
      hits.push(this.hit("replica", row.origin_node, row.kind, row.id, score, payload));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private vectorSearch(query: PeerSearchVector, limit: number): PeerRetrievalHit[] {
    if (!query.model.trim() || query.values.length === 0) return [];
    if (!query.values.every(isFiniteFloat)) throw new TypeError("Query vector contains a non-finite value");
    const source = this.requireSource();
    const replica = this.requireReplica();
    const hits: PeerRetrievalHit[] = [];
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      for (const row of source
        .prepare(`SELECT * FROM ${quoteIdentifier(spec.table)} LIMIT ${SEARCH_SCAN_LIMIT}`)
        .all() as Array<Record<string, unknown>>) {
        for (const vector of buildVectors(spec.kind, row)) {
          if (vector.model !== query.model || vector.dimension !== query.values.length) continue;
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
      .prepare("SELECT * FROM peer_vectors WHERE model = ? AND dimension = ? LIMIT ?")
      .all([query.model, query.values.length, SEARCH_SCAN_LIMIT]) as Array<{
        origin_node: string;
        kind: PeerSyncKind;
        item_id: string;
        model: string;
        dimension: number;
        values_json: string;
      }>;
    for (const vector of vectors) {
      if (vector.model !== query.model || vector.dimension !== query.values.length) continue;
      const values = JSON.parse(vector.values_json) as number[];
      const score = cosine(query.values, values);
      if (score <= 0) continue;
      const item = replica
        .prepare("SELECT payload_json FROM peer_items WHERE origin_node = ? AND kind = ? AND id = ?")
        .get([vector.origin_node, vector.kind, vector.item_id]) as { payload_json: string } | undefined;
      if (!item) continue;
      const hit = this.hit(
        "replica",
        vector.origin_node,
        vector.kind,
        vector.item_id,
        score,
        parseJsonObject(item.payload_json),
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
  ): PeerRetrievalHit {
    const remoteId = origin === "local" ? `remote~${id}` : `replica~${originNode}~${id}`;
    return {
      tier: kind === "skill" ? 1 : kind === "world_model" ? 3 : 2,
      refId: remoteId,
      refKind: kind === "world_model" ? "world-model" : kind === "policy" ? "experience" : kind,
      score: Math.max(0, Math.min(1, score)),
      snippet: snippetOf(payload),
      origin,
      originNode,
      remoteId,
      replica: origin === "replica",
    };
  }

  private getReplicaTrace(id: string, nodeId?: string): PeerTraceDetail | null {
    const replica = this.requireReplica();
    const row = (nodeId
      ? replica
          .prepare("SELECT * FROM peer_items WHERE origin_node = ? AND kind = 'trace' AND id = ?")
          .get([nodeId, id])
      : replica
          .prepare("SELECT * FROM peer_items WHERE kind = 'trace' AND id = ? ORDER BY imported_at DESC LIMIT 1")
          .get(id)) as ReplicaRow | undefined;
    if (!row) return null;
    const payload = parseJsonObject(row.payload_json);
    return this.traceDto(
      { ...payload, id: row.id },
      payload,
      row.origin_node,
      `replica~${row.origin_node}~${row.id}`,
      row.revision,
    );
  }

  private traceDto(
    source: Record<string, unknown>,
    payload: Record<string, unknown>,
    originNode: string,
    remoteId: string,
    revision: string,
  ): PeerTraceDetail {
    const id = safeString(source.id, 512) || safeString(payload.id, 512);
    const summary = safeString(payload.summary, 2_000);
    const agentText = safeString(payload.agentText, 2_000) || summary;
    return {
      id,
      episodeId: safeString(source.episode_id, 512) || safeString(payload.episodeId, 512),
      sessionId: safeString(source.session_id, 512) || safeString(payload.sessionId, 512),
      ownerAgentKind: safeString(source.owner_agent_kind, 128) || "unknown",
      ownerProfileId: safeString(source.owner_profile_id, 128) || "default",
      ownerWorkspaceId: safeString(source.owner_workspace_id, 256) || null,
      ts: safeInteger(source.ts) ?? safeInteger(payload.ts) ?? 0,
      userText: safeString(payload.userText, 2_000),
      agentText,
      summary: summary || null,
      tags: safeStringArray(payload.tags),
      toolCalls: [],
      value: safeNumber(payload.value),
      alpha: safeNumber(payload.alpha),
      priority: safeNumber(payload.priority),
      turnId: safeInteger(payload.ts) ?? 0,
      originNode,
      remoteId,
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

  private hasExportCandidatesAfter(
    source: StorageDb,
    cursor: { updated_at: number; kind: PeerSyncKind; id: string },
  ): boolean {
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const available = new Set(
        source
          .prepare(`PRAGMA table_info(${quoteIdentifier(spec.table)})`)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      );
      const updatedExpression = updatedExpressionFor(spec, available);
      if (!updatedExpression || !available.has(spec.idColumn)) continue;
      const row = source
        .prepare(`
          SELECT 1 AS found
            FROM ${quoteIdentifier(spec.table)}
           WHERE ${updatedExpression} > @updated_at
              OR (${updatedExpression} = @updated_at
                  AND ${quoteIdentifier(spec.idColumn)} > @id)
              OR (${updatedExpression} = @updated_at
                  AND ${quoteIdentifier(spec.idColumn)} = @id
                  AND @kind > @kind_cursor)
           LIMIT 1`)
        .get({
          updated_at: cursor.updated_at,
          id: cursor.id,
          kind: KIND_ORDER[spec.kind],
          kind_cursor: KIND_ORDER[cursor.kind],
        });
      if (row) return true;
    }
    return false;
  }

  private collectRevisionCandidates(
    source: StorageDb,
    candidates: CandidateRow[],
    limit: number,
  ): void {
    for (const spec of TABLE_SPECS) {
      if (!this.sourceTables.has(spec.table)) continue;
      const available = new Set(
        source
          .prepare(`PRAGMA table_info(${quoteIdentifier(spec.table)})`)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      );
      const updatedExpression = updatedExpressionFor(spec, available);
      if (!updatedExpression || !available.has(spec.idColumn)) continue;
      const cols = spec.columns.filter((column) => available.has(column));
      const payload = projectionColumns(cols, spec.kind);
      const vectors = vectorColumns(spec.kind).filter((column) => available.has(column));
      const select = [
        `${updatedExpression} AS peer_updated_at`,
        quoteIdentifier(spec.idColumn),
        ...payload.map(quoteIdentifier),
        ...vectors.map(quoteIdentifier),
      ].join(", ");
      const rows = source
        .prepare(`
          SELECT ${select}
            FROM ${quoteIdentifier(spec.table)}
           ORDER BY peer_updated_at DESC, ${quoteIdentifier(spec.idColumn)} DESC
           LIMIT ?`)
        .all(limit) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = safeString(row[spec.idColumn], 512);
        const updatedAt = safeInteger(row.peer_updated_at);
        if (!id || updatedAt === undefined) continue;
        const itemPayload = buildPayload(spec.kind, row);
        const itemVectors = buildVectors(spec.kind, row);
        candidates.push({
          kind: spec.kind,
          id,
          revision: revisionOf(updatedAt, itemPayload, itemVectors),
          updated_at: updatedAt,
          payload_json: JSON.stringify(itemPayload),
          vectors_json: JSON.stringify(itemVectors),
        });
      }
    }
    candidates.sort(compareCandidates);
  }

  private installReplicaSchema(db: StorageDb): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS peer_items (
        origin_node TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('trace','policy','world_model','skill')),
        id TEXT NOT NULL,
        revision TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        vectors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(vectors_json)),
        source_updated_at INTEGER NOT NULL,
        imported_at INTEGER NOT NULL,
        PRIMARY KEY (origin_node, kind, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS peer_vectors (
        origin_node TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        values_json TEXT NOT NULL CHECK (json_valid(values_json)),
        PRIMARY KEY (origin_node, kind, item_id, slot, model)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS peer_items_fts USING fts5(
        origin_node UNINDEXED,
        kind UNINDEXED,
        item_id UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS peer_items_ai AFTER INSERT ON peer_items BEGIN
        INSERT INTO peer_items_fts(origin_node, kind, item_id, text)
        VALUES (new.origin_node, new.kind, new.id, new.payload_json);
      END;
      CREATE TRIGGER IF NOT EXISTS peer_items_au AFTER UPDATE ON peer_items BEGIN
        DELETE FROM peer_items_fts
         WHERE origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
        INSERT INTO peer_items_fts(origin_node, kind, item_id, text)
        VALUES (new.origin_node, new.kind, new.id, new.payload_json);
      END;
      CREATE TRIGGER IF NOT EXISTS peer_items_ad AFTER DELETE ON peer_items BEGIN
        DELETE FROM peer_items_fts
         WHERE origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
        DELETE FROM peer_vectors
         WHERE origin_node = old.origin_node AND kind = old.kind AND item_id = old.id;
      END;
      CREATE INDEX IF NOT EXISTS idx_peer_items_origin ON peer_items(origin_node, kind, id);
      CREATE INDEX IF NOT EXISTS idx_peer_vectors_lookup ON peer_vectors(model, dimension);
    `);
  }
}

function validatePage(
  page: unknown,
  expectedNodeId: string,
  localNodeId: string,
): { originNode: string; items: Array<PeerSyncItem & { sourceUpdatedAt: number }> } {
  if (!page || typeof page !== "object" || Array.isArray(page)) throw new TypeError("Invalid peer page");
  const raw = page as Record<string, unknown>;
  if (raw.protocol !== PEER_SYNC_PROTOCOL) throw new TypeError("Unsupported peer protocol");
  if (!validNodeId(expectedNodeId)) throw new TypeError("Expected peer node id is invalid");
  if (raw.nodeId !== expectedNodeId) throw new TypeError("Peer node id does not match");
  if (raw.nodeId === localNodeId) throw new TypeError("Peer page must originate from another node");
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
  return { originNode: expectedNodeId, items };
}

function buildPayload(kind: PeerSyncKind, row: Record<string, unknown>): Record<string, unknown> {
  const owner = {
    ownerAgentKind: safeString(row["owner_agent_kind"], 128) || "unknown",
    ownerProfileId: safeString(row["owner_profile_id"], 128) || "default",
    ownerWorkspaceId: safeString(row["owner_workspace_id"], 256) || null,
  };
  if (kind === "trace") {
    return wireRecord({
      summary: safeString(row["summary"], 2_000) || null,
      userText: safeString(row["user_text"], 2_000),
      agentText: safeString(row["agent_text"], 2_000),
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
      sourceEpisodeIds: safeJsonArray(row["source_episodes_json"]),
      sourceTraceIds: safeJsonArray(row["source_trace_ids_json"]),
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
      policyIds: safeJsonArray(row["policy_ids_json"]),
      sourceEpisodeIds: safeJsonArray(row["source_episodes_json"]),
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
    sourcePolicyIds: safeJsonArray(row["source_policies_json"]),
    sourceWorldModelIds: safeJsonArray(row["source_world_json"]),
    evidenceAnchors: safeJsonArray(row["evidence_anchors_json"]),
    createdAt: safeInteger(row["created_at"]),
    updatedAt: safeInteger(row["updated_at"]),
    version: safeInteger(row["version"]) ?? 1,
    editedAt: safeInteger(row["edited_at"]),
    ...owner,
  });
}

function buildVectors(kind: PeerSyncKind, row: Record<string, unknown>): PeerSyncVector[] {
  const out: PeerSyncVector[] = [];
  const slots = vectorColumns(kind);
  for (const slot of slots) {
    const vector = decodeVectorBlob(row[slot]);
    if (!vector) continue;
    out.push({
      slot: slot === "vec_summary" ? "summary" : slot === "vec_action" ? "action" : "content",
      model: "local-embedding",
      dimension: vector.length,
      values: vector,
    });
  }
  return out;
}

function vectorColumns(kind: PeerSyncKind): string[] {
  if (kind === "trace") return ["vec_summary", "vec_action"];
  return ["vec"];
}

function projectionColumns(columns: readonly string[], kind: PeerSyncKind): string[] {
  const blocked = new Set(["messages", "messages_json", "logs", "config", "raw_json"]);
  const vector = new Set(vectorColumns(kind));
  return columns.filter((column) => !blocked.has(column) && !vector.has(column));
}

function updatedExpressionFor(spec: TableSpec, available: ReadonlySet<string>): string | undefined {
  if (!available.has(spec.updatedColumn)) return undefined;
  const candidates = [spec.updatedColumn];
  if (spec.kind === "trace") {
    for (const column of ["edited_at", "created_at", "last_seen_at"]) {
      if (available.has(column)) candidates.push(column);
    }
  }
  if (candidates.length === 1) return quoteIdentifier(candidates[0]!);
  return `MAX(${candidates.map(quoteIdentifier).join(", ")})`;
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
      if (CREDENTIAL_KEY.test(key)) continue;
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

function safeJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    return safeStringArray(JSON.parse(value));
  } catch {
    return [];
  }
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

function compareCandidates(a: { updated_at: number; kind: PeerSyncKind; id: string }, b: { updated_at: number; kind: PeerSyncKind; id: string }): number {
  return a.updated_at - b.updated_at ||
    a.id.localeCompare(b.id) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

function encodeCursor(cursor: CursorState): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseCursor(raw: string | undefined): CursorState | undefined {
  if (!raw) return undefined;
  if (raw.length > 1_024) throw new TypeError("Peer cursor is too long");
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorState>;
    if (safeInteger(parsed.updatedAt) === undefined || !isKind(parsed.kind) || !safeString(parsed.id, 512)) {
      throw new Error("shape");
    }
    return {
      updatedAt: safeInteger(parsed.updatedAt)!,
      kind: parsed.kind,
      id: String(parsed.id),
      sweep: parsed.sweep === true,
    };
  } catch {
    throw new TypeError("Peer cursor is invalid");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
