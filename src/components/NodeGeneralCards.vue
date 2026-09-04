<script setup lang="ts">
import type { NodeGeneralCardContext } from '@/components/nodeGeneralCards.definitions'
import type { GeneralMetricCard } from '@/components/nodeGeneralCards.helpers'
import type { GeneralCardKey } from '@/stores/app'
import type { NodeData } from '@/stores/nodes'
import type { CurrencyCode } from '@/utils/financeHelper'
import { Icon } from '@iconify/vue/offline'
import { useNow } from '@vueuse/core'
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import ComponentErrorBoundary from '@/components/ComponentErrorBoundary.vue'
import NodeEarthGlobe from '@/components/NodeEarthGlobe.vue'
import { getNodeGeneralCardDefinition } from '@/components/nodeGeneralCards.definitions'
import {
  createNodeGeneralFormatters,
  formatNodeGeneralDate,
  formatNodeGeneralTime,
  GENERAL_CARD_CLASS,
  GENERAL_CARD_UNIT_CLASS,
  getMetricSwitchStyle,
  getNodeGeneralCardPositionClass,
} from '@/components/nodeGeneralCards.helpers'
import { CardX } from '@/components/ui/card-x'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useDailyExchangeRates } from '@/composables/useDailyExchangeRates'
import { useNodeGeneralFinance } from '@/composables/useNodeGeneralFinance'
import { useNodeGeneralSummary } from '@/composables/useNodeGeneralSummary'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import * as financeHelper from '@/utils/financeHelper'
import { formatBytesSplit } from '@/utils/helper'
import {
  formatMetricDecimal,
  formatNodeCount,
  formatNodeNameList,
} from '@/utils/nodeMetricsHelper'
import { earthRenderModeState, resolveStaticEarthRenderer } from '@/utils/renderModeState'

defineOptions({ components: { CardX, ComponentErrorBoundary, DataTooltip, FinanceDetailsDialog: defineAsyncComponent(() => import('@/components/FinanceDetailsDialog.vue')), Icon, NodeEarthGlobe } })

const props = withDefaults(defineProps<{
  nodes?: NodeData[]
  globeNodes?: NodeData[]
  transitionKey?: string
  active?: boolean
}>(), {
  active: true,
})
const appStore = useAppStore()
const nodesStore = useNodesStore()
// 未登录且开启「未登录隐藏价格」时，屏蔽金额类信息
const showPrice = computed(() => appStore.privateFeaturesAllowed || !appStore.hidePriceWhenLoggedOut)
const financeCardKeys = new Set<GeneralCardKey>(['remainingValue', 'monthlyCost', 'yearlyCost'])
const showEarth = computed(() => !appStore.hideEarth)
const isTiledEarth = computed(() => {
  if (!showEarth.value)
    return false
  const live = earthRenderModeState.value?.active
  if (live)
    return live === 'tiled'
  return resolveStaticEarthRenderer(appStore.earthRenderer).active === 'tiled'
})
const needsExchangeRates = computed(() => showPrice.value && (
  appStore.generalCardOrder.some(key => financeCardKeys.has(key))
  || isTiledEarth.value
))

const {
  rates: exchangeRates,
  dailyRates: dailyExchangeRates,
  source: exchangeRateSource,
  updatedAt: exchangeRateUpdatedAt,
} = useDailyExchangeRates(needsExchangeRates, { applyOverrides: true })
const financeCurrency = ref<CurrencyCode>('CNY')
const excludeFreeNodes = ref(true)
const financeDetailsOpen = ref(false)
const currentTimeControls = useNow({ interval: 1000, immediate: false, controls: true })
const currentTime = currentTimeControls.now
const clockEnabled = computed(() => props.active && (
  appStore.generalCardOrder.includes('currentTime')
  || financeDetailsOpen.value
))

watch(clockEnabled, (enabled) => {
  if (enabled) {
    currentTime.value = new Date()
    currentTimeControls.resume()
  }
  else {
    currentTimeControls.pause()
  }
}, { immediate: true })
const summaryNodes = computed(() => props.nodes ?? nodesStore.visibleNodes)
const summaryTransitionKey = computed(() => props.transitionKey ?? nodesStore.visibleNodes.length)
const metricSwitchTransitionProps = computed(() => ({
  ...(appStore.disablePageAnimation
    ? { css: false }
    : { name: 'metric-switch', mode: 'out-in' as const }),
}))

function formatBytesText(bytes: number): string {
  const formatted = formatBytesSplit(bytes, appStore.byteDecimals)
  return `${formatted.value} ${formatted.unit}`
}

const { formatTopNodeSpeed, formatTopNodePercentage } = createNodeGeneralFormatters(() => appStore.byteDecimals)
const formatCount = formatNodeCount
const formatDecimal = formatMetricDecimal
const formatNodeNames = formatNodeNameList

