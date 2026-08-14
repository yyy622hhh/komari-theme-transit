# Transit for Komari

> A topology-first network operations theme for Komari.

[![Release](https://img.shields.io/github/v/release/yyy622hhh/komari-theme-transit?style=flat-square&color=10b981)](https://github.com/yyy622hhh/komari-theme-transit/releases)
[![Quality](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/quality.yml?branch=main&style=flat-square&label=quality)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/quality.yml)
[![Visual Regression](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/visual-regression.yml?branch=main&style=flat-square&label=visual)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/visual-regression.yml)
[![License](https://img.shields.io/github/license/yyy622hhh/komari-theme-transit?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)

Transit 是一个面向多节点、多线路和跨境链路监控的 Komari 社区主题。它把“入口 → 线路机 → 落地机”的链路拓扑、北京/上海/广州三网 Ping、实时资源、异常告警和资产信息放进同一套紧凑界面，并提供可视化拓扑管理器与 Transit 风格管理后台。

![Transit 暗色总览](docs/screenshots/transit-overview-dark.png)

## 为什么使用 Transit

- **拓扑优先**：一眼看清用户入口、线路机、落地机以及每一段链路的延迟和丢包。
- **可视化配置**：不需要手写配置即可添加、排序和删除线路，选择节点并绑定实时 Ping 任务。
- **三网质量**：节点卡片集中展示联通、电信、移动的延迟、丢包和近期采样。
- **统一采样交互**：鼠标悬停显示时间、延迟与丢包；移动端可点击固定浮窗。
- **运维视角**：提供异常摘要、线路可靠性、维护状态、事件时间线、健康统计和审计日志。
- **资产视角**：同时展示价格、剩余价值、到期日、流量配额和厂商信息。
- **完整管理能力**：内嵌基于官方 `komari-web` 的 Transit 管理端，不重新实现服务端权限。
- **隐私优先**：默认不提供公网 IP 检测，不把访客地址发送给额外的第三方查询服务。

## 功能一览

| 区域     | 能力                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 线路状态 | 多线路拓扑、入口探测点切换、逐段实时/静态指标、采样浮窗、历史详情、健康评分        |
| 拓扑管理 | 添加/删除/排序线路、选择线路机与落地机、绑定 Ping 任务、备用延迟与丢包、保存和恢复 |
| 节点卡片 | CPU、内存、硬盘、上下行、累计流量、到期信息、价格和三网质量                        |
| 告警     | 离线、高负载、流量预警、即将到期、Ping 丢包、维护状态和异常时间线                  |
| 首页工具 | 节点对比、厂商性价比、健康摘要、快照导出、网络信息和核心审计日志                   |
| 节点详情 | 自定义概览卡、完整负载图、Ping 延迟/丢包历史、GPU 与磁盘耗尽预测                   |
| 显示     | 亮色/暗色/北京时间自动模式、四档卡片密度、卡片/列表视图和移动端布局                |
| 管理端   | 运维总览、服务器、任务、通知、主题、插件、系统设置、数据库与终端等官方功能         |

## 界面预览

| 暗色总览                                                        | 亮色总览                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| ![Transit 暗色总览](docs/screenshots/transit-overview-dark.png) | ![Transit 亮色总览](docs/screenshots/transit-overview-light.png) |

### 可视化拓扑管理器

登录后点击“线路状态”右上角的“管理”，即可直接维护所有线路和每一段指标。修改会保存到 Komari 托管主题设置，并同步到所有设备。

![Transit 拓扑管理器](docs/screenshots/transit-topology-manager.png)

### Transit 管理端

| 运维总览                                                          | 独立设置页                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Transit 管理总览](docs/screenshots/transit-admin-dashboard.png) | ![Transit 设置页](docs/screenshots/transit-admin-settings.png) |

## 快速开始

1. 前往 [Releases](https://github.com/yyy622hhh/komari-theme-transit/releases) 下载最新的 `komari-theme-Transit-build-*.zip`。
2. 登录 Komari 管理后台，在主题管理中上传这个 zip；不要上传 GitHub 自动生成的源码压缩包。
3. 启用短名称为 `Transit` 的主题。
4. 打开主题设置，选择主题模式、节点卡密度和三网地区。
5. 返回首页，在“线路状态”右上角打开拓扑管理器，配置线路并保存。

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
- 线路机到落地机的自定义任务，例如 `Transit-JP-Relay-to-Transit-US-Edge`

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
北京电信|CN|入口;Transit-JP-Relay|JP|线路机;Transit-US-Edge|US|落地机||北京电信|CN|入口;Transit-US-Relay|US|线路机;Transit-US-Edge-2|US|落地机
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
live@Transit-JP-Relay@北京电信@51@0;live@Transit-JP-Relay@Transit-JP-Relay-to-Transit-US-Edge@84@0||live@Transit-US-Relay@北京电信@148@0;live@Transit-US-Relay@Transit-US-Relay-to-Transit-US-Edge-2@1.1@0
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
- **节点对比**：比较多个节点的资源、流量、价格和网络数据。
- **健康摘要**：切换日、周、月区间查看历史健康情况。
- **厂商性价比**：按价格、资源和剩余价值排序节点。
- **快照导出**：导出当前监控快照的 CSV 或 JSON。
- **审计日志**：读取 Komari 核心管理员操作日志，不虚构服务端未提供的访客记录。
- **磁盘预测**：样本充足时按历史增长趋势估算磁盘耗尽时间。

高级工具默认只向已登录用户显示，权限校验以 Komari `/api/me` 和服务端接口为准。隐藏按钮、前端状态和本地设置都不是安全边界。

## 主题设置

Transit 的托管设置按使用路径分为八组：

| 分组                | 主要内容                                               |
| ------------------- | ------------------------------------------------------ |
| 01 · 基础与外观     | 主题模式、刷新间隔、RPC 模式、默认视图、节点卡尺寸     |
| 02 · 首页布局       | 公告、地球样式、拓扑、三网地区、配色方案、色觉辅助模式 |
| 03 · 首页总览卡片   | 官方/基础/运维/资源/财务等预设与自定义卡片 keys        |
| 04 · 高级工具与隐私 | 高级工具、访客显示、价格隐藏、厂商别名、减少动画       |
| 05 · 节点卡片与列表 | 快捷筛选、列表字段、离线置底、告警阈值、磁盘预测       |
| 06 · 节点详情概览   | 分区标签、详情卡片预设与自定义 keys                    |
| 07 · 节点详情图表   | CPU、内存、磁盘、网络、GPU、Ping 等图表组合            |
| 08 · 自定义背景     | 图片/视频背景、亮暗地址、模糊和遮罩                    |

完整 key、默认值与帮助文本以 [komari-theme.json](komari-theme.json) 为准。Komari 1.2.6 Metric Store 适配细节见 [docs/Komari-1.2.6-theme-adaptation.md](docs/Komari-1.2.6-theme-adaptation.md)。

## Transit 管理端

`dist/admin-app/` 是基于官方 [komari-web](https://github.com/komari-monitor/komari-web) 构建的完整管理端。Transit 修改导航、运维总览、设置页布局和主题样式，但服务器、Agent、任务、通知、主题、插件、数据库、终端、账号和权限等能力仍使用官方实现与 Komari API。

主题启用后，可直接访问：

```text
/admin-app/index.html?__komari_route=/admin/dashboard
```

Komari 核心会优先接管 `/admin/*`，所以仅上传主题时，直接打开 `/admin/dashboard` 仍可能看到官方默认样式。这不影响功能。若希望原管理地址自动进入 Transit，可以在 Nginx 的站点 `server` 中、通用 `location /` 之前加入：

```nginx
location = /admin {
    return 302 /admin-app/index.html?__komari_route=/admin/dashboard;
}

location ^~ /admin/ {
    return 302 /admin-app/index.html?__komari_route=$uri;
}

location = /manage {
    return 302 /admin-app/index.html?__komari_route=/manage/;
}

location ^~ /manage/ {
    return 302 /admin-app/index.html?__komari_route=$uri;
}

location = /terminal {
    return 302 /admin-app/index.html?__komari_route=/terminal;
}

location ^~ /terminal/ {
    return 302 /admin-app/index.html?__komari_route=$uri;
}
```

应用前先备份配置，并执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

这些规则不匹配 `/api/admin/*`，管理 API、登录和权限仍由 Komari 处理。使用 Caddy 或其他反向代理时遵循同样原则：只改浏览器页面路由，不代理或改写管理 API。

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
5. 验证首页、节点详情和管理端后，再决定是否保留旧主题。

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

### `/admin/dashboard` 仍是官方样式

直接访问 `/admin-app/index.html?__komari_route=/admin/dashboard`，或按“Transit 管理端”一节配置反向代理页面路由。

### 上传主题失败

确认上传的是 Release 附件中的 `komari-theme-Transit-build-*.zip`，并检查反向代理上传大小限制。当前主题包约 7 MB，建议允许至少 10 MB。

### 更新后仍显示旧页面

先执行浏览器强制刷新；若使用 CDN，再清理 HTML 缓存。带内容哈希的 JS/CSS 可以长期缓存，但入口 HTML 不应永久缓存。

### 私有站点打开首页后跳转登录

这是 Komari 的私有站点策略。完成登录后，公开监控、Transit 高级工具和管理端会按当前会话权限显示。

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

视觉回归覆盖亮暗主题、桌面/移动端、拓扑管理器、统一采样交互、节点卡等高布局、管理总览和独立设置页。像素基准由 Playwright Chromium 在 macOS 环境维护，Linux CI 另外执行 lint、类型检查和生产构建。更新截图基准前必须人工确认设计差异。

## 重建内嵌管理端

仓库中的 `public/admin-app/` 来自官方 `komari-web`，通过补丁与同步脚本实现 Transit 外观。具体源提交记录在 `public/admin-app/komari-admin-source.json`。

```bash
git clone https://github.com/komari-monitor/komari-web.git ../komari-web
git -C ../komari-web checkout 4a74e8a
git -C ../komari-web apply ../komari-theme-transit/patches/komari-web-transit-admin.patch
bun run sync:admin ../komari-web
```

同步脚本会重新构建官方管理端、修正嵌入路径并记录源信息。后台敏感操作仍由 Komari 自身的登录和权限系统控制。

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
- [komari-web](https://github.com/komari-monitor/komari-web) — 官方管理端与前端实现。
- [komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) — 原始主题、组件结构与 MIT 授权基础。
- [komari-theme-Glassmorphism-three-network](https://github.com/vlongx/komari-theme-Glassmorphism-three-network) — 三网 Ping 展示与后续二开基础。

在这些项目的基础上，Transit 重新设计了网络拓扑、可视化拓扑管理器、节点卡片、告警体系、采样交互、亮暗主题和管理后台。感谢所有上游贡献者。

## 参与与支持

- 使用问题、功能建议和可复现缺陷请通过 [GitHub Issues](https://github.com/yyy622hhh/komari-theme-transit/issues/new/choose) 提交。
- 提交截图和日志前请先打码 IP、域名、Cookie、Token 和其他私密信息。
- 贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开披露漏洞。
- 版本变化记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

本项目继续采用 [MIT License](LICENSE)。发布和再分发时请保留原始版权与许可证声明。
