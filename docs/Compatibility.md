# Komari 兼容性实验室

Transit 的兼容性工作流会为每个版本启动全新的 Komari 进程和临时 SQLite 数据库，测试结束后由系统临时目录回收，不连接生产实例。

当前矩阵覆盖 Komari `1.2.5-fix2`、`1.2.6`、`1.4.2` 和 `1.4.3`。官方 Linux amd64 二进制的 SHA-256 固定在 `scripts/komari-lab.ts`，下载内容不匹配时立即失败。

每个版本验证：

- 使用真实管理 API 安装当前提交的 Release zip，并核对返回的主题 manifest 与 `dist/index.html`；
- 在初装、覆盖升级和回滚重启后分别启动 Chromium 执行真实 Komari 提供的主题，阻止页面运行时异常和同源 HTTP 错误；
- Komari `1.4.3` 走 `/api/admin/upload/init`、`chunk`、`merge` 分片上传，覆盖服务端合并和 `extractAndValidateTheme`；
- Komari `1.2.5-fix2`、`1.2.6` 和 `1.4.2` 尚无统一主题分片上传接口，明确走各自原生的 `PUT /api/admin/theme/upload` 旧接口，不使用文件系统解压兜底；
- 初始化管理员并验证匿名请求不能调用管理员 RPC；
- 激活 Transit、保存随机 canary 配置并通过公共配置接口读回；
- 创建两个隔离节点，调用 `admin:orderClients` 后通过 `admin:listClients` 读回权重；
- 走一遍入口任务的新建与复用：第一台真实实验室节点通过 `admin:addPingTask` 创建任务，第二台通过 `admin:editPingTask` 加入并重拉列表核对；旧版本没有 edit 时按主题逻辑再新建一条同名任务，并确认第二台节点确实绑定成功，最后删除并复核所有实验室任务；
- 使用同一 Release zip 再次走真实上传接口，验证覆盖升级会替换旧目录，同时保留数据库中的主题配置和节点顺序；
- 在覆盖升级前生成独立主题目录快照，升级后停止 Komari 并以目录重命名恢复快照；重启后通过专用标记、主题文件、canary 和节点权重共同验证回滚；
- 校验 JSON-RPC `jsonrpc` 和 `id` 回包信封，并兼容 `admin:orderClients` 成功时省略 nil `result` 的 Komari 行为。

Linux 本地可执行：

```bash
bun run build
KOMARI_VERSION=1.4.3 bun run test:komari
```

macOS 开发者可以通过 `TRANSIT_KOMARI_BINARY` 指向自行构建的本机 Komari 二进制。实验室会生成随机凭据且不会输出凭据或 Komari 启动日志。
