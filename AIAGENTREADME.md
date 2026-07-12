# AI Agent README

> 面向 Claude Code、Cursor、Copilot、Codeium、OpenDevin 等 AI 编程代理的项目手册。人类二开也可以把它当作架构说明和开发路线图使用。

## 0. AI 开发前必须做的事

1. 先读本文件，再读最近作用域的 `AGENTS.md`。
2. 读 [AICACHE.md](AICACHE.md)，确认当前待办、已做、验证结果、风险点。
3. 修改前先判断改动属于哪类：
   - **M2**：只优化性能，不改交互。
   - **M3**：只加强安全与权限。
   - **M4**：只改 UI/UX。
   - **M5**：新增功能。
   - **M6**：文档、测试与开发者体验。
4. 开发中如果任务会跨文件或容易中断，把计划和进度写进 [AICACHE.md](AICACHE.md)。
5. 结束前把 [AICACHE.md](AICACHE.md) 更新为可交接状态：做了什么、没做什么、验证了什么、下一步是什么。

## 1. 项目是什么

**Komari Glassmorphism** 是一个 Komari Monitor 主题，使用 Vue 3 + Vite 构建。它的发布产物是 Komari 可以导入的 zip 包，不是普通 Web App 部署包。

关键事实：

- 主题清单：[komari-theme.json](komari-theme.json)。这是发布输入，不是可选元数据。
- 版本唯一来源：[komari-theme.json](komari-theme.json) 的 `version`。
- 不要在 [package.json](package.json) 重新添加顶层 `version`。
- 打包产物：`komari-theme-Glassmorphism-build-<short-sha>.zip`。
- zip 内固定包含：`komari-theme.json`、`preview.png`、`dist/`。
- `preview.png` 来自 [docs/preview.png](docs/preview.png)，打包时重命名。

## 2. 技术栈

- Vue 3 + `<script setup lang="ts">`
- Vite
- Bun，见 [package.json](package.json) 的 `packageManager` 与 `engines`
- Pinia setup stores
- Vue Router，仅两个公开路由
- Tailwind CSS v4，CSS-first 配置在 [src/styles/main.css](src/styles/main.css)
- reka-ui + 本地 shadcn-vue 风格组件库：[src/components/ui/](src/components/ui/)
- Iconify 图标：`@iconify/vue`
- ECharts / vue-echarts 图表
- cobe / three / globe 相关地球展示
- vue-sonner toast，通过 `window.$message` 暴露

明确禁止：

- 不要引入 Naive UI。
- 不要引入 UnoCSS。
- 不要使用 SCSS。
- 不要重新引入 `lucide-vue-next` 或其他 icon-as-component 包。
- 不要添加不存在的测试命令，例如 `bun test`。

## 3. 常用命令

必须在仓库根目录运行：

```bash
bun run dev       # Vite dev server，代理 /api 到配置目标
bun run build     # vue-tsc --build + vite build + zip packaging
bun run preview   # 预览 production build
bun run lint      # eslint --fix --cache
```

当前没有测试套件。验证源码变更通常只跑：

```bash
bun run lint
bun run build
```

## 4. 根目录地图

```text
.
├── AIAGENTREADME.md          # AI/二开总手册
├── AICACHE.md                # AI 工作缓存、待办、交接日志
├── CLAUDE.md                 # Claude Code 入口指令，指向本文件
├── AGENTS.md                 # 根作用域 agent 指令
├── src/AGENTS.md             # src 子树作用域 agent 指令
├── komari-theme.json         # 主题清单、版本和托管配置 schema
├── vite.config.ts            # Vite、manual chunks、zip packaging
├── package.json              # Bun scripts 与依赖
├── docs/                     # 架构、认证、缓存、数据流、迁移、里程碑文档
├── public/images/            # 运行时图片契约，代码按路径拼接访问
└── src/                      # 应用源码
```

## 5. 发布与打包契约

`bun run build` 必须保留 [vite.config.ts](vite.config.ts) 里的 Komari zip 插件流程。

成功后根目录应有：

- `dist/`
- `komari-theme-Glassmorphism-build-<short-sha>.zip`

zip 固定结构：

```text
komari-theme.json
preview.png
dist/
```

Vite 注入的全局常量：

- `__BUILD_VERSION__`：来自 [komari-theme.json](komari-theme.json)
- `__BUILD_GIT_HASH__`：来自 git short hash

