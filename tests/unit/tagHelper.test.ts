import { describe, expect, test } from 'bun:test'
import {
  formatCurrencyValue,
  formatPrice,
  formatPriceWithCycle,
  getBillingCycleText,
  getDaysUntilExpired,
  getExpireStatus,
  getExpireStatusColor,
  getExpireStatusHexColor,
  getExpireText,
  getRemainingValue,
  getTagColorHex,
  hasFreeNodeTag,
  hasIPv4,
  hasIPv6,
  isFreeNode,
  isFreePrice,
  parseBillingCycleType,
  parseTags,
  parseTagWithColor,
  TAG_COLOR_HEX_MAP,
  TAG_COLORS,
} from '../../src/utils/tagHelper'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 到期时间辅助：这些函数内部读 `Date.now()`，只能用相对时间构造用例。 */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString()
}

describe('parseBillingCycleType', () => {
  test('maps -1 to the one-off cycle', () => {
    expect(parseBillingCycleType(-1)).toBe('once')
  })

  test.each([
    [30, 'monthly'],
    [27, 'monthly'],
    [32, 'monthly'],
    [90, 'quarterly'],
    [180, 'semi_annual'],
    [365, 'annual'],
    [730, 'biennial'],
    [1095, 'triennial'],
    [1825, 'quinquennial'],
  ])('classifies %i days as %s', (days, expected) => {
    expect(parseBillingCycleType(days)).toBe(expected as ReturnType<typeof parseBillingCycleType>)
  })

  test.each([0, 7, 26, 33, 60, 200, 400, 2000])('treats %i days as a custom cycle', (days) => {
    expect(parseBillingCycleType(days)).toBe('custom')
  })

  test('leaves the gaps between ranges as custom rather than snapping to a neighbour', () => {
    // 33..86 落在月付与季付之间，必须是 custom，不能被就近归类。
    expect(parseBillingCycleType(33)).toBe('custom')
    expect(parseBillingCycleType(86)).toBe('custom')
  })
})

describe('getBillingCycleText', () => {
  test('renders known cycles in both languages', () => {
    expect(getBillingCycleText(30)).toBe('月')
    expect(getBillingCycleText(30, 'en-US')).toBe('Month')
    expect(getBillingCycleText(365)).toBe('年')
    expect(getBillingCycleText(365, 'en-US')).toBe('Year')
    expect(getBillingCycleText(-1)).toBe('一次性')
    expect(getBillingCycleText(-1, 'en-US')).toBe('Once')
  })

  test('inlines the raw day count for custom cycles', () => {
    expect(getBillingCycleText(45)).toBe('45 天')
    expect(getBillingCycleText(45, 'en-US')).toBe('45 Days')
  })
})

describe('getDaysUntilExpired', () => {
  test('returns 0 for missing or unparseable input', () => {
    expect(getDaysUntilExpired(null)).toBe(0)
    expect(getDaysUntilExpired(undefined)).toBe(0)
    expect(getDaysUntilExpired('')).toBe(0)
    expect(getDaysUntilExpired('not-a-date')).toBe(0)
  })

  test('rounds a partial future day up to 1 so "expiring today" is never shown as 0', () => {
    expect(getDaysUntilExpired(daysFromNow(0.25))).toBe(1)
  })

  test('rounds future days up', () => {
    expect(getDaysUntilExpired(daysFromNow(9.2))).toBe(10)
  })

  test('returns a negative day count once expired', () => {
    expect(getDaysUntilExpired(daysFromNow(-3.5))).toBeLessThan(0)
  })

  test('accepts epoch milliseconds as well as ISO strings', () => {
    const target = Date.now() + 5 * MS_PER_DAY
    expect(getDaysUntilExpired(target)).toBe(getDaysUntilExpired(new Date(target).toISOString()))
  })
})

describe('getExpireStatus', () => {
  test('returns unknown when the timestamp is absent or invalid', () => {
    expect(getExpireStatus(null)).toBe('unknown')
    expect(getExpireStatus('nonsense')).toBe('unknown')
  })

  test('classifies each threshold band', () => {
    expect(getExpireStatus(daysFromNow(-1))).toBe('expired')
    expect(getExpireStatus(daysFromNow(3))).toBe('critical')
    expect(getExpireStatus(daysFromNow(8))).toBe('warning')
    expect(getExpireStatus(daysFromNow(60))).toBe('normal')
    expect(getExpireStatus(daysFromNow(40_000))).toBe('long_term')
  })

  test('places the critical/warning boundary at 5 days inclusive', () => {
    expect(getExpireStatus(daysFromNow(4.5))).toBe('critical')
    expect(getExpireStatus(daysFromNow(5.5))).toBe('warning')
  })

  test('places the warning/normal boundary at 10 days inclusive', () => {
    expect(getExpireStatus(daysFromNow(9.5))).toBe('warning')
    expect(getExpireStatus(daysFromNow(10.5))).toBe('normal')
  })
})

