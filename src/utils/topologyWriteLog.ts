const STORAGE_KEY = 'transit:topology-write-log'
const MAX_ENTRIES = 60

export type TopologyWriteTrigger = 'manual' | 'auto'
export type TopologyWriteOutcome = 'ok' | 'failed'

export interface TopologyWriteEntry {
  /** 毫秒时间戳。存数字而不是格式化字符串，读的时候才能按用户时区显示。 */
  at: number
  trigger: TopologyWriteTrigger
  /** 一句话说明做了什么，例如「创建探测任务 北京电信」。 */
  action: string
  outcome: TopologyWriteOutcome
  /** 失败原因，或成功时的补充信息。 */
  detail?: string
}

/**
 * 主题对后端 Ping 任务和拓扑绑定做过什么的本地流水。
 *
 * 存在的理由：自动修复会在无人值守时建、删、改后端任务。防护做得再严，事后
 * 也没有任何地方能回答「昨天这个任务是谁建的」——只有失败时首页角标一闪。出问题
 * 时这是唯一能自证清白的东西。
 *
 * 写 localStorage（同源跨标签页共享，刷新、关闭重开都还在）而不是后端：这仍然
 * 是给操作者当场排查用的，不是正式审计日志，不该占用主题配置的写入配额。
 * 跨标签页共享意味着并发写入理论上可能互相覆盖对方刚追加的一条——可接受，
 * 丢一条排查线索不影响主流程，比"每个标签页各看各的、互相看不见"更有用。
 * 仍然是单浏览器本地存储，不跨设备；如需真正的审计留痕请看诊断中心。
 */
function canUseLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

function isEntry(value: unknown): value is TopologyWriteEntry {
  if (!value || typeof value !== 'object')
    return false
  const entry = value as Record<string, unknown>
  return typeof entry.at === 'number'
    && typeof entry.action === 'string'
    && (entry.trigger === 'manual' || entry.trigger === 'auto')
    && (entry.outcome === 'ok' || entry.outcome === 'failed')
}

export function readTopologyWriteLog(): TopologyWriteEntry[] {
  if (!canUseLocalStorage())
    return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  }
  catch {
    return []
  }
}

/** 最新的在前，超出上限的丢弃。写失败静默——流水本身不该反过来影响主流程。 */
export function recordTopologyWrite(entry: Omit<TopologyWriteEntry, 'at'> & { at?: number }): void {
  if (!canUseLocalStorage())
    return
  const next = [{ at: entry.at ?? Date.now(), ...entry }, ...readTopologyWriteLog()].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  catch {
  }
}

export function clearTopologyWriteLog(): void {
  if (!canUseLocalStorage())
    return
  try {
    localStorage.removeItem(STORAGE_KEY)
  }
  catch {
  }
}

/** 把一批任务名压成一句话，避免流水里出现三十个任务名的长串。 */
export function summarizeTaskNames(names: readonly string[], limit = 3): string {
  const usable = names.map(name => name.trim()).filter(Boolean)
  if (!usable.length)
    return ''
  if (usable.length <= limit)
    return usable.join('、')
  return `${usable.slice(0, limit).join('、')} 等 ${usable.length} 个`
}
