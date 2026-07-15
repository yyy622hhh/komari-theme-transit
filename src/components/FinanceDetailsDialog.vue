<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { CurrencyCode, ExchangeRates, ExchangeRateSource } from '@/utils/financeHelper'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as financeHelper from '@/utils/financeHelper'
import { formatPriceWithCycle, getDaysUntilExpired, getExpireStatus, hasFreeNodeTag } from '@/utils/tagHelper'

const props = defineProps<{
  open: boolean
  nodes: NodeData[]
  rates: ExchangeRates
  source: ExchangeRateSource | 'loading'
  currency: CurrencyCode
  excludeFree: boolean
  now: Date
}>()

const emit = defineEmits<{
  'update:open': [open: boolean]
  'update:currency': [currency: CurrencyCode]
  'update:excludeFree': [exclude: boolean]
  'update:rate': [currency: CurrencyCode, value: number]
  'resetRates': []
}>()

const displayRate = computed(() => props.rates[props.currency] || 1)
const visibleNodes = computed(() => props.nodes.filter(node => !props.excludeFree || !hasFreeNodeTag(node.tags)))

const sourceLabels: Record<ExchangeRateSource | 'loading', string> = {
  'loading': '载入中',
  'network': '今日网络汇率',
  'cache': '今日缓存汇率',
  'stale-cache': '历史缓存汇率',
  'default': '内置参考汇率',
}

function toCNY(amount: number, nodeCurrency: string): number {
  const currency = financeHelper.normalizeCurrency(nodeCurrency)
  const rate = props.rates[currency] || 1
  return currency === 'CNY' ? amount : amount / rate
}

function formatDisplayAmount(amountCNY: number): string {
  const formatted = financeHelper.formatFinanceAmount(amountCNY * displayRate.value, props.currency)
  return `${formatted.symbol}${formatted.value}`
}

const rows = computed(() => visibleNodes.value.map((node) => {
  const estimate = financeHelper.calculateBillingEstimate(node, props.now)
  const estimateCNY = toCNY(estimate.totalCost, node.currency)
  const remainingCNY = financeHelper.calculateRemainingValueCNY(node, props.rates, props.now)
  const expireStatus = getExpireStatus(node.expired_at)
  const days = getDaysUntilExpired(node.expired_at)
  const expiryLabel = expireStatus === 'unknown'
    ? '未设置'
    : expireStatus === 'expired'
      ? '已过期'
      : expireStatus === 'long_term'
        ? '长期'
        : days === 0
          ? '今天'
          : `${days} 天`
  return {
    node,
    estimate,
    estimateCNY,
    remainingCNY,
    expiryLabel,
  }
}))

const totalRemainingCNY = computed(() => rows.value.reduce((sum, row) => sum + row.remainingCNY, 0))
const totalEstimateCNY = computed(() => rows.value.reduce((sum, row) => sum + row.estimateCNY, 0))
const totalMonthlyCNY = computed(() => visibleNodes.value.reduce((sum, node) => sum + financeHelper.calculateMonthlyCostCNY(node, props.rates), 0))

function handleCurrencyChange(event: Event) {
  emit('update:currency', (event.target as HTMLSelectElement).value as CurrencyCode)
}

function handleRateChange(currency: CurrencyCode, event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (currency !== 'CNY' && Number.isFinite(value) && value > 0)
    emit('update:rate', currency, value)
}