类型声明在 [src/types/global.d.ts](src/types/global.d.ts)。

发布注意：

- GitHub Release 自动化必须读取 `komari-theme.json.version`。
- 改 release workflow 或 bump 版本后，不要只信本地 build，要检查 GitHub Actions 和 Release assets。
- 如果已发布构建坏了，应该 bump patch version 后发布新 Release，不要静默依赖旧失败 tag。

## 6. v3 总架构

新代码遵循：

```text
Vue Component
  -> Composable
  -> Service
  -> RequestManager / CacheService
  -> API / RPC
  -> Komari backend
```

职责边界：

| 层            | 位置                                     | 责任                                           | 不应该做什么                                          |
| ------------- | ---------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Component     | `src/components/`, `src/views/`          | 渲染 UI、组合 composable/service               | 不写业务流程、不直接解析 `theme_settings`、不自建缓存 |
| Composable    | `src/composables/`                       | Vue 响应式状态、生命周期、watch、订阅清理      | 不放跨业务服务逻辑                                    |
| Service       | `src/services/`                          | 认证、缓存、请求、历史、预测、快照、厂商元数据 | 不直接渲染 UI                                         |
| Request/Cache | `request.service.ts`, `cache.service.ts` | 去重、并发、超时、重试、TTL、引用计数          | 不感知具体组件                                        |
| API/RPC       | `src/utils/api.ts`, `src/utils/rpc.ts`   | Komari HTTP/RPC 低层客户端                     | 不放业务规则                                          |
| Utils         | `src/utils/`                             | 纯 helper，如格式化、CSV、record transform     | 不新增业务工作流                                      |
| Constants     | `src/constants/`                         | 共享限制、时间、缓存、安全、UI 参数            | 不散落 magic number                                   |

相关架构文档：

- [docs/Architecture.md](docs/Architecture.md)
- [docs/DataFlow.md](docs/DataFlow.md)
- [docs/Auth.md](docs/Auth.md)
- [docs/Cache.md](docs/Cache.md)
- [docs/Migration-v3.md](docs/Migration-v3.md)
- [docs/Milestones-v3.md](docs/Milestones-v3.md)

## 7. App shell 与路由

- [src/main.ts](src/main.ts)：bootstrap only。只安装 Pinia/router、加载全局样式、设置 `window.$message`、执行 `setupIconify()`、挂载 App。
- [src/App.vue](src/App.vue)：全局布局、`<Toaster>`、`Provider`、`initApp()` / `destroyInitManager()`、`KeepAlive` HomeView。
- [src/router/index.ts](src/router/index.ts)：只保留两个 lazy route：
  - `/` -> `HomeView`
  - `/instance/:id` -> `InstanceDetail`
- 不要加全局 router guard。公开首页/详情页必须保持公开，敏感数据路径自己做权限 gate。

## 8. 状态管理

### 8.1 app store

位置：[src/stores/app.ts](src/stores/app.ts)

职责：

- public settings
- theme settings 归一化
- 登录/认证状态
- layout flags
- 格式化偏好
- theme mode
- private feature flags
- `requireLoginPermission()`

规则：

- `publicSettings.theme_settings` 必须防御性解析。
- schema 与默认值在 [komari-theme.json](komari-theme.json) 的 `configuration.data`。
- 组件只消费 app store 暴露的归一化字段。

### 8.2 nodes store

位置：[src/stores/nodes.ts](src/stores/nodes.ts)

职责：

- normalized nodes
- visible nodes
- group derivation
- WebSocket/polling state
- live update application

关键规则：

- UUID index 必须指向 `nodes.value` 中的 Vue 响应式对象。
- 不能索引插入前的 raw object，否则实时 CPU、上下行、内存等不会刷新 UI。
- 改 `nodes.ts`、`init.ts`、实时 metric 渲染后，要在运行 app 验证实时更新无需刷新浏览器。

## 9. 服务层说明

### 9.1 Auth service

文件：[src/services/auth.service.ts](src/services/auth.service.ts)

- 通过 `/api/me` 验证登录状态。
- 有 session TTL，减少重复验证。
- 暴露 typed permission keys。
- app store 的 `requireLoginPermission()` 应优先使用。

权限键包括：

- `advancedTools`
- `snapshotExport`
- `healthSummary`
- `providerValue`
- `nodeTopology`
- `diskPrediction`
- `providerGeoLookup`
- `historyMetrics`

### 9.2 RequestManager

