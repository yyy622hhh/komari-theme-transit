<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import CarrierPingSamples from '@/components/CarrierPingSamples.vue'
import { ProgressThin } from '@/components/ui/progress-thin'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { usePandaOpsNodeAlert } from '@/composables/usePandaOpsAlertState'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getConfiguredNodeRole, getNodeRole } from '@/utils/nodeRoleHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, parseTags } from '@/utils/tagHelper'

const props = defineProps<{ node: NodeData }>()
const emit = defineEmits<{ click: [], manage: [] }>()
const appStore = useAppStore()
const nodeControl = computed(() => appStore.pandaOpsNodeControls[props.node.uuid])
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

const price = computed(() => props.node.price > 0 && showPrice.value
  ? formatPriceWithCycle(props.node.price, props.node.billing_cycle, props.node.currency, appStore.lang)
  : '')
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

const { carrierDisplays, carrierScopeLabel, stale: carrierStatsStale } = useNodeCarrierPingDisplay(() => props.node.uuid)
const primaryAlert = usePandaOpsNodeAlert(() => props.node.uuid)
const visibleAlert = computed(() => isMaintenance.value ? null : primaryAlert.value)
const formatBytes = (value: number) => formatBytesWithConfig(value, appStore.byteDecimals)
const formatSpeed = (value: number) => formatBytesPerSecondWithConfig(value, appStore.byteDecimals)

function resourceStatus(value: number) {
  return getStatus(value)
}

function lossTone(loss: string): string {
  const value = Number.parseFloat(loss)
  if (!Number.isFinite(value) || value <= 1)
    return 'text-slate-700 dark:text-slate-300'
  if (value <= 3)
    return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-600 dark:text-rose-400'
}

const alertTone = computed(() => visibleAlert.value?.severity === 'critical'
  ? 'text-rose-600 dark:text-rose-400'
  : 'text-amber-700 dark:text-amber-300')
const statusEdgeTone = computed(() => {
  if (isMaintenance.value)
    return 'bg-amber-500/90 dark:bg-amber-300/80'
  if (visibleAlert.value?.severity === 'critical')
    return 'bg-rose-500/85 dark:bg-rose-400/75'
  if (visibleAlert.value)
    return 'bg-amber-500/90 dark:bg-amber-300/80'
  return 'bg-emerald-500/85 dark:bg-emerald-400/75'
})
</script>

