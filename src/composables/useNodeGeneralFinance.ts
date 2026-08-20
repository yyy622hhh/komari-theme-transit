import type { ComputedRef, Ref } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { CurrencyCode, ExchangeRates } from '@/utils/financeHelper'
import { computed } from 'vue'
import * as financeHelper from '@/utils/financeHelper'
import { isFreeNode } from '@/utils/tagHelper'

interface NodeGeneralFinanceOptions {
  nodes: ComputedRef<NodeData[]>
  exchangeRates: Ref<ExchangeRates>
  currency: Ref<CurrencyCode>
  excludeFreeNodes: Ref<boolean>
  showPrice: ComputedRef<boolean>
}

export function useNodeGeneralFinance(options: NodeGeneralFinanceOptions) {
  function getPeriodCostCNY(node: NodeData, periodDays: number): number {
    if (options.excludeFreeNodes.value && isFreeNode(node))
      return 0
    return financeHelper.calculatePeriodCostCNY(node, options.exchangeRates.value, periodDays)
  }

  function formatCostCard(amountCNY: number): { value: string, unit?: string } {
    if (!options.showPrice.value)
      return { value: '***' }
    const targetRate = options.exchangeRates.value[options.currency.value] || 1
    const formatted = financeHelper.formatFinanceAmount(amountCNY * targetRate, options.currency.value)
    return { value: `${formatted.symbol}${formatted.value}` }
  }

  const monthlyCostCNY = computed(() => options.nodes.value.reduce((sum, node) => sum + getPeriodCostCNY(node, 30), 0))
  const yearlyCostCNY = computed(() => options.nodes.value.reduce((sum, node) => sum + getPeriodCostCNY(node, 365), 0))
  const remainingValueCNY = computed(() => financeHelper.calculateTotalRemainingValueCNY(
    options.nodes.value,
    options.exchangeRates.value,
    options.excludeFreeNodes.value,
  ))
  const remainingValue = computed(() => remainingValueCNY.value * (options.exchangeRates.value[options.currency.value] || 1))
  const formattedRemainingValue = computed(() => financeHelper.formatFinanceAmount(remainingValue.value, options.currency.value))
  const totalValueCNY = computed(() => financeHelper.calculateTotalValueCNY(
    options.nodes.value,
    options.exchangeRates.value,
    options.excludeFreeNodes.value,
  ))
  const totalValue = computed(() => totalValueCNY.value * (options.exchangeRates.value[options.currency.value] || 1))
  const formattedTotalValue = computed(() => financeHelper.formatFinanceAmount(totalValue.value, options.currency.value))
  const totalValueTooltip = computed(() => options.showPrice.value
    ? `总价值\n${formattedTotalValue.value.symbol}${formattedTotalValue.value.value}`
    : '总价值\n***')
  const monthlyCostCard = computed(() => formatCostCard(monthlyCostCNY.value))
  const yearlyCostCard = computed(() => formatCostCard(yearlyCostCNY.value))

  return {
    formattedRemainingValue,
    totalValueTooltip,
    monthlyCostCard,
    yearlyCostCard,
  }
}
