import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { onScopeDispose, ref, toValue, watch } from 'vue'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'
import { deleteTopologyPingTasks, ensureTopologyPingTask } from '@/services/ping-task.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { canRunTopologyProbeRepair, runTopologyProbeRepair } from '@/services/topology-repair.service'
import { useAppStore } from '@/stores/app'

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * 挂在公开首页上的后台自愈：判定和写入逻辑全在
 * `services/topology-repair.service.ts`（纯函数，完整单测覆盖）；这里只提供
 * Vue 生命周期、定时器和到 Pinia store / `useTopologyManager` 的取值器桥接。
 */
export function useTopologyProbeRepair(
  nodes: MaybeRefOrGetter<NodeData[]>,
  managerOpen: MaybeRefOrGetter<boolean>,
) {
  const appStore = useAppStore()
  const manager = useTopologyManager(nodes)
  const repairing = ref(false)
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null
  let activeController: AbortController | null = null

  function canRepair(): boolean {
    return canRunTopologyProbeRepair({
      disposed,
      autoRepairEnabled: appStore.topologyAutoRepairEnabled,
      managerOpen: toValue(managerOpen),
      privateFeaturesAllowed: appStore.privateFeaturesAllowed,
      topologyRoute: appStore.topologyRoute,
    })
  }

  async function repairNow(): Promise<void> {
    if (repairing.value || !canRepair())
      return

    repairing.value = true
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
        signal: controller.signal,
      })
    }
    catch {
      // Background repair is best-effort; auth services synchronize expired sessions.
    }
    finally {
      if (activeController === controller)
        activeController = null
      repairing.value = false
    }
  }

  if (typeof window !== 'undefined') {
    timer = window.setInterval(() => {
      // 标签页在后台时没人看结果，也没必要每分钟打一轮 admin 请求。
      if (pageIsVisible())
        void repairNow()
    }, OPS_TOPOLOGY_HOP_PROBE.recheckIntervalMs)
  }

  watch(canRepair, (available) => {
    if (!available)
      activeController?.abort()
  })

  onScopeDispose(() => {
    disposed = true
    activeController?.abort()
    if (timer !== null)
      clearInterval(timer)
  })

  return { repairing, repairNow }
}
