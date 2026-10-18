/** One memory-specific model selection shared by the native UI and Viewer. */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryCore } from "../../agent-contract/memory-core.js";
import type { ResolvedConfig } from "../../core/config/index.js";
import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type {
  DeepSeekHarnessLlmLike, DeepSeekHarnessLlmRoute,
  DeepSeekHarnessLlmRouteContext, DeepSeekHarnessHostLlmBridge,
} from "./host-llm.js";
import { createDeepSeekHarnessHostLlmBridge } from "./host-llm.js";

export type MemoryModelSelection = { mode: "follow" } | {
  mode: "fixed"; provider: string; model: string;
};

export interface DshModelRegistry extends DeepSeekHarnessLlmLike {
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name?: string }>>;
}

export interface MemorySettingsApi {
  history?: import("./history.js").HistoryApi;
  snapshot(): Promise<unknown>;
  save(value: unknown): Promise<unknown>;
  test(value: unknown, signal?: AbortSignal): Promise<unknown>;
  testEmbedding(): Promise<unknown>;
}

export function parseMemorySelection(value: unknown): MemoryModelSelection {
  if (!value || typeof value !== "object") throw new MemosError("invalid_argument", "A model selection is required");
  const raw = value as Record<string, unknown>;
  if (raw.mode === "follow") return { mode: "follow" };
  if (raw.mode !== "fixed" || typeof raw.provider !== "string" || !raw.provider.trim() ||
    typeof raw.model !== "string" || !raw.model.trim()) {
    throw new MemosError("invalid_argument", "Choose follow or a registered DSH provider and model");
  }
  return { mode: "fixed", provider: raw.provider.trim(), model: raw.model.trim() };
}

/** All memory LLM stages use the same DSH route and credential resolver. */
export function configureDshManagedModels(config: ResolvedConfig): ResolvedConfig {
  const host = <T extends { provider: string; model: string }>(slot: T): T => ({
    ...slot, provider: "host", model: "", endpoint: "", apiKey: "",
  });
  return Object.freeze({ ...config, llm: host(config.llm),
    l3Llm: host(config.l3Llm), skillEvolver: host(config.skillEvolver) });
}

export class DshMemorySettings implements MemorySettingsApi {
  history?: import("./history.js").HistoryApi;
  private selection: MemoryModelSelection = { mode: "follow" };
  private enabled: boolean;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private warning?: string;
  constructor(private readonly options: {
    home: string; enabled: boolean; llm: DshModelRegistry;
    routes: DeepSeekHarnessLlmRouteContext; core: () => MemoryCore;
    viewerUrl?: () => string | undefined;
  }) {
    this.enabled = options.enabled;
    this.path = join(options.home, "dsh-model.json");
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.path, "utf8"));
      if (raw.version !== 1) throw new Error("Unsupported DSH model settings version");
      this.selection = parseMemorySelection(raw.selection);
      this.enabled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Keep the original file for inspection. Settings remains available to repair it.
        this.enabled = false;
        this.warning = "Saved DSH memory model settings could not be read. Save a new selection to repair them.";
      }
    }
  }

  isEnabled(): boolean { return this.enabled; }
  configurationWarning(): string | undefined { return this.warning; }

  route(): DeepSeekHarnessLlmRoute | undefined {
    if (!this.enabled) throw new MemosError(ERROR_CODES.LLM_UNAVAILABLE,
      "Save a memory model selection in DSH settings to enable model-assisted memory");
    return this.selection.mode === "fixed" ? this.selection : this.options.routes.current();
  }

  private async models() {
    const rows: Array<{ provider: string; providerName: string; model: string; modelName: string }> = [];
    const failures: Array<{ provider: string; message: string }> = [];
    await Promise.all(this.options.llm.listProviders().map(async (provider) => {
      try {
        const models = await bounded(this.options.llm.listModels(provider.id), 10_000);
        for (const model of models) rows.push({ provider: provider.id, providerName: provider.name,
          model: model.id, modelName: model.name || model.id });
      } catch {
        failures.push({ provider: provider.id, message: "DSH model catalog unavailable" });
      }
    }));
    return { models: rows, failures };
  }

  async snapshot() {
    const [catalog, health] = await Promise.all([this.models(), this.options.core().health()]);
    return { selection: { ...this.selection }, enabled: this.enabled, warning: this.warning, ...catalog,
      embedding: { provider: health.embedder.provider, model: health.embedder.model,
        dimension: health.embedder.dim, status: health.embedder.available ? "ready" : "unavailable" },
      viewerUrl: this.options.viewerUrl?.() };
  }

  async validate(selection: MemoryModelSelection): Promise<void> {
    if (selection.mode === "follow") return;
    const { models } = await this.models();
    if (!models.some(row => row.provider === selection.provider && row.model === selection.model)) {
      throw new MemosError("invalid_argument", "The selected model is no longer in DSH's registered catalog");
    }
    await bounded(this.options.llm.resolveModelInfo(selection.provider, selection.model), 10_000);
  }

  async save(value: unknown) {
    const selection = parseMemorySelection(value);
    const write = this.writes.catch(() => undefined).then(async () => {
      await this.validate(selection);
      await fs.mkdir(this.options.home, { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ version: 1, selection }, null, 2) + "\n", { mode: 0o600 });
        await fs.rename(temp, this.path);
      } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
      this.selection = selection;
      this.enabled = true;
      this.warning = undefined;
      return this.snapshot();
    });
    this.writes = write;
    return write;
  }

  async test(value: unknown, signal?: AbortSignal) {
    const selection = parseMemorySelection(value);
    const raw = value as Record<string, unknown>;
    let route: DeepSeekHarnessLlmRoute | undefined = selection.mode === "fixed" ? selection : this.options.routes.current();
    if (!route) {
      const candidate = parseMemorySelection({ mode: "fixed", provider: raw.testProvider, model: raw.testModel });
      if (candidate.mode !== "fixed") throw new Error("Choose a DSH model for the test");
      route = candidate;
    }
    await this.validate({ mode: "fixed", provider: route.provider, model: route.model });
    const probeBridge = createDeepSeekHarnessHostLlmBridge({ llm: this.options.llm, routes: this.options.routes });
    // Test an unsaved candidate without replacing the live memory selection.
    const result = await this.options.routes.run(route, () => probeBridge.complete({
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      maxTokens: 32, timeoutMs: 20_000, signal,
    }));
    return { ok: true, provider: route.provider, model: route.model,
      latencyMs: result.durationMs, responseChars: result.text.length };
  }

  async testEmbedding() { return this.options.core().probeEmbedding(); }
}

async function bounded<T>(pending: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MemosError("llm_timeout", "DSH model catalog timed out")), timeout);
  })]); } finally { if (timer) clearTimeout(timer); }
}
