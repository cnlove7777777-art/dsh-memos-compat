# MemOS local plugin — DSH compatibility build

> A maintained fork of [`@memtensor/memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
> that runs on **DeepSeek Harness (DSH) 0.2.1** and later.
> All credit for the memory engine, its algorithm, and its adapters belongs to
> [MemTensor](https://github.com/MemTensor) and the MemOS contributors; this
> repository only carries the DSH-runtime fixes described below.

## What this fork changes

Upstream 2.0.16 declares `@deepseek-ai/dsh-*` peer ranges of `<0.2.0`, so DSH
0.2.1 refuses to install it, and three further problems appear once that gate
is passed. This fork fixes all four in the package itself — no manual
`node_modules` editing, no separate patch script to run afterwards.

| # | Problem | Fix |
|---|---------|-----|
| 1 | DSH 0.2.1 rejected the `<0.2.0` peer ranges (`ERESOLVE` / "incompatible") | `engines.dsh` + `peerDependencies` widened with an explicit prerelease branch |
| 2 | DSH Session V4 retired the `{ kind: "plugin", plugin: id }` message source | Adapters now emit `{ kind: \`plugin:${id}\` }` |
| 3 | `better-sqlite3` has no ABI 149 prebuild for DSH's Electron 44.7 / Node 24.21 runtime, so the database could not open | New `node:sqlite` fallback driver, selected automatically when the native binding cannot be loaded |
| 4 | The local MiniLM embedder resolved a model directory that did not exist, so embeddings were unavailable offline | Offline model-root resolution, with `env.allowRemoteModels = false` so a plugin inside a chat client never calls out to huggingface.co |

Nothing else is changed: the memory layers, retrieval tiers, capture pipeline,
migrations, viewer, and all other adapters are upstream's code at the commit
recorded in `git log`.

## Install

From a DSH profile directory:

```sh
dsh plugin --profile <name> add cnlove7777777-art/dsh-memos-compat
```

or from a packed tarball:

```sh
npm pack
dsh plugin --profile <name> add ./memtensor-memos-local-plugin-2.0.16-dsh.1.tgz
```

Then add the bundle to the profile's `package.json` and add the loader entry
to `cordis.patch.yml`:

```jsonc
// <profile>/package.json
{ "dsh": { "profile": { "bundles": ["@memtensor/memos-local-plugin"] } } }
```

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: memos-local-memory
      name: '@memtensor/memos-local-plugin/dist/adapters/deepseek-harness/index.js'
      config:
        enabled: true
        profileId: standard
        home: ''
        recallEnabled: true
        captureEnabled: true
        toolsEnabled: true
        hostLlmEnabled: false
        viewerEnabled: true
        viewerPort: 18801
```

Reopen DSH afterwards.

### `better-sqlite3` and build approval

`better-sqlite3` is still the primary engine and is still a dependency. When
pnpm cannot build or download a prebuild for the running runtime, DSH reports
`ERR_PNPM_IGNORED_BUILDS` and refuses the install; approve the build, or leave
it unapproved — the plugin falls back to `node:sqlite` either way. Force an
engine with `MEMOS_SQLITE_DRIVER=better-sqlite3` or
`MEMOS_SQLITE_DRIVER=node:sqlite`.

### Offline model staging

The embedder looks for the model in this order:

1. `MEMOS_LOCAL_MODEL_ROOT`
2. `<plugin>/node_modules/@huggingface/transformers/.cache`
3. `<profile>/.cache`

Stage the four files (`config.json`, `tokenizer_config.json`, `tokenizer.json`,
`onnx/model_quantized.onnx`) under `<root>/Xenova/all-MiniLM-L6-v2/`. If the
model is absent the plugin still runs — capture and retrieval degrade to
keyword-only, and `GET /api/v1/health` reports `embedder.available: false`.

## Verify

`GET http://127.0.0.1:<viewerPort>/api/v1/health` should return
`{"ok": true, "agent": "deepseek-harness"}`. `embedder.available` reflects
whether the local model was found; `llm.available` is false unless
`hostLlmEnabled` is on and a host route is configured.

## Known limits

- `iterate()` is materialized: `node:sqlite` exposes no streaming cursor in
  this runtime. Fine for a new, small database; not a streaming implementation
  for a large corpus.
- `unsafeMode()` is a no-op under `node:sqlite`, which does not enable
  `SQLITE_DBCONFIG_DEFENSIVE` — so `PRAGMA writable_schema` is already
  permitted and the migrations that need it still run.
- The DSH market badge can still read "incompatible" until DSH picks up the
  new `engines.dsh` range; that badge reflects the manifest, not this build.

## Upstream

- Source: <https://github.com/MemTensor/MemOS> (`apps/memos-local-plugin`),
- Upstream package: `@memtensor/memos-local-plugin` on npm, Apache-2.0.
- This fork's own changes are MIT, matching the upstream package's declared
  `license` field.

The upstream README is preserved verbatim as [`README.upstream.md`](./README.upstream.md).
