import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type { MetricCustomRange } from '@/utils/metricRange'
import type { MetricSeries, PingMetricTaskStats, PingRecord, PingTaskInfo } from '@/utils/rpc'
import dayjs from 'dayjs'
import { ref, shallowRef } from 'vue'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import { loadPingRecordsWithTasks } from '@/services/history.service'
import { loadPingMetricStats, loadPublicPingTasks, queryMetrics } from '@/services/metrics.service'
import {
  isPingMetric,
  normalizeMetricSeriesList,
  orderPingTasksByBackend,
  PING_LATENCY_METRIC,
  pingTaskId,
  pingTaskName,
} from '@/utils/metricSeries'

interface PingChartDataOptions {
  getUuid: () => string
  isCustomRange: ComputedRef<boolean>
  customRange: ComputedRef<MetricCustomRange | null>
  customRangeError: Readonly<Ref<string>>
  appliedCustomRange: ShallowRef<MetricCustomRange | null>
  selectedHours: ComputedRef<number>
  maxPingRecordPreserveTime: ComputedRef<number>
  selectedTaskIds: Ref<number[]>
}

function normalizeMetricTaskId(taskId: string): number {
  if (!taskId.trim())
    return Number.NaN

  const numericTaskId = Number(taskId)
  if (Number.isFinite(numericTaskId))
    return numericTaskId

  let hash = 0
  for (let index = 0; index < taskId.length; index++)
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0
  return Math.abs(hash)
}

function normalizeMetricTask(stat: PingMetricTaskStats): PingTaskInfo {
  return {
    id: normalizeMetricTaskId(stat.task_id),
    name: stat.name?.trim() || pingTaskName(stat) || `Task ${stat.task_id}`,
    interval: stat.interval ?? 0,
    loss: stat.loss,
    min: stat.min,
    max: stat.max,
    avg: stat.avg,
    latest: stat.latest,
    p50: stat.p50,
    p99: stat.p99,
    p99_p50_ratio: stat.p99_p50_ratio,
    stddev: stat.stddev,
    total: stat.total,
    valid: stat.valid,
    loss_approximate: stat.loss_approximate,
    type: stat.type,
  }
}

function buildMetricRecords(seriesList: MetricSeries[]): PingRecord[] {
  const records: PingRecord[] = []
  const normalizedSeriesList = normalizeMetricSeriesList(seriesList).filter(isPingMetric)

  for (const series of normalizedSeriesList) {
    const taskId = normalizeMetricTaskId(pingTaskId(series))
    if (!Number.isFinite(taskId))
      continue

    for (const point of series.points) {
      if (point.value === null)
        continue

      records.push({
        client: series.entity_id,
        task_id: taskId,
        time: point.time,
        value: point.value,
      })
    }
  }

  return records.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf())
}

