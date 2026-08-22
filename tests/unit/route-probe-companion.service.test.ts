import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  enqueueCompanionRouteProbe,
  getCompanionRouteProbeBatch,
  RouteProbeCompanionError,
  RouteProbeCompanionUnavailableError,
} from '../../src/services/route-probe-companion.service'

const originalFetch = globalThis.fetch

afterEach(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

describe('route probe companion fallback boundary', () => {
  test('allows fallback only when the initial enqueue endpoint is unavailable', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 404 })) as typeof fetch

    await expect(enqueueCompanionRouteProbe(['node-1'], 'beijing'))
      .rejects
      .toBeInstanceOf(RouteProbeCompanionUnavailableError)
  })

  test('does not classify a missing accepted batch as an unavailable plugin', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 404 })) as typeof fetch

    const request = getCompanionRouteProbeBatch('accepted-batch')
    await expect(request).rejects.toBeInstanceOf(RouteProbeCompanionError)
    await expect(request).rejects.not.toBeInstanceOf(RouteProbeCompanionUnavailableError)
    await expect(request).rejects.toMatchObject({ status: 404 })
  })
})