describe('expire status colors', () => {
  test('maps every status to a semantic tone', () => {
    expect(getExpireStatusColor('expired')).toBe('error')
    expect(getExpireStatusColor('critical')).toBe('error')
    expect(getExpireStatusColor('warning')).toBe('warning')
    expect(getExpireStatusColor('normal')).toBe('success')
    expect(getExpireStatusColor('long_term')).toBe('success')
    expect(getExpireStatusColor('unknown')).toBe('default')
  })

  test('returns a usable hex for every status', () => {
    for (const status of ['expired', 'critical', 'warning', 'normal', 'long_term', 'unknown'] as const)
      expect(getExpireStatusHexColor(status)).toMatch(/^#[0-9a-f]{3,8}$/i)
  })
})

describe('getExpireText', () => {
  test('renders a dash when the expiry is unknown', () => {
    expect(getExpireText(null)).toBe('-')
    expect(getExpireText(null, 'en-US')).toBe('-')
  })

  test('renders expired and long-term states as words, not day counts', () => {
    expect(getExpireText(daysFromNow(-2))).toBe('已过期')
    expect(getExpireText(daysFromNow(-2), 'en-US')).toBe('Expired')
    expect(getExpireText(daysFromNow(40_000))).toBe('长期')
    expect(getExpireText(daysFromNow(40_000), 'en-US')).toBe('Long-term')
  })

  test('renders a day count in the remaining bands', () => {
    expect(getExpireText(daysFromNow(6.2))).toBe('7 天')
    expect(getExpireText(daysFromNow(6.2), 'en-US')).toBe('7 days')
  })
})

describe('parseTagWithColor', () => {
  test('splits a recognised color suffix off the label', () => {
    expect(parseTagWithColor('生产<jade>')).toEqual({ text: '生产', color: 'jade' })
  })

  test('accepts a case-insensitive color suffix', () => {
    expect(parseTagWithColor('生产<JADE>')).toEqual({ text: '生产', color: 'jade' })
  })

  test('keeps an unrecognised suffix as part of the label', () => {
    expect(parseTagWithColor('版本<v2>')).toEqual({ text: '版本<v2>', color: null })
  })

  test('trims surrounding whitespace', () => {
    expect(parseTagWithColor('  边缘<sky>  ')).toEqual({ text: '边缘', color: 'sky' })
  })

  test('returns a null color when no suffix is present', () => {
    expect(parseTagWithColor('普通')).toEqual({ text: '普通', color: null })
  })
})

describe('parseTags', () => {
  test('returns an empty list for empty input', () => {
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags('')).toEqual([])
    expect(parseTags('   ')).toEqual([])
  })

  test('splits on semicolons and drops empty segments', () => {
    expect(parseTags('a;;b; ;c').map(tag => tag.text)).toEqual(['a', 'b', 'c'])
  })

  test('honours explicit colors and cycles palette colors by position otherwise', () => {
    const tags = parseTags('生产<jade>;测试;边缘')
    expect(tags[0]).toEqual({ text: '生产', color: 'jade', hex: TAG_COLOR_HEX_MAP.jade })
    expect(tags[1]?.color).toBe(TAG_COLORS[1]!)
    expect(tags[2]?.color).toBe(TAG_COLORS[2]!)
  })

  test('always resolves a hex that matches the chosen color', () => {
    for (const tag of parseTags('a;b;c;d;e'))
      expect(tag.hex).toBe(getTagColorHex(tag.color))
  })

  test('wraps around the palette instead of running out of colors', () => {
    const many = parseTags(Array.from({ length: TAG_COLORS.length + 2 }, (_, index) => `t${index}`).join(';'))
    expect(many).toHaveLength(TAG_COLORS.length + 2)
    expect(many.at(-2)?.color).toBe(TAG_COLORS[0]!)
    expect(many.at(-1)?.color).toBe(TAG_COLORS[1]!)
  })
})

describe('free node detection', () => {
  test('treats -1 as the free sentinel and 0 as a real zero price', () => {
    expect(isFreePrice(-1)).toBe(true)
    expect(isFreePrice(0)).toBe(false)
    expect(isFreePrice(9.9)).toBe(false)
  })

  test('recognises the 白嫖中 tag regardless of its color suffix', () => {
    expect(hasFreeNodeTag('白嫖中')).toBe(true)
    expect(hasFreeNodeTag('白嫖中<jade>')).toBe(true)
    expect(hasFreeNodeTag('生产;白嫖中')).toBe(true)
    expect(hasFreeNodeTag('生产')).toBe(false)
    expect(hasFreeNodeTag(undefined)).toBe(false)
  })

  test('combines the price sentinel and the tag', () => {
    expect(isFreeNode({ price: -1 })).toBe(true)
    expect(isFreeNode({ price: 9.9, tags: '白嫖中' })).toBe(true)
    expect(isFreeNode({ price: 9.9, tags: '生产' })).toBe(false)
    expect(isFreeNode({ price: 0 })).toBe(false)
  })
})

