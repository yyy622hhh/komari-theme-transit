# Transit Auth Flow

## Source of truth

`services/auth.service.ts` verifies the current session with Komari `/api/me` via `verifyLogin()`.

## Flow

```text
initApp()
  -> getMe()
  -> appStore.updateLoginState()
  -> auth service session
  -> appStore.privateFeaturesAllowed
```

Sensitive actions call `requirePermission()` / `appStore.requireLoginPermission()` before work begins. User-triggered advanced tools use `force: true`; background-sensitive data paths use typed permission keys and reuse the fresh session TTL to avoid repeated `/me` calls.

## Permission keys

- `advancedTools` — generic private metadata paths such as authenticated list metadata.
- `snapshotExport` — snapshot export and export-specific provider metadata.
- `healthSummary` — health summary generation.
- `providerValue` — provider value panel metadata.
- `nodeTopology` — topology panel metadata.
- `serverList` — server list access and global node-order writes.
- `auditLog` — Komari administrator audit log reads.
- `diskPrediction` — disk-prediction history loading.
- `providerGeoLookup` — detail/list provider geo metadata lookups.
- `nodeCardPanel` — per-node and grouped observation-panel writes.

## Protected surfaces

- Home advanced tools: topology, provider value, health summary, snapshot export.
- Snapshot export: login verification before composing or downloading a snapshot.
- Health summary generation.
- Disk prediction history loading.
- Provider geo lookup for sensitive metadata.
- Server-list tools and `admin:orderClients` writes.
- Administrator audit log reads.
- Per-node and grouped observation-panel writes.

## Public behavior

The home page and instance detail route stay public. Public node monitoring includes load charts, mini Ping bars, and detail Ping latency/loss history. When auth is missing or expired, the theme hides only advanced/private surfaces and continues rendering public node data.

Regression tests verify that logged-out home/detail routes never request `/api/admin/*`, `admin:*` RPC methods, node IP geo providers, or hidden-price exchange-rate providers. User-triggered private actions force a fresh `/api/me` verification so an expired session is denied before the private request starts.
