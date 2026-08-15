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
    manager.run('same-key', async () => {
      taskRuns++
      await wait(30)
      return 'replacement'
    })

    await wait(0)
    const deduplicated = manager.run('same-key', async () => {
      taskRuns++
      return 'duplicate'
    })

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

  test('removes the per-attempt abort listener after a successful task', async () => {
    const manager = new RequestManager()
    let abortListenerBalance = 0

    await expect(manager.run('listener-cleanup', async (signal) => {
      const addEventListener = signal.addEventListener.bind(signal)
      const removeEventListener = signal.removeEventListener.bind(signal)
      signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === 'abort')
          abortListenerBalance++
        addEventListener(type, listener, options)
      }) as typeof signal.addEventListener
      signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        if (type === 'abort')
          abortListenerBalance--
        removeEventListener(type, listener, options)
      }) as typeof signal.removeEventListener
      return 'ok'
    })).resolves.toBe('ok')

    expect(abortListenerBalance).toBe(0)
  })

  test('cancels one deduplicated consumer without affecting another', async () => {
    const manager = new RequestManager()
    let resolveTask!: (value: string) => void
    let aborts = 0
    const firstController = new AbortController()
    const first = manager.run('shared', signal => new Promise<string>((resolve) => {
      resolveTask = resolve
      signal.addEventListener('abort', () => aborts++, { once: true })
    }), { signal: firstController.signal })
    const second = manager.run('shared', async () => 'unused')

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    resolveTask('shared-result')

    await expect(second).resolves.toBe('shared-result')
    expect(aborts).toBe(0)
  })

  test('cancels the source request after its final consumer releases it', async () => {
    const manager = new RequestManager()
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = manager.run('shared-final', signal => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('shared request aborted')), { once: true })
    }), { signal: firstController.signal })
    const second = manager.run('shared-final', async () => 'unused', { signal: secondController.signal })

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    secondController.abort()

    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await wait(0)
    await expect(manager.run('shared-final', async () => 'fresh')).resolves.toBe('fresh')
  })

  test('releases settled consumers before a later request with the same key', async () => {
    const manager = new RequestManager()
    let taskRuns = 0
    const first = manager.run('settled-consumers', async () => ++taskRuns)
    const second = manager.run('settled-consumers', async () => ++taskRuns)

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1])
    await expect(manager.run('settled-consumers', async () => ++taskRuns)).resolves.toBe(2)
  })
})
