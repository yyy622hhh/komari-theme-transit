# Transit for Komari

> A topology-first network operations theme for Komari.

[![Release](https://img.shields.io/github/v/release/yyy622hhh/komari-theme-transit?style=flat-square&color=10b981)](https://github.com/yyy622hhh/komari-theme-transit/releases)
[![Quality](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/quality.yml?branch=main&style=flat-square&label=quality)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/quality.yml)
[![Visual Regression](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/visual-regression.yml?branch=main&style=flat-square&label=visual)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/visual-regression.yml)
[![License](https://img.shields.io/github/license/yyy622hhh/komari-theme-transit?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)

Transit 是一个面向多节点、多线路和跨境链路监控的 Komari 社区主题。它把“入口 → 线路机 → 落地机”的链路拓扑、北京/上海/广州三网 Ping、实时资源、异常告警和资产信息放进同一套紧凑界面，并提供可视化拓扑管理器。

![Transit 暗色总览](docs/screenshots/transit-overview-dark.png)

## 为什么使用 Transit

- **拓扑优先**：一眼看清用户入口、线路机、落地机以及每一段链路的延迟和丢包。
- **可视化配置**：不需要手写配置即可添加、排序和删除线路，选择节点并绑定实时 Ping 任务。
- **三网质量**：节点卡片集中展示联通、电信、移动的延迟、丢包和近期采样。
- **统一采样交互**：鼠标悬停显示时间、延迟与丢包；移动端可点击固定浮窗。
- **运维视角**：提供异常摘要、线路可靠性、维护状态、事件时间线、健康统计和审计日志。
- **资产视角**：同时展示价格、剩余价值、到期日、流量配额和厂商信息。
- **原生服务器列表**：登录后可查看实时服务器清单、筛选与排序，并直接保存首页顺序；其余配置管理仍沿用 Komari 自带后台。
- **本机壁纸**：可在顶部上传当前浏览器专用的 JPG、PNG、WebP 或 AVIF 壁纸，并切换玻璃化、模糊和高清效果。
- **隐私默认关闭**：公网信息查询和 Transit 访客审计均为明确选择加入，默认不会触发。

## 功能一览

| 区域     | 能力                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 线路状态 | 多线路拓扑、入口探测点切换、逐段实时/静态指标、采样浮窗、历史详情、健康评分        |
| 拓扑管理 | 添加/删除/排序线路、选择线路机与落地机、绑定 Ping 任务、备用延迟与丢包、保存和恢复 |
| 节点卡片 | CPU、内存、硬盘、上下行、累计流量、到期信息、价格和三网质量                        |
| 告警     | 离线、高负载、流量预警、即将到期、Ping 丢包、维护状态和异常时间线                  |
| 首页工具 | 服务器列表、节点对比、厂商性价比、健康摘要、快照导出、网络信息和核心审计日志       |
| 节点详情 | 自定义概览卡、完整负载图、Ping 延迟/丢包历史、GPU 与磁盘耗尽预测                   |
| 显示     | 亮色/暗色/北京时间自动模式、本机壁纸与三种效果、四档卡片密度和移动端布局           |

## 界面预览

| 暗色总览                                                        | 亮色总览                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| ![Transit 暗色总览](docs/screenshots/transit-overview-dark.png) | ![Transit 亮色总览](docs/screenshots/transit-overview-light.png) |

### 可视化拓扑管理器

登录后点击“线路状态”右上角的“管理”，即可直接维护所有线路和每一段指标。修改会保存到 Komari 托管主题设置，并同步到所有设备。

![Transit 拓扑管理器](docs/screenshots/transit-topology-manager.png)

## 快速开始

1. 前往 [Releases](https://github.com/yyy622hhh/komari-theme-transit/releases) 下载最新的 `komari-theme-Transit-build-*.zip`。
2. 登录 Komari 管理后台，在主题管理中上传这个 zip；不要上传 GitHub 自动生成的源码压缩包。
3. 启用短名称为 `Transit` 的主题。
4. 打开主题设置，选择主题模式、节点卡密度和三网地区。
5. 新安装不会预置任何真实节点；返回首页，按“还没有配置线路”的引导创建第一条拓扑并保存。

发布 zip 的根目录固定为：

```text
komari-theme.json
preview.png
dist/
```

Transit 使用独立短名称 `Transit`，不会覆盖已有的 PandaOps、Glassmorphism 或其他主题目录。

## 拓扑管理器

### 使用前准备

实时链路指标来自 Komari Ping 任务。建议先在 Komari 后台建立需要的任务，并确认负责探测的节点已经上报过样本。常见任务包括：

- 北京电信、北京联通、北京移动
- 上海电信、上海联通、上海移动
- 广东电信、广东联通、广东移动
- 线路机到落地机的自定义任务，例如 `Relay-JP-to-Exit-US`

任务名称可以自定义，但管理器绑定时必须选择或填写准确名称。

### 配置一条线路

一条完整线路最多包含三个位置：

```text
入口 → 线路机 → 落地机
```

| 字段        | 说明                                                                     |
| ----------- | ------------------------------------------------------------------------ |
| 入口        | 可填写“北京电信”等逻辑入口，也可在首页从北京、上海、广州三网探测点中切换 |
| 线路机      | 从 Komari 节点列表选择承担中转或入口职责的服务器                         |
| 落地机      | 从 Komari 节点列表选择最终出口服务器                                     |
| 角色        | 自定义显示文字，默认使用“入口”“线路机”“落地机”                           |
| 第 1 段指标 | 表示入口到线路机的延迟和丢包                                             |
| 第 2 段指标 | 表示线路机到落地机的延迟和丢包                                           |

每条线路至少需要两个名称不同的节点。管理器会阻止缺少实时任务来源、节点重复或节点数量不足的配置。

### 实时任务与静态基线

每一段都可以独立选择两种模式：

- **实时任务**：选择探测来源节点，再选择该节点可用的 Ping 任务。主题会读取最新样本和历史波动。
- **静态基线**：直接填写延迟和丢包，适合暂时没有对应 Ping 任务的链路。

实时任务还可以填写备用延迟和备用丢包。任务尚未产生样本、查询失败或短暂不可用时，页面使用备用值维持拓扑可读性，而不会伪造历史采样。

如果下拉框没有列出任务：

1. 确认“探测来源节点”选择正确。
2. 确认该任务包含此来源节点并已经产生 Ping 数据。
3. 仍未列出时，可以手动输入任务的精确名称。

### 多线路操作

- “添加线路”创建新的三段式线路。
- 右上角箭头调整线路顺序。
- 删除按钮只删除当前编辑副本，点击“保存并应用”后才会写入 Komari。
- “恢复已保存配置”放弃当前未保存修改并重新载入线上配置。
- “保存并应用”通过 Komari 管理接口写入当前主题设置，所有浏览器和设备同步生效。

只有已登录管理员可以保存。公开访客可以查看允许公开的线路状态，但不能修改主题配置。

### 入口探测点切换

每条拓扑线路左侧的入口下拉框支持：

- 北京：电信、联通、移动
- 上海：电信、联通、移动
- 广州：电信、联通、移动

切换后主题会为入口段匹配对应 Ping 任务。广州探测点在任务匹配时使用“广东电信/联通/移动”名称。

### 高级文本格式

推荐使用可视化管理器。需要迁移、排障或批量维护时，也可以直接编辑主题设置中的 `topologyRoute` 和 `topologyMetrics`。

线路格式：

```text
节点名称|地区代码|角色;节点名称|地区代码|角色
```

多条线路使用 `||` 分隔：

```text
北京电信|CN|入口;Relay-JP|JP|线路机;Exit-US|US|落地机||上海联通|CN|入口;Relay-SG|SG|线路机;Exit-DE|DE|落地机
```

静态指标格式为 `延迟,丢包`，同一线路的两段使用 `;` 分隔：

```text
51,0;84,0||148,0;1.1,0
```

实时指标格式为：

```text
live@探测来源节点@Ping任务名称@备用延迟@备用丢包
```

完整示例：

```text
live@Relay-JP@北京电信@51@0;live@Relay-JP@Relay-JP-to-Exit-US@84@0||live@Relay-SG@上海联通@72@0;live@Relay-SG@Relay-SG-to-Exit-DE@165@0
```

使用 `-` 表示没有备用值。旧版 `live@节点@地区@运营商@备用延迟@备用丢包` 格式仍可读取。

## 三网质量与采样交互

节点卡片可以显示北京、上海、广东或全部地区的联通、电信、移动质量。每一行同时包含：

- 当前延迟
- 当前丢包率
- 最近一组采样格
- 按延迟、丢包和缺失数据计算的状态颜色

桌面端将鼠标放到采样格上即可查看时间、延迟和丢包；点击可以固定浮窗。移动端直接点击采样格查看，点击空白处关闭。拓扑、节点卡和详情页使用同一套采样交互。

## 告警、可靠性与运维工具

Transit 不只展示在线/离线状态，还会把可操作信息集中到首页：

- **异常摘要**：汇总离线、高负载、Ping 丢包、流量预警和即将到期节点。
- **事件时间线**：查看节点异常、恢复和维护事件。
- **线路可靠性**：按有效采样、延迟和丢包计算线路评分，并展示每一段的数据覆盖情况。
- **节点维护**：管理员可以为节点设置维护状态，保存后立即影响告警判断。
- **服务器列表**：按名称、地区、IP、系统和 CPU 搜索，筛选状态，按官方顺序或实时指标升降序排列；管理员可调整并保存首页全局顺序。
- **节点对比**：比较多个节点的资源、流量、价格和网络数据。
- **健康摘要**：切换日、周、月区间查看历史健康情况。
- **厂商性价比**：按价格、资源和剩余价值排序节点。
- **快照导出**：导出当前监控快照的 CSV 或 JSON。
- **审计日志**：读取 Komari 核心管理员操作日志，不虚构服务端未提供的访客记录；浏览器单次导出最多 5,000 条并标记是否截断，避免大日志库耗尽页面内存。
- **磁盘预测**：样本充足时按历史增长趋势估算磁盘耗尽时间。

高级工具默认只向已登录用户显示，权限校验以 Komari `/api/me` 和服务端接口为准。隐藏按钮、前端状态和本地设置都不是安全边界。

## 主题设置

### 本机壁纸

点击顶部“壁纸与背景效果”按钮即可选择图片。原图保存在当前浏览器的 IndexedDB 中，不会提交给 Komari 或第三方；刷新页面后仍会保留，但其他浏览器、设备和访客不会自动同步。支持 JPG、PNG、WebP、AVIF，单张最大 15 MB、解码后最大 5,000 万像素。

- **玻璃化**：保持壁纸清晰，并加强前景卡片的毛玻璃层次。
- **模糊**：对背景使用 16px 柔焦，降低复杂画面对内容的干扰。
- **高清**：按原图显示，不增加模糊或额外滤镜。

“更换壁纸”只有在新图片完成解码并成功写入浏览器存储后才替换旧图；失败时原壁纸仍会保留。清理站点数据、浏览器无可用存储空间或使用隐私模式时，可能需要重新选择。站点管理员如需给所有访客统一配置背景，仍使用下方的托管 URL/`local:` 背景设置。

Transit 的托管设置按使用路径分为八组：

| 分组                | 主要内容                                               |
| ------------------- | ------------------------------------------------------ |
| 01 · 基础与外观     | 主题模式、刷新间隔、RPC 模式、默认视图、节点卡尺寸     |
| 02 · 首页布局       | 公告、地球样式、拓扑、三网地区、配色方案、色觉辅助模式 |
| 03 · 首页总览卡片   | 官方/基础/运维/资源/财务等预设与自定义卡片 keys        |
| 04 · 高级工具与隐私 | 高级工具、访客信息、访客审计、价格隐藏和减少动画       |
| 05 · 节点卡片与列表 | 快捷筛选、列表字段、离线置底、告警阈值、磁盘预测       |
| 06 · 节点详情概览   | 分区标签、详情卡片预设与自定义 keys                    |
| 07 · 节点详情图表   | CPU、内存、磁盘、网络、GPU、Ping 等图表组合            |
| 08 · 自定义背景     | 图片/视频背景、亮暗地址、模糊和遮罩                    |

完整 key、默认值与帮助文本以 [komari-theme.json](komari-theme.json) 为准。Komari 1.2.6 Metric Store 适配细节见 [docs/Komari-1.2.6-theme-adaptation.md](docs/Komari-1.2.6-theme-adaptation.md)。

## 隐私

Transit 将两类可选行为默认关闭：

- **访客公网信息**：开启 `visitorInfoEnabled` 后，访客浏览器会依次请求 `ipwho.is`、`ipapi.co`、`api.ip.sb`，直到一家返回成功。相应服务会看到访客 IP，并返回 IP、地区和运营商信息。
- **访客审计**：只有 `visitorAuditClientEnabled` 与 Komari 核心的 `visitor_audit_enabled` 同时开启时，Transit 才会上报页面事件、设备特征和哈希指纹到站点自己的 Komari。
- **本机壁纸**：壁纸文件只写入访客当前浏览器的 IndexedDB，不经过 Transit、Komari 或第三方网络请求；效果选择只写入同站点 `localStorage`。

公开首页的地球节点只按 Komari 已提供的国家/地区代码定位，不读取节点 IP，也不会为地图向第三方地理服务发送节点 IP。只有已登录用户主动打开需要地理增强的工具时，才可能在权限校验后查询节点 IP。

汇率请求同样按需触发：只有页面实际显示金额时才读取日缓存并在必要时访问汇率服务；隐藏访客价格或当前布局没有金额卡片时不会请求。

部署者在启用前应向访客说明用途、第三方接收方、保留期限和退出方式。完整字段、数据流与运营者检查清单见 [PRIVACY.md](PRIVACY.md)。

## 官方管理后台与授权边界

Transit 不再内嵌或再分发 `komari-web` 构建物。登录后的服务器列表由 Transit 自有代码展示主题已经接收的实时节点数据，并提供排序、首页顺序保存、详情和维护入口；顺序通过 Komari 官方 `admin:orderClients` RPC 保存。新增/删除 Agent、密钥、Ping 任务、通知、主题、插件、数据库、终端、账号和权限等其余配置能力继续使用 Komari 安装包自带的官方后台。主题顶部和服务器列表中的后台入口都直接进入 `/admin/client`。

截至本版本发布时，[komari-monitor/komari-web](https://github.com/komari-monitor/komari-web) 没有声明可供第三方修改和再分发的许可证。因此 Transit 的源码仓库和 Release 都不包含它的源码、补丁、构建文件或派生管理端截图。若上游未来提供明确许可，可在符合其条款的前提下重新评估集成。

## 兼容性

| 项目     | 支持范围                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| Komari   | 重点适配 1.2.6 Metric Store；保留 1.2.5 records 回退；维护者生产环境已验证 1.4.2 |
| 浏览器   | Chromium 为正式验证目标；最新稳定版 Edge、Safari、Firefox 按尽力兼容处理         |
| 设备     | 桌面与移动端响应式布局，最低自动验证宽度 390px                                   |
| 主题设置 | 同一 `Transit` 短名称升级时保留托管设置                                          |
| 服务端   | 主题包不修改 Komari 数据库结构、Agent 或系统账户                                 |

Komari 新增接口时，Transit 优先使用 Metric Store；接口不可用时再回退到兼容 records 路径。

## 从 PandaOps 迁移

Transit 与 PandaOps 使用不同短名称，因此两套主题可以并存，但 Komari 不会自动把 PandaOps 的托管设置复制给 Transit。

建议迁移步骤：

1. 记录或导出 PandaOps 当前的 `topologyRoute`、`topologyMetrics` 和自定义设置。
2. 上传并启用 Transit，不要删除 PandaOps。
3. 在 Transit 设置中恢复主题模式、卡片方案和告警阈值。
4. 使用拓扑管理器重新确认线路、探测来源和 Ping 任务。
5. 验证首页、节点详情和拓扑配置后，再决定是否保留旧主题。

服务器管理员可以在完整数据库备份后复制对应 `theme_configurations`，但不建议普通用户直接修改 Komari 数据库。

## 升级与回滚

升级前建议保存主题设置并保留当前 Release：

1. 下载新的 Release 主题 zip。
2. 在 Komari 主题管理中上传并更新 `Transit`。
3. 强制刷新浏览器，检查拓扑、三网任务和自定义背景。
4. 若新版不符合预期，重新上传上一版 Release 或切回保留的旧主题。

Transit 不执行数据库迁移。主题设置格式发生变化时会保留旧值回退逻辑，并在 Release Notes 与 [CHANGELOG.md](CHANGELOG.md) 中说明。

## 常见问题

### 首页没有“管理”按钮

确认已经登录 Komari，并启用了 Transit 首页和多线路拓扑。公开访客不会获得保存主题设置的权限。

### Ping 任务下拉框为空

先选择正确的探测来源节点，确认任务包含该节点并已经产生样本。没有可列出的任务时可以输入精确任务名称，并设置备用延迟/丢包。

### 拓扑一直显示备用值或 0 ms

检查来源节点、任务名称和目标是否对应正确链路。任务名称匹配成功但尚无样本时，等待至少一个采样周期。

### 为什么管理后台仍是官方样式

这是预期行为。Transit 提供自有的实时服务器列表和主题内运维工具，但不再分发授权状态不明确的 `komari-web` 派生管理端；完整配置操作请使用 Komari 自带后台。

### 上传主题失败

确认上传的是 Release 附件中的 `komari-theme-Transit-build-*.zip`，并检查反向代理上传大小限制；不要上传 GitHub 自动生成的源码压缩包。

### 更新后仍显示旧页面

先执行浏览器强制刷新；若使用 CDN，再清理 HTML 缓存。带内容哈希的 JS/CSS 可以长期缓存，但入口 HTML 不应永久缓存。

### 私有站点打开首页后跳转登录

这是 Komari 的私有站点策略。完成登录后，公开监控和 Transit 高级工具会按当前会话权限显示，管理操作仍进入官方后台。

## 本地开发

需要 Node.js 20.19+ 或 22.12+，推荐使用仓库声明的 Bun 1.3.14。

```bash
bun install --frozen-lockfile
bun run dev
```

提交前执行：

```bash
bun run lint:check
bun run type-check
bun run build-only
bun run test:visual
bun run build
```

`bun run build` 会生成：

- `dist/`
- `komari-theme-Transit-build-<short-sha>.zip`

视觉回归覆盖亮暗主题、桌面/移动端、拓扑管理器、统一采样交互和节点卡等高布局。像素基准由 Playwright Chromium 在 macOS 环境维护，Linux CI 另外执行 lint、类型检查和生产构建。更新截图基准前必须人工确认设计差异。

## 发布物授权边界

- Release 只打包本仓库可依法再分发的主题代码和资产。
- 构建检测到 `dist/admin-app/` 时会直接失败，避免误把外部管理端带入主题包。
- 外部项目的名称、链接与截图仅用于兼容性说明或致谢，不表示其许可证自动适用于 Transit。
- 如需加入第三方代码，贡献者必须同时提交来源、固定版本、许可证文本和必要的 NOTICE。

## 架构与安全边界

- 首页和节点详情是公开监控界面，不是鉴权边界。
- 拓扑保存、节点维护、快照导出和管理操作会验证 Komari 会话。
- 自定义背景、Markdown、外部链接和导出数据应视为不可信输入。
- 不要在 Issue、截图或日志中提交密码、Token、Cookie、私钥和未打码服务器地址。

深入资料：

- [架构](docs/Architecture.md)
- [认证与权限](docs/Auth.md)
- [数据流](docs/DataFlow.md)
- [缓存策略](docs/Cache.md)
- [安全策略](SECURITY.md)

## 项目来源与致谢

Transit 是社区二次开发项目，不是 Komari 官方主题。感谢以下开源项目与作者提供的基础：

- [Komari](https://github.com/komari-monitor/komari) — 监控服务端与生态基础。
- [komari-web](https://github.com/komari-monitor/komari-web) — Komari 官方管理界面；Transit 仅保持 API 与使用流程兼容，不打包或再分发其代码。
- [komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) — 原始主题、组件结构与 MIT 授权基础。
- [komari-theme-Glassmorphism-three-network](https://github.com/vlongx/komari-theme-Glassmorphism-three-network) — 三网 Ping 展示与后续二开基础。

在已获许可的主题基础上，Transit 重新设计了网络拓扑、可视化拓扑管理器、节点卡片、告警体系、采样交互和亮暗主题。感谢所有上游贡献者。

## 参与与支持

- 使用问题、功能建议和可复现缺陷请通过 [GitHub Issues](https://github.com/yyy622hhh/komari-theme-transit/issues/new/choose) 提交。
- 提交截图和日志前请先打码 IP、域名、Cookie、Token 和其他私密信息。
- 贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开披露漏洞。
- 版本变化记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

本仓库中由 Transit 提供、且未另行标注的代码采用 [MIT License](LICENSE)。发布和再分发时请保留版权与许可证声明；MIT 不会替未授权的第三方作品授予许可。
