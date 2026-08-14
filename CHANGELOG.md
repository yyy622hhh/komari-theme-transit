# 更新日志

所有面向用户的重要变化记录在此。项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [1.0.3] - 2026-08-15

### Added

- 新增登录后可用的 Transit 原生服务器列表，支持实时状态、搜索、在线/离线/维护筛选、CPU/流量/更新时间排序、节点详情和运维入口。
- 新增桌面表格与移动端紧凑卡片回归，覆盖搜索、筛选、排序、运维弹窗和页面宽度约束。

### Fixed

- 服务器列表直接使用主题现有的 Vue 响应式节点仓库，不再依赖可能被浏览器过滤的 `/api/admin/client/list` 请求。

### Security and privacy

- 新列表完全由 Transit 自有代码实现；Release 继续排除 `komari-web` 源码、补丁和派生构建，服务器配置仍进入 Komari 官方后台。

## [1.0.2] - 2026-08-14

### Security and privacy

- 默认关闭访客公网信息查询，并在主题设置与 `PRIVACY.md` 明示 `ipwho.is`、`ipapi.co`、`api.ip.sb` 第三方请求。
- 新增独立的 `visitorAuditClientEnabled` 选择加入开关；只有它与 Komari 核心访客审计同时开启时，才采集页面事件、设备特征和哈希指纹。
- 从源码仓库、测试和 Release 中移除授权状态不明确的内嵌 `komari-web` 管理端、补丁与派生截图；构建检测到 `dist/admin-app/` 时会失败。

### Changed

- 新安装的拓扑配置默认为空，登录用户会看到“配置第一条线路”引导，不再引用维护者自己的节点。
- 改用 `.env.example` 记录本地 API 目标，并忽略开发者自己的 `.env`。
- 清理 Glassmorphism v2.3.0、v3 里程碑和“没有测试套件”等过期资料。

### Fixed

- 视觉回归使用锁定的 Noto Sans SC 测试字体，避免不同 CI 机器的中英文字形和布局漂移。
- 视觉测试失败会生成 GitHub Actions 原生注解，直接标出失败用例与截图比较详情。
- 兼容 Chromium 对相同浅色节点背景的 `rgba()` 与 `oklch()` 计算样式序列化结果。

### Documentation

- 重写 README，完整说明可视化拓扑管理器、实时 Ping 绑定、入口探测点、运维工具、PandaOps 迁移与常见问题。
- 新增拓扑管理器实机截图，并移除尚未启用的 GitHub Discussions 链接。

## [1.0.1] - 2026-08-14

### Added

- 可复现的 Bun 依赖锁定与独立 Quality CI。
- 贡献、安全、行为准则、Issue 和 Pull Request 模板。

### Changed

- 视觉回归固定在与基准图一致的 macOS Chromium 环境运行，减少跨系统字体渲染造成的误报。
- 补充 Komari、浏览器、升级和回滚兼容说明。

## [1.0.0] - 2026-08-14

### Added

- 多线路“入口—线路机—落地机”可视化拓扑和管理器。
- 北京、上海、广东三网 Ping 与统一采样浮窗交互。
- 紧凑等高节点卡片、告警摘要、可靠性窗口、智能基线和线路排名。
- 亮暗主题、桌面/移动布局和 Transit 风格内嵌 Komari 管理端。
- Playwright 视觉与交互回归、自动构建和 GitHub Release 发布流程。

[Unreleased]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yyy622hhh/komari-theme-transit/releases/tag/v1.0.0
