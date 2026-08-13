<script setup lang="ts">
import type { TopologyRouteDetail } from '@/components/TopologyRouteDetailDialog.vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteHealth, TopologyRouteScore, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import { Icon } from '@iconify/vue'
import { useMediaQuery, useStorageAsync } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PandaOpsIncidentTimelineDialog from '@/components/PandaOpsIncidentTimelineDialog.vue'
import TopologyEdgeMetric from '@/components/TopologyEdgeMetric.vue'
import TopologyManagerDialog from '@/components/TopologyManagerDialog.vue'
import TopologyProbeSelect from '@/components/TopologyProbeSelect.vue'
import TopologyRouteDetailDialog from '@/components/TopologyRouteDetailDialog.vue'
import { useAppStore } from '@/stores/app'
import { getNodeRole } from '@/utils/nodeRoleHelper'
import { getRegionCode } from '@/utils/regionHelper'
import { calculateTopologyRouteScore } from '@/utils/topologyHealth'
import {
  findTopologyProbeKey,
  formatTopologyMetricForProbe,
  getTopologyProbe,
  parseTopologyMetric,
  parseTopologyNodes,
  splitTopologyGroups,
} from '@/utils/topologyHelper'

interface RouteNode {
  key: string
  name: string
  region: string
  role: string
  node?: NodeData
}

