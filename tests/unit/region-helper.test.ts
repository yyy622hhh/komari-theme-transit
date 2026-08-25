import { describe, expect, test } from 'bun:test'
import {
  extractRegionEmojis,
  getEmojiByCode,
  getRegionByAlias,
  getRegionCode,
  getRegionDisplayName,
  getSupportedRegions,
  isRegionMatch,
  searchRegions,
} from '../../src/utils/regionHelper'

describe('isRegionMatch', () => {
  test('matches the exact emoji or raw value even for an unrecognised region', () => {
    expect(isRegionMatch('🇭🇰', '🇭🇰')).toBe(true)
    expect(isRegionMatch('some-custom-label', 'some-custom-label')).toBe(true)
  })

  test('falls back to a substring check on the raw value when the region is unknown', () => {
    expect(isRegionMatch('湖北电信', '电信')).toBe(true)
    expect(isRegionMatch('湖北电信', '联通')).toBe(false)
  })

  test('matches by English name, Chinese name, or alias, case-insensitively', () => {
    expect(isRegionMatch('🇭🇰', 'hong kong')).toBe(true)
    expect(isRegionMatch('🇭🇰', '香港')).toBe(true)
    expect(isRegionMatch('🇭🇰', 'HK')).toBe(true)
    expect(isRegionMatch('🇺🇸', 'america')).toBe(true)
  })

  test('does not match an unrelated region', () => {
    expect(isRegionMatch('🇭🇰', 'japan')).toBe(false)
  })
})

describe('getRegionDisplayName', () => {
  test('returns the Chinese name by default', () => {
    expect(getRegionDisplayName('🇭🇰')).toBe('香港')
  })

  test('returns the English name when asked', () => {
    expect(getRegionDisplayName('🇭🇰', 'en')).toBe('Hong Kong')
  })

  test('returns an empty string for an unrecognised region', () => {
    expect(getRegionDisplayName('🏴‍☠️')).toBe('')
  })
})

describe('getSupportedRegions', () => {
  test('includes the well-known regions and nothing empty', () => {
    const regions = getSupportedRegions()
    expect(regions).toContain('🇭🇰')
    expect(regions).toContain('🇨🇳')
    expect(regions.every(Boolean)).toBe(true)
  })
})

describe('getRegionCode', () => {
  test('returns the ISO-style code for a known region', () => {
    expect(getRegionCode('🇭🇰')).toBe('HK')
    expect(getRegionCode('🇨🇳')).toBe('CN')
  })

  test('echoes back the input unchanged for an unknown region', () => {
    expect(getRegionCode('custom-label')).toBe('custom-label')
  })
})

describe('getEmojiByCode', () => {
  test('resolves a code back to its emoji, case-insensitively', () => {
    expect(getEmojiByCode('hk')).toBe('🇭🇰')
    expect(getEmojiByCode('HK')).toBe('🇭🇰')
  })

  test('echoes back the input unchanged for an unknown code', () => {
    expect(getEmojiByCode('XX')).toBe('XX')
  })
})

describe('searchRegions', () => {
  test('finds every region whose name or alias matches the term', () => {
    const results = searchRegions('hong kong')
    expect(results.some(region => region.emoji === '🇭🇰')).toBe(true)
  })

  test('returns an empty list when nothing matches', () => {
    expect(searchRegions('definitely-not-a-region')).toEqual([])
  })
})

describe('getRegionByAlias', () => {
  test('resolves an alias, a code, or a Chinese name to full region info', () => {
    expect(getRegionByAlias('hongkong')?.emoji).toBe('🇭🇰')
    expect(getRegionByAlias('HK')?.emoji).toBe('🇭🇰')
    expect(getRegionByAlias('香港')?.emoji).toBe('🇭🇰')
  })

  test('returns null for an alias that matches nothing', () => {
    expect(getRegionByAlias('not-a-real-place')).toBeNull()
  })
})

describe('extractRegionEmojis', () => {
  test('pulls every recognised flag emoji out of a longer string', () => {
    expect(extractRegionEmojis('线路：🇭🇰 → 🇯🇵 → 🇺🇸')).toEqual(['🇭🇰', '🇯🇵', '🇺🇸'])
  })

  test('ignores a flag-shaped sequence that is not in the region map', () => {
    // 区域指示符组合本身合法，但 ZZ 不是地图里收录的国家/地区代码。
    expect(extractRegionEmojis('🇿🇿')).toEqual([])
  })

  test('returns an empty list when there is no flag in the text', () => {
    expect(extractRegionEmojis('没有旗帜的纯文本')).toEqual([])
  })
})
