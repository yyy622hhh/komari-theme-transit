import { describe, expect, test } from 'bun:test'
import { getSafeErrorSummary, redactSensitiveText } from '../../src/utils/safeError'

describe('safe error summaries', () => {
  test('redacts credentials, tokens and sensitive query values', () => {
    const message = 'Bearer abc.def token = "secret with spaces" https://user:pass@example.test/path?api_key=hidden {"token":"secret-token","password": "hunter2", "api_key": "json-hidden", "access_key": 12345, "session": null} Cookie: session_token=cookie-secret'
    const redacted = redactSensitiveText(message)
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('secret')
    expect(redacted).not.toContain('user:pass')
    expect(redacted).not.toContain('hidden')
    expect(redacted).not.toContain('secret-token')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).not.toContain('json-hidden')
    expect(redacted).not.toContain('12345')
    expect(redacted).not.toContain('cookie-secret')
    expect(redacted).not.toContain('secret with spaces')
    expect(redacted).toContain('[REDACTED]')
  })

  test('does not traverse arbitrary non-error objects', () => {
    let accessed = false
    const hostile = Object.defineProperty({}, 'message', {
      get() {
        accessed = true
        throw new Error('must not read')
      },
    })
    expect(getSafeErrorSummary(hostile)).toEqual({ name: 'Error', message: 'Non-error value received' })
    expect(accessed).toBe(false)
  })
})
