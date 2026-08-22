import { describe, expect, test } from 'bun:test'
import {
  buildThemeSettingsExport,
  diffThemeSettings,
  parseThemeSettingsImport,
  THEME_SETTINGS_EXPORT_SCHEMA_VERSION,
  themeSettingsEqual,
} from '../../src/utils/themeSettingsBackup'

describe('diffThemeSettings', () => {
  test('detects added, changed and removed keys', () => {
    const diff = diffThemeSettings(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 20, d: 4 },
    )
    expect(diff).toEqual([
      { key: 'b', kind: 'changed', before: 2, after: 20 },
      { key: 'c', kind: 'removed', before: 3 },
      { key: 'd', kind: 'added', after: 4 },
    ])
  })

  test('returns an empty array for identical settings regardless of key order', () => {
    expect(diffThemeSettings({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([])
  })

  test('treats deeply equal nested objects as unchanged even with different key order', () => {
    expect(diffThemeSettings(
      { glassCustomColors: { light: '#fff', dark: '#000' } },
      { glassCustomColors: { dark: '#000', light: '#fff' } },
    )).toEqual([])
  })
})

describe('themeSettingsEqual', () => {
  test('is key-order independent', () => {
    expect(themeSettingsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  test('detects a real difference', () => {
    expect(themeSettingsEqual({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('buildThemeSettingsExport / parseThemeSettingsImport round trip', () => {
  test('a freshly built export parses back to the same settings', () => {
    const settings = { alertEnabled: true, dataUpdateInterval: 5 }
    const file = buildThemeSettingsExport(settings, '1.3.0')
    expect(file.schemaVersion).toBe(THEME_SETTINGS_EXPORT_SCHEMA_VERSION)

    const result = parseThemeSettingsImport(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.settings).toEqual(settings)
      expect(result.themeVersion).toBe('1.3.0')
    }
  })

  test('rejects a file whose schema version is newer than this build supports', () => {
    const result = parseThemeSettingsImport({ schemaVersion: 999, settings: {} })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error).toContain('schema')
  })

  test('rejects non-object input', () => {
    expect(parseThemeSettingsImport('not an object').ok).toBe(false)
    expect(parseThemeSettingsImport(null).ok).toBe(false)
    expect(parseThemeSettingsImport([1, 2, 3]).ok).toBe(false)
  })

  test('accepts a bare settings object with no export wrapper', () => {
    const result = parseThemeSettingsImport({ alertEnabled: true })
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.settings).toEqual({ alertEnabled: true })
  })

  test('rejects a wrapper-shaped file whose schemaVersion is not a number instead of importing the wrapper keys', () => {
    const result = parseThemeSettingsImport({
      schemaVersion: '1',
      settings: { alertEnabled: true },
    })
    expect(result.ok).toBe(false)
  })

  test('rejects a numbered schema wrapper that has no settings object', () => {
    const result = parseThemeSettingsImport({ schemaVersion: 1, exportedAt: 1 })
    expect(result.ok).toBe(false)
  })
})
