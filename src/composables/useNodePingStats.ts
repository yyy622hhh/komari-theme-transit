import type { MaybeRefOrGetter } from 'vue'
import type { PingTaskNameMatch } from '@/services/nodePingRecords.shared'
import type { NodePingStatsState } from '@/utils/pingStats'
import type { TopologyInsightPoint } from '@/utils/topologyInsights'
import { useThrottleFn } from '@vueuse/core'
import { computed, onScopeDispose, ref, toValue, watch } from 'vue'
import { PING_RECORD_MAX_COUNT } from '@/constants/load'
import {
  collectNodePingTaskIds,
  getSharedPingRecordsEntry,
  getSharedPingRecordsKey,
  loadSharedPingRecords,
  matchesTaskName,
  normalizeMaxCount,
  normalizeTaskId,
  normalizeTaskNameFilter,
  PING_RECORD_REFRESH_INTERVAL_MS,
  pingFreshnessGraceUntil,
  pingFreshnessTick,
  resolveExactMatchingTaskIds,
  retainSharedPingRecordsEntry,
} from '@/services/nodePingRecords.shared'
import { readStatsCache, writeStatsCache } from '@/services/nodePingStatsCache'
import { resolvePingFreshness } from '@/utils/pingFreshness'
import { buildNodePingStats, createEmptyNodePingStats } from '@/utils/pingStats'
import { buildTopologyInsightPoints } from '@/utils/topologyInsights'

export { buildPingMetricState, collectNodePingTaskIds, pickPreferredExactPingTaskId } from '@/services/nodePingRecords.shared'

function latestMatchingSampleAt(sampleUpdatedAtByTaskId: ReadonlyMap<number, number>, taskIds: ReadonlySet<number>): number {
  let latest = 0
  for (const taskId of taskIds)
    latest = Math.max(latest, sampleUpdatedAtByTaskId.get(taskId) ?? 0)
  return latest
}

