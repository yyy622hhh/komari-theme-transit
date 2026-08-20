import { afterEach, describe, expect, test } from 'bun:test'
import { adoptTopologyCreatedTaskIds, getTopologyCreatedTaskIds, parseTopologyOwnedPingTaskIds, persistTopologyCreatedTaskIds, rememberTopologyCreatedTaskId, resetTopologyCreatedTaskIdsCache, serializeTopologyOwnedPingTaskIds } from '../../src/utils/topologyCreatedTasks'

const memory = new Map<string, string>()
const originalSessionStorage = globalThis.sessionStorage

afterEach(() => {
  memory.clear()
  resetTopologyCreatedTaskIdsCache()
  if (originalSessionStorage)
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: originalSessionStorage })
  else
    Reflect.deleteProperty(globalThis, 'sessionStorage')
})

function installMemorySessionStorage(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
      removeItem: (key: string) => { memory.delete(key) },
    },
  })
}

describe('topology created task persistence', () => {
  test('round-trips integer task IDs through sessionStorage', () => {
    installMemorySessionStorage()
    persistTopologyCreatedTaskIds(new Set([7, 8]))
    expect([...getTopologyCreatedTaskIds()].sort((left, right) => left - right)).toEqual([7, 8])
    getTopologyCreatedTaskIds().add(9)
    persistTopologyCreatedTaskIds()
    expect(getTopologyCreatedTaskIds().has(9)).toBe(true)
  })

  test('parses owned task ids from theme settings and adopts them into the session set', () => {
    installMemorySessionStorage()
    expect(parseTopologyOwnedPingTaskIds('[7, 0, 8, 7]')).toEqual([7, 8])
    expect(serializeTopologyOwnedPingTaskIds(new Set([8, 7]))).toBe('[8,7]')
    adoptTopologyCreatedTaskIds(parseTopologyOwnedPingTaskIds('[7, 8]'))
    rememberTopologyCreatedTaskId(9)
    expect([...getTopologyCreatedTaskIds()].sort((left, right) => left - right)).toEqual([7, 8, 9])
  })

  test('ignores malformed storage instead of throwing', () => {
    installMemorySessionStorage()
    memory.set('transit:topology-created-task-ids', '{not-json')
    resetTopologyCreatedTaskIdsCache()
    expect(getTopologyCreatedTaskIds()).toEqual(new Set())
  })
})
