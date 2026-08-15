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

Disk prediction uses `LOAD_RECORD_MAX_COUNT` by default, verifies the `diskPrediction` permission before loading private history, and does not run for logged-out public cards. Ping history is public and shares capped request-manager-backed loads keyed by node, time range, and `maxCount`. Nodes requesting the same Ping window are combined into Metric Store calls with `entity_ids`, then the response is partitioned by node before caching.

## Snapshot export

```text
SnapshotExportPanel
  -> AuthService permission check
  -> optional export secondary password
  -> Provider metadata lookup with snapshot export permission
  -> SnapshotService
  -> CSV helper / JSON download
```

## Request lifecycle

History requests are keyed by record type, node UUID or batch scope, time range, and `maxCount`. The shared request manager deduplicates identical in-flight requests, enforces the global concurrency cap, applies timeout and exponential retry backoff with jitter, and exposes abort hooks used when shared load-history subscribers are released. Backoff waits are abortable, so navigation or cache release does not leave retries sleeping in the background.
