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

Package the three plugin files at the ZIP root and install the ZIP on Komari's
Plugins page. Komari `>=1.4.0` is required because the relay relies on plugin
route identity context for both admin sessions and Agent tokens.
