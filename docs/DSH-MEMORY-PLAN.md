# DSH memory plugin delivery boundaries

## Integrated settings

Implemented in `2.0.16-dsh.2`: one MemOS core inside DSH, native Settings entry,
registered DSH model selection, immediate memory-specific routing, shared Viewer
settings and active embedding probe. Package installation and market acceptance
are separate states.

## Bounded local history and MCP

Implemented in `2.0.16-dsh.5`: opt-in recent Codex JSONL and DSH V4/zstd readers,
completed direct-human turns, model-refined summaries with source references,
stable trace IDs, durable file signatures, bounded batches and embedding repair.
The timer and cancellation belong to the Cordis plugin. Default window seven
days; maximum thirty days. Background work needs an explicitly selected registered
model or a fixed memory route. Follow without a route waits. Original history is
read-only; no scheduled task, Python reader service or second memory core exists.

The existing Viewer listener exposes bearer-authenticated, read-only `/mcp` for
Codex. One-shot configuration preserves existing MCP servers. It advertises
`memory_search` and `memory_get`; only trace detail is exposed. Dedicated
MCP credentials grant no Viewer settings or import access. The Viewer retains
its password/session gate. New Codex sessions or an MCP reconnect discover newly
registered tools; registration is not itself proof of real conversation recall.

## Specified remote recall

Implemented in `2.0.16-dsh.5`: one explicit authenticated peer, independently
bounded local/remote queries, source labels, local-only peer dispatch to prevent
forwarding loops, and read-only trace detail. Optional plugin-owned SSH transport
reuses existing key/known-host configuration and stops on plugin disposal. This
does not scan a LAN or select models by discovery. A DSH-only server does not
need Codex or history extraction enabled to query the local peer.

Remote writes, database synchronization, retrying write queues, deletion
propagation and conflict resolution remain unimplemented. Neither a live SQLite
copy nor automatic raw-session upload is used as a synchronization protocol.

## Verification boundaries

Parser and transport fixtures cover malformed input, authentication, idempotency,
limits, cancellation and offline behavior. Deployment acceptance must separately
verify the installed version, visible Settings, real embedding, both local
cross-application queries and both remote directions, with the original source
session IDs and facts. Keep private transcripts, credentials and detailed live
evidence outside the public repository. No extra data backup is created when
the user has opted to retain their existing backup.
