import { describe, expect, test } from 'bun:test'
import {
  ALL_CHART_DASHBOARD_CARDS,
  ALL_GENERAL_CARD_KEYS,
  CHART_DASHBOARD_SLOT_COUNT,
  DEFAULT_CHART_DASHBOARD_CARDS,
  DEFAULT_GLASS_CUSTOM_COLORS,
  DETAIL_METRIC_CARD_SLOT_COUNT,
  GENERAL_CARD_SLOT_COUNT,
  getBeijingHour,
  isChartDashboardCardKey,
  isDetailMetricCardKey,
  isGeneralCardKey,
  isHomeQuickControlKey,
  isNodeListMetadataField,
  isValidManagedThemeMode,
  isValidThemeMode,
  normalizeHomeQuickControlOrder,
  parseChartDashboardPreset,
  parseChartDashboardSlots,
  parseChartDashboardTemplate,
  parseColorVisionMode,
  parseDetailMetricCardPreset,
  parseDetailMetricCardSlots,
  parseGeneralCardPreset,
  parseGeneralCardSlots,
  parseGlassColorPreset,
  parseGlassCustomColors,
  parseHomeQuickControlPreset,
  parseKeyList,
  readBooleanSetting,
  readColorSetting,
  readColorValue,
  readNumberSetting,
  readStringSetting,
} from '../../src/stores/app.settings'

describe('theme mode guards', () => {
  test('accepts only the three supported modes', () => {
    expect(isValidThemeMode('auto')).toBe(true)
    expect(isValidThemeMode('light')).toBe(true)
    expect(isValidThemeMode('dark')).toBe(true)
    expect(isValidThemeMode('Dark')).toBe(false)
    expect(isValidThemeMode('')).toBe(false)
    expect(isValidThemeMode(null)).toBe(false)
    expect(isValidThemeMode(undefined)).toBe(false)
    expect(isValidThemeMode(1)).toBe(false)
  })

  test('managed theme mode guard rejects non-string input the same way', () => {
    expect(isValidManagedThemeMode(null)).toBe(false)
    expect(isValidManagedThemeMode({})).toBe(false)
  })
})

describe('getBeijingHour', () => {
  test('reports the Asia/Shanghai hour regardless of the host timezone', () => {
    // 2026-08-18T00:30:00Z 即北京时间 08:30。
    expect(getBeijingHour(Date.parse('2026-08-18T00:30:00.000Z'))).toBe(8)
  })

  test('normalises the midnight hour to 0 rather than 24', () => {
    // 2026-08-17T16:00:00Z 即北京时间次日 00:00。
    expect(getBeijingHour(Date.parse('2026-08-17T16:00:00.000Z'))).toBe(0)
  })

  test('always returns an hour inside [0, 23]', () => {
    for (let offsetHours = 0; offsetHours < 24; offsetHours += 1) {
      const hour = getBeijingHour(Date.parse('2026-01-01T00:00:00.000Z') + offsetHours * 3_600_000)
      expect(hour).toBeGreaterThanOrEqual(0)
      expect(hour).toBeLessThanOrEqual(23)
    }
  })
})

describe('key guards', () => {
  test('recognise their own key spaces and reject foreign keys', () => {
    expect(isGeneralCardKey('memory')).toBe(true)
    expect(isGeneralCardKey('definitely-not-a-card')).toBe(false)
    expect(isChartDashboardCardKey('cpu')).toBe(true)
    expect(isChartDashboardCardKey('memory')).toBe(true)
    expect(isChartDashboardCardKey('remainingValue')).toBe(false)
    expect(isDetailMetricCardKey('nodePrice')).toBe(true)
    expect(isDetailMetricCardKey('cpu-nope')).toBe(false)
    expect(isHomeQuickControlKey('not-a-control')).toBe(false)
    expect(isNodeListMetadataField('not-a-field')).toBe(false)
  })
})

