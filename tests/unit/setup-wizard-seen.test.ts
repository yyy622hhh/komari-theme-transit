import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hasSeenSetupWizard } from '../../src/composables/useSetupWizard'

const originalLocalStorage = globalThis.localStorage

function installLocalStorage(): Map<string, string> {
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
  return store
}

beforeEach(() => {
  installLocalStorage()
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

describe('hasSeenSetupWizard', () => {
  test('is false for a first-time visitor with no stored flag', () => {
    expect(hasSeenSetupWizard()).toBe(false)
  })

  test('is true once the flag has been written', () => {
    localStorage.setItem('transit:setup-wizard-dismissed', '1')
    expect(hasSeenSetupWizard()).toBe(true)
  })

  test('defaults to true (do not auto-pop) when localStorage is unavailable', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
    expect(hasSeenSetupWizard()).toBe(true)
  })
})
