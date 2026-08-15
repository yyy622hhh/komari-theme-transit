import { describe, expect, test } from 'bun:test'
import {
  buildAvailableMetricViews,
  CUSTOM_METRIC_VIEW_LABEL,
  getMetricCustomRangeError,
  parseMetricCustomRange,
} from '../../src/utils/metricRange'

const presets = [
  { label: '4 小时', hours: 4 },
  { label: '1 天', hours: 24 },
  { label: '7 天', hours: 168 },
] as const

describe('metric range helpers', () => {
  test('builds realtime, preset, preserve-time and custom views without duplicates', () => {
    expect(buildAvailableMetricViews(48, presets, { includeRealtime: true })).toEqual([
      { label: '实时' },
      { label: '4 小时', hours: 4 },
      { label: '1 天', hours: 24 },
      { label: '2 天', hours: 48 },
      { label: CUSTOM_METRIC_VIEW_LABEL },
    ])
  })

  test('validates custom date ranges and reports incomplete input', () => {
    const range = parseMetricCustomRange('2026-08-15T08:00', '2026-08-15T10:30')
    expect(range?.hours).toBe(3)
    expect(getMetricCustomRangeError(true, '2026-08-15T08:00', '2026-08-15T10:30', range)).toBe('')
    expect(getMetricCustomRangeError(true, '2026-08-15T08:00', '', null)).toBe('请选择开始和结束时间')
    expect(parseMetricCustomRange('2026-08-15T10:30', '2026-08-15T08:00')).toBeNull()
  })
})
