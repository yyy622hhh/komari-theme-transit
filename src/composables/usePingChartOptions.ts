import type { ComputedRef, Ref, ShallowRef } from 'vue'
import type { PingTaskInfo } from '@/utils/rpc'
import { computed } from 'vue'
import { ACCESSIBLE_LINE_TYPES } from '@/utils/chartPalette'
import { formatMetricAxisTime, formatMetricTooltipTime } from '@/utils/metricRange'

interface ChartThemeColors {
  text: string
  textSecondary: string
  textTertiary: string
  borderColor: string
  splitLineColor: string
  tooltipBg: string
  tooltipShadow: string
  crosshairColor: string
}

interface PingChartOptions {
  colorVisionFriendly: ComputedRef<boolean>
  chartThemeColors: ComputedRef<ChartThemeColors>
  chartColors: string[]
  selectedTasks: ComputedRef<PingTaskInfo[]>
  chartData: ComputedRef<Record<string, unknown>[]>
  selectedHours: ComputedRef<number>
  tasks: ShallowRef<PingTaskInfo[]>
  cutPeak: Ref<boolean>
  showDateInAxis: ComputedRef<boolean>
  getTaskColor: (taskId: number) => string
}

export function usePingChartOptions(options: PingChartOptions) {
  const chartMargin = { top: 30, right: 24, bottom: 52, left: 56 }
  const baseTooltipConfig = computed(() => ({
    trigger: 'axis' as const,
    confine: false,
    backgroundColor: options.chartThemeColors.value.tooltipBg,
    borderColor: 'transparent',
    borderWidth: 0,
    borderRadius: 6,
    textStyle: {
      color: options.chartThemeColors.value.text,
      fontSize: 12,
      lineHeight: 20,
    },
    extraCssText: `backdrop-filter: blur(5px);z-index:9;box-shadow:0 0 0 1px ${options.chartThemeColors.value.tooltipShadow}, 0 0 16px ${options.chartThemeColors.value.tooltipShadow}`,
    axisPointer: {
      type: 'cross' as const,
      crossStyle: {
        color: options.chartThemeColors.value.textTertiary,
      },
      lineStyle: {
        color: options.chartThemeColors.value.crosshairColor,
        width: 1,
        type: 'dashed' as const,
      },
      shadowStyle: {
        color: options.chartThemeColors.value.crosshairColor,
      },
    },
  }))

  const pingChartOption = computed(() => {
    const taskList = options.selectedTasks.value
    const data = options.chartData.value
    const hours = options.selectedHours.value

    const series = taskList.map((task, index) => {
      const color = options.getTaskColor(task.id)
      const lineType = options.colorVisionFriendly.value
        ? (ACCESSIBLE_LINE_TYPES[index % ACCESSIBLE_LINE_TYPES.length] ?? 'solid')
        : 'solid'
      return {
        name: task.name,
        type: 'line' as const,
        data: data.map(datum => datum[task.id] as number | null ?? null),
        smooth: options.cutPeak.value ? 0.6 : 0.1,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.5, color, cap: 'round' as const, type: lineType },
        itemStyle: { color },
      }
    })

    const colorMap = new Map<number, string>()
    options.tasks.value.forEach((task, index) => {
      const safeIndex = Math.max(0, index % options.chartColors.length)
      colorMap.set(task.id, options.chartColors[safeIndex]!)
    })

    return {
      animation: false,
      color: options.tasks.value.map((_, index) => {
        const safeIndex = Math.max(0, index % options.chartColors.length)
        return options.chartColors[safeIndex]!
      }),
      tooltip: {
        ...baseTooltipConfig.value,
        formatter: (params: unknown) => {
          const entries = params as Array<{ seriesName: string, value: number | null, dataIndex: number }>
          const firstEntry = entries[0]
          if (!firstEntry)
            return ''

          const rowData = data[firstEntry.dataIndex]
          if (!rowData)
            return ''

          const time = rowData.time as string
          const timeText = formatMetricTooltipTime(time, hours)
          let html = `<div style="font-weight:600;margin-bottom:6px;color:${options.chartThemeColors.value.textSecondary}">${timeText}</div>`
          html += '<div style="display:flex;flex-direction:column;gap:4px">'

          const sortedEntries = [...entries].sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
          for (const entry of sortedEntries) {
            if (entry.value === null || entry.value === undefined)
              continue

            const task = options.tasks.value.find(candidate => candidate.name === entry.seriesName)
            const color = task ? colorMap.get(task.id) || options.chartColors[0] : options.chartColors[0]
            const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:8px;flex-shrink:0"></span>`
            html += `<div style="display:flex;align-items:center">${colorDot}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${entry.seriesName}</span><span style="margin-left:auto;font-weight:600;margin-left:16px;font-variant-numeric:tabular-nums">${Math.round(entry.value)} ms</span></div>`
          }
          html += '</div>'
          return html
        },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        itemWidth: 12,
        itemHeight: 12,
        itemGap: 16,
        icon: 'roundRect',
        textStyle: { fontSize: 11, color: options.chartThemeColors.value.textSecondary },
        data: taskList.map(task => task.name),
      },
      grid: chartMargin,
      xAxis: {
        type: 'category',
        data: data.map(datum => formatMetricAxisTime(datum.time as string, options.showDateInAxis.value)),
        axisLabel: {
          fontSize: 11,
          color: options.chartThemeColors.value.textSecondary,
          margin: 12,
        },
        axisLine: {
          show: true,
          lineStyle: { color: options.chartThemeColors.value.borderColor, width: 1 },
        },
        axisTick: { show: false },
        boundaryGap: false,
      },
      yAxis: {
        type: 'value',
        name: '延迟 (ms)',
        nameTextStyle: { color: options.chartThemeColors.value.textSecondary },
        axisLabel: { fontSize: 11, color: options.chartThemeColors.value.textSecondary, formatter: '{value}' },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: {
          lineStyle: {
            color: options.chartThemeColors.value.splitLineColor,
            type: 'dashed' as const,
          },
        },
      },
      series,
    }
  })

  return { pingChartOption }
}
