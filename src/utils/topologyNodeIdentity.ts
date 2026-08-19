import type { TopologyQuickNode } from '@/utils/topologyHelper'
import { findUniqueTopologyNode } from '@/utils/topologyHelper'

const STORAGE_KEY = 'pandaTopologyNodeIdentity'
const MAX_ENTRIES = 300
const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000
const REWRITE_THROTTLE_MS = 60_000

interface TopologyIdentityEntry {
  uuid: string
  seenAt: number
}

type TopologyIdentityStore = Record<string, TopologyIdentityEntry>

function normalizeIdentityName(name: string): string {
  return name.trim().toLowerCase()
}

function readIdentityStore(): TopologyIdentityStore {
  if (typeof localStorage === 'undefined')
    return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}
    const store: TopologyIdentityStore = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object')
        continue
      const uuid = (value as { uuid?: unknown }).uuid
      const seenAt = (value as { seenAt?: unknown }).seenAt
      if (typeof uuid === 'string' && uuid && typeof seenAt === 'number')
        store[name] = { uuid, seenAt }
    }
    return store
  }
  catch {
    return {}
  }
}

function writeIdentityStore(store: TopologyIdentityStore): void {
  if (typeof localStorage === 'undefined')
    return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
  catch {
    // 隐私模式或存储配额已满时静默放弃——这只是尽力而为的缓存，不影响主流程。
  }
}

function pruneIdentityStore(store: TopologyIdentityStore): TopologyIdentityStore {
  const now = Date.now()
  const entries = Object.entries(store).filter(([, entry]) => now - entry.seenAt <= MAX_AGE_MS)
  entries.sort((left, right) => right[1].seenAt - left[1].seenAt)
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES))
}

/**
 * 持续记录「名称 → uuid」的最近关联，供节点改名后按旧名称反查使用。
 *
 * 只增量更新、不会因为某个名字暂时从当前节点列表消失就删除它——改名恰恰是
 * 「旧名字不再出现在当前列表」，那一刻正是需要保留旧记录的时候。过期只按
 * 时间和总量淘汰，不按「是否还能在当前节点里找到」淘汰。
 *
 * 节点名称本来就展示在公开首页，缓存内容不涉及新的隐私暴露，因此对所有访客
 * （不限管理员）都可以持续调用来保温这份缓存。
 */
export function recordTopologyNodeIdentity(nodes: readonly TopologyQuickNode[]): void {
  if (typeof localStorage === 'undefined')
    return
  const relevant = nodes.filter(node => node.uuid && node.name.trim())
  if (!relevant.length)
    return
  const store = readIdentityStore()
  const now = Date.now()
  const currentUuids = new Set(relevant.map(node => node.uuid))
  let changed = false
  for (const node of relevant) {
    const key = normalizeIdentityName(node.name)
    const existing = store[key]
    // A node can be renamed while another node takes its old name. Preserve
    // the old association while that UUID is still present so resolution can
    // report the reuse as a conflict instead of silently rebinding routes.
    if (existing?.uuid !== node.uuid && existing?.uuid && currentUuids.has(existing.uuid))
      continue
    if (existing?.uuid === node.uuid && now - existing.seenAt < REWRITE_THROTTLE_MS)
      continue
    store[key] = { uuid: node.uuid!, seenAt: now }
    changed = true
  }
  if (changed)
    writeIdentityStore(pruneIdentityStore(store))
}

export interface TopologyNodeIdentityResolution<T extends TopologyQuickNode> {
  node?: T
  status: 'direct' | 'cached' | 'conflict' | 'missing'
}

/**
 * Resolve a configured name without allowing a reused name to change UUIDs.
 * Mutating callers must treat `conflict` exactly like an unresolved node.
 */
export function resolveTopologyNodeIdentityState<T extends TopologyQuickNode>(
  nodes: readonly T[],
  name: string,
): TopologyNodeIdentityResolution<T> {
  const trimmed = name.trim()
  if (!trimmed)
    return { status: 'missing' }
  const direct = findUniqueTopologyNode(nodes, name)
  if (typeof localStorage === 'undefined')
    return direct ? { node: direct, status: 'direct' } : { status: 'missing' }
  const cachedUuid = readIdentityStore()[normalizeIdentityName(trimmed)]?.uuid
  if (!cachedUuid)
    return direct ? { node: direct, status: 'direct' } : { status: 'missing' }

  if (direct && direct.uuid !== cachedUuid)
    return { status: 'conflict' }
  if (direct)
    return { node: direct, status: 'direct' }

  const matches = nodes.filter(node => node.uuid === cachedUuid)
  return matches.length === 1
    ? { node: matches[0], status: 'cached' }
    : { status: 'missing' }
}

export function resolveTopologyNodeIdentity<T extends TopologyQuickNode>(
  nodes: readonly T[],
  name: string,
): T | undefined {
  return resolveTopologyNodeIdentityState(nodes, name).node
}
