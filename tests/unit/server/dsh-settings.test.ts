import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer } from "../../../server/http.js";
import type { ServerHandle } from "../../../server/types.js";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";

let server: ServerHandle | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe("embedded DSH Viewer settings HTTP boundary", () => {
  it("accepts actual page authority, rejects foreign writes, and preserves error status", async () => {
    server = await startHttpServer({ core: {} as MemoryCore, dshSettings: {
      snapshot: async () => ({ selection: { mode: "follow" } }),
      save: async value => value,
      test: async () => { throw new Error("provider failed: Authorization Bearer secret"); },
      testEmbedding: async () => ({ ok: true, dimensions: 384 }),
    } });
    const headers = { Origin: server.url, "Content-Type": "application/json" };
    const saved = await fetch(server.url + "/api/v1/dsh/settings", {
      method: "PUT", headers, body: JSON.stringify({ mode: "follow" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ mode: "follow" });
    const evil = await fetch(server.url + "/api/v1/dsh/embedding-test", {
      method: "POST", headers: { Origin: "https://foreign.invalid" },
    });
    expect(evil.status).toBe(403);
    const probe = await fetch(server.url + "/api/v1/dsh/test", { method: "POST", headers, body: "{}" });
    expect(probe.status).toBe(502); expect(await probe.text()).not.toContain("secret");
    const malformed = await fetch(server.url + "/api/v1/dsh/settings", { method: "PUT", headers, body: "{" });
    expect(malformed.status).toBe(400);
  });
});