export function useNodePingStats(
  uuid: MaybeRefOrGetter<string>,
  options?: {
    hours?: MaybeRefOrGetter<number>
    enabled?: MaybeRefOrGetter<boolean>
    maxCount?: MaybeRefOrGetter<number | undefined>
    taskNameFilter?: MaybeRefOrGetter<string>
    taskNameMatch?: MaybeRefOrGetter<PingTaskNameMatch>
  },
) {
  const loading = ref(false)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    const taskNameFilter = toValue(options?.taskNameFilter)?.trim() ?? ''
    const requestedMatch = toValue(options?.taskNameMatch)
    const taskNameMatch: PingTaskNameMatch = requestedMatch === 'exact' || requestedMatch === 'normalized-exact'
      ? requestedMatch
      : 'contains'
    return {
      uuid: toValue(uuid),
      hours,
      maxCount,
      cacheKey: getSharedPingRecordsKey(hours, maxCount, toValue(uuid)),
      taskNameFilter,
      taskNameMatch,
      enabled: toValue(options?.enabled) ?? true,
    }
  })

  let activeCacheKey: string | null = null
  let releaseSharedRecords: (() => void) | null = null

  function syncSharedRecordsSubscription(hours: number | null, maxCount?: number, uuid?: string): void {
    const cacheKey = hours === null ? null : getSharedPingRecordsKey(hours, maxCount, uuid)
    if (activeCacheKey === cacheKey)
      return

    releaseSharedRecords?.()
    releaseSharedRecords = null
    activeCacheKey = null

    if (hours === null)
      return

    releaseSharedRecords = retainSharedPingRecordsEntry(hours, maxCount, uuid)
    activeCacheKey = cacheKey
  }

  onScopeDispose(() => {
    syncSharedRecordsSubscription(null)
  })

  // 同时派生统计值和真实样本时间。请求成功时间只负责调度下一次请求，不能用来
  // 判断监控数据是否新鲜，否则后端重复返回旧样本时会永久显示为正常。
  const resolvedStats = computed<{
    stats: NodePingStatsState
    insightPoints: TopologyInsightPoint[]
    taskId: number | null
    taskName: string
    sampleUpdatedAt: number
    source: 'live' | 'cache' | 'empty'
  }>(() => {
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return { stats: createEmptyNodePingStats(), insightPoints: [], taskId: null, taskName: '', sampleUpdatedAt: 0, source: 'empty' }

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state) {
      // 网络不可用时仍按分钟检查缓存的真实样本时间；缓存自身不会因此被重新写入。
      void pingFreshnessTick.value
      const cached = readStatsCache(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch)
      return cached
        ? { stats: cached.stats, insightPoints: [], taskId: null, taskName: '', sampleUpdatedAt: cached.sampleUpdatedAt, source: 'cache' }
        : { stats: createEmptyNodePingStats(), insightPoints: [], taskId: null, taskName: '', sampleUpdatedAt: 0, source: 'empty' }
    }

    const normalizedFilter = normalizeTaskNameFilter(taskNameFilter, taskNameMatch)
    const nodeTaskIds = collectNodePingTaskIds(
      nodeUuid,
      state.recordsByClient.get(nodeUuid) ?? [],
      state.metricStats,
      state.metricLossPoints,
      state.taskClientsById,
    )
    const matchingTaskIds = resolveExactMatchingTaskIds(
      normalizedFilter
        ? new Set([...state.taskNamesById.entries()]
            .filter(([taskId, name]) => nodeTaskIds.has(taskId) && matchesTaskName(name, normalizedFilter, taskNameMatch))
            .map(([taskId]) => taskId))
        : null,
      taskNameMatch,
      state.metricStats,
      state.recordsByClient.get(nodeUuid) ?? [],
    )
    const records = (state.recordsByClient.get(nodeUuid) ?? [])
      .filter(record => !matchingTaskIds || matchingTaskIds.has(record.task_id))
    const metricStats = state.metricStats?.filter(stat => !matchingTaskIds || matchingTaskIds.has(normalizeTaskId(stat.task_id)))
    const metricLossPoints = state.metricLossPoints?.filter(point => !matchingTaskIds || matchingTaskIds.has(point.taskId))
    const stats = records.length || metricStats?.length
      ? buildNodePingStats(records, metricStats, metricLossPoints)
      : createEmptyNodePingStats()
    const sampleTaskIds = matchingTaskIds ?? nodeTaskIds
    const selectedTaskId = matchingTaskIds?.size === 1 ? [...matchingTaskIds][0]! : null
    return {
      stats,
      insightPoints: selectedTaskId === null
        ? []
        : buildTopologyInsightPoints(records, metricLossPoints, new Set([selectedTaskId]), maxCount ?? 240),
      taskId: selectedTaskId,
      taskName: selectedTaskId === null ? '' : state.taskNamesById.get(selectedTaskId) ?? taskNameFilter,
      sampleUpdatedAt: latestMatchingSampleAt(state.sampleUpdatedAtByTaskId, sampleTaskIds),
      source: 'live',
    }
  })
  const stats = computed<NodePingStatsState>(() => resolvedStats.value.stats)

  const taskNames = computed<string[]>(() => {
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return []

    const state = getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value
    if (!state)
      return []

    const normalizedFilter = normalizeTaskNameFilter(taskNameFilter, taskNameMatch)
    const nodeTaskIds = collectNodePingTaskIds(
      nodeUuid,
      state.recordsByClient.get(nodeUuid) ?? [],
      state.metricStats,
      state.metricLossPoints,
      state.taskClientsById,
    )
    return [...new Set([...state.taskNamesById.entries()]
      .filter(([taskId, name]) => nodeTaskIds.has(taskId) && matchesTaskName(name, normalizedFilter, taskNameMatch))
      .map(([, name]) => name))]
  })

  const lastFetchedAt = computed(() => {
    return resolvedStats.value.sampleUpdatedAt
  })

  const freshness = computed(() => resolvePingFreshness(
    lastFetchedAt.value,
    pingFreshnessTick.value,
    { hasData: stats.value.hasData, graceUntil: pingFreshnessGraceUntil.value },
  ))
  const delayed = computed(() => freshness.value === 'delayed')
  const stale = computed(() => freshness.value === 'stale')
  const freshnessAgeMs = computed(() => Math.max(0, pingFreshnessTick.value - lastFetchedAt.value))

  const error = computed<string | null>(() => {
    const { uuid: nodeUuid, hours, maxCount, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return null
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    return entry.error.value ?? null
  })

  // 副作用：按需触发首次共享加载并维护 loading/error，不再命令式写入 stats。
  watch(
    resolved,
    async (next, _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })

      const { uuid: nodeUuid, hours, maxCount, enabled } = next
      if (!enabled || !nodeUuid.trim()) {
        syncSharedRecordsSubscription(null)
        loading.value = false
        return
      }

      syncSharedRecordsSubscription(hours, maxCount, nodeUuid)
      const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
      const shouldLoadRecords = !entry.data.value
        || Date.now() - entry.lastFetchedAt >= PING_RECORD_REFRESH_INTERVAL_MS

      if (!shouldLoadRecords) {
        loading.value = false
        return
      }

      const shouldShowLoading = !entry.data.value
      loading.value = shouldShowLoading

      try {
        await loadSharedPingRecords(entry, hours, maxCount, nodeUuid)
      }
      catch {}
      finally {
        if (!cancelled)
          loading.value = false
      }
    },
    { immediate: true },
  )

  // 共享记录会定时刷新，节流回写 localStorage，避免多节点同时重算时密集写盘。
  const persistStats = useThrottleFn(
    (nodeUuid: string, hours: number, maxCount: number | undefined, taskNameFilter: string, taskNameMatch: PingTaskNameMatch, value: NodePingStatsState, sampleUpdatedAt: number) => {
      writeStatsCache(nodeUuid, hours, maxCount, value, sampleUpdatedAt, taskNameFilter, taskNameMatch)
    },
    30_000,
    true,
    true,
  )

  watch(resolvedStats, (value) => {
    if (value.source !== 'live' || !value.stats.hasData || value.sampleUpdatedAt <= 0)
      return
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, enabled } = resolved.value
    if (enabled && nodeUuid.trim())
      persistStats(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, value.stats, value.sampleUpdatedAt)
  })

  return {
    stats,
    loading,
    error,
    history: computed(() => stats.value.history),
    avgLatency: computed(() => stats.value.avgLatency),
    avgLoss: computed(() => stats.value.avgLoss),
    avgVolatility: computed(() => stats.value.avgVolatility),
    p50Latency: computed(() => stats.value.p50Latency),
    p95Latency: computed(() => stats.value.p95Latency),
    availability: computed(() => stats.value.availability),
    sampleCount: computed(() => stats.value.sampleCount),
    hasData: computed(() => stats.value.hasData),
    hasLatencyData: computed(() => stats.value.hasLatencyData),
    lastFetchedAt,
    freshnessAgeMs,
    freshness,
    delayed,
    stale,
    taskNames,
    insightPoints: computed(() => resolvedStats.value.insightPoints),
    selectedTaskId: computed(() => resolvedStats.value.taskId),
    selectedTaskName: computed(() => resolvedStats.value.taskName),
  }
}

