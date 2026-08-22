import { afterEach, describe, expect, mock, test } from 'bun:test'
import { KomariApi } from '../../src/utils/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

describe('KomariApi request lifetime', () => {
  test('keeps the timeout active while the response body is being read', async () => {
    let bodyCancelled = false
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            bodyCancelled = true
            controller.error(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const api = new KomariApi({ baseUrl: 'http://example.test/api', timeout: 5 })

    await expect(api.getMe()).rejects.toThrow('Network error')
    expect(bodyCancelled).toBe(true)
  })
})
