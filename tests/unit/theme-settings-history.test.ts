import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { clearThemeSettingsHistory, readThemeSettingsHistory, recordThemeSettingsVersion } from '../../src/utils/themeSettingsHistory'

const originalLocalStorage = globalThis.localStorage

function installLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
}

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

describe('theme settings history', () => {
  test('records newest first', () => {
    recordThemeSettingsVersion({ a: 1 }, 'initial')
    recordThemeSettingsVersion({ a: 2 }, 'external-change')

    const history = readThemeSettingsHistory()
    expect(history.map(entry => entry.settings)).toEqual([{ a: 2 }, { a: 1 }])
    expect(history[0]!.source).toBe('external-change')
  })

  test('skips recording when the settings are identical to the most recent entry, regardless of key order', () => {
    recordThemeSettingsVersion({ a: 1, b: 2 }, 'initial')
    recordThemeSettingsVersion({ b: 2, a: 1 }, 'external-change')

    expect(readThemeSettingsHistory()).toHaveLength(1)
  })

  test('upgrades a generic source label when the same snapshot is recorded as import/rollback', () => {
    recordThemeSettingsVersion({ a: 1 }, 'external-change')
    recordThemeSettingsVersion({ a: 1 }, 'import')

    const history = readThemeSettingsHistory()
    expect(history).toHaveLength(1)
    expect(history[0]!.source).toBe('import')
  })

  test('does not downgrade a specific source back to external-change', () => {
    recordThemeSettingsVersion({ a: 1 }, 'rollback')
    recordThemeSettingsVersion({ a: 1 }, 'external-change')

    expect(readThemeSettingsHistory()[0]!.source).toBe('rollback')
  })

  test('caps history at 20 entries', () => {
    for (let index = 0; index < 25; index++)
      recordThemeSettingsVersion({ index }, 'external-change')

    const history = readThemeSettingsHistory()
    expect(history).toHaveLength(20)
    expect(history[0]!.settings).toEqual({ index: 24 })
  })

  test('clears completely', () => {
    recordThemeSettingsVersion({ a: 1 }, 'initial')
    clearThemeSettingsHistory()
    expect(readThemeSettingsHistory()).toEqual([])
  })

  test('drops corrupt entries instead of throwing', () => {
    localStorage.setItem('transit:theme-settings-history', '[{"at":1,"settings":{"a":1},"source":"initial"},null,{"settings":{}},42]')
    expect(readThemeSettingsHistory()).toEqual([{ at: 1, settings: { a: 1 }, source: 'initial' }])
  })

  test('is a no-op without localStorage rather than crashing', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
    expect(recordThemeSettingsVersion({ a: 1 }, 'initial')).toBe(false)
    expect(readThemeSettingsHistory()).toEqual([])
  })

  test('drops oldest snapshots when a write exceeds quota', () => {
    recordThemeSettingsVersion({ keep: 1 }, 'initial')
    recordThemeSettingsVersion({ keep: 2 }, 'external-change')
    const store = new Map<string, string>()
    const existing = localStorage.getItem('transit:theme-settings-history')
    if (existing)
      store.set('transit:theme-settings-history', existing)

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          const parsed = JSON.parse(value) as unknown
          if (Array.isArray(parsed) && parsed.length > 2)
            throw new Error('quota')
          store.set(key, value)
        },
        removeItem: (key: string) => store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() {
          return store.size
        },
      },
    })

    expect(recordThemeSettingsVersion({ keep: 3 }, 'external-change')).toBe(true)
    expect(readThemeSettingsHistory().map(entry => entry.settings)).toEqual([{ keep: 3 }, { keep: 2 }])
  })
})
