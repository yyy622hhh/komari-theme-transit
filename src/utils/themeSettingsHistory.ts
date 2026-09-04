import type { ThemeSettings } from '@/utils/themeSettings'
import { validateThemeSettings } from '@/utils/themeSettings'
import { themeSettingsEqual } from '@/utils/themeSettingsBackup'

const STORAGE_KEY = 'transit:theme-settings-history'
const MAX_ENTRIES = 20
const MAX_INSPECTED_ENTRIES = MAX_ENTRIES * 4

export type ThemeSettingsVersionSource = 'initial' | 'external-change' | 'theme-write' | 'import' | 'rollback'

export interface ThemeSettingsVersionEntry {
  at: number
  settings: ThemeSettings
  source: ThemeSettingsVersionSource
}

/**
 * 本地保存的最近 N 份完整配置快照，纯粹是为了"一键回滚"——不是审计日志，
 * 也不试图记录是谁改的（Komari 后台的改动本来就没有身份信息可拿）。存
 * localStorage：同浏览器跨标签页共享，不占用后端配置写入额度，逻辑和
 * topologyWriteLog.ts 里的写入流水一致。
 */
function canUseLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

const VERSION_SOURCES = new Set<ThemeSettingsVersionSource>([
  'initial',
  'external-change',
  'theme-write',
  'import',
  'rollback',
])

function parseEntry(value: unknown): ThemeSettingsVersionEntry | null {
  if (!value || typeof value !== 'object')
    return null
  const entry = value as Record<string, unknown>
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)
    || !VERSION_SOURCES.has(entry.source as ThemeSettingsVersionSource)
    || !entry.settings || typeof entry.settings !== 'object' || Array.isArray(entry.settings)) {
    return null
  }
  try {
    return {
      at: entry.at as number,
      settings: validateThemeSettings(entry.settings),
      source: entry.source as ThemeSettingsVersionSource,
    }
  }
  catch {
    return null
  }
}

export function readThemeSettingsHistory(): ThemeSettingsVersionEntry[] {
  if (!canUseLocalStorage())
    return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed))
      return []
    const entries: ThemeSettingsVersionEntry[] = []
    for (const value of parsed.slice(0, MAX_INSPECTED_ENTRIES)) {
      const entry = parseEntry(value)
      if (entry)
        entries.push(entry)
      if (entries.length >= MAX_ENTRIES)
        break
    }
    return entries
  }
  catch {
    return []
  }
}

/**
 * 追加一个版本快照。和上一条内容完全相同就跳过——否则窗口每次重新聚焦刷新一次
 * 设置就会插一条重复记录，20 条的额度很快就被"什么都没变"占满。
 */
const SOURCE_SPECIFICITY: Record<ThemeSettingsVersionSource, number> = {
  'initial': 0,
  'external-change': 1,
  'theme-write': 2,
  'import': 2,
  'rollback': 2,
}

function persistHistory(entries: ThemeSettingsVersionEntry[]): boolean {
  let next = entries
  while (true) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return true
    }
    catch {
      // 配额满了就丢最旧的再试；一整份快照都写不下才放弃，不能让导入看起来
      // 记上了其实列表还停在更早的版本。
      if (next.length <= 1)
        return false
      next = next.slice(0, -1)
    }
  }
}

export function recordThemeSettingsVersion(settings: ThemeSettings, source: ThemeSettingsVersionSource): boolean {
  if (!canUseLocalStorage())
    return false
  const history = readThemeSettingsHistory()
  if (history[0] && themeSettingsEqual(history[0].settings, settings)) {
    // App 根上的 recorder 会把保存写成 external-change；导入/回滚/向导随后用
    // 更具体的来源标同一份快照。内容相同就只升级标签，不另插一条「当前」。
    if (SOURCE_SPECIFICITY[source] <= SOURCE_SPECIFICITY[history[0].source])
      return true
    return persistHistory([{ ...history[0], source }, ...history.slice(1)])
  }
  return persistHistory([{ at: Date.now(), settings, source }, ...history].slice(0, MAX_ENTRIES))
}

export function clearThemeSettingsHistory(): void {
  if (!canUseLocalStorage())
    return
  try {
    localStorage.removeItem(STORAGE_KEY)
  }
  catch {
  }
}
