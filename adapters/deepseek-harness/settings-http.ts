import type { MemorySettingsApi } from "./settings.js";
import { MemosError } from "../../agent-contract/errors.js";

export const DSH_MEMORY_PATHS = ["/api/memos/settings", "/api/memos/test", "/api/memos/embedding-test"];

export async function handleMemorySettingsRequest(api: MemorySettingsApi, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.split("/").pop();
  const respond = (status: number, value: unknown) => new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
  try {
    if (action === "settings" && request.method === "GET") return respond(200, await api.snapshot());
    // DSH authenticates owner peers and validates browser Host/Origin before
    // dispatch. Its Request URL uses dsh.internal, not the page's origin.
    if (action === "settings" && request.method === "PUT") return respond(200, await api.save(await request.json()));
    if (action === "test" && request.method === "POST") return respond(200, await api.test(await request.json(), request.signal));
    if (action === "embedding-test" && request.method === "POST") return respond(200, await api.testEmbedding());
    return respond(405, { error: { message: "Method not allowed" } });
  } catch (error) {
    if (error instanceof SyntaxError) return respond(400, { error: { message: "Invalid settings JSON" } });
    if (MemosError.is(error) && error.code === "invalid_argument") {
      return respond(400, { error: { message: error.message } });
    }
    if (MemosError.is(error) && error.code === "llm_timeout") {
      return respond(504, { error: { message: "DSH model operation timed out" } });
    }
    const status = (error as NodeJS.ErrnoException)?.code?.startsWith("E") ? 500 : 502;
    // Provider errors can include request headers; never forward credentials to a client.
    return respond(status, { error: { message: "Memory model operation failed. Check the selected DSH model and plugin logs." } });
  }
}

export interface SettingsConnectionContext {
  inject(deps: string[], apply: (ctx: {
    connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: "buffered";
      fetch(request: Request): Promise<Response> }): () => void } };
    effect(effect: () => () => void, label?: string): unknown;
  }) => void): unknown;
}

export function registerMemorySettingsHttp(ctx: SettingsConnectionContext, api: MemorySettingsApi): void {
  ctx.inject(["connection"], child => {
    for (const path of DSH_MEMORY_PATHS) child.effect(() => child.connection.fetch.register({
      path, methods: path.endsWith("/settings") ? ["GET", "PUT"] : ["POST"],
      requestBody: "buffered", fetch: request => handleMemorySettingsRequest(api, request),
    }), `memos: ${path}`);
  });
}
