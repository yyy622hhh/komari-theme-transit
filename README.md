<div align="center">

# 🌌 Komari Glassmorphism

## 给 Komari Monitor 的一套「玻璃拟态 · 运维驾驶舱」主题

从好看的监控首页，逐步成长为好用、可配置、适合长期运行的 Komari 主题。

![Version](https://img.shields.io/github/v/release/sanrokamlan-prog/komari-theme-Glassmorphism?style=for-the-badge&label=release&color=10b981)
![Vue](https://img.shields.io/badge/Vue-3-42b883?style=for-the-badge&logo=vue.js)
![Vite](https://img.shields.io/badge/Vite-7-646cff?style=for-the-badge&logo=vite)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-v4-38bdf8?style=for-the-badge&logo=tailwindcss)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2-000000?style=for-the-badge&logo=bun)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)

**[📥 下载 Release](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)** ·
**[🚀 安装](#-安装--升级)** ·
**[✨ 功能](#-节点详情页全面升级)** ·
**[⚙️ 设置](#️-主题设置)** ·
**[🛠️ 开发](#️-本地开发)**

</div>

---

## 📸 预览

<div align="center">

<img src="docs/preview-home.png" width="49%" alt="Komari Glassmorphism 首页预览" />
<img src="docs/preview-detail.png" width="49%" alt="Komari Glassmorphism 节点详情预览" />

</div>

---

## 🚀 项目定位

| 项目     | 说明                                                      |
| :------- | :-------------------------------------------------------- |
| 当前版本 | **v3.1.4**                                                |
| 主题定位 | Komari Monitor 可导入 zip 主题，不是普通 Web App 部署包   |
| 视觉风格 | 毛玻璃卡片、动态背景、浅色 / 深色 / 北京时间自动日夜模式  |
| 数据能力 | Metric Store 优先，旧接口自动 fallback，兼容 Komari 1.2.x |
| 高级工具 | 拓扑、性价比、健康摘要、快照导出、审计日志                |
| 发布产物 | `komari-theme-Glassmorphism-build-<short-sha>.zip`        |

> 好看只是外壳。v3 真正的重点，是把 Metric、Ping、流量、费用、健康分析和运维工具整合成日常真的会打开来看的监控面板。

---

## 📶 v3.1.4 首页分时丢包修复

`v3.1.4` 修复首页节点卡的丢包时间格被整段平均值覆盖、导致所有格子同值同色的问题。

右侧汇总仍显示整个统计周期的平均丢包率；每个时间格改为读取 Metric Store 的 `ping.loss` 分时序列，并按各 Ping 任务的实际样本数加权。空桶继续显示为无数据，旧版 Komari 的 records 负值丢包逻辑仍作为 fallback 保留。

---

## 🧭 v3.1.3 路由过渡修复

`v3.1.3` 修复开启“减弱过渡动画”后，首页进入节点详情或返回首页时只剩背景、必须刷新才能恢复的问题。

减弱动画时，路由切换不再使用串行 `out-in` 离场流程，避免同步 `afterLeave` 与首页 `KeepAlive` 更新重入导致 Vue 丢失 DOM 锚点。关闭动画不会再影响页面正常渲染；未开启该选项时仍保留原有过渡效果。

---

## 🛟 v3.1.2 启动可靠性更新

`v3.1.2` 修复了一个会同时影响登录状态、节点详情和实时连接的启动单点故障。

旧流程中，首次 `rpc.ping()` 只要超时或遇到瞬时抖动，后面的公开设置、用户信息、节点数据和 WebSocket / 轮询就全部不会执行。现在这些请求已经拆开，单项失败不再拖垮整个应用。

```text
健康检查 ─┐
公开设置 ─┼─> 独立并行初始化 ─> 公共页面可用
用户信息 ─┤                     ├─> WebSocket / HTTP 轮询恢复
节点数据 ─┘                     └─> 全局错误提示与手动重试
```

| 修复项       | 当前行为                                                  |
| :----------- | :-------------------------------------------------------- |
| 健康检查     | 5 秒超时，最多 3 次递增间隔重试                           |
| 超时请求     | 通过 `AbortSignal` 主动取消，不残留悬挂请求               |
| 初始化       | `Promise.allSettled()` 隔离健康检查、设置、用户和节点请求 |
| 节点首拉失败 | 仍启动实时连接和轮询，网络恢复后自动补齐数据              |
| 错误提示     | 首页和 `/instance/:id` 等所有公开路由统一显示             |
| 手动恢复     | 全局提示提供重试按钮，并防止重复创建连接与定时器          |

> 这不是 Komari 1.2.5 / 1.2.6 的专属兼容补丁。新版后端响应变慢可能提高触发概率，但根因是前端启动链过度串行，现已从设计上修复。

---

## ✨ 节点详情页全面升级

主题已适配新版 Komari / komari-web Metric 能力，并将官方指标重新整理成适合监控场景的图表族。

| 分类        | 支持指标                                                       |
| :---------- | :------------------------------------------------------------- |
| 💻 CPU      | CPU、Load、Processes                                           |
| 🧠 内存     | RAM、RAM Total、Swap、Swap Total                               |
| 💾 存储     | Disk、Disk Total、磁盘耗尽预测                                 |
| 🚀 GPU      | GPU、GPU Device、GPU Memory、GPU Memory Total、GPU Temperature |
| 🌐 网络     | Download、Upload、周期流量、累计流量、TCP、UDP                 |
| 📡 网络质量 | Ping Latency、Packet Loss、多任务统计                          |
| 🌡️ 环境状态 | System Temperature、GPU Temperature                            |

> 不是简单堆叠 25 张单指标图，而是归并成 12 个稳定图表族，减少碎片化信息和无意义的重复展示。

### 📐 详情页布局

| 优化方向 | 当前能力                               |
| :------- | :------------------------------------- |
| 概览卡   | 18 类指标，7 套预设                    |
| 图表面板 | 12 个图表族，9 套预设                  |
| 响应式   | 移动端 2 列、中屏 3 列、宽屏 4 列      |
| 分区模式 | 可选概览 / 负载 / 延迟标签页           |
| 兼容配置 | 保留旧图表 key、旧卡位和 JSON 模板解析 |

---

## 🎨 详情页自定义能力

主题设置不要求修改源码。预设适合快速启用，英文 key 适合高级用户精确控制顺序和内容。

| 功能                | 状态 |
| :------------------ | :--- |
| 概览卡预设          | ✅   |
| 图表预设            | ✅   |
| 英文 key 自定义     | ✅   |
| 英文 / 中文逗号解析 | ✅   |
| 空格 / 分号解析     | ✅   |
| 多行粘贴解析        | ✅   |
| 后台 help key 说明  | ✅   |
| 旧配置兼容          | ✅   |

### 推荐配置方向

| 类型       | 适合场景                             |
| :--------- | :----------------------------------- |
| Resource   | CPU / 内存 / 磁盘资源监控            |
| Network    | 实时速率、累计流量、连接与 Ping 分析 |
| GPU        | GPU 利用率、设备、显存与温度         |
| Operations | 资源、连接、进程、温度与网络质量     |
| Full       | 覆盖完整官方 Metric 能力             |
| Custom     | 自己决定卡片和图表顺序               |

---

## 📈 Metric 接口升级

新版接口优先，旧版 Komari 后端继续保持兼容。

```text
新版 Metric API 有效
        ↓
public:queryMetrics / public:getPingMetricStats
        ↓
无数据或接口不可用
        ↓
common:getRecords / legacy records fallback
        ↓
保持图表与 Ping 正常展示
```

| 项目                        | 状态                |
| :-------------------------- | :------------------ |
| `public:queryMetrics`       | ✅ 优先使用         |
| `public:getPingMetricStats` | ✅ 优先使用         |
| `common:getRecords`         | ✅ 自动 fallback    |
| 自定义 `start` / `end`      | ✅                  |
| Metric `null` 断点          | ✅ 保留，不误判丢包 |
| 旧接口负值丢包哨兵          | ✅ 兼容             |

---

## 📶 Ping 模块增强

| 优化项目                 | 状态 |
| :----------------------- | :--- |
| Min / Max / Avg / Latest | ✅   |
| P50 / P99 / 波动率       | ✅   |
| 多任务丢包统计           | ✅   |
| 100% 丢包任务保留        | ✅   |
| Null 点不再误判丢包      | ✅   |
| 自定义起止时间           | ✅   |
| 新旧接口自动切换         | ✅   |
| 快速切换请求防旧数据覆盖 | ✅   |

适用于网络抖动分析、短时丢包排查和特定时间段异常定位。

---

## 🪟 首页驾驶舱

- 地球、点阵地球、平铺地图三种视觉模式
- 卡片 / 列表双视图，列表在密集节点下自动虚拟化
- `mini` / `compact` / `comfortable` / `large` 四档卡片密度，默认保持 `compact`
- 官方、基础、运维、资源、财务、流量、GPU、资产、完整和自定义总览方案
- 月成本、总流量、上下行、峰值、离线、高负载、即将到期等快捷控制
- 节点 `message` 在卡片 / 列表以纯文本提示，不使用 `v-html`
- 自定义图片 / 视频背景、毛玻璃配色预设和动画减弱选项

---

## 🧰 首页高级工具

高级工具仅在登录验证通过后显示和执行。

| 工具          | 用途                                               |
| :------------ | :------------------------------------------------- |
| 🗺️ 拓扑分析   | 根据 ASN、厂商、分组和标签分析节点关系与异常集中点 |
| 💰 性价比排行 | 比较每核、每 GB 内存、流量额度和周期成本           |
| 🩺 健康摘要   | 聚合负载、磁盘、流量、离线状态和 Ping 风险         |
| 📤 快照导出   | 导出 JSON / CSV，内置 CSV 公式注入防护             |
| 📜 审计日志   | 分页查看管理员操作记录                             |

---

## 🧱 底层架构

新功能遵循统一调用链：

```text
Component
    ↓
Composable
    ↓
Service
    ↓
RequestManager / CacheService
    ↓
API / RPC
```

同步具备：

- [x] 请求去重与并发限制
- [x] 超时、重试和 Abort 清理
- [x] TTL / LRU-like / 引用计数缓存
- [x] Metric Store 优先与旧接口 fallback
- [x] 共享 Ping / 负载历史数据流
- [x] 登录权限与敏感操作校验
- [x] Vue 响应式节点索引和实时更新

---

## 🔒 公开访问与安全边界

首页和节点详情页始终保持公开，不使用全局路由守卫阻断普通监控。

| 公开能力               | 登录后能力                   |
| :--------------------- | :--------------------------- |
| 普通节点状态与实时指标 | Hidden 节点                  |
| Load / Ping 历史图表   | 拓扑、性价比、健康摘要       |
| Ping 延迟与丢包统计    | 快照导出与审计日志           |
| 公开厂商元数据         | Geo 增强、磁盘预测等敏感路径 |

安全细节包括：

- 快照导出需要登录验证，可选二级密码
- CSV 中和 `=`、`+`、`-`、`@`、`|` 等公式注入前缀
- Markdown 链接和图片限制 URL scheme，拦截 `javascript:`
- 未登录可隐藏价格、费用卡片和后台入口
- 登录过期时降级到公共展示，不让整个 dashboard 崩溃

---

## 📱 WebKit / iOS 兼容

| 环境                       | 策略                                         |
| :------------------------- | :------------------------------------------- |
| Safari 15.4+               | 构建语法目标与基础可用边界                   |
| Safari 16.4+               | Tailwind CSS v4 完整视觉基线                 |
| 缺少 `oklch` / `color-mix` | 使用 sRGB token 和可读降级样式               |
| 旧 WebKit                  | 关闭高成本毛玻璃，避免透明或不可读界面       |
| Firefox                    | 对密集卡片和控制层关闭多层 `backdrop-filter` |

> 兼容策略的目标是保证基础功能和文字可读，不承诺老旧内核拥有与现代浏览器完全一致的视觉效果。

---

## ⚙️ 主题设置

全部设置由 [`komari-theme.json`](komari-theme.json) 托管到 Komari 后台，无需修改代码。

| 分类           | 代表设置                                            |
| :------------- | :-------------------------------------------------- |
| 基础与外观     | 主题模式、更新间隔、RPC 模式、默认视图、卡片尺寸    |
| 首页布局       | 公告、地球样式、访客信息、毛玻璃配色、自定义背景    |
| 总览卡片       | 10 套方案、自定义 keys 和显示顺序                   |
| 高级工具与隐私 | 工具总开关、隐藏后台 / 价格、厂商别名、导出二级密码 |
| 快捷控制与列表 | 快捷按钮、列表元数据、离线置底、预警阈值            |
| 详情概览       | 18 类指标卡、7 套方案、分区标签页                   |
| 详情图表       | 12 个图表族、9 套方案、GPU 图表和自定义 keys        |
| 自定义背景     | 亮 / 暗 URL、图片 / 视频、模糊和遮罩                |

---

## 📦 安装 / 升级

### 方式一：使用 GitHub 仓库地址

Komari 后台支持直接填写仓库地址并拉取最新 Release：

```text
https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism
```

### 方式二：手动安装 Release

1. 打开 [Releases](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)
2. 下载最新的 `komari-theme-Glassmorphism-build-*.zip`
3. 登录 Komari Monitor 后台，进入 **设置 → 主题管理**
4. 上传 zip 并启用主题
5. 在主题设置中调整视觉、卡片、快捷控制和高级工具

> 请上传 Release 附件中的主题 zip，不要上传 GitHub 自动生成的源码压缩包。

---

## 🛠️ 本地开发

环境要求：Node.js `^20.19.0` 或 `>=22.12.0`，Bun `>=1.2.0`。

```bash
bun install
bun run dev
bun run lint
bun run build
bun run preview
```

构建成功后会生成：

- `dist/`
- `komari-theme-Glassmorphism-build-<short-sha>.zip`

发布包固定包含：

```text
komari-theme.json
preview.png
dist/
```

> 发布版本只改 [`komari-theme.json`](komari-theme.json) 顶层 `version`，不要给 `package.json` 添加顶层 `version`。

---

## 📝 更新日志

<details open>
<summary><strong>v3.1.4 · 首页分时丢包修复</strong></summary>

- 首页 Metric Store 查询同时读取 `ping.latency_ms` 与 `ping.loss`
- 每个丢包时间格按对应时间桶和 point `count` 加权计算，不再复用整段平均值
- `null` 空桶保持无数据，周期平均丢包文字继续使用精确汇总统计
- Metric 分时丢包数据不完整时自动回退旧 records 负值丢包逻辑

</details>

<details>
<summary><strong>v3.1.3 · 减弱动画路由切换修复</strong></summary>

- 修复开启“减弱过渡动画”后进入详情只剩背景的问题
- 修复异常发生后返回首页仍为空白、必须刷新恢复的问题
- 减弱动画时停用 `out-in` 串行离场，保留首页 `KeepAlive` 状态
- 正常动画配置继续使用原有页面淡入淡出效果

</details>

<details>
<summary><strong>v3.1.2 · 启动恢复与全局错误反馈</strong></summary>

- 修复健康检查偶发失败时跳过用户、节点和实时连接的问题
- 健康检查增加 5 秒超时、3 次递增间隔重试和请求取消
- 设置、用户、节点与健康检查改为独立并行初始化
- 节点首拉失败后仍启动轮询自愈；所有路由统一显示错误和重试入口

</details>

<details>
<summary><strong>v3.1.1 · 首页、列表与公开 Ping 修复</strong></summary>

- 修复默认背景被实色层遮挡和暗色模式全黑
- 修复列表 Ping 提示遮挡，并降低 DOM / hover 合成开销
- 普通 Ping 历史恢复公开访问，修复详情快速切换的旧请求覆盖
- 优化首页快捷控制计数和大样本时间合并

</details>

<details>
<summary><strong>v3.1.0 · 节点详情 Metric 驾驶舱</strong></summary>

- 对齐 Komari 1.2.6 的 25 个 Metric definition，归并为 12 个图表族
- 新增累计 / 周期流量、GPU 设备、显存、温度和 Ping 图表
- 增加详情概览 / 图表预设、自定义时间范围和多行 keys 配置
- 修复 Metric null、100% 丢包任务和多任务汇总问题

</details>

更多历史版本请查看 [Releases](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)。

---

## ⭐ Support

如果这个项目帮助到了你，欢迎：

- ⭐ Star 本项目
- 🍴 Fork 并贡献代码
- 💬 提交 Issue 或 Feature Request
- 📢 分享给更多 Komari 用户

你的每一个 Star，都是继续维护更新的动力。

---

## ☕ Donation / Sponsor

如果你喜欢这个项目，也欢迎支持后续开发。每一份支持都会用于功能开发、Bug 修复、性能优化、文档和长期维护。

感谢 **可乐杯里泡枸杞**、**Leo Lin**、**HelloWorldx** 、**johnmill**的捐赠支持。

---

## 🙏 致谢

感谢原始主题作者 **Tokinx**，感谢 [Komari](https://github.com/komari-monitor/komari)、[Komari Naive](https://github.com/tonyliuzj/komari-naive)、Vue、Vite、reka-ui、Tailwind CSS，以及所有反馈 Issue、提交 PR 和分享建议的朋友。

## 📄 License

[MIT](LICENSE)