文件：[src/services/request.service.ts](src/services/request.service.ts)

能力：

- keyed request dedupe
- concurrency limit
- timeout
- retry
- abort
- queue draining

历史数据和重请求路径应该走它。

### 9.3 CacheService

文件：[src/services/cache.service.ts](src/services/cache.service.ts)

能力：

- TTL
- LRU-like eviction
- reference counting
- cleanup timer
- promise dedupe

不要在组件里新增 provider/history/request 的 ad-hoc cache。

### 9.4 History / prediction

文件：

- [src/services/history.service.ts](src/services/history.service.ts)
- [src/services/prediction.service.ts](src/services/prediction.service.ts)

规则：

- history cache/request key 必须包含 record type、uuid、hours、`maxCount`。
- capped prediction samples 不能复用为 uncapped chart data。
- 磁盘预测属于敏感历史路径，必须登录后运行。

### 9.5 Provider metadata

文件：[src/services/provider.service.ts](src/services/provider.service.ts)

规则：

- public metadata-only 和 private geo-enriched 必须用不同 cache key。
- `allowGeoLookup` 必须进入 fingerprint/cache key。
- Geo lookup 必须和 `privateFeaturesAllowed` / permission check 绑定。

### 9.6 Snapshot export

文件：

- [src/services/snapshot.service.ts](src/services/snapshot.service.ts)
- [src/utils/csv.ts](src/utils/csv.ts)

规则：

- 导出前验证 `snapshotExport` 权限。
- 如果配置了 `exportSecondaryPassword`，UI 要额外要求输入。
- CSV 必须中和公式注入前缀：`=`、`+`、`-`、`@`、`|`，并识别前导空白、BOM、NBSP 绕过。
- CSV 单元格必须按 RFC 4180 处理双引号、逗号、回车和换行：双引号写成 `""`，含特殊字符的字段整体用双引号包裹，不能把换行伪造成新行。
- 二级密码只是客户端摩擦层，不是强安全边界。

## 10. UI 写法

本项目已经迁移到 reka-ui + Tailwind CSS v4。

组件优先级：

1. 先组合 [src/components/ui/](src/components/ui/) 已有 primitives。
2. 缺 primitive 时按 shadcn-vue 风格新增：reka-ui + cva + `cn()`。
3. 不要引入新组件库。
4. 不要写 SCSS。
5. Tailwind utilities 优先，必要时才用 scoped style。

图标：

```vue
<Icon icon="lucide:x" />

<Icon icon="tabler:server" />
```

只用 `@iconify/vue`。

Toast：

```ts
window.$message?.success('完成')
window.$message?.warning('请先登录')
```

只有 `window.$message`，没有 `$dialog`、`$notification`、`$loadingBar`。

## 11. 运行时图片契约

[public/images/](public/images/) 里的文件名是运行时契约，代码按字符串拼路径访问，不是 import。

重要路径：

- `/images/flags/<UPPERCASE_CODE>.svg`
- `/images/logo/os-*.{svg,png,ico}`

不要随意重命名、移动、大小写归一化。改 public images 前必须先查 `src/` 引用和 helper mapping：

- [src/utils/regionHelper.ts](src/utils/regionHelper.ts)
- [src/utils/osImageHelper.ts](src/utils/osImageHelper.ts)

## 12. 功能开发路径

### 12.1 新增普通 UI 功能

1. 在 app store 中确认是否已有设置或状态。
2. 若需要配置，先改 [komari-theme.json](komari-theme.json) schema，再在 [src/stores/app.ts](src/stores/app.ts) 做防御性解析。
3. 视图只做编排，组件只做展示。
4. 优先复用 `src/components/ui/`。
5. 跑 `bun run lint` 和 `bun run build`。
6. 更新 [AICACHE.md](AICACHE.md)。

### 12.2 新增需要请求的数据功能

1. 先判断是否敏感。
2. 敏感则定义/复用 `PermissionKey`。
3. 低层 API/RPC 只放在 `src/utils/api.ts` / `src/utils/rpc.ts`。
4. 业务请求封装进 `src/services/*`。
5. Vue lifecycle/状态封装进 composable。
6. 组件只消费 composable/service 输出。
7. 缓存走 `cache.service.ts`，请求去重走 `request.service.ts`。
8. key 必须包含影响结果的所有维度。

### 12.3 新增高级工具

推荐路径：

