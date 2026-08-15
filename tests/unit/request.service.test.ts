import { describe, expect, test } from 'bun:test'
import { RequestManager } from '../../src/services/request.service'

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

describe('RequestManager', () => {
  test('keeps a replacement request registered after an aborted request settles', async () => {
    const manager = new RequestManager()
    let taskRuns = 0

    const aborted = manager.run('same-key', signal => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })).catch(() => undefined)

    manager.abort('same-key')
    const replacement = manager.run('same-key', async () => {
      taskRuns++
      await wait(30)
      return 'replacement'
    })

    await wait(0)
    const deduplicated = manager.run('same-key', async () => {
      taskRuns++
      return 'duplicate'
    })

    expect(deduplicated).toBe(replacement)
    expect(await deduplicated).toBe('replacement')
    await aborted
    expect(taskRuns).toBe(1)
  })

  test('aborts while waiting for retry backoff', async () => {
    const manager = new RequestManager()
    let taskRuns = 0
    const request = manager.run('retry-backoff', async () => {
      taskRuns++
      throw new Error('temporary failure')
    }, {
      retryAttempts: 2,
      retryBaseDelay: 10_000,
      retryMaxDelay: 10_000,
      retryJitterRatio: 0,
    })

    await wait(0)
    manager.abort('retry-backoff')

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await request.catch(() => undefined)
    expect(taskRuns).toBe(1)
  })

  test('times out a stalled task without leaking it into later deduplication', async () => {
    const manager = new RequestManager()
    let timeoutSignalObserved = false
    const timedOut = manager.run('timeout', signal => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        timeoutSignalObserved = true
        reject(new Error('timed out'))
      }, { once: true })
    }), { retryAttempts: 0, timeout: 5 })

    await expect(timedOut).rejects.toThrow('timed out')
    expect(timeoutSignalObserved).toBe(true)
    await expect(manager.run('timeout', async () => 'fresh')).resolves.toBe('fresh')
  })

  test('does not retry failures rejected by the retry policy', async () => {
    const manager = new RequestManager()
    let taskRuns = 0

    await expect(manager.run('permission-denied', async () => {
      taskRuns += 1
      throw new Error('permission denied')
    }, {
      retryAttempts: 3,
      shouldRetry: () => false,
    })).rejects.toThrow('permission denied')
    expect(taskRuns).toBe(1)
  })
})
