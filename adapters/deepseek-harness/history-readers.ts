import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as zlib from "node:zlib";

export interface HistoryTurn {
  source: "codex" | "dsh";
  sessionId: string;
  turnKey: string;
  userText: string;
  agentText: string;
  ts: number;
  sourceRef: string;
  cwd?: string;
}

/**
 * Read-only local history adapters for the history worker.
 *
 * The reader intentionally returns only completed direct-human turns. It
 * never executes transcript content, and file/stream expansion is bounded
 * before parsing so a malformed or hostile session cannot exhaust memory.
 */

export const HISTORY_FILE_LIMIT = 64 * 1024 * 1024;
export const HISTORY_DECOMPRESSED_LIMIT = 128 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface CodexTurnDraft {
  sessionId: string;
  cwd?: string;
  userText?: string;
  userLine?: number;
  userTs?: number;
}

interface DshTurnDraft {
  sessionId: string;
  cwd?: string;
  turn: number;
  startedSeq?: number;
  startedLine?: number;
  userTexts: string[];
  userIds: Set<string>;
  assistantTexts: Array<{
    text: string;
    line: number;
    seq: number;
    time: number;
  }>;
}

export function parseCodexHistory(text: string, path: string): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let sessionId = sessionIdFromCodexPath(path);
  let cwd: string | undefined;
  let pending: CodexTurnDraft | undefined;
  const seenFinalIds = new Set<string>();
  const emitted = new Set<string>();

  forEachJsonLine(text, (record, line) => {
    if (record.type === "session_meta") {
      const payload = asRecord(record.payload);
      const id = stringValue(payload, "id") ?? stringValue(payload, "session_id");
      if (id) sessionId = id;
      cwd = stringValue(payload, "cwd") ?? cwd;
      return;
    }

    if (record.type === "response_item") {
      const payload = asRecord(record.payload);
      if (payload?.type !== "message") return;

      if (payload.role === "user") {
        const candidate = textFromCodexContent(payload.content, "input_text");
        if (!isHumanCodexText(candidate)) return;
        const request = extractWrappedHumanText(candidate) ?? candidate;
        pending = {
          sessionId,
          cwd,
          userText: request,
          userLine: line,
          userTs: timestampValue(record, payload),
        };
        return;
      }

      if (
        payload.role === "assistant"
        && payload.phase === "final_answer"
        && pending?.userText
      ) {
        const finalText = textFromCodexContent(payload.content, "output_text");
        if (!finalText) return;
        const finalId = stringValue(payload, "id")
          ?? `${line}:${stableHash(finalText)}`;
        if (seenFinalIds.has(finalId)) {
          pending = undefined;
          return;
        }
        seenFinalIds.add(finalId);
        const ts = timestampValue(record, payload) ?? pending.userTs ?? 0;
        const dedupeKey = codexTurnDedupeKey(pending.userText, finalText);
        if (emitted.has(dedupeKey)) {
          pending = undefined;
          return;
        }
        emitted.add(dedupeKey);
        turns.push({
          source: "codex",
          sessionId: pending.sessionId,
          turnKey: turnKey("codex", pending.sessionId, pending.userLine!, pending.userText),
          userText: pending.userText,
          agentText: finalText,
          ts,
          sourceRef: `${path}:${line}`,
          ...(pending.cwd ? { cwd: pending.cwd } : {}),
        });
        pending = undefined;
        return;
      }

      if (payload.role === "assistant" && payload.phase === "commentary") return;
      return;
    }

    if (record.type === "event_msg") {
      const payload = asRecord(record.payload);
      if (payload?.type === "user_message") {
        const candidate = eventMessageText(payload);
        if (!isHumanCodexText(candidate)) return;
        const request = extractWrappedHumanText(candidate) ?? candidate;
        // Legacy user_message events mirror response_item user messages in
        // newer rollouts. Do not create a second draft when the same prompt
        // is already pending.
        if (pending?.userText === request) return;
        pending = {
          sessionId,
          cwd,
          userText: request,
          userLine: line,
          userTs: timestampValue(record, payload),
        };
        return;
      }

      if (payload?.type === "agent_message" && pending?.userText) {
        const finalText = eventMessageText(payload);
        if (!finalText) return;
        const key = stringValue(payload, "id")
          ?? `event:${pending.userLine}:${stableHash(finalText)}`;
        if (seenFinalIds.has(key)) {
          pending = undefined;
          return;
        }
        seenFinalIds.add(key);
        const ts = timestampValue(record, payload) ?? pending.userTs ?? 0;
        const dedupeKey = codexTurnDedupeKey(pending.userText, finalText);
        if (emitted.has(dedupeKey)) {
          pending = undefined;
          return;
        }
        emitted.add(dedupeKey);
        turns.push({
          source: "codex",
          sessionId: pending.sessionId,
          turnKey: turnKey("codex", pending.sessionId, pending.userLine!, pending.userText),
          userText: pending.userText,
          agentText: finalText,
          ts,
          sourceRef: `${path}:${line}`,
          ...(pending.cwd ? { cwd: pending.cwd } : {}),
        });
        pending = undefined;
      }
    }
  });

  return turns;
}

