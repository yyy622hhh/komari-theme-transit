<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue/offline'
import { computed } from 'vue'
import NodeCardInsightPanel from '@/components/NodeCardInsightPanel.vue'
import NodeRoutePanel from '@/components/NodeRoutePanel.vue'
import { ProgressThin } from '@/components/ui/progress-thin'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNodeAlert } from '@/composables/useNodeAlertState'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getConfiguredNodeRole, getNodeRole } from '@/utils/nodeRoleHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { resolveNodeRouteTag } from '@/utils/routeProbeResults'
import { parseNodeRouteTag } from '@/utils/routeTag'
import { formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, isFreePrice, parseTags } from '@/utils/tagHelper'

const props = defineProps<{ node: NodeData }>()
const emit = defineEmits<{ click: [], manage: [] }>()
const appStore = useAppStore()
const nodeControl = computed(() => appStore.nodeControls[props.node.uuid])
const isMaintenance = computed(() => Boolean(nodeControl.value?.maintenanceUntil))
const isSilenced = computed(() => Boolean(nodeControl.value?.silenceUntil))

const memoryPercentage = computed(() => getMemoryPercentage(props.node))
const diskPercentage = computed(() => getDiskPercentage(props.node))
const trafficUsed = computed(() => getTrafficUsed(props.node))
const trafficPercentage = computed(() => getTrafficUsedPercentage(props.node))
const showPrice = computed(() => appStore.isLoggedIn || !appStore.hidePriceWhenLoggedOut)
const role = computed(() => getNodeRole(props.node.tags, props.node.groups)
  ?? getConfiguredNodeRole(props.node.name, appStore.topologyRoute))
const effectiveRouteTag = computed(() => resolveNodeRouteTag(
  props.node.uuid,
  props.node.tags,
  appStore.routeProbeResults,
))
/** 有回程数据时右边那一格才存在，没有的话网络概览独占整行。 */
const hasReturnRoute = computed(() => parseNodeRouteTag(effectiveRouteTag.value) !== null)
const tags = computed(() => parseTags(props.node.tags)
  .map(tag => tag.text)
  .filter(tag => tag !== role.value)
  .slice(0, 5))

const price = computed(() => {
  if (!showPrice.value || props.node.price === 0)
    return ''
  if (isFreePrice(props.node.price))
    return appStore.lang === 'zh-CN' ? '免费' : 'Free'
  return props.node.price > 0
    ? formatPriceWithCycle(props.node.price, props.node.billing_cycle, props.node.currency, appStore.lang)
    : ''
})
const expiryStatus = computed(() => getExpireStatus(props.node.expired_at))
const expiryDays = computed(() => getDaysUntilExpired(props.node.expired_at))
const expiryText = computed(() => {
  if (expiryStatus.value === 'unknown')
    return '未设置到期'
  if (expiryStatus.value === 'expired')
    return '已过期'
  if (expiryStatus.value === 'long_term')
    return '长期'
  return `剩余 ${Math.max(0, expiryDays.value)} 天`
})
const expiryDate = computed(() => expiryStatus.value === 'unknown' || expiryStatus.value === 'long_term'
  ? ''
  : formatDateTime(props.node.expired_at, 'YYYY-MM-DD'))

const primaryAlert = useNodeAlert(() => props.node.uuid)
const visibleAlert = computed(() => isMaintenance.value ? null : primaryAlert.value)
const formatBytes = (value: number) => formatBytesWithConfig(value, appStore.byteDecimals)
const formatSpeed = (value: number) => formatBytesPerSecondWithConfig(value, appStore.byteDecimals)

function hasRegion(region: string | null | undefined): boolean {
  return Boolean(region?.trim())
}

function getRegionAltText(region: string): string {
  return getRegionDisplayName(region) || getRegionCode(region)
}

function resourceStatus(value: number) {
  return getStatus(value)
}

const alertTone = computed(() => visibleAlert.value?.severity === 'critical'
  ? 'text-rose-600 dark:text-rose-400'
  : 'text-amber-700 dark:text-amber-300')
