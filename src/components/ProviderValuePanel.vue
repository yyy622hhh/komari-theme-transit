<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, onMounted, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { CardX } from '@/components/ui/card-x'
import { useNodeProviderMetadata } from '@/composables/useNodeProviderMetadata'
import { useAppStore } from '@/stores/app'
import * as financeHelper from '@/utils/financeHelper'
import { formatBytesWithConfig } from '@/utils/helper'
import { hasFreeNodeTag } from '@/utils/tagHelper'

interface NodeValueRow {
  key: string
  node: NodeData
  provider: string
  monthlyCostCNY: number
  cpuName: string
  cpuCores: number
  memoryBytes: number
  trafficBytes: number
  costPerCore: number | null
  costPerMemoryGb: number | null
  costPerTrafficGb: number | null
}

type SortKey = 'name' | 'provider' | 'monthlyCostCNY' | 'costPerCore' | 'costPerMemoryGb' | 'costPerTrafficGb'

const props = defineProps<{
  nodes: NodeData[]
}>()

const appStore = useAppStore()
const exchangeRates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
const financeCurrency = ref<financeHelper.CurrencyCode>('CNY')
const excludeFreeNodes = ref(true)
const sortKey = ref<SortKey>('costPerCore')
const sortDir = ref<1 | -1>(1)

const { getNodeProviderMetadata } = useNodeProviderMetadata({
  nodes: () => props.nodes,
  customAliases: () => appStore.providerAliases,
  enabled: true,
})

onMounted(async () => {
  financeCurrency.value = financeHelper.getStoredFinanceCurrency()
  excludeFreeNodes.value = financeHelper.shouldExcludeFreeNodes()
  const { rates } = await financeHelper.getDailyExchangeRates()
  exchangeRates.value = rates
})

function shouldExcludeNode(node: NodeData): boolean {
  if (Number(node.price) <= 0)
    return true
  return excludeFreeNodes.value && hasFreeNodeTag(node.tags)
}

function getProviderName(node: NodeData): string {
  return getNodeProviderMetadata(node)?.provider?.displayName || '未知厂商'
}

function getTrafficComparableBytes(node: NodeData): number {
  const limit = Number(node.traffic_limit)
  return Number.isFinite(limit) && limit > 0 ? limit : 0
}

function formatMoneyCNY(amountCNY: number): string {
  if (!Number.isFinite(amountCNY))
    return '-'
  const targetRate = exchangeRates.value[financeCurrency.value] || 1
  const formatted = financeHelper.formatFinanceAmount(amountCNY * targetRate, financeCurrency.value)
  return `${formatted.symbol}${formatted.value}`
}

function formatCost(value: number | null): string {
  if (value === null || !Number.isFinite(value))
    return '-'
  return formatMoneyCNY(value)
}

function formatBytes(bytes: number): string {
  return formatBytesWithConfig(bytes, appStore.byteDecimals)
}

function formatRankValue(row: NodeValueRow, key: SortKey): string {
  switch (key) {
    case 'monthlyCostCNY': return formatMoneyCNY(row.monthlyCostCNY)
    case 'costPerMemoryGb': return `${formatCost(row.costPerMemoryGb)} / GB 内存`
    case 'costPerTrafficGb': return `${formatCost(row.costPerTrafficGb)} / GB 流量`
    case 'costPerCore': return `${formatCost(row.costPerCore)} / 核`
    case 'provider': return row.provider
    case 'name':
    default: return row.node.name
  }
}

function compareNullableCost(left: number | null, right: number | null): number {
  if (left === null && right === null)
    return 0
  if (left === null)
    return 1
  if (right === null)
    return -1
  return left - right
}

const nodeRows = computed<NodeValueRow[]>(() => props.nodes
  .filter(node => !shouldExcludeNode(node))
  .map((node) => {
    const monthlyCostCNY = financeHelper.calculateMonthlyCostCNY(node, exchangeRates.value)
    const cpuCores = Math.max(0, node.cpu_cores || 0)
    const memoryBytes = Math.max(0, node.mem_total || 0)
    const trafficBytes = getTrafficComparableBytes(node)
    const memoryGb = memoryBytes / 1024 ** 3
    const trafficGb = trafficBytes / 1024 ** 3

    return {
      key: node.uuid,
      node,
      provider: getProviderName(node),
      monthlyCostCNY,
      cpuName: node.cpu_name || '-',
      cpuCores,
      memoryBytes,
      trafficBytes,
      costPerCore: cpuCores > 0 ? monthlyCostCNY / cpuCores : null,
      costPerMemoryGb: memoryGb > 0 ? monthlyCostCNY / memoryGb : null,
      costPerTrafficGb: trafficGb > 0 ? monthlyCostCNY / trafficGb : null,
    }
  }))

const sortedRows = computed(() => {
  const key = sortKey.value
  const dir = sortDir.value
  return [...nodeRows.value].sort((left, right) => {
    if (key === 'name')
      return dir * left.node.name.localeCompare(right.node.name, 'zh-CN')
    if (key === 'provider')
      return dir * left.provider.localeCompare(right.provider, 'zh-CN')
    if (key === 'monthlyCostCNY')
      return dir * (left.monthlyCostCNY - right.monthlyCostCNY)
    return dir * compareNullableCost(left[key], right[key])
  })
})

