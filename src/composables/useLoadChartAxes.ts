import type { ComputedRef } from 'vue'
import type { getLoadChartThemeColors } from '@/utils/loadChartTheme'
import type { RecordFormat } from '@/utils/recordHelper'
import { computed } from 'vue'
import { formatMetricAxisTime } from '@/utils/metricRange'

interface LoadChartAxesContext {
  chartData: ComputedRef<RecordFormat[]>
  chartThemeColors: ComputedRef<ReturnType<typeof getLoadChartThemeColors>>
  effectiveHistoryHours: ComputedRef<number>
}

export interface LoadChartAxisConfig {
  axisLabel: Record<string, unknown>
  [key: string]: unknown
}

export function useLoadChartAxes(context: LoadChartAxesContext) {
  const { chartData, chartThemeColors, effectiveHistoryHours } = context
  const showDateInAxis = computed(() => (effectiveHistoryHours.value) >= 24)

  // 通用 X 轴配置
  const baseXAxisConfig = computed(() => ({
    type: 'category' as const,
    data: chartData.value.map(r => formatMetricAxisTime(r.time, showDateInAxis.value)),
    axisLabel: {
      fontSize: 11,
      color: chartThemeColors.value.textSecondary,
      margin: 12,
    },
    axisLine: {
      show: true,
      lineStyle: { color: chartThemeColors.value.borderColor, width: 1 },
    },
    axisTick: { show: false },
    boundaryGap: false,
  }))

  // 通用 Y 轴配置
  const baseYAxisConfig = computed(() => ({
    type: 'value' as const,
    axisLabel: {
      fontSize: 11,
      color: chartThemeColors.value.textSecondary,
    },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: {
      lineStyle: {
        color: chartThemeColors.value.splitLineColor,
        type: 'dashed' as const,
      },
    },
  }))

  return { baseXAxisConfig, baseYAxisConfig }
}
