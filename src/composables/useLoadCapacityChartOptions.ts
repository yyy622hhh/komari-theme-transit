import type { ComputedRef } from 'vue'
import type { LoadChartAxisConfig } from '@/composables/useLoadChartAxes'
import type { NodeData } from '@/stores/nodes'
import type { getLoadChartPalette } from '@/utils/chartPalette'
import type { getLoadChartThemeColors, getLoadChartTooltipConfig } from '@/utils/loadChartTheme'
import type { RecordFormat } from '@/utils/recordHelper'
import { computed } from 'vue'
import { formatBytes } from '@/utils/helper'
import { LOAD_CHART_MARGIN, LOAD_CHART_MARGIN_WITH_LEGEND } from '@/utils/loadChartTheme'
import { formatMetricTooltipTime } from '@/utils/metricRange'

interface LoadCapacityChartContext {
  baseTooltipConfig: ComputedRef<ReturnType<typeof getLoadChartTooltipConfig>>
  baseXAxisConfig: ComputedRef<LoadChartAxisConfig>
  baseYAxisConfig: ComputedRef<LoadChartAxisConfig>
  chartColors: ReturnType<typeof getLoadChartPalette>
  chartData: ComputedRef<RecordFormat[]>
  chartThemeColors: ComputedRef<ReturnType<typeof getLoadChartThemeColors>>
  effectiveHistoryHours: ComputedRef<number>
  nodeInfo: ComputedRef<NodeData | undefined>
}

function resolveCapacityTotal(recordTotal: number | null | undefined, nodeTotal: number | undefined): number | null {
  if (typeof recordTotal === 'number' && recordTotal > 0)
    return recordTotal
  if (typeof nodeTotal === 'number' && nodeTotal > 0)
    return nodeTotal
  return null
}

function formatCapacityBytes(value: number | null): string {
  return value == null ? '-' : formatBytes(value)
}