export function parseDshHistory(text: string, path: string): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let sessionId = sessionIdFromDshPath(path);
  let cwd: string | undefined;
  let active: DshTurnDraft | undefined;
  let usable = false;

  forEachJsonLine(text, (record, line) => {
    if (record.type === "session") {
      if (isSeededDshSession(record)) {
        active = undefined;
        cwd = undefined;
        usable = false;
        return;
      }
      usable = true;
      sessionId = stringValue(record, "id") ?? sessionId;
      cwd = stringValue(record, "cwd") ?? cwd;
      return;
    }
    if (!usable) return;

    if (record.type === "turn/start") {
      const data = asRecord(record.data);
      const turn = numberValue(data, "turn");
      if (turn === undefined) return;
      active = {
        sessionId,
        cwd,
        turn,
        startedSeq: numberValue(record, "seq"),
        startedLine: line,
        userTexts: [],
        userIds: new Set<string>(),
        assistantTexts: [],
      };
      return;
    }

    if (record.type === "user/message" && active) {
      const data = asRecord(record.data);
      const message = asRecord(data?.message) ?? data;
      const source = asRecord(message?.source);
      if (source?.kind !== "user" || message?.role !== "user") return;
      const text = textFromDshContent(message.content, "text");
      if (!text) return;
      const id = stringValue(message, "id");
      if (id && active.userIds.has(id)) return;
      if (id) active.userIds.add(id);
      active.userTexts.push(text);
      return;
    }

    if (record.type === "assistant/message" && active) {
      const data = asRecord(record.data);
      const turn = numberValue(data, "turn");
      if (turn !== active.turn) return;
      const message = asRecord(data?.message);
      if (!message) return;
      const content = Array.isArray(message.content) ? message.content : [];
      const hasToolCall = content.some((block) => asRecord(block)?.type === "tool-call");
      if (hasToolCall) return;
      const text = textFromDshContent(content, "text");
      if (!text) return;
      active.assistantTexts.push({
        text,
        line,
        seq: numberValue(record, "seq") ?? 0,
        time: normalizeTimestamp(numberValue(record, "time")) ?? 0,
      });
      return;
    }

    if (record.type === "turn/end" && active) {
      const data = asRecord(record.data);
      const turn = numberValue(data, "turn");
      if (turn !== active.turn || !isCompletedTurnEnd(data?.reason)) return;

      const userText = active.userTexts.join("\n\n").trim();
      const final = active.assistantTexts[active.assistantTexts.length - 1];
      if (userText && final?.text) {
        turns.push({
          source: "dsh",
          sessionId: active.sessionId,
          turnKey: turnKey("dsh", active.sessionId, active.startedSeq ?? active.startedLine!, userText),
          userText,
          agentText: final.text,
          ts: final.time || normalizeTimestamp(numberValue(record, "time")) || 0,
          sourceRef: `${path}:${final.line}`,
          ...(active.cwd ? { cwd: active.cwd } : {}),
        });
      }
      active = undefined;
    }
  });

  return turns;
}

export async function readHistoryFile(
  path: string,
  source: "codex" | "dsh",
): Promise<HistoryTurn[]> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`History path ${path} is not a regular file.`);
  }
  if (info.size > HISTORY_FILE_LIMIT) {
    throw new Error(
      `History file ${path} is ${info.size} bytes; the 64 MiB input limit was exceeded.`,
    );
  }

  const compressed = source === "dsh" && isZstdPath(path);
  const text = compressed
    ? await readZstdJsonl(path, info.size)
    : await readUtf8Bounded(path, HISTORY_DECOMPRESSED_LIMIT);
  return source === "codex"
    ? parseCodexHistory(text, path)
    : parseDshHistory(text, path);
}

function forEachJsonLine(
  text: string,
  visitor: (record: JsonRecord, line: number) => void,
): void {
  let offset = 0;
  let line = 0;
  while (offset < text.length) {
    line += 1;
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const raw = text.slice(offset, end).replace(/\r$/, "");
    offset = newline === -1 ? text.length : newline + 1;
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      const record = asRecord(value);
      if (record) visitor(record, line);
    } catch {
      // A partially written trailing row must not discard completed turns.
    }
  }
}