```text
HomeView tool button
  -> permission map
  -> async component panel
  -> panel composable/service
  -> shared service/cache/request
```

要求：

- 未登录不显示或阻止。
- 点击时 `force: true` 验证登录。
- 后台敏感加载可用 `force: false` 复用 TTL。
- 失败时提示且不要破坏公共 dashboard。

### 12.4 改实时数据更新

重点文件：

- [src/utils/init.ts](src/utils/init.ts)
- [src/stores/nodes.ts](src/stores/nodes.ts)
- 卡片/总览/list metric 组件

验证：

- CPU、内存、磁盘、`net_in`、`net_out` 不刷新浏览器也变化。
- WebSocket 失败时 HTTP fallback 可用。
- UUID index 仍指向 reactive object。

### 12.5 改发布逻辑或版本

1. 只改 [komari-theme.json](komari-theme.json) 的 `version`。
2. 不要给 [package.json](package.json) 加顶层 version。
3. 本地跑 `bun run build`。
4. 推送后查 GitHub Actions。
5. 查 Release tag 和 zip asset。
6. 在 [AICACHE.md](AICACHE.md) 记录验证链接/结果。

## 13. 里程碑边界

详见 [docs/Milestones-v3.md](docs/Milestones-v3.md)。开发时不要混淆：

- M2：性能优化，不改变用户交互。
- M3：安全权限，不做 UI 花活。
- M4：UI/UX，不新增业务功能。
- M5：新增功能，必须补权限/缓存/文档。
- M6：文档、验证、DX。

## 14. 安全规则

- 公开首页和详情页必须继续公开。
- 不要加 router guard 来挡页面。
- 敏感数据和敏感动作在数据/动作入口 gate。
- `isLoggedIn` 不等于权限；使用 `requireLoginPermission()`。
- session 过期时要降级到公共展示，不要让 dashboard 崩掉。
- Provider Geo、snapshot export、history metrics、disk prediction、advanced tools 都是敏感路径。
- Managed markdown 不用 `v-html`，链接/图片要限制 URL scheme。
- CSV 导出必须防公式注入。

## 15. 性能规则

- 大量节点列表用虚拟列表。
- history-heavy 请求走 RequestManager。
- provider/history 缓存走 CacheService 或已有共享缓存模式。
- 不要在每个节点组件里重复打同一个历史接口。
- `maxCount`、hours、uuid、record type 都要进入 key。
- 大 chunk 警告不是立刻失败，但新增大依赖前必须检查 manual chunks。

## 16. 文档与 AICACHE 工作流

[AICACHE.md](AICACHE.md) 是 AI 工作缓存，不是用户文档。用途：

- 防止 AI 会话中断、断网、上下文丢失。
- 方便其他 AI 或人类二开接手。
- 记录“准备做什么、已经做了什么、验证结果、风险点、下一步”。

每次较大任务建议更新：

```text
## 当前任务
- 目标：
- 范围：
- 不做：
- 状态：planned / in-progress / blocked / done

## 执行日志
- YYYY-MM-DD HH:mm：做了什么，改了哪些文件

## 验证
- 命令：
- 结果：
- 警告：

## 交接
- 已完成：
- 未完成：
- 风险：
- 下一步：
```

不要把密钥、token、私有服务器密码写进 AICACHE。

## 17. 常见反模式

- 在组件里直接 `fetch` 或直接 `rpc.getClient().call()` 写业务逻辑。
- 在组件里解析 raw `theme_settings`。
- 添加 ad-hoc Map cache，不走共享 cache/request 体系。
- 把私有功能做成只隐藏按钮，不做真正 permission check。
- 修改 public image 文件名但不改 helper mapping。
- 新增大依赖但不检查 Vite manual chunks。
- 把 release version 放到 package.json。
- 用本地 build 成功代替 Release 检查。
- 修改 default card size，让 `mini` 替代或缩水 `compact`。

## 18. 最小交接清单

一个 AI 完成任务前，至少确认：

- [ ] 代码符合分层：Component -> Composable -> Service -> Request/Cache -> API/RPC。
- [ ] 敏感功能有权限验证。
- [ ] theme setting 已在 app store 归一化。
- [ ] 没引入 Naive UI / UnoCSS / SCSS / lucide-vue-next。
- [ ] `bun run lint` 已跑，或说明未跑原因。
- [ ] `bun run build` 已跑，或说明未跑原因。
- [ ] [AICACHE.md](AICACHE.md) 已更新。
