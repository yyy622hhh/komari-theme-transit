import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 触屏「点击展开/收起」tooltip 的状态机，不含设备检测的挂载/卸载逻辑，方便
 * 直接单测。真正在组件里用的是下面的 {@link useTouchTooltipMode}。
 */
export function createTouchTooltipState() {
  const isTouchTooltipMode = ref(false)
  const activeTaskTooltipId = ref<number | null>(null)
  const smoothInfoTooltipOpen = ref(false)

  function setTaskTooltipOpen(taskId: number, open: boolean): void {
    // 触屏由 toggle 关；忽略 reka 在第一次点开后立刻发出的 blur/onClose。
    if (isTouchTooltipMode.value && !open)
      return
    activeTaskTooltipId.value = open
      ? taskId
      : activeTaskTooltipId.value === taskId ? null : activeTaskTooltipId.value
  }

  function setSmoothInfoOpen(open: boolean): void {
    if (isTouchTooltipMode.value && !open)
      return
    smoothInfoTooltipOpen.value = open
  }

  function toggleTaskTooltip(taskId: number): void {
    if (!isTouchTooltipMode.value)
      return

    activeTaskTooltipId.value = activeTaskTooltipId.value === taskId ? null : taskId
    smoothInfoTooltipOpen.value = false
  }

  function toggleSmoothInfoTooltip(): void {
    if (!isTouchTooltipMode.value)
      return

    smoothInfoTooltipOpen.value = !smoothInfoTooltipOpen.value
    if (smoothInfoTooltipOpen.value)
      activeTaskTooltipId.value = null
  }

  /** 换节点/换数据时收起已经打开的 tooltip，避免残留指向旧任务。 */
  function reset(): void {
    activeTaskTooltipId.value = null
    smoothInfoTooltipOpen.value = false
  }

  return {
    isTouchTooltipMode,
    activeTaskTooltipId,
    smoothInfoTooltipOpen,
    setTaskTooltipOpen,
    setSmoothInfoOpen,
    toggleTaskTooltip,
    toggleSmoothInfoTooltip,
    reset,
  }
}

/**
 * 触屏设备上「点击展开/收起」代替桌面端「悬停显示」的 tooltip 状态机。
 *
 * 只依赖 `window`/`navigator`，跟具体图表数据完全无关，PingChart.vue 用它来
 * 决定任务图例和平滑说明这两处 tooltip 该不该响应点击。
 */
export function useTouchTooltipMode() {
  const state = createTouchTooltipState()
  let coarsePointerMediaQuery: MediaQueryList | null = null

  function syncTouchTooltipMode(): void {
    if (typeof window === 'undefined') {
      state.isTouchTooltipMode.value = false
      return
    }

    state.isTouchTooltipMode.value = window.matchMedia('(pointer: coarse)').matches
  }

  onMounted(() => {
    syncTouchTooltipMode()
    coarsePointerMediaQuery = window.matchMedia('(pointer: coarse)')
    coarsePointerMediaQuery.addEventListener('change', syncTouchTooltipMode)
  })

  onBeforeUnmount(() => {
    coarsePointerMediaQuery?.removeEventListener('change', syncTouchTooltipMode)
    coarsePointerMediaQuery = null
  })

  return state
}