describe('preset parsers', () => {
  test('fall back to their documented default for non-string input', () => {
    expect(parseGeneralCardPreset(undefined)).toBe('basic')
    expect(parseGeneralCardPreset(null)).toBe('basic')
    expect(parseGeneralCardPreset(42)).toBe('basic')
    expect(parseDetailMetricCardPreset(undefined)).toBe('finance')
    expect(parseChartDashboardPreset(undefined)).toBe('all')
    expect(parseHomeQuickControlPreset(undefined)).toBe('full')
    expect(parseGlassColorPreset(undefined)).toBe('emerald')
    expect(parseColorVisionMode(undefined)).toBe('default')
  })

  test('fall back for an unknown string instead of leaking it through', () => {
    expect(parseGeneralCardPreset('nonsense')).toBe('basic')
    expect(parseDetailMetricCardPreset('nonsense')).toBe('finance')
    expect(parseChartDashboardPreset('nonsense')).toBe('all')
    expect(parseHomeQuickControlPreset('nonsense')).toBe('full')
    expect(parseGlassColorPreset('nonsense')).toBe('emerald')
    expect(parseColorVisionMode('nonsense')).toBe('default')
  })

  test('accept the Chinese aliases used in the hosted settings UI', () => {
    expect(parseGeneralCardPreset('运维')).toBe('ops')
    expect(parseGeneralCardPreset('完整')).toBe('full')
    expect(parseDetailMetricCardPreset('网络')).toBe('network')
    expect(parseHomeQuickControlPreset('流量')).toBe('traffic')
    expect(parseGlassColorPreset('午夜')).toBe('midnight')
    expect(parseColorVisionMode('色觉友好')).toBe('accessible')
    expect(parseColorVisionMode('colorblind')).toBe('accessible')
  })

  test('trim surrounding whitespace before matching an alias', () => {
    expect(parseGeneralCardPreset('  运维  ')).toBe('ops')
    expect(parseGlassColorPreset(' custom ')).toBe('custom')
  })
})

describe('parseKeyList', () => {
  const fallback = ['cpu', 'memory'] as const

  test('falls back when the value is absent or of the wrong type', () => {
    expect(parseKeyList(undefined, isChartDashboardCardKey, fallback)).toEqual([...fallback])
    expect(parseKeyList(null, isChartDashboardCardKey, fallback)).toEqual([...fallback])
    expect(parseKeyList(123, isChartDashboardCardKey, fallback)).toEqual([...fallback])
  })

  test('falls back when every entry is invalid rather than returning an empty layout', () => {
    expect(parseKeyList('nope,also-nope', isChartDashboardCardKey, fallback)).toEqual([...fallback])
  })

  test('splits on commas, semicolons, whitespace and their full-width forms', () => {
    expect(parseKeyList('cpu,memory;disk network，gpu；process', isChartDashboardCardKey, fallback))
      .toEqual(['cpu', 'memory', 'disk', 'network', 'gpu', 'process'])
  })

  test('accepts an array as well as a delimited string', () => {
    expect(parseKeyList(['cpu', 'disk'], isChartDashboardCardKey, fallback)).toEqual(['cpu', 'disk'])
  })

  test('drops duplicates while preserving first-seen order', () => {
    expect(parseKeyList('disk,cpu,disk,cpu', isChartDashboardCardKey, fallback)).toEqual(['disk', 'cpu'])
  })

  test('drops invalid entries but keeps the valid ones', () => {
    expect(parseKeyList('cpu,bogus,disk', isChartDashboardCardKey, fallback)).toEqual(['cpu', 'disk'])
  })

  test('trims each entry and ignores non-string array members', () => {
    expect(parseKeyList([' cpu ', 7, null, 'disk'], isChartDashboardCardKey, fallback)).toEqual(['cpu', 'disk'])
  })
})

describe('slot parsers', () => {
  test('return an empty list when no slot is configured', () => {
    expect(parseGeneralCardSlots({})).toEqual([])
    expect(parseDetailMetricCardSlots({})).toEqual([])
    expect(parseChartDashboardSlots({})).toEqual([])
  })

  test('read slots in order and skip unset ones', () => {
    expect(parseGeneralCardSlots({
      generalCardSlot1: 'memory',
      generalCardSlot3: 'disk',
    })).toEqual(['memory', 'disk'])
  })

  test('resolve Chinese labels through the alias table', () => {
    expect(parseGeneralCardSlots({ generalCardSlot1: '内存用量', generalCardSlot2: '硬盘用量' }))
      .toEqual(['memory', 'disk'])
  })

  test('trim slot values before resolving them', () => {
    expect(parseGeneralCardSlots({ generalCardSlot1: '  memory  ' })).toEqual(['memory'])
  })

  test('drop duplicates so one card cannot occupy two slots', () => {
    expect(parseGeneralCardSlots({
      generalCardSlot1: 'memory',
      generalCardSlot2: '内存用量',
      generalCardSlot3: 'disk',
    })).toEqual(['memory', 'disk'])
  })

  test('ignore unknown labels and non-string values', () => {
    expect(parseGeneralCardSlots({
      generalCardSlot1: 'memory',
      generalCardSlot2: 'not-a-card',
      generalCardSlot3: 99,
      generalCardSlot4: 'disk',
    })).toEqual(['memory', 'disk'])
  })

  test('never read past the declared slot count', () => {
    const beyond = GENERAL_CARD_SLOT_COUNT + 1
    expect(parseGeneralCardSlots({ [`generalCardSlot${beyond}`]: 'memory' })).toEqual([])
    expect(parseDetailMetricCardSlots({ [`detailMetricCardSlot${DETAIL_METRIC_CARD_SLOT_COUNT + 1}`]: 'nodePrice' })).toEqual([])
    expect(parseChartDashboardSlots({ [`chartDashboardSlot${CHART_DASHBOARD_SLOT_COUNT + 1}`]: 'cpu' })).toEqual([])
  })

  test('only ever emit keys from their own key space', () => {
    for (const key of parseGeneralCardSlots({ generalCardSlot1: 'memory', generalCardSlot2: 'disk' }))
      expect(ALL_GENERAL_CARD_KEYS as readonly string[]).toContain(key)
  })
})

