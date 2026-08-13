<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { CurrencyCode } from '@/utils/financeHelper'
import { computed, onMounted, ref } from 'vue'
import NetworkTopology from '@/components/NetworkTopology.vue'
import { useAppStore } from '@/stores/app'
import * as financeHelper from '@/utils/financeHelper'
import { formatBytesPerSecondWithConfig, formatBytesWithConfig } from '@/utils/helper'
import { getTrafficUsed } from '@/utils/nodeMetricsHelper'

const props = defineProps<{ nodes: NodeData[] }>()
const appStore = useAppStore()
const exchangeRates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
const currency = ref<CurrencyCode>('CNY')
const excludeFreeNodes = ref(true)

const showPrice = computed(() => appStore.isLoggedIn || !appStore.hidePriceWhenLoggedOut)
const onlineNodes = computed(() => props.nodes.filter(node => node.online))

const totals = computed(() => {
  const memoryUsed = props.nodes.reduce((sum, node) => sum + (node.ram || 0), 0)
  const memoryTotal = props.nodes.reduce((sum, node) => sum + (node.mem_total || 0), 0)
  const diskUsed = props.nodes.reduce((sum, node) => sum + (node.disk || 0), 0)
  const diskTotal = props.nodes.reduce((sum, node) => sum + (node.disk_total || 0), 0)
  const traffic = props.nodes.reduce((sum, node) => sum + getTrafficUsed(node), 0)
  const upload = onlineNodes.value.reduce((sum, node) => sum + (node.net_out || 0), 0)
  const download = onlineNodes.value.reduce((sum, node) => sum + (node.net_in || 0), 0)
  const remainingValue = financeHelper.calculateTotalRemainingValueCNY(props.nodes, exchangeRates.value, excludeFreeNodes.value)

  return { memoryUsed, memoryTotal, diskUsed, diskTotal, traffic, upload, download, remainingValue }
})

function formatBytes(value: number): string {
  return formatBytesWithConfig(value, appStore.byteDecimals)
}

function formatSpeed(value: number): string {
  return formatBytesPerSecondWithConfig(value, appStore.byteDecimals)
}

function formatMoney(amountCNY: number): string {
  if (!showPrice.value)
    return '***'
  const rate = exchangeRates.value[currency.value] || 1
  const formatted = financeHelper.formatFinanceAmount(amountCNY * rate, currency.value)
  return `${formatted.symbol}${formatted.value}`
}

onMounted(async () => {
  currency.value = financeHelper.getStoredFinanceCurrency()
  excludeFreeNodes.value = financeHelper.shouldExcludeFreeNodes()
  const result = await financeHelper.getDailyExchangeRates()
  exchangeRates.value = result.rates
})
</script>

<template>
  <section id="asset-summary" class="relative z-1 scroll-mt-20 px-4 pb-3 pt-3">
    <div class="mx-auto max-w-[1560px] space-y-3">
      <div class="panda-panel telemetry-scroll overflow-x-auto rounded-2xl">
        <div class="grid min-w-[840px] grid-cols-[0.82fr_1.28fr_1.28fr_1fr_1.18fr_1.5fr] divide-x divide-white/[0.055]">
          <div class="telemetry-item">
            <span>在线</span>
            <strong>{{ onlineNodes.length }} / {{ nodes.length }}</strong>
          </div>
          <div class="telemetry-item">
            <span>内存</span>
            <strong>{{ formatBytes(totals.memoryUsed) }} <em>/ {{ formatBytes(totals.memoryTotal) }}</em></strong>
          </div>
          <div class="telemetry-item">
            <span>硬盘</span>
            <strong>{{ formatBytes(totals.diskUsed) }} <em>/ {{ formatBytes(totals.diskTotal) }}</em></strong>
          </div>
          <div class="telemetry-item">
            <span>流量</span>
            <strong>{{ formatBytes(totals.traffic) }}</strong>
          </div>
          <div class="telemetry-item">
            <span>剩余价值</span>
            <strong>{{ formatMoney(totals.remainingValue) }}</strong>
          </div>
          <div class="telemetry-item">
            <span>实时</span>
            <strong class="flex items-center gap-3">
              <span class="text-emerald-400">↑ {{ formatSpeed(totals.upload) }}</span>
              <span class="text-slate-300">↓ {{ formatSpeed(totals.download) }}</span>
            </strong>
          </div>
        </div>
      </div>

      <NetworkTopology v-if="appStore.topologyEnabled" embedded :nodes="nodes" />
    </div>
  </section>
</template>

<style scoped>
.telemetry-scroll {
  scrollbar-width: none;
}

.telemetry-scroll::-webkit-scrollbar {
  display: none;
}

.telemetry-item {
  display: flex;
  min-height: 3.4rem;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  padding: 0.75rem 1rem;
  white-space: nowrap;
  font-size: 0.72rem;
  color: rgb(148 163 184);
}

@media (max-width: 640px) {
  .telemetry-item {
    min-height: 3rem;
    padding: 0.62rem 0.8rem;
  }
}

.telemetry-item strong {
  color: rgb(241 245 249);
  font-size: 0.79rem;
  font-style: normal;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.telemetry-item em {
  color: rgb(100 116 139);
  font-style: normal;
  font-weight: 500;
}
</style>
