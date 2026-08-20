import type { MaybeRefOrGetter } from 'vue'
import type { NormalizedMetricSeries } from '@/utils/metricSeries'
import type { RecordFormat } from '@/utils/recordHelper'
import type { MetricQueryParams, PingTaskInfo, StatusRecord } from '@/utils/rpc'
import { useIntervalFn } from '@vueuse/core'
import dayjs from 'dayjs'
import { onBeforeUnmount, onMounted, ref, shallowRef, toValue, watch } from 'vue'
import { loadNodeLoadRecords } from '@/composables/useNodeLoadStats'
import { LOAD_RECORD_MAX_COUNT } from '@/constants/load'
import { loadRecentNodeStatus } from '@/services/history.service'
import { loadMetricDefinitions, loadPublicPingTasks, queryMetrics } from '@/services/metrics.service'
import { useNodesStore } from '@/stores/nodes'
import { createAsyncGeneration } from '@/utils/asyncGeneration'
import { LOAD_METRIC_KEYS, metricSeriesToChartRecords, recordHasLoadSample } from '@/utils/loadMetricRecords'
import { normalizeMetricSeriesList } from '@/utils/metricSeries'
import { isRpcPermissionError, RpcError } from '@/utils/rpc'

/**
 * 节点详情负载图的取数层：实时轮询、历史查询、Metric Store 与旧版 records 的
 * 降级，以及三条互相独立的在途请求代次。
 *
 * 从 LoadChart.vue 抽出来的原因是那个组件把取数、归一化和十几张 ECharts 配置
 * 叠在一起，1548 行里真正会出问题的是这一段——切换节点、切换时间范围、实时与
 * 历史来回切时的竞态，都在这里。抽成 composable 之后它不再需要挂载组件就能读懂。
 */

const PING_METRIC_KEYS = ['ping.latency_ms', 'ping.loss'] as const
const METRIC_HISTORY_MAX_POINTS = 700
const REALTIME_METRIC_REFRESH_MS = 30_000

interface MetricHistoryData {
  records: RecordFormat[]
  series: NormalizedMetricSeries[]
}

interface MetricHistoryResult {
  availableKeys: Set<string>
  history: MetricHistoryData | null
}

interface LoadChartRequest {
  generation: number
  uuid: string
}

export interface LoadChartDataOptions {
  uuid: () => string
  isRealtime: () => boolean
  isCustomRange: () => boolean
  customRange: () => { start: dayjs.Dayjs, end: dayjs.Dayjs, hours: number } | null | undefined
  effectiveHistoryHours: () => number
  chartCards: () => readonly string[]
  customRangeError: () => string
  maxRecordPreserveTime: () => number
  pollIntervalMs: MaybeRefOrGetter<number>
}

