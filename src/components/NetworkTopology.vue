<script setup lang="ts">
import type { TopologyRouteDetail } from '@/components/TopologyRouteDetailDialog.vue'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { useStorageAsync } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import TopologyEdgeMetric from '@/components/TopologyEdgeMetric.vue'
import TopologyManagerDialog from '@/components/TopologyManagerDialog.vue'
import TopologyProbeSelect from '@/components/TopologyProbeSelect.vue'
import TopologyRouteDetailDialog from '@/components/TopologyRouteDetailDialog.vue'
import TopologyStability from '@/components/TopologyStability.vue'
import { useAppStore } from '@/stores/app'
import { getNodeRole } from '@/utils/nodeRoleHelper'
import { getRegionCode } from '@/utils/regionHelper'
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
  online: boolean
}

const props = withDefaults(defineProps<{ nodes: NodeData[], embedded?: boolean }>(), { embedded: false })
const appStore = useAppStore()
const router = useRouter()
const probeSelections = useStorageAsync<Record<string, string>>('pandaTopologyProbeSelections', {}, localStorage)
const managerOpen = ref(false)
const detailOpen = ref(false)
const selectedRoute = ref<TopologyRouteDetail | null>(null)

const routeGroups = computed(() => splitTopologyGroups(appStore.topologyRoute))
const metricGroups = computed(() => splitTopologyGroups(appStore.topologyMetrics))

function findNode(name: string): NodeData | undefined {
  return props.nodes.find(node => node.name.trim().toLowerCase() === name.trim().toLowerCase())
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

  return {
    key: `route-${routeIndex}`,
    probeStorageKey,
    probeKey,
    nodes,
    metrics,
    online: nodes.every(item => !item.node || item.node.online),
  }
}).filter(route => route.nodes.length >= 2))

const healthyRouteCount = computed(() => routes.value.filter(route => route.online).length)

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
  }
  detailOpen.value = true
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
      <header class="flex h-11 items-center justify-between gap-3 border-b border-white/[0.055] px-4 sm:px-5">
        <div class="flex items-center gap-2">
          <Icon icon="tabler:route" :width="17" class="text-emerald-400" />
          <h2 id="topology-title" class="text-sm font-semibold">
            线路状态
          </h2>
        </div>
        <div class="flex items-center gap-2 text-[10px] text-slate-400 sm:text-[11px]">
          <span>{{ routes.length }} 条线路</span>
          <span class="text-slate-700">·</span>
          <span>{{ healthyRouteCount === routes.length ? '全部正常' : `${routes.length - healthyRouteCount} 条异常` }}</span>
          <span class="size-1.5 rounded-full" :class="healthyRouteCount === routes.length ? 'bg-emerald-400' : 'bg-rose-400'" />
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button"
            class="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-white/8 px-2 text-slate-400 transition-colors hover:border-emerald-400/25 hover:text-slate-200"
            @click="managerOpen = true"
          >
            <Icon icon="tabler:settings" :width="13" />管理
          </button>
        </div>
      </header>

      <div class="topology-scroll overflow-x-auto px-3 pb-2 pt-1 sm:px-4">
        <div class="min-w-[760px]">
          <article
            v-for="route in routes"
            :key="route.key"
            class="group grid min-h-12 grid-cols-[138px_minmax(120px,1fr)_170px_minmax(120px,1fr)_184px_72px] items-center gap-2 border-b border-white/[0.045] px-2 transition-colors last:border-b-0 hover:bg-white/[0.018]"
          >
            <div class="flex min-w-0 items-center gap-2">
              <span class="size-2 shrink-0 rounded-full" :class="route.online ? 'bg-emerald-400' : 'bg-rose-400'" />
              <TopologyProbeSelect
                :model-value="route.probeKey"
                @update:model-value="updateProbe(route, $event)"
              />
            </div>

            <TopologyEdgeMetric :metric="route.metrics[0] || '-,-'" :nodes="nodes" />

            <button
              type="button"
              class="flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
              :disabled="!route.nodes[1]?.node"
              @click="route.nodes[1] && openNode(route.nodes[1])"
            >
              <span class="size-1.5 shrink-0 rounded-full ring-4 ring-[#101820]" :class="route.nodes[1]?.node?.online === false ? 'bg-rose-400' : 'bg-emerald-400'" />
              <img
                v-if="route.nodes[1]?.region"
                :src="`/images/flags/${getRegionCode(route.nodes[1].region)}.svg`"
                :alt="route.nodes[1].region"
                class="h-3.5 w-5 shrink-0 rounded-[2px] object-cover"
              >
              <span class="truncate text-[13px] font-semibold">{{ route.nodes[1]?.name }}</span>
              <span class="shrink-0 text-[10px] text-slate-500">· {{ route.nodes[1]?.role }}</span>
            </button>

            <TopologyEdgeMetric :metric="route.metrics[1] || '-,-'" :nodes="nodes" />

            <button
              type="button"
              class="flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
              :disabled="!route.nodes[2]?.node"
              @click="route.nodes[2] && openNode(route.nodes[2])"
            >
              <span class="size-1.5 shrink-0 rounded-full ring-4 ring-[#101820]" :class="route.nodes[2]?.node?.online === false ? 'bg-rose-400' : 'bg-emerald-400'" />
              <img
                v-if="route.nodes[2]?.region"
                :src="`/images/flags/${getRegionCode(route.nodes[2].region)}.svg`"
                :alt="route.nodes[2].region"
                class="h-3.5 w-5 shrink-0 rounded-[2px] object-cover"
              >
              <span class="truncate text-[13px] font-semibold">{{ route.nodes[2]?.name }}</span>
              <span class="shrink-0 text-[10px] text-slate-500">· {{ route.nodes[2]?.role }}</span>
            </button>

            <button
              type="button"
              class="flex h-8 items-center justify-end gap-1.5 rounded-md px-1 text-left text-slate-500 transition-colors hover:bg-white/[0.035] hover:text-slate-200"
              aria-label="查看线路历史"
              @click="openRouteDetail(route)"
            >
              <TopologyStability :metric="route.metrics[0] || route.metrics[1] || '-,-'" :nodes="nodes" />
              <Icon icon="tabler:chevron-right" :width="13" class="opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </article>
        </div>
      </div>
    </div>
    <TopologyManagerDialog v-model:open="managerOpen" :nodes="nodes" />
    <TopologyRouteDetailDialog v-model:open="detailOpen" :route="selectedRoute" :nodes="nodes" />
  </section>
</template>

<style scoped>
.topology-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgb(47 207 155 / 0.22) transparent;
}
</style>
