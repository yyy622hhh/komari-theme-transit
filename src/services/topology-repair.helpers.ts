import type { AdminPingTask } from '@/services/ping-task.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyModel'
import { entryTaskIds } from '@/services/ping-task.service'
import { resolveTopologyNode } from '@/utils/topologyHelper'

export interface TopologyRetiredTask {
  id: number
  name: string
}

export function liveTopologyTaskNames(routes: readonly Pick<TopologyRouteConfig, 'metrics'>[]): Set<string> {
  return new Set(routes.flatMap(route => route.metrics
    .filter(metric => metric.live)
    .map(metric => metric.taskFilter.trim())
    .filter(Boolean)))
}

export function listLiveEntryTaskIds(
  routes: readonly Pick<TopologyRouteConfig, 'nodes' | 'metrics'>[],
  nodes: readonly NodeData[],
  tasks: readonly AdminPingTask[],
  retiredIds: ReadonlySet<number> = new Set(),
): Set<number> {
  return new Set(routes.flatMap((route) => {
    const metric = route.metrics[0]
    const boundName = metric?.taskFilter.trim()
    if (!metric?.live || !boundName)
      return []
    const source = resolveTopologyNode(nodes, route.nodes[1]?.name ?? '', route.nodes[1]?.uuid ?? '')
    if (!source?.uuid)
      return []
    const matchingIds = [...entryTaskIds(tasks, source.uuid, boundName)]
    const remaining = matchingIds.filter(id => !retiredIds.has(id))
    return remaining.length ? remaining : matchingIds
  }))
}

export function listOwnedRetiredTaskIds(
  retired: readonly TopologyRetiredTask[],
  sessionCreatedIds: ReadonlySet<number>,
  exclude: { boundTaskNames?: ReadonlySet<string>, excludeIds?: ReadonlySet<number> },
): number[] {
  return [...new Set(retired
    .filter(task => sessionCreatedIds.has(task.id)
      && !exclude.boundTaskNames?.has(task.name.trim())
      && !exclude.excludeIds?.has(task.id))
    .map(task => task.id))]
}

export function listOwnedUnboundTaskIds(
  ownedIds: ReadonlySet<number>,
  tasks: ReadonlyArray<{ id?: number, name: string }>,
  boundTaskNames: ReadonlySet<string>,
): number[] {
  const namesById = new Map<number, string>()
  for (const task of tasks) {
    if (!Number.isInteger(task.id))
      continue
    namesById.set(task.id!, task.name.trim())
  }
  return [...ownedIds].filter((id) => {
    const name = namesById.get(id)
    return Boolean(name) && !boundTaskNames.has(name!)
  })
}

export interface TopologyRepairAvailability {
  disposed: boolean
  autoRepairEnabled: boolean
  managerOpen: boolean
  privateFeaturesAllowed: boolean
  topologyRoute: string
  topologyConfigured?: boolean
  pageVisible: boolean
}

export function canRunTopologyProbeRepair(state: TopologyRepairAvailability): boolean {
  return !state.disposed
    && state.autoRepairEnabled
    && !state.managerOpen
    && state.privateFeaturesAllowed
    && (Boolean(state.topologyRoute.trim()) || Boolean(state.topologyConfigured))
    && state.pageVisible
}
