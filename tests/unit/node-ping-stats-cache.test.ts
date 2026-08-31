import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readStatsCache, writeStatsCache } from '../../src/services/nodePingStatsCache'
import { createEmptyNodePingStats } from '../../src/utils/pingStats'

const originalLocalStorage = globalThis.localStorage
const values = new Map<string, string>()
const storage = {
  get length() {
    return values.size
  },
  clear() {
    values.clear()
  },
  getItem(key: string) {
    return values.get(key) ?? null
  },
  key(index: number) {
    return [...values.keys()][index] ?? null
  },
  removeItem(key: string) {
    values.delete(key)
  },
  setItem(key: string, value: string) {
    values.set(key, value)
  },
} as Storage

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })

beforeEach(() => {
  storage.clear()
})

afterAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

function populatedStats() {
  return {
    ...createEmptyNodePingStats(),
    hasData: true,
    hasLatencyData: true,
    sampleCount: 1,
    latencySampleCount: 1,
    avgLatency: 42,
    history: [{ time: '2026-08-20T00:00:00.000Z', latency: 42, loss: 0 }],
  }
}

describe('node Ping stats cache freshness', () => {
  test('Guangzhou and Guangdong normalized-exact aliases share the same cache', async () => {
    writeStatsCache('alias-node', 1, 240, populatedStats(), Date.now(), '广州-电信', 'normalized-exact')
    await Promise.resolve()
    expect(readStatsCache('alias-node', 1, 240, '广东电信', 'normalized-exact')?.stats.avgLatency).toBe(42)
    expect(readStatsCache('alias-node', 1, 240, '广东电信', 'exact')).toBeNull()
  })
  test('a quota failure in the deferred index write is contained and later writes recover', () => {
    const originalQueue = globalThis.queueMicrotask
    const setItem = storage.setItem
    let flush!: () => void
    try {
      globalThis.queueMicrotask = (callback) => {
        flush = callback
      }
      writeStatsCache('quota-node', 1, 240, populatedStats(), Date.now())
      storage.setItem = () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      }
      expect(() => flush()).not.toThrow()
      storage.setItem = setItem
      writeStatsCache('recovered-node', 1, 240, populatedStats(), Date.now())
      expect(() => flush()).not.toThrow()
      expect(readStatsCache('recovered-node', 1, 240)?.stats.avgLatency).toBe(42)
    }
    finally {
      globalThis.queueMicrotask = originalQueue
      storage.setItem = setItem
    }
  })
  test('preserves the real sample time when the same data is written again', async () => {
    const sampleUpdatedAt = Date.now() - 12 * 60_000
    const stats = populatedStats()
    writeStatsCache('node-a', 24, 240, stats, sampleUpdatedAt)
    writeStatsCache('node-a', 24, 240, stats, sampleUpdatedAt)
    await Promise.resolve()

    const cached = readStatsCache('node-a', 24, 240)
    expect(cached?.sampleUpdatedAt).toBe(sampleUpdatedAt)
    expect(cached?.stats.avgLatency).toBe(42)
  })

  test('rejects cached data once its sample is thirty minutes old', async () => {
    const sampleUpdatedAt = Date.now() - 31 * 60_000
    writeStatsCache('node-a', 24, 240, populatedStats(), sampleUpdatedAt)
    await Promise.resolve()

    expect(readStatsCache('node-a', 24, 240)).toBeNull()
  })
})
