import { describe, expect, test } from 'bun:test'
import {
  calcPercentage,
  formatBytes,
  formatBytesPerSecond,
  formatBytesPerSecondSplit,
  formatBytesSplit,
  formatBytesWithConfig,
  formatDateTime,
  formatUptime,
  formatUptimeWithFormat,
  getStatus,
  getUptimeDays,
} from '../../src/utils/helper'

const KB = 1024
const MB = KB ** 2
const GB = KB ** 3
const TB = KB ** 4
const PB = KB ** 5

describe('formatBytes', () => {
  test('renders zero as a bare 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  test('picks the unit by magnitude', () => {
    expect(formatBytes(512)).toBe('512.0 B')
    expect(formatBytes(KB)).toBe('1.0 KB')
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB')
    expect(formatBytes(2 * GB)).toBe('2.0 GB')
    expect(formatBytes(3 * TB)).toBe('3.0 TB')
    expect(formatBytes(4 * PB)).toBe('4.0 PB')
  })

  test('keeps sub-byte values in B instead of overflowing to PB', () => {
    // 回归：以前 Math.log(0.5)/Math.log(1024) 得到负下标，0.5 B 被显示成「512.0 PB」。
    // 磁盘日增长是线性回归斜率，这种量级真实可达。
    expect(formatBytes(0.5)).toBe('0.5 B')
    expect(formatBytes(0.3)).toBe('0.3 B')
    expect(formatBytes(0.999)).toBe('1.0 B')
  })

  test('keeps the sign for negative values instead of yielding NaN', () => {
    expect(formatBytes(-KB)).toBe('-1.0 KB')
    expect(formatBytes(-0.5)).toBe('-0.5 B')
  })

  test('treats non-finite input as zero rather than printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe('0 B')
  })

  test('caps at the largest known unit', () => {
    expect(formatBytes(1024 * PB)).toContain('PB')
  })

  test('honours the decimals argument', () => {
    expect(formatBytes(1.5 * MB, 0)).toBe('2 MB')
    expect(formatBytes(1.25 * MB, 2)).toBe('1.25 MB')
  })

  test('never emits a unit outside the known table', () => {
    for (const value of [0.1, 1, KB, MB, GB, TB, PB, 1e30, -1e30, Number.NaN]) {
      const [, unit] = formatBytes(value).split(' ')
      expect(['B', 'KB', 'MB', 'GB', 'TB', 'PB']).toContain(unit!)
    }
  })
})

describe('formatBytesWithConfig', () => {
  test('applies the default per-unit precision', () => {
    expect(formatBytesWithConfig(1536)).toBe('2 KB')
    expect(formatBytesWithConfig(1.5 * MB)).toBe('1.5 MB')
    expect(formatBytesWithConfig(1.5 * TB)).toBe('1.50 TB')
  })

  test('shares the sub-byte, negative and non-finite handling', () => {
    expect(formatBytesWithConfig(0.5)).toBe('1 B')
    expect(formatBytesWithConfig(-KB)).toBe('-1 KB')
    expect(formatBytesWithConfig(Number.NaN)).toBe('0 B')
  })

  test('promotes to the next enabled unit when one is disabled', () => {
    expect(formatBytesWithConfig(512, { B: -1 })).toBe('1 KB')
    expect(formatBytesWithConfig(0, { B: -1 })).toBe('0 KB')
  })

  test('uses the TB precision for PB', () => {
    expect(formatBytesWithConfig(2 * PB, { TB: 3 })).toBe('2.000 PB')
  })
})

describe('formatBytesSplit', () => {
  test('splits the number from the unit', () => {
    expect(formatBytesSplit(1.5 * MB)).toEqual({ value: '1.5', unit: 'MB' })
    expect(formatBytesSplit(0)).toEqual({ value: '0', unit: 'B' })
  })

  test('shares the sub-byte, negative and non-finite handling', () => {
    expect(formatBytesSplit(0.5)).toEqual({ value: '1', unit: 'B' })
    expect(formatBytesSplit(-KB)).toEqual({ value: '-1', unit: 'KB' })
    expect(formatBytesSplit(Number.NaN)).toEqual({ value: '0', unit: 'B' })
  })

  test('stays consistent with formatBytesWithConfig', () => {
    for (const value of [0, 0.5, 900, KB, 1.5 * MB, 3 * GB, -KB, Number.NaN]) {
      const split = formatBytesSplit(value)
      expect(`${split.value} ${split.unit}`).toBe(formatBytesWithConfig(value))
    }
  })
})

describe('byte rate helpers', () => {
  test('append a per-second suffix', () => {
    expect(formatBytesPerSecond(1.5 * MB)).toBe('1.5 MB/s')
    expect(formatBytesPerSecondSplit(1.5 * MB)).toEqual({ value: '1.5', unit: 'MB/s' })
  })

  test('do not reintroduce the sub-byte overflow', () => {
    expect(formatBytesPerSecond(0.5)).toBe('0.5 B/s')
  })
})

describe('getUptimeDays', () => {
  test('floors to whole days', () => {
    expect(getUptimeDays(86_400)).toBe(1)
    expect(getUptimeDays(86_400 * 2.9)).toBe(2)
  })

  test('treats missing, negative and non-finite input as zero', () => {
    expect(getUptimeDays(null)).toBe(0)
    expect(getUptimeDays(undefined)).toBe(0)
    expect(getUptimeDays(-5)).toBe(0)
    expect(getUptimeDays(Number.NaN)).toBe(0)
  })
})

describe('formatUptime', () => {
  test('renders the largest meaningful units', () => {
    expect(formatUptime(0)).toContain('0')
    expect(formatUptime(90)).toContain('分钟')
    expect(formatUptime(86_400)).toContain('天')
  })

  test('respects the requested precision', () => {
    const seconds = 86_400 + 3600 + 60 + 1
    expect(formatUptimeWithFormat(seconds, 'day')).not.toContain('小时')
    expect(formatUptimeWithFormat(seconds, 'hour')).toContain('小时')
    expect(formatUptimeWithFormat(seconds, 'hour')).not.toContain('分钟')
    expect(formatUptimeWithFormat(seconds, 'second')).toContain('秒')
  })
})

describe('calcPercentage', () => {
  test('computes a percentage', () => {
    expect(calcPercentage(50, 200)).toBeCloseTo(25, 5)
  })

  test('returns 0 for an invalid or zero denominator instead of Infinity', () => {
    expect(calcPercentage(5, 0)).toBe(0)
    expect(Number.isFinite(calcPercentage(5, 0))).toBe(true)
  })
})

describe('getStatus', () => {
  test('maps percentages onto semantic tones', () => {
    expect(getStatus(10)).toBe('success')
    expect(getStatus(99)).toBe('error')
  })

  test('returns one of the three known tones for any input', () => {
    for (const value of [-10, 0, 50, 80, 90, 100, 200, Number.NaN])
      expect(['success', 'warning', 'error']).toContain(getStatus(value))
  })
})

describe('formatDateTime', () => {
  test('returns a placeholder for missing input', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDateTime('')).toBe('-')
  })

  test('formats a parseable timestamp', () => {
    // 用本地时间字面量而不是 UTC：dayjs 按本地时区渲染，带 Z 的午夜在 UTC 以西会退到前一天。
    expect(formatDateTime('2026-08-19T12:00:00', 'YYYY-MM-DD')).toBe('2026-08-19')
    expect(formatDateTime('2026-08-19T12:34:56', 'HH:mm:ss')).toBe('12:34:56')
  })
})
