# Transit Architecture

Transit organizes new code around a layered architecture:

```text
Vue Component
  -> Composable (reactive state and lifecycle)
  -> Service (business logic)
  -> RequestManager / CacheService
  -> API / RPC
  -> Komari backend
```

## Rules

- Components render UI and invoke composables or services.
- Composables own `ref`, `computed`, `watch`, subscriptions, and lifecycle cleanup.
- Services own business logic such as auth, provider metadata, history loading, prediction, snapshot export, cache, and request orchestration.
- Constants belong in `src/constants/`; avoid new magic numbers in components.
- Utils stay pure and framework-light.
- Public routes remain public; sensitive operations require verified auth through the auth service.

## Foundation directories

- `src/services/` — business and infrastructure services.
- `src/constants/` — grouped runtime and architecture constants.
- `src/hooks/` — reserved for future cross-cutting hooks.
- `src/workers/` — reserved for future Web Worker workloads.
- `src/types/` — shared type entry point.

## Core services

- `auth.service.ts` — verified session state, login verification, and permission checks.
- `cache.service.ts` — shared TTL/LRU/reference-counted cache and promise deduplication helper.
- `request.service.ts` — keyed request deduplication, concurrency limiting, abort, timeout, and retry policy.
- `history.service.ts` — load/ping history normalization and request-manager-backed data fetching.
- `prediction.service.ts` — disk growth prediction from normalized history records.
- `provider.service.ts` — provider and geo metadata composition.
- `snapshot.service.ts` — JSON/CSV export composition and download boundary.
- `node-card-panel.service.ts` — permission-checked persistence for per-node and grouped card-panel preferences.

## Focused source modules

- `stores/app.types.ts` — app store 的公开类型契约；运行时配置归一化仍由 `stores/app.ts` 统一负责。
- `utils/metricRange.ts` — 负载图和延迟图共用的时间范围生成、校验与格式化纯函数。
- `utils/pingStats.ts` — Ping 历史分桶、百分位、丢包、可用性与 Metric Store 聚合纯计算。
- `composables/useOrderMoveFeedback.ts` — 首页、列表与服务器清单共用的键盘移动、拖动反馈和读屏公告逻辑。
- `components/AsyncDataState.vue` — 负载图和延迟图共用的空状态、错误状态与重试入口。
- `utils/nodeCardPanel.ts` — 节点面板配置校验、UUID 覆盖、自动模式选择和序列化纯函数。

Heavy Globe、ECharts、地图与详情图表继续通过路由或异步组件按需加载。访客公网信息组件仅在配置启用后加载，访客安全指纹采集器仅在审计事件确实需要安全资料时加载。首屏审计禁止 `echarts`、`globe`、详情历史图表、访客信息和访客指纹进入 module preload，并检查入口资源不含访客 IP 服务或指纹采集代码；预算以 145 KiB gzip 为优化目标、165 KiB 为硬上限。

## Current M2-M6 scope

Future work builds on this foundation without changing the public route contract:

- M2 keeps user interactions stable while routing history-heavy paths through shared request/cache infrastructure and virtualizing dense lists.
- M3 gates private tools, sensitive metadata, snapshot export, and disk prediction through verified auth; ordinary node and Ping history metrics stay public.
- M4 adds configurable presentation options such as card density, quick controls, detail tabs, list metadata, glass colors, and privacy display toggles.
- M5 adds advanced home tools: topology, provider value, health summary, snapshot export, disk prediction, and richer summary cards.
- M6 documents the architecture, auth, cache, data flow, migration behavior, and milestone acceptance points.

New work should continue to use the same layered chain rather than reintroducing component-local request, cache, or permission logic.