const summary = useNodeGeneralSummary(summaryNodes)

const { formattedRemainingValue, totalValueTooltip, monthlyCostCard, yearlyCostCard } = useNodeGeneralFinance({
  nodes: summaryNodes,
  exchangeRates,
  currency: financeCurrency,
  excludeFreeNodes,
  showPrice,
})

const trafficPeakCard = computed(() => formatTopNodeSpeed(summary.trafficPeak.value))
const uploadPeakCard = computed(() => formatTopNodeSpeed(summary.uploadPeakNode.value))
const downloadPeakCard = computed(() => formatTopNodeSpeed(summary.downloadPeakNode.value))
const gpuPeakCard = computed(() => formatTopNodePercentage(summary.gpuPeakNode.value))
const currentTimeText = computed(() => formatNodeGeneralTime(currentTime.value))
const currentDateText = computed(() => formatNodeGeneralDate(currentTime.value))
const connectionPeakTooltip = computed(() => {
  const metric = summary.connectionPeakNode.value
  if (!metric)
    return '暂无数据'
  return `${metric.node.name}\nTCP ${formatCount(metric.node.connections || 0)}\nUDP ${formatCount(metric.node.connections_udp || 0)}`
})
const cardContext = computed<NodeGeneralCardContext>(() => ({
  summary,
  finance: { formattedRemainingValue, totalValueTooltip, monthlyCostCard, yearlyCostCard },
  derived: { trafficPeakCard, uploadPeakCard, downloadPeakCard, gpuPeakCard, currentTimeText, currentDateText, connectionPeakTooltip },
  format: { bytes: formatBytesText, count: formatCount, decimal: formatDecimal, nodeNames: formatNodeNames },
  showPrice,
  highLoadThreshold: () => appStore.homeHighLoadThreshold,
}))

function getCardDefinition(key: GeneralCardKey): GeneralMetricCard {
  return getNodeGeneralCardDefinition(key, cardContext.value)
}

const tiledDefaultCardKeys: GeneralCardKey[] = [
  'onlineNodes',
  'remainingValue',
  'monthlyCost',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
]
const baseVisibleCards = computed(() => appStore.generalCardOrder.map(getCardDefinition))
const tiledDefaultCards = computed(() => tiledDefaultCardKeys.map(getCardDefinition))
const visibleCards = computed(() => isTiledEarth.value ? tiledDefaultCards.value : baseVisibleCards.value)
const shouldRenderHeader = computed(() => showEarth.value || visibleCards.value.length > 0)
const hasExtraCards = computed(() => visibleCards.value.length > 6)
const wrapperClass = computed(() => {
  if (!showEarth.value)
    return 'p-4 grid grid-cols-1 gap-2 h-auto'

  if (isTiledEarth.value)
    return 'p-3 sm:p-4 grid grid-cols-12 gap-2 sm:gap-3 h-auto min-h-[40rem] sm:min-h-[30rem] md:min-h-[36rem] lg:min-h-[40rem]'

  return hasExtraCards.value
    ? 'p-4 grid grid-cols-12 gap-2 h-auto md:min-h-58'
    : 'p-4 grid grid-cols-12 grid-rows-1 gap-2 h-auto md:h-58'
})
const earthClass = computed(() => {
  if (isTiledEarth.value)
    return 'col-span-12 row-start-2 min-h-[18rem] h-[18rem] sm:h-[20rem] md:h-[24rem] lg:h-[28rem]'

  return 'col-span-12 col-start-1 md:col-span-6 md:col-start-7 md:row-start-1'
})
const cardGridClass = computed(() => {
  if (!showEarth.value)
    return 'col-span-1 grid grid-cols-3 md:grid-cols-6 gap-2'

  if (isTiledEarth.value)
    return 'col-span-12 row-start-1 z-9 grid grid-cols-12 auto-rows-[4.75rem] sm:auto-rows-[5rem] md:auto-rows-[5.8rem] gap-2 sm:gap-3'

  return hasExtraCards.value
    ? 'h-auto -mt-42 md:mt-0 col-span-12 row-start-3 z-9 md:h-auto md:col-span-6 md:row-start-1 grid grid-cols-12 auto-rows-[5rem] md:auto-rows-[7rem] gap-2'
    : 'h-42 -mt-42 md:mt-0 col-span-12 row-start-3 z-9 md:h-auto md:col-span-6 md:row-start-1 grid grid-cols-12 grid-rows-2 gap-2'
})
const cardClass = GENERAL_CARD_CLASS
const unitClass = GENERAL_CARD_UNIT_CLASS

function getCardPositionClass(index: number): string {
  return getNodeGeneralCardPositionClass(index, showEarth.value, isTiledEarth.value)
}