describe('parseChartDashboardTemplate', () => {
  test('falls back to the default cards for empty input', () => {
    expect(parseChartDashboardTemplate(undefined).cards).toEqual([...DEFAULT_CHART_DASHBOARD_CARDS])
    expect(parseChartDashboardTemplate('').cards).toEqual([...DEFAULT_CHART_DASHBOARD_CARDS])
    expect(parseChartDashboardTemplate(null).cards).toEqual([...DEFAULT_CHART_DASHBOARD_CARDS])
  })

  test('parses a JSON object with a cards array', () => {
    expect(parseChartDashboardTemplate('{"cards":["cpu","disk"]}').cards).toEqual(['cpu', 'disk'])
  })

  test('accepts an already-parsed object', () => {
    expect(parseChartDashboardTemplate({ cards: ['memory', 'network'] }).cards).toEqual(['memory', 'network'])
  })

  test('accepts the legacy layout key', () => {
    expect(parseChartDashboardTemplate({ layout: ['gpu', 'cpu'] }).cards).toEqual(['gpu', 'cpu'])
  })

  test('treats a non-JSON string as a delimited key list', () => {
    expect(parseChartDashboardTemplate('cpu, disk').cards).toEqual(['cpu', 'disk'])
  })

  test('falls back for a JSON array or scalar at the top level', () => {
    expect(parseChartDashboardTemplate('["cpu"]').cards).toEqual([...DEFAULT_CHART_DASHBOARD_CARDS])
    expect(parseChartDashboardTemplate('42').cards).toEqual([...DEFAULT_CHART_DASHBOARD_CARDS])
  })

  test('only ever emits known chart cards', () => {
    for (const card of parseChartDashboardTemplate('{"cards":["cpu","bogus","disk"]}').cards)
      expect(ALL_CHART_DASHBOARD_CARDS as readonly string[]).toContain(card)
  })
})

describe('normalizeHomeQuickControlOrder', () => {
  test('drops duplicates while preserving order', () => {
    const order = normalizeHomeQuickControlOrder(['a', 'b', 'a', 'c'] as never)
    expect(order).toEqual(['a', 'b', 'c'] as never)
  })

  test('leaves an already-unique order untouched', () => {
    const order = ['a', 'b'] as never
    expect(normalizeHomeQuickControlOrder(order)).toEqual(order)
  })
})

describe('scalar setting readers', () => {
  test('readBooleanSetting only accepts real booleans', () => {
    expect(readBooleanSetting({ flag: true }, 'flag', false)).toBe(true)
    expect(readBooleanSetting({ flag: false }, 'flag', true)).toBe(false)
    // 字符串 "true" 是配置里最常见的误填，必须回落而不是被当成 true。
    expect(readBooleanSetting({ flag: 'true' }, 'flag', false)).toBe(false)
    expect(readBooleanSetting({ flag: 1 }, 'flag', false)).toBe(false)
    expect(readBooleanSetting({}, 'flag', true)).toBe(true)
  })

  test('readNumberSetting clamps into range and rejects non-finite values', () => {
    expect(readNumberSetting({ n: 50 }, 'n', 10, 0, 100)).toBe(50)
    expect(readNumberSetting({ n: -5 }, 'n', 10, 0, 100)).toBe(0)
    expect(readNumberSetting({ n: 500 }, 'n', 10, 0, 100)).toBe(100)
    expect(readNumberSetting({ n: Number.NaN }, 'n', 10, 0, 100)).toBe(10)
    expect(readNumberSetting({ n: Number.POSITIVE_INFINITY }, 'n', 10, 0, 100)).toBe(10)
    expect(readNumberSetting({ n: '50' }, 'n', 10, 0, 100)).toBe(10)
    expect(readNumberSetting({}, 'n', 10, 0, 100)).toBe(10)
  })

  test('readStringSetting trims and falls back for non-strings', () => {
    expect(readStringSetting({ s: '  hello  ' }, 's')).toBe('hello')
    expect(readStringSetting({ s: 42 }, 's', 'fallback')).toBe('fallback')
    expect(readStringSetting({}, 's', 'fallback')).toBe('fallback')
    // 空字符串是合法的显式取值，不应该被换成 fallback。
    expect(readStringSetting({ s: '   ' }, 's', 'fallback')).toBe('')
  })
})

