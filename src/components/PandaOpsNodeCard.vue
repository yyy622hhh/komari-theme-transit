<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { computed } from 'vue'
import { ProgressThin } from '@/components/ui/progress-thin'
import { useNodeCarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import { useAppStore } from '@/stores/app'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig, formatDateTime, getStatus, getUptimeDays } from '@/utils/helper'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsed, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'
import { getConfiguredNodeRole, getNodeRole } from '@/utils/nodeRoleHelper'
import { getOSImage, getOSName } from '@/utils/osImageHelper'
import { getRegionCode, getRegionDisplayName } from '@/utils/regionHelper'
import { formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, parseTags } from '@/utils/tagHelper'

const props = defineProps<{ node: NodeData }>()
const emit = defineEmits<{ click: [] }>()
const appStore = useAppStore()

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

const { carrierDisplays, carrierScopeLabel } = useNodeCarrierPingDisplay(() => props.node.uuid)
const formatBytes = (value: number) => formatBytesWithConfig(value, appStore.byteDecimals)
const formatSpeed = (value: number) => formatBytesPerSecondWithConfig(value, appStore.byteDecimals)

function handleKeyboardOpen(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ')
    return
  event.preventDefault()
  emit('click')
}

function resourceStatus(value: number) {
  return getStatus(value)
}

function lossTone(loss: string): string {
  const value = Number.parseFloat(loss)
  if (!Number.isFinite(value) || value <= 1)
    return 'text-slate-300'
  if (value <= 3)
    return 'text-amber-300'
  return 'text-rose-400'
}
</script>

