import { afterEach, describe, expect, test } from 'bun:test'
import { getAuthSession, setAuthSessionFromLogin, verifyLogin } from '../../src/services/auth.service'

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
})
