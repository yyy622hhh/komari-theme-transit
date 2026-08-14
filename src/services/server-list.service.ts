import type { NodeData } from '@/stores/nodes'
import { getRealtimeTotalSpeed } from '@/utils/nodeMetricsHelper'
import { isNodeMatchSearch } from '@/utils/nodeSearch'

export type ServerListStatusFilter = 'all' | 'online' | 'offline' | 'maintenance'
export type ServerListSortKey = 'status' | 'name' | 'cpu' | 'traffic' | 'updated'
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

function compareNodeValue(
  left: NodeData,
  right: NodeData,
  key: ServerListSortKey,
  maintenanceIds: ReadonlySet<string>,
): number {
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
