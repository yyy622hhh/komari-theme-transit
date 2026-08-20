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
    avgLatency: 42,
    history: [{ time: '2026-08-20T00:00:00.000Z', latency: 42, loss: 0 }],
  }
}

describe('node Ping stats cache freshness', () => {
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
