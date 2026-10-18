import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryMcpHandler,
  type MemoryMcpHandler,
} from "../../../adapters/deepseek-harness/mcp.js";

const TOKEN = "test-mcp-bearer-token";
const LOOPBACK_ORIGIN = "http://localhost:18801";

let server: Server;
let baseUrl: string;
let port: number;
let search: ReturnType<typeof vi.fn>;
let fetchMemory: ReturnType<typeof vi.fn>;
let handler: MemoryMcpHandler;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Origin: LOOPBACK_ORIGIN,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function post(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: headers(extraHeaders),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rawPost(
  body: unknown,
  extraHeaders: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        ...headers(extraHeaders),
        "Content-Length": String(Buffer.byteLength(text)),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

beforeAll(async () => {
  search = vi.fn(async (query: string, limit: number, signal?: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return {
      text: `Found 1 memory for "${query}".`,
      query,
      limit,
      hits: [{
        refKind: "trace",
        refId: "trace-test-1",
        snippet: "Synthetic test memory.",
        score: 0.9,
      }],
    };
  });
  fetchMemory = vi.fn(async (id: string, signal?: AbortSignal) => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return {
      text: `Memory ${id}`,
      found: true,
      id,
      body: "Synthetic memory body.",
    };
  });
  handler = createMemoryMcpHandler({
    token: TOKEN,
    search,
    fetch: fetchMemory,
  });
  server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind a TCP address");
  }
  port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  search.mockClear();
  fetchMemory.mockClear();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

describe("DSH memory MCP handler", () => {
  it("initializes with protocol negotiation and advertises tools", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as {
      result: {
        protocolVersion: string;
        capabilities: { tools: Record<string, unknown> };
        serverInfo: { name: string };
      };
    };
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toEqual({});
    expect(body.result.serverInfo.name).toBe("memos-local-memory");
  });

  it("negotiates down to the latest supported protocol version", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: "init-2",
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("accepts initialized notifications with 202 and no body", async () => {
    const response = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("lists only the two read-only memory tools", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { required?: string[] };
          annotations: {
            readOnlyHint: boolean;
            destructiveHint: boolean;
          };
        }>;
      };
    };
    expect(body.result.tools.map(tool => tool.name)).toEqual([
      "memory_search",
      "memory_get",
    ]);
    for (const tool of body.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.inputSchema.required).toHaveLength(1);
    }
  });

  it("calls memory_search with bounded arguments and structured content", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "  concise answer  ", limit: 3 },
      },
    });

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(
      "concise answer",
      3,
      expect.any(AbortSignal),
    );
    const body = await response.json() as {
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: { query: string; limit: number; hits: unknown[] };
      };
    };
    expect(body.result.content[0]).toEqual({
      type: "text",
      text: 'Found 1 memory for "concise answer".',
    });
    expect(body.result.structuredContent).toMatchObject({
      query: "concise answer",
      limit: 3,
      hits: [expect.objectContaining({ refId: "trace-test-1" })],
    });
  });

  it("calls memory_get with a validated id", async () => {
    const response = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "memory_get",
        arguments: { id: "trace-test-1" },
      },
    });

    expect(response.status).toBe(200);
    expect(fetchMemory).toHaveBeenCalledWith(
      "trace-test-1",
      expect.any(AbortSignal),
    );
    const body = await response.json() as {
      result: {
        content: Array<{ text: string }>;
        structuredContent: { found: boolean; id: string };
      };
    };
    expect(body.result.content[0]?.text).toBe("Memory trace-test-1");
    expect(body.result.structuredContent).toMatchObject({
      found: true,
      id: "trace-test-1",
    });
  });

  it("authenticates before parsing the request body or executing tools", async () => {
    const missing = await post("{", { Authorization: "" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "must not run" },
      },
    }, { Authorization: "Bearer wrong-token" });
    expect(wrong.status).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects foreign Origins and non-loopback Host authorities", async () => {
    const foreignOrigin = await post({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/list",
    }, { Origin: "http://example.com" });
    expect(foreignOrigin.status).toBe(403);

    const invalidHost = await rawPost({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
    }, { Host: "example.com" });
    expect(invalidHost.status).toBe(403);
    expect(invalidHost.body).not.toContain(TOKEN);
  });

  it("rejects batches and unsupported protocol headers", async () => {
    const batch = await post([{
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
    }]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({
      error: { code: -32600 },
    });

    const protocol = await post({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/list",
    }, { "MCP-Protocol-Version": "2099-01-01" });
    expect(protocol.status).toBe(400);
    expect(await protocol.json()).toMatchObject({
      error: { code: "unsupported_protocol" },
    });
  });

  it("rejects request bodies over 64 KiB before tool execution", async () => {
    const response = await post("x".repeat(64 * 1024 + 1));

    expect(response.status).toBe(413);
    expect(search).not.toHaveBeenCalled();
    expect(fetchMemory).not.toHaveBeenCalled();
  });

  it("rejects invalid tool input without executing the callback", async () => {
    const cases = [
      {
        name: "memory_search",
        arguments: { query: "   " },
      },
      {
        name: "memory_search",
        arguments: { query: "valid", limit: 0 },
      },
      {
        name: "memory_search",
        arguments: { query: "valid", unexpected: true },
      },
      {
        name: "memory_get",
        arguments: { id: "" },
      },
    ];

    for (const [index, params] of cases.entries()) {
      const response = await post({
        jsonrpc: "2.0",
        id: 10 + index,
        method: "tools/call",
        params,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        error: { code: -32602 },
      });
    }
    expect(search).not.toHaveBeenCalled();
    expect(fetchMemory).not.toHaveBeenCalled();
  });

  it("does not execute tools/call when its id is omitted", async () => {
    const response = await post({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "notification must not execute" },
      },
    });

    expect(response.status).toBe(202);
    expect(search).not.toHaveBeenCalled();
  });

  it("returns stable safe tool errors without callback details", async () => {
    search.mockRejectedValueOnce(
      new Error("Authorization: Bearer must-not-leak"),
    );
    const response = await post({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "memory_search",
        arguments: { query: "failure path" },
      },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("must-not-leak");
    expect(JSON.parse(text)).toMatchObject({
      result: {
        content: [{ type: "text", text: "Memory search failed." }],
        structuredContent: {
          error: { code: "failed", message: "Memory search failed." },
        },
        isError: true,
      },
    });
  });

  it("returns 405 for GET because it has no SSE stream", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: headers(),
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