export function useLoadChartData(options: LoadChartDataOptions) {
  const { uuid, isRealtime, isCustomRange, customRange, effectiveHistoryHours, chartCards, customRangeError, maxRecordPreserveTime } = options
  const nodesStore = useNodesStore()

  const remoteData = shallowRef<StatusRecord[]>([])
  const metricData = shallowRef<RecordFormat[] | null>(null)
  const rawMetricSeries = shallowRef<NormalizedMetricSeries[]>([])
  const availableMetricKeys = shallowRef<Set<string>>(new Set())
  const pingTasks = shallowRef<PingTaskInfo[]>([])
  const loading = ref(false)
  /** 首次加载：实时模式下只有这一轮显示加载态，之后的轮询不该让图闪。 */
  const isInitialLoad = ref(true)
  const error = ref<string | null>(null)

  let lastRealtimeMetricFetchAt = 0
  const dataRequests = createAsyncGeneration()
  const realtimeMetricRequests = createAsyncGeneration()
  const metricCatalogRequests = createAsyncGeneration()

  async function loadMetricCatalog(): Promise<{ availableKeys: Set<string>, tasks: PingTaskInfo[] }> {
    const [definitions, tasks] = await Promise.all([
      loadMetricDefinitions().catch(() => []),
      loadPublicPingTasks().catch(() => []),
    ])
    return {
      availableKeys: new Set(definitions.map(definition => definition.name)),
      tasks,
    }
  }

  async function loadMetricHistoryRecords(
    uuid: string,
    params: Pick<MetricQueryParams, 'hours' | 'start' | 'end'>,
  ): Promise<MetricHistoryResult> {
    const definitions = await loadMetricDefinitions()
    const availableKeys = new Set(definitions.map(definition => definition.name))
    const metricKeys = LOAD_METRIC_KEYS.filter(key => availableKeys.has(key))
    if (!metricKeys.length)
      return { availableKeys, history: null }

    const result = await queryMetrics({
      metric_keys: metricKeys,
      entity_id: uuid,
      ...params,
      downsample: true,
      fill_empty: true,
      max_points: METRIC_HISTORY_MAX_POINTS,
      aggregation: 'avg',
    })

    const series = normalizeMetricSeriesList(result.series)
    if (!series.some(item => item.points.length > 0))
      return { availableKeys, history: null }

    return {
      availableKeys,
      history: {
        records: metricSeriesToChartRecords(result.series, {
          uuid,
          memoryTotal: nodesStore.nodesByUuid.get(uuid)?.mem_total,
          swapTotal: nodesStore.nodesByUuid.get(uuid)?.swap_total,
          diskTotal: nodesStore.nodesByUuid.get(uuid)?.disk_total,
        }),
        series,
      },
    }
  }

  async function refreshRealtimeMetricSeries(force = false): Promise<void> {
    const cards = chartCards()
    if (!cards.includes('ping') && !cards.includes('pingLoss')) {
      realtimeMetricRequests.invalidate()
      rawMetricSeries.value = []
      return
    }

    const now = Date.now()
    if (!force && now - lastRealtimeMetricFetchAt < REALTIME_METRIC_REFRESH_MS)
      return
    lastRealtimeMetricFetchAt = now
    const requestedUuid = uuid()
    const generation = realtimeMetricRequests.begin()

    try {
      let metricKeysCatalog = availableMetricKeys.value
      if (!metricKeysCatalog.size) {
        const catalog = await loadMetricCatalog()
        if (!realtimeMetricRequests.isCurrent(generation))
          return
        availableMetricKeys.value = catalog.availableKeys
        pingTasks.value = catalog.tasks
        metricKeysCatalog = catalog.availableKeys
      }

      const metricKeys = PING_METRIC_KEYS.filter(key => metricKeysCatalog.has(key))
      if (!metricKeys.length) {
        if (realtimeMetricRequests.isCurrent(generation))
          rawMetricSeries.value = []
        return
      }

      const result = await queryMetrics({
        metric_keys: [...metricKeys],
        entity_id: requestedUuid,
        hours: 1,
        downsample: true,
        fill_empty: true,
        max_points: 150,
        aggregation: 'avg',
      })
      if (!realtimeMetricRequests.isCurrent(generation) || !isRealtime() || uuid() !== requestedUuid)
        return
      rawMetricSeries.value = normalizeMetricSeriesList(result.series)
    }
    catch {
      if (realtimeMetricRequests.isCurrent(generation) && isRealtime() && uuid() === requestedUuid)
        rawMetricSeries.value = []
    }
  }

  async function fetchRecentData(request: LoadChartRequest): Promise<void> {
    metricData.value = null
    void refreshRealtimeMetricSeries()

    // 只在首次加载时显示 loading
    if (isInitialLoad.value) {
      loading.value = true
    }
    error.value = null

    try {
      const records = await loadRecentNodeStatus(request.uuid, 150)
      if (dataRequests.isCurrent(request.generation))
        remoteData.value = records
    }
    catch (err) {
      if (dataRequests.isCurrent(request.generation)) {
        error.value = err instanceof Error ? err.message : '获取数据失败'
        remoteData.value = []
      }
    }
    finally {
      if (dataRequests.isCurrent(request.generation)) {
        loading.value = false
        isInitialLoad.value = false
      }
    }
  }

  function sliceTimedRecordsToCustomRange<T extends { time?: string }>(records: T[]): T[] {
    const range = customRange()
    if (!isCustomRange() || !range)
      return records
    const fromTs = range.start.valueOf()
    const toTs = range.end.valueOf()
    return records.filter((record) => {
      const timestamp = dayjs(record.time ?? '').valueOf()
      return timestamp >= fromTs && timestamp <= toTs
    })
  }

  async function fetchHistoryData(request: LoadChartRequest): Promise<void> {
    if (isCustomRange() && !customRange()) {
      realtimeMetricRequests.invalidate()
      metricData.value = null
      rawMetricSeries.value = []
      remoteData.value = []
      loading.value = false
      error.value = customRangeError() || '请选择有效的自定义时间范围'
      return
    }

    const range = customRange()
    const hours = effectiveHistoryHours()
    const metricParams: Pick<MetricQueryParams, 'hours' | 'start' | 'end'> = isCustomRange() && range
      ? { start: range.start.toDate().toISOString(), end: range.end.toDate().toISOString() }
      : { hours }
    const legacyHours = range
      ? Math.min(
          maxRecordPreserveTime(),
          Math.max(hours, Math.ceil(dayjs().diff(range.start, 'hour', true))),
        )
      : hours

    loading.value = true
    error.value = null

    try {
      let metricResult: MetricHistoryResult | null = null
      try {
        metricResult = await loadMetricHistoryRecords(request.uuid, metricParams)
      }
      catch (metricError) {
        // Metric Store is optional on older Komari versions. Only use the
        // legacy load-record route for compatibility failures; never conceal an
        // expired session or a cancelled request by starting a second request.
        const compatibilityFailure = metricError instanceof RpcError
          && (metricError.code === -32601 || metricError.code === 404 || metricError.code === 405)
        if (!compatibilityFailure || isRpcPermissionError(metricError))
          throw metricError
      }
      if (!dataRequests.isCurrent(request.generation))
        return

      if (metricResult)
        availableMetricKeys.value = metricResult.availableKeys
      const metricHistory = metricResult?.history ?? null
      const hasLoadHistory = metricHistory?.records.some(recordHasLoadSample) ?? false
      if (metricHistory && hasLoadHistory) {
        metricData.value = sliceTimedRecordsToCustomRange(metricHistory.records)
        rawMetricSeries.value = metricHistory.series
        remoteData.value = []
      }
      else {
        const records = await loadNodeLoadRecords(request.uuid, legacyHours, LOAD_RECORD_MAX_COUNT)
        if (!dataRequests.isCurrent(request.generation))
          return
        metricData.value = null
        rawMetricSeries.value = metricHistory?.series ?? []
        remoteData.value = sliceTimedRecordsToCustomRange(records)
      }
    }
    catch (err) {
      if (dataRequests.isCurrent(request.generation)) {
        error.value = err instanceof Error ? err.message : '获取数据失败'
        remoteData.value = []
        metricData.value = null
        rawMetricSeries.value = []
      }
    }
    finally {
      if (dataRequests.isCurrent(request.generation))
        loading.value = false
    }
  }

  async function fetchData(): Promise<void> {
    const request: LoadChartRequest = {
      generation: dataRequests.begin(),
      uuid: uuid(),
    }
    if (!request.uuid) {
      realtimeMetricRequests.invalidate()
      remoteData.value = []
      metricData.value = null
      rawMetricSeries.value = []
      loading.value = false
      return
    }

    if (isRealtime()) {
      await fetchRecentData(request)
    }
    else {
      realtimeMetricRequests.invalidate()
      await fetchHistoryData(request)
    }
  }

  const { pause: pauseRealtimeUpdate, resume: resumeRealtimeUpdate } = useIntervalFn(
    () => fetchData(),
    () => toValue(options.pollIntervalMs),
    { immediate: false },
  )

  watch(isRealtime, realtime => (realtime ? resumeRealtimeUpdate() : pauseRealtimeUpdate()), { immediate: true })

  watch(chartCards, () => {
    if (isRealtime()) {
      lastRealtimeMetricFetchAt = 0
      void refreshRealtimeMetricSeries(true)
    }
  })

  watch(uuid, () => {
    remoteData.value = []
    metricData.value = null
    rawMetricSeries.value = []
    lastRealtimeMetricFetchAt = 0
    isInitialLoad.value = true
    void fetchData()
  })

  /** 切换视图、点「应用」自定义范围或从错误里重试时重新取数，并让加载态重新显示一次。 */
  function reload(): void {
    isInitialLoad.value = true
    void fetchData()
  }

  onMounted(() => {
    const catalogGeneration = metricCatalogRequests.begin()
    void loadMetricCatalog().then((catalog) => {
      if (!metricCatalogRequests.isCurrent(catalogGeneration))
        return
      availableMetricKeys.value = catalog.availableKeys
      pingTasks.value = catalog.tasks
    })
    void fetchData()
  })

  onBeforeUnmount(() => {
    pauseRealtimeUpdate()
    dataRequests.dispose()
    realtimeMetricRequests.dispose()
    metricCatalogRequests.dispose()
  })

  return {
    remoteData,
    metricData,
    rawMetricSeries,
    pingTasks,
    loading,
    error,
    fetchData,
    reload,
  }
}
