import { describe, expect, test } from 'bun:test'
import { PromiseCache, SharedCache } from '../../src/services/cache.service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('PromiseCache', () => {
  test('an old promise cannot delete a replacement created after clear', async () => {
    const cache = new PromiseCache<string>({ maxSize: 4, ttl: 60_000 })
    const first = deferred<string>()
    const replacement = deferred<string>()

    cache.getOrCreate('same-key', () => first.promise)
    cache.clear()
    const replacementPromise = cache.getOrCreate('same-key', () => replacement.promise)

    first.resolve('old')
    await first.promise

    let duplicateFactoryCalls = 0
    const deduplicated = cache.getOrCreate('same-key', async () => {
      duplicateFactoryCalls++
      return 'duplicate'
    })

    expect(deduplicated).toBe(replacementPromise)
    expect(duplicateFactoryCalls).toBe(0)
    replacement.resolve('new')
    expect(await deduplicated).toBe('new')
  })
})

describe('SharedCache', () => {
  test('runs periodic cleanup only while the cache contains entries', () => {
    const originalWindow = globalThis.window
    let nextTimer = 0
    const activeTimers = new Set<number>()
    globalThis.window = {
      setInterval: () => {
        const timer = ++nextTimer
        activeTimers.add(timer)
        return timer
      },
      clearInterval: (timer: number) => activeTimers.delete(timer),
    } as unknown as Window & typeof globalThis

    try {
      const cache = new SharedCache<string>({ maxSize: 2, ttl: 60_000, cleanupInterval: 1_000 })
      expect(activeTimers.size).toBe(0)

      cache.set('entry', 'value')
      expect(activeTimers.size).toBe(1)

      cache.clear()
      expect(activeTimers.size).toBe(0)

      cache.set('replacement', 'value')
      expect(activeTimers.size).toBe(1)
      cache.dispose()
      expect(activeTimers.size).toBe(0)
    }
    finally {
      globalThis.window = originalWindow
    }
  })

  test('bounds idle entries while preserving retained values', () => {
    const cache = new SharedCache<string>({ maxSize: 2, ttl: 60_000 })
    cache.set('retained', 'a')
    const release = cache.retain('retained')
    cache.set('idle-1', 'b')
    cache.set('idle-2', 'c')

    expect(cache.get('retained')).toBe('a')
    expect(cache.size).toBe(2)
    release()
    cache.set('idle-3', 'd')
    expect(cache.size).toBe(2)
  })

  test('evicts expired idle entries and invokes the eviction hook once', () => {
    const originalNow = Date.now
    let now = 1_000
    Date.now = () => now
    const evicted: string[] = []
    try {
      const cache = new SharedCache<string>({
        maxSize: 4,
        ttl: 50,
        onEvict: (_value, key) => evicted.push(key),
      })
      cache.set('expired', 'value')
      now += 51

      expect(cache.get('expired')).toBeUndefined()
      expect(cache.size).toBe(0)
      expect(evicted).toEqual(['expired'])
    }
    finally {
      Date.now = originalNow
    }
  })
})
