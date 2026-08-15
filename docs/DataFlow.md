# Transit Data Flow

## Node data

```text
Komari RPC / API
  -> init manager
  -> nodes store
  -> visible node computed state
  -> HomeView / InstanceDetail / components
```

Logged-out users receive public rendering only. Hidden nodes are filtered through `nodesStore.visibleNodes` unless `appStore.privateFeaturesAllowed` is true.

## Provider metadata

```text
Component
  -> useNodeProviderMetadata()
  -> AuthService permission check when geo is requested
  -> ProviderService
  -> SharedCache
  -> Geo lookup / provider resolver
```

Geo lookup is gated by `allowGeoLookup` and, when supplied, a typed permission key. Cache keys include the geo mode, so public metadata-only resolution cannot reuse private geo-enriched entries.

The public globe is a separate country-only path: it groups nodes from the Komari country/region code and built-in coordinates. It does not inspect node IPv4/IPv6 fields or call IP geolocation providers. Authenticated geo-enriched tools continue through the permission-gated provider flow above.

## History and prediction

```text
Component
  -> useNodeLoadStats() / useNodePingStats() / PingChart
  -> optional AuthService permission check
  -> HistoryService
  -> RequestManager
  -> RPC / REST fallback
  -> PredictionService
```

Disk prediction uses `LOAD_RECORD_MAX_COUNT` by default, verifies the `diskPrediction` permission before loading private history, and does not run for logged-out public cards. Ping history is public and shares capped request-manager-backed loads keyed by node, time range, and `maxCount`. Nodes requesting the same Ping window are combined into Metric Store calls with at most 50 deduplicated `entity_ids` each, then every response is partitioned by node before caching.

Exchange rates are loaded through `useDailyExchangeRates()` only when the active public surface can display a monetary value. Hidden logged-out prices and layouts without finance cards stay on local defaults without contacting exchange-rate providers; the finance helper still provides one shared in-flight request and a daily browser cache when rates are needed.

## Snapshot export

```text
SnapshotExportPanel
  -> AuthService permission check
  -> optional export secondary password
  -> Provider metadata lookup with snapshot export permission
  -> SnapshotService
  -> CSV helper / JSON download
```

## Audit logs

```text
AuditLogPanel
  -> AuthService permission check
  -> AuditService
  -> RequestManager
  -> Komari audit RPC
```

Changing pages or filters and unmounting the panel aborts the superseded request. Full export is paginated at 200 records per request, deduplicates overlapping IDs, yields between pages, and keeps at most 5,000 records in browser memory. Truncated JSON exports include the reported total and export limit in their metadata.

## Request lifecycle

History requests are keyed by record type, node UUID or batch scope, time range, and `maxCount`. The shared request manager deduplicates identical in-flight requests, enforces the global concurrency cap, applies timeout and exponential retry backoff with jitter, and exposes abort hooks used when shared load-history subscribers are released. Backoff waits are abortable, so navigation or cache release does not leave retries sleeping in the background.