export type ChinaCarrierKey = 'unicom' | 'telecom' | 'mobile'
export type { NodePingHistoryPoint, NodePingStatsState } from '@/utils/pingStats'

interface NodeCarrierPingOptions {
  hours?: MaybeRefOrGetter<number>
  enabled?: MaybeRefOrGetter<boolean>
  maxCount?: MaybeRefOrGetter<number | undefined>
  taskNameFilter?: MaybeRefOrGetter<string>
}

const CHINA_CARRIERS = [
  { key: 'unicom', labelZh: '联通', labelEn: 'Unicom' },
  { key: 'telecom', labelZh: '电信', labelEn: 'Telecom' },
  { key: 'mobile', labelZh: '移动', labelEn: 'Mobile' },
] as const
const CHINA_CARRIER_REGIONS = ['北京', '上海', '广东'] as const

function averageAvailable(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null
}

/** “全部地区”先分别精确选出三个地区的新任务，再汇总，避免迁移期混入旧 ID。 */
export function mergeCarrierPingStats(states: readonly NodePingStatsState[]): NodePingStatsState {
  const usable = states.filter(state => state.hasData)
  if (!usable.length)
    return createEmptyNodePingStats()
  const sampleCount = usable.reduce((sum, state) => sum + state.sampleCount, 0)
  const weighted = (read: (state: NodePingStatsState) => number): number => sampleCount > 0
    ? usable.reduce((sum, state) => sum + read(state) * state.sampleCount, 0) / sampleCount
    : 0
  const historyLength = Math.max(...usable.map(state => state.history.length), 0)
  const history = Array.from({ length: historyLength }, (_, index) => {
    const points = usable.flatMap((state) => {
      const point = state.history[state.history.length - historyLength + index]
      return point ? [point] : []
    })
    const timestamps = points.map(point => Date.parse(point.time)).filter(Number.isFinite)
    return {
      time: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : points[0]?.time ?? new Date(0).toISOString(),
      latency: averageAvailable(points.map(point => point.latency)),
      loss: averageAvailable(points.map(point => point.loss)),
    }
  })
  return {
    avgLatency: weighted(state => state.avgLatency),
    avgLoss: weighted(state => state.avgLoss),
    lineLoss: weighted(state => state.lineLoss),
    commonModeLossEvents: usable.reduce((sum, state) => sum + state.commonModeLossEvents, 0),
    avgVolatility: weighted(state => state.avgVolatility),
    p50Latency: averageAvailable(usable.map(state => state.p50Latency)),
    p95Latency: averageAvailable(usable.map(state => state.p95Latency)),
    availability: averageAvailable(usable.map(state => state.availability)),
    sampleCount,
    history,
    hasData: true,
    hasLatencyData: usable.some(state => state.hasLatencyData),
  }
}

