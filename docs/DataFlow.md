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
  -> useNodeLoadStats() / useNodePingStats() / PingChart / LoadChart
  -> metricRange / pingStats pure transforms
  -> optional AuthService permission check
  -> HistoryService
  -> RequestManager
  -> RPC / REST fallback
  -> PredictionService
```

Disk prediction uses `LOAD_RECORD_MAX_COUNT` by default, verifies the `diskPrediction` permission before loading private history, and does not run for logged-out public cards. Ping history is public and shares capped request-manager-backed loads keyed by node, time range, and `maxCount`. Nodes requesting the same Ping window are combined into Metric Store calls with at most 50 deduplicated `entity_ids` each, then every response is partitioned by node before caching.

LoadChart and PingChart share the same pure time-range validation/labeling layer and the same empty/error/retry UI contract. Ping percentile, volatility, loss and availability aggregation is framework-independent in `utils/pingStats.ts`; the composable only owns reactive subscriptions, cache persistence and lifecycle cleanup.

Exchange rates are loaded through `useDailyExchangeRates()` only when the active public surface can display a monetary value. Hidden logged-out prices and layouts without finance cards stay on local defaults without contacting exchange-rate providers; the finance helper still provides one shared in-flight request and a daily browser cache when rates are needed.

## Optional visitor data

```text
Header -- visitorInfoEnabled --> async VisitorInfo --> public IP providers
useVisitorPageAudit -- both audit switches enabled --> async visitorFingerprint --> visitor audit RPC
```

The visitor information component is not loaded while its theme setting is disabled. The security fingerprint module is imported only after both Komari's core visitor-audit setting and the Transit client setting allow an event; public routes with either switch disabled do not initialize WebRTC/WebGL fingerprint collection.

## Personal wallpaper

```text
Header -> async WallpaperManagerDialog -> usePersonalWallpaper()
  -> wallpaper.service.ts -> decode + validate -> IndexedDB
Background.vue <- shared reactive wallpaper state <- object URL
```

The selected image never enters a Komari API/RPC request. It is stored under the current origin in IndexedDB; the glass/blur/HD selection is stored in localStorage. Uploads are limited to supported raster MIME types, 15 MiB and 50 million decoded pixels. A replacement updates the visible object URL only after the new record commits, so decode, quota and transaction failures preserve the previous wallpaper. Object URLs are revoked after state replacement, image decoders are closed, and IndexedDB connections close after each transaction or a version-change request.

Managed URL and `local:` backgrounds remain the site-wide administrator path. A personal wallpaper takes visual precedence only in the browser that selected it and does not alter `publicSettings.theme_settings`.

## Managed theme writes

```text
TopologyManager / node maintenance
  -> saveManagedThemeSettings()
  -> AuthService forced verification
  -> RequestManager
  -> POST /api/admin/theme/settings?theme=Transit
  -> PUT /api/admin/theme/config?short=Transit (legacy 404/405 fallback only)
```

Komari 1.4 uses the `/settings` endpoint. Permission, validation and server errors are surfaced directly and never trigger the legacy fallback.

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

Detail charts add a component-local generation gate above shared requests. Rapid node/range changes and component disposal invalidate older generations, so late results cannot publish into the current view while the underlying request remains available to other deduplicated consumers. Metric Store compatibility fallback is restricted to explicit unsupported-method/route errors; authentication, cancellation, validation, timeout and server failures remain visible and never trigger a second private request.

The global live-status poller and shared load/Ping refresh schedulers pause while the page is hidden. Returning to the foreground triggers an immediate status and node-metadata refresh before normal scheduling resumes. KeepAlive also pauses the home summary clock while the home route is inactive.

## Server ordering

```text
HomeView / ServerListPanel / NodeList
  -> useOrderMoveFeedback() + useSortableOrder()
  -> useServerList()
  -> server-list.service.ts
  -> admin:orderClients
  -> nodesStore.applyNodeOrder()
```

Editing always expands to the complete official node order. Cancel restores the prior search/filter/sort context. Failed saves leave the draft intact for retry; successful saves update the reactive node weights immediately, and a later metadata refresh or page reload reads the same order back from Komari.
