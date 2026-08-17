import type { HomeQuickControlKey } from '@/stores/app.types'
import type { NodeData } from '@/stores/nodes'
import type { ExchangeRates } from '@/utils/financeHelper'
import { calculateMonthlyCostCNY } from '@/utils/financeHelper'
import {
  getRealtimePeakSpeed,
  getTotalTraffic,
  isExpiringNode,
  isHighLoadNode,
} from '@/utils/nodeMetricsHelper'

export function resolveActiveHomeQuickControl(
  active: HomeQuickControlKey | null,
  enabled: boolean,
  keys: readonly HomeQuickControlKey[],
): HomeQuickControlKey | null {
  if (!enabled || !active || !keys.includes(active))
    return null
  return active
}

export interface HomeQuickControlContext {
  isFavorite: (uuid: string) => boolean
  isMaintenance: (node: NodeData) => boolean
  highLoadThreshold: number
  expiringDays: number
  offlineNodesLast: boolean
  exchangeRates: ExchangeRates
}

function sortNodesByComputedValue(nodes: NodeData[], selector: (node: NodeData) => number): NodeData[] {
  return nodes
    .map(node => ({ node, value: selector(node) }))
    .sort((left, right) => right.value - left.value)
    .map(item => item.node)
}

function placeOfflineNodesLast(nodes: NodeData[], enabled: boolean): NodeData[] {
  if (!enabled)
    return nodes

  return [...nodes].sort((left, right) => {
    if (left.online === right.online)
      return 0
    return left.online ? -1 : 1
  })
}

export function applyHomeQuickControl(
  nodes: NodeData[],
  control: HomeQuickControlKey | null,
  context: HomeQuickControlContext,
): NodeData[] {
  let result: NodeData[]

  switch (control) {
    case 'favorite':
      return nodes.filter(node => context.isFavorite(node.uuid))
    case 'monthlyCost':
      result = sortNodesByComputedValue(nodes, node => calculateMonthlyCostCNY(node, context.exchangeRates))
      break
    case 'totalTraffic':
      result = sortNodesByComputedValue(nodes, getTotalTraffic)
      break
    case 'upload':
      result = [...nodes].sort((left, right) => (right.net_out || 0) - (left.net_out || 0))
      break
    case 'download':
      result = [...nodes].sort((left, right) => (right.net_in || 0) - (left.net_in || 0))
      break
    case 'peak':
      result = sortNodesByComputedValue(nodes, getRealtimePeakSpeed)
      break
    case 'offline':
      return nodes.filter(node => !node.online && !context.isMaintenance(node))
    case 'highLoad':
      result = nodes.filter(node => isHighLoadNode(node, context.highLoadThreshold))
      break
    case 'expiring':
      result = nodes.filter(node => isExpiringNode(node, context.expiringDays))
      break
    default:
      result = nodes
      break
  }

  return placeOfflineNodesLast(result, context.offlineNodesLast)
}

export function countHomeQuickControl(
  nodes: NodeData[],
  control: HomeQuickControlKey,
  context: HomeQuickControlContext,
): number {
  switch (control) {
    case 'favorite':
      return nodes.reduce((count, node) => count + (context.isFavorite(node.uuid) ? 1 : 0), 0)
    case 'offline':
      return nodes.reduce((count, node) => count + (!node.online && !context.isMaintenance(node) ? 1 : 0), 0)
    case 'highLoad':
      return nodes.reduce((count, node) => count + (isHighLoadNode(node, context.highLoadThreshold) ? 1 : 0), 0)
    case 'expiring':
      return nodes.reduce((count, node) => count + (isExpiringNode(node, context.expiringDays) ? 1 : 0), 0)
    default:
      return nodes.length
  }
}
