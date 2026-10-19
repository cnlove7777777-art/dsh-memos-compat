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

## Peer network and logical mirrors

Implemented in `2.0.16-dsh.6`: signed LAN discovery, direct private peer queries,
configured HTTPS fallback, existing WebOS Owner-session authentication and
outbound reverse-query polling for desktops behind NAT. The plugin no longer
launches SSH. A DSH-only server needs no Codex installation or history reader.

Opt-in logical synchronization imports memory and compatible vector metadata
into a separate source-owned replica store; it does not overwrite either local
database or re-export imported records. Deletion propagation and competing edit
resolution remain outside this version. The authoritative transport, lifecycle,
settings and authentication contract is [DSH-PEER-NETWORK.md](DSH-PEER-NETWORK.md).

## Verification boundaries

Parser and transport fixtures cover malformed input, authentication, idempotency,
limits, cancellation and offline behavior. Deployment acceptance must separately
verify the installed version, visible Settings, real embedding, both local
cross-application queries and both remote directions, with the original source
session IDs and facts. Keep private transcripts, credentials and detailed live
evidence outside the public repository. No extra data backup is created when
the user has opted to retain their existing backup.