<template>
  <article
    class="panda-node-card group relative min-w-0 cursor-pointer overflow-hidden rounded-2xl p-3.5 transition duration-200 hover:-translate-y-px hover:border-emerald-400/25"
    :class="!node.online ? 'opacity-75' : ''"
    role="button"
    tabindex="0"
    :aria-label="`查看节点 ${node.name} 详情`"
    @click="emit('click')"
    @keydown="handleKeyboardOpen"
  >
    <header class="panda-node-card__header flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2">
          <span class="size-2.5 shrink-0 rounded-full" :class="node.online ? 'bg-emerald-400' : 'bg-rose-400'" />
          <h3 class="truncate text-[15px] font-semibold tracking-[-0.01em] text-slate-100">
            {{ node.name }}
          </h3>
          <span v-if="role" class="shrink-0 text-[10px] text-slate-500">· {{ role }}</span>
        </div>
        <div class="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500">
          <span>{{ node.online ? `在线 ${getUptimeDays(node.uptime)} 天` : '离线' }}</span>
          <span v-if="price">{{ price }}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <img :src="getOSImage(node.os)" :alt="getOSName(node.os)" class="size-3.5 opacity-75">
        <img
          v-if="node.region"
          :src="`/images/flags/${getRegionCode(node.region)}.svg`"
          :alt="getRegionDisplayName(node.region)"
          class="h-4 w-6 rounded-[2px] object-cover"
        >
      </div>
    </header>

    <div class="mt-3 grid grid-cols-3 gap-3 border-y border-white/[0.055] py-2.5">
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">CPU</span>
          <strong class="font-medium tabular-nums text-slate-200">{{ node.cpu.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="node.cpu" :status="resourceStatus(node.cpu)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-600">
          {{ node.load.toFixed(2) }}, {{ node.load5.toFixed(2) }}, {{ node.load15.toFixed(2) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">内存</span>
          <strong class="font-medium tabular-nums text-slate-200">{{ memoryPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="memoryPercentage" :status="resourceStatus(memoryPercentage)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-600">
          {{ formatBytes(node.ram) }} / {{ formatBytes(node.mem_total) }}
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2 text-[10px]">
          <span class="text-slate-500">硬盘</span>
          <strong class="font-medium tabular-nums text-slate-200">{{ diskPercentage.toFixed(1) }}%</strong>
        </div>
        <ProgressThin class="mt-1.5" :percentage="diskPercentage" :status="resourceStatus(diskPercentage)" :height="3" />
        <div class="mt-1 truncate text-[9px] tabular-nums text-slate-600">
          {{ formatBytes(node.disk) }} / {{ formatBytes(node.disk_total) }}
        </div>
      </div>
    </div>

    <div class="mt-2.5 grid grid-cols-[0.78fr_0.92fr_1.65fr] gap-2">
      <div class="node-card-cell flex flex-col justify-center px-2.5 py-2 text-[10px] tabular-nums">
        <span class="text-emerald-400">↑ {{ formatSpeed(node.net_out) }}</span>
        <span class="mt-1 text-slate-300">↓ {{ formatSpeed(node.net_in) }}</span>
      </div>

      <div class="node-card-cell min-w-0 px-2.5 py-2 text-[9px]">
        <div class="flex items-center justify-between gap-2 text-slate-500">
          <span>累计流量</span>
          <span v-if="hasTrafficLimit(node)" class="tabular-nums">{{ trafficPercentage.toFixed(1) }}%</span>
        </div>
        <div class="mt-1 truncate text-[10px] font-medium tabular-nums text-slate-200">
          {{ formatBytes(trafficUsed) }}<template v-if="hasTrafficLimit(node)">
            / {{ formatBytes(node.traffic_limit) }}
          </template>
        </div>
        <div class="mt-1 flex items-center justify-between gap-2 text-slate-500">
          <span>{{ expiryText }}</span>
          <span v-if="expiryDate" class="truncate">{{ expiryDate }}</span>
        </div>
      </div>

      <div class="node-card-cell min-w-0 px-2.5 py-1.5">
        <div class="mb-1 flex items-center justify-between text-[9px] text-slate-500">
          <span>三网质量</span><span>{{ carrierScopeLabel }}</span>
        </div>
        <div class="space-y-1">
          <div v-for="carrier in carrierDisplays" :key="carrier.key" class="grid grid-cols-[26px_1fr_38px_34px] items-center gap-1 text-[8px] leading-none">
            <span class="flex items-center gap-1 text-slate-500"><i class="size-1.5 rounded-full" :class="carrier.dotClass" />{{ carrier.label }}</span>
            <span class="grid h-1 grid-flow-col auto-cols-fr gap-px overflow-hidden rounded-sm">
              <i v-for="bar in carrier.latencyBars.slice(-12)" :key="bar.key" class="block h-full" :class="bar.className" :title="bar.tooltip" />
            </span>
            <strong class="text-right font-medium tabular-nums text-slate-200">{{ carrier.latencyDisplay.replace(' ms', '') }}</strong>
            <strong class="text-right font-medium tabular-nums" :class="lossTone(carrier.lossDisplay)">{{ carrier.lossDisplay }}</strong>
          </div>
        </div>
      </div>
    </div>

    <footer v-if="tags.length" class="mt-2.5 flex min-w-0 gap-1 overflow-hidden">
      <span v-for="tag in tags" :key="tag" class="shrink-0 rounded-full border border-white/[0.07] px-2 py-0.5 text-[9px] text-slate-500">
        {{ tag }}
      </span>
    </footer>

    <div v-if="!node.online" class="absolute inset-0 grid place-items-center bg-[#080c11]/55 backdrop-blur-[1px]">
      <div class="rounded-lg border border-rose-400/20 bg-[#11161d] px-3 py-2 text-center">
        <div class="text-xs font-semibold text-rose-400">
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
.panda-node-card {
  border: 1px solid rgb(41 49 61 / 0.78);
  background: rgb(14 19 25 / 0.84);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.025),
    0 18px 50px -42px rgb(0 0 0 / 0.95);
  backdrop-filter: blur(18px) saturate(118%);
}

.panda-node-card__header {
  background: transparent !important;
  border-bottom: 0 !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.node-card-cell {
  border: 1px solid rgb(255 255 255 / 0.055);
  border-radius: 0.65rem;
  background: rgb(255 255 255 / 0.018);
}
</style>
