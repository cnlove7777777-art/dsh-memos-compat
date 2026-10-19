# DSH peer memory transport

Implemented by `2.0.16-dsh.6`. Installation and live acceptance are separate
from the source and isolated protocol tests.

## Ownership and routes

One MemOS core remains inside each DSH host. The plugin owns the discovery
socket, peer HTTP listener, connection timers, outbound reverse-query poll and
replica store. Disposal cancels requests and releases these resources. No SSH
child, scheduled task, standalone memory service or model discovery is used.

The loopback Viewer and Codex MCP remain on TCP 18801. The separate TCP 18802
listener serves only the authenticated `/peer/` API. It never serves Viewer
settings, model credentials, configuration files or shell commands.

Peers discover one another through signed UDP 18802 multicast
`239.255.77.77` and broadcasts on attached private IPv4 interfaces. Discovery
announcements contain identities, ports and challenges, never keys or memory.
The source address determines a candidate URL. A keyed challenge/response must
then confirm the configured or remembered peer identity. Authenticated private
LAN routes take priority over the configured HTTPS URL. Known routes are
remembered and revalidated after restart. A failed LAN query can fall back to
the HTTPS address within the foreground deadline.

Discovery and reconnection run periodically inside the plugin. An explicit
"discover and test" action retries immediately. Rejected authentication backs
off automatic retries; correcting credentials and testing does not require
waiting for that backoff.

## Authentication

Every new peer request signs its method, canonical `/peer/` route, body digest,
device identity, timestamp and random nonce with the pairing key. A bounded
replay guard rejects expired or repeated nonces. Responses sign their body,
status, serving identity and request nonce. A health status or discovery packet
alone does not establish trust.

Private LAN HTTP uses signatures without sending the pairing key or WebOS
session as plaintext headers. LAN payloads themselves are not encrypted by this
HTTP transport. Public URLs must use HTTPS, normal certificate validation and
no redirects. Only the explicitly configured HTTPS endpoint receives the
`Authorization: Bearer` pairing key and optional `X-WebOS-Session` login token.

The WebOS framework mounts `/desktop/api/memory-peer/<route>` and rewrites only
the allowlisted suffix to `http://127.0.0.1:18802/peer/<route>`. It validates the
existing Owner session; expiry, logout and revocation still apply. The plugin
then verifies the independent peer signature. Machine requests are admitted
only on this narrow namespace. Other management APIs retain browser login,
Origin and CSRF checks. The gateway preserves signed response bytes and headers.

Pairing keys and login sessions entered in Settings are write-only. They are
stored under the plugin home in `.peer-credentials.json`, never returned in
settings snapshots or saved in browser storage. Legacy market-owned pairing
keys are copied into this plugin-owned credential file. Old SSH forward URLs
are migrated to LAN discovery; tunnel settings are discarded.

## Bidirectional requests through NAT

The desktop maintains an outbound authenticated HTTPS long poll to the server.
The server can return bounded `search` or `detail` requests through that poll;
the desktop queries only its local core and submits the result. This supports
server-to-desktop recall even when the desktop has no inbound public address.
The relay has bounded queues and deadlines, does not execute history as code,
and cannot carry terminal or arbitrary network requests.

| Canonical endpoint | Method | Purpose |
| --- | --- | --- |
| `/peer/health` | GET | Authenticated status |
| `/peer/handshake` | POST | Confirm peer identity and challenge |
| `/peer/search` | POST | Query the receiving local core |
| `/peer/detail` | POST | Read one local trace |
| `/peer/relay/poll` | POST | Receive reverse read requests |
| `/peer/relay/results` | POST | Complete a bounded reverse request |
| `/peer/sync/pull` | POST | Export a bounded logical memory page |
| `/peer/sync/push` | POST | Import a page into the replica store |

## Logical synchronization

Synchronization requires both peers to enable it. A page carries source
identity, memory kind and ID, revision, bounded structured memory, and vector
model/dimension metadata. Traces, policies, world models and skills are mirrored
in a separate `peer-replicas.db`. Imported entries are never re-exported.
The original `memos.db` remains authoritative and is opened read-only by the
sync exporter. Stable origin IDs make repeated imports idempotent.

One bounded pull and push page is processed per maintenance cycle. No physical
SQLite file, raw session archive, configuration or log is uploaded. A replica
can answer offline queries with explicit source labels. Vector comparisons
require matching model identity and dimension; incompatible or unidentified
vectors are not compared. Local query embeddings reuse the existing embedder.

This version provides non-destructive source-owned mirrors, not multi-master
editing. Deletion propagation, merging competing edits and an exactly identical
pair of SQLite databases are not part of this protocol.

## Settings and verification

Both DSH native Settings and the Viewer provide LAN discovery, public server
URL, pairing key, login session, peer identity, synchronization and connection
status. Save first, then test. Refreshes never replace an unsaved draft and a
successful save clears secret inputs.

A bare public domain is normalized to HTTPS and uses the WebOS
`/desktop/api/memory-peer` mount automatically. An explicit `/peer` mount is
also supported for a dedicated HTTPS reverse proxy.

The DSH native action is `POST /api/memos/history/connect`; the Viewer maps it
to `POST /api/v1/dsh/history/connect`. This tests saved settings without changing
the selected model or starting a history import.

Protocol tests do not prove an installed desktop plugin or public-domain login.
Live acceptance records the installed versions, actual Settings entry, real
source records, LAN route, WAN fallback, reverse query and offline replica
behavior separately. A temporary network probe is labeled as such.
