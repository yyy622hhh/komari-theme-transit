# Source AGENTS.md

This guide applies to [src/](./). For full project context, read [../AIAGENTREADME.md](../AIAGENTREADME.md). For current work handoff, read/update [../AICACHE.md](../AICACHE.md).

## Source-tree rule of thumb

All new app code should follow:

```text
Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC
```

Do not bypass this chain unless you are editing bootstrap/transport glue that already lives at a lower layer.

## Where code belongs

- `main.ts` — bootstrap only: create Vue app, install Pinia/router, load styles, set `window.$message`, run `setupIconify()`, mount App.
- `App.vue` — app shell: layout, `<Toaster>`, `Provider`, `initApp()` / `destroyInitManager()`, `KeepAlive` for `HomeView`.
- `router/` — exactly two public lazy routes: `/` and `/instance/:id`. Do not add broad router guards.
- `views/` — route-level orchestration only.
- `components/` — presentation and local UI composition.
- `components/ui/` — local shadcn-vue-style primitives based on reka-ui + cva + `cn()`.
- `composables/` — Vue state/lifecycle glue: `ref`, `computed`, `watch`, subscriptions, `onScopeDispose`.
- `services/` — auth, provider metadata, history loading, prediction, snapshot export, request/cache orchestration.
- `constants/` — grouped limits, timeouts, cache/security/request/UI settings.
- `stores/` — Pinia setup stores and source-of-truth app/node state.
- `utils/` — pure helpers, formatting, CSV escaping, low-level API/RPC clients.

## Stores

- [stores/app.ts](stores/app.ts) owns public settings, normalized theme settings, login/auth state, layout flags, formatting preferences, theme mode, persisted UI state, and permission helpers.
- [stores/nodes.ts](stores/nodes.ts) owns normalized nodes, visible nodes, groups, WebSocket state, and live updates.

Rules:

- Components must not parse raw `publicSettings.theme_settings`; normalize once in `stores/app.ts`.
- Public home/detail rendering remains available when auth is missing or expired.
- Private surfaces use `appStore.privateFeaturesAllowed` plus verified permission checks.
- Node UUID indexes must store the reactive object from `nodes.value`, not raw objects, so live CPU/network metrics update correctly.
- `nodeCardSize` default stays `compact`; `mini` is optional high-density mode.

## Private features and export security

Sensitive operations must call `appStore.requireLoginPermission()` or auth-service permission helpers before work starts.

Protected paths include:

- Advanced home tools: topology, provider value, health summary, snapshot export.
- Snapshot export and export-specific provider metadata.
- Disk-prediction history loading.
- Provider geo lookup.
- Ping/history metric loading.

Export rules:

- `exportSecondaryPassword` is optional and adds a client-side friction layer after verified login.
- It is not a replacement for backend authorization.
- CSV export must go through `services/snapshot.service.ts` and `utils/csv.ts`.
- CSV cells starting with `=`, `+`, `-`, or `@` must be neutralized.

## Services and request/cache rules

- Use `services/auth.service.ts` for verified auth/session state.
- Use `services/request.service.ts` for keyed request dedupe, concurrency, timeout, retry, and abort.
- Use `services/cache.service.ts` for shared cache lifecycle and promise dedupe.
- Use `services/history.service.ts` for load/ping history.
- Use `services/prediction.service.ts` for disk prediction.
- Use `services/provider.service.ts` for provider/geo metadata rules.
- Use `services/snapshot.service.ts` for export composition/download boundary.

Cache/request keys must include every dimension that changes the result, especially:

- record type
- node UUID
- time range / hours
- `maxCount`
- public metadata-only vs private geo-enriched mode

## UI rules

- Use Composition API with `<script setup lang="ts">`.
- Prefer `@/` imports for source-local files.
- Compose existing primitives from `components/ui/` before adding new UI components.
- If a primitive is missing, follow the existing pattern: reka-ui + class-variance-authority + `cn()`.
- Do not introduce Naive UI, UnoCSS, SCSS, or a new component library.
- Component styling should use Tailwind utilities and design tokens from `styles/main.css`.
- Use `@iconify/vue` for all icons. Lucide icons use the `lucide:` prefix.
- Only app global is `window.$message`; do not assume `$dialog`, `$notification`, `$loadingBar`, or `$modal`.

## Views and async components

- Keep `defineOptions({ name: 'HomeView' })` in `HomeView.vue`, because `App.vue` KeepAlive includes `HomeView` by name.
- Heavy node/chart UI should stay lazy-loaded with `defineAsyncComponent` from views.
- Views coordinate store/composable state; they should not own reusable business logic.

## Transport and startup

- Low-level HTTP API lives in `utils/api.ts`.
- Low-level RPC lives in `utils/rpc.ts`.
- Startup, polling, reconnects, transport selection, and WebSocket fallback live in `utils/init.ts` unless a clear service boundary exists.
- `rpcTransportMode` is user-configurable through the theme manifest.

## Runtime assets

`public/images/` filenames are runtime contracts. Code builds URLs from values rather than importing assets.

- Flags: `/images/flags/<UPPERCASE_CODE>.svg`, used by `utils/regionHelper.ts`.
- OS logos: `/images/logo/os-*`, used by `utils/osImageHelper.ts`.

Do not rename/move these files without updating helper mappings and checking all references.

## Validation

For source changes, run from repo root:

```bash
bun run lint
bun run build
```

There is no test suite. Do not invent one.

Update [../AICACHE.md](../AICACHE.md) with validation results or explain why validation was skipped.
