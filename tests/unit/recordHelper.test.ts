import { describe, expect, test } from 'bun:test'
import { cutPeakValues, fillMissingTimePoints, interpolateNullsLinear } from '../../src/utils/recordHelper'

function iso(offsetSeconds: number, base = '2026-08-15T00:00:00.000Z'): string {
  return new Date(new Date(base).getTime() + offsetSeconds * 1000).toISOString()
}

describe('fillMissingTimePoints', () => {
  test('returns an empty array for empty input', () => {
    expect(fillMissingTimePoints([], 10, 180)).toEqual([])
  })

  test('fixed-length mode generates an evenly-spaced window ending at the last point', () => {
    const data = [{ time: iso(0), cpu: 10 }]
    const filled = fillMissingTimePoints(data, 10, 30)
    // 30s window / 10s interval -> 3 points, ending exactly at the last data point.
    expect(filled).toHaveLength(3)
    expect(filled.at(-1)?.time).toBe(iso(0))
    expect(filled[0]?.time).toBe(iso(-20))
  })

  test('variable-length mode (totalSeconds=null) spans from the first to the last data point', () => {
    const data = [{ time: iso(0), cpu: 10 }, { time: iso(40), cpu: 20 }]
    const filled = fillMissingTimePoints(data, 10, null)
    expect(filled[0]?.time).toBe(iso(0))
    expect(filled.at(-1)?.time).toBe(iso(40))
    expect(filled).toHaveLength(5)
  })

  test('matches an existing point within tolerance and aligns it to the grid', () => {
    // grid = [10s, 20s] for a 20s window ending at the 20s sample; the 2s
    // sample is 8s off the 10s grid slot, within the default 10s tolerance.
    const data = [{ time: iso(2), cpu: 10 }, { time: iso(20), cpu: 20 }]
    const filled = fillMissingTimePoints(data, 10, 20)
    const grid10 = filled.find(point => point.time === iso(10))
    expect(grid10?.cpu).toBe(10)
  })

  test('fills a genuinely missing point with a null-valued template, preserving non-numeric fields', () => {
    const data = [{ time: iso(0), client: 'node-a', cpu: 10 }, { time: iso(300), client: 'node-a', cpu: 90 }]
    const filled = fillMissingTimePoints(data, 60, 300, 5)
    const missingPoint = filled.find(point => point.time === iso(180))
    expect(missingPoint?.cpu).toBeNull()
    expect(missingPoint?.client).toBe('node-a')
  })

  test('does not match a point outside the tolerance window', () => {
    const data = [{ time: iso(0), cpu: 10 }, { time: iso(50), cpu: 99 }]
    // Tight 3s tolerance: the point at +50s should not snap onto a nearby 10s-grid slot that isn't within 3s.
    const filled = fillMissingTimePoints(data, 10, 60, 3)
    const grid40 = filled.find(point => point.time === iso(40))
    expect(grid40?.cpu).toBeNull()
  })
})

