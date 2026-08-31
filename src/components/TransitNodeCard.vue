<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import NodeCardInsightPanel from '@/components/NodeCardInsightPanel.vue'
import { ProgressThin } from '@/components/ui/progress-thin'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNodeAlert } from '@/composables/useNodeAlertState'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getConfiguredNodeRole, getNodeRole } from '@/utils/nodeRoleHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
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
const regionCode = computed(() => hasRegion(props.node.region) ? getRegionCode(props.node.region) : '')
</script>

<template>
  <article
    :data-transit-node-card-size="appStore.nodeCardSize"
    :data-node-status-edge="node.online ? '' : undefined"
    :data-node-alert-edge="node.online && visibleAlert ? '' : undefined"
    class="transit-node-card group relative flex h-full min-w-0 flex-col rounded-[20px] p-5 transition-[border-color,box-shadow] duration-200 hover:border-emerald-500/30"
    :style="statusEdgeStyle"
  >
    <button
      type="button"
      class="absolute inset-0 z-0 cursor-pointer rounded-[20px] border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/70"
      :aria-label="`查看节点 ${node.name} 详情`"
      @click="emit('click')"
    />

    <header class="transit-node-card__header pointer-events-none relative z-1 pb-4">
      <div class="flex min-w-0 items-start gap-3">
        <img v-if="regionCode" :src="`/images/flags/${regionCode}.svg`" :alt="getRegionAltText(node.region)" class="mt-0.5 h-6 w-9 shrink-0 rounded-[4px] object-cover">
        <span v-else class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-slate-500/10 text-muted-foreground"><Icon icon="tabler:server" width="20" /></span>
        <div class="min-w-0 flex-1">
          <div data-node-title-row class="flex min-w-0 items-start gap-2">
            <h3 data-node-name class="node-card-name min-w-0 text-lg font-semibold leading-snug tracking-tight text-foreground" :title="node.name">
              {{ node.name }}
            </h3>
          </div>
          <div data-node-status-row class="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4 text-muted-foreground">
            <span v-if="regionCode">{{ getRegionAltText(node.region) }}</span>
            <span v-if="role" data-node-role>· {{ role }}</span>
            <span data-node-status-dot class="ml-0.5 size-1.5 shrink-0 rounded-full" :style="{ background: statusEdgeTone }" />
            <span data-node-uptime :class="isMaintenance && 'font-medium text-amber-700 dark:text-amber-300'">{{ isMaintenance ? '维护中' : node.online ? `在线 ${getUptimeDays(node.uptime)} 天` : '离线' }}</span>
            <span v-if="isSilenced && !isMaintenance" data-node-maintenance-state>已静默</span>
          </div>
        </div>
        <div class="flex shrink-0 flex-col items-end gap-1">
          <span v-if="regionCode" aria-hidden="true" class="node-region-code text-[22px] font-light leading-none tracking-tight text-muted-foreground/70">{{ regionCode }}</span>
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button" data-node-control-button
            class="pointer-events-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-slate-500/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-emerald-500"
            :class="(isMaintenance || isSilenced) && 'text-amber-700 dark:text-amber-300'"
            :aria-label="`管理节点 ${node.name}`"
            :title="isMaintenance ? '维护中' : isSilenced ? '告警已静默' : '节点运维'"
            @click.stop="emit('manage')"
          >
            <Icon :icon="isMaintenance ? 'tabler:tools' : isSilenced ? 'tabler:bell-off' : 'tabler:dots'" width="16" />
          </button>
          <img v-else :src="getOSImage(node.os)" :alt="getOSName(node.os)" class="mt-1 size-3.5 opacity-75">
        </div>
      </div>
      <TooltipProvider v-if="visibleAlert && node.online" :delay-duration="160">
        <Tooltip>
          <TooltipTrigger as-child>
            <button type="button" data-node-alert-reason class="pointer-events-auto mt-3 flex w-full min-w-0 items-start gap-1.5 rounded-md bg-slate-500/5 px-2 py-1.5 text-left text-[11px] font-medium leading-4" :class="alertTone" @click.stop="emit('click')">
              <Icon icon="tabler:alert-circle" width="14" class="mt-px shrink-0" />
              <span class="min-w-0 break-words">{{ visibleAlert.detail }}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent data-node-alert-tooltip side="top" :side-offset="7" class="max-w-[260px] text-[11px] tabular-nums">
            {{ visibleAlert.detail }}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </header>

    <div data-node-card-detail-grid class="pointer-events-none relative z-1 min-w-0 flex-1 border-t border-[var(--transit-divider)] pt-4">
      <NodeCardInsightPanel :node="node" />
    </div>

    <div data-node-resource-grid class="transit-divider pointer-events-none relative z-1 mt-4 grid grid-cols-3 gap-3 border-t pt-3">
      <div class="min-w-0" :title="`Load: ${(node.load ?? 0).toFixed(2)}, ${(node.load5 ?? 0).toFixed(2)}, ${(node.load15 ?? 0).toFixed(2)}`">
        <div class="resource-label">
          <span>CPU</span><strong>{{ (node.cpu ?? 0).toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-2" :percentage="node.cpu" :status="resourceStatus(node.cpu)" :height="3" />
        <span data-node-resource-value class="sr-only">Load {{ (node.load ?? 0).toFixed(2) }}, {{ (node.load5 ?? 0).toFixed(2) }}, {{ (node.load15 ?? 0).toFixed(2) }}</span>
      </div>
      <div class="min-w-0" :title="`${formatBytes(node.ram)} / ${formatBytes(node.mem_total)}`">
        <div class="resource-label">
          <span>内存</span><strong>{{ memoryPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-2" :percentage="memoryPercentage" :status="resourceStatus(memoryPercentage)" :height="3" />
        <span data-node-resource-value class="sr-only">{{ formatBytes(node.ram) }} / {{ formatBytes(node.mem_total) }}</span>
      </div>
      <div class="min-w-0" :title="`${formatBytes(node.disk)} / ${formatBytes(node.disk_total)}`">
        <div class="resource-label">
          <span>硬盘</span><strong>{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-2" :percentage="diskPercentage" :status="resourceStatus(diskPercentage)" :height="3" />
        <span data-node-resource-value class="sr-only">{{ formatBytes(node.disk) }} / {{ formatBytes(node.disk_total) }}</span>
      </div>
    </div>

    <div data-node-network-cell class="transit-divider pointer-events-none relative z-1 mt-3 border-y py-3">
      <div data-node-network-grid class="node-card-network-grid">
        <span data-node-speed-cell class="min-w-0 break-words"><span class="sr-only">上行</span><span aria-hidden="true" class="text-emerald-600 dark:text-emerald-300">↑</span> {{ formatSpeed(node.net_out) }}</span>
        <span class="min-w-0 break-words"><span class="sr-only">下行</span><span aria-hidden="true" class="text-emerald-600 dark:text-emerald-300">↓</span> {{ formatSpeed(node.net_in) }}</span>
        <span data-node-traffic-value class="node-traffic min-w-0 break-words text-[11px] text-muted-foreground">累计 {{ formatBytes(trafficUsed) }}<template v-if="hasTrafficLimit(node)"> / {{ formatBytes(node.traffic_limit) }}</template></span>
      </div>
      <ProgressThin v-if="hasTrafficLimit(node)" class="mt-2" :percentage="trafficPercentage" :status="resourceStatus(trafficPercentage)" :height="2" role="progressbar" aria-label="流量额度" :aria-valuenow="Math.min(100, Math.max(0, trafficPercentage))" :aria-valuetext="`流量已使用 ${trafficPercentage.toFixed(1)}%`" :aria-valuemin="0" :aria-valuemax="100" />
    </div>

    <footer class="pointer-events-none relative z-1 mt-3 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs">
      <span v-if="price" data-node-price class="min-w-0 break-words font-medium text-foreground">{{ price }}</span>
      <div data-node-expiry-row class="flex min-h-[34px] min-w-0 flex-col justify-center gap-0.5 text-[11px] leading-4 text-muted-foreground" :class="expiryStatus === 'expired' && 'text-rose-600 dark:text-rose-400'">
        <span data-node-expiry-text>{{ expiryText }}</span>
        <span v-if="expiryDate" data-node-expiry-date class="text-[10px] tabular-nums">{{ expiryDate }}</span>
      </div>
      <button type="button" class="pointer-events-auto ml-auto inline-flex min-h-8 shrink-0 items-center gap-1 rounded text-emerald-700 hover:underline focus-visible:outline-2 focus-visible:outline-emerald-500 dark:text-emerald-300" :aria-label="`打开 ${node.name} 的详细信息`" @click.stop="emit('click')">
        详情 <Icon icon="tabler:arrow-up-right" width="14" />
      </button>
    </footer>
    <div v-if="tags.length" data-node-tag-row class="pointer-events-none relative z-1 mt-2 flex flex-wrap gap-1">
      <span v-for="tag in tags" :key="tag" class="max-w-full break-words rounded bg-slate-500/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ tag }}</span>
    </div>
    <div v-if="!node.online" data-node-offline-note class="pointer-events-none relative z-1 mt-3 rounded-lg bg-rose-500/5 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
      节点离线 · 最后上报 {{ formatDateTime(node.time) }}
    </div>
  </article>
</template>

<style scoped>
.transit-node-card {
  container-type: inline-size;
}

.transit-node-card__header {
  background: transparent !important;
  border-bottom: 0 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.node-card-name {
  overflow-wrap: anywhere;
}

.resource-label {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.125rem 0.375rem;
  color: var(--transit-text-secondary);
  font-size: 0.6875rem;
}

.resource-label strong {
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--transit-text-primary);
}

.node-card-network-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: var(--transit-text-primary);
}

.node-traffic {
  grid-column: 1 / -1;
}

@container (min-width: 24rem) {
  .node-card-network-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .node-traffic {
    grid-column: auto;
    text-align: right;
  }
}

@container (max-width: 19rem) {
  .node-region-code {
    display: none;
  }
  [data-node-resource-grid] {
    gap: 0.5rem;
  }
}

.transit-node-card[data-transit-node-card-size='mini'] {
  padding: 1rem;
}
.transit-node-card[data-transit-node-card-size='comfortable'],
.transit-node-card[data-transit-node-card-size='large'] {
  padding: 1.5rem;
}
</style>
