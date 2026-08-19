# 为 Transit 贡献

感谢你帮助改进 Transit。这个仓库发布的是 Komari 可导入主题包，因此界面改动、兼容性和打包结构同样属于发布契约。

## 开始之前

1. 搜索现有 Issue 和 Pull Request，避免重复工作。
2. 较大的功能或会改变配置格式的方案，请先开 Issue 对齐方向。
3. Bug 修复请写清 Transit、Komari 和浏览器版本以及最小复现步骤。
4. 不要提交密码、Cookie、Token、真实服务器地址、未打码截图或私有运行日志。

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发环境

- Node.js `22.22.2+`（22.x）、`24.15+`（24.x）或 `26+`
- Bun `1.3.14`
- Playwright Chromium（涉及 UI 时）

```bash
bun install --frozen-lockfile
bun run dev
```

不要在 `package.json` 添加顶层 `version`。发布版本的唯一来源是 `komari-theme.json.version`。

## 代码约定

- Vue 组件负责展示，响应式生命周期放在 composable，业务与请求编排放在 service。
- 复用现有 reka-ui、本地 UI primitives、Tailwind CSS 和 Iconify。
- 不引入 Naive UI、UnoCSS、SCSS、`lucide-vue-next` 或新的大型组件库。
- 公开首页和详情页保持公开；敏感数据与操作必须在动作入口验证 Komari 登录权限。
- 运行时图片路径和发布 zip 结构属于兼容契约，不能随意改名。

## 提交前验证

所有改动至少运行：

```bash
bun run lint:check
bun run icons:check
bun run type-check
bun run test:unit
bun run build-only
bun run audit:bundle
bun run audit:performance
bun run audit:reproducible
bun run audit:dependencies
```

`audit:reproducible` 会在同一检出目录和工具链中连续重建并比较 Release zip 的 SHA-256，用于阻止本项目构建逻辑产生非确定性输出；它不替代跨操作系统、跨工具链的独立可复现构建证明。

涉及页面、样式、响应式或交互时还需运行：

```bash
bun run test:visual
bun run test:functional
```

`test:functional` 会在 Chromium、Firefox、WebKit 与移动 WebKit 上验证公开浏览、详情跳转、后台入口契约和排序持久化。

无障碍相关改动也可先单独运行：

```bash
bun run test:accessibility
```

涉及大规模节点、虚拟列表、定时刷新、缓存或组件生命周期时，还应运行：

```bash
bun run test:performance
```

该命令覆盖大规模节点渲染与长稳资源释放；预算和加压参数见 [docs/Performance.md](docs/Performance.md)。

修改 RPC、认证、主题安装或排序持久化时，应在 Linux 隔离环境运行 `bun run test:komari`。该命令只操作临时 Komari/SQLite，详情见 [docs/Compatibility.md](docs/Compatibility.md)。

该命令在开发测试环境对首页、节点详情和登录后的服务器列表执行 axe 结构与交互扫描，并阻止 serious/critical 级违规。毛玻璃主题的动态透明色由高对比度样式和视觉回归共同覆盖。`audit:dependencies` 会按提交的 `bun.lock` 查询 OSV，并阻止 HIGH/CRITICAL 依赖漏洞。

截图差异只有在人工确认设计变化后才可以更新，且必须重新生成基线，不要仅为让 CI 通过而扩大阈值或删除断言。本地 macOS 与 CI runner 的色彩管理不一致，用 `bun run test:visual:update` 生成的基线会带来 2~3% 的固定漂移，足以逼着阈值放宽到能盖住真实回归的程度。请改为在 GitHub Actions 上手动触发 **Visual Baseline** 工作流（`gh workflow run visual-baseline.yml`），下载 `visual-baseline-snapshots` 制品，覆盖 `tests/visual/snapshots/` 后提交。

改动发布流程时，请额外运行 `bun run build`，并确认 zip 顶层仍只有：

```text
komari-theme.json
preview.png
dist/
```

然后执行 `bun run audit:bundle` 和 `bun run audit:release`，确认首屏资源预算、发布物顶层结构和内嵌管理端检查均通过。

主题 zip 的条目时间固定为当前 Git 提交时间（也可通过 `SOURCE_DATE_EPOCH` 显式指定），文件和目录权限固定为 `0644`/`0755`。相同提交和依赖锁应生成相同 SHA-256 的发布包；发布前可连续执行两次 `bun run build` 并比较摘要。

Release 不得包含 `public/admin-app/`、`dist/admin-app/`、第三方管理端补丁或其他没有明确再分发许可的内容。加入第三方代码或资产时，PR 必须说明来源、固定版本、许可证与 NOTICE 要求。

## Pull Request

- 一个 PR 解决一个清晰问题，避免混入无关格式化。
- 描述用户可见变化、兼容风险和回滚方式。
- UI 改动提供相关断点的亮色/暗色截图。
- 新配置需要合理默认值、旧值回退和 README 更新。
- 维护者可能要求补充基准截图、Komari 版本验证或拆分改动。

## Release 规则

项目采用语义化版本。只有维护者应修改 `komari-theme.json.version` 和创建 Release。修复已发布版本时发布新的 patch 版本，不覆盖已经被用户下载的历史 tag。

版本变更推送到 `main` 后，Release 工作流会等待同一提交的 Quality、Visual Regression、Browser Functional 和 Komari Compatibility 全部成功，再创建 tag 与 GitHub Release。不要绕过失败或仍在运行的发布门禁手工覆盖同版本 tag。
