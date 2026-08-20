import { afterEach, describe, expect, test } from 'bun:test'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { saveTopologyConfiguration } from '../../src/services/topology.service'
import { persistTopologyCreatedTaskIds, resetTopologyCreatedTaskIdsCache } from '../../src/utils/topologyCreatedTasks'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setAuthSessionFromLogin(false)
  resetTopologyCreatedTaskIdsCache()
})

describe('topology service', () => {
  test('persists clearing all routes as empty topology settings without hiding the manager entry', async () => {
    let persisted: Record<string, unknown> = {
      topologyEnabled: true,
      topologyRoute: '入口|CN|入口;线路|JP|线路机',
      topologyMetrics: '10,0',
    }
    let postedBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: persisted } })
      if (url.includes('/api/admin/theme/settings?theme=Transit')) {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        persisted = postedBody
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
    persistTopologyCreatedTaskIds(new Set([12]))

    await expect(saveTopologyConfiguration({
      theme: 'Transit',
      routes: [],
      expected: { topologyRoute: '入口|CN|入口;线路|JP|线路机', topologyMetrics: '10,0' },
    })).resolves.toEqual({
      topologyEnabled: true,
      topologyRoute: '',
      topologyMetrics: '',
      topologyOwnedPingTaskIds: '[12]',
    })

    expect(postedBody).toEqual({
      topologyEnabled: true,
      topologyRoute: '',
      topologyMetrics: '',
      topologyOwnedPingTaskIds: '[12]',
    })
  })
})
