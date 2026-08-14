import { describe, expect, test } from 'bun:test'
import { PromiseCache } from '../../src/services/cache.service'

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
