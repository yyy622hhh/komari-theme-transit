# 更新日志

所有面向用户的重要变化记录在此。项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [1.0.7] - 2026-08-15

### Changed

- 服务器全局顺序编辑改为抓手拖拽，桌面表格和移动端卡片均支持，保存后继续同步首页与 Komari 官方后台。
- 拖拽抓手保留键盘上下方向键操作，并使用更大的触控区域改善移动端操作。
- 拖拽由固定版本 SortableJS 1.15.7 提供，来源为 SortableJS/Sortable，采用 MIT 许可证；Release 内保留完整许可文本。

### Testing

- 浏览器回归使用真实指针手势验证桌面拖拽、移动端拖拽和保存后的权重请求。
- 新增服务器列表桌面与移动端拖拽编辑态视觉基准。

## [1.0.6] - 2026-08-15

### Fixed

- 修复取消请求后立即发起同键请求时，旧请求完成清理会移除新请求去重状态的竞态。
- 修复清空 Promise 缓存并立即重建同键值时，旧 Promise 完成后误删新缓存的竞态。
- 修复公告中的 `&`、`<`、`>` 被 Vue 二次转义并显示为 HTML 实体的问题。
- 修复编辑服务器顺序期间节点新增或删除时，保存会漏掉新节点或提交已删除节点的问题；本地节点权重现在保持唯一连续。
- 修复应用销毁时仍在途的轮询响应重新写回已清空节点状态的问题。

### Testing

- 新增请求管理、Promise 缓存和服务器顺序协调单元测试，并将单元测试加入 Quality 与 Release 工作流。
- 新增公告特殊字符的浏览器回归测试。

## [1.0.5] - 2026-08-15

### Changed

- Transit 节点卡片左侧状态条补全正常在线的绿色状态；维护或警告保持黄色，严重异常保持红色，离线继续使用遮罩提示。
- 视觉回归加入真实的健康节点样本，同时覆盖正常、告警和离线状态条。

## [1.0.4] - 2026-08-15

### Added

- 服务器列表新增“官方顺序”默认项、桌面与移动端统一的排序字段选择和升降序控制。
- 登录管理员可以在 Transit 内使用上下箭头编辑并保存首页服务器顺序，保存后立即同步节点卡片和官方后台权重。

### Fixed

- 从官方后台标签页返回 Transit 时立即刷新节点元数据，后台调整顺序不再最多等待 60 秒轮询周期。
- 相同权重的节点使用稳定名称顺序，避免 Komari 返回 UUID 映射时出现随机抖动。

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

[Unreleased]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.7...HEAD
[1.0.7]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yyy622hhh/komari-theme-transit/releases/tag/v1.0.0
