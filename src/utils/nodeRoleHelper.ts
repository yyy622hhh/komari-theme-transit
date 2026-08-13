import { parseTags } from '@/utils/tagHelper'

export const NODE_ROLES = ['线路机', '落地机', '订阅机', '探针主机'] as const
export type NodeRole = typeof NODE_ROLES[number]

function isNodeRole(value: string): value is NodeRole {
  return (NODE_ROLES as readonly string[]).includes(value)
}

export function getNodeRole(tags: string | null | undefined, groups: string[] = []): NodeRole | null {
  const candidates = [
    ...parseTags(tags ?? undefined).map(tag => tag.text.trim()),
    ...groups.map(group => group.trim()),
  ]

  return NODE_ROLES.find(role => candidates.some(candidate => candidate === role || candidate.includes(role))) ?? null
}

export function getConfiguredNodeRole(nodeName: string, topologyRoute: string): NodeRole | null {
  const normalizedName = nodeName.trim().toLowerCase()
  const segments = topologyRoute
    .split('||')
    .flatMap(route => route.split(';'))

  for (const segment of segments) {
    const [configuredName = '', , configuredRole = ''] = segment.split('|').map(part => part.trim())
    if (configuredName.toLowerCase() === normalizedName && isNodeRole(configuredRole))
      return configuredRole
  }
  return null
}

export function parseNodeRole(value: string): NodeRole | null {
  return isNodeRole(value) ? value : null
}

export function getNodeRoleTone(role: NodeRole): string {
  const tones: Record<NodeRole, string> = {
    线路机: 'border-cyan-400/20 bg-cyan-400/10 text-cyan-600 dark:text-cyan-300',
    落地机: 'border-violet-400/20 bg-violet-400/10 text-violet-600 dark:text-violet-300',
    订阅机: 'border-amber-400/20 bg-amber-400/10 text-amber-600 dark:text-amber-300',
    探针主机: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-600 dark:text-emerald-300',
  }
  return tones[role]
}
