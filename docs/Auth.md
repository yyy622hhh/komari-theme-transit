# v3 Auth Flow

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
- `diskPrediction` — disk-prediction history loading.
- `providerGeoLookup` — detail/list provider geo metadata lookups.
- `historyMetrics` — ping/history metric surfaces, including mini ping bars and detail ping history.

## Protected surfaces

- Home advanced tools: topology, provider value, health summary, snapshot export.
- Snapshot export: login verification plus optional export secondary password.
- Health summary generation.
- Disk prediction history loading.
- Ping/history metric loading.
- Provider geo lookup for sensitive metadata.

## Public behavior

The home page and instance detail route stay public. When auth is missing or expired, the theme hides private surfaces and continues rendering public node data.
