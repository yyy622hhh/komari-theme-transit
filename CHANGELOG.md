# 更新日志

所有面向用户的重要变化记录在此。项目遵循 [Semantic Versioning](https://semver.org/)。

## [1.0.17] - 2026-08-16

### Fixed

- 兼容 Komari 1.4.2 在管理类 JSON-RPC 成功响应中省略空 `result` 字段的行为，修复首页和服务器列表保存全局顺序时报 `Invalid JSON-RPC response` 的问题。
- 将服务器列表的“官方后台”入口修正为 Komari 实际使用的 `/admin/client`，避免打开不存在的后台路由后显示 404。

### Testing

- JSON-RPC 回归新增省略空结果、缺失响应 ID 和畸形错误对象覆盖；浏览器夹具同步模拟 Komari 的真实空响应序列化行为。

## [1.0.16] - 2026-08-16

### Performance and privacy

- 访客公网信息组件改为仅在配置启用时加载，访客安全指纹采集代码改为仅在核心与主题审计开关同时启用后加载；默认首屏 gzip 从约 144.9 KiB 降至约 141.2 KiB。
- 首屏资源审计新增访客 IP 服务与指纹采集器边界，阻止这些可选模块以后重新进入入口资源或 module preload。

## [1.0.15] - 2026-08-15

### Changed

- 首页与服务器列表共用统一的排序移动逻辑，保留拖动、方向键、Home/End、读屏公告和保存失败后的草稿重试。
- 调整 Vite 分包与预加载策略，Bun 审计口径的首屏 gzip 从约 153.8 KiB 降至不超过 145 KiB；ECharts、Globe 和详情历史图表继续按需加载。
- 收紧记录插值和 CardX slot 的宽泛类型，不改变公开 API、主题设置或页面文案。
- 将 app store 类型契约、图表时间范围与 Ping 统计纯计算从超大文件拆出，并让负载图和延迟图共用空状态、错误状态与重试交互。

### Security and accessibility

- 增加基于 `bun.lock` 的 OSV 依赖扫描，并在本地审计、Quality 和 Release 工作流阻止 HIGH/CRITICAL 漏洞。
- 增加首页、详情页和登录服务器列表的 axe 结构与交互扫描，阻止 serious/critical 级违规。
- 增加登录过期和公网权限边界回归，确保私有 HTTP/RPC、IP 地理和隐藏价格汇率请求不会从公开页面启动。

### Testing

- 增加 RPC 非法响应/超时/HTTP 回退、认证拒绝、请求取消/重试、过期缓存和非法服务器顺序单元测试。
- 增加图表时间范围与 Ping 聚合纯函数单元测试；当前单元测试共 32 项。
- 增加首页排序保存失败、刷新持久化、卡片/列表键盘操作和移动端真实触摸拖动浏览器回归。

## [1.0.14] - 2026-08-15

### Fixed

- 修复首页卡片排序容器没有通过 Vue 组件引用绑定到真实 DOM，导致部分环境无法开始拖动的问题。

## [1.0.13] - 2026-08-15

### Added

- 首页节点卡片和列表可以直接进入全局顺序编辑，拖动或使用键盘调整后同步 Komari 官方后台权重。

## [1.0.12] - 2026-08-15

### Fixed

- 审计日志翻页、筛选或离开面板时会取消不再需要的旧请求，避免快速操作继续占用请求池。
- 审计日志导出按 ID 去重，并将单次浏览器内存导出限制为 5,000 条；达到上限时会明确提示并在 JSON 元数据中标记截断。
- 关闭访客信息或卸载组件时立即中止仍在进行的公网信息查询，并清理延迟显示定时器。

### Testing

- 新增审计分页去重、导出上限以及 CSV 公式注入防护单元回归测试。

## [1.0.11] - 2026-08-15

### Performance and privacy

- Metric Store Ping 请求会去重节点 UUID，并将每批 `entity_ids` 限制为 50，避免大规模安装生成无界 RPC 请求体。
- 同一轮响应式更新中的 Ping 本地缓存索引写入会合并执行，同时继续保持最多 200 项的边界。
- 汇率改为只在当前页面实际展示金额时按需加载；未登录隐藏价格或当前布局没有财务卡片时不会请求第三方汇率服务。

### Testing

- 新增 Metric Store 请求分批单元测试，以及首页和详情页隐藏价格时不访问汇率服务的浏览器回归。

## [1.0.10] - 2026-08-15

### Performance and privacy

- 负载历史、Ping 历史和公开 Ping 任务缓存增加容量与过期边界；相同窗口的节点 Ping 改为共享定时器和批量 Metric Store 请求。
- 历史请求的重试退避支持立即取消，避免导航后仍有后台重试占用请求池。
- 公开地球仅使用 Komari 已提供的国家/地区代码与主题内置坐标，不读取节点 IP，也不调用第三方地理服务。
- 详情负载图的 Metric Store 归一化从大型 Vue 组件移入纯工具层，降低组件复杂度并覆盖 GPU 数据兼容。
- 新增首屏 gzip 预算审计并加入 Quality 与 Release 工作流。

### Testing

- 新增共享缓存容量、可取消退避、负载指标归一化和公开地球隐私回归测试。

## [1.0.9] - 2026-08-15

### Fixed

- 修复登录校验请求晚于退出或会话刷新返回时，旧响应覆盖最新权限状态的问题；应用启动也统一通过竞态安全的认证服务同步登录状态。
- 修复 WebSocket 在握手完成前关闭时连接流程永久等待的问题。
- 修复旧 WebSocket 的延迟关闭事件清空已建立替代连接的问题，避免实时模式重连后再次误判断开。

### Testing

- 新增认证会话失效竞态，以及 WebSocket 握手关闭和替代连接所有权单元回归测试。

## [1.0.8] - 2026-08-15

### Changed

- 服务器排序统一使用 SortableJS fallback 指针路径，减少桌面浏览器原生拖放与移动端触控之间的行为差异。
- 拖动抓手现在会标明节点当前位置与总数；键盘除上下方向键外，还支持 Home 和 End 快速移到首尾，并通过读屏状态反馈移动结果。
- 取消顺序编辑后恢复进入编辑前的搜索、状态筛选、排序字段和升降序，不再打断正在查看的列表上下文。

### Testing

- 浏览器回归覆盖同一节点连续多次拖动、拖动与键盘操作混用、取消编辑恢复列表状态，以及最终提交的全局权重。

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

[Unreleased]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.15...HEAD
[1.0.15]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/yyy622hhh/komari-theme-transit/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yyy622hhh/komari-theme-transit/releases/tag/v1.0.0
