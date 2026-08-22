import type { ThemeSettings } from '@/utils/themeSettings'
import { validateThemeSettings } from '@/utils/themeSettings'

/** 导出文件的 schema 版本。只在导出格式本身发生不兼容变化时才需要升它。 */
export const THEME_SETTINGS_EXPORT_SCHEMA_VERSION = 1

export interface ThemeSettingsExportFile {
  schemaVersion: number
  themeVersion: string
  exportedAt: number
  settings: ThemeSettings
}

export interface ThemeSettingsDiffEntry {
  key: string
  kind: 'added' | 'changed' | 'removed'
  before?: unknown
  after?: unknown
}

/** 和 JSON.stringify 相比，键顺序固定，避免同一份配置因为键序不同被误判为"有变化"。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function themeSettingsEqual(a: ThemeSettings, b: ThemeSettings): boolean {
  return stableStringify(a) === stableStringify(b)
}

/** 保存前 / 回滚前都要看一眼到底改了哪些字段，而不是盲目相信"应该没问题"。 */
export function diffThemeSettings(current: ThemeSettings, next: ThemeSettings): ThemeSettingsDiffEntry[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  const entries: ThemeSettingsDiffEntry[] = []
  for (const key of keys) {
    const hasCurrent = Object.hasOwn(current, key)
    const hasNext = Object.hasOwn(next, key)
    if (!hasCurrent && hasNext) {
      entries.push({ key, kind: 'added', after: next[key] })
    }
    else if (hasCurrent && !hasNext) {
      entries.push({ key, kind: 'removed', before: current[key] })
    }
    else if (hasCurrent && hasNext && stableStringify(current[key]) !== stableStringify(next[key])) {
      entries.push({ key, kind: 'changed', before: current[key], after: next[key] })
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

export function buildThemeSettingsExport(settings: ThemeSettings, themeVersion: string): ThemeSettingsExportFile {
  return {
    schemaVersion: THEME_SETTINGS_EXPORT_SCHEMA_VERSION,
    themeVersion,
    exportedAt: Date.now(),
    settings,
  }
}

export type ThemeSettingsImportResult
  = | { ok: true, settings: ThemeSettings, exportedAt: number | null, themeVersion: string | null }
    | { ok: false, error: string }

/**
 * 导入前的字段与版本校验。字段校验直接复用 `validateThemeSettings`（深度/大小/
 * 原型污染防护本来就已经写好，没有理由为导入再写一遍）；版本校验只挡"schema
 * 不认识"的情况——目前只有 1 一个版本，这里主要是为将来格式变化占位。
 */
export function parseThemeSettingsImport(raw: unknown): ThemeSettingsImportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: '文件内容不是合法的配置导出格式。' }

  const record = raw as Record<string, unknown>
  const looksWrapped = typeof record.schemaVersion === 'number' && record.settings && typeof record.settings === 'object'
  const schemaVersion = looksWrapped ? record.schemaVersion as number : null
  const settingsSource = looksWrapped ? record.settings : raw

  if (schemaVersion !== null && schemaVersion > THEME_SETTINGS_EXPORT_SCHEMA_VERSION)
    return { ok: false, error: `导出文件的 schema 版本（v${schemaVersion}）比当前 Transit 支持的（v${THEME_SETTINGS_EXPORT_SCHEMA_VERSION}）更新，请先升级主题。` }

  try {
    const settings = validateThemeSettings(settingsSource)
    return {
      ok: true,
      settings,
      exportedAt: typeof record.exportedAt === 'number' ? record.exportedAt : null,
      themeVersion: typeof record.themeVersion === 'string' ? record.themeVersion : null,
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '配置文件校验失败。' }
  }
}