interface RouteRow {
  key: string
  probeStorageKey: string
  probeKey: string
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
const managerOpen = ref(false)
const timelineOpen = ref(false)
const detailOpen = ref(false)
const selectedRoute = ref<TopologyRouteDetail | null>(null)
const routeSegmentHealth = ref<Record<string, Record<number, TopologyRouteHealth>>>({})
const routeSegmentMetrics = ref<Record<string, Record<number, TopologySegmentTelemetry>>>({})
const activeDirection = ref('all')
const isDesktop = useMediaQuery('(min-width: 768px)')

const routeGroups = computed(() => splitTopologyGroups(appStore.topologyRoute))
const metricGroups = computed(() => splitTopologyGroups(appStore.topologyMetrics))

function findNode(name: string): NodeData | undefined {
  return props.nodes.find(node => node.name.trim().toLowerCase() === name.trim().toLowerCase())
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

const routes = computed<RouteRow[]>(() => routeGroups.value.map((group, routeIndex) => {
  const nodes = parseTopologyNodes(group).slice(0, 3).map((config, nodeIndex) => {
    const node = findNode(config.name)
    return {
      key: `${routeIndex}-${nodeIndex}-${config.name}`,
      name: config.name,
      region: node?.region || config.region,
      role: node ? (getNodeRole(node.tags, node.groups) || config.role) : config.role,
      node,
    }
  })
  const metrics = (metricGroups.value[routeIndex] || metricGroups.value[0] || '')
    .split(';')
    .map(metric => metric.trim())
  const configuredFirstMetric = parseTopologyMetric(metrics[0] || '')
  const defaultProbeKey = findTopologyProbeKey(configuredFirstMetric.taskFilter, nodes[0]?.name || '')
  const probeStorageKey = `${nodes[1]?.name || routeIndex}>${nodes[2]?.name || ''}`
  const probeKey = probeSelections.value[probeStorageKey] || defaultProbeKey
  const probe = getTopologyProbe(probeKey)
  metrics[0] = formatTopologyMetricForProbe(metrics[0] || '', probeKey, nodes[1]?.name || '')

  if (nodes[0])
    nodes[0].name = probe.label

  const direction = getRouteDirection(nodes)

  return {
    key: `route-${routeIndex}`,
    probeStorageKey,
    probeKey,
    nodes,
    metrics,
    directionKey: direction.key,
    directionLabel: direction.label,
  }
}).filter(route => route.nodes.length >= 2))

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

watch(directions, (items) => {
  if (activeDirection.value !== 'all' && !items.some(item => item.key === activeDirection.value))
    activeDirection.value = 'all'
})

function getRouteHealth(route: RouteRow): TopologyRouteHealth {
  const configuredNodes = route.nodes.slice(1)
  if (configuredNodes.some(item => item.node?.online === false))
    return 'offline'
  if (configuredNodes.some(item => !item.node))
    return 'error'
  const expectedSegments = Math.max(1, route.nodes.length - 1)
  const states = Array.from({ length: expectedSegments }, (_, index) => routeSegmentHealth.value[route.key]?.[index] ?? 'pending')
  for (const status of ['offline', 'error', 'warning', 'pending'] as const) {
    if (states.includes(status))
      return status
  }
  return 'healthy'
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

function getRouteScore(route: RouteRow): TopologyRouteScore {
  const expectedSegments = Math.max(1, route.nodes.length - 1)
  return calculateTopologyRouteScore({
    segments: Array.from({ length: expectedSegments }, (_, index) => routeSegmentMetrics.value[route.key]?.[index]),
    segmentLabels: Array.from({ length: expectedSegments }, (_, index) => `${route.nodes[index]?.name || `第 ${index + 1} 段`}至${route.nodes[index + 1]?.name || '目标'}`),
    hasOfflineNode: route.nodes.slice(1).some(item => item.node?.online === false),
    hasMissingNode: route.nodes.slice(1).some(item => !item.node),
  })
}

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
  probeSelections.value = { ...probeSelections.value, [route.probeStorageKey]: value }
}

function openRouteDetail(route: RouteRow): void {
  selectedRoute.value = {
    key: route.key,
    nodeNames: route.nodes.map(node => node.name),
    metrics: route.metrics,
    score: getRouteScore(route),
  }
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
</script>

<template>
  <section
    v-if="routes.length"
    :class="embedded ? '' : 'px-4 pb-4'"
    class="relative z-1 scroll-mt-20 pointer-events-auto"
    aria-labelledby="topology-title"
  >
    <div class="panda-panel overflow-hidden rounded-2xl">
      <header class="panda-divider flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2 sm:px-5">
        <div class="flex items-center gap-2">
          <Icon icon="tabler:route" :width="17" class="text-emerald-400" />
          <h2 id="topology-title" class="text-sm font-semibold">
            线路状态
          </h2>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-slate-600 dark:text-slate-400 sm:text-[11px]">
          <span>{{ routes.length }} 条线路</span>
          <span class="text-slate-400 dark:text-slate-700">·</span>
          <span>{{ healthSummary.label }}</span>
          <span class="size-1.5 rounded-full" :class="healthSummary.dot" />
          <button
            type="button"
            data-panda-incident-timeline-button
            class="panda-divider ml-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-slate-600 transition-colors hover:border-emerald-500/30 hover:text-slate-900 dark:text-slate-400 dark:hover:border-emerald-400/25 dark:hover:text-slate-200"
            aria-label="查看异常时间线"
            @click="timelineOpen = true"
          >
            <Icon icon="tabler:timeline-event" :width="13" />
            <span class="hidden sm:inline">事件</span>
          </button>
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button"
            class="panda-divider ml-1 inline-flex h-7 items-center gap-1 rounded-md border px-2 text-slate-600 transition-colors hover:border-emerald-500/30 hover:text-slate-900 dark:text-slate-400 dark:hover:border-emerald-400/25 dark:hover:text-slate-200"
            @click="managerOpen = true"
          >
            <Icon icon="tabler:settings" :width="13" />管理
          </button>
        </div>
      </header>

      <nav
        v-if="directions.length > 1"
        aria-label="线路方向"
        class="panda-divider topology-direction-scroll flex min-w-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:px-4"
      >
        <button
          type="button"
          data-topology-direction
          class="shrink-0 rounded-md border px-2.5 py-1 text-[10px] transition-colors"
          :class="activeDirection === 'all' ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/[0.055] dark:text-emerald-300' : 'panda-divider text-slate-600 hover:text-slate-900 dark:text-slate-500 dark:hover:text-slate-300'"
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
          :class="activeDirection === direction.key ? 'border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/[0.055] dark:text-emerald-300' : 'panda-divider text-slate-600 hover:text-slate-900 dark:text-slate-500 dark:hover:text-slate-300'"
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
            class="panda-divider panda-hover-surface group grid min-h-16 grid-cols-[144px_minmax(190px,1fr)_178px_minmax(190px,1fr)_190px] items-center gap-3 border-b px-2 transition-colors last:border-b-0"
          >
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  data-topology-route-status
                  :data-status="getRouteHealth(route)"
                  class="size-2 shrink-0 rounded-full"
                  :class="routeDotClass(route)"
                />
                <TopologyProbeSelect
                  :model-value="route.probeKey"
                  @update:model-value="updateProbe(route, $event)"
                />
              </div>
              <button
                type="button"
                data-topology-route-score
                class="ml-4 mt-0.5 whitespace-nowrap text-[9px] font-medium tabular-nums transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
                :class="routeScoreClass(route)"
                :aria-label="`线路健康评分 ${getRouteScore(route).score} 分，${getRouteScore(route).label}，查看详情`"
                @click="openRouteDetail(route)"
              >
                {{ getRouteScore(route).score }} 分 {{ getRouteScore(route).label }}
              </button>
            </div>

            <TopologyEdgeMetric
              :metric="route.metrics[0] || '-,-'"
              :nodes="nodes"
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
              <span class="panda-dot-ring size-1.5 shrink-0 rounded-full ring-4" :class="!route.nodes[1]?.node ? 'bg-amber-400' : route.nodes[1].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
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

            <TopologyEdgeMetric
              :metric="route.metrics[1] || '-,-'"
              :nodes="nodes"
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
              <span class="panda-dot-ring size-1.5 shrink-0 rounded-full ring-4" :class="!route.nodes[2]?.node ? 'bg-amber-400' : route.nodes[2].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
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
          </article>
        </div>
      </div>

      <div v-else class="px-3">
        <article
          v-for="route in visibleRoutes"
          :key="route.key"
          data-topology-mobile-route
          class="panda-divider border-b py-3 last:border-b-0"
        >
          <div class="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2">
            <span class="grid place-items-center">
              <span
                data-topology-route-status
                :data-status="getRouteHealth(route)"
                class="panda-dot-ring size-2 rounded-full ring-4"
                :class="routeDotClass(route)"
              />
            </span>
            <TopologyProbeSelect
              :model-value="route.probeKey"
              @update:model-value="updateProbe(route, $event)"
            />
            <button
              type="button"
              data-topology-route-score
              class="whitespace-nowrap text-[9px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60"
              :class="routeScoreClass(route)"
              :aria-label="`线路健康评分 ${getRouteScore(route).score} 分，${getRouteScore(route).label}，查看详情`"
              @click="openRouteDetail(route)"
            >
              {{ getRouteScore(route).score }} {{ getRouteScore(route).label }}
            </button>
          </div>

          <div class="grid grid-cols-[22px_minmax(0,1fr)] gap-2">
            <span class="flex justify-center"><span class="panda-rail h-full w-px" /></span>
            <TopologyEdgeMetric
              mobile
              :metric="route.metrics[0] || '-,-'"
              :nodes="nodes"
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
              <span class="panda-dot-ring size-1.5 rounded-full ring-4" :class="!route.nodes[1]?.node ? 'bg-amber-400' : route.nodes[1].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
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
              <span class="flex justify-center"><span class="panda-rail h-full w-px" /></span>
              <TopologyEdgeMetric
                mobile
                :metric="route.metrics[1] || '-,-'"
                :nodes="nodes"
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
                <span class="panda-dot-ring size-1.5 rounded-full ring-4" :class="!route.nodes[2]?.node ? 'bg-amber-400' : route.nodes[2].node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
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
    </div>
    <PandaOpsIncidentTimelineDialog v-model:open="timelineOpen" />
    <TopologyManagerDialog v-model:open="managerOpen" :nodes="nodes" />
    <TopologyRouteDetailDialog v-model:open="detailOpen" :route="selectedRoute" :nodes="nodes" />
  </section>
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
