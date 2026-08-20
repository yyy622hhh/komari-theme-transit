import { afterEach, describe, expect, test } from 'bun:test'
import { getAuthSession, requirePermission, setAuthSessionFromLogin, subscribeAuthSession, verifyLogin } from '../../src/services/auth.service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const originalFetch = globalThis.fetch

function meResponse(loggedIn: boolean): Response {
  return new Response(JSON.stringify({ logged_in: loggedIn }), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setAuthSessionFromLogin(false)
})

describe('auth session verification', () => {
  test('an invalidated verification cannot overwrite a newer session', async () => {
    const staleResponse = deferred<Response>()
    const currentResponse = deferred<Response>()
    let fetchCalls = 0
    globalThis.fetch = (() => {
      fetchCalls += 1
      return fetchCalls === 1 ? staleResponse.promise : currentResponse.promise
    }) as typeof fetch

    setAuthSessionFromLogin(false)
    const staleVerification = verifyLogin({ force: true })

    setAuthSessionFromLogin(false)
    const currentVerification = verifyLogin({ force: true })

    currentResponse.resolve(meResponse(true))
    expect((await currentVerification).authenticated).toBe(true)

    staleResponse.resolve(meResponse(false))
    expect((await staleVerification).authenticated).toBe(true)
    expect(getAuthSession().authenticated).toBe(true)
    expect(fetchCalls).toBe(2)
  })

  test('denies private permissions when a forced verification reports an expired session', async () => {
    globalThis.fetch = (async () => meResponse(false)) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    const permission = await requirePermission('serverList', { force: true })

    expect(permission.granted).toBe(false)
    expect(permission.session.status).toBe('guest')
    expect(permission.session.authenticated).toBe(false)
    expect(permission.reason).toContain('serverList')
  })

  test('notifies store subscribers when forced verification expires a session', async () => {
    const statuses: string[] = []
    const unsubscribe = subscribeAuthSession(session => statuses.push(session.status))
    globalThis.fetch = (async () => meResponse(false)) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    try {
      await requirePermission('nodeTopology', { force: true })
      expect(statuses).toEqual(['authenticated', 'guest'])
    }
    finally {
      unsubscribe()
    }
  })

  test('treats verification failures as unauthenticated instead of preserving stale access', async () => {
    globalThis.fetch = (async () => {
      throw new Error('verification unavailable')
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })

    const permission = await requirePermission('snapshotExport', { force: true })

    expect(permission.granted).toBe(false)
    expect(permission.session.status).toBe('error')
    expect(permission.session.errorMessage).toContain('verification unavailable')
  })

  test('retries a transient verification failure instead of caching it for the auth TTL', async () => {
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts += 1
      if (attempts === 1)
        throw new Error('temporary network failure')
      return meResponse(true)
    }) as typeof fetch
    setAuthSessionFromLogin(false)

    await expect(verifyLogin({ force: true })).resolves.toMatchObject({ status: 'error', authenticated: false })
    await expect(verifyLogin()).resolves.toMatchObject({ status: 'authenticated', authenticated: true })
    expect(attempts).toBe(2)
  })

  test('a forced verification does not join an in-flight unforced /me', async () => {
    globalThis.fetch = (async () => {
      throw new Error('seed error')
    }) as typeof fetch
    setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
    await expect(verifyLogin({ force: true })).resolves.toMatchObject({ status: 'error' })

    const background = deferred<Response>()
    const forced = deferred<Response>()
    let calls = 0
    globalThis.fetch = (() => {
      calls += 1
      return calls === 1 ? background.promise : forced.promise
    }) as typeof fetch

    const backgroundVerification = verifyLogin()
    const forcedVerification = verifyLogin({ force: true })
    expect(calls).toBe(2)

    forced.resolve(meResponse(true))
    expect((await forcedVerification).authenticated).toBe(true)
    background.resolve(meResponse(false))
    expect((await backgroundVerification).authenticated).toBe(true)
    expect(getAuthSession().authenticated).toBe(true)
  })

  test('does not grant access when a malformed response uses a truthy non-boolean login value', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ logged_in: 'false', username: 'admin' }), {
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
    setAuthSessionFromLogin(false)

    const permission = await requirePermission('serverList', { force: true })

    expect(permission.granted).toBe(false)
    expect(permission.session.status).toBe('guest')
  })
})
