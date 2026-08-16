import { describe, expect, test } from 'bun:test'
import { normalizeThemeSettings, resolveThemeBackgroundSource, validateServerThemeSettings, validateThemeSettings } from '../../src/utils/themeSettings'

describe('theme settings boundary', () => {
  test('normalizes JSON strings and preserves forward-compatible values', () => {
    expect(normalizeThemeSettings('{"future":{"enabled":true},"count":3}')).toEqual({
      future: { enabled: true },
      count: 3,
    })
  })

  test('drops unsafe prototype keys from untrusted public settings', () => {
    const parsed = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}')
    const result = normalizeThemeSettings(parsed)
    expect(result.safe).toBe(true)
    expect(Object.hasOwn(result, '__proto__')).toBe(false)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test('rejects invalid mutation values before an admin request', () => {
    expect(() => validateThemeSettings({ backgroundBlur: Number.POSITIVE_INFINITY })).toThrow('无效数字')
    expect(() => validateThemeSettings({ nested: { value: () => true } })).toThrow('JSON 数据')
  })

  test('fails closed instead of silently dropping a complete server value', () => {
    expect(() => validateServerThemeSettings('{invalid')).toThrow('不是有效 JSON')
    let nested: Record<string, unknown> = { value: true }
    for (let index = 0; index < 70; index++)
      nested = { nested }
    expect(() => validateServerThemeSettings(nested)).toThrow('嵌套层级过深')
  })

  test('keeps large legacy and forward-compatible configuration values', () => {
    const topology = 'node-a|region|role;'.repeat(20_000)
    expect(validateServerThemeSettings({ topology, future: { values: Array.from({ length: 3_000 }, (_, index) => index) } }))
      .toMatchObject({ topology, future: { values: expect.any(Array) } })
  })

  test('allows http, https, root-relative and safe local backgrounds only', () => {
    expect(resolveThemeBackgroundSource('local:wall papers/a.png')).toBe('/themes/user-assets/wall%20papers/a.png')
    expect(resolveThemeBackgroundSource('/images/background.png')).toBe('/images/background.png')
    expect(resolveThemeBackgroundSource('https://cdn.example.test/wall.jpg')).toBe('https://cdn.example.test/wall.jpg')
    expect(resolveThemeBackgroundSource('javascript:alert(1)')).toBe('')
    expect(resolveThemeBackgroundSource('//example.test/wall.jpg')).toBe('')
    expect(resolveThemeBackgroundSource('/\\evil.example/wall.jpg')).toBe('')
    expect(resolveThemeBackgroundSource('/safe\nunsafe.jpg')).toBe('')
    expect(resolveThemeBackgroundSource('local:../secret')).toBe('')
  })
})
