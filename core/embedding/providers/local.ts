/**
 * Local MiniLM embeddings via `@huggingface/transformers`.
 *
 * Model: by default `Xenova/all-MiniLM-L6-v2` — 384-dim, ~23 MB on first run,
 * quantized to int8 for CPU friendliness. The model loads lazily on the first
 * call and is shared across all embedders in the process.
 *
 * Output: `pipeline("feature-extraction")` already supports mean-pooling and
 * L2-normalize via `{ pooling: "mean", normalize: true }`. We intentionally
 * don't normalize again on top of that.
 */

import type {
  EmbedRole,
  EmbeddingProvider,
  EmbeddingProviderName,
  ProviderCallCtx,
} from "../types.js";

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (text: string, options?: Record<string, unknown>) => Promise<any>;

let extractorPromise: Promise<Extractor> | null = null;
let currentModel: string | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Stop awaiting native Transformers work when the caller's request expires.
 *
 * The pipeline API does not accept an AbortSignal, so the underlying model
 * load/inference may still finish in the background. Keeping that work alive
 * is intentional: a timed-out first request can still warm the shared model
 * cache for the next request. Attaching both promise handlers also prevents a
 * late native failure from becoming an unhandled rejection.
 */
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Resolve a directory that already holds the model, so an offline install
 * works without reaching the network.
 *
 * `@huggingface/transformers` looks in `env.localModelPath` first and then in
 * `env.cacheDir`; both default to paths beside the package itself. A plugin
 * installed into a DSH profile keeps its model wherever the profile staged
 * it, so check the well-known locations before giving up and letting the
 * loader try the network.
 */
export function resolveLocalModelRootForTests(model: string): string | undefined {
  return resolveLocalModelRoot(model);
}

function resolveLocalModelRoot(model: string): string | undefined {
  const relative = model.split("/").join("/");
  // Resolve through a real subpath export, not `package.json`: the package's
  // `exports` map does not expose `./package.json`, and `require.resolve`
  // throws rather than returning null.
  const packageDir = dirname(require.resolve("@huggingface/transformers"));
  const candidates = [
    // Explicit override, for profiles that stage the model elsewhere.
    process.env["MEMOS_LOCAL_MODEL_ROOT"],
    // `<plugin>/node_modules/@huggingface/transformers/.cache` — where the
    // DSH installer stages the quantized MiniLM files.
    join(packageDir, ".cache"),
    // `<plugin>/.cache` — a profile-local staging directory.
    resolve(packageDir, "..", "..", "..", ".cache"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(join(candidate, relative))) return candidate;
  }
  return undefined;
}

async function ensureExtractor(model: string, log: ProviderCallCtx["log"]): Promise<Extractor> {
  if (extractorPromise && currentModel === model) return extractorPromise;
  if (extractorPromise && currentModel && currentModel !== model) {
    log.warn("model.swap", { from: currentModel, to: model });
    extractorPromise = null;
  }
  log.info("loading", { model });
  const t0 = Date.now();
  extractorPromise = (async () => {
    // Dynamic import keeps the heavy dep out of the hot path for tests that
    // don't need it.
    const mod = await import("@huggingface/transformers");
    const pipeline = (mod as unknown as { pipeline: PipelineFn }).pipeline;
    // Offline-first: never reach out to huggingface.co from a plugin that
    // runs inside someone's chat client. Models are expected to be present
    // in the local cache; `MEMOS_OFFLINE_MODELS=0` re-enables remote fetch
    // for users who explicitly want it.
    const offline = (process.env["MEMOS_OFFLINE_MODELS"] ?? "1") !== "0";
    const env = (mod as unknown as { env?: Record<string, unknown> }).env;
    if (offline && env && typeof env === "object") {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      // Point the loader at a directory that actually holds the model. Without
      // this the offline load fails on `models/` even when the files are
      // staged one directory over.
      const localRoot = resolveLocalModelRoot(model);
      if (localRoot) {
        env.localModelPath = localRoot;
        env.cacheDir = localRoot;
        log.info("offline", { root: localRoot });
      }
    }
    const ext = (await pipeline("feature-extraction", model, {
      dtype: "q8",
      device: "cpu",
    })) as unknown as Extractor;
    log.info("ready", { model, durationMs: Date.now() - t0 });
    return ext;
  })().catch((err) => {
    extractorPromise = null;
    log.error("load_failed", {
      model,
      err: { name: (err as Error).name, message: (err as Error).message },
    });
    throw err;
  });
  currentModel = model;
  return extractorPromise;
}

/**
 * Reference type for the dynamic `pipeline` import. We can't import the
 * real type at compile time without a static `import type`, which would pull
 * the library into test builds. This shape matches what we actually use.
 */
type PipelineFn = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name: EmbeddingProviderName = "local";

  async embed(texts: string[], _role: EmbedRole, ctx: ProviderCallCtx): Promise<number[][]> {
    const { config, log } = ctx;
    // Avoid starting a costly lazy model load for an already-expired request.
    if (ctx.signal?.aborted) throw abortReason(ctx.signal);
    const ext = await awaitWithAbort(ensureExtractor(config.model, log), ctx.signal);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      if (ctx.signal?.aborted) throw abortReason(ctx.signal);
      const result = await awaitWithAbort(
        ext(texts[i]!, { pooling: "mean", normalize: true }),
        ctx.signal,
      );
      const arr = (result as { data?: Float32Array }).data;
      if (!arr) {
        throw new Error("[embedding.local] extractor returned no .data");
      }
      out.push(Array.from(arr));
    }
    return out;
  }

  async close(): Promise<void> {
    // The transformers pipeline doesn't expose a .close(); GC handles it.
    extractorPromise = null;
    currentModel = null;
  }
}

// Test hook — tests can reset the cached extractor without touching internals.
export function __resetLocalExtractorForTests(): void {
  extractorPromise = null;
  currentModel = null;
}