describe('interpolateNullsLinear', () => {
  test('returns the input unchanged when there are no rows or no keys', () => {
    expect(interpolateNullsLinear([], ['cpu'])).toEqual([])
    expect(interpolateNullsLinear([{ time: iso(0), cpu: 1 }], [])).toEqual([{ time: iso(0), cpu: 1 }])
  })

  test('linearly interpolates a single null gap between two valid points', () => {
    const rows = [
      { time: iso(0), cpu: 0 },
      { time: iso(10), cpu: null },
      { time: iso(20), cpu: 20 },
    ]
    const result = interpolateNullsLinear(rows, ['cpu'], { maxGapMs: 60_000 })
    expect(result[1]?.cpu).toBe(10)
  })

  test('leaves a gap unfilled once it exceeds maxGapMs', () => {
    const rows = [
      { time: iso(0), cpu: 0 },
      { time: iso(30), cpu: null },
      { time: iso(60), cpu: 60 },
    ]
    const result = interpolateNullsLinear(rows, ['cpu'], { maxGapMs: 10_000 })
    expect(result[1]?.cpu).toBeNull()
  })

  test('accepts a bare number as shorthand for { maxGapMs }', () => {
    const rows = [
      { time: iso(0), cpu: 0 },
      { time: iso(10), cpu: null },
      { time: iso(20), cpu: 20 },
    ]
    expect(interpolateNullsLinear(rows, ['cpu'], 60_000)[1]?.cpu).toBe(10)
  })

  test('needs at least two valid points to attempt interpolation for a key', () => {
    const rows = [
      { time: iso(0), cpu: 5 },
      { time: iso(10), cpu: null },
      { time: iso(20), cpu: null },
    ]
    const result = interpolateNullsLinear(rows, ['cpu'], { maxGapMs: 60_000 })
    expect(result[1]?.cpu).toBeNull()
    expect(result[2]?.cpu).toBeNull()
  })

  test('does not extrapolate leading or trailing nulls outside the valid-point span', () => {
    const rows = [
      { time: iso(0), cpu: null },
      { time: iso(10), cpu: 10 },
      { time: iso(20), cpu: 20 },
      { time: iso(30), cpu: null },
    ]
    const result = interpolateNullsLinear(rows, ['cpu'], { maxGapMs: 60_000 })
    expect(result[0]?.cpu).toBeNull()
    expect(result[3]?.cpu).toBeNull()
  })

  test('interpolates each key independently', () => {
    const rows = [
      { time: iso(0), cpu: 0, ram: 100 },
      { time: iso(10), cpu: null, ram: null },
      { time: iso(20), cpu: 10, ram: 200 },
    ]
    const result = interpolateNullsLinear(rows, ['cpu', 'ram'], { maxGapMs: 60_000 })
    expect(result[1]?.cpu).toBe(5)
    expect(result[1]?.ram).toBe(150)
  })
})

describe('cutPeakValues', () => {
  test('returns the input unchanged for empty data', () => {
    const data: Array<{ time: string, cpu: number | null }> = []
    expect(cutPeakValues(data, ['cpu'])).toBe(data)
  })

  test('nulls out a value that spikes far above its neighbors', () => {
    const data = Array.from({ length: 7 }, (_, i) => ({ time: iso(i * 10), cpu: 20 }))
    data[3]!.cpu = 500 // an obvious spike among steady 20s
    const result = cutPeakValues(data, ['cpu'], 0.3, 7, 0.3)
    // The spike should have been detected and replaced (via null -> EWMA fill), landing near the steady baseline rather than 500.
    expect(result[3]?.cpu).not.toBe(500)
    expect(Number(result[3]?.cpu)).toBeLessThan(100)
  })

  test('smooths a steady non-spiking sequence toward the running average without introducing nulls', () => {
    const data = [
      { time: iso(0), cpu: 10 },
      { time: iso(10), cpu: 10 },
      { time: iso(20), cpu: 10 },
    ]
    const result = cutPeakValues(data, ['cpu'], 0.3, 15, 0.3)
    for (const row of result) expect(row.cpu).toBeCloseTo(10)
  })

  test('leaves values before the first valid sample as null', () => {
    const data = [
      { time: iso(0), cpu: null },
      { time: iso(10), cpu: 50 },
    ]
    const result = cutPeakValues(data, ['cpu'], 0.3, 15, 0.3)
    expect(result[0]?.cpu).toBeNull()
    expect(result[1]?.cpu).toBe(50)
  })

  test('forward-fills a hole after a valid sample using the running EWMA', () => {
    const data = [
      { time: iso(0), cpu: 40 },
      { time: iso(10), cpu: null },
    ]
    const result = cutPeakValues(data, ['cpu'], 0.3, 15, 0.3)
    expect(result[1]?.cpu).toBe(40)
  })
})
