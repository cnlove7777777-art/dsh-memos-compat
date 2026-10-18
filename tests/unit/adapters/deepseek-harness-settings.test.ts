import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRetryPolicy, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { MemoryCore } from "../../../agent-contract/memory-core.js";
import { DEFAULT_CONFIG } from "../../../core/config/defaults.js";
import { HostLlmProvider } from "../../../core/llm/providers/host.js";
import { registerHostLlmBridge } from "../../../core/llm/host-bridge.js";
import { configureDshManagedModels, DshMemorySettings, type DshModelRegistry } from "../../../adapters/deepseek-harness/settings.js";
import { createDeepSeekHarnessHostLlmBridge, DeepSeekHarnessLlmRouteContext } from "../../../adapters/deepseek-harness/host-llm.js";
import { handleMemorySettingsRequest, registerMemorySettingsHttp } from "../../../adapters/deepseek-harness/settings-http.js";

const homes: string[] = [];
afterEach(async () => { registerHostLlmBridge(null); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function setup(enabled = true) {
  const home = await mkdtemp(join(tmpdir(), "memos-dsh-settings-")); homes.push(home);
  const calls: Array<{ provider: string; model: string }> = [];
  const llm: DshModelRegistry = {
    listProviders: () => [{ id: "local", name: "DSH local" }],
    listModels: async () => [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    prepareCall: async config => ({ config, adapterDefaults: {}, retryPolicy: resolveRetryPolicy(undefined, "test"),
      stream: async function* () {
        calls.push({ provider: config.provider, model: config.model });
        yield { type: "text-delta", index: 0, text: "OK" } as StreamChunk;
        yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
      } }),
  };
  const routes = new DeepSeekHarnessLlmRouteContext();
  const core = { health: async () => ({ embedder: { provider: "local", model: "MiniLM", dim: 384, available: true } }),
    probeEmbedding: vi.fn(async () => ({ ok: true, dimensions: 384, latencyMs: 1 })) } as unknown as MemoryCore;
  const makeSettings = () => new DshMemorySettings({ home, enabled, llm, routes, core: () => core });
  const settings = makeSettings(); await settings.load();
  const bridge = createDeepSeekHarnessHostLlmBridge({ llm, routes, resolveRoute: () => settings.route() });
  return { home, settings, makeSettings, core, calls, llm, routes, bridge };
}

describe("DSH memory model settings", () => {
  it("saves only a memory route, enables immediately, and restores it on restart", async () => {
    const f = await setup(false);
    await expect(f.bridge.complete({ messages: [] })).rejects.toThrow(/Save a memory model/);
    await f.settings.save({ mode: "fixed", provider: "local", model: "b", apiKey: "must-not-persist" });
    registerHostLlmBridge(f.bridge);
    const config = configureDshManagedModels(DEFAULT_CONFIG);
    await new HostLlmProvider().complete([{ role: "user", content: "extract" }], {}, { config: config.llm, signal: new AbortController().signal });
    expect(f.calls).toEqual([{ provider: "local", model: "b" }]);
    const fresh = f.makeSettings(); await fresh.load();
    expect(fresh.route()).toMatchObject({ provider: "local", model: "b" });
    const text = await readFile(join(f.home, "dsh-model.json"), "utf8");
    expect(text).not.toContain("apiKey"); expect(text).not.toContain("must-not-persist");
    expect(config.skillEvolver.provider).toBe("host"); expect(config.l3Llm.provider).toBe("host");
  });

  it("follows each owning conversation with no global last-model fallback", async () => {
    const f = await setup();
    await Promise.all(["a", "b"].map(model => f.routes.run({ provider: "local", model }, async () => {
      await Promise.resolve(); return f.bridge.complete({ messages: [] });
    })));
    expect(f.calls.map(call => call.model).sort()).toEqual(["a", "b"]);
    await expect(f.bridge.complete({ messages: [] })).rejects.toThrow(/no active/);
  });

  it("tests an unsaved model without redirecting memory work or changing the follow selection", async () => {
    const f = await setup();
    await f.settings.save({ mode: "fixed", provider: "local", model: "a" });
    await f.settings.test({ mode: "fixed", provider: "local", model: "b" });
    await f.bridge.complete({ messages: [] });
    expect(f.calls.map(call => call.model)).toEqual(["b", "a"]);
    await f.settings.save({ mode: "follow" });
    await expect(f.settings.test({ mode: "follow" })).rejects.toThrow();
    await f.settings.test({ mode: "follow", testProvider: "local", testModel: "b" });
    expect((await f.settings.snapshot()).selection).toEqual({ mode: "follow" });
    expect(f.settings.route()).toBeUndefined();
  });

  it("rejects an unavailable model without overwriting a saved working selection", async () => {
    const f = await setup();
    await f.settings.save({ mode: "fixed", provider: "local", model: "a" });
    await expect(f.settings.save({ mode: "fixed", provider: "local", model: "removed" })).rejects.toThrow(/catalog/);
    expect(f.settings.route()?.model).toBe("a");
    await writeFile(join(f.home, "dsh-model.json"), "{broken");
    const corrupt = f.makeSettings();
    await corrupt.load();
    expect(await corrupt.snapshot()).toMatchObject({ enabled: false, warning: expect.any(String) });
    await corrupt.save({ mode: "follow" });
    expect(await corrupt.snapshot()).toMatchObject({ enabled: true, warning: undefined });
  });

  it("preserves the committed write order and reads embedding status from the active core", async () => {
    const f = await setup();
    await Promise.all(["a", "b"].map(model => f.settings.save({ mode: "fixed", provider: "local", model })));
    expect(f.settings.route()?.model).toBe("b");
    expect((await f.settings.snapshot()).embedding.dimension).toBe(384);
    expect(await f.settings.testEmbedding()).toMatchObject({ dimensions: 384 });
    expect(f.core.probeEmbedding).toHaveBeenCalledOnce();
  });

  it("accepts DSH's internal request authority and never returns provider error secrets", async () => {
    const f = await setup();
    const post = (origin: string) => new Request("http://dsh.internal/api/memos/settings", {
      method: "PUT", headers: { Origin: origin }, body: JSON.stringify({ mode: "follow" }),
    });
    expect((await handleMemorySettingsRequest(f.settings, post("http://localhost"))).status).toBe(200);
    f.llm.listModels = async () => { throw new Error("Authorization: Bearer secret"); };
    const response = await handleMemorySettingsRequest(f.settings, new Request("http://localhost/api/memos/test", {
      method: "POST", body: JSON.stringify({ mode: "fixed", provider: "local", model: "a" }),
    }));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("secret");
  });

  it("owns the native HTTP registrations through the child context effect lifecycle", async () => {
    const f = await setup(); const dispose = vi.fn(); const register = vi.fn(() => dispose);
    const releases: Array<() => void> = [];
    registerMemorySettingsHttp({ inject: (_deps, apply) => apply({
      connection: { fetch: { register } }, effect: effect => { releases.push(effect()); },
    }) }, f.settings);
    expect(register).toHaveBeenCalledTimes(5);
    releases.forEach(release => release()); expect(dispose).toHaveBeenCalledTimes(5);
  });
});
