# DSH memory plugin delivery boundaries

## Phase 1: integrated memory settings

Implemented in `2.0.16-dsh.2`: one MemOS core inside DSH; native Settings entry;
registered DSH model selection; immediate memory-specific routing; shared Viewer
settings; active embedding probe. Installation uses the existing plugin manager.
The package can be installed by URL/tarball while its market listing is pending.
A listing submission and an accepted market listing are separate states.

The runtime starts and stops with its Cordis plugin. The existing loopback
Viewer is an HTTP listener in that same process. No scheduled task, service,
LAN scan or gateway discovery is needed for model selection.

## Phase 2: incremental Codex history worker (not implemented)

Add an opt-in job queue owned by the same plugin lifecycle. Settings must show
the selected history root, a recent time window, enabled state and last result.
Do not import all history by default. Read local JSONL without executing any
content. Store durable file/offset and content-digest cursors, debounce changes,
use bounded idle batches and resume safely after DSH restarts. Separate raw
observations from model-refined facts, with source references and deduplication.
Use the fixed memory route for unattended refinement; follow mode must defer
work when there is no owning conversation. Stop/cancel on plugin disposal.
Do not claim extraction is enabled merely because Codex exposes an MCP client.

## Phase 3: local and specified remote memory stores (not implemented)

Keep the local database available offline. Configure one explicit remote API
address and authenticated credential reference, with connection test and clear
read/write controls. Query local/remote with independent timeouts and mark each
result's source. Remote failures must not block local retrieval or chat startup.
Remote writes need stable IDs, idempotency, a durable retry cursor and explicit
conflict/deletion behavior. Never copy a live SQLite/WAL pair as a sync protocol.
Do not scan the network or send raw Codex sessions to the server automatically.

## Optional MCP access (not implemented)

An MCP interface can expose search/record operations over the same runtime and
database. Prefer a host-supported in-process transport where available; do not
launch another daemon to duplicate the core. MCP registration alone neither
extracts history nor synchronizes stores. Keep this access layer separate from
the bounded maintenance queue.

## Acceptance

Phase 1: DSH's actual Settings navigation renders the entry, installed version
matches the package, a saved fixed route is used by MemOS, follow routes remain
isolated between conversations, a failed probe leaves the saved model intact,
and the real local embedder returns a valid vector. Report isolated-runtime
acceptance separately from the user's installed desktop acceptance.

Later phases require crash/restart cursor recovery, offline local recall,
bounded backlog handling, authenticated remote round trips, provenance and
duplicate/conflict tests. They must not introduce an OS background task.
