# Transit Route Probe companion

This Komari plugin is the relay between the Transit theme and the fixed-purpose
node helper. It deliberately requests only `allowRoutes` plus the sandboxed
Node compatibility module set.

It does **not** request system RPC, child-process execution, port listening,
HTML injection, hooks, or unrestricted filesystem access.

Protocol summary:

1. An authenticated admin queues node UUIDs and one of three built-in cities.
2. A helper authenticates with that node's existing Komari Agent token and
   polls for its own work.
3. The helper selects all traceroute targets locally; the relay never sends a
   command, address, shell fragment, or traceroute option.
4. A one-time leased job ID binds the result to the authenticated node.
5. The theme validates and merges the returned `transit-route:` tag.

An authenticated admin can also read `GET /roster?clients=` to see which
node UUIDs have a helper actively polling (`helper_seen_at`). This is
read-only — a poll call updates that timestamp regardless of whether a job
exists, so the roster never queues a job or triggers a probe on its own.

The optional `active_job_until` field is a Unix timestamp in milliseconds (or
null), derived from a running job's valid lease and capped by its ten-minute
TTL. It keeps a busy helper visible while the synchronous collector is not
polling; it does not assert a fresh heartbeat. Completed or expired leases no
longer count as busy. Older plugins may omit this field, and old helpers do not
need to change their requests. A task that expires without ever being leased
is reported by the theme as an unconnected helper, not a failed network probe.

Package `komari-plugin.json`, `script.js`, `protocol.cjs`, `storage.cjs`, and `request-limits.cjs`
at the ZIP root (`bun run build:route-probe`) and install the ZIP on Komari's
Plugins page. Komari `>=1.4.0` is required because the relay relies on plugin
route identity context for both admin sessions and Agent tokens.

`GET /health` keeps `ok`, `protocol`, and `version`. The optional `storage`
object independently reports `status` (`healthy`, `degraded`, `unavailable`),
`last_success_at` (milliseconds or null), `last_error` (category or null), and
`recovered_from_corrupt`. `ok` means the relay is available, not that disk writes
succeeded. Older plugins without this field are **unreported**, not healthy.

State stays in Komari's `__storageDir__/state-v1.json` with mode `0600`, a
same-directory temporary file and atomic rename. The v1.4.0 format is unchanged;
it contains no token. Task mutations save immediately and idle heartbeats save
at most once per minute. Failed writes preserve memory, dirty state and the old
file; subsequent requests retry after 15, 30, then at most 60 seconds. Logs and
health expose only permission/no-space/I/O categories, never paths or raw errors.
A successful save clears degradation. Corrupt JSON is renamed and retained.
An unreadable file is not treated as corruption and is never overwritten.

Recovery also reconciles jobs by client/city: retain a valid lease first, then
newer work, and mark redundant jobs failed without issuing them again. A newer
successful job cannot revive old queued work. The reconciled state is persisted;
the v1 schema and old helper protocol remain compatible.

The theme waits up to the ten-minute job TTL plus thirty seconds of transport
margin for companion results; the legacy remote-exec timeout is unchanged.
The helper installer uses private temporary files and atomic configuration
replacement, aborts on critical failures, and restarts/verifies the service on
upgrade. A service-start failure reports an incomplete install (not a rollback).

While degraded, probes continue but restarting may lose unsaved state. Before
upgrading, check the Komari service account owns the plugin/storage directories
and can write there, and back up the old plugin ZIP and state file. After upgrading,
verify health version, helper polls, storage recovery and restart restoration.
Never migrate real monitoring targets as part of a release smoke test.

## Credential transport and upgrade order

Upgrade the plugin before installing the new helper. New helpers send Agent
credentials only in HTTPS JSON POST bodies to `/poll` and `/result`, not in URL
query strings, curl arguments or logs. This uses Komari's JSON Agent identity
handling (covered by the 1.4.2/1.4.3 integration matrix). An old plugin that lacks
POST polling is reported as needing an upgrade; the helper never falls back to
query-token authentication. The plugin still accepts old GET/form helpers so
nodes can be upgraded gradually. Those old helpers still put tokens in URLs.

Use an HTTPS panel to generate installation commands. The explicit manual
`--allow-insecure-http` flag accepts only literal loopback addresses for a local
TLS-terminating proxy, never a remote HTTP host. Supply tokens interactively or
with `--token-file`; `--token` command-line input is rejected. Each helper request
uses a new private directory and `0600` files. An explicitly configured runtime
directory must already exist, be owned by the service user, and have mode `0700`.

Authenticated polling and results are limited independently per node (bursts
6/8, refill one request per 5/15 seconds). HTTP 429 includes `Retry-After`.
Duplicate completed results do not rewrite task state or emit another acceptance
log; heartbeat persistence remains at most once per minute. These bounds are
in-process protection, not a substitute for reverse-proxy request limits.

Configure proxy/CDN/APM logging to omit credential query strings and request
bodies. Do not disable access auditing entirely: retain method, path, status,
duration and source metadata. If old URL-token logs were accessible to others,
restrict access and rotate affected Agent tokens through the operator's normal
procedure. Updating code cannot revoke previously logged credentials.
