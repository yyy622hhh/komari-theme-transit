import { describe, expect, test } from 'bun:test'
import { createRetryableAsyncLoader } from '../../src/utils/retryableAsyncLoader'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('createRetryableAsyncLoader', () => {
  test('does not permanently cache a transient load failure', async () => {
    let attempts = 0
    const load = createRetryableAsyncLoader(() => {
      attempts += 1
      if (attempts === 1)
        throw new Error('stale deployment chunk')
      return Promise.resolve({ ready: true })
    })

    await expect(load()).rejects.toThrow('stale deployment chunk')
    await expect(load()).resolves.toEqual({ ready: true })
    await expect(load()).resolves.toEqual({ ready: true })
    expect(attempts).toBe(2)
  })

  test('deduplicates concurrent attempts and caches the successful value', async () => {
    const source = deferred<{ ready: boolean }>()
    let attempts = 0
    const load = createRetryableAsyncLoader(() => {
      attempts += 1
      return source.promise
    })

    const first = load()
    const second = load()
    expect(second).toBe(first)
    await Promise.resolve()
    expect(attempts).toBe(1)

    source.resolve({ ready: true })
    const value = await first
    expect(await load()).toBe(value)
    expect(attempts).toBe(1)
  })
})