describe('price formatting', () => {
  test('renders both zero and the free sentinel as 免费', () => {
    expect(formatPrice(0)).toBe('免费')
    expect(formatPrice(-1)).toBe('免费')
    expect(formatPrice(0, '$', 'en-US')).toBe('Free')
  })

  test('prefixes the currency symbol for a real price', () => {
    expect(formatPrice(9.9)).toBe('￥9.9')
    expect(formatPrice(9.9, '$')).toBe('$9.9')
  })

  test('omits the cycle suffix for a free node', () => {
    expect(formatPriceWithCycle(-1, 30)).toBe('免费')
    expect(formatPriceWithCycle(-1, 30, '$', 'en-US')).toBe('Free')
  })

  test('appends the cycle for a priced node', () => {
    expect(formatPriceWithCycle(9.9, 30, '$')).toBe('$9.9 / 月')
    expect(formatPriceWithCycle(9.9, 365, '$', 'en-US')).toBe('$9.9 / Year')
  })

  test('renders a zero price with its cycle rather than as a bare 免费', () => {
    expect(formatPriceWithCycle(0, 30)).toBe('免费 / 月')
  })
})

describe('getRemainingValue', () => {
  test('returns 0 for a non-positive price', () => {
    expect(getRemainingValue(0, 30, daysFromNow(15))).toBe(0)
    expect(getRemainingValue(-1, 30, daysFromNow(15))).toBe(0)
  })

  test('returns 0 for unknown or already-expired nodes', () => {
    expect(getRemainingValue(30, 30, null)).toBe(0)
    expect(getRemainingValue(30, 30, 'nonsense')).toBe(0)
    expect(getRemainingValue(30, 30, daysFromNow(-1))).toBe(0)
  })

  test('returns the full price for a long-term node', () => {
    expect(getRemainingValue(30, 30, daysFromNow(40_000))).toBe(30)
  })

  test('returns the full price when the cycle is one-off or unknown', () => {
    expect(getRemainingValue(30, -1, daysFromNow(15))).toBe(30)
    expect(getRemainingValue(30, 0, daysFromNow(15))).toBe(30)
  })

  test('prorates by remaining days within a cycle', () => {
    // 15 天剩余 / 30 天周期 ≈ 半个周期的价值。
    expect(getRemainingValue(30, 30, daysFromNow(14.5))).toBeCloseTo(15, 5)
  })

  test('accumulates value across multiple prepaid cycles', () => {
    // 提前续费覆盖多个周期时按全部剩余天数累计，而不是截断到一个周期。
    expect(getRemainingValue(30, 30, daysFromNow(89.5))).toBeCloseTo(90, 5)
  })
})

describe('formatCurrencyValue', () => {
  test('drops a fully-zero fractional part', () => {
    expect(formatCurrencyValue(100)).toBe('￥100')
    expect(formatCurrencyValue(1000)).toBe('￥1000')
    expect(formatCurrencyValue(20)).toBe('￥20')
  })

  test('drops only the trailing zero of a partial fraction', () => {
    expect(formatCurrencyValue(100.5)).toBe('￥100.5')
    expect(formatCurrencyValue(100.1)).toBe('￥100.1')
  })

  test('keeps two meaningful decimals', () => {
    expect(formatCurrencyValue(1082.87)).toBe('￥1082.87')
  })

  test('rounds to two decimals', () => {
    expect(formatCurrencyValue(9.999)).toBe('￥10')
    expect(formatCurrencyValue(9.994)).toBe('￥9.99')
  })

  test('renders zero as a bare 0 rather than an empty string', () => {
    expect(formatCurrencyValue(0)).toBe('￥0')
    expect(formatCurrencyValue(0.001)).toBe('￥0')
  })

  test('honours a custom currency symbol', () => {
    expect(formatCurrencyValue(12.5, '$')).toBe('$12.5')
  })
})

describe('ip presence helpers', () => {
  test('treats empty and whitespace-only values as absent', () => {
    expect(hasIPv4('')).toBe(false)
    expect(hasIPv4('   ')).toBe(false)
    expect(hasIPv4(undefined)).toBe(false)
    expect(hasIPv4(null)).toBe(false)
    expect(hasIPv6('')).toBe(false)
    expect(hasIPv6(undefined)).toBe(false)
  })

  test('accepts a populated address', () => {
    expect(hasIPv4('203.0.113.10')).toBe(true)
    expect(hasIPv6('2001:db8::25')).toBe(true)
  })
})
