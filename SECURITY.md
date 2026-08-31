# 安全策略

## 支持范围

| 版本         | 安全更新           |
| ------------ | ------------------ |
| 最新 Release | 支持               |
| 更早版本     | 仅在最新版本中修复 |

Transit 的安全范围包括前端主题、`transit-route-probe` 伴生插件及固定能力节点助手。Komari 服务端、反向代理、系统账户和 Komari Agent 本体的问题应分别报告给对应上游项目或服务提供方。

## 私下报告安全问题

请使用仓库的 [Private vulnerability reporting](https://github.com/yyy622hhh/komari-theme-transit/security/advisories/new) 提交报告，不要创建公开 Issue、Discussion 或 Pull Request。

报告中请包含：

- 受影响的 Transit 和 Komari 版本；
- 复现步骤和影响范围；
- 可行的缓解措施；
- 已经打码的日志或截图。

请勿提供生产密码、私钥、完整 Cookie、Token 或不必要的真实服务器地址。维护者会尽快确认报告，在修复发布前协调披露时间。

## 安全边界

- Transit 的公开首页和节点详情不是鉴权边界。
- 管理操作和敏感数据必须继续由 Komari 登录与权限系统保护。
- 浏览器本地设置、隐藏按钮和前端二级密码不能替代服务端授权。
- 自定义背景、Markdown、CSV 导出和外部链接应被视为不可信输入。
- 节点上报的设备名、任务名和图表序列标签也是不可信输入；HTML 图表提示必须显式转义，不能仅依赖 Vue 模板保护。
- 节点助手不接受任意命令或探测目标，不开放入站端口；新助手使用 HTTPS JSON 请求体传递凭据，不回退到 URL token 或远端明文 HTTP。
- 伴生插件从 Komari 注入的认证身份确定节点，而非相信请求中的 UUID。按节点限流只缓解应用层滥用，不能替代代理的连接及请求限制。
- 升级应先插件、后助手。兼容旧助手意味着旧 URL 凭据传输仍可使用；代理/CDN/APM 必须保护查询参数和请求体，历史凭据暴露需管理员另行轮换。详见[安全升级说明](companion/transit-route-probe/README.md#credential-transport-and-upgrade-order)。
