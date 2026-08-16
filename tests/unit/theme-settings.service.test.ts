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
    let persisted: Record<string, unknown> = { preserved: 'server-value' }
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: persisted } })
      if (url.includes('/api/admin/theme/settings?theme=Transit')) {
        persisted = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    const settings = { topologyEnabled: true }
    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      patch: settings,
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:current',
    })).resolves.toMatchObject(settings)
    expect(calls).toContainEqual({
      method: 'POST',
      url: '/api/admin/theme/settings?theme=Transit',
    })
    expect(calls.some(call => call.url.includes('/theme/config'))).toBe(false)
  })

  test('falls back to the legacy config endpoint only when the new route is unavailable', async () => {
    const calls: Array<{ method?: string, url: string }> = []
    let persisted: Record<string, unknown> = {}
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method })
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: persisted } })
      if (url.includes('/api/admin/theme/settings'))
        return jsonResponse({ message: 'not found' }, 404)
      if (url.includes('/api/admin/theme/config?short=Transit')) {
        persisted = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await saveManagedThemeSettings({
      theme: 'Transit',
      patch: { pandaOpsNodeControls: '{}' },
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:legacy',
    })

    expect(calls).toContainEqual({
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
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: {} } })
      return jsonResponse({ message: 'theme payload rejected' }, 400)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      patch: {},
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
      patch: { topologyEnabled: true },
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:expired',
    })).rejects.toThrow('登录状态已过期')
    expect(calls).toEqual(['/api/me'])
  })

  test('merges a patch with the latest server settings instead of a stale page snapshot', async () => {
    let postedBody: Record<string, unknown> | undefined
    let persisted: Record<string, unknown> = { changedInOtherTab: 2, topologyEnabled: false }
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: persisted } })
      if (url.includes('/api/admin/theme/settings')) {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        persisted = postedBody
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      patch: { topologyEnabled: true },
      permission: 'nodeTopology',
      requestKey: 'test:theme-settings:merge-latest',
    })).resolves.toEqual({ changedInOtherTab: 2, topologyEnabled: true })
    expect(postedBody).toEqual({ changedInOtherTab: 2, topologyEnabled: true })
  })

  test('serializes concurrent saves so the second patch reads the first result', async () => {
    let settings: Record<string, unknown> = { preserved: true }
    const postedBodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: settings } })
      if (url.includes('/api/admin/theme/settings')) {
        settings = JSON.parse(String(init?.body)) as Record<string, unknown>
        postedBodies.push(settings)
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await Promise.all([
      saveManagedThemeSettings({
        theme: 'Transit',
        patch: { topologyEnabled: true },
        permission: 'nodeTopology',
        requestKey: 'save:topology',
      }),
      saveManagedThemeSettings({
        theme: 'Transit',
        patch: { pandaOpsNodeControls: '{}' },
        permission: 'nodeTopology',
        requestKey: 'save:panda',
      }),
    ])

    expect(postedBodies).toEqual([
      { preserved: true, topologyEnabled: true },
      { preserved: true, topologyEnabled: true, pandaOpsNodeControls: '{}' },
    ])
  })

  test('continues the same-theme queue after an earlier save fails', async () => {
    let settings: Record<string, unknown> = { preserved: true }
    let saveAttempt = 0
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public'))
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: settings } })
      if (url.includes('/api/admin/theme/settings')) {
        saveAttempt++
        if (saveAttempt === 1)
          return jsonResponse({ message: 'first save rejected' }, 400)
        settings = JSON.parse(String(init?.body)) as Record<string, unknown>
        return jsonResponse({ status: 'success', data: null })
      }
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    const failed = saveManagedThemeSettings({
      theme: 'Transit',
      patch: { topologyEnabled: true },
      permission: 'nodeTopology',
      requestKey: 'save:failure',
    })
    const recovered = saveManagedThemeSettings({
      theme: 'Transit',
      patch: { pandaOpsNodeControls: '{}' },
      permission: 'nodeTopology',
      requestKey: 'save:after-failure',
    })

    await expect(failed).rejects.toThrow('first save rejected')
    await expect(recovered).resolves.toEqual({ preserved: true, pandaOpsNodeControls: '{}' })
    expect(saveAttempt).toBe(2)
  })

  test('uses a named Web Lock when the browser supports cross-tab serialization', async () => {
    const originalNavigator = globalThis.navigator
    const lockNames: string[] = []
    let persisted: Record<string, unknown> = {}
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
            lockNames.push(name)
            return callback()
          },
        },
      },
    })
    try {
      globalThis.fetch = (async (input, init) => {
        const url = String(input)
        if (url.endsWith('/api/me'))
          return jsonResponse({ logged_in: true, username: 'admin' })
        if (url.endsWith('/api/public'))
          return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: persisted } })
        if (url.includes('/api/admin/theme/settings')) {
          persisted = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse({ status: 'success', data: null })
        }
        return jsonResponse({ message: 'unexpected endpoint' }, 500)
      }) as typeof fetch
      setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

      await saveManagedThemeSettings({
        theme: 'Transit',
        patch: { topologyEnabled: true },
        permission: 'nodeTopology',
        requestKey: 'save:web-lock',
      })
      expect(lockNames).toEqual(['transit:theme-settings:Transit'])
    }
    finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
    }
  })

  test('rejects a nominally successful write when the server does not persist the patch', async () => {
    let publicReadCount = 0
    globalThis.fetch = (async (input) => {
      const url = String(input)
      if (url.endsWith('/api/me'))
        return jsonResponse({ logged_in: true, username: 'admin' })
      if (url.endsWith('/api/public')) {
        publicReadCount++
        return jsonResponse({ status: 'success', message: '', data: { theme: 'Transit', theme_settings: { topologyEnabled: false } } })
      }
      if (url.includes('/api/admin/theme/settings'))
        return jsonResponse({ status: 'success', data: null })
      return jsonResponse({ message: 'unexpected endpoint' }, 500)
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    await expect(saveManagedThemeSettings({
      theme: 'Transit',
      patch: { topologyEnabled: true },
      permission: 'nodeTopology',
      requestKey: 'save:not-persisted',
    })).rejects.toThrow('服务器未保留')
    expect(publicReadCount).toBe(2)
  })
})
