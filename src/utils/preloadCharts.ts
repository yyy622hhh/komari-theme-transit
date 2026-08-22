import { chartsPreloadState } from '@/utils/renderModeState'

let scheduled = false

/**
 * 浏览器空闲时把节点详情页要用的图表 chunk（echarts + LoadChart.vue 及其同伴）
 * 提前拉取好，真正点进详情页时就不用再等一次网络往返。只是预取模块，不挂载、
 * 不渲染——`import()` 本身就会触发下载并缓存在模块注册表里，之后 `defineAsyncComponent`
 * 再次 `import()` 同一个模块会直接命中缓存。
 *
 * 用 requestIdleCallback 而不是 onMounted 里直接调用：首屏渲染、水合、首次数据
 * 拉取都比这个预取更重要，抢不到主线程空闲时间就不该抢。降级到 setTimeout 是因为
 * Safari 到目前为止都没实现 requestIdleCallback。
 */
export function preloadChartsOnIdle(): void {
  if (scheduled)
    return
  scheduled = true

  const run = async () => {
    chartsPreloadState.value = 'loading'
    try {
      await Promise.all([
        import('@/components/LoadChart.vue'),
        import('@/components/PingChart.vue'),
      ])
      chartsPreloadState.value = 'done'
    }
    catch {
      chartsPreloadState.value = 'failed'
    }
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window)
    window.requestIdleCallback(() => void run(), { timeout: 10_000 })
  else
    setTimeout(() => void run(), 4000)
}
