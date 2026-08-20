const STORAGE_KEY = 'transit:topology-created-task-ids'

let cachedIds: Set<number> | null = null

export function parseTopologyOwnedPingTaskIds(raw: unknown): number[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return []
    }
  }
  if (!Array.isArray(value))
    return []
  return [...new Set(value.filter((id): id is number => Number.isInteger(id) && id > 0))]
}

export function serializeTopologyOwnedPingTaskIds(ids: ReadonlySet<number> | readonly number[]): string {
  return JSON.stringify([...ids].filter(id => Number.isInteger(id) && id > 0))
}

function canUseSessionStorage(): boolean {
  return typeof sessionStorage !== 'undefined'
}

function readStoredIds(): Set<number> {
  if (!canUseSessionStorage())
    return new Set()

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw)
      return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed))
      return new Set()
    return new Set(parsed.filter((id): id is number => Number.isInteger(id) && id > 0))
  }
  catch {
    return new Set()
  }
}

/** 自愈和拓扑管理器共用同一份所有权集合，避免互相 persist 把对方刚记下的 ID 盖掉。 */
export function getTopologyCreatedTaskIds(): Set<number> {
  cachedIds ??= readStoredIds()
  return cachedIds
}

export function persistTopologyCreatedTaskIds(ids: ReadonlySet<number> = getTopologyCreatedTaskIds()): void {
  cachedIds = ids instanceof Set ? ids : new Set(ids)
  if (!canUseSessionStorage())
    return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...cachedIds]))
  }
  catch {
  }
}

export function loadTopologyCreatedTaskIds(): Set<number> {
  return getTopologyCreatedTaskIds()
}

/** 把主题配置里记过的所有权并进本页会话，关标签页后再打开仍能清理自己建的任务。 */
export function rememberTopologyCreatedTaskId(id: number): void {
  if (!Number.isInteger(id) || id <= 0)
    return
  const current = getTopologyCreatedTaskIds()
  if (current.has(id))
    return
  current.add(id)
  persistTopologyCreatedTaskIds(current)
}

export function adoptTopologyCreatedTaskIds(ids: Iterable<number>): void {
  const current = getTopologyCreatedTaskIds()
  let changed = false
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || current.has(id))
      continue
    current.add(id)
    changed = true
  }
  if (changed)
    persistTopologyCreatedTaskIds(current)
}

export function resetTopologyCreatedTaskIdsCache(): void {
  cachedIds = null
}
