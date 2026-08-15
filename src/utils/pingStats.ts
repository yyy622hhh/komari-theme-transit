import type { PingMetricTaskStats, PingRecord } from '@/utils/rpc'

export interface NodePingHistoryPoint {
  time: string
  latency: number | null
  loss: number | null
}

export interface NodePingStatsState {
  avgLatency: number
  avgLoss: number
  avgVolatility: number
  p50Latency: number | null
  p95Latency: number | null
  availability: number | null
  sampleCount: number
  history: NodePingHistoryPoint[]
  hasData: boolean
}

export interface MetricLossPoint {
  time: string
  value: number
  count: number
  taskId: number
}

interface TaskRecordSummary {
  total: number
  success: number
}

const HISTORY_BUCKET_COUNT = 20
const FULL_LOSS_EPSILON = 1e-6
const TASK_FILTER_SEPARATOR_PATTERN = /[\s\-_—–·]+/g

export function createEmptyNodePingStats(): NodePingStatsState {
  return {
    avgLatency: 0,
    avgLoss: 0,
    avgVolatility: 0,
    p50Latency: null,
    p95Latency: null,
    availability: null,
    sampleCount: 0,
    history: [],
    hasData: false,
  }
}

export function normalizePingTaskFilter(value: string): string {
  return value.toLowerCase().replace(TASK_FILTER_SEPARATOR_PATTERN, '')
}

function average(values: number[]): number {
  if (!values.length)
    return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function weightedAverage(values: Array<{ value: number, weight: number }>): number {
  const weightedValues = values.filter(item => item.weight > 0)
  const totalWeight = weightedValues.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight)
    return 0

  return weightedValues.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function summarizeTaskRecords(records: PingRecord[]): Map<number, TaskRecordSummary> {
  const summaries = new Map<number, TaskRecordSummary>()

  for (const record of records) {
    const summary = summaries.get(record.task_id) ?? { total: 0, success: 0 }
    summary.total += 1
    if (record.value >= 0)
      summary.success += 1
    summaries.set(record.task_id, summary)
  }

  return summaries
}

function getIncludedTaskIds(records: PingRecord[]): Set<number> {
  const recordSummaries = summarizeTaskRecords(records)

  return new Set(
    [...recordSummaries.entries()]
      .filter(([, summary]) => summary.total > 0)
      .map(([taskId]) => taskId),
  )
}

function buildPingHistory(records: PingRecord[], metricLossPoints?: MetricLossPoint[]): NodePingHistoryPoint[] {
  const sortedRecords = records
    .map((record) => {
      const timestamp = new Date(record.time).getTime()
      return { ...record, timestamp }
    })
    .filter(record => Number.isFinite(record.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
  const sortedMetricLossPoints = (metricLossPoints ?? [])
    .map(point => ({ ...point, timestamp: new Date(point.time).getTime() }))
    .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value) && point.count > 0)
    .sort((left, right) => left.timestamp - right.timestamp)

  if (!sortedRecords.length && !sortedMetricLossPoints.length)
    return []

  const firstTime = Math.min(
    sortedRecords[0]?.timestamp ?? Number.POSITIVE_INFINITY,
    sortedMetricLossPoints[0]?.timestamp ?? Number.POSITIVE_INFINITY,
  )
  const lastTime = Math.max(
    sortedRecords.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
    sortedMetricLossPoints.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY,
  )
  const bucketCount = Math.min(HISTORY_BUCKET_COUNT, Math.max(sortedRecords.length, sortedMetricLossPoints.length))
  const bucketSize = Math.max(1, (lastTime - firstTime) / bucketCount)

  const history: NodePingHistoryPoint[] = []
  let recordIndex = 0
  let metricLossPointIndex = 0

  for (let index = 0; index < bucketCount; index++) {
    const startTime = firstTime + bucketSize * index
    const endTime = index === bucketCount - 1 ? lastTime + 1 : startTime + bucketSize
    let totalCount = 0
    let lostCount = 0
    let latencySum = 0
    let latencyCount = 0
    let metricLossSum = 0
    let metricLossCount = 0

    while (recordIndex < sortedRecords.length) {
      const record = sortedRecords[recordIndex]
      if (!record || record.timestamp >= endTime)
        break

      if (record.timestamp >= startTime) {
        totalCount += 1
        if (record.value >= 0) {
          latencySum += record.value
          latencyCount += 1
        }
        else {
          lostCount += 1
        }
      }
      recordIndex += 1
    }

    while (metricLossPointIndex < sortedMetricLossPoints.length) {
      const point = sortedMetricLossPoints[metricLossPointIndex]
      if (!point || point.timestamp >= endTime)
        break

      if (point.timestamp >= startTime) {
        metricLossSum += point.value * point.count
        metricLossCount += point.count
      }
      metricLossPointIndex += 1
    }

    history.push({
      time: new Date(startTime).toISOString(),
      latency: latencyCount ? latencySum / latencyCount : null,
      loss: metricLossPoints
        ? (metricLossCount ? metricLossSum / metricLossCount * 100 : null)
        : (totalCount ? lostCount / totalCount * 100 : null),
    })
  }

  return history
}

function getPercentile(values: number[], percentile: number): number | null {
  if (!values.length)
    return null

  const sorted = [...values].sort((left, right) => left - right)
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * percentile))
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lowerValue = sorted[lowerIndex]
  const upperValue = sorted[upperIndex]

  if (lowerValue === undefined || upperValue === undefined)
    return null
  if (lowerIndex === upperIndex)
    return lowerValue

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex)
}

