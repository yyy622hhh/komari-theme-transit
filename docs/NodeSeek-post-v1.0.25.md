# [开源] Transit：面向多节点/多线路场景的 Komari 监控主题，支持拓扑、三网 Ping、拖动排序和本机壁纸

大家好，最近把自己一直在用的 Komari 主题整理并开源了，项目叫 **Transit**。

它不是单纯换一套颜色，而是针对多节点、多线路、跨境链路监控重新做了首页信息架构：把线路拓扑、三网 Ping、节点资源、流量/到期、异常告警和资产信息放到同一套界面里。

目前稳定版是 **v1.0.25**，已经在我自己的 Komari 1.4.2 环境运行。

项目地址：

https://github.com/yyy622hhh/komari-theme-transit

Release 下载：

https://github.com/yyy622hhh/komari-theme-transit/releases/latest

在线演示：

https://status.pandakiko.com/

## 主要功能

### 1. 多线路拓扑

可以用“入口 → 线路机 → 落地机”的方式展示多条线路，并分别显示每一段的延迟、丢包、近期采样、健康评分和历史波动。

登录管理员账号后，可以直接在首页打开可视化管理器：

- 添加、删除和调整线路顺序；
- 从 Komari 节点中选择线路机和落地机；
- 给每一段绑定真实 Komari Ping 任务；
- 配置没有实时样本时使用的备用延迟/丢包；
- 保存到 Komari 托管主题设置，多设备同步。

### 2. 北京/上海/广东三网质量

节点卡可以集中显示联通、电信、移动的：

- 当前延迟；
- 当前丢包率；
- 最近一组采样；
- 数据过期和任务未匹配状态。

桌面端可以悬停查看采样时间，移动端可以点击固定浮窗。

### 3. 为运维场景做的节点卡

节点卡包含 CPU、内存、硬盘、实时上下行、累计流量、流量配额、价格、到期日期和三网质量。

v1.0.24 起重新做了容器响应式布局：

- 宽卡片三列展示速度、流量和三网质量；
- 中窄卡片让三网质量独占整行；
- 极窄卡片切换单列；
- 长节点名最多两行；
- 日期、大流量、速度和三网指标不会再被省略号隐藏。

自动回归覆盖 320、390、768、1280、1700px，以及 mini / compact / comfortable / large 四档密度。

### 4. 首页直接拖动服务器顺序

登录后可以在首页或 Transit 自带的服务器列表里调整全局节点顺序：

- 桌面鼠标拖动；
- 移动端触摸拖动；
- 键盘方向键、Home、End；
- 保存后通过 Komari 官方 `admin:orderClients` RPC 写入权重；
- 会重新读取服务端顺序确认真的保存成功，失败会保留草稿供重试。

完整的 Agent、Ping 任务、通知、主题、插件、数据库、终端、账号等管理仍然使用 Komari 官方后台。

### 5. 告警和资产工具

目前还做了：

- 离线、高负载、流量预警、即将到期和 Ping 异常摘要；
- 节点维护/告警静默；
- 异常时间线和线路可靠性；
- 节点对比、厂商性价比和健康摘要；
- CSV / JSON 快照导出；
- 核心管理员审计日志；
- 价格、剩余价值、月/年费用；
- 磁盘耗尽趋势预测；
- 亮色、暗色和北京时间自动模式；
- 当前浏览器专用的本机壁纸，支持玻璃化、模糊、高清。

## 关于“线路方向”和真实数据

这里特别说明一下，避免把展示拓扑和真实探测方向混在一起：

**Komari Ping 数据由配置的“探测来源节点”发起。**

如果来源节点在日本，Ping 任务叫“北京电信”，这仍然是日本节点发起的探测，不能当成“北京电信 → 日本”的正向路径。真正的北京电信到日本，需要在北京电信网络里部署探测节点。

Transit 会显示“探测来源节点 + Ping 任务”，不会把反向 Ping 伪装成正向线路。目前项目也没有伪造 traceroute 跳点。

## 隐私和授权边界

- 访客公网信息查询默认关闭；
- Transit 访客审计默认关闭；
- 公开首页不会为了地图把节点 IP 发送给第三方地理服务；
- 本机壁纸只保存在当前浏览器 IndexedDB，不上传服务器；
- Release 不包含或再分发授权状态不明确的 `komari-web` 管理端构建物；
- Transit 是社区主题，不是 Komari 官方项目。

## 安装方法

1. 打开 Releases：
   https://github.com/yyy622hhh/komari-theme-transit/releases/latest
2. 下载附件里的 `komari-theme-Transit-build-*.zip`；
3. 登录 Komari 后台，在主题管理中上传这个 zip；
4. 启用短名称为 `Transit` 的主题；
5. 回到首页，根据引导配置第一条拓扑。

注意不要上传 GitHub 自动生成的 Source code zip。正确主题包根目录只有：

```text
komari-theme.json
preview.png
dist/
```

## 兼容与质量验证

- 真实 Komari 隔离实验：1.2.6、1.4.2、1.4.3；
- 浏览器自动回归：Chromium、Firefox、WebKit、移动 WebKit；
- axe 无障碍扫描；
- 大规模节点虚拟化和长稳资源释放测试；
- OSV 锁文件依赖安全扫描；
- 首屏 gzip 预算和 Release zip 结构审计；
- 同环境连续构建 SHA-256 可复现校验；
- GitHub Release 必须等待 Quality、Visual Regression、Browser Functional、Komari Compatibility 全部通过。

## 截图

暗色总览：

https://github.com/yyy622hhh/komari-theme-transit/blob/main/docs/screenshots/transit-overview-dark.png

亮色总览：

https://github.com/yyy622hhh/komari-theme-transit/blob/main/docs/screenshots/transit-overview-light.png

拓扑管理器：

https://github.com/yyy622hhh/komari-theme-transit/blob/main/docs/screenshots/transit-topology-manager.png

## 最后

这个主题目前主要按我自己的多线路使用场景持续优化。如果你也在用 Komari，欢迎试用。

遇到问题可以在 GitHub Issue 里附上 Komari 版本、浏览器版本和复现步骤。截图和日志记得先打码 IP、域名、Cookie、Token 等敏感信息。

如果觉得项目有用，欢迎点个 Star；有明确需求或可复现 Bug 也欢迎提 Issue / PR。