function formatHours(hours: number): string {
  if (hours < 24)
    return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

function formatTraffic(tib: number): string {
  if (tib < 0.001)
    return `${(tib * 1024).toFixed(2)} GiB`
  return `${tib.toFixed(3)} TiB`
}
</script>

<template>
  <AppDialog
    :open="open"
    title="价值与费用明细"
    description="剩余价值、实时费用估算与汇率设置"
    @update:open="emit('update:open', $event)"
  >
    <div class="space-y-5">
      <div class="grid grid-cols-3 divide-x divide-border/60 border-y border-border/60 py-3 text-center">
        <div class="min-w-0 px-2">
          <div class="text-xs text-muted-foreground">
            剩余价值
          </div>
          <div class="mt-1 truncate text-lg font-semibold tabular-nums">
            {{ formatDisplayAmount(totalRemainingCNY) }}
          </div>
        </div>
        <div class="min-w-0 px-2">
          <div class="text-xs text-muted-foreground">
            实时累计估算
          </div>
          <div class="mt-1 truncate text-lg font-semibold tabular-nums">
            {{ formatDisplayAmount(totalEstimateCNY) }}
          </div>
        </div>
        <div class="min-w-0 px-2">
          <div class="text-xs text-muted-foreground">
            固定月均支出
          </div>
          <div class="mt-1 truncate text-lg font-semibold tabular-nums">
            {{ formatDisplayAmount(totalMonthlyCNY) }}
          </div>
        </div>
      </div>

      <section class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="mr-auto">
            <h3 class="text-sm font-semibold">
              汇率
            </h3>
            <p class="text-xs text-muted-foreground">
              {{ sourceLabels[source] }} · 1 CNY 对应数值
            </p>
          </div>
          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              class="size-4 accent-primary"
              :checked="excludeFree"
              @change="emit('update:excludeFree', ($event.target as HTMLInputElement).checked)"
            >
            排除免费节点
          </label>
          <select
            :value="currency"
            aria-label="显示币种"
            class="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            @change="handleCurrencyChange"
          >
            <option v-for="item in financeHelper.SUPPORTED_CURRENCIES" :key="item" :value="item">
              {{ item }}
            </option>
          </select>
          <Button type="button" size="sm" variant="outline" class="h-8 gap-1.5" @click="emit('resetRates')">
            <Icon icon="tabler:refresh" width="14" height="14" />
            恢复今日汇率
          </Button>
        </div>

        <div class="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          <label v-for="item in financeHelper.SUPPORTED_CURRENCIES" :key="item" class="grid grid-cols-[2.5rem_1fr] items-center gap-2 text-xs">
            <span class="font-medium">{{ item }}</span>
            <Input
              type="number"
              min="0"
              step="any"
              :disabled="item === 'CNY'"
              :model-value="rates[item]"
              class="h-8 px-2 text-xs tabular-nums"
              @change="handleRateChange(item, $event)"
            />
          </label>
        </div>
      </section>

      <section class="space-y-2">
        <h3 class="text-sm font-semibold">
          节点明细
        </h3>
        <div class="overflow-x-auto rounded-md border border-border/60">
          <table class="w-full min-w-[780px] text-left text-xs">
            <thead class="bg-muted/45 text-muted-foreground">
              <tr>
                <th class="px-3 py-2 font-medium">
                  节点
                </th>
                <th class="px-3 py-2 font-medium">
                  固定费用
                </th>
                <th class="px-3 py-2 font-medium">
                  到期 / 剩余
                </th>
                <th class="px-3 py-2 font-medium">
                  运行费用
                </th>
                <th class="px-3 py-2 font-medium">
                  流量费用
                </th>
                <th class="px-3 py-2 font-medium">
                  首次开机费
                </th>
                <th class="px-3 py-2 text-right font-medium">
                  累计估算
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/50">
              <tr v-for="row in rows" :key="row.node.uuid" class="hover:bg-muted/25">
                <td class="max-w-44 px-3 py-2.5">
                  <div class="truncate font-medium">
                    {{ row.node.name }}
                  </div>
                  <div v-if="row.node.first_agent_reported_at_estimated" class="mt-0.5 text-[11px] text-amber-600">
                    创建时间推定
                  </div>
                </td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  {{ formatPriceWithCycle(row.node.price, row.node.billing_cycle, row.node.currency) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  <div>{{ row.expiryLabel }}</div>
                  <div class="text-muted-foreground">
                    {{ formatDisplayAmount(row.remainingCNY) }}
                  </div>
                </td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  <div>{{ formatHours(row.estimate.runtimeHours) }}</div>
                  <div class="text-muted-foreground">
                    {{ formatDisplayAmount(toCNY(row.estimate.timeCost, row.node.currency)) }}
                  </div>
                </td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  <div>{{ formatTraffic(row.estimate.trafficTiB) }}</div>
                  <div class="text-muted-foreground">
                    {{ formatDisplayAmount(toCNY(row.estimate.trafficCost, row.node.currency)) }}
                  </div>
                </td>
                <td class="whitespace-nowrap px-3 py-2.5">
                  {{ formatDisplayAmount(toCNY(row.estimate.startupCost, row.node.currency)) }}
                </td>
                <td class="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums">
                  {{ formatDisplayAmount(row.estimateCNY) }}
                </td>
              </tr>
              <tr v-if="rows.length === 0">
                <td colspan="7" class="px-3 py-8 text-center text-muted-foreground">
                  暂无计费节点
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </AppDialog>
</template>