export function useLoadCapacityChartOptions(context: LoadCapacityChartContext) {
  const {
    baseTooltipConfig,
    baseXAxisConfig,
    baseYAxisConfig,
    chartColors,
    chartData,
    chartThemeColors,
    effectiveHistoryHours,
    nodeInfo,
  } = context
  const chartMargin = LOAD_CHART_MARGIN
  const chartMarginWithLegend = LOAD_CHART_MARGIN_WITH_LEGEND
  // CPU 图表
  const cpuChartOption = computed(() => ({
    animation: false,
    // 全局颜色配置（确保 Tooltip 圆点颜色与线条一致）
    color: [chartColors.primary, chartColors.secondary],
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ dataIndex: number, seriesName: string, value: number, color: string }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const record = chartData.value[firstParam.dataIndex]
        if (!record)
          return ''

        const timeStr = formatMetricTooltipTime(record.time, effectiveHistoryHours.value)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'

        for (const item of p) {
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
          if (item.seriesName === 'CPU') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>CPU</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${item.value?.toFixed(1) ?? '-'}%</span></div>`
          }
          else if (item.seriesName === '负载') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>系统负载</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${item.value?.toFixed(2) ?? '-'}</span></div>`
          }
        }
        html += '</div>'
        return html
      },
    },
    grid: chartMargin,
    xAxis: baseXAxisConfig.value,
    yAxis: [
      {
        ...baseYAxisConfig.value,
        name: 'CPU %',
        nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
        min: 0,
        max: 100,
        axisLabel: { ...baseYAxisConfig.value.axisLabel, formatter: '{value}%' },
      },
      {
        ...baseYAxisConfig.value,
        name: '负载',
        nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 0, 0, 40] },
        min: 0,
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: 'CPU',
        type: 'line',
        data: chartData.value.map(r => r.cpu),

        showSymbol: false,
        yAxisIndex: 0,
        lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: chartColors.primaryAreaStrong },
              { offset: 1, color: chartColors.primaryAreaFaint },
            ],
          },
        },
      },
      {
        name: '负载',
        type: 'line',
        data: chartData.value.map(r => r.load),

        showSymbol: false,
        yAxisIndex: 1,
        lineStyle: { width: 1.5, color: chartColors.secondary, cap: 'round' as const },
      },
    ],
  }))

  // 内存图表
  const memoryChartOption = computed(() => ({
    animation: false,
    color: [chartColors.primary, chartColors.quinary, chartColors.secondary, chartColors.quaternary],
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ dataIndex: number, seriesName: string, value: number, color: string }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const record = chartData.value[firstParam.dataIndex]
        if (!record)
          return ''

        const ramUsed = typeof record.ram === 'number' && Number.isFinite(record.ram) ? record.ram : null
        const ramTotal = resolveCapacityTotal(record.ram_total, nodeInfo.value?.mem_total)
        const swapUsed = typeof record.swap === 'number' && Number.isFinite(record.swap) ? record.swap : null
        const swapTotal = resolveCapacityTotal(record.swap_total, nodeInfo.value?.swap_total)
        const ramPercent = ramUsed != null && ramTotal != null ? ((ramUsed / ramTotal) * 100).toFixed(1) : '-'
        const swapPercent = swapUsed != null && swapTotal != null ? ((swapUsed / swapTotal) * 100).toFixed(1) : '-'

        const timeStr = formatMetricTooltipTime(record.time, effectiveHistoryHours.value)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'

        for (const item of p) {
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
          if (item.seriesName === 'RAM') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>RAM</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatCapacityBytes(ramUsed)} (${ramPercent}${ramPercent === '-' ? '' : '%'})</span></div>`
          }
          else if (item.seriesName === 'Swap') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>Swap</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatCapacityBytes(swapUsed)} (${swapPercent}${swapPercent === '-' ? '' : '%'})</span></div>`
          }
          else if (item.seriesName === 'RAM 总量') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>RAM 总量</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatCapacityBytes(ramTotal)}</span></div>`
          }
          else if (item.seriesName === 'Swap 总量') {
            html += `<div style="display:flex;align-items:center">${colorDot}<span>Swap 总量</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatCapacityBytes(swapTotal)}</span></div>`
          }
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      data: ['RAM', 'RAM 总量', 'Swap', 'Swap 总量'],
      bottom: 4,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: chartThemeColors.value.textSecondary },
    },
    grid: chartMarginWithLegend,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: '内存',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      axisLabel: {
        ...baseYAxisConfig.value.axisLabel,
        formatter: (val: number) => formatBytes(val),
      },
    },
    series: [
      {
        name: 'RAM',
        type: 'line',
        data: chartData.value.map(r => r.ram),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: chartColors.primaryAreaStrong },
              { offset: 1, color: chartColors.primaryAreaFaint },
            ],
          },
        },
      },
      {
        name: 'RAM 总量',
        type: 'line',
        data: chartData.value.map(r => r.ram_total ?? nodeInfo.value?.mem_total ?? null),
        showSymbol: false,
        lineStyle: { width: 1.2, type: 'dashed' as const, color: chartColors.quinary, cap: 'round' as const },
      },
      {
        name: 'Swap',
        type: 'line',
        data: chartData.value.map(r => r.swap),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.secondary, cap: 'round' as const },
      },
      {
        name: 'Swap 总量',
        type: 'line',
        data: chartData.value.map(r => r.swap_total ?? nodeInfo.value?.swap_total ?? null),
        showSymbol: false,
        lineStyle: { width: 1.2, type: 'dashed' as const, color: chartColors.quaternary, cap: 'round' as const },
      },
    ],
  }))

  // 磁盘图表
  const diskChartOption = computed(() => ({
    animation: false,
    color: [chartColors.tertiary, chartColors.quinary],
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ dataIndex: number, seriesName: string, value: number, color: string }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const record = chartData.value[firstParam.dataIndex]
        if (!record)
          return ''

        const diskUsed = typeof record.disk === 'number' && Number.isFinite(record.disk) ? record.disk : null
        const diskTotal = resolveCapacityTotal(record.disk_total, nodeInfo.value?.disk_total)
        const diskPercent = diskUsed != null && diskTotal != null ? ((diskUsed / diskTotal) * 100).toFixed(1) : '-'

        const timeStr = formatMetricTooltipTime(record.time, effectiveHistoryHours.value)
        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'
        for (const item of p) {
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
          const text = item.seriesName === '磁盘总量' ? formatCapacityBytes(diskTotal) : `${formatCapacityBytes(diskUsed)} (${diskPercent}${diskPercent === '-' ? '' : '%'})`
          html += `<div style="display:flex;align-items:center">${colorDot}<span>${item.seriesName}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${text}</span></div>`
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      data: ['磁盘已用', '磁盘总量'],
      bottom: 4,
      itemWidth: 10,
      itemHeight: 8,
      textStyle: { fontSize: 10, color: chartThemeColors.value.textSecondary },
    },
    grid: chartMarginWithLegend,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: '磁盘',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      axisLabel: {
        ...baseYAxisConfig.value.axisLabel,
        formatter: (val: number) => formatBytes(val),
      },
    },
    series: [
      {
        name: '磁盘已用',
        type: 'line',
        data: chartData.value.map(r => r.disk),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.tertiary, cap: 'round' as const },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: chartColors.tertiaryAreaStrong },
              { offset: 1, color: chartColors.tertiaryAreaFaint },
            ],
          },
        },
      },
      {
        name: '磁盘总量',
        type: 'line',
        data: chartData.value.map(r => r.disk_total ?? nodeInfo.value?.disk_total ?? null),
        showSymbol: false,
        lineStyle: { width: 1.2, type: 'dashed' as const, color: chartColors.quinary, cap: 'round' as const },
      },
    ],
  }))

  return { cpuChartOption, memoryChartOption, diskChartOption }
}
