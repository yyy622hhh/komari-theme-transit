import type { GeneralCardKey } from '@/stores/app'
import type { NodeData } from '@/stores/nodes'
import type { ByteDecimalsConfig } from '@/utils/helper'
import type { TopNodeMetric } from '@/utils/nodeMetricsHelper'
import { UI_CONFIG } from '@/constants/ui'
import { formatBytesPerSecondSplit } from '@/utils/helper'
import { formatMetricDecimal } from '@/utils/nodeMetricsHelper'

export interface GeneralMetricCard {
  key: GeneralCardKey
  label: string
  icon: string
  value: string
  unit?: string
  tooltip?: string
  action?: 'financeDetails'
}

export const GENERAL_CARD_CLASS = 'group relative z-10 h-full bg-background/50 border-none hover:bg-background backdrop-blur-sm md:backdrop-blur-none transition-all'
export const GENERAL_CARD_UNIT_CLASS = 'text-[11px] md:text-xs font-medium text-muted-foreground truncate'

const CARD_POSITION_CLASSES = [
  'col-span-4 row-span-1 col-start-1 row-start-1',
  'col-span-4 row-span-1 col-start-1 row-start-2',
  'col-span-4 row-span-1 col-start-5 row-start-1',
  'col-span-4 row-span-1 col-start-5 row-start-2',
  'col-span-4 row-span-1 col-start-9 row-start-1',
  'col-span-4 row-span-1 col-start-9 row-start-2',
]
const TILED_CARD_POSITION_CLASSES = [
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-1 row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-4 row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-7 row-start-2 sm:row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-10 row-start-2 sm:row-start-1',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-1 row-start-3 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-4 row-start-3 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-7 row-start-4 sm:row-start-2',
  'col-span-6 sm:col-span-3 row-span-1 sm:col-start-10 row-start-4 sm:row-start-2',
]

export function getMetricSwitchStyle(index: number): Record<string, string> {
  return { '--metric-switch-delay': `${index * UI_CONFIG.motion.staggerMs}ms` }
}

export function getNodeGeneralCardPositionClass(index: number, showEarth: boolean, tiled: boolean): string {
  if (!showEarth)
    return 'col-span-1 min-h-18 md:min-h-28'
  if (tiled)
    return TILED_CARD_POSITION_CLASSES[index] ?? 'col-span-6 sm:col-span-3 row-span-1'
  return CARD_POSITION_CLASSES[index] ?? 'col-span-4 row-span-1'
}

export function createNodeGeneralFormatters(getDecimals: () => ByteDecimalsConfig) {
  function formatSpeedText(bytes: number): string {
    const formatted = formatBytesPerSecondSplit(bytes, getDecimals())
    return `${formatted.value} ${formatted.unit}`
  }

  function formatTopNodeSpeed(metric: TopNodeMetric | null, fallback = '-') {
    if (!metric || metric.value <= 0)
      return { value: fallback }
    const formatted = formatBytesPerSecondSplit(metric.value, getDecimals())
    return {
      value: formatted.value,
      unit: formatted.unit,
      tooltip: `${metric.node.name}\n↑ ${formatSpeedText(metric.node.net_out || 0)}\n↓ ${formatSpeedText(metric.node.net_in || 0)}`,
    }
  }

  function formatTopNodePercentage(metric: TopNodeMetric | null) {
    if (!metric)
      return { value: '-' }
    const gpuName = metric.node.gpu_name?.trim()
    return {
      value: formatMetricDecimal(metric.value),
      unit: '%',
      tooltip: [metric.node.name, gpuName, `GPU ${formatMetricDecimal(metric.value)}%`].filter(Boolean).join('\n'),
    }
  }

  return { formatSpeedText, formatTopNodeSpeed, formatTopNodePercentage }
}

export function formatNodeGeneralTime(value: Date): string {
  return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function formatNodeGeneralDate(value: Date): string {
  return value.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export type NodeNameFormatter = (node: NodeData) => string
