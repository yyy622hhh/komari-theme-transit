# Komari Glassmorphism

一款面向 **Komari Monitor** 的实用型毛玻璃主题。v3.0.0 的重点不是单纯换皮，而是把官方新版后端和探针里有用的数据能力接到主题里：metric store 图表、Ping 统计、节点消息、拓扑、健康摘要、快照导出、磁盘耗尽预测、厂商信息、费用和流量分析等都围绕日常运维场景整理。

![Version](https://img.shields.io/github/v/release/sanrokamlan-prog/komari-theme-Glassmorphism?style=flat-square&label=version&color=10b981)
![Vue](https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vue.js)
![Vite](https://img.shields.io/badge/Vite-7-646cff?style=flat-square&logo=vite)
![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-v4-38bdf8?style=flat-square&logo=tailwindcss)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2-000000?style=flat-square&logo=bun)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

[实用功能](#实用功能) · [主题设置](#主题设置) · [安装使用](#安装使用) · [本地开发](#本地开发) · [更新日志](#更新日志)

## 一屏看懂

| 项目     | 内容                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 主题定位 | Komari Monitor 主题包，上传 zip 到 Komari 后台即可使用                    |
| 当前版本 | v3.0.0                                                                    |
| 核心重点 | 运维实用功能扩展 + Komari 新版 metric store 兼容 + 旧后端 fallback        |
| 首页能力 | 总览卡片、地球/地图、节点卡片/列表、快捷筛选排序、Ping 摘要、节点消息提示 |
| 详情能力 | 节点信息、实时/历史负载图、Ping 图表、GPU 图表可选、磁盘耗尽预测          |
| 高级工具 | 拓扑、厂商/ASN 信息、健康摘要、快照导出、CSV 安全导出                     |
| 配置方式 | Komari 后台托管主题设置，无需改代码                                       |
| 发布产物 | Release 附件中的 `komari-theme-Glassmorphism-build-*.zip`                 |

## 实用功能

### 1. Komari 新版 metric store 适配

v3.0.0 已接入官方新版 komari-web 里更实用的数据链路，并保留旧接口回退：

- Ping 图表优先读取 `public:getPingMetricStats` / `public:queryMetrics`。
- 负载历史图优先读取 `public:listMetricDefinitions` / `public:queryMetrics`。
- 新接口不存在、无数据或请求失败时自动回退旧 `common:getRecords` 路径。
- 支持 `maxCount` / `max_count`、records array/map 等新旧返回形态兼容。
- 接收新探针字段：`cpu_physical_cores`、`traffic_up`、`traffic_down`、`message`、`updated_at` 等。

### 2. Ping 统计增强

节点详情页 Ping 图不再只是画线：

- 支持多 Ping 任务切换、全选/全不选。
- 新后端优先展示官方 metric stats。
- 支持 min / max / avg / latest。
- 支持 P50 / P99 / P99-P50 波动率。
- 支持 stddev、total、valid、loss approximate 等统计字段。
- 丢包点按空点处理，不把丢包画成 0ms。
- 首页节点卡片也会显示延迟和丢包小条。

### 3. 负载图表增强

节点详情页负载图支持实时和历史两套路径：

- 实时模式保留 `common:getNodeRecentStatus`，刷新轻量。
- 历史模式优先走 metric store。
- 支持 CPU / Load、内存 / Swap、磁盘、网络、连接、进程。
- 支持历史数据补点，避免图表断层过于难看。
- `chartDashboardTemplate` 可自定义卡片顺序和显示项。
- 无 metric store 的旧后端仍能正常显示 legacy 历史图。

### 4. GPU 图表可选

很多 VPS 没有 GPU，所以 GPU 图表默认关闭，需要时在主题设置里打开：

- 主题设置：`详情页显示 GPU 图表`。
- 仅当开关开启且节点确实有 GPU 数据时显示卡片。
- 支持总 GPU 使用率。
- 支持 per-device GPU 使用率。
- 支持显存使用率和温度。
- tooltip 会按 `device_name` / `device_index` 展示设备明细。

### 5. 节点 message 提示

新版探针返回 `message` 时，主题会在节点名旁显示黄色 warning 图标：

- 首页卡片视图支持。
- 首页列表视图支持。
- tooltip 纯文本展示 message 和更新时间。
- 不使用 `v-html`，避免 HTML 注入。

### 6. 磁盘耗尽预测

登录后可开启磁盘耗尽预测，用历史磁盘用量趋势估算剩余时间：

- 首页节点卡片的磁盘区域会显示“预计 N 天后满”。
- 节点详情页负载图的磁盘卡片标题下会显示趋势摘要。
- 样本不足、磁盘未增长、预测天数超过阈值时自动隐藏。
- 默认至少需要约 2 天历史样本。
- 可配置“磁盘预测预警天数”。

### 7. 拓扑、厂商和健康摘要

登录后首页高级工具可提供更多排障信息：

- **节点拓扑**：整理离线上游、分组和节点关系，方便看异常集中在哪。
- **厂商信息**：结合地区、ASN、厂商别名显示更准确的节点元数据。
- **健康摘要**：聚合负载、流量、连接、离线、高负载、即将到期等状态。
- **快照导出**：导出节点快照，支持 JSON / CSV；CSV 做了公式注入防护。

### 8. 首页总览和快捷排序

总览卡片不只显示几项固定指标，可以按场景切换：

- **基础**：内存、硬盘、剩余价值、累计流量、实时上下行。
- **运维**：在线/离线、高负载、流量预警、平均 CPU / Load。
- **财务**：剩余价值、月费用、年费用、即将到期。
- **流量**：累计流量、流量配额、实时峰值、上行最高、下行最高。
- **自定义**：用 key 自定义卡片内容和顺序。

快捷控制支持：

- 默认排序
- 月成本排序
- 总流量排序
- 上行 / 下行排序
- 实时峰值排序
- 离线节点
- 高负载节点
- 即将到期节点
- 离线节点置底

### 9. 卡片 / 列表双视图

- 卡片视图适合公开状态页和日常看板。
- `mini` 高密度尺寸适合节点很多的面板。
- `compact` 保持默认紧凑体验。
- `comfortable` / `large` 适合大屏展示。
- 列表视图适合快速扫状态，支持厂商、地区、城市、ASN、标签、分组字段。
- 列表在节点数量较多时启用虚拟列表，降低渲染压力。

### 10. 财务、隐私和公开展示

- 支持价格、周期、到期时间、剩余价值、月成本、年成本。
- 支持多货币格式化和汇率换算。
- 未登录可隐藏价格、剩余价值和费用类卡片。
- 未登录可隐藏后台入口。
- Komari hidden 节点仅登录后显示，公开首页自动过滤。
- 敏感功能走登录权限校验，不加全局路由守卫，公开首页和详情保持可访问。

### 11. 外观和后台设置

- 毛玻璃卡片、渐变背景、浅色/深色/北京时间自动日夜模式。
- 支持三种地球/地图：realistic、cobe、tiled。
- 支持公告、自定义背景图片/视频、背景模糊、背景遮罩。
- 自定义毛玻璃颜色已合并为一个高级 JSON 配置，避免后台设置页一长串颜色输入。
- 可减弱过渡动画，照顾低性能设备。

## 主题设置

主题设置由 [komari-theme.json](komari-theme.json) 声明，并在 Komari 后台以托管设置展示。

### 基础设置

| 设置         | 作用                                                   |
| ------------ | ------------------------------------------------------ |
| 默认主题模式 | `beijing` 北京时间自动、`light` 浅色、`dark` 深色      |
| 数据更新间隔 | 实时数据刷新秒数，建议 1-10 秒                         |
| RPC 连接模式 | HTTP 兼容性最好；反代支持 WebSocket 时可切换 websocket |
| 默认视图模式 | 首页默认卡片或列表                                     |
| 节点卡片尺寸 | `mini`、`compact`、`comfortable`、`large` 四档         |

### 首页模块设置

| 设置                           | 作用                                         |
| ------------------------------ | -------------------------------------------- |
| 启用公告 / 公告标题 / 公告内容 | 首页公告，内容支持简单 Markdown              |
| 地球样式                       | realistic、cobe、tiled 三种地球/地图模式     |
| 隐藏地球 / 隐藏头部            | 让首页更紧凑                                 |
| 登录后显示高级工具             | 拓扑、性价比、健康摘要、快照导出             |
| 毛玻璃配色方案                 | 翡翠、柔和、高对比、午夜、自定义             |
| 高级：自定义毛玻璃颜色         | 用 JSON 一次配置全部自定义颜色               |
| 头部卡片方案                   | 基础、运维、财务、流量、完整、自定义         |
| 高级：自定义头部卡片           | 用英文逗号填写卡片 key，自定义显示内容和顺序 |
| 隐藏后台入口                   | 未登录时隐藏顶部后台管理入口                 |
| 未登录隐藏价格                 | 未登录访客隐藏价格、剩余价值和费用类卡片     |
| 厂商自定义别名                 | 给 VPS 厂商配置别名，提高识别准确度          |
| 导出二级密码                   | 快照导出时增加一道客户端确认                 |
| 减弱过渡动画                   | 减少页面过渡动画，提高弱设备体验             |

### 节点与快捷控制

| 设置                 | 作用                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| 显示主页快捷控制     | 控制分组旁快捷按钮是否展示                                                                        |
| 快捷控制方案         | 基础、流量、运维、完整、自定义                                                                    |
| 高级：自定义快捷按钮 | 自己填写 `default,monthlyCost,totalTraffic,upload,download,peak,offline,highLoad,expiring` 等 key |
| 列表信息栏           | 控制列表视图是否展示节点元信息                                                                    |
| 列表信息字段         | 自定义 provider、region、city、asn、tags、group 的顺序                                            |
| 详情页分区标签页     | 将详情页拆为概览、负载、延迟标签页                                                                |
| 详情页显示 GPU 图表  | 默认关闭；开启后有 GPU 数据的节点显示 GPU 图表                                                    |
| 离线节点置底         | 在线节点优先，离线节点排到最后                                                                    |
| 默认快捷模式         | 进入首页默认启用的筛选/排序模式                                                                   |
| 高负载阈值           | CPU、内存或硬盘达到阈值时归为高负载                                                               |
| 流量预警阈值         | 流量配额使用率达到阈值时归为预警                                                                  |
| 即将到期天数         | 剩余天数小于等于该值时归为即将到期                                                                |
| 启用磁盘耗尽预测     | 基于历史磁盘趋势预测耗尽时间                                                                      |
| 磁盘预测预警天数     | 预测剩余天数小于等于该值时显示提示                                                                |
| 详情负载图模板       | 用 JSON 控制详情页负载图卡片顺序和显示项                                                          |

### 自定义背景

| 设置             | 作用                              |
| ---------------- | --------------------------------- |
| 启用自定义背景   | 开启后使用自定义图片或视频背景    |
| 背景类型         | image 或 video                    |
| 亮色模式背景地址 | 亮色模式下使用的背景 URL          |
| 暗色模式背景地址 | 暗色模式下使用的背景 URL          |
| 背景模糊半径     | 背景高斯模糊 px 值                |
| 背景遮罩强度     | -100 到 100，控制透明度或黑色遮罩 |

## 安装使用

1. 打开 [Releases](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases) 页面。
2. 下载最新版本的 `komari-theme-Glassmorphism-build-*.zip`。
3. 登录 Komari Monitor 后台，进入 **设置 → 主题管理**。
4. 点击 **上传主题**，选择下载的 zip 文件。
5. 在主题设置里按需调整卡片尺寸、地球样式、总览卡片、快捷控制、背景和高级功能。
6. 刷新页面，即可应用主题。

> 请上传 Release 附件中的主题 zip 包，不要直接上传源码压缩包。

## 本地开发

### 环境要求

| 工具    | 版本                      |
| ------- | ------------------------- |
| Node.js | `^20.19.0` 或 `>=22.12.0` |
| Bun     | `>=1.2.0`                 |

### 常用命令

```bash
# 安装依赖
bun install

# 启动 Vite 开发服务器
bun run dev

# 自动修复并检查代码风格
bun run lint

# 类型检查 + 生产构建 + 主题 zip 打包
bun run build

# 预览生产构建
bun run preview
```

构建成功后会生成：

- `dist/`
- `komari-theme-Glassmorphism-build-<short-sha>.zip`

zip 包内包含 Komari 主题需要的 `komari-theme.json`、`preview.png` 和 `dist/`。

### 版本号

发布版本只需要修改 [komari-theme.json](komari-theme.json) 顶层 `version` 字段。不要在 [package.json](package.json) 添加顶层 `version`。

## 技术栈

| 类别        | 技术                              |
| ----------- | --------------------------------- |
| 框架        | Vue 3                             |
| 构建        | Vite 7                            |
| 包管理器    | Bun                               |
| UI 基础     | reka-ui + shadcn-vue 风格本地组件 |
| 样式        | Tailwind CSS v4 + tw-animate-css  |
| 状态管理    | Pinia                             |
| 路由        | Vue Router                        |
| 图标        | Iconify                           |
| 图表        | ECharts + vue-echarts             |
| 地球 / 地图 | globe.gl、three、cobe             |
| 工具        | VueUse、dayjs                     |
| 代码规范    | ESLint + @antfu/eslint-config     |

## 项目结构

```text
.
├─ AIAGENTREADME.md       # AI/二开总手册
├─ AICACHE.md             # AI 任务交接记录
├─ docs/                  # 文档和截图资源
├─ public/images/         # 运行时图片资源：旗帜、系统 logo 等
├─ src/
│  ├─ components/         # 业务组件与本地 UI 组件
│  ├─ composables/        # 可复用组合式逻辑
│  ├─ services/           # 业务服务、请求、缓存、导出、metric 封装
│  ├─ stores/             # Pinia 状态
│  ├─ styles/             # 全局 Tailwind v4 样式与设计 token
│  ├─ utils/              # API、RPC、格式化、地理与财务工具
│  └─ views/              # 首页与节点详情页
├─ komari-theme.json      # Komari 主题清单、托管配置和发布版本号
├─ vite.config.ts         # Vite 构建与主题 zip 打包配置
└─ package.json           # 项目命令与依赖版本
```

## 更新日志

### v3.0.0

- 接入官方新版 metric store：Ping 图表、首页 Ping 摘要、LoadChart 历史模式优先使用 public metric API，并保留旧接口 fallback。
- 新增 Ping 统计增强：P50、P99、波动率、标准差、有效数、总数、loss approximate 等。
- 新增节点 `message` 提示，首页卡片和列表节点名旁显示 warning tooltip。
- 新增 GPU 图表支持，默认关闭，可在主题设置中开启；支持总览和 per-device tooltip。
- 新增 `chartDashboardTemplate`，可配置详情页负载图卡片顺序和显示项。
- 新增磁盘耗尽预测，在首页节点卡片和详情页磁盘图中显示趋势预警。
- 增强拓扑、健康摘要、快照导出、CSV 安全、厂商元数据、请求缓存和性能表现。
- 自定义毛玻璃颜色合并为单个高级 JSON 配置，减少后台设置页占用空间。
- 补齐 Komari 1.2.x 新探针字段和历史 records 新旧返回形态兼容。

### v2.3.1

- 修复节点状态轮询时实时上行 / 下行、CPU 等卡片数据需要刷新浏览器才更新的问题。
- 确认节点卡片尺寸未配置时仍默认使用 `compact`；`mini` 仅作为可选高密度模式。

### v2.3.0

- 新增 `mini` 节点卡片尺寸，高密度展示更多节点；保留原有 `compact`、`comfortable`、`large` 三档。
- 新增「离线节点置底」设置，常用排序中在线节点优先，离线快捷筛选保持只显示离线节点。
- 优化加载阶段的后台入口和访客信息显示，避免初始状态闪现。
- 登录后可查看 Komari hidden 节点，未登录公开首页仍过滤 hidden 节点。
- 发布版本号统一以 [komari-theme.json](komari-theme.json) 为准，构建显示版本同步读取该字段。
- 重构 README，补全主题设置、隐藏功能和使用亮点说明。

更多历史版本请查看 [Releases](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism/releases)。

## 致谢

- 原始主题作者：Tokinx
- 捐赠支持：可乐杯里泡枸杞、Leo Lin（排名不分先后）
- [Komari](https://github.com/komari-monitor/komari)
- [Komari Naive](https://github.com/tonyliuzj/komari-naive)
- [Vue](https://vuejs.org/)
- [Vite](https://vitejs.dev/)
- [reka-ui](https://reka-ui.com/)
- [Tailwind CSS](https://tailwindcss.com/)

本项目在原有 Komari Emerald 主题基础上进行了毛玻璃风格改造，感谢原作者和社区项目的贡献。

## ❤️ 写在最后

从最初的一个简单主题，到现在的 **Glassmorphism v3.0**。

感谢每一位提出 Issue、提交 PR、反馈 Bug、提出建议的朋友。

因为有你们，这个项目才能不断成长。

未来，我仍会持续维护和更新它，带来更多高质量的新功能与优化。

## ⭐ Support

如果这个项目帮助到了你，欢迎：

- ⭐ Star 本项目
- 🍴 Fork 并贡献代码
- 💬 提交 Issue 或 Feature Request
- 📢 分享给更多 Komari 用户

你的每一个 Star，都是继续更新下去最大的动力。

## ☕ Support the Project

如果你喜欢这个项目，并希望支持后续开发，也欢迎请我喝杯咖啡 ☕。

你的每一份支持，都将用于：

- 🚀 持续开发新功能
- 🐛 修复 Bug 与性能优化
- 📖 完善文档与教程
- 💻 项目长期维护与服务器开销

### 💖 Donation / Sponsor

> 如果觉得这个项目值得支持，欢迎以任何方式赞助作者。

每一份支持，无论金额大小，都是项目持续更新的动力 ❤️

## License

[MIT](LICENSE)
