/**
 * Authenticated, read-only MCP endpoint for the DSH Viewer.
 *
 * This handler deliberately owns no listener, session store, process, or
 * database. DSH mounts it on its existing loopback HTTP server.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export interface MemoryMcpHandlerOptions {
  token: string;
  search: (
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  fetch: (id: string, signal?: AbortSignal) => Promise<unknown>;
}

export type MemoryMcpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 2_000;
const MAX_MEMORY_ID_CHARS = 512;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_TOOL_TEXT_CHARS = 16_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;

const SERVER_NAME = "memos-local-memory";
const SERVER_VERSION = "2.0.16-dsh.3";
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

type JsonObject = Record<string, unknown>;
type RequestId = string | number;

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: RequestId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolTextContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolTextContent[];
  structuredContent: JsonObject;
  isError?: true;
}

interface ToolDefinition {
  name: "memory_search" | "memory_get";
  title: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
  annotations: {
    title: string;
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: "memory_search",
    title: "Search memory",
    description:
      "Search long-term MemOS memory across prior traces, policies, world models, and skills. " +
      "This tool is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MAX_QUERY_CHARS,
          description: "A concise free-text memory query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          default: DEFAULT_SEARCH_LIMIT,
          description: "Maximum number of memory results.",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    annotations: {
      title: "Search memory",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "memory_get",
    title: "Get memory",
    description:
      "Fetch one bounded MemOS memory item by its id. This tool is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MEMORY_ID_CHARS,
          description: "Memory item id.",
        },
      },
      required: ["id"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
    },
    annotations: {
      title: "Get memory",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

class BodyTooLargeError extends HttpFailure {
  constructor() {
    super(413, "body_too_large", "Request body exceeds 64 KiB.");
  }
}

class ClientAbortedError extends Error {}

class ToolTimeoutError extends Error {}

class ToolAbortedError extends Error {}

export function createMemoryMcpHandler(
  options: MemoryMcpHandlerOptions,
): MemoryMcpHandler {
  if (!options || typeof options !== "object") {
    throw new TypeError("MCP options are required");
  }
  if (
    typeof options.token !== "string" ||
    !options.token ||
    options.token !== options.token.trim() ||
    /\s/.test(options.token)
  ) {
    throw new TypeError("MCP token must be a non-empty bearer token");
  }
  if (typeof options.search !== "function") {
    throw new TypeError("MCP search callback is required");
  }
  if (typeof options.fetch !== "function") {
    throw new TypeError("MCP fetch callback is required");
  }

  const expectedTokenDigest = digestToken(options.token);

  return async (req, res) => {
    try {
      await handleRequest(req, res, options, expectedTokenDigest);
    } catch (error) {
      if (error instanceof ClientAbortedError) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      if (error instanceof HttpFailure) {
        writeHttpFailure(req, res, error);
        return;
      }
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        } satisfies JsonRpcFailure);
        return;
      }
      res.destroy();
    }
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MemoryMcpHandlerOptions,
  expectedTokenDigest: Buffer,
): Promise<void> {
  if (!isAllowedHost(headerValue(req.headers.host))) {
    throw new HttpFailure(
      403,
      "forbidden",
      "Request Host is not a loopback authority.",
    );
  }
  if (!isAllowedOrigin(headerValue(req.headers.origin))) {
    throw new HttpFailure(
      403,
      "forbidden",
      "Request Origin is not allowed.",
    );
  }
  if (!isAuthorized(req, expectedTokenDigest)) {
    throw new HttpFailure(
      401,
      "unauthenticated",
      "A valid bearer token is required.",
      { "WWW-Authenticate": 'Bearer realm="memos-mcp"' },
    );
  }

  if (req.method !== "POST") {
    throw new HttpFailure(405, "method_not_allowed", "Only POST is supported.", {
      Allow: "POST",
    });
  }

  const protocolHeader = headerValue(req.headers["mcp-protocol-version"]);
  if (
    protocolHeader !== undefined &&
    !isSupportedProtocolVersion(protocolHeader)
  ) {
    throw new HttpFailure(
      400,
      "unsupported_protocol",
      "Unsupported MCP protocol version.",
    );
  }

  const contentType = headerValue(req.headers["content-type"]);
  if (contentType !== undefined && !isJsonContentType(contentType)) {
    throw new HttpFailure(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON" },
    } satisfies JsonRpcFailure);
    return;
  }

  if (Array.isArray(parsed)) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests are not supported" },
    } satisfies JsonRpcFailure);
    return;
  }
  if (!isJsonObject(parsed)) {
    writeJson(res, 400, invalidRequest());
    return;
  }

  if (
    parsed.jsonrpc !== "2.0" ||
    typeof parsed.method !== "string" ||
    parsed.method.length === 0 ||
    parsed.method.length > 128
  ) {
    writeJson(res, 400, invalidRequest());
    return;
  }

  const method = parsed.method;
  const hasId = Object.hasOwn(parsed, "id");
  if (!hasId) {
    // JSON-RPC notifications never receive a response body. Do not execute
    // request methods that accidentally omitted their id.
    writeAccepted(res);
    return;
  }

  const id = parsed.id;
  if (!isValidRequestId(id)) {
    writeJson(res, 400, invalidRequest());
    return;
  }

  const params = parsed.params;
  if (params !== undefined && !isJsonObject(params)) {
    writeJson(res, 200, rpcError(id, -32602, "params must be an object"));
    return;
  }
  const requestParams = params as JsonObject | undefined;

  if (method.startsWith("notifications/")) {
    writeAccepted(res);
    return;
  }

  if (method === "initialize") {
    const requested = requestParams?.["protocolVersion"];
    if (typeof requested !== "string" || !requested.trim()) {
      writeJson(
        res,
        200,
        rpcError(id, -32602, "protocolVersion must be a non-empty string"),
      );
      return;
    }
    const protocolVersion = isSupportedProtocolVersion(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    } satisfies JsonRpcSuccess);
    return;
  }

  if (method === "ping") {
    writeJson(res, 200, { jsonrpc: "2.0", id, result: {} } satisfies JsonRpcSuccess);
    return;
  }

  if (method === "tools/list") {
    const cursor = requestParams?.["cursor"];
    if (cursor !== undefined && typeof cursor !== "string") {
      writeJson(res, 200, rpcError(id, -32602, "cursor must be a string"));
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: { tools: MEMORY_TOOLS },
    } satisfies JsonRpcSuccess);
    return;
  }

  if (method === "tools/call") {
    const outcome = await handleToolCall(req, res, options, requestParams);
    if (outcome.kind === "error") {
      writeJson(res, 200, rpcError(id, outcome.code, outcome.message));
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: outcome.result,
    } satisfies JsonRpcSuccess);
    return;
  }

  writeJson(res, 200, rpcError(id, -32601, "Method not found"));
}

async function handleToolCall(
  req: IncomingMessage,
  res: ServerResponse,
  options: MemoryMcpHandlerOptions,
  params: JsonObject | undefined,
): Promise<
  | { kind: "success"; result: ToolResult }
  | { kind: "error"; code: number; message: string }
> {
  const name = params?.["name"];
  if (typeof name !== "string" || !name) {
    return { kind: "error", code: -32602, message: "Tool name is required" };
  }
  const args = params?.["arguments"] ?? {};
  if (!isJsonObject(args)) {
    return { kind: "error", code: -32602, message: "arguments must be an object" };
  }

  if (name === "memory_search") {
    const keys = validateArgumentKeys(args, ["query", "limit"]);
    if (keys) return { kind: "error", code: -32602, message: keys };
    const queryValue = args["query"];
    if (typeof queryValue !== "string" || !queryValue.trim()) {
      return {
        kind: "error",
        code: -32602,
        message: "query must be a non-empty string",
      };
    }
    const query = queryValue.trim();
    if (query.length > MAX_QUERY_CHARS) {
      return {
        kind: "error",
        code: -32602,
        message: `query must not exceed ${MAX_QUERY_CHARS} characters`,
      };
    }
    const limitValue = args["limit"];
    if (
      limitValue !== undefined &&
      (typeof limitValue !== "number" ||
        !Number.isInteger(limitValue) ||
        limitValue < 1 ||
        limitValue > MAX_SEARCH_LIMIT)
    ) {
      return {
        kind: "error",
        code: -32602,
        message: `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
      };
    }
    const limit = limitValue ?? DEFAULT_SEARCH_LIMIT;
    return {
      kind: "success",
      result: await invokeTool(
        req,
        res,
        signal => options.search(query, limit, signal),
        SEARCH_TIMEOUT_MS,
        "Memory search",
      ),
    };
  }

  if (name === "memory_get") {
    const keys = validateArgumentKeys(args, ["id"]);
    if (keys) return { kind: "error", code: -32602, message: keys };
    const idValue = args["id"];
    if (typeof idValue !== "string" || !idValue.trim()) {
      return {
        kind: "error",
        code: -32602,
        message: "id must be a non-empty string",
      };
    }
    const id = idValue.trim();
    if (id.length > MAX_MEMORY_ID_CHARS) {
      return {
        kind: "error",
        code: -32602,
        message: `id must not exceed ${MAX_MEMORY_ID_CHARS} characters`,
      };
    }
    return {
      kind: "success",
      result: await invokeTool(
        req,
        res,
        signal => options.fetch(id, signal),
        FETCH_TIMEOUT_MS,
        "Memory fetch",
      ),
    };
  }

  return {
    kind: "error",
    code: -32602,
    message: `Unknown tool: ${clip(name, 80)}`,
  };
}

async function invokeTool(
  req: IncomingMessage,
  res: ServerResponse,
  operation: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
  label: string,
): Promise<ToolResult> {
  const requestAbort = new AbortController();
  const onAborted = (): void => requestAbort.abort();
  const onClosed = (): void => {
    if (!res.writableEnded) requestAbort.abort();
  };
  req.once("aborted", onAborted);
  res.once("close", onClosed);

  try {
    const value = await invokeWithBounds(
      operation,
      requestAbort.signal,
      timeoutMs,
    );
    return successToolResult(value);
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      return toolFailure("timeout", `${label} timed out.`);
    }
    if (error instanceof ToolAbortedError) {
      return toolFailure("cancelled", `${label} was cancelled.`);
    }
    return toolFailure("failed", `${label} failed.`);
  } finally {
    req.removeListener("aborted", onAborted);
    res.removeListener("close", onClosed);
  }
}

async function invokeWithBounds<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (parentSignal.aborted) throw new ToolAbortedError();

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ToolTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });

  const abortFailure = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const error = new ToolAbortedError();
      controller.abort(error);
      reject(error);
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeoutFailure,
      abortFailure,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) {
      parentSignal.removeEventListener("abort", onAbort);
    }
  }
}

function successToolResult(value: unknown): ToolResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value === undefined ? null : value);
  } catch {
    return toolFailure("invalid_result", "Memory result could not be read.");
  }
  if (serialized === undefined) serialized = "null";
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES) {
    return toolFailure(
      "result_too_large",
      "Memory result exceeded the response limit.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return toolFailure("invalid_result", "Memory result could not be read.");
  }
  const structuredContent = isJsonObject(parsed) ? parsed : { result: parsed };
  const text = readableToolText(structuredContent);
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function toolFailure(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

function readableToolText(value: JsonObject): string {
  const text = value["text"];
  if (typeof text === "string" && text.trim()) {
    return clip(text, MAX_TOOL_TEXT_CHARS);
  }
  const hits = value["hits"];
  if (Array.isArray(hits)) {
    return hits.length === 0
      ? "No relevant memories found."
      : `Found ${hits.length} memories.`;
  }
  const serialized = JSON.stringify(value);
  return clip(serialized === "{}" ? "Memory result is empty." : serialized, MAX_TOOL_TEXT_CHARS);
}

function validateArgumentKeys(
  args: JsonObject,
  allowed: readonly string[],
): string | undefined {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(args).filter(key => !allowedSet.has(key));
  return unexpected.length === 0
    ? undefined
    : `Unexpected argument: ${clip(unexpected[0]!, 80)}`;
}

function isAuthorized(
  req: IncomingMessage,
  expectedTokenDigest: Buffer,
): boolean {
  const authorization = headerValue(req.headers.authorization);
  if (authorization === undefined) return false;
  const match = /^Bearer[ \t]+([^ \t]+)$/i.exec(authorization);
  if (!match) return false;
  const presented = digestToken(match[1]!);
  return presented.length === expectedTokenDigest.length &&
    timingSafeEqual(presented, expectedTokenDigest);
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function isAllowedHost(value: string | undefined): boolean {
  if (value === undefined || !value || value !== value.trim()) return false;
  if (value.includes(",") || /\s/.test(value)) return false;

  let hostname: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([^:]+))?$/.exec(value);
    if (!match) return false;
    hostname = match[1]!;
    port = match[2];
  } else {
    const firstColon = value.indexOf(":");
    const lastColon = value.lastIndexOf(":");
    if (firstColon !== lastColon) return false;
    hostname = firstColon === -1 ? value : value.slice(0, firstColon);
    port = firstColon === -1 ? undefined : value.slice(firstColon + 1);
  }

  if (!hostname || !isLoopbackHostname(hostname)) return false;
  if (port === undefined) return true;
  if (!/^\d+$/.test(port)) return false;
  const number = Number(port);
  return number >= 1 && number <= 65_535;
}

function isAllowedOrigin(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!value || value === "null" || value !== value.trim()) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    return false;
  }
  return isLoopbackHostname(url.hostname.replace(/^\[|\]$/g, ""));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost") return true;
  const version = isIP(normalized);
  if (version === 4) return normalized.startsWith("127.");
  return version === 6 && (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

function isSupportedProtocolVersion(value: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function isJsonContentType(value: string): boolean {
  return /^application\/(?:[a-z0-9.!#$&^_+-]+\+)?json(?:\s*;.*)?$/i.test(value);
}

function isValidRequestId(value: unknown): value is RequestId {
  return (
    typeof value === "number" && Number.isFinite(value)
  ) || (
    typeof value === "string" && value.length <= MAX_REQUEST_ID_CHARS
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = headerValue(req.headers["content-length"]);
  if (declared !== undefined) {
    if (!/^\d+$/.test(declared)) {
      throw new HttpFailure(400, "invalid_request", "Invalid Content-Length.");
    }
    if (Number(declared) > MAX_BODY_BYTES) throw new BodyTooLargeError();
  }

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        fail(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => fail(new ClientAbortedError());

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function invalidRequest(): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid JSON-RPC request" },
  };
}

function rpcError(
  id: RequestId,
  code: number,
  message: string,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function writeAccepted(res: ServerResponse): void {
  res.writeHead(202, BASE_HEADERS);
  res.end();
}

function writeHttpFailure(
  req: IncomingMessage,
  res: ServerResponse,
  failure: HttpFailure,
): void {
  writeJson(
    res,
    failure.status,
    {
      error: {
        code: failure.code,
        message: failure.message,
      },
    },
    failure.headers,
  );
  if (failure instanceof BodyTooLargeError) closeAfterResponse(req, res);
}

function closeAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  // A 413 is only useful if the client receives it before the socket closes.
  // Half-close the write side after the response flushes, then allow a short
  // grace period for unread request bytes before destroying the connection.
  const timer = setTimeout(() => {
    if (!req.destroyed) req.destroy();
  }, 1_000);
  timer.unref?.();
  res.once("finish", () => {
    res.socket?.end();
    req.resume();
  });
  res.once("close", () => clearTimeout(timer));
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
