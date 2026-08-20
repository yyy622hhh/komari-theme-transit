import type { StatusRecord } from '../../src/utils/rpc'
import { describe, expect, test } from 'bun:test'
import { analyzeDiskPrediction, buildDiskPrediction } from '../../src/services/prediction.service'

const GIB = 1024 ** 3
const DAY_MS = 24 * 60 * 60 * 1000
const START = Date.parse('2026-08-01T00:00:00Z')

function record(dayOffset: number, diskGib: number, totalGib: number | null = 100): StatusRecord {
  return {
    client: 'node-1',
    time: new Date(START + dayOffset * DAY_MS).toISOString(),
    disk: diskGib * GIB,
    ...(totalGib === null ? {} : { disk_total: totalGib * GIB }),
  } as StatusRecord
}

/** 一条每天涨 1 GiB 的干净直线，覆盖 minSampleDays（2 天）。 */
function linearGrowth(days = 5, perDayGib = 1, startGib = 10): StatusRecord[] {
  return Array.from({ length: days }, (_, index) => record(index, startGib + index * perDayGib))
}

describe('analyzeDiskPrediction unavailable reasons', () => {
  test('reports no_samples when nothing usable came back', () => {
    expect(analyzeDiskPrediction([])).toEqual({ prediction: null, reason: 'no_samples', sampleDays: 0, sampleCount: 0 })
  })

  test('treats a zero or missing disk total as unusable rather than dividing by it', () => {
    // disk_total 缺失且没有兜底值时不能当成「磁盘容量为 0」，否则会算出立刻写满。
    const state = analyzeDiskPrediction([record(0, 10, null), record(1, 11, null), record(3, 13, null)])
    expect(state.prediction).toBeNull()
    expect(state.reason).toBe('no_samples')
  })

  test('uses the fallback total when the samples carry none', () => {
    const state = analyzeDiskPrediction(
      [record(0, 10, null), record(1, 11, null), record(3, 13, null)],
      100 * GIB,
    )
    expect(state.prediction?.diskTotalBytes).toBe(100 * GIB)
  })

  test('needs more than one sample', () => {
    const state = analyzeDiskPrediction([record(0, 10)])
    expect(state).toMatchObject({ prediction: null, reason: 'insufficient_samples', sampleCount: 1 })
  })

  test('needs a long enough window, not just enough points', () => {
    // 一小时内的 20 个点足够多，但外推一年份的趋势没有意义。
    const dense = Array.from({ length: 20 }, (_, index) => record(index / 24 / 20, 10 + index * 0.01))
    const state = analyzeDiskPrediction(dense)
    expect(state).toMatchObject({ prediction: null, reason: 'insufficient_duration' })
    expect(state.sampleCount).toBe(20)
  })

  test('reports no_growth for a flat or shrinking disk instead of predicting a past date', () => {
    expect(analyzeDiskPrediction([record(0, 10), record(2, 10), record(4, 10)]).reason).toBe('no_growth')
    expect(analyzeDiskPrediction([record(0, 30), record(2, 20), record(4, 10)]).reason).toBe('no_growth')
  })

  test('samples arriving out of order are sorted before the fit', () => {
    const shuffled = [record(4, 14), record(0, 10), record(2, 12)]
    expect(analyzeDiskPrediction(shuffled).prediction?.dailyGrowthBytes).toBeCloseTo(GIB, -3)
  })
})

describe('analyzeDiskPrediction fit', () => {
  test('recovers the growth rate and days remaining from a clean line', () => {
    const state = analyzeDiskPrediction(linearGrowth())
    expect(state.prediction).not.toBeNull()
    expect(state.prediction!.dailyGrowthBytes).toBeCloseTo(GIB, -3)
    // 第 5 天用掉 14 GiB，剩 86 GiB，每天 1 GiB。
    expect(state.prediction!.currentDiskBytes).toBe(14 * GIB)
    expect(state.prediction!.daysUntilFull).toBeCloseTo(86, 5)
    expect(state.prediction!.confidence).toBeCloseTo(1, 5)
    expect(state.sampleDays).toBeCloseTo(4, 5)
  })

  test('a noisy series still predicts, but with lower confidence', () => {
    const noisy = [record(0, 10), record(1, 30), record(2, 12), record(3, 40), record(4, 14)]
    const clean = analyzeDiskPrediction(linearGrowth()).prediction!
    const state = analyzeDiskPrediction(noisy).prediction!
    expect(state.confidence).toBeLessThan(clean.confidence)
    expect(state.confidence).toBeGreaterThanOrEqual(0)
    expect(state.confidence).toBeLessThanOrEqual(1)
  })

  test('an already-full disk reports zero days rather than a negative countdown', () => {
    const full = [record(0, 96), record(2, 98), record(4, 100)]
    expect(analyzeDiskPrediction(full).prediction).toMatchObject({ daysUntilFull: 0, confidence: 1 })
  })

  test('a growing disk whose total also grows uses the latest total', () => {
    const resized = [record(0, 10, 100), record(2, 12, 100), record(4, 14, 200)]
    expect(analyzeDiskPrediction(resized).prediction?.diskTotalBytes).toBe(200 * GIB)
  })

  test('unparsable timestamps are dropped instead of poisoning the fit', () => {
    const broken = { client: 'node-1', time: 'not-a-date', disk: 99 * GIB, disk_total: 100 * GIB } as StatusRecord
    const state = analyzeDiskPrediction([...linearGrowth(), broken])
    expect(state.sampleCount).toBe(5)
    expect(state.prediction!.dailyGrowthBytes).toBeCloseTo(GIB, -3)
  })
})

describe('buildDiskPrediction', () => {
  test('is the prediction of analyzeDiskPrediction and nothing else', () => {
    const records = linearGrowth()
    expect(buildDiskPrediction(records)).toEqual(analyzeDiskPrediction(records).prediction)
    expect(buildDiskPrediction([])).toBeNull()
  })
})