export function usePingChartData(options: PingChartDataOptions) {
  const remoteData = shallowRef<PingRecord[]>([])
  const tasks = shallowRef<PingTaskInfo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const legacyCustomRangeFallback = ref(false)
  let fetchRecordsSequence = 0

  async function loadMetricPingPayload(nodeUuid: string): Promise<{ records: PingRecord[], tasks: PingTaskInfo[] } | null> {
    const range = options.appliedCustomRange.value
    const metricRangeParams = options.isCustomRange.value && range
      ? { start: range.start.toDate().toISOString(), end: range.end.toDate().toISOString() }
      : { hours: options.selectedHours.value }

    const [statsResult, metricsResult, backendTasksResult] = await Promise.allSettled([
      loadPingMetricStats({ entity_id: nodeUuid, ...metricRangeParams, max_points: PING_RECORD_MAX_COUNT }),
      queryMetrics({
        metric_keys: [PING_LATENCY_METRIC],
        entity_id: nodeUuid,
        ...metricRangeParams,
        downsample: true,
        fill_empty: true,
        max_points: PING_RECORD_MAX_COUNT,
        aggregation: 'avg',
      }),
      loadPublicPingTasks(),
    ])

    const metricStats = statsResult.status === 'fulfilled'
      ? (statsResult.value.stats ?? []).filter(stat => stat.entity_id === nodeUuid)
      : []
    const metricRecords = metricsResult.status === 'fulfilled'
      ? buildMetricRecords(metricsResult.value.series)
      : []

    const metricTaskIds = new Set(metricRecords.map(record => record.task_id))
    const exactStatTaskIds = new Set(
      metricStats
        .filter(stat => stat.total > 0 && !stat.loss_approximate && Number.isFinite(stat.loss))
        .map(stat => normalizeMetricTaskId(stat.task_id)),
    )
    if (!metricRecords.length || [...metricTaskIds].some(taskId => !exactStatTaskIds.has(taskId)))
      return null

    const taskMap = new Map<number, PingTaskInfo>()
    for (const stat of metricStats) {
      const task = normalizeMetricTask(stat)
      taskMap.set(task.id, task)
    }

    const metricSeries = metricsResult.status === 'fulfilled' ? metricsResult.value.series : []
    for (const series of normalizeMetricSeriesList(metricSeries).filter(isPingMetric)) {
      const taskId = normalizeMetricTaskId(pingTaskId(series))
      if (!taskId || taskMap.has(taskId))
        continue

      taskMap.set(taskId, {
        id: taskId,
        name: pingTaskName(series) || `Task ${taskId}`,
        interval: series.interval_seconds ?? 0,
        loss: 0,
      })
    }

    return {
      records: metricRecords,
      tasks: orderPingTasksByBackend(
        [...taskMap.values()],
        backendTasksResult.status === 'fulfilled' ? backendTasksResult.value : [],
      ),
    }
  }

  async function fetchRecords() {
    const sequence = ++fetchRecordsSequence
    const requestedUuid = options.getUuid()
    if (!requestedUuid)
      return

    if (options.isCustomRange.value && !options.customRange.value) {
      remoteData.value = []
      tasks.value = []
      error.value = options.customRangeError.value || '请选择有效的自定义时间范围'
      legacyCustomRangeFallback.value = false
      loading.value = false
      return
    }

    options.appliedCustomRange.value = options.isCustomRange.value ? options.customRange.value : null
    loading.value = true
    error.value = null

    try {
      const metricPayload = await loadMetricPingPayload(requestedUuid).catch(() => null)
      if (sequence !== fetchRecordsSequence || requestedUuid !== options.getUuid())
        return

      legacyCustomRangeFallback.value = !metricPayload && options.isCustomRange.value
      const range = options.appliedCustomRange.value
      const legacyHours = range
        ? Math.min(
            options.maxPingRecordPreserveTime.value,
            Math.max(range.hours, Math.ceil(dayjs().diff(range.start, 'hour', true))),
          )
        : options.selectedHours.value
      const result = metricPayload ?? await loadPingRecordsWithTasks(legacyHours, PING_RECORD_MAX_COUNT, requestedUuid)
      if (sequence !== fetchRecordsSequence || requestedUuid !== options.getUuid())
        return

      result.records.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf())
      remoteData.value = result.records
      tasks.value = result.tasks

      if (tasks.value.length > 0 && options.selectedTaskIds.value.length === 0)
        options.selectedTaskIds.value = tasks.value.map(task => task.id)
    }
    catch (caught) {
      if (sequence !== fetchRecordsSequence || requestedUuid !== options.getUuid())
        return

      error.value = caught instanceof Error ? caught.message : '获取数据失败'
      legacyCustomRangeFallback.value = false
      remoteData.value = []
      tasks.value = []
    }
    finally {
      if (sequence === fetchRecordsSequence)
        loading.value = false
    }
  }

  function invalidate() {
    fetchRecordsSequence += 1
  }

  return {
    remoteData,
    tasks,
    loading,
    error,
    legacyCustomRangeFallback,
    fetchRecords,
    invalidate,
  }
}