const statusEdgeTone = computed(() => {
  if (!props.node.online)
    return 'var(--destructive)'
  if (isMaintenance.value)
    return 'var(--warning)'
  if (visibleAlert.value?.severity === 'critical')
    return 'var(--destructive)'
  if (visibleAlert.value)
    return 'var(--warning)'
  return 'var(--success)'
})
const statusEdgeStyle = computed(() => ({ '--node-status-tone': statusEdgeTone.value }))
</script>

<template>
  <article
    :data-transit-node-card-size="appStore.nodeCardSize"
    :data-node-status-edge="node.online ? '' : undefined"
    :data-node-alert-edge="node.online && visibleAlert ? '' : undefined"
    class="transit-node-card group relative h-full min-w-0 cursor-pointer overflow-hidden rounded-2xl p-3 pl-5.5 transition duration-200 hover:-translate-y-px hover:border-emerald-400/25"
    :class="!node.online ? 'opacity-75' : ''"
    :style="statusEdgeStyle"
  >
    <span aria-hidden="true" data-node-status-rail class="transit-node-card__status-rail" />

    <button
      type="button"
      class="absolute inset-0 z-0 cursor-pointer rounded-2xl border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400/70"
      :aria-label="`查看节点 ${node.name} 详情`"
      @click="emit('click')"
    />

    <header class="transit-node-card__header pointer-events-none relative z-1 min-h-[2.65rem]">
      <div class="flex min-w-0 items-start justify-between gap-3">
        <div data-node-title-row class="relative flex min-w-0 flex-1 items-baseline gap-2">
          <span data-node-status-dot class="absolute -left-2.5 top-[0.4rem] size-1.5 rounded-full" :class="isMaintenance ? 'bg-amber-400' : node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
          <h3
            data-node-name
            class="node-card-name min-w-0 text-[15px] font-semibold leading-[1.25] tracking-[-0.01em] text-slate-900 dark:text-slate-100"
            :title="node.name"
            :aria-label="node.name"
          >
            {{ node.name }}
          </h3>
          <span v-if="role" data-node-role class="shrink-0 text-[10px] leading-[1.25] text-slate-500 dark:text-slate-400">· {{ role }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button"
            data-node-control-button
            class="pointer-events-auto grid size-6 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-500/10 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 dark:text-slate-400 dark:hover:text-slate-200"
            :class="(isMaintenance || isSilenced) && 'text-amber-700 dark:text-amber-300'"
            :aria-label="`管理节点 ${node.name}`"
            :title="isMaintenance ? '维护中' : isSilenced ? '告警已静默' : '节点运维'"
            @click.stop="emit('manage')"
          >
            <Icon :icon="isMaintenance ? 'tabler:tools' : isSilenced ? 'tabler:bell-off' : 'tabler:dots'" :width="14" />
          </button>
          <img :src="getOSImage(node.os)" :alt="getOSName(node.os)" class="size-3.5 opacity-75">
          <img
            v-if="hasRegion(node.region)"
            :src="`/images/flags/${getRegionCode(node.region)}.svg`"
            :alt="getRegionAltText(node.region)"
            class="h-4 w-6 rounded-[2px] object-cover"
          >
        </div>
      </div>
      <div data-node-status-row class="mt-1.5 flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span data-node-uptime class="break-words" :class="isMaintenance && 'font-medium text-amber-700 dark:text-amber-300'">
            {{ isMaintenance ? '维护中' : node.online ? `在线 ${getUptimeDays(node.uptime)} 天` : '离线' }}
          </span>
          <span v-if="price" data-node-price class="break-words">{{ price }}</span>
          <span v-if="isSilenced && !isMaintenance" data-node-maintenance-state class="break-words font-medium text-slate-600 dark:text-slate-300">已静默</span>
        </div>
        <TooltipProvider v-if="visibleAlert && node.online" :delay-duration="160">
          <Tooltip>
            <TooltipTrigger as-child>
              <span
                data-node-alert-reason
                class="pointer-events-auto flex min-w-0 max-w-full items-center gap-1.5 font-medium tabular-nums"
                :class="alertTone"
                @click="emit('click')"
              >
                <span class="size-1.5 shrink-0 rounded-full bg-current" />
                <span class="truncate">{{ visibleAlert.detail }}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent data-node-alert-tooltip side="top" :side-offset="7" class="max-w-[260px] text-[10px] tabular-nums">
              {{ visibleAlert.detail }}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>

    <div data-node-resource-grid class="transit-divider pointer-events-none relative z-1 mt-2.5 grid grid-cols-3 gap-2.5 border-y py-2">
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500 dark:text-slate-400">CPU</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ (node.cpu ?? 0).toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="node.cpu" :status="resourceStatus(node.cpu)" :height="3" />
        <div data-node-resource-value class="mt-1 break-words text-[10px] leading-tight tabular-nums text-slate-500 dark:text-slate-400">
          {{ (node.load ?? 0).toFixed(2) }}, {{ (node.load5 ?? 0).toFixed(2) }}, {{ (node.load15 ?? 0).toFixed(2) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500 dark:text-slate-400">内存</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ memoryPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="memoryPercentage" :status="resourceStatus(memoryPercentage)" :height="3" />
        <div data-node-resource-value class="mt-1 break-words text-[10px] leading-tight tabular-nums text-slate-500 dark:text-slate-400">
          {{ formatBytes(node.ram) }} / {{ formatBytes(node.mem_total) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500 dark:text-slate-400">硬盘</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="diskPercentage" :status="resourceStatus(diskPercentage)" :height="3" />
        <div data-node-resource-value class="mt-1 break-words text-[10px] leading-tight tabular-nums text-slate-500 dark:text-slate-400">
          {{ formatBytes(node.disk) }} / {{ formatBytes(node.disk_total) }}
        </div>
      </div>
    </div>

    <div data-node-card-detail-grid class="node-card-detail-grid pointer-events-none relative z-1 mt-2 grid gap-1.5">
      <!--
        网络概览：上下行、累计流量和到期并成一格，让右边空出位置给三网回程。
        没有回程数据时这一格独占整行，不留半格空白。
      -->
      <div
        data-node-network-cell
        class="node-card-cell min-w-0 overflow-hidden p-0 text-[10px]"
        :class="!hasReturnRoute && 'node-card-cell--full'"
      >
        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 text-slate-500 dark:text-slate-400">
          <span>网络概览</span>
          <span v-if="hasTrafficLimit(node)" class="shrink-0 tabular-nums">{{ trafficPercentage.toFixed(1) }}%</span>
        </div>

        <!-- 四项一组：半宽时排成 2×2，整行时摊成一排，不留大片空白 -->
        <div data-node-network-grid class="node-card-network-grid grid">
          <div data-node-speed-cell class="min-w-0 px-2.5 py-1.5">
            <div class="text-slate-500 dark:text-slate-400">
              上行
            </div>
            <div class="mt-0.5 break-words text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">
              ↑ {{ formatSpeed(node.net_out) }}
            </div>
          </div>
          <div class="min-w-0 px-2.5 py-1.5">
            <div class="text-slate-500 dark:text-slate-400">
              下行
            </div>
            <div class="mt-0.5 break-words text-[10px] tabular-nums text-slate-700 dark:text-slate-300">
              ↓ {{ formatSpeed(node.net_in) }}
            </div>
          </div>
          <div class="min-w-0 px-2.5 py-1.5">
            <div class="text-slate-500 dark:text-slate-400">
              累计
            </div>
            <div data-node-traffic-value class="mt-0.5 break-words text-[10px] font-medium leading-tight tabular-nums text-slate-700 dark:text-slate-200">
              {{ formatBytes(trafficUsed) }}<template v-if="hasTrafficLimit(node)">
                / {{ formatBytes(node.traffic_limit) }}
              </template>
            </div>
          </div>
          <div class="min-w-0 px-2.5 py-1.5">
            <div class="text-slate-500 dark:text-slate-400">
              到期
            </div>
            <div data-node-expiry-row class="mt-0.5 flex h-[1.65rem] min-w-0 flex-col items-start gap-y-0.5 text-slate-500 dark:text-slate-400">
              <span data-node-expiry-text class="max-w-full whitespace-nowrap">{{ expiryText }}</span>
              <span v-if="expiryDate" data-node-expiry-date class="max-w-full whitespace-nowrap text-[9px] tabular-nums">{{ expiryDate }}</span>
            </div>
          </div>
        </div>
      </div>

      <NodeRoutePanel :tags="effectiveRouteTag" />

      <NodeCardInsightPanel :node="node" />
    </div>

    <footer v-if="tags.length" data-node-tag-row class="pointer-events-none relative z-1 mt-2.5 flex min-w-0 items-center gap-1 overflow-hidden">
      <span v-for="tag in tags" :key="tag" class="transit-divider shrink-0 rounded-full border px-2 py-0.5 text-[10px] text-slate-500 dark:text-slate-400">
        {{ tag }}
      </span>
    </footer>

    <div v-if="!node.online" class="pointer-events-none absolute inset-0 z-2 grid place-items-center bg-slate-200/70 backdrop-blur-[1px] dark:bg-[#080c11]/55">
      <div class="rounded-lg border border-rose-500/20 bg-white/90 px-3 py-2 text-center dark:border-rose-400/20 dark:bg-[#11161d]">
        <div class="text-xs font-semibold text-rose-600 dark:text-rose-400">
          离线
        </div>
        <div class="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
          {{ formatDateTime(node.time) }}
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.transit-node-card__header {
  background: transparent !important;
  border-bottom: 0 !important;
  backdrop-filter: none !important;
}

.transit-node-card {
  container-type: inline-size;
  isolation: isolate;
}

.transit-node-card::after {
  position: absolute;
  z-index: 0;
  inset: 1px;
  border-radius: calc(1rem - 1px);
  background: linear-gradient(135deg, rgb(255 255 255 / 0.09), transparent 32%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.1);
  content: '';
  pointer-events: none;
}

.transit-node-card__status-rail {
  position: absolute;
  z-index: 3;
  inset-block: 0;
  inset-inline-start: 0;
  width: 0.4375rem;
  pointer-events: none;
  background: var(--node-status-tone);
  box-shadow: inset -1px 0 0 rgb(255 255 255 / 0.18);
}

.node-card-name {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.node-card-detail-grid {
  grid-template-columns: minmax(0, 1fr);
}

.node-card-cell {
  border: 1px solid var(--transit-divider);
  border-radius: 0.65rem;
  background: var(--transit-cell-bg);
}

/* 上行/下行/累计/到期默认 2×2；只有在卡片本身够宽、且这一格独占整行时才摊成一排。
   `--full` 只说明这个节点没有回程数据，不代表容器很宽——不加宽度条件的话，窄卡上
   会得到四个五十几像素的窄列。 */
.node-card-network-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-top: 1px solid var(--transit-divider);
}

.node-card-network-grid > div:nth-child(odd) {
  border-right: 1px solid var(--transit-divider);
}

.node-card-network-grid > div:nth-child(-n + 2) {
  border-bottom: 1px solid var(--transit-divider);
}

/*
 * 两列：网络概览 | 三网回程，三网质量占满整行。
 * 三网质量是一整排采样格，挤进半列会读不出来，所以不像以前那样在宽卡上并成三列。
 */
@container (min-width: 22rem) {
  .node-card-detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  [data-node-insight-panel],
  .node-card-cell--full {
    grid-column: 1 / -1;
  }

  .node-card-cell--full .node-card-network-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .node-card-cell--full .node-card-network-grid > div {
    border-bottom: 0;
    border-right: 1px solid var(--transit-divider);
  }

  .node-card-cell--full .node-card-network-grid > div:last-child {
    border-right: 0;
  }
}

@container (min-width: 35rem) {
  .node-card-detail-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  }
}

@container (max-width: 21rem) {
  .transit-node-card__header > div:first-child {
    gap: 0.5rem;
  }

  [data-node-resource-grid] {
    gap: 0.45rem;
  }

  [data-node-resource-value] {
    font-size: 0.5625rem;
  }

  .node-card-cell {
    padding-inline: 0.6rem;
  }
}

.transit-node-card[data-transit-node-card-size='mini'] {
  padding: 0.75rem;
  padding-left: 1.375rem;
}

.transit-node-card[data-transit-node-card-size='mini'] [data-node-resource-grid] {
  gap: 0.55rem;
}

.transit-node-card[data-transit-node-card-size='mini'] footer {
  display: none;
}

.transit-node-card[data-transit-node-card-size='comfortable'] {
  padding: 1rem;
  padding-left: 1.625rem;
}

.transit-node-card[data-transit-node-card-size='large'] {
  padding: 1.1rem;
  padding-left: 1.75rem;
}
</style>
