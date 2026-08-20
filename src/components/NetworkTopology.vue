<script setup lang="ts">
import type { TopologyRouteDetail } from '@/components/TopologyRouteDetailDialog.vue'
import type { NodeData } from '@/stores/nodes'
import type { PingTaskInfo } from '@/utils/rpc'
import type { TopologyRouteHealth, TopologyRouteScore, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyRouteRanking, TopologyRouteReliability, TopologySegmentReliabilitySnapshot } from '@/utils/topologyIntelligence'
import { Icon } from '@iconify/vue'
import { useMediaQuery, useStorageAsync } from '@vueuse/core'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import IncidentTimelineDialog from '@/components/IncidentTimelineDialog.vue'
import TopologyEdgeMetric from '@/components/TopologyEdgeMetric.vue'
import TopologyManagerDialog from '@/components/TopologyManagerDialog.vue'
import TopologyProbeSelect from '@/components/TopologyProbeSelect.vue'
import TopologyRouteDetailDialog from '@/components/TopologyRouteDetailDialog.vue'
import TopologySegmentReliabilityObserver from '@/components/TopologySegmentReliabilityObserver.vue'
import { useTopologyProbeRepair } from '@/composables/useTopologyProbeRepair'
import { loadPublicPingTasks } from '@/services/metrics.service'
import { useAppStore } from '@/stores/app'
import { getNodeRole } from '@/utils/nodeRoleHelper'
import { getRegionCode } from '@/utils/regionHelper'
import { readTopologyRoutes } from '@/utils/topologyConfig'
import { calculateTopologyRouteScore } from '@/utils/topologyHealth'
import { resolveTopologyNode } from '@/utils/topologyHelper'
import { aggregateTopologyRouteReliability, rankTopologyRoutes } from '@/utils/topologyIntelligence'
import { formatTopologyMetric, formatTopologyMetricForProbe, getTopologyProbeStorageKey, parseTopologyMetric, serializeTopologyRoutes } from '@/utils/topologyLegacyFormat'
import { findTopologyProbeKey, getTopologyProbe, listTopologyProbeTaskNamesForSource, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'

interface RouteNode {
  key: string
  name: string
  region: string
  role: string
  uuid?: string
  node?: NodeData
}

interface RouteRow {
  key: string
  probeStorageKey: string
  probeKey: string
  probeLabel: string
  probeOverridden: boolean
  probeSelectable: boolean
  nodes: RouteNode[]
  metrics: string[]
  directionKey: string
  directionLabel: string
}

interface RouteDirection {
  key: string
  label: string
  count: number
}

const props = withDefaults(defineProps<{ nodes: NodeData[], embedded?: boolean }>(), { embedded: false })
const appStore = useAppStore()
const router = useRouter()
const probeSelections = useStorageAsync<Record<string, string>>('pandaTopologyProbeSelections', {}, localStorage)
const publicPingTasks = shallowRef<PingTaskInfo[]>([])
const managerOpen = ref(false)
const timelineOpen = ref(false)
const detailOpen = ref(false)
const selectedRouteKey = ref<string | null>(null)
const routeSegmentHealth = ref<Record<string, Record<number, TopologyRouteHealth>>>({})
const routeSegmentMetrics = ref<Record<string, Record<number, TopologySegmentTelemetry>>>({})
const routeSegmentReliability = ref<Record<string, Record<number, TopologySegmentReliabilitySnapshot>>>({})
const activeDirection = ref('all')
const isDesktop = useMediaQuery('(min-width: 768px)')
const { lastError: repairError } = useTopologyProbeRepair(() => props.nodes, managerOpen)

onMounted(() => {
  void loadPublicPingTasks()
    .then((tasks) => {
      publicPingTasks.value = tasks
    })
    .catch(() => {
      publicPingTasks.value = []
    })
})

// 有 JSON 配置就用 JSON，没有才解析旧的两条字符串——和拓扑管理器共用同一个
// 入口，避免同一份配置在首页和管理器里解析出不同结果。
const configuredRoutes = computed(() => readTopologyRoutes(
  appStore.topologyConfig,
  appStore.topologyRoute,
  appStore.topologyMetrics,
))

function findNode(name: string, uuid = ''): NodeData | undefined {
  return resolveTopologyNode(props.nodes, name, uuid)
}

const DIRECTION_LABELS: Record<string, string> = {
  AU: '澳洲方向',
  CA: '加拿大方向',
  DE: '德国方向',
  GB: '英国方向',
  HK: '香港方向',
  JP: '日本方向',
  KR: '韩国方向',
  SG: '新加坡方向',
  TW: '台湾方向',
  US: '美国方向',
}

function getRouteDirection(nodes: RouteNode[]): { key: string, label: string } {
  const region = nodes.at(-1)?.region || nodes[1]?.region || ''
  const code = getRegionCode(region).toUpperCase()
  return {
    key: code || 'OTHER',
    label: DIRECTION_LABELS[code] || `${region || '其他'}方向`,
  }
}

const routes = computed<RouteRow[]>(() => configuredRoutes.value.map((configured, routeIndex) => {
  // 探测选择存在 localStorage 里，键沿用旧的线路组字符串——换成别的算法会让
  // 所有人已保存的入口选择一次性失效。
  const group = serializeTopologyRoutes([configured]).topologyRoute
  const nodes = configured.nodes.slice(0, 3).map((config, nodeIndex) => {
    const node = nodeIndex === 0 ? findNode(config.name) : findNode(config.name, config.uuid)
    return {
      key: `${routeIndex}-${nodeIndex}-${config.uuid || config.name}`,
      name: config.name,
      region: node?.region || config.region,
      role: node ? (getNodeRole(node.tags, node.groups) || config.role) : config.role,
      uuid: config.uuid || node?.uuid,
      node,
    }
  })
  while (nodes.length && !nodes.at(-1)?.name.trim())
    nodes.pop()
  // 子组件仍按字符串接收指标；这里把解析结果格式化回去，读路径的格式差异
  // （例如旧版六段 live@ 写法）在这一步就被归一化掉了。
  const metrics = configured.metrics.slice(0, 2).map(formatTopologyMetric)
  const configuredFirstMetric = parseTopologyMetric(metrics[0] || '')
  const configuredEntryProbeKey = findTopologyProbeKey(nodes[0]?.name || '')
  const configuredTaskProbeKey = findTopologyProbeKey(configuredFirstMetric.taskFilter)
  const configuredProbeKey = configuredEntryProbeKey === configuredTaskProbeKey
    ? configuredTaskProbeKey
    : undefined
  const probeStorageKey = getTopologyProbeStorageKey(group, metrics[0] || '')
  const rawStoredProbeKey = configuredFirstMetric.live ? probeSelections.value[probeStorageKey] : undefined
  const storedProbeKey = TOPOLOGY_PROBE_OPTIONS.find(option => option.key === rawStoredProbeKey)?.key
  const probeKey = storedProbeKey || configuredProbeKey || ''
  const selectedProbe = probeKey ? getTopologyProbe(probeKey) : null
  const probeLabel = nodes[0]?.name || selectedProbe?.label || configuredFirstMetric.taskFilter || '自定义入口'
  const probeSelectable = configuredFirstMetric.live

  if (configuredFirstMetric.live && storedProbeKey && selectedProbe) {
    const probeTaskNames = listTopologyProbeTaskNamesForSource(publicPingTasks.value, nodes[1]?.uuid || '')
    metrics[0] = formatTopologyMetricForProbe(metrics[0] || '', selectedProbe.key, nodes[1]?.name || '', probeTaskNames)
    if (nodes[0])
      nodes[0].name = selectedProbe.label
  }

  const direction = getRouteDirection(nodes)

  return {
    key: `route-${routeIndex}`,
    probeStorageKey,
    probeKey,
    probeLabel,
    probeOverridden: Boolean(storedProbeKey),
    probeSelectable,
    nodes,
    metrics,
    directionKey: direction.key,
    directionLabel: direction.label,
  }
}).filter(route => route.nodes.filter(node => node.name.trim()).length >= 2))

const directions = computed<RouteDirection[]>(() => {
  const counts = new Map<string, RouteDirection>()
  for (const route of routes.value) {
    const current = counts.get(route.directionKey)
    if (current)
      current.count += 1
    else
      counts.set(route.directionKey, { key: route.directionKey, label: route.directionLabel, count: 1 })
  }
  return [...counts.values()]
})

const visibleRoutes = computed(() => activeDirection.value === 'all'
  ? routes.value
  : routes.value.filter(route => route.directionKey === activeDirection.value))
const hiddenRoutes = computed(() => activeDirection.value === 'all'
  ? []
  : routes.value.filter(route => route.directionKey !== activeDirection.value))

watch(directions, (items) => {
  if (activeDirection.value !== 'all' && !items.some(item => item.key === activeDirection.value))
    activeDirection.value = 'all'
})

function getRouteHealth(route: RouteRow): TopologyRouteHealth {
  if (route.nodes.some(item => !item.name.trim()))
    return 'error'

  const configuredNodes = route.nodes.slice(1)
  if (configuredNodes.some(item => item.node?.online === false))
    return 'offline'
  if (configuredNodes.some(item => !item.node))
    return 'error'
  const expectedSegments = Math.max(1, route.nodes.length - 1)
  const states = Array.from({ length: expectedSegments }, (_, index) => routeSegmentHealth.value[route.key]?.[index] ?? 'pending')
  for (const status of ['offline', 'error', 'pending'] as const) {
    if (states.includes(status))
      return status
  }
  const scoreTone = getRouteScore(route).tone
  if (scoreTone === 'critical')
    return 'error'
  if (states.includes('warning') || scoreTone === 'warning')
    return 'warning'
  return scoreTone === 'pending' ? 'pending' : 'healthy'
}

function updateRouteSegmentHealth(routeKey: string, segmentIndex: number, status: TopologyRouteHealth): void {
  const current = routeSegmentHealth.value[routeKey] ?? {}
  if (current[segmentIndex] === status)
    return
  routeSegmentHealth.value = {
    ...routeSegmentHealth.value,
    [routeKey]: { ...current, [segmentIndex]: status },
  }
}

function updateRouteSegmentMetrics(routeKey: string, segmentIndex: number, metrics: TopologySegmentTelemetry): void {
  const current = routeSegmentMetrics.value[routeKey] ?? {}
  const previous = current[segmentIndex]
  if (previous
    && previous.status === metrics.status
    && previous.latency === metrics.latency
    && previous.loss === metrics.loss
    && previous.volatility === metrics.volatility
    && previous.hasLiveData === metrics.hasLiveData
    && previous.stale === metrics.stale) {
    return
  }
  routeSegmentMetrics.value = {
    ...routeSegmentMetrics.value,
    [routeKey]: { ...current, [segmentIndex]: metrics },
  }
}

function updateRouteSegmentReliability(routeKey: string, segmentIndex: number, snapshot: TopologySegmentReliabilitySnapshot): void {
  const current = routeSegmentReliability.value[routeKey] ?? {}
  const previous = current[segmentIndex]
  if (previous && JSON.stringify(previous) === JSON.stringify(snapshot))
    return
  routeSegmentReliability.value = {
    ...routeSegmentReliability.value,
    [routeKey]: { ...current, [segmentIndex]: snapshot },
  }
}

function getRouteScore(route: RouteRow): TopologyRouteScore {
  const expectedSegments = Math.max(1, route.nodes.length - 1)
  return calculateTopologyRouteScore({
    segments: Array.from({ length: expectedSegments }, (_, index) => routeSegmentMetrics.value[route.key]?.[index]),
    segmentLabels: Array.from({ length: expectedSegments }, (_, index) => `${route.nodes[index]?.name || `第 ${index + 1} 段`}至${route.nodes[index + 1]?.name || '目标'}`),
    hasOfflineNode: route.nodes.slice(1).some(item => item.node?.online === false),
    hasMissingNode: route.nodes.slice(1).some(item => !item.node),
  })
}

function getRouteReliability(route: RouteRow): TopologyRouteReliability {
  const expectedSegments = Math.max(1, route.nodes.length - 1)
  return aggregateTopologyRouteReliability(
    Array.from({ length: expectedSegments }, (_, index) => routeSegmentMetrics.value[route.key]?.[index]),
    Array.from({ length: expectedSegments }, (_, index) => routeSegmentReliability.value[route.key]?.[index]),
  )
}

const routeRankings = computed<Record<string, TopologyRouteRanking>>(() => rankTopologyRoutes(routes.value.map(route => ({
  key: route.key,
  directionKey: `${route.probeKey || findTopologyProbeKey(route.probeLabel) || route.probeLabel.trim().toLowerCase()}::${route.directionKey}`,
  healthScore: getRouteScore(route).score,
  status: getRouteHealth(route),
  reliability: getRouteReliability(route),
}))))

const selectedRoute = computed<TopologyRouteDetail | null>(() => {
  const route = routes.value.find(item => item.key === selectedRouteKey.value)
  if (!route)
    return null
  return {
    key: route.key,
    sourceUuid: route.nodes[1]?.uuid,
    nodeNames: route.nodes.map(node => node.name),
    metrics: route.metrics,
    score: getRouteScore(route),
    reliability: getRouteReliability(route),
    ranking: ['healthy', 'warning'].includes(getRouteHealth(route)) ? routeRankings.value[route.key] : undefined,
    directionLabel: route.directionLabel,
  }
})

watch(selectedRoute, (route) => {
  if (detailOpen.value && !route)
    detailOpen.value = false
})

const healthCounts = computed(() => routes.value.reduce((counts, route) => {
  counts[getRouteHealth(route)] += 1
  return counts
}, { healthy: 0, warning: 0, pending: 0, error: 0, offline: 0 } as Record<TopologyRouteHealth, number>))

const healthSummary = computed(() => {
  const counts = healthCounts.value
  if (counts.healthy === routes.value.length)
    return { label: '全部正常', dot: 'bg-emerald-400' }
  const parts = [
    counts.offline ? `${counts.offline} 失联` : '',
    counts.error ? `${counts.error} 异常` : '',
    counts.warning ? `${counts.warning} 波动` : '',
    counts.pending ? `${counts.pending} 待数据` : '',
  ].filter(Boolean)
  return {
    label: parts.join(' · '),
    dot: counts.offline || counts.error ? 'bg-rose-400' : counts.warning || counts.pending ? 'bg-amber-400' : 'bg-emerald-400',
  }
})

function routeStatusLabel(route: RouteRow): string {
  const status = getRouteHealth(route)
  if (status === 'offline')
    return '失联'
  if (status === 'error')
    return '异常'
  if (status === 'pending')
    return '待数据'
  if (status === 'warning')
    return '波动'
  return '正常'
}

function routeDotClass(route: RouteRow): string {
  const status = getRouteHealth(route)
  if (status === 'offline' || status === 'error')
    return 'bg-rose-400'
  if (status === 'warning' || status === 'pending')
    return 'bg-amber-400'
  return 'bg-emerald-400'
}

function openNode(item: RouteNode) {
  if (item.node)
    router.push({ name: 'instance-detail', params: { id: item.node.uuid } })
}

function updateProbe(route: RouteRow, value: string) {
  const nextSelections = { ...probeSelections.value }
  if (value)
    nextSelections[route.probeStorageKey] = value
  else
    delete nextSelections[route.probeStorageKey]
  probeSelections.value = nextSelections
}

function openRouteDetail(route: RouteRow): void {
  selectedRouteKey.value = route.key
  detailOpen.value = true
}

function routeScoreClass(route: RouteRow): string {
  const tone = getRouteScore(route).tone
  if (tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (tone === 'pending')
    return 'text-slate-500 dark:text-slate-400'
  return 'text-emerald-700 dark:text-emerald-300'
}

function routeRankingLabel(route: RouteRow): string {
  if (!['healthy', 'warning'].includes(getRouteHealth(route)))
    return ''
  const ranking = routeRankings.value[route.key]
  if (!ranking || ranking.total <= 1)
    return ''
  return ranking.recommended ? '推荐' : `#${ranking.rank}/${ranking.total}`
}
</script>

<template>
  <section
    v-if="routes.length"
    :class="embedded ? '' : 'px-4 pb-4'"
    class="relative z-1 scroll-mt-20 pointer-events-auto"
    aria-labelledby="topology-title"
  >
    <div class="transit-panel overflow-hidden rounded-2xl">
      <header class="transit-divider flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2 sm:px-5">
        <div class="flex items-center gap-2">
          <Icon icon="tabler:route" :width="17" class="text-emerald-400" />
          <h2 id="topology-title" class="text-sm font-semibold">
            线路状态
          </h2>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-400 sm:text-[11px]">
          <span>{{ routes.length }} 条线路</span>
          <span class="text-slate-400 dark:text-slate-700">·</span>
          <span role="status" aria-live="polite" aria-atomic="true">{{ healthSummary.label }}</span>
          <span class="size-1.5 rounded-full" :class="healthSummary.dot" />
          <span
            v-if="repairError"
            data-topology-repair-error
            role="status"
            class="max-w-40 truncate text-amber-700 dark:text-amber-300"
            :title="repairError"
          >自愈失败</span>
          <button
            type="button"
            data-transit-incident-timeline-button
            class="transit-divider ml-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-slate-600 transition-colors hover:border-emerald-500/30 hover:text-slate-900 dark:text-slate-400 dark:hover:border-emerald-400/25 dark:hover:text-slate-200"
            aria-label="查看异常时间线"
            @click="timelineOpen = true"
          >
            <Icon icon="tabler:timeline-event" :width="13" />
            <span class="hidden sm:inline">事件</span>
          </button>
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button"
            class="transit-divider ml-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-slate-600 transition-colors hover:border-emerald-500/30 hover:text-slate-900 dark:text-slate-400 dark:hover:border-emerald-400/25 dark:hover:text-slate-200"
            @click="managerOpen = true"
          >
            <Icon icon="tabler:settings" :width="13" />管理
          </button>
        </div>
      </header>

      <nav
        v-if="directions.length > 1"
        aria-label="线路方向"
        class="transit-divider topology-direction-scroll flex min-w-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:px-4"
      >
        <button
          type="button"
          data-topology-direction
          class="shrink-0 rounded-md border px-2.5 py-1 text-[10px] transition-colors"
          :class="activeDirection === 'all' ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/[0.055] dark:text-emerald-300' : 'transit-divider text-slate-600 hover:text-slate-900 dark:text-slate-500 dark:hover:text-slate-300'"
          :aria-pressed="activeDirection === 'all'"
          @click="activeDirection = 'all'"
        >
          全部 {{ routes.length }}
        </button>
        <button
          v-for="direction in directions"
          :key="direction.key"
          type="button"
          data-topology-direction
          class="shrink-0 rounded-md border px-2.5 py-1 text-[10px] transition-colors"
          :class="activeDirection === direction.key ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/[0.055] dark:text-emerald-300' : 'transit-divider text-slate-600 hover:text-slate-900 dark:text-slate-500 dark:hover:text-slate-300'"
          :aria-pressed="activeDirection === direction.key"
          @click="activeDirection = direction.key"
        >
          {{ direction.label }} {{ direction.count }}
        </button>
      </nav>

      <div v-if="isDesktop" class="topology-scroll overflow-x-auto px-3 sm:px-4">
        <div class="min-w-[980px]">
          <article
            v-for="route in visibleRoutes"
            :key="route.key"
            data-topology-route
            class="transit-divider transit-hover-surface group grid min-h-16 items-center gap-3 border-b px-2 transition-colors last:border-b-0"
            :class="route.nodes[2] ? 'grid-cols-[144px_minmax(190px,1fr)_178px_minmax(190px,1fr)_190px]' : 'grid-cols-[144px_minmax(190px,1fr)_190px]'"
          >
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  data-topology-route-status
                  :data-status="getRouteHealth(route)"
                  role="img"
                  :aria-label="`线路状态：${routeStatusLabel(route)}`"
                  class="size-2 shrink-0 rounded-full"
                  :class="routeDotClass(route)"
                />
                <TopologyProbeSelect
                  :model-value="route.probeKey"
                  :custom-label="route.probeLabel"
                  :disabled="!route.probeSelectable"
                  :resettable="route.probeOverridden"
                  @update:model-value="updateProbe(route, $event)"
                />
              </div>
              <button
                type="button"
                data-topology-route-score
                :data-topology-route-ranking="routeRankingLabel(route) || undefined"
                class="ml-4 mt-0.5 whitespace-nowrap text-[9px] font-medium tabular-nums transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
                :class="routeScoreClass(route)"
                :aria-label="`线路状态：${routeStatusLabel(route)}，线路健康评分 ${getRouteScore(route).score} 分，${getRouteScore(route).label}${routeRankingLabel(route) ? `，${routeRankingLabel(route)}` : ''}，查看详情`"
                @click="openRouteDetail(route)"
              >
                {{ getRouteScore(route).score }} 分 {{ getRouteScore(route).label }}
                <span v-if="routeRankingLabel(route)" class="ml-1 rounded border border-current/20 px-1 py-px text-[8px] no-underline">
                  {{ routeRankingLabel(route) }}
                </span>
              </button>
            </div>

            <TopologyEdgeMetric
              :metric="route.metrics[0] || '-,-'"
              :nodes="nodes"
              :source-uuid="route.nodes[1]?.uuid"
              :source-label="route.nodes[0]?.name || '入口'"
              :target-label="route.nodes[1]?.name || '线路机'"
              :segment-index="0"
              @open-detail="openRouteDetail(route)"
              @status-change="updateRouteSegmentHealth(route.key, 0, $event)"
              @metrics-change="updateRouteSegmentMetrics(route.key, 0, $event)"
            />

            <button
              type="button"
              class="flex min-w-0 items-center gap-2.5 text-left disabled:cursor-default"
              :disabled="!route.nodes[1]?.node"
              @click="route.nodes[1] && openNode(route.nodes[1])"
            >
              <span class="transit-dot-ring size-1.5 shrink-0 rounded-full ring-4" :class="!route.nodes[1]?.node ? 'bg-amber-400' : route.nodes[1].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
              <img
                v-if="route.nodes[1]?.region"
                :src="`/images/flags/${getRegionCode(route.nodes[1].region)}.svg`"
                :alt="route.nodes[1].region"
                class="h-4 w-6 shrink-0 rounded-[3px] object-cover"
              >
              <span class="flex min-w-0 flex-col leading-tight">
                <span class="truncate text-[13px] font-semibold">{{ route.nodes[1]?.name }}</span>
                <span class="mt-0.5 truncate text-[10px] text-slate-500">{{ route.nodes[1]?.role }}</span>
              </span>
            </button>

            <template v-if="route.nodes[2]">
              <TopologyEdgeMetric
                :metric="route.metrics[1] || '-,-'"
                :nodes="nodes"
                :source-uuid="route.nodes[1]?.uuid"
                :source-label="route.nodes[1]?.name || '线路机'"
                :target-label="route.nodes[2]?.name || '落地机'"
                :segment-index="1"
                @open-detail="openRouteDetail(route)"
                @status-change="updateRouteSegmentHealth(route.key, 1, $event)"
                @metrics-change="updateRouteSegmentMetrics(route.key, 1, $event)"
              />

              <button
                type="button"
                class="flex min-w-0 items-center gap-2.5 text-left disabled:cursor-default"
                :disabled="!route.nodes[2]?.node"
                @click="route.nodes[2] && openNode(route.nodes[2])"
              >
                <span class="transit-dot-ring size-1.5 shrink-0 rounded-full ring-4" :class="!route.nodes[2]?.node ? 'bg-amber-400' : route.nodes[2].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
                <img
                  v-if="route.nodes[2]?.region"
                  :src="`/images/flags/${getRegionCode(route.nodes[2].region)}.svg`"
                  :alt="route.nodes[2].region"
                  class="h-4 w-6 shrink-0 rounded-[3px] object-cover"
                >
                <span class="flex min-w-0 flex-col leading-tight">
                  <span class="truncate text-[13px] font-semibold">{{ route.nodes[2]?.name }}</span>
                  <span class="mt-0.5 truncate text-[10px] text-slate-500">{{ route.nodes[2]?.role }}</span>
                </span>
              </button>
            </template>
          </article>
        </div>
      </div>

      <div v-else class="px-3">
        <article
          v-for="route in visibleRoutes"
          :key="route.key"
          data-topology-mobile-route
          class="transit-divider border-b py-3 last:border-b-0"
        >
          <div class="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2">
            <span class="grid place-items-center">
              <span
                data-topology-route-status
                :data-status="getRouteHealth(route)"
                role="img"
                :aria-label="`线路状态：${routeStatusLabel(route)}`"
                class="transit-dot-ring size-2 rounded-full ring-4"
                :class="routeDotClass(route)"
              />
            </span>
            <TopologyProbeSelect
              :model-value="route.probeKey"
              :custom-label="route.probeLabel"
              :disabled="!route.probeSelectable"
              :resettable="route.probeOverridden"
              @update:model-value="updateProbe(route, $event)"
            />
            <button
              type="button"
              data-topology-route-score
              :data-topology-route-ranking="routeRankingLabel(route) || undefined"
              class="whitespace-nowrap text-[9px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
              :class="routeScoreClass(route)"
              :aria-label="`线路状态：${routeStatusLabel(route)}，线路健康评分 ${getRouteScore(route).score} 分，${getRouteScore(route).label}${routeRankingLabel(route) ? `，${routeRankingLabel(route)}` : ''}，查看详情`"
              @click="openRouteDetail(route)"
            >
              {{ getRouteScore(route).score }} {{ getRouteScore(route).label }}
              <span v-if="routeRankingLabel(route)" class="ml-1 rounded border border-current/20 px-1 py-px text-[8px]">
                {{ routeRankingLabel(route) }}
              </span>
            </button>
          </div>

          <div class="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
            <span class="flex justify-center"><span class="transit-rail h-full w-px" /></span>
            <TopologyEdgeMetric
              mobile
              :metric="route.metrics[0] || '-,-'"
              :nodes="nodes"
              :source-uuid="route.nodes[1]?.uuid"
              :source-label="route.nodes[0]?.name || '入口'"
              :target-label="route.nodes[1]?.name || '线路机'"
              :segment-index="0"
              @open-detail="openRouteDetail(route)"
              @status-change="updateRouteSegmentHealth(route.key, 0, $event)"
              @metrics-change="updateRouteSegmentMetrics(route.key, 0, $event)"
            />
          </div>

          <button
            type="button"
            data-topology-mobile-node
            class="grid w-full grid-cols-[22px_minmax(0,1fr)] items-center gap-2 text-left disabled:cursor-default"
            :disabled="!route.nodes[1]?.node"
            @click="route.nodes[1] && openNode(route.nodes[1])"
          >
            <span class="grid place-items-center">
              <span class="transit-dot-ring size-1.5 rounded-full ring-4" :class="!route.nodes[1]?.node ? 'bg-amber-400' : route.nodes[1].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
            </span>
            <span class="flex min-w-0 items-center gap-2.5">
              <img
                v-if="route.nodes[1]?.region"
                :src="`/images/flags/${getRegionCode(route.nodes[1].region)}.svg`"
                :alt="route.nodes[1].region"
                class="h-4 w-6 shrink-0 rounded-[3px] object-cover"
              >
              <span class="flex min-w-0 flex-col leading-tight">
                <span class="truncate text-[13px] font-semibold">{{ route.nodes[1]?.name }}</span>
                <span class="mt-0.5 truncate text-[10px] text-slate-500">{{ route.nodes[1]?.role }}</span>
              </span>
            </span>
          </button>

          <template v-if="route.nodes[2]">
            <div class="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
              <span class="flex justify-center"><span class="transit-rail h-full w-px" /></span>
              <TopologyEdgeMetric
                mobile
                :metric="route.metrics[1] || '-,-'"
                :nodes="nodes"
                :source-uuid="route.nodes[1]?.uuid"
                :source-label="route.nodes[1]?.name || '线路机'"
                :target-label="route.nodes[2]?.name || '落地机'"
                :segment-index="1"
                @open-detail="openRouteDetail(route)"
                @status-change="updateRouteSegmentHealth(route.key, 1, $event)"
                @metrics-change="updateRouteSegmentMetrics(route.key, 1, $event)"
              />
            </div>

            <button
              type="button"
              data-topology-mobile-node
              class="grid w-full grid-cols-[22px_minmax(0,1fr)] items-center gap-2 text-left disabled:cursor-default"
              :disabled="!route.nodes[2]?.node"
              @click="route.nodes[2] && openNode(route.nodes[2])"
            >
              <span class="grid place-items-center">
                <span class="transit-dot-ring size-1.5 rounded-full ring-4" :class="!route.nodes[2]?.node ? 'bg-amber-400' : route.nodes[2].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
              </span>
              <span class="flex min-w-0 items-center gap-2.5">
                <img
                  v-if="route.nodes[2]?.region"
                  :src="`/images/flags/${getRegionCode(route.nodes[2].region)}.svg`"
                  :alt="route.nodes[2].region"
                  class="h-4 w-6 shrink-0 rounded-[3px] object-cover"
                >
                <span class="flex min-w-0 flex-col leading-tight">
                  <span class="truncate text-[13px] font-semibold">{{ route.nodes[2]?.name }}</span>
                  <span class="mt-0.5 truncate text-[10px] text-slate-500">{{ route.nodes[2]?.role }}</span>
                </span>
              </span>
            </button>
          </template>
        </article>
      </div>

      <div class="hidden" aria-hidden="true">
        <template v-for="route in hiddenRoutes" :key="`${route.key}-telemetry`">
          <TopologyEdgeMetric
            v-for="(metric, segmentIndex) in route.metrics.slice(0, Math.max(1, route.nodes.length - 1))"
            :key="`${route.key}-${segmentIndex}-telemetry`"
            observe-only
            :metric="metric || '-,-'"
            :nodes="nodes"
            :source-uuid="route.nodes[1]?.uuid"
            :source-label="route.nodes[segmentIndex]?.name || `节点 ${segmentIndex + 1}`"
            :target-label="route.nodes[segmentIndex + 1]?.name || `节点 ${segmentIndex + 2}`"
            :segment-index="segmentIndex"
            @status-change="updateRouteSegmentHealth(route.key, segmentIndex, $event)"
            @metrics-change="updateRouteSegmentMetrics(route.key, segmentIndex, $event)"
          />
        </template>
        <template v-for="route in routes" :key="`${route.key}-reliability`">
          <TopologySegmentReliabilityObserver
            v-for="(metric, segmentIndex) in route.metrics.slice(0, Math.max(1, route.nodes.length - 1))"
            :key="`${route.key}-${segmentIndex}-reliability`"
            :metric="metric || '-,-'"
            :nodes="nodes"
            :source-uuid="route.nodes[1]?.uuid"
            :current="routeSegmentMetrics[route.key]?.[segmentIndex]"
            @snapshot-change="updateRouteSegmentReliability(route.key, segmentIndex, $event)"
          />
        </template>
      </div>
    </div>
  </section>
  <section
    v-else-if="appStore.privateFeaturesAllowed"
    :class="embedded ? '' : 'px-4 pb-4'"
    class="relative z-1 scroll-mt-20 pointer-events-auto"
    aria-labelledby="topology-empty-title"
  >
    <div class="transit-panel flex flex-col gap-3 rounded-2xl px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div class="flex min-w-0 items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-lg border border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-600 dark:text-emerald-300">
          <Icon icon="tabler:route-square-2" :width="18" />
        </span>
        <div class="min-w-0">
          <h2 id="topology-empty-title" class="text-sm font-semibold">
            还没有配置线路
          </h2>
          <p class="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-400">
            选入口、线路机和落地机即可添加第一条线路。添加和修改都会立即保存，并自动创建探测任务。
          </p>
        </div>
      </div>
      <button
        type="button"
        class="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.08] px-3 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/[0.13] dark:text-emerald-300"
        @click="managerOpen = true"
      >
        <Icon icon="tabler:plus" :width="15" />
        配置第一条线路
      </button>
    </div>
  </section>
  <IncidentTimelineDialog v-model:open="timelineOpen" />
  <TopologyManagerDialog v-model:open="managerOpen" :nodes="nodes" />
  <TopologyRouteDetailDialog v-model:open="detailOpen" :route="selectedRoute" :nodes="nodes" />
</template>

<style scoped>
.topology-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgb(47 207 155 / 0.22) transparent;
}

.topology-direction-scroll {
  scrollbar-width: none;
}

.topology-direction-scroll::-webkit-scrollbar {
  display: none;
}
</style>