export function useNodeCarrierPingStats(uuid: MaybeRefOrGetter<string>, options?: NodeCarrierPingOptions) {
  const carrierPings = CHINA_CARRIERS.map((carrier) => {
    const regionalPings = CHINA_CARRIER_REGIONS.map((region) => {
      const selectedRegion = computed(() => toValue(options?.taskNameFilter)?.trim() ?? '')
      const enabled = computed(() => (toValue(options?.enabled) ?? true) && (!selectedRegion.value || selectedRegion.value === region))
      return useNodePingStats(uuid, {
        hours: options?.hours,
        enabled,
        maxCount: options?.maxCount,
        taskNameFilter: `${region}${carrier.labelZh}`,
        taskNameMatch: 'normalized-exact',
      })
    })
    return {
      ...carrier,
      regionalPings,
    }
  })

  return {
    carriers: computed(() => carrierPings.map((carrier) => {
      const active = carrier.regionalPings.filter(ping => ping.hasData.value || ping.loading.value || ping.error.value || ping.taskNames.value.length)
      const stats = mergeCarrierPingStats(active.map(ping => ping.stats.value))
      return {
        key: carrier.key,
        labelZh: carrier.labelZh,
        labelEn: carrier.labelEn,
        taskNames: [...new Set(active.flatMap(ping => ping.taskNames.value))],
        stats,
        hasLatency: stats.hasLatencyData,
        delayed: active.some(ping => ping.delayed.value),
        stale: active.length > 0 && active.every(ping => ping.stale.value),
      }
    })),
    loading: computed(() => carrierPings.some(carrier => carrier.regionalPings.some(ping => ping.loading.value))),
    error: computed(() => carrierPings.flatMap(carrier => carrier.regionalPings.map(ping => ping.error.value)).find(Boolean) ?? null),
    lastFetchedAt: computed(() => Math.max(...carrierPings.flatMap(carrier => carrier.regionalPings.map(ping => ping.lastFetchedAt.value)), 0)),
    freshnessAgeMs: computed(() => Math.max(...carrierPings.flatMap(carrier => carrier.regionalPings.map(ping => ping.freshnessAgeMs.value)), 0)),
    delayed: computed(() => carrierPings.some(carrier => carrier.regionalPings.some(ping => ping.delayed.value))),
    stale: computed(() => {
      const active = carrierPings.flatMap(carrier => carrier.regionalPings)
        .filter(ping => ping.hasData.value || ping.loading.value || ping.error.value || ping.taskNames.value.length)
      return active.length > 0 && active.every(ping => ping.stale.value)
    }),
  }
}
