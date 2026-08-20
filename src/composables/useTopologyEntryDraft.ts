import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyModel'
import { ref } from 'vue'
import { getTopologyRouteProbeKey } from '@/utils/topologyHelper'

interface CustomEntrySnapshot {
  node: TopologyNodeConfig
  metric: TopologyMetricConfig
}

/** Keeps a hand-written entry reversible while the editor temporarily applies a preset. */
export function useTopologyEntryDraft(customProbe: string) {
  const snapshots = ref<Record<number, CustomEntrySnapshot>>({})

  function reset(): void {
    snapshots.value = {}
  }

  function remove(routeId: number): void {
    const next = { ...snapshots.value }
    delete next[routeId]
    snapshots.value = next
  }

  function probeValue(route: TopologyRouteConfig): string {
    return getTopologyRouteProbeKey(route) || customProbe
  }

  function remember(route: TopologyRouteConfig): void {
    const node = route.nodes[0]
    const metric = route.metrics[0]
    if (!node || !metric)
      return
    snapshots.value = {
      ...snapshots.value,
      [route.id]: { node: { ...node }, metric: { ...metric } },
    }
  }

  function restore(route: TopologyRouteConfig): boolean {
    const snapshot = snapshots.value[route.id]
    if (!snapshot)
      return false
    route.nodes[0] = { ...snapshot.node }
    route.metrics[0] = { ...snapshot.metric }
    return true
  }

  function label(route: TopologyRouteConfig): string {
    return snapshots.value[route.id]?.node.name.trim() || route.nodes[0]?.name.trim() || '自定义入口'
  }

  function hasOption(route: TopologyRouteConfig): boolean {
    return probeValue(route) === customProbe || Boolean(snapshots.value[route.id])
  }

  return { hasOption, label, probeValue, remember, remove, reset, restore }
}
