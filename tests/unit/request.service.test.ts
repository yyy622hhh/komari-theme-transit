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
})
