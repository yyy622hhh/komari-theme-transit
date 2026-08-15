import { afterEach, describe, expect, test } from 'bun:test'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { saveManagedThemeSettings } from '../../src/services/theme-settings.service'

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
})

describe('managed theme settings compatibility', () => {
  test('uses the Komari 1.4 settings endpoint', async () => {
    const calls: Array<{ method?: string, url: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.includes('/api/admin/theme/settings?theme=Transit'))
        return jsonResponse({ status: 'success', data: null })
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    const settings = { topologyEnabled: true }
    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      settings,
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:current',
    })).resolves.toBe(settings)

    expect(calls).toContainEqual({
      method: 'POST',
      url: '/api/admin/theme/settings?theme=Transit',
    })
    expect(calls.some(call => call.url.includes('/theme/config'))).toBe(false)
  })

  test('falls back to the legacy config endpoint only when the new route is unavailable', async () => {
    const calls: Array<{ method?: string, url: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.includes('/api/admin/theme/settings'))
        return jsonResponse({ message: 'not found' }, 404)
      if (url.includes('/api/admin/theme/config?short=Transit'))
        return jsonResponse({ status: 'success', data: null })
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await saveManagedThemeSettings({
      theme: 'Transit',
      settings: { pandaOpsNodeControls: '{}' },
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:legacy',
    })

    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      url: '/api/admin/theme/config?short=Transit',
    })
  })

  test('does not fall back after a permission or validation failure', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      return jsonResponse({ message: 'theme payload rejected' }, 400)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      settings: {},
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:rejected',
    })).rejects.toThrow('theme payload rejected')
    expect(calls.some(url => url.includes('/theme/config'))).toBe(false)
  })

  test('does not call a private theme endpoint after login expires', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: false })
      return jsonResponse({ message: 'private endpoint should not be called' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      settings: { topologyEnabled: true },
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:expired',
    })).rejects.toThrow('登录状态已过期')
    expect(calls).toEqual(['/api/me'])
  })
})
