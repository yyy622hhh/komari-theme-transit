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
import {
  filterMetricLossToCurrentEpoch,
  filterPingRecordsToCurrentEpoch,
  pingTaskEpochRevision,
  pingTaskEpochStartedAt,
} from '@/services/ping-task-epoch.service'
import { mergeCarrierPingHistory } from '@/utils/carrierPingHistory'
import { mergeProbeCurrentStates, resolveProbeCurrentState } from '@/utils/pingCurrentState'
import { resolvePingFreshness } from '@/utils/pingFreshness'
import { buildNodePingStats, createEmptyNodePingStats } from '@/utils/pingStats'
import { buildTopologyInsightPoints } from '@/utils/topologyInsights'

export { buildPingMetricState, collectNodePingTaskIds, pickPreferredExactPingTaskId } from '@/services/nodePingRecords.shared'

/**
 * 严格匹配，类型未知时不算命中。
 *
 * `taskType` 目前没有任何调用方在用——三网卡片曾经靠它把统计限定在 ICMP，
 * 但那样会让还没迁移到 ICMP 的站点三网卡片直接消失，已经改回不按类型过滤
 * （见 `useNodeCarrierPingStats`），协议区分交给展示层的 `probeFailureRateLabel`
 * 之类的函数按实际 `probeType` 动态措辞。这里保留严格匹配是为未来可能的调用方
 * 定基调：类型缺失时宁可判不中，也不能让「未知」悄悄冒充成某个具体协议。
 */
function taskTypeMatches(rawType: string | undefined, wantedType: string): boolean {
  return rawType?.trim().toLowerCase() === wantedType
}

