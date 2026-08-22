import type { ThemeSettings } from '@/utils/themeSettings'
import { themeSettingsEqual } from '@/utils/themeSettingsBackup'

const STORAGE_KEY = 'transit:theme-settings-history'
const MAX_ENTRIES = 20

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

function isEntry(value: unknown): value is ThemeSettingsVersionEntry {
  if (!value || typeof value !== 'object')
    return false
  const entry = value as Record<string, unknown>
  return typeof entry.at === 'number'
    && Boolean(entry.settings) && typeof entry.settings === 'object'
    && typeof entry.source === 'string'
}

export function readThemeSettingsHistory(): ThemeSettingsVersionEntry[] {
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

/**
 * 追加一个版本快照。和上一条内容完全相同就跳过——否则窗口每次重新聚焦刷新一次
 * 设置就会插一条重复记录，20 条的额度很快就被"什么都没变"占满。
 */
export function recordThemeSettingsVersion(settings: ThemeSettings, source: ThemeSettingsVersionSource): void {
  if (!canUseLocalStorage())
    return
  const history = readThemeSettingsHistory()
  if (history[0] && themeSettingsEqual(history[0].settings, settings))
    return
  const next = [{ at: Date.now(), settings, source }, ...history].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  catch {
  }
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
