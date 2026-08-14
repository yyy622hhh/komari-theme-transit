# Transit for Komari

> A topology-first network operations theme for Komari.

[![Release](https://img.shields.io/github/v/release/yyy622hhh/komari-theme-transit?style=flat-square&color=10b981)](https://github.com/yyy622hhh/komari-theme-transit/releases)
[![Quality](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/quality.yml?branch=main&style=flat-square&label=quality)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/quality.yml)
[![Visual Regression](https://img.shields.io/github/actions/workflow/status/yyy622hhh/komari-theme-transit/visual-regression.yml?branch=main&style=flat-square&label=visual)](https://github.com/yyy622hhh/komari-theme-transit/actions/workflows/visual-regression.yml)
[![License](https://img.shields.io/github/license/yyy622hhh/komari-theme-transit?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3-42b883?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)

Transit 是一个面向多节点、多线路和跨境链路监控的 Komari 社区主题。它把线路拓扑、三网 Ping、实时资源、告警和资产信息放在同一套紧凑界面里，同时保留完整的节点详情与管理能力。

![Transit 暗色总览](docs/screenshots/transit-overview-dark.png)

## 功能亮点

- 拓扑优先：首页支持多条“入口 - 线路机 - 落地机”链路，并允许登录用户可视化配置。
- 三网质量：节点卡片集中展示联通、电信、移动的延迟、丢包和近期样本。
- 统一采样交互：鼠标悬停即可查看每个采样点的时间、延迟与丢包，移动端支持点击固定。
- 运维视角：内置异常摘要、可靠性窗口、链路基线、维护状态和事件时间线。
- 紧凑节点卡：CPU、内存、硬盘、流量、到期时间与三网质量保持等高排版。
- 亮暗双主题：桌面端和移动端均提供经过视觉回归验证的亮色与暗色样式。
- 完整管理端：内嵌 Transit 风格的 Komari 管理后台，同时保留独立设置页面和原有权限边界。
- 隐私优先：默认不提供公网 IP 检测，不向额外的第三方查询服务发送访客地址。

## 界面预览

| 暗色总览                                                        | 亮色总览                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| ![Transit 暗色总览](docs/screenshots/transit-overview-dark.png) | ![Transit 亮色总览](docs/screenshots/transit-overview-light.png) |

| 管理总览                                                          | 独立设置页                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Transit 管理总览](docs/screenshots/transit-admin-dashboard.png) | ![Transit 设置页](docs/screenshots/transit-admin-settings.png) |

## 安装

1. 前往 [Releases](https://github.com/yyy622hhh/komari-theme-transit/releases) 下载最新的 `komari-theme-Transit-build-*.zip`。
2. 登录 Komari 管理后台，在主题管理中上传该 zip。
3. 启用 `Transit` 主题。
4. 在主题设置中选择三网地区、卡片密度和拓扑数据；也可以在首页拓扑右上角使用可视化管理器。

Transit 使用独立短名称 `Transit`，可以与已有的 PandaOps 或 Glassmorphism 主题配置并存。

升级前建议先在 Komari 后台导出当前主题设置。若新版不符合预期，重新上传并启用上一版 Release 即可回滚；Transit 不修改 Komari 数据库结构或 Agent 配置。

## 兼容性

| 项目   | 支持范围                                                                   |
| ------ | -------------------------------------------------------------------------- |
| Komari | 重点验证 `1.2.6`；保留 `1.2.5` 旧 records 接口回退；更早版本不保证完整功能 |
| 浏览器 | Chromium 为正式验证目标；最新稳定版 Edge、Safari、Firefox按尽力兼容处理    |
| 设备   | 桌面与移动端响应式布局，最低验证宽度 390px                                 |
| 升级   | 同一 `Transit` 短名称下保留托管主题设置；发布包不修改服务端数据库与 Agent  |

Komari 新增接口时，Transit 会优先使用 Metric Store；接口不可用时再回退到兼容 records 路径。完整适配说明见 [Komari 1.2.6 主题适配](docs/Komari-1.2.6-theme-adaptation.md)。

## 拓扑配置

推荐登录后使用首页的“管理”按钮配置。需要手工维护时，主题仍支持文本格式：

```text
北京电信|CN|入口;Transit-JP-Relay|JP|线路机;Transit-US-Edge|US|落地机
```

- `||` 分隔多条线路。
- `;` 分隔同一线路上的节点。
- 每个节点使用 `名称|地区|角色`。
- 链路指标既支持静态的 `延迟,丢包`，也支持绑定 Komari Ping 任务的实时格式。

## 本地开发

需要 Node.js 20.19+ 或 22.12+，并建议使用项目声明的 Bun 版本。

```bash
bun install --frozen-lockfile
bun run dev
bun run lint:check
bun run type-check
bun run build-only
bun run test:visual
bun run build
```

像素基准由 Playwright Chromium 在 macOS 环境维护；Linux CI 另外执行 lint、类型检查和生产构建。更新截图基准前请人工确认差异确实是预期设计变化。

`bun run build` 会生成：

- `dist/`
- `komari-theme-Transit-build-<short-sha>.zip`

发布 zip 根目录只包含 `komari-theme.json`、`preview.png` 和 `dist/`，可直接由 Komari 导入。

## 重建内嵌管理端

仓库中的 `public/admin-app/` 来自官方 [komari-web](https://github.com/komari-monitor/komari-web)，并通过补丁与同步脚本实现 Transit 外观。要复现管理端构建：

```bash
git clone https://github.com/komari-monitor/komari-web.git ../komari-web
git -C ../komari-web checkout 4a74e8a
git -C ../komari-web apply ../komari-theme-transit/patches/komari-web-transit-admin.patch
bun run sync:admin ../komari-web
```

同步脚本会重新构建官方管理端、修正嵌入路径并记录源提交信息。后台敏感操作仍由 Komari 自身的登录和权限系统控制。

## 项目来源与致谢

Transit 是社区二次开发项目，不是 Komari 官方主题。感谢以下开源项目与作者提供的基础：

- [Komari](https://github.com/komari-monitor/komari) - 监控服务端与生态基础。
- [komari-web](https://github.com/komari-monitor/komari-web) - 官方管理端与前端实现。
- [komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism) - 原始主题、组件结构与 MIT 授权基础。
- [komari-theme-Glassmorphism-three-network](https://github.com/vlongx/komari-theme-Glassmorphism-three-network) - 三网 Ping 展示与后续二开基础。

在这些项目的基础上，Transit 重新设计了网络拓扑、节点卡片、告警体系、采样交互、亮暗主题和管理后台。感谢所有上游贡献者。

## 参与与支持

- 使用问题和方案讨论请使用 [GitHub Discussions](https://github.com/yyy622hhh/komari-theme-transit/discussions)。
- 可复现缺陷请按 [Issue 模板](https://github.com/yyy622hhh/komari-theme-transit/issues/new/choose) 提交，并先打码 IP、域名和日志中的私密信息。
- 贡献代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开披露漏洞或敏感运行信息。
- 版本变化记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

本项目继续采用 [MIT License](LICENSE)。发布和再分发时请保留原始版权与许可证声明。