async function readUtf8Bounded(path: string, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error(`History input for ${path} exceeded its read limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readZstdJsonl(
  path: string,
  fileBytes: number,
): Promise<string> {
  const compressed = await readBounded(path, Math.min(fileBytes, HISTORY_FILE_LIMIT));
  if (typeof zlib.createZstdDecompress !== "function") {
    throw zstdUnavailable(path);
  }
  return decompressConcatenatedZstd(compressed, path);
}

async function decompressConcatenatedZstd(
  compressed: Buffer,
  path: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = 0;

  while (offset < compressed.length) {
    const remaining = HISTORY_DECOMPRESSED_LIMIT - total;
    if (remaining <= 0) {
      throw new Error(
        `Decompressed history for ${path} exceeded the 128 MiB limit.`,
      );
    }
    const decoder = zlib.createZstdDecompress({
      maxOutputLength: remaining,
    });
    let consumed = 0;
    const output: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > HISTORY_DECOMPRESSED_LIMIT) {
          callback(new Error(
            `Decompressed history for ${path} exceeded the 128 MiB limit.`,
          ));
          return;
        }
        output.push(buffer);
        callback();
      },
    });
    const source = new Readable({
      read() {
        if (consumed >= compressed.length - offset) {
          this.push(null);
          return;
        }
        const chunk = compressed.subarray(offset + consumed, offset + consumed + 64 * 1024);
        consumed += chunk.length;
        this.push(chunk);
      },
    });
    await new Promise<void>((resolve, reject) => {
      source.once("error", reject);
      decoder.once("error", reject);
      sink.once("error", reject);
      sink.once("finish", resolve);
      source.pipe(decoder).pipe(sink);
    });
    chunks.push(...output);
    const frameBytes = decoder.bytesWritten;
    if (frameBytes <= 0) {
      throw new Error(`History file ${path} contains an invalid zstd stream.`);
    }
    offset += frameBytes;
  }

  return Buffer.concat(chunks, total).toString("utf8");
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw new Error(`History input ${path} exceeded the 64 MiB limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function zstdUnavailable(path: string): Error {
  return new Error(
    `Reading ${path} requires a Node runtime with node:zlib zstd support.`,
  );
}

function isZstdPath(path: string): boolean {
  return /\.zst(?:d)?$/i.test(path);
}

function textFromCodexContent(value: unknown, type: string): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const block = asRecord(item);
      return block?.type === type && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function textFromDshContent(value: unknown, type: string): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const block = asRecord(item);
      return block?.type === type && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function eventMessageText(payload: JsonRecord): string {
  const message = payload.message;
  if (typeof message === "string") return message.trim();
  const text = payload.text;
  return typeof text === "string" ? text.trim() : "";
}

function isHumanCodexText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (isCompactionContinuation(value)) return false;
  if (/^# AGENTS\.md instructions\b/i.test(value)) return false;
  if (/^#\s*(?:Mira|AGENTS)(?=\s|$)/i.test(value)) return false;
  if (/^#\s*project-doc\b/i.test(value)) return false;
  if (/^Another language model started to solve this problem\b/i.test(value)) return false;
  if (/^<environment_context>/i.test(value)) return false;
  if (/^<codex_apps_client_time_context>/i.test(value)) return false;
  if (/^<codex_apps_open_page_instructions>/i.test(value)) return false;
  if (/^<external_codex_apps_open_page>/i.test(value)) return false;
  if (/^<codex_internal_context\b/i.test(value)) return false;
  if (/^<compaction\b/i.test(value)) return false;
  if (/^<(?:tool|tool_output|function_call_output)\b/i.test(value)) return false;
  return true;
}

function isCompactionContinuation(value: string): boolean {
  return /^Another language model started to solve this problem\b/i.test(value)
    || /^Another model has already been working on this task\b/i.test(value)
    || /^The conversation so far has been compacted\b/i.test(value)
    || /^Summary of the conversation so far\b/i.test(value);
}

function extractWrappedHumanText(value: string): string | undefined {
  return value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, "")
    .replace(/<subagent_notification\b[^>]*>[\s\S]*?<\/subagent_notification>/gi, "")
    .replace(
      /<send_user_message_question_reply\b[^>]*>[\s\S]*?<\/send_user_message_question_reply>/gi,
      "",
    )
    .trim() || undefined;
}

function isCompletedTurnEnd(reason: unknown): boolean {
  const value = asRecord(reason);
  return value?.kind === "completed";
}

function isSeededDshSession(header: JsonRecord): boolean {
  if (header.isSeeded === true) return true;
  const depth = numberValue(header, "delegationDepth");
  return depth !== undefined && depth > 0;
}

function timestampValue(...records: unknown[]): number | undefined {
  for (const record of records) {
    const value = asRecord(record);
    const raw = value?.timestamp ?? value?.ts ?? value?.time;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return normalizeTimestamp(raw);
    }
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeTimestamp(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function sessionIdFromCodexPath(path: string): string {
  const name = basename(path);
  const match = name.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? name.replace(/\.jsonl$/i, "");
}

function sessionIdFromDshPath(path: string): string {
  const parent = basename(dirname(path));
  return parent || basename(path).replace(/\.(?:jsonl\.)?zst(?:d)?$/i, "");
}

function turnKey(
  source: "codex" | "dsh",
  sessionId: string,
  position: number,
  userText: string,
): string {
  return `${source}:${sessionId}:${position}:${stableHash(userText).slice(0, 16)}`;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function codexTurnDedupeKey(userText: string, agentText: string): string {
  return stableHash(`${userText}\u0000${agentText}`);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