describe('color settings', () => {
  test('accept 6- and 8-digit hex in either case', () => {
    expect(readColorValue('#AABBCC', '#000000')).toBe('#AABBCC')
    expect(readColorValue('#aabbccdd', '#000000')).toBe('#aabbccdd')
    expect(readColorValue('  #aabbcc  ', '#000000')).toBe('#aabbcc')
  })

  test('reject shorthand, missing hash, bad characters and non-strings', () => {
    expect(readColorValue('#abc', '#000000')).toBe('#000000')
    expect(readColorValue('aabbcc', '#000000')).toBe('#000000')
    expect(readColorValue('#gggggg', '#000000')).toBe('#000000')
    expect(readColorValue('#aabbc', '#000000')).toBe('#000000')
    expect(readColorValue(null, '#000000')).toBe('#000000')
    expect(readColorValue(0x00FF00, '#000000')).toBe('#000000')
  })

  test('readColorSetting applies the same validation through a settings key', () => {
    expect(readColorSetting({ c: '#123456' }, 'c', '#000000')).toBe('#123456')
    expect(readColorSetting({ c: 'red' }, 'c', '#000000')).toBe('#000000')
    expect(readColorSetting({}, 'c', '#000000')).toBe('#000000')
  })
})

describe('parseGlassCustomColors', () => {
  test('returns the built-in defaults for empty settings', () => {
    expect(parseGlassCustomColors({})).toEqual(DEFAULT_GLASS_CUSTOM_COLORS)
  })

  test('reads the legacy flat keys', () => {
    const colors = parseGlassCustomColors({ glassLightCardColor: '#112233' })
    expect(colors.lightCard).toBe('#112233')
    expect(colors.darkCard).toBe(DEFAULT_GLASS_CUSTOM_COLORS.darkCard)
  })

  test('lets the JSON blob override the legacy keys', () => {
    const colors = parseGlassCustomColors({
      glassLightCardColor: '#112233',
      glassCustomColors: '{"lightCard":"#445566"}',
    })
    expect(colors.lightCard).toBe('#445566')
  })

  test('falls back per-field to the legacy value when the blob entry is invalid', () => {
    const colors = parseGlassCustomColors({
      glassLightCardColor: '#112233',
      glassCustomColors: '{"lightCard":"not-a-color"}',
    })
    expect(colors.lightCard).toBe('#112233')
  })

  test('falls back to the legacy colors when the blob is malformed JSON', () => {
    const colors = parseGlassCustomColors({
      glassLightCardColor: '#112233',
      glassCustomColors: '{not json',
    })
    expect(colors.lightCard).toBe('#112233')
  })

  test('falls back when the blob is an array or scalar', () => {
    expect(parseGlassCustomColors({ glassCustomColors: '[]' })).toEqual(DEFAULT_GLASS_CUSTOM_COLORS)
    expect(parseGlassCustomColors({ glassCustomColors: '5' })).toEqual(DEFAULT_GLASS_CUSTOM_COLORS)
  })

  test('accepts an already-parsed object', () => {
    expect(parseGlassCustomColors({ glassCustomColors: { darkText: '#ffffff' } }).darkText).toBe('#ffffff')
  })

  test('always returns a complete, valid palette', () => {
    const colors = parseGlassCustomColors({ glassCustomColors: '{"lightCard":"bogus"}' })
    for (const value of Object.values(colors))
      expect(value).toMatch(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i)
    expect(Object.keys(colors).sort()).toEqual(Object.keys(DEFAULT_GLASS_CUSTOM_COLORS).sort())
  })
})

describe('slot parsers cover every declared slot', () => {
  // 上面「不越界」的用例只有在键名写对时才有意义，这里正面确认最后一个槽位可读。
  test('reads the last general card slot', () => {
    expect(parseGeneralCardSlots({ [`generalCardSlot${GENERAL_CARD_SLOT_COUNT}`]: 'memory' })).toEqual(['memory'])
  })

  test('reads the last detail metric card slot', () => {
    expect(parseDetailMetricCardSlots({ [`detailMetricCardSlot${DETAIL_METRIC_CARD_SLOT_COUNT}`]: 'nodePrice' })).toEqual(['nodePrice'])
  })

  test('reads the last chart dashboard slot', () => {
    expect(parseChartDashboardSlots({ [`chartDashboardSlot${CHART_DASHBOARD_SLOT_COUNT}`]: 'cpu' })).toEqual(['cpu'])
  })
})
