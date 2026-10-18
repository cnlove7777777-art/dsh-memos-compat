# MemOS local plugin — DSH compatibility build

> A maintained fork of [`@memtensor/memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
> that targets **DeepSeek Harness (DSH) 0.2.1** (including its prereleases).
> All credit for the memory engine, its algorithm, and its adapters belongs to
> [MemTensor](https://github.com/MemTensor) and the MemOS contributors; this
> repository carries DSH compatibility fixes and an integrated memory Settings section.

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

Version `2.0.16-dsh.2` also adds **Settings -> 记忆插件** inside DSH. It uses
DSH's registered model catalog and credential resolution for memory extraction,
summaries, L3 abstraction and skill evolution. It never changes DSH's default
conversation model. The existing MemOS Viewer (`http://127.0.0.1:18801/#/settings`)
uses the same memory selection when embedded in DSH.

- **Follow**: use the provider/model of the conversation that owns each memory
  operation. Concurrent conversations retain separate routes. Work without an
  owning conversation has no implicit last-used-model fallback.
- **Fixed**: choose a registered DSH provider/model for all memory LLM work.
- **Save**: persist only the memory selection in `<memos-home>/dsh-model.json`;
  activate it immediately, without restarting DSH or copying API keys.
- **Test**: execute a small real call through DSH. In follow mode, choose a
  registered model for the settings-page test only; this does not change follow.
- **Embedding test**: run the active core's embedder and verify a finite vector
  with the expected dimension. Showing a model name alone is not a successful test.

An old profile with `hostLlmEnabled: false` keeps model-assisted work disabled
until a selection is saved. The DSH adapter now manages all memory LLM stages;
standalone provider/key fields in old MemOS YAML do not override DSH routing.
Other host adapters retain their existing behavior. Embedding configuration
changes still follow the Viewer's existing restart instructions.

## Install

From a DSH profile directory:

```sh
dsh plugin --profile <name> add cnlove7777777-art/dsh-memos-compat
```

or from a packed tarball:

```sh
npm pack
dsh plugin --profile <name> add ./memtensor-memos-local-plugin-2.0.16-dsh.2.tgz
```

DSH's plugin manager owns dependency installation and bundle registration.
Do not insert a second copy of the adapter into `cordis.patch.yml`. If a profile
already has an override for `memos-local-memory`, edit that override by ID.
The package supplies this bundle layer automatically:

```jsonc
// <profile>/package.json
{ "dsh": { "profile": { "bundles": ["@memtensor/memos-local-plugin"] } } }
```

```yaml
# <profile>/cordis.patch.yml
- insert:
    - id: memos-local-memory
      name: '../../dist/adapters/deepseek-harness/index.js'
      config:
        enabled: true
        profileId: standard
        home: ''
        recallEnabled: true
        captureEnabled: true
        toolsEnabled: true
        hostLlmEnabled: true
        viewerEnabled: true
        viewerPort: 18801
```

This relative entry is resolved beside the package's bundle patch by DSH. It
also lets DSH discover the package's client metadata: 0.2.1's scanner ignores
bare package subpath specifiers. Do not copy this package-relative entry into a
profile's own patch. Existing ID overrides should contain config only.

Reopen DSH after installing/upgrading the package. Open DSH Settings and select
**记忆插件**. The standalone `18801` page is the memory database Viewer; it is
not DSH's installed-plugin inventory. New model selections do not require a
host restart.

### `better-sqlite3` and build approval

`better-sqlite3` is still the primary engine and is still a dependency. When
pnpm cannot build or download a prebuild for the running runtime, its install
policy may require approving the build before installation completes. The
runtime fallback does not bypass the package manager's install policy. Force an
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
`{"ok": true, "agent": "deepseek-harness"}`. Check the memory Settings entry's
enabled state and execute its model and embedding tests. Core health reports
client initialization; it does not prove a successful model request.

## Shared history and Codex access (`2.0.16-dsh.5`)

DSH Settings -> 记忆插件 now includes a separate history section. Opt in to local
Codex and DSH session roots and a recent window (default seven days). The queue
runs inside the plugin, at startup and once a minute, in bounded batches. It
reads completed direct-human turns, excludes tools, injected instructions and
delegated sessions, refines project facts using a registered DSH model, and
repairs vectors through the existing local embedder. Stable source IDs and
durable cursor receipts make retries and restarts idempotent. Source references
remain attached to each imported memory. Original session files are not changed.

Choose a background model explicitly, or use the memory selection's fixed
model. Follow mode without an owning conversation waits; it does not reuse an
arbitrary last model. A failed model call leaves the source pending. Current
DSH conversation capture continues through the existing native lifecycle.

The existing loopback Viewer listener also serves a read-only Streamable HTTP
MCP endpoint at `/mcp`, protected by a dedicated random credential stored in
`<memos-home>/.codex-mcp.json`. The Viewer's password gate remains in place.
After DSH starts, connect Codex once:

```sh
node scripts/connect-codex.mjs <memos-home> <codex-home>
```

This adds the `dsh_memory` connection while preserving other Codex MCP servers.
Reconnect MCP or start a new Codex session to discover `memory_search` and
`memory_get`. DSH must be running for this connection to answer; it does not
launch a second memory process. The credential is local setup data, never part
of the package or repository. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Optionally enable one explicit remote peer URL (HTTPS, or loopback through SSH)
and select its existing JSON credential file. The supported peer protocol uses
`/peer/search`, `/peer/detail` and `/peer/health`, not an arbitrary Viewer URL.
Local and remote recall run independently within the DSH foreground deadline;
remote failure leaves local recall available. Results identify the remote
source. Peer access is read-only: raw Codex sessions and SQLite files are not
copied, merged or uploaded. A server with DSH only needs remote recall enabled;
leave its history roots empty and history maintenance disabled.

An optional existing SSH settings file (`identity`, `known_hosts`,
`last_address`, optional `username`) lets the plugin own the paired transport.
It preserves host-key checking and never scans the network. The SSH child is
only transport and stops with the plugin; no OS task or memory daemon is added.
The paired NanoPi transport uses local forward 18794 -> server 18801 and reverse
forward server 18793 -> this Viewer's port. Disable the old standalone connector
before handing these ports to the plugin.

## Known limits

- `iterate()` is materialized: `node:sqlite` exposes no streaming cursor in
  this runtime. Fine for a new, small database; not a streaming implementation
  for a large corpus.
- `unsafeMode()` is a no-op under `node:sqlite`, which does not enable
  `SQLITE_DBCONFIG_DEFENSIVE` — so `PRAGMA writable_schema` is already
  permitted and the migrations that need it still run.
- Remote access currently provides federated read-only recall; bidirectional
  database replication, remote writes and conflict/deletion merging are not
  implemented. Source files exceeding the bounded reader limits need separate
  handling; the worker never performs an unbounded whole-history import. See
  [the delivery boundaries](docs/DSH-MEMORY-PLAN.md).

## Upstream

- Source: <https://github.com/MemTensor/MemOS> (`apps/memos-local-plugin`),
- Upstream package: `@memtensor/memos-local-plugin` on npm. Preserve upstream
  attribution and the license files shipped in this repository.

The upstream README is preserved verbatim as [`README.upstream.md`](./README.upstream.md).
