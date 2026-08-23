import type { MaybeRefOrGetter, Ref } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { useDocumentVisibility } from '@vueuse/core'
import { onScopeDispose, ref, toValue, watch } from 'vue'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'
import { TIME_MS } from '@/constants/time'
import { createTopologyEntryProbeTask, deleteTopologyPingTasks, ensureTopologyEntryProbeTask, ensureTopologyPingTask } from '@/services/ping-task.service'
import { planEntryProbeTask, planWorkingHopTask } from '@/services/topology-probe.service'
import { canRunTopologyProbeRepair, runTopologyProbeRepair } from '@/services/topology-repair.service'
import { useAppStore } from '@/stores/app'
import { logAppWarning } from '@/utils/safeError'
import { getTopologyCreatedTaskIds, persistTopologyCreatedTaskIds } from '@/utils/topologyCreatedTasks'

const REPAIR_ERROR_NOTICE_COOLDOWN_MS = 5 * TIME_MS.minute

export function isAbortLikeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

export function formatTopologyRepairError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '拓扑探测自愈失败'
}

export function shouldAnnounceTopologyRepairError(lastAnnouncedAt: number, now: number): boolean {
  return lastAnnouncedAt <= 0 || now - lastAnnouncedAt >= REPAIR_ERROR_NOTICE_COOLDOWN_MS
}

export interface TopologyRepairRunnerDeps {
  canRepair: () => boolean
  repairing: Ref<boolean>
  run: () => Promise<void>
}

/**
 * 用 `repairing` 锁把并发触发的多次尝试收敛成互斥的单次执行：条件首次满足、
 * 登录状态确认、页面恢复可见和每分钟定时复检都可能在短时间内先后触发，这里
 * 保证同一时刻只有一轮真正在跑，其余尝试直接跳过而不是排队。
 */
export function createTopologyRepairRunner(deps: TopologyRepairRunnerDeps): () => Promise<void> {
  return async function attemptTopologyRepair(): Promise<void> {
    if (deps.repairing.value || !deps.canRepair())
      return
    deps.repairing.value = true
    try {
      await deps.run()
    }
    finally {
      deps.repairing.value = false
    }
  }
}

export interface TopologyProbeRepairTriggerDeps {
  /** 判定这一刻是否可以修复；必须读取所有需要追踪的响应式依赖。 */
  canRepair: () => boolean
  repairNow: () => void
  /** 条件从满足变为不满足时，用来中止正在进行的修复。 */
  abortActive: () => void
  intervalMs: number
}

/**
 * 调度何时尝试一轮修复：条件首次满足、或从不满足变为满足时（登录状态确认、
 * 页面从后台恢复可见等）立即触发一次，不必等第一个定时器；条件失效时中止
 * 正在进行的修复。定时器只负责之后的周期性复检。是否真的执行、并发互斥都
 * 交给 `repairNow`（见 {@link createTopologyRepairRunner}）自己把关。
 */
export function useTopologyProbeRepairTrigger(deps: TopologyProbeRepairTriggerDeps): () => void {
  let seeded = false
  const stopWatch = watch(deps.canRepair, (available) => {
    if (available)
      deps.repairNow()
    else if (seeded)
      deps.abortActive()
    seeded = true
  }, { immediate: true })

  const timer = typeof window === 'undefined'
    ? null
    : window.setInterval(() => deps.repairNow(), deps.intervalMs)

  return () => {
    stopWatch()
    if (timer !== null)
      clearInterval(timer)
  }
}

/**
 * 挂在公开首页上的后台自愈：判定和写入逻辑全在
 * `services/topology-repair.service.ts`（纯函数，完整单测覆盖）；触发调度和
 * 并发互斥拆成上面两个纯函数各自测试；这里只提供 Vue 生命周期、页面可见性
 * 和到 Pinia store / `useTopologyManager` 的取值器桥接。
 */
export function useTopologyProbeRepair(
  nodes: MaybeRefOrGetter<NodeData[]>,
  managerOpen: MaybeRefOrGetter<boolean>,
) {
  const appStore = useAppStore()
  const manager = useTopologyManager(nodes)
  const repairing = ref(false)
  const lastError = ref('')
  const sessionCreatedTaskIds = getTopologyCreatedTaskIds()
  const documentVisibility = useDocumentVisibility()
  let disposed = false
  let activeController: AbortController | null = null
  let lastErrorAnnouncedAt = 0

  function canRepair(): boolean {
    return canRunTopologyProbeRepair({
      disposed,
      autoRepairEnabled: appStore.topologyAutoRepairEnabled,
      managerOpen: toValue(managerOpen),
      privateFeaturesAllowed: appStore.privateFeaturesAllowed,
      topologyRoute: appStore.topologyRoute,
      pageVisible: documentVisibility.value === 'visible',
    })
  }

  async function performRepair(): Promise<void> {
    const controller = new AbortController()
    activeController = controller
    try {
      await runTopologyProbeRepair({
        nodes: () => toValue(nodes),
        canRepair,
        requireLoginPermission: () => appStore.requireLoginPermission('nodeTopology', { force: false }),
        manager: {
          get routes() { return manager.routes.value },
          get validationErrors() { return manager.validationErrors.value },
          get dirty() { return manager.dirty.value },
          reset: manager.reset,
          withSaveLock: manager.withSaveLock,
          preflightSave: manager.preflightSave,
          save: manager.save,
        },
        planWorkingHopTask,
        ensureTopologyPingTask,
        deleteTopologyPingTasks,
        sessionCreatedTaskIds,
        planEntryProbeTask,
        ensureTopologyEntryProbeTask,
        createTopologyEntryProbeTask,
        signal: controller.signal,
      })
      lastError.value = ''
    }
    catch (error) {
      if (isAbortLikeError(error) || controller.signal.aborted)
        return
      const message = formatTopologyRepairError(error)
      lastError.value = message
      logAppWarning('Topology probe auto-repair failed', error)
      const now = Date.now()
      if (shouldAnnounceTopologyRepairError(lastErrorAnnouncedAt, now)) {
        lastErrorAnnouncedAt = now
        window.$message?.warning(`拓扑探测自愈失败：${message}`)
      }
    }
    finally {
      persistTopologyCreatedTaskIds(sessionCreatedTaskIds)
      if (activeController === controller)
        activeController = null
    }
  }

  const repairNow = createTopologyRepairRunner({ canRepair, repairing, run: performRepair })

  const stopTrigger = useTopologyProbeRepairTrigger({
    canRepair,
    repairNow: () => { void repairNow() },
    abortActive: () => activeController?.abort(),
    intervalMs: OPS_TOPOLOGY_HOP_PROBE.recheckIntervalMs,
  })

  onScopeDispose(() => {
    disposed = true
    activeController?.abort()
    stopTrigger()
  })

  return { repairing, lastError, repairNow }
}
