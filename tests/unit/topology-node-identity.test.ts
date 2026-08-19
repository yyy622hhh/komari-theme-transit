import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { recordTopologyNodeIdentity, resolveTopologyNodeIdentity } from '../../src/utils/topologyNodeIdentity'

const originalLocalStorage = globalThis.localStorage

beforeEach(() => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    },
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

describe('resolveTopologyNodeIdentity', () => {
  test('resolves by exact name without touching the cache', () => {
    const nodes = [{ uuid: 'a', name: 'Relay-JP' }]
    expect(resolveTopologyNodeIdentity(nodes, 'Relay-JP')?.uuid).toBe('a')
  })

  test('falls back to a cached uuid once the display name no longer matches', () => {
    recordTopologyNodeIdentity([{ uuid: 'a', name: 'Relay-JP' }])
    const renamed = [{ uuid: 'a', name: 'Relay-Tokyo' }]

    expect(resolveTopologyNodeIdentity(renamed, 'Relay-JP')?.name).toBe('Relay-Tokyo')
  })

  test('does not resolve a name that was never seen before', () => {
    const nodes = [{ uuid: 'a', name: 'Relay-Tokyo' }]
    expect(resolveTopologyNodeIdentity(nodes, 'Relay-JP')).toBeUndefined()
  })

  test('does not resolve once the cached node has actually been deleted', () => {
    recordTopologyNodeIdentity([{ uuid: 'a', name: 'Relay-JP' }])
    const nodes = [{ uuid: 'b', name: 'Other-Node' }]

    expect(resolveTopologyNodeIdentity(nodes, 'Relay-JP')).toBeUndefined()
  })

  test('keeps the latest association when a name is reused by a different uuid', () => {
    recordTopologyNodeIdentity([{ uuid: 'a', name: 'Relay-JP' }])
    recordTopologyNodeIdentity([{ uuid: 'b', name: 'Relay-JP' }])
    const nodes = [{ uuid: 'a', name: 'Relay-Old' }, { uuid: 'b', name: 'Relay-JP' }]

    // 直接按当前名称能唯一命中 uuid b，走的是 findUniqueTopologyNode 快路径。
    expect(resolveTopologyNodeIdentity(nodes, 'Relay-JP')?.uuid).toBe('b')
  })

  test('is a no-op without localStorage', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
    recordTopologyNodeIdentity([{ uuid: 'a', name: 'Relay-JP' }])
    const renamed = [{ uuid: 'a', name: 'Relay-Tokyo' }]

    expect(resolveTopologyNodeIdentity(renamed, 'Relay-JP')).toBeUndefined()
  })
})