function activateCard(card: GeneralMetricCard) {
  if (card.action === 'financeDetails')
    financeDetailsOpen.value = true
}

function handleCardKeydown(event: KeyboardEvent, card: GeneralMetricCard) {
  if (!card.action || (event.key !== 'Enter' && event.key !== ' '))
    return
  event.preventDefault()
  activateCard(card)
}

function updateFinanceCurrency(currency: CurrencyCode) {
  financeCurrency.value = currency
  financeHelper.setStoredFinanceCurrency(currency)
}

function updateExcludeFreeNodes(exclude: boolean) {
  excludeFreeNodes.value = exclude
  financeHelper.setExcludeFreeNodes(exclude)
}

function updateExchangeRate(currency: CurrencyCode, value: number) {
  financeHelper.setExchangeRateOverride(currency, value)
  exchangeRates.value = { ...exchangeRates.value, [currency]: value, CNY: 1 }
}

function resetExchangeRates() {
  financeHelper.clearExchangeRateOverrides()
  exchangeRates.value = { ...dailyExchangeRates.value }
}

onMounted(() => {
  financeCurrency.value = financeHelper.getStoredFinanceCurrency()
  excludeFreeNodes.value = financeHelper.shouldExcludeFreeNodes()
})
</script>

<template>
  <div v-if="shouldRenderHeader" :class="wrapperClass">
    <ComponentErrorBoundary v-if="showEarth" label="节点地图" :reset-key="appStore.earthRenderer">
      <NodeEarthGlobe :nodes="globeNodes" :class="earthClass" />
    </ComponentErrorBoundary>

    <div v-if="visibleCards.length > 0" :class="cardGridClass">
      <CardX
        v-for="(card, index) in visibleCards"
        :key="card.key"
        hoverable
        :class="[cardClass, getCardPositionClass(index), card.action && 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring']"
        content-class="h-full !p-3"
        :role="card.action ? 'button' : undefined"
        :tabindex="card.action ? 0 : undefined"
        :aria-label="card.action ? `查看${card.label}明细` : undefined"
        @click="activateCard(card)"
        @keydown="handleCardKeydown($event, card)"
      >
        <div class="flex h-full flex-col justify-between gap-1">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-medium tracking-wider text-muted-foreground truncate">{{ card.label }}</span>
            <Icon
              :icon="card.icon"
              :width="20"
              :height="20"
              class="shrink-0 text-slate-500/20 group-hover:text-slate-500 transition-colors"
            />
          </div>
          <DataTooltip
            as="span"
            placement="top"
            :content="card.tooltip"
            class="min-w-0"
            content-class="whitespace-pre px-2 py-1 left-0 -translate-x-0 leading-normal"
          >
            <Transition v-bind="metricSwitchTransitionProps">
              <div
                :key="`${card.key}-${summaryTransitionKey}`"
                class="flex items-baseline gap-1 min-w-0"
                :style="getMetricSwitchStyle(index)"
              >
                <span class="text-md md:text-2xl font-bold leading-none tracking-tight truncate"> {{ card.value }} </span>
                <span v-if="card.unit" :class="unitClass"> {{ card.unit }} </span>
              </div>
            </Transition>
          </DataTooltip>
        </div>
      </CardX>
    </div>
  </div>

  <FinanceDetailsDialog
    v-if="financeDetailsOpen"
    v-model:open="financeDetailsOpen"
    :nodes="summaryNodes"
    :rates="exchangeRates"
    :source="exchangeRateSource"
    :rates-updated-at="exchangeRateUpdatedAt"
    :currency="financeCurrency"
    :exclude-free="excludeFreeNodes"
    :now="currentTime"
    @update:currency="updateFinanceCurrency"
    @update:exclude-free="updateExcludeFreeNodes"
    @update:rate="updateExchangeRate"
    @reset-rates="resetExchangeRates"
  />
</template>

<style scoped>
.metric-switch-enter-active,
.metric-switch-leave-active {
  transition:
    opacity 160ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 180ms ease;
}

.metric-switch-enter-active {
  transition-delay: var(--metric-switch-delay, 0ms);
}
.metric-switch-enter-from {
  opacity: 0;
  transform: translateY(6px);
  filter: blur(3px);
}
.metric-switch-leave-to {
  opacity: 0;
  transform: translateY(-4px);
  filter: blur(2px);
}

@media (prefers-reduced-motion: reduce) {
  .metric-switch-enter-active,
  .metric-switch-leave-active {
    transition: none;
    transition-delay: 0ms;
  }

  .metric-switch-enter-from,
  .metric-switch-leave-to {
    opacity: 1;
    transform: none;
    filter: none;
  }
}
</style>
