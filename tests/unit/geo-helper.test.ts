import { describe, expect, test } from 'bun:test'
import { COORD_MAP, getCoordByCode, getCountryCodeFromRegion } from '../../src/utils/geoHelper'

describe('getCountryCodeFromRegion', () => {
  test('accepts an ISO code in any casing or padding', () => {
    expect(getCountryCodeFromRegion('CN')).toBe('CN')
    expect(getCountryCodeFromRegion('hk')).toBe('HK')
    expect(getCountryCodeFromRegion('  jp  ')).toBe('JP')
  })

  test('accepts a flag emoji, which is what Komari stores for many nodes', () => {
    expect(getCountryCodeFromRegion('🇨🇳')).toBe('CN')
    expect(getCountryCodeFromRegion('🇺🇸')).toBe('US')
  })

  test('returns null for anything unusable instead of guessing a country', () => {
    // 猜错国家会把节点画到地球上完全不相干的位置，宁可不画。
    for (const value of [undefined, null, '', '   ', '中国', 'CHN', 'ZZ', '1', '🚀'])
      expect(getCountryCodeFromRegion(value)).toBeNull()
  })

  test('an ISO-shaped code with no coordinates is rejected, not passed through', () => {
    // 两个字母能过正则，但地图上没有对应坐标就不能认——否则后面取坐标会拿到 null，
    // 调用方却以为拿到了有效地区。
    const unknownTwoLetter = ['AA', 'QQ', 'XX'].find(code => !(code in COORD_MAP))
    expect(unknownTwoLetter).toBeDefined()
    expect(getCountryCodeFromRegion(unknownTwoLetter!)).toBeNull()
  })
})

describe('getCoordByCode', () => {
  test('resolves a known code to its coordinates', () => {
    expect(getCoordByCode('CN')).toEqual([35.8617, 104.1954])
    expect(getCoordByCode('HK')).toEqual([22.3193, 114.1694])
  })

  test('returns null for empty or unknown codes', () => {
    expect(getCoordByCode(null)).toBeNull()
    expect(getCoordByCode(undefined)).toBeNull()
    expect(getCoordByCode('')).toBeNull()
    expect(getCoordByCode('ZZ')).toBeNull()
  })

  test('is case sensitive, so callers must go through getCountryCodeFromRegion', () => {
    expect(getCoordByCode('cn')).toBeNull()
    expect(getCoordByCode(getCountryCodeFromRegion('cn'))).toEqual([35.8617, 104.1954])
  })
})

describe('COORD_MAP', () => {
  test('every entry is a plausible lat/lon pair', () => {
    for (const [code, [lat, lon]] of Object.entries(COORD_MAP)) {
      expect(code).toMatch(/^[A-Z]{2}$/)
      expect(lat).toBeGreaterThanOrEqual(-90)
      expect(lat).toBeLessThanOrEqual(90)
      expect(lon).toBeGreaterThanOrEqual(-180)
      expect(lon).toBeLessThanOrEqual(180)
    }
  })
})
