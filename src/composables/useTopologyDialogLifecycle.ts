import type { Ref } from 'vue'
import type { useTopologyEntryDraft } from '@/composables/useTopologyEntryDraft'
import type { useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import type { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import type { createTopologyPersistence } from '@/services/topology-persistence.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import { onScopeDispose, watch } from 'vue'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'

/**
 * `manager` 是 reactive() 包过的代理，顶层 ref 会被自动解包，所以这里用解包后
 *  的纯值类型（对齐 topology-persistence.service.ts 里同样场景的写法），而不是
 *  `ReturnType<typeof useTopologyManager>` ——那样 `routes` 会被误标成 `Ref<...>`。
 */
interface TopologyDialogLifecycleManager {
  reset: () => void
  routes: TopologyRouteConfig[]
}

export interface TopologyDialogLifecycleDeps {
  props: { nodes: NodeData[], open: boolean }
  manager: TopologyDialogLifecycleManager
  catalog: Pick<ReturnType<typeof useTopologyTaskCatalog>, 'reset'>
  planner: Pick<ReturnType<typeof useTopologyRoutePlanner>, 'reset' | 'planRouteTasks' | 'cancelRouteTaskPlanning'>
  entryDraft: Pick<ReturnType<typeof useTopologyEntryDraft>, 'reset'>
  persistence: Pick<ReturnType<typeof createTopologyPersistence>, 'waitForIdle' | 'persistRoutes' | 'abort'>
  /** 拓扑侧「重跑一轮」的状态，两个组合式函数都要读写，所以由外层持有并按引用传入。 */
  rematching: Ref<boolean>
  rematchDone: Ref<boolean>
  /** 是否忙碌（保存中/快速添加中/复检中），定期复检计时器据此跳过这一轮。 */
  managerBusy: { readonly value: boolean }
  syncQuickSelections: () => void
  resetQuickProbeKey: () => void
  /** 相当于原来的 quickConfigurationRun+=1 加 quickConfiguring=false 两步。 */
  cancelQuickConfigurationRun: () => void
  hasPendingWork: () => boolean
  persistBlockingErrors: { value: string[] }
  refreshWriteLog: () => void
  getDialogSession: () => number
  bumpDialogSession: () => number
  /** 打开对话框前等后台自愈这一轮结束，避免两份 expected 快照互相踩。 */
  waitForRepairIdle?: () => Promise<void>
}

/**
 * 对话框开关生命周期、定期复检计时器与「重置」——从 `useTopologyManagerDialog`
 * 拆出来只是为了把那个组合式函数顶到 600 行的部分挪走。`dialogSession` 这个
 * 世代号仍由外层持有并通过 `getDialogSession`/`bumpDialogSession` 注入，因为
 * `createTopologyPersistence` 也要读同一个号码来判断保存是否还对着当前这次
 * 打开——两处判断口径必须唯一。
 */
export function useTopologyDialogLifecycle(deps: TopologyDialogLifecycleDeps) {
  const { props, manager, catalog, planner, entryDraft, persistence, rematching, rematchDone } = deps

  let recheckTimer: ReturnType<typeof setInterval> | null = null

  function stopRecheckTimer(): void {
    if (!recheckTimer)
      return
    clearInterval(recheckTimer)
    recheckTimer = null
  }

  /**
   * 对话框开着的时候定期复检一轮：刚建好的任务要过一会儿才出样本，判死后才能
   * 自动换探测方式。操作者什么都不用点，看着提示行变绿即可。
   */
  function startRecheckTimer(): void {
    stopRecheckTimer()
    if (typeof window === 'undefined')
      return
    recheckTimer = setInterval(() => {
      if (props.open && !deps.managerBusy.value)
        void rematchOpenRoutes(deps.getDialogSession())
    }, OPS_TOPOLOGY_HOP_PROBE.recheckIntervalMs)
  }

  function recheckNow(): void {
    if (!props.open || deps.managerBusy.value)
      return
    void rematchOpenRoutes(deps.getDialogSession())
  }

  function cancelQuickConfiguration(): void {
    deps.cancelQuickConfigurationRun()
    persistence.abort()
  }

  async function rematchOpenRoutes(session: number): Promise<void> {
    rematching.value = true
    try {
      for (const route of manager.routes) {
        if (session !== deps.getDialogSession() || !props.open)
          return
        await planner.planRouteTasks(route)
      }
      if (session !== deps.getDialogSession() || !props.open)
        return
      if (deps.hasPendingWork() && !deps.persistBlockingErrors.value.length) {
        await persistence.persistRoutes({
          keepOpen: true,
          ignoreBusy: true,
          successMessage: '已按当前节点校正并保存。',
        })
      }
    }
    finally {
      if (session === deps.getDialogSession()) {
        rematching.value = false
        rematchDone.value = true
      }
    }
  }

  function reset(): void {
    cancelQuickConfiguration()
    planner.cancelRouteTaskPlanning()
    rematchDone.value = false
    rematching.value = true
    const session = deps.getDialogSession()
    void (async () => {
      await deps.waitForRepairIdle?.()
      await persistence.waitForIdle()
      if (session !== deps.getDialogSession() || !props.open)
        return
      manager.reset()
      catalog.reset()
      planner.reset()
      entryDraft.reset()
      await rematchOpenRoutes(session)
    })()
  }

  watch(() => props.open, (value) => {
    deps.bumpDialogSession()
    deps.refreshWriteLog()
    const session = deps.getDialogSession()
    if (!value) {
      rematching.value = false
      rematchDone.value = false
      stopRecheckTimer()
      cancelQuickConfiguration()
      planner.cancelRouteTaskPlanning()
      return
    }
    rematchDone.value = false
    rematching.value = true
    deps.resetQuickProbeKey()
    void (async () => {
      await deps.waitForRepairIdle?.()
      await persistence.waitForIdle()
      if (session !== deps.getDialogSession() || !props.open)
        return
      manager.reset()
      catalog.reset()
      planner.reset()
      entryDraft.reset()
      deps.syncQuickSelections()
      startRecheckTimer()
      await rematchOpenRoutes(session)
    })()
  }, { immediate: true })

  onScopeDispose(() => {
    deps.bumpDialogSession()
    stopRecheckTimer()
    cancelQuickConfiguration()
    planner.cancelRouteTaskPlanning()
  })

  return {
    recheckNow,
    reset,
  }
}