const bestRows = computed(() => sortedRows.value.slice(0, 3))
const totalComparableNodes = computed(() => nodeRows.value.length)
const totalMonthlyCost = computed(() => nodeRows.value.reduce((sum, row) => sum + row.monthlyCostCNY, 0))
const providerCount = computed(() => new Set(nodeRows.value.map(row => row.provider)).size)

function setSort(key: SortKey): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 1 ? -1 : 1
    return
  }

  sortKey.value = key
  sortDir.value = 1
}

function sortMark(key: SortKey): string {
  if (sortKey.value !== key)
    return ''
  return sortDir.value === 1 ? ' ↑' : ' ↓'
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <CardX size="small" class="border-none bg-background/50">
        <div class="text-xs text-muted-foreground">
          参与对比机器
        </div>
        <div class="mt-1 text-2xl font-bold">
          {{ totalComparableNodes }}
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          已排除免费 / 白嫖中节点
        </div>
      </CardX>
      <CardX size="small" class="border-none bg-background/50">
        <div class="text-xs text-muted-foreground">
          服务商 / 网络
        </div>
        <div class="mt-1 text-2xl font-bold">
          {{ providerCount }}
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          表格按每台机器单独排行
        </div>
      </CardX>
      <CardX size="small" class="border-none bg-background/50 sm:col-span-2 lg:col-span-1">
        <div class="text-xs text-muted-foreground">
          月成本估算
        </div>
        <div class="mt-1 text-2xl font-bold">
          {{ formatMoneyCNY(totalMonthlyCost) }}
        </div>
        <div class="mt-1 text-[11px] text-muted-foreground">
          使用现有 financeHelper 汇率缓存
        </div>
      </CardX>
    </div>

    <div v-if="bestRows.length" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <CardX v-for="row in bestRows" :key="row.key" size="small" class="border-none bg-background/50">
        <div class="flex items-start gap-2">
          <Icon icon="tabler:trophy" width="18" height="18" class="mt-0.5 text-amber-500" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">
              {{ row.node.name }}
            </div>
            <div class="mt-1 truncate text-xs text-muted-foreground">
              {{ row.provider }} · {{ formatRankValue(row, sortKey) }}
            </div>
          </div>
          <Badge v-if="row.trafficBytes <= 0" variant="outline" class="rounded-md text-[11px] text-orange-500 border-orange-500/30">
            无流量配额
          </Badge>
        </div>
      </CardX>
    </div>

    <CardX class="border-none bg-background/50" content-class="overflow-x-auto">
      <template #header>
        <div>
          <div class="font-semibold">
            单机性价比排行
          </div>
          <div class="text-xs text-muted-foreground">
            每台机器单独计算；指标越低越划算，流量只统计有明确配额的节点。
          </div>
        </div>
      </template>
      <table class="min-w-[960px] w-full text-left text-sm">
        <thead class="text-xs text-muted-foreground">
          <tr class="border-b border-border/60">
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('name')">
              机器{{ sortMark('name') }}
            </th>
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('provider')">
              服务商{{ sortMark('provider') }}
            </th>
            <th class="px-2 py-2 font-medium">
              CPU
            </th>
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('monthlyCostCNY')">
              月成本{{ sortMark('monthlyCostCNY') }}
            </th>
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('costPerCore')">
              每核月成本{{ sortMark('costPerCore') }}
            </th>
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('costPerMemoryGb')">
              每 GB 内存{{ sortMark('costPerMemoryGb') }}
            </th>
            <th class="cursor-pointer px-2 py-2 font-medium" @click="setSort('costPerTrafficGb')">
              每 GB 流量{{ sortMark('costPerTrafficGb') }}
            </th>
            <th class="px-2 py-2 font-medium">
              资源
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sortedRows" :key="row.key" class="border-b border-border/40 last:border-0">
            <td class="px-2 py-3">
              <div class="font-medium">
                {{ row.node.name }}
              </div>
              <div class="mt-1 flex flex-wrap gap-1">
                <Badge v-if="row.trafficBytes <= 0" variant="outline" class="rounded-md text-[11px] text-orange-500 border-orange-500/30">
                  无流量配额
                </Badge>
              </div>
            </td>
            <td class="px-2 py-3 text-xs text-muted-foreground">
              {{ row.provider }}
            </td>
            <td class="px-2 py-3 text-xs text-muted-foreground">
              <div class="font-medium text-foreground">
                {{ row.cpuCores }} 核
              </div>
              <div class="max-w-[15rem] truncate" :title="row.cpuName">
                {{ row.cpuName }}
              </div>
            </td>
            <td class="px-2 py-3 tabular-nums">
              {{ formatMoneyCNY(row.monthlyCostCNY) }}
            </td>
            <td class="px-2 py-3 tabular-nums">
              {{ formatCost(row.costPerCore) }}
            </td>
            <td class="px-2 py-3 tabular-nums">
              {{ formatCost(row.costPerMemoryGb) }}
            </td>
            <td class="px-2 py-3 tabular-nums">
              {{ formatCost(row.costPerTrafficGb) }}
            </td>
            <td class="px-2 py-3 text-xs text-muted-foreground">
              <div>{{ row.cpuCores }} 核 · {{ formatBytes(row.memoryBytes) }} 内存</div>
              <div>流量配额 {{ row.trafficBytes > 0 ? formatBytes(row.trafficBytes) : '未统计' }}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="sortedRows.length === 0" class="py-10 text-center text-sm text-muted-foreground">
        暂无可对比的付费节点。
      </div>
    </CardX>
  </div>
</template>
