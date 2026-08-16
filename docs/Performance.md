# 性能与长稳验证

Transit 以可重复的浏览器压力测试和构建产物预算避免性能缓慢回退。测试不依赖真实 Komari 数据，也不会访问公网。

## 本地命令

```bash
bun run build-only
bun run audit:performance
bun run test:performance
```

`audit:performance` 会生成 `test-results/performance/bundle-performance.json`。CI 上传该 JSON，维护者可在不同提交之间比较首屏、HomeView、初始化运行时以及 Globe/Three 动态块的 raw/gzip 体积。

`test:performance` 默认覆盖：

- 2,000 个虚构节点的列表加载与滚动，断言 DOM 行数受虚拟列表约束；
- 首页与详情页重复导航 12 轮，强制 GC 后检查活动定时器、事件监听器和 JS 堆增长。

可在手工长稳验证时提高压力：

```bash
TRANSIT_PERF_NODE_COUNT=5000 \
TRANSIT_PERF_STABILITY_ROUNDS=100 \
bun run test:performance
```

## 预算策略

- 首屏资源 gzip 不超过 145 KiB；
- 关键路由与运行时块设置独立预算，防止代码从首屏转移后在其他关键页面失控；
- Globe 和 Three 必须保持独立动态块，不允许出现在首屏 module preload；
- 浏览器耗时预算采用宽松的回归上限，主要捕获数量级退化，不作为跨机器微基准；
- JSON 报告作为 CI artifact 保留，用于趋势分析。需要调整预算时，应在 PR 中附带前后报告和原因。

长稳测试中的监听器计数包含浏览器和第三方库的稳定基线，因此比较的是重复操作后的增量。若测试失败，应先检查组件卸载、定时器清理、AbortSignal 与缓存订阅释放，而不是直接扩大阈值。