function availabilityFromLoss(loss: number, hasSamples: boolean): number | null {
  return hasSamples ? Math.max(0, Math.min(100, 100 - loss)) : null
}

function metricLossPercent(points?: MetricLossPoint[]): number | null {
  if (!points?.length)
    return null
  return weightedAverage(points.map(point => ({ value: point.value * 100, weight: point.count })))
}

export function buildNodePingStats(
  records: PingRecord[],
  metricStats?: PingMetricTaskStats[],
  metricLossPoints?: MetricLossPoint[],
): NodePingStatsState {
  const statsWithSamples = (metricStats ?? []).filter(stat => stat.total > 0)
  if (statsWithSamples.length) {
    const history = buildPingHistory(records.filter(record => record.value >= 0), metricLossPoints)
    const latencyValues = statsWithSamples
      .flatMap(stat => stat.valid > 0 && isFiniteNumber(stat.avg)
        ? [{ value: stat.avg, weight: stat.valid }]
        : [])
    const latestLatencyValues = statsWithSamples
      .map(stat => stat.latest)
      .filter(isFiniteNumber)
    const lossValues = statsWithSamples
      .filter(stat => !stat.loss_approximate && isFiniteNumber(stat.loss))
      .map(stat => ({ value: stat.loss, weight: stat.total }))
    const volatilityValues = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99_p50_ratio))
      .map(stat => ({ value: stat.p99_p50_ratio!, weight: stat.valid }))

    const metricLoss = metricLossPercent(metricLossPoints)
    const avgLoss = lossValues.length ? weightedAverage(lossValues) : (metricLoss ?? 0)
    const recordLatencies = records
      .map(record => record.value)
      .filter(value => value >= 0 && Number.isFinite(value))
    const p50Values = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p50))
      .map(stat => ({ value: stat.p50!, weight: stat.valid }))
    const p99Values = statsWithSamples
      .filter(stat => stat.valid > 0 && isFiniteNumber(stat.p99))
      .map(stat => ({ value: stat.p99!, weight: stat.valid }))
    const sampleCount = statsWithSamples.reduce((sum, stat) => sum + stat.total, 0)

    return {
      avgLatency: latencyValues.length ? weightedAverage(latencyValues) : average(latestLatencyValues),
      avgLoss,
      avgVolatility: weightedAverage(volatilityValues),
      p50Latency: getPercentile(recordLatencies, 0.5) ?? (p50Values.length ? weightedAverage(p50Values) : null),
      p95Latency: getPercentile(recordLatencies, 0.95) ?? (p99Values.length ? weightedAverage(p99Values) : null),
      availability: availabilityFromLoss(avgLoss, sampleCount > 0),
      sampleCount,
      history,
      hasData: true,
    }
  }

  const includedTaskIds = getIncludedTaskIds(records)

  if (!includedTaskIds.size)
    return createEmptyNodePingStats()

  const filteredRecords = records.filter(record => includedTaskIds.has(record.task_id))
  const history = buildPingHistory(filteredRecords)
  const taskRecords = new Map<number, PingRecord[]>()

  for (const record of filteredRecords) {
    const currentRecords = taskRecords.get(record.task_id) ?? []
    currentRecords.push(record)
    taskRecords.set(record.task_id, currentRecords)
  }

  const latencyValues: number[] = []
  const taskLossValues: number[] = []
  const volatilityValues: number[] = []

  for (const recordsByTask of taskRecords.values()) {
    const validValues = recordsByTask
      .map(record => record.value)
      .filter(value => value >= 0)

    taskLossValues.push((recordsByTask.length - validValues.length) / recordsByTask.length * 100)

    if (!validValues.length)
      continue

    latencyValues.push(average(validValues))

    if (validValues.length > 1) {
      const p50 = getPercentile(validValues, 0.5)
      const p99 = getPercentile(validValues, 0.99)
      if (isFiniteNumber(p50) && isFiniteNumber(p99) && p50 > FULL_LOSS_EPSILON)
        volatilityValues.push(p99 / p50)
    }
  }

  const historyLatencyValues = history
    .map(point => point.latency)
    .filter(isFiniteNumber)
  const historyLossValues = history
    .map(point => point.loss)
    .filter(isFiniteNumber)

  const avgLatency = latencyValues.length ? average(latencyValues) : average(historyLatencyValues)
  const metricLoss = metricLossPercent(metricLossPoints)
  const avgLoss = metricLoss ?? (taskLossValues.length ? average(taskLossValues) : average(historyLossValues))
  const avgVolatility = average(volatilityValues)
  const hasData = history.length > 0 || latencyValues.length > 0 || taskLossValues.length > 0
  const validLatencyValues = filteredRecords
    .map(record => record.value)
    .filter(value => value >= 0 && Number.isFinite(value))

  return {
    avgLatency,
    avgLoss,
    avgVolatility,
    p50Latency: getPercentile(validLatencyValues, 0.5),
    p95Latency: getPercentile(validLatencyValues, 0.95),
    availability: availabilityFromLoss(avgLoss, filteredRecords.length > 0),
    sampleCount: filteredRecords.length,
    history,
    hasData,
  }
}
