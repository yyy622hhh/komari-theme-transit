import type { MaybeRefOrGetter } from 'vue'
import type { TopologyHopProbe } from '@/services/ping-task.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { onScopeDispose, ref, toValue } from 'vue'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { OPS_TOPOLOGY_HOP_PROBE } from '@/constants/ops'
import { ensureTopologyPingTask } from '@/services/ping-task.service'
import { planWorkingHopTask } from '@/services/topology-probe.service'
import { useAppStore } from '@/stores/app'
import { findUniqueTopologyNode } from '@/utils/topologyHelper'

interface PlannedProbeRepair {
  route: TopologyRouteConfig
  source: NodeData
  landing: NodeData
  probe: TopologyHopProbe
  taskName: string
  needsCreation: boolean
}

export function useTopologyProbeRepair(
  nodes: MaybeRefOrGetter<NodeData[]>,
  managerOpen: MaybeRefOrGetter<boolean>,
) {
  const appStore = useAppStore()
  const manager = useTopologyManager(nodes)
  const repairing = ref(false)
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null

  function canRepair(): boolean {
    return !disposed
      && !toValue(managerOpen)
      && appStore.privateFeaturesAllowed
      && Boolean(appStore.topologyRoute.trim())
  }

  async function planRouteRepair(route: TopologyRouteConfig): Promise<PlannedProbeRepair | null> {
    const source = findUniqueTopologyNode(toValue(nodes), route.nodes[1]?.name ?? '')
    const landing = findUniqueTopologyNode(toValue(nodes), route.nodes[2]?.name ?? '')
    const metric = route.metrics[1]
    if (!source || !landing || !metric?.live)
      return null

    const planned = await planWorkingHopTask(source, landing, metric.taskFilter)
    const bindingChanged = metric.nodeName.trim() !== source.name.trim()
      || metric.taskFilter.trim() !== planned.task.name.trim()
    if (!planned.needsCreation && !bindingChanged)
      return null

    return {
      route,
      source,
      landing,
      probe: planned.probe,
      taskName: planned.task.name,
      needsCreation: planned.needsCreation,
    }
  }

  async function repairNow(): Promise<void> {
    if (repairing.value || !canRepair())
      return

    repairing.value = true
    try {
      const granted = await appStore.requireLoginPermission('nodeTopology', { force: false })
      if (!granted || !canRepair())
        return

      manager.reset()
      if (manager.validationErrors.value.length)
        return

      const repairs = (await Promise.all(manager.routes.value.map(route => planRouteRepair(route).catch(() => null))))
        .filter((repair): repair is PlannedProbeRepair => repair !== null)
      if (!repairs.length || !canRepair())
        return

      await manager.withSaveLock(async () => {
        if (!canRepair())
          return
        await manager.preflightSave()
        if (!canRepair())
          return

        for (const repair of repairs) {
          if (!canRepair())
            return
          const latestRepair = await planRouteRepair(repair.route)
          if (!latestRepair)
            continue
          const metric = latestRepair.route.metrics[1]
          if (!metric?.live)
            continue
          const taskName = latestRepair.needsCreation
            ? (await ensureTopologyPingTask(latestRepair.source, latestRepair.landing, { probe: latestRepair.probe })).task.name
            : latestRepair.taskName
          if (!canRepair())
            return
          metric.nodeName = latestRepair.source.name
          metric.taskFilter = taskName
        }

        if (manager.dirty.value && canRepair())
          await manager.save({ lockHeld: true })
      })
    }
    catch {
      // Background repair is best-effort; auth services synchronize expired sessions.
    }
    finally {
      repairing.value = false
    }
  }

  if (typeof window !== 'undefined') {
    timer = window.setInterval(() => {
      void repairNow()
    }, OPS_TOPOLOGY_HOP_PROBE.recheckIntervalMs)
  }

  onScopeDispose(() => {
    disposed = true
    if (timer !== null)
      clearInterval(timer)
  })

  return { repairing, repairNow }
}
