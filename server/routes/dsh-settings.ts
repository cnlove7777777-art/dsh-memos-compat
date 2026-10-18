import type { ServerDeps } from "../types.js";
import type { Routes } from "./registry.js";
import { writeJson } from "../middleware/io.js";
import { DSH_MEMORY_PATHS, handleMemorySettingsRequest } from "../../adapters/deepseek-harness/settings-http.js";

export function registerDshSettingsRoutes(routes: Routes, deps: ServerDeps): void {
  if (!deps.dshSettings) return;
  const api = deps.dshSettings;
  for (const path of DSH_MEMORY_PATHS) {
    const viewerPath = path.replace("/api/memos/", "/api/v1/dsh/");
    const methods = /\/(settings|history)$/.test(path) ? ["GET", "PUT"] : ["POST"];
    for (const method of methods) routes.set(`${method} ${viewerPath}`, async ctx => {
      const origin = ctx.req.headers.origin;
      const authority = ctx.req.headers.host;
      if (method !== "GET" && origin && (!authority || new URL(origin).host !== authority)) {
        writeJson(ctx.res, 403, { error: { message: "Cross-origin memory settings writes are not allowed" } });
        return;
      }
      const headers = new Headers();
      if (typeof ctx.req.headers.origin === "string") headers.set("Origin", ctx.req.headers.origin);
      const response = await handleMemorySettingsRequest(api, new Request(new URL(path, ctx.url), {
        method, headers, ...(method === "GET" ? {} : { body: ctx.body.toString("utf8") }),
      }));
      ctx.res.setHeader("Cache-Control", "no-store");
      writeJson(ctx.res, response.status, await response.json());
    });
  }
}
