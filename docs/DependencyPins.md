# 依赖钉子

本仓库大部分依赖写的是精确版本，那只是锁定策略，不构成「不许升」。

这里记录的是另一类：**已经尝试过升级、测出真实问题后主动退回的主版本**。这类钉子的危险不在于钉住本身，而在于当初的理由会过期，而过期是无声的——所以每条都必须写出**可判定的解除条件**，而不是只写原因。

复查节奏：每季度一次，或在准备一轮依赖升级之前。复查时更新下方的「上次复查」。

---

## typescript — 钉在 `5.9.3`，最新主版本 `7.x`

**当初测出的问题**（2026-08-18，`ea3f489`）

TypeScript 7 是原生 Go 重写，npm 包结构随之改变。`vue-tsc@3.3.10`（当时已是最新）在它上面**根本起不来**：`vue-tsc` 内部的 `resolveTscPath()` 硬编码要求 `typescript/lib/tsc` 这个子路径，而 TS 7 的 `package.json` 不再 export 它，直接报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。这是加载期崩溃，不是可以逐个修的类型错误。

**解除条件**（要全部满足）

1. `vue-tsc` 发布了适配 TS 7 包结构的版本。可判定的检查：
   ```bash
   npm view vue-tsc peerDependencies
   ```
   `typescript` 的范围包含 `7.x` 才算数；仅仅是版本号变大不算。
2. 在该组合下 `bun run type-check` 能跑完并通过。

**不能作为解除理由**：构建不报错。`vite build` 不做类型检查，它绿了什么都说明不了。

**上次复查**：2026-08-20（无变化）

---

## vite — 钉在 `7.3.6`，最新主版本 `8.x`

**当初测出的问题**（2026-08-18，`1b9d188`）

Vite 8 把 rolldown 变成默认打包器（`vite` 的 `package.json` 直接依赖 rolldown，不再是可选）。两个后果：

1. `rollupOptions.output.manualChunks` 的对象简写形式不再支持，rolldown 只认函数形式。**这条容易修**，不是真正的阻塞点。
2. chunk 图与 modulepreload 分析变了：`echarts` 这种本该懒加载的重 chunk 会被当成首屏 `modulepreload` 发出去，直接击穿初始包预算。这正是本项目性能预算存在的意义所在，属于真实回归，不是配置问题。

**解除条件**（要全部满足）

1. `vite.config.ts` 的 `manualChunks` 改成函数形式（可以先于升级完成，与 vite 7 兼容）。
2. 升级后 `bun run audit:bundle` 通过，且输出里 `module preloads` 不包含 `echarts` / `globe` / `three`——脚本里的 `FORBIDDEN_PRELOADS` 已经在把这条守住，越过就会直接报错。
3. `bun run audit:performance` 的初始包 gzip 不越过硬限（见 `scripts/bundle-budget.ts`）。

**上次复查**：2026-08-20（无变化）

---

## 复查怎么做

```bash
# 1. 看当前钉住的版本和最新版本的距离
npm view typescript version
npm view vite version
npm view vue-tsc peerDependencies

# 2. 想真的验证，就在一次性分支上升级并跑完整门禁——只跑构建没有意义
bun run lint:check && bun run type-check && bun run test:unit
bun run build && bun run audit:bundle && bun run audit:performance
```

解除任何一条钉子时，把对应小节从本文件删掉，并在 CHANGELOG 里写清楚是什么变化让它得以解除——下一个人需要知道的是「为什么现在可以了」，不是「升了」。
