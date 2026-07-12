import type { StatusRecord } from '@/utils/rpc'
import { LOAD_CONFIG } from '@/constants/load'
import { TIME_MS } from '@/constants/time'

export interface NodeDiskPrediction {
  daysUntilFull: number
  dailyGrowthBytes: number
  currentDiskBytes: number
  diskTotalBytes: number
  sampleDays: number
  confidence: number
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function buildDiskPrediction(records: readonly StatusRecord[], fallbackDiskTotal = 0): NodeDiskPrediction | null {
  const samples = records
    .map((record) => {
      const timestamp = new Date(record.time).getTime()
      const disk = numberOrZero(record.disk)
      const diskTotal = numberOrZero(record.disk_total) || fallbackDiskTotal
      return { timestamp, disk, diskTotal }
    })
    .filter(sample => Number.isFinite(sample.timestamp) && sample.disk > 0 && sample.diskTotal > 0)
    .sort((left, right) => left.timestamp - right.timestamp)

  if (samples.length < 2)
    return null

  const first = samples[0]
  const latest = samples.at(-1)
  if (!first || !latest)
    return null

  const sampleDays = (latest.timestamp - first.timestamp) / TIME_MS.day
  if (sampleDays < LOAD_CONFIG.diskPrediction.minSampleDays)
    return null

  const xs = samples.map(sample => (sample.timestamp - first.timestamp) / TIME_MS.day)
  const ys = samples.map(sample => sample.disk)
  const avgX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const avgY = ys.reduce((sum, value) => sum + value, 0) / ys.length

  let numerator = 0
  let denominator = 0
  let totalVariance = 0
  for (let index = 0; index < samples.length; index++) {
    const x = xs[index] ?? 0
    const y = ys[index] ?? 0
    numerator += (x - avgX) * (y - avgY)
    denominator += (x - avgX) ** 2
    totalVariance += (y - avgY) ** 2
  }

  if (denominator <= 0)
    return null

  const dailyGrowthBytes = numerator / denominator
  if (!Number.isFinite(dailyGrowthBytes) || dailyGrowthBytes <= 0)
    return null

  const diskTotalBytes = latest.diskTotal || fallbackDiskTotal
  const currentDiskBytes = latest.disk
  const remainingBytes = diskTotalBytes - currentDiskBytes
  if (remainingBytes <= 0) {
    return {
      daysUntilFull: 0,
      dailyGrowthBytes,
      currentDiskBytes,
      diskTotalBytes,
      sampleDays,
      confidence: 1,
    }
  }

  let residualVariance = 0
  for (let index = 0; index < samples.length; index++) {
    const x = xs[index] ?? 0
    const y = ys[index] ?? 0
    const predicted = avgY + dailyGrowthBytes * (x - avgX)
    residualVariance += (y - predicted) ** 2
  }

  const confidence = totalVariance <= 0
    ? 0
    : Math.min(Math.max(1 - residualVariance / totalVariance, 0), 1)

  return {
    daysUntilFull: remainingBytes / dailyGrowthBytes,
    dailyGrowthBytes,
    currentDiskBytes,
    diskTotalBytes,
    sampleDays,
    confidence,
  }
}