function latestMatchingSampleAt(sampleUpdatedAtByTaskId: ReadonlyMap<number, number>, taskIds: ReadonlySet<number>): number {
  let latest = 0
  for (const taskId of taskIds) {
    const sampleAt = sampleUpdatedAtByTaskId.get(taskId) ?? 0
    if (sampleAt >= pingTaskEpochStartedAt(taskId))
      latest = Math.max(latest, sampleAt)
  }
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
    taskType?: MaybeRefOrGetter<string>
  },
) {
  const loading = ref(false)

  const resolved = computed(() => {
    const hours = Math.max(1, Math.floor(toValue(options?.hours) ?? 24))
    const maxCount = normalizeMaxCount(toValue(options?.maxCount) ?? PING_RECORD_MAX_COUNT)
    const taskNameFilter = toValue(options?.taskNameFilter)?.trim() ?? ''
    const requestedMatch = toValue(options?.taskNameMatch)
    const taskType = toValue(options?.taskType)?.trim().toLowerCase() ?? ''
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
      taskType,
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
    void pingTaskEpochRevision.value
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType, enabled } = resolved.value
    if (!enabled || !nodeUuid.trim())
      return { stats: createEmptyNodePingStats(), insightPoints: [], taskId: null, taskName: '', sampleUpdatedAt: 0, source: 'empty' }

    // 通过 getSharedPingRecordsEntry 读取（不存在则创建），确保 computed 始终对
    // entry.data 这个 shallowRef 建立响应式依赖——即便首次加载尚未返回。
    const entry = getSharedPingRecordsEntry(hours, maxCount, nodeUuid)
    const state = entry.data.value
    if (!state) {
      // 网络不可用时仍按分钟检查缓存的真实样本时间；缓存自身不会因此被重新写入。
      void pingFreshnessTick.value
      const cached = readStatsCache(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType)
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
    const nameMatchingTaskIds = normalizedFilter
      ? new Set([...state.taskNamesById.entries()]
          .filter(([taskId, name]) => nodeTaskIds.has(taskId) && matchesTaskName(name, normalizedFilter, taskNameMatch))
          .map(([taskId]) => taskId))
      : new Set(nodeTaskIds)
    const typedMatchingTaskIds = taskType
      ? new Set([...nameMatchingTaskIds].filter(taskId => taskTypeMatches(state.taskTypesById?.get(taskId), taskType)))
      : nameMatchingTaskIds
    const matchingTaskIds = resolveExactMatchingTaskIds(
      normalizedFilter
        ? typedMatchingTaskIds
        : taskType ? typedMatchingTaskIds : null,
      taskNameMatch,
      state.metricStats,
      state.recordsByClient.get(nodeUuid) ?? [],
    )
    const records = filterPingRecordsToCurrentEpoch((state.recordsByClient.get(nodeUuid) ?? [])
      .filter(record => !matchingTaskIds || matchingTaskIds.has(record.task_id)))
    const metricLossPoints = state.metricLossPoints
      ? filterMetricLossToCurrentEpoch(state.metricLossPoints
          .filter(point => !matchingTaskIds || matchingTaskIds.has(point.taskId)))
      : undefined
    const rangeStartedAt = pingFreshnessTick.value - hours * 60 * 60 * 1000
    const metricStats = state.metricStats?.filter((stat) => {
      const id = normalizeTaskId(stat.task_id)
      return (!matchingTaskIds || matchingTaskIds.has(id)) && pingTaskEpochStartedAt(id) <= rangeStartedAt
    })
    const stats = records.length || metricStats?.length || metricLossPoints?.length
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
  const current = computed(() => {
    const { uuid: nodeUuid, hours, maxCount } = resolved.value
    const state = getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value
    const id = resolvedStats.value.taskId
    if (!state || id === null)
      return resolveProbeCurrentState([])
    return resolveProbeCurrentState(filterPingRecordsToCurrentEpoch((state.rawRecordsByClient?.get(nodeUuid) ?? []).filter(record => record.task_id === id)), {
      now: pingFreshnessTick.value,
      interval: state.taskIntervalsById?.get(id),
    })
  })
  const probeType = computed(() => {
    const { uuid: nodeUuid, hours, maxCount } = resolved.value
    return getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value?.taskTypesById?.get(resolvedStats.value.taskId ?? -1) ?? ''
  })
  const probeInterval = computed(() => {
    const { uuid: nodeUuid, hours, maxCount } = resolved.value
    return getSharedPingRecordsEntry(hours, maxCount, nodeUuid).data.value?.taskIntervalsById?.get(resolvedStats.value.taskId ?? -1) ?? null
  })

  const taskNames = computed<string[]>(() => {
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType, enabled } = resolved.value
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
      .filter(([taskId, name]) => nodeTaskIds.has(taskId)
        && matchesTaskName(name, normalizedFilter, taskNameMatch)
        && (!taskType || taskTypeMatches(state.taskTypesById?.get(taskId), taskType)))
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
  const freshnessAgeMs = computed(() => lastFetchedAt.value > 0
    ? Math.max(0, pingFreshnessTick.value - lastFetchedAt.value)
    : 0)

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
    (nodeUuid: string, hours: number, maxCount: number | undefined, taskNameFilter: string, taskNameMatch: PingTaskNameMatch, taskType: string, value: NodePingStatsState, sampleUpdatedAt: number) => {
      writeStatsCache(nodeUuid, hours, maxCount, value, sampleUpdatedAt, taskNameFilter, taskNameMatch, taskType)
    },
    30_000,
    true,
    true,
  )

  watch(resolvedStats, (value) => {
    if (value.source !== 'live' || !value.stats.hasData || value.sampleUpdatedAt <= 0)
      return
    const { uuid: nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType, enabled } = resolved.value
    if (enabled && nodeUuid.trim())
      persistStats(nodeUuid, hours, maxCount, taskNameFilter, taskNameMatch, taskType, value.stats, value.sampleUpdatedAt)
  })

  return {
    stats,
    current,
    probeType,
    probeInterval,
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
    latencySampleCount: computed(() => stats.value.latencySampleCount),
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
  const latencySampleCount = usable.reduce((sum, state) => sum + state.latencySampleCount, 0)
  const weighted = (read: (state: NodePingStatsState) => number): number => sampleCount > 0
    ? usable.reduce((sum, state) => sum + read(state) * state.sampleCount, 0) / sampleCount
    : 0
  const weightedLatency = (read: (state: NodePingStatsState) => number): number => latencySampleCount > 0
    ? usable.reduce((sum, state) => sum + read(state) * state.latencySampleCount, 0) / latencySampleCount
    : 0
  const history = mergeCarrierPingHistory(usable.map(state => state.history))
  return {
    avgLatency: weightedLatency(state => state.avgLatency),
    avgLoss: weighted(state => state.avgLoss),
    lineLoss: weighted(state => state.lineLoss),
    commonModeLossEvents: usable.reduce((sum, state) => sum + state.commonModeLossEvents, 0),
    avgVolatility: weightedLatency(state => state.avgVolatility),
    p50Latency: averageAvailable(usable.map(state => state.p50Latency)),
    p95Latency: averageAvailable(usable.map(state => state.p95Latency)),
    availability: sampleCount > 0 ? Math.max(0, Math.min(100, 100 - weighted(state => state.avgLoss))) : null,
    sampleCount,
    latencySampleCount,
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
        // 三网卡片按地区+运营商的任务名精确匹配就已经唯一确定了任务，不能再按
        // 类型二次过滤——`docs/MonitoringTargetHealth.md` 记录的当前行为是
        // ICMP、TCP 都要显示，只是失败率的措辞不同（丢包率 vs 探测失败率）。
        // 按 icmp 强制过滤会让还没迁移的 TCP 监测任务在三网卡片上直接消失。
      })
    })
    return {
      ...carrier,
      regionalPings,
    }
  })

  // Use the oldest available active sample for the aggregate delay label.
  // Disabled regions have no timestamp and must never contribute epoch-sized ages.
  const lastFetchedAt = computed(() => {
    const timestamps = carrierPings.flatMap(carrier => carrier.regionalPings.map(ping => ping.lastFetchedAt.value))
      .filter(timestamp => timestamp > 0)
    return timestamps.length ? Math.min(...timestamps) : 0
  })
  return {
    carriers: computed(() => carrierPings.map((carrier) => {
      const active = carrier.regionalPings.filter(ping => ping.hasData.value || ping.loading.value || ping.error.value || ping.taskNames.value.length)
      const stats = mergeCarrierPingStats(active.map(ping => ping.stats.value))
      // 只在活跃分区一致时才报出具体类型（icmp 或 tcp 都可能），分区之间类型
      // 不一致或未知时退回空字符串——展示层据此选用「丢包率」还是「失败率」
      // 措辞，混用状态下不该冒充确定的某一种。
      const activeProbeTypes = new Set(active.map(ping => ping.probeType.value))
      const uniformProbeType = activeProbeTypes.size === 1 ? [...activeProbeTypes][0]! : ''
      return {
        key: carrier.key,
        labelZh: carrier.labelZh,
        labelEn: carrier.labelEn,
        taskNames: [...new Set(active.flatMap(ping => ping.taskNames.value))],
        stats,
        current: mergeProbeCurrentStates(active.map(ping => ping.current.value)),
        probeType: uniformProbeType,
        hasLatency: stats.hasLatencyData,
        delayed: active.some(ping => ping.delayed.value),
        stale: active.length > 0 && active.every(ping => ping.stale.value),
      }
    })),
    loading: computed(() => carrierPings.some(carrier => carrier.regionalPings.some(ping => ping.loading.value))),
    error: computed(() => carrierPings.flatMap(carrier => carrier.regionalPings.map(ping => ping.error.value)).find(Boolean) ?? null),
    lastFetchedAt,
    freshnessAgeMs: computed(() => lastFetchedAt.value > 0 ? Math.max(0, pingFreshnessTick.value - lastFetchedAt.value) : 0),
    delayed: computed(() => carrierPings.some(carrier => carrier.regionalPings.some(ping => ping.delayed.value))),
    stale: computed(() => {
      const active = carrierPings.flatMap(carrier => carrier.regionalPings)
        .filter(ping => ping.hasData.value || ping.loading.value || ping.error.value || ping.taskNames.value.length)
      return active.length > 0 && active.every(ping => ping.stale.value)
    }),
  }
}