<template>
  <article
    :data-panda-node-card-size="appStore.nodeCardSize"
    class="panda-node-card group relative h-full min-w-0 cursor-pointer overflow-hidden rounded-2xl p-3.5 transition duration-200 hover:-translate-y-px hover:border-emerald-400/25"
    :class="!node.online ? 'opacity-75' : ''"
  >
    <button
      type="button"
      class="absolute inset-0 z-0 cursor-pointer rounded-2xl border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-400/70"
      :aria-label="`查看节点 ${node.name} 详情`"
      @click="emit('click')"
    />

    <span
      v-if="node.online"
      data-node-status-edge
      :data-node-alert-edge="visibleAlert ? '' : undefined"
      class="pointer-events-none absolute inset-y-3 left-0 z-1 w-0.5 rounded-r-full"
      :class="statusEdgeTone"
    />

    <header class="panda-node-card__header pointer-events-none relative z-1 min-h-[2.65rem]">
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2">
          <span class="size-2.5 shrink-0 rounded-full" :class="isMaintenance ? 'bg-amber-400' : node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
          <h3 class="truncate text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
            {{ node.name }}
          </h3>
          <span v-if="role" class="shrink-0 text-[10px] text-slate-500">· {{ role }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button
            v-if="appStore.privateFeaturesAllowed"
            type="button"
            data-node-control-button
            class="pointer-events-auto grid size-6 place-items-center rounded-md text-slate-500 transition-colors hover:bg-slate-500/10 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 dark:hover:text-slate-200"
            :class="(isMaintenance || isSilenced) && 'text-amber-700 dark:text-amber-300'"
            :aria-label="`管理节点 ${node.name}`"
            :title="isMaintenance ? '维护中' : isSilenced ? '告警已静默' : '节点运维'"
            @click.stop="emit('manage')"
          >
            <Icon :icon="isMaintenance ? 'tabler:tools' : isSilenced ? 'tabler:bell-off' : 'tabler:dots'" :width="14" />
          </button>
          <img :src="getOSImage(node.os)" :alt="getOSName(node.os)" class="size-3.5 opacity-75">
          <img
            v-if="node.region"
            :src="`/images/flags/${getRegionCode(node.region)}.svg`"
            :alt="getRegionDisplayName(node.region)"
            class="h-4 w-6 rounded-[2px] object-cover"
          >
        </div>
      </div>
      <div class="mt-1.5 flex min-w-0 items-center justify-between gap-3 text-[10px] text-slate-500">
        <div class="flex min-w-0 shrink-0 items-center gap-2">
          <span :class="isMaintenance && 'font-medium text-amber-700 dark:text-amber-300'">
            {{ isMaintenance ? '维护中' : node.online ? `在线 ${getUptimeDays(node.uptime)} 天` : '离线' }}
          </span>
          <span v-if="price">{{ price }}</span>
          <span v-if="isSilenced && !isMaintenance" class="font-medium text-slate-600 dark:text-slate-300">已静默</span>
        </div>
        <TooltipProvider v-if="visibleAlert && node.online" :delay-duration="160">
          <Tooltip>
            <TooltipTrigger as-child>
              <span
                data-node-alert-reason
                class="pointer-events-auto flex min-w-0 max-w-[58%] items-center gap-1.5 font-medium tabular-nums"
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

    <div data-node-resource-grid class="panda-divider pointer-events-none relative z-1 mt-3 grid grid-cols-3 gap-3 border-y py-2.5">
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">CPU</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ node.cpu.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="node.cpu" :status="resourceStatus(node.cpu)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-500 dark:text-slate-600">
          {{ node.load.toFixed(2) }}, {{ node.load5.toFixed(2) }}, {{ node.load15.toFixed(2) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">内存</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ memoryPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="memoryPercentage" :status="resourceStatus(memoryPercentage)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-500 dark:text-slate-600">
          {{ formatBytes(node.ram) }} / {{ formatBytes(node.mem_total) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">硬盘</span>
          <strong class="font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="diskPercentage" :status="resourceStatus(diskPercentage)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-500 dark:text-slate-600">
          {{ formatBytes(node.disk) }} / {{ formatBytes(node.disk_total) }}
        </div>
      </div>
    </div>

    <div class="pointer-events-none relative z-1 mt-2.5 grid grid-cols-[0.78fr_0.92fr_1.65fr] gap-2">
      <div class="node-card-cell flex flex-col justify-center px-2.5 py-2 text-[10px] tabular-nums">
        <span class="text-emerald-600 dark:text-emerald-400">↑ {{ formatSpeed(node.net_out) }}</span>
        <span class="mt-1 text-slate-700 dark:text-slate-300">↓ {{ formatSpeed(node.net_in) }}</span>
      </div>

      <div class="node-card-cell min-w-0 px-2.5 py-2 text-[9px]">
        <div class="flex items-center justify-between gap-2 text-slate-500">
          <span>累计流量</span>
          <span v-if="hasTrafficLimit(node)" class="tabular-nums">{{ trafficPercentage.toFixed(1) }}%</span>
        </div>
        <div class="mt-1 truncate text-[10px] font-medium tabular-nums text-slate-700 dark:text-slate-200">
          {{ formatBytes(trafficUsed) }}<template v-if="hasTrafficLimit(node)">
            / {{ formatBytes(node.traffic_limit) }}
          </template>
        </div>
        <div class="mt-1 flex min-w-0 items-center justify-between gap-1 text-slate-500">
          <span class="min-w-0 truncate">{{ expiryText }}</span>
          <span v-if="expiryDate" data-node-expiry-date class="shrink-0 whitespace-nowrap text-[8px] tabular-nums">{{ expiryDate }}</span>
        </div>
      </div>

      <div class="node-card-cell min-w-0 px-2.5 py-1.5">
        <div class="mb-1 flex items-center justify-between text-[9px] text-slate-500">
          <span>三网质量</span><span :class="carrierStatsStale && 'text-amber-700 dark:text-amber-300'">{{ carrierStatsStale ? `${carrierScopeLabel} 数据过期` : carrierScopeLabel }}</span>
        </div>
        <div class="space-y-1">
          <div v-for="carrier in carrierDisplays" :key="carrier.key" class="grid grid-cols-[26px_1fr_38px_34px] items-center gap-1 text-[8px] leading-none">
            <span class="flex items-center gap-1 text-slate-500"><i class="size-1.5 rounded-full" :class="carrier.dotClass" />{{ carrier.label }}</span>
            <CarrierPingSamples
              :bars="carrier.latencyBars.slice(-12)"
              :label="`${carrier.label}延迟`"
            />
            <strong class="text-right font-medium tabular-nums text-slate-700 dark:text-slate-200">{{ carrier.latencyDisplay.replace(' ms', '') }}</strong>
            <strong class="text-right font-medium tabular-nums" :class="lossTone(carrier.lossDisplay)">{{ carrier.lossDisplay }}</strong>
          </div>
        </div>
      </div>
    </div>

    <footer v-if="tags.length" class="pointer-events-none relative z-1 mt-2.5 flex min-w-0 gap-1 overflow-hidden">
      <span v-for="tag in tags" :key="tag" class="panda-divider shrink-0 rounded-full border px-2 py-0.5 text-[9px] text-slate-500">
        {{ tag }}
      </span>
    </footer>

    <div v-if="!node.online" class="pointer-events-none absolute inset-0 z-2 grid place-items-center bg-slate-200/70 backdrop-blur-[1px] dark:bg-[#080c11]/55">
      <div class="rounded-lg border border-rose-500/20 bg-white/90 px-3 py-2 text-center dark:border-rose-400/20 dark:bg-[#11161d]">
        <div class="text-xs font-semibold text-rose-600 dark:text-rose-400">
          离线
        </div>
        <div class="mt-1 text-[9px] text-slate-500">
          {{ formatDateTime(node.time) }}
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.panda-node-card__header {
  background: transparent !important;
  border-bottom: 0 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.node-card-cell {
  border: 1px solid var(--panda-divider);
  border-radius: 0.65rem;
  background: var(--panda-cell-bg);
}

.panda-node-card[data-panda-node-card-size='mini'] {
  padding: 0.75rem;
}

.panda-node-card[data-panda-node-card-size='mini'] [data-node-resource-grid] {
  gap: 0.55rem;
}

.panda-node-card[data-panda-node-card-size='mini'] footer {
  display: none;
}

.panda-node-card[data-panda-node-card-size='comfortable'] {
  padding: 1rem;
}

.panda-node-card[data-panda-node-card-size='large'] {
  padding: 1.1rem;
}
</style>
