import type { NodeData } from '@/stores/nodes'
import { getRealtimeTotalSpeed } from '@/utils/nodeMetricsHelper'
import { isNodeMatchSearch } from '@/utils/nodeSearch'
import { getSharedRpc } from '@/utils/rpc'

export type ServerListStatusFilter = 'all' | 'online' | 'offline' | 'maintenance'
export type ServerListSortKey = 'official' | 'status' | 'name' | 'cpu' | 'traffic' | 'updated'
export type ServerListSortDirection = 'asc' | 'desc'

export interface ServerListSummary {
  total: number
  online: number
  offline: number
  maintenance: number
}

interface FilterServerListOptions {
  query: string
  status: ServerListStatusFilter
  maintenanceIds: ReadonlySet<string>
  sortKey: ServerListSortKey
  sortDirection: ServerListSortDirection
}

function isMaintenanceNode(node: NodeData, maintenanceIds: ReadonlySet<string>): boolean {
  return maintenanceIds.has(node.uuid)
}

function matchesStatus(
  node: NodeData,
  status: ServerListStatusFilter,
  maintenanceIds: ReadonlySet<string>,
): boolean {
  const maintenance = isMaintenanceNode(node, maintenanceIds)

  if (status === 'maintenance')
    return maintenance
  if (status === 'online')
    return node.online && !maintenance
  if (status === 'offline')
    return !node.online && !maintenance
  return true
}

function getStatusRank(node: NodeData, maintenanceIds: ReadonlySet<string>): number {
  if (isMaintenanceNode(node, maintenanceIds))
    return 1
  return node.online ? 0 : 2
}

function getUpdatedTimestamp(node: NodeData): number {
  const timestamp = Date.parse(node.status_updated_at || node.time || node.updated_at || '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function getOfficialWeight(node: Pick<NodeData, 'weight'>): number {
  return Number.isFinite(node.weight) ? node.weight : Number.MAX_SAFE_INTEGER
}

export function compareOfficialServerOrder(
  left: Pick<NodeData, 'name' | 'weight'>,
  right: Pick<NodeData, 'name' | 'weight'>,
): number {
  const result = getOfficialWeight(left) - getOfficialWeight(right)
  return result === 0 ? left.name.localeCompare(right.name, 'zh-CN') : result
}

export function sortServersByOfficialOrder(nodes: NodeData[]): NodeData[] {
  return [...nodes].sort(compareOfficialServerOrder)
}

/** Keep an in-progress order complete when the live node set changes. */
export function reconcileServerOrder(
  orderedUuids: string[],
  nodes: Array<Pick<NodeData, 'name' | 'uuid' | 'weight'>>,
): string[] {
  const currentUuids = new Set(nodes.map(node => node.uuid))
  const reconciled: string[] = []
  const included = new Set<string>()

  for (const uuid of orderedUuids) {
    if (currentUuids.has(uuid) && !included.has(uuid)) {
      reconciled.push(uuid)
      included.add(uuid)
    }
  }

  const appended = nodes
    .filter(node => !included.has(node.uuid))
    .sort(compareOfficialServerOrder)
    .map(node => node.uuid)

  return [...reconciled, ...appended]
}

function compareNodeValue(
  left: NodeData,
  right: NodeData,
  key: ServerListSortKey,
  maintenanceIds: ReadonlySet<string>,
): number {
  if (key === 'official')
    return compareOfficialServerOrder(left, right)
  if (key === 'name')
    return left.name.localeCompare(right.name, 'zh-CN')
  if (key === 'cpu')
    return (left.cpu || 0) - (right.cpu || 0)
  if (key === 'traffic')
    return getRealtimeTotalSpeed(left) - getRealtimeTotalSpeed(right)
  if (key === 'updated')
    return getUpdatedTimestamp(left) - getUpdatedTimestamp(right)
  return getStatusRank(left, maintenanceIds) - getStatusRank(right, maintenanceIds)
}

export async function saveServerOrder(orderedUuids: string[]): Promise<Record<string, number>> {
  if (!orderedUuids.length || new Set(orderedUuids).size !== orderedUuids.length)
    throw new Error('服务器顺序无效，请刷新后重试')

  const order = Object.fromEntries(orderedUuids.map((uuid, index) => [uuid, index]))
  await getSharedRpc().orderClients(order)
  return order
}

export function summarizeServerList(
  nodes: NodeData[],
  maintenanceIds: ReadonlySet<string>,
): ServerListSummary {
  return nodes.reduce<ServerListSummary>((summary, node) => {
    summary.total++
    if (isMaintenanceNode(node, maintenanceIds))
      summary.maintenance++
    else if (node.online)
      summary.online++
    else
      summary.offline++
    return summary
  }, { total: 0, online: 0, offline: 0, maintenance: 0 })
}

export function filterAndSortServerList(
  nodes: NodeData[],
  options: FilterServerListOptions,
): NodeData[] {
  const direction = options.sortDirection === 'asc' ? 1 : -1

  return nodes
    .filter(node => isNodeMatchSearch(node, options.query))
    .filter(node => matchesStatus(node, options.status, options.maintenanceIds))
    .slice()
    .sort((left, right) => {
      const result = compareNodeValue(left, right, options.sortKey, options.maintenanceIds)
      return result === 0
        ? left.name.localeCompare(right.name, 'zh-CN')
        : result * direction
    })
}
