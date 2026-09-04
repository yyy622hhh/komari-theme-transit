import type { TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
import { TOPOLOGY_NODE_RESERVED_PATTERN } from '@/utils/topologyModel'

function quickNodeRank(node: TopologyQuickNode): number {
  if (node.online === true)
    return 0
  if (node.online === false)
    return 2
  return 1
}

export function listQuickTopologyNodes<T extends TopologyQuickNode>(nodes: readonly T[]): T[] {
  const nameCounts = new Map<string, number>()
  for (const node of nodes) {
    const name = node.name.trim().toLowerCase()
    if (name)
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }

  return nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name.trim()
      && node.online !== false
      && (Boolean(node.uuid?.trim()) || nameCounts.get(node.name.trim().toLowerCase()) === 1)
      && !TOPOLOGY_NODE_RESERVED_PATTERN.test(node.name)
      && !TOPOLOGY_NODE_RESERVED_PATTERN.test(node.region ?? ''))
    .sort((left, right) => quickNodeRank(left.node) - quickNodeRank(right.node) || left.index - right.index)
    .map(({ node }) => node)
}

export function getQuickTopologySourceNode<T extends TopologyQuickNode>(nodes: readonly T[]): T | null {
  return listQuickTopologyNodes(nodes)[0] ?? null
}

export function findUniqueTopologyNode<T extends Pick<TopologyQuickNode, 'name'>>(nodes: readonly T[], name: string): T | undefined {
  const normalized = name.trim().toLowerCase()
  if (!normalized)
    return undefined
  const matches = nodes.filter(node => node.name.trim().toLowerCase() === normalized)
  return matches.length === 1 ? matches[0] : undefined
}

export function resolveTopologyNode<T extends TopologyQuickNode>(
  nodes: readonly T[],
  name: string,
  uuid = '',
): T | undefined {
  const id = uuid.trim()
  if (id) {
    const matches = nodes.filter(node => node.uuid?.trim() === id)
    if (matches.length === 1)
      return matches[0]
  }
  return findUniqueTopologyNode(nodes, name)
}

export function resolveTopologyMetricSource<T extends TopologyQuickNode>(
  nodes: readonly T[],
  nodeName: string,
  uuid = '',
): T | undefined {
  const named = nodeName.trim()
  const id = uuid.trim()
  const namedNode = findUniqueTopologyNode(nodes, named)
  if (id) {
    const matches = nodes.filter(node => node.uuid?.trim() === id)
    if (matches.length === 1) {
      if (namedNode && namedNode.uuid?.trim() && namedNode.uuid.trim() !== id)
        return namedNode
      return matches[0]
    }
  }
  return namedNode
}

export function hydrateTopologyRouteNodes(
  routes: TopologyRouteConfig[],
  nodes: readonly TopologyQuickNode[],
): void {
  for (const route of routes) {
    route.nodes.forEach((config, index) => {
      if (index === 0)
        return
      const resolved = resolveTopologyNode(nodes, config.name, config.uuid)
      if (!resolved?.uuid)
        return
      config.uuid = resolved.uuid
      config.name = resolved.name.trim()
      if (resolved.region?.trim())
        config.region = resolved.region.trim()
    })
  }
}
