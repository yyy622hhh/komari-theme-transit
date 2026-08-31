import type { ComputedRef } from 'vue'
import type { LoadChartAxisConfig } from '@/composables/useLoadChartAxes'
import type { ChartDashboardCardKey, useAppStore } from '@/stores/app'
import type { getLoadChartPalette } from '@/utils/chartPalette'
import type { getLoadChartThemeColors, getLoadChartTooltipConfig } from '@/utils/loadChartTheme'
import type { RecordFormat } from '@/utils/recordHelper'
import { computed } from 'vue'
import { escapeTooltipHtml, safeTooltipColor } from '@/utils/chartTooltip'
import { formatBytes } from '@/utils/helper'
import { LOAD_CHART_MARGIN, LOAD_CHART_MARGIN_WITH_LEGEND } from '@/utils/loadChartTheme'
import { formatMetricTooltipTime } from '@/utils/metricRange'

interface LoadActivityChartContext {
  appStore: ReturnType<typeof useAppStore>
  baseTooltipConfig: ComputedRef<ReturnType<typeof getLoadChartTooltipConfig>>
  baseXAxisConfig: ComputedRef<LoadChartAxisConfig>
  baseYAxisConfig: ComputedRef<LoadChartAxisConfig>
  chartColors: ReturnType<typeof getLoadChartPalette>
  chartData: ComputedRef<RecordFormat[]>
  chartThemeColors: ComputedRef<ReturnType<typeof getLoadChartThemeColors>>
  effectiveHistoryHours: ComputedRef<number>
  gpuDeviceEntries: () => Array<{ index: number, name: string }>
  hasGpuData: ComputedRef<boolean>
  hasGpuMemoryData: ComputedRef<boolean>
  hasPingData: ComputedRef<boolean>
  hasPingLossData: ComputedRef<boolean>
  hasTemperatureData: ComputedRef<boolean>
  hasTrafficData: ComputedRef<boolean>
  metricSeriesColors: string[]
}

export function useLoadActivityChartOptions(context: LoadActivityChartContext) {
  const {
    appStore,
    baseTooltipConfig,
    baseXAxisConfig,
    baseYAxisConfig,
    chartColors,
    chartData,
    chartThemeColors,
    effectiveHistoryHours,
    gpuDeviceEntries,
    hasGpuData,
    hasGpuMemoryData,
    hasPingData,
    hasPingLossData,
    hasTemperatureData,
    hasTrafficData,
    metricSeriesColors,
  } = context
  const chartMargin = LOAD_CHART_MARGIN
  const chartMarginWithLegend = LOAD_CHART_MARGIN_WITH_LEGEND
  // 网络图表
  const networkChartOption = computed(() => ({
    animation: false,
    color: [chartColors.quinary, chartColors.quaternary],
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
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${safeTooltipColor(item.color)};margin-right:8px;flex-shrink:0"></span>`
          const label = item.seriesName === '下载' ? '↓ 下载' : '↑ 上传'
          html += `<div style="display:flex;align-items:center">${colorDot}<span>${label}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${typeof item.value === 'number' && Number.isFinite(item.value) ? `${formatBytes(item.value)}/s` : '-'}</span></div>`
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      data: ['下载', '上传'],
      bottom: 4,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 20,
      icon: 'roundRect',
      textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
    },
    grid: chartMarginWithLegend,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: '速度',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      axisLabel: {
        ...baseYAxisConfig.value.axisLabel,
        formatter: (val: number) => formatBytes(val),
      },
    },
    series: [
      {
        name: '下载',
        type: 'line',
        data: chartData.value.map(r => r.net_in),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.quinary, cap: 'round' as const },
      },
      {
        name: '上传',
        type: 'line',
        data: chartData.value.map(r => r.net_out),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
      },
    ],
  }))

  const gpuDeviceUsageEChartSeries = computed(() => gpuDeviceEntries().map((device, index) => ({
    name: device.name,
    type: 'line',
    data: chartData.value.map(record => record.gpu_detailed?.[device.index]?.usage ?? null),
    showSymbol: false,
    lineStyle: {
      width: 1.2,
      type: 'dashed' as const,
      color: metricSeriesColors[index % metricSeriesColors.length]!,
      cap: 'round' as const,
    },
  })).filter(series => series.data.some(value => value !== null)))

  // GPU 图表
  const gpuChartOption = computed(() => ({
    animation: false,
    color: [chartColors.senary, chartColors.quaternary],
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
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${safeTooltipColor(item.color)};margin-right:8px;flex-shrink:0"></span>`
          html += `<div style="display:flex;align-items:center">${colorDot}<span>${escapeTooltipHtml(item.seriesName)}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${item.value?.toFixed(1) ?? '-'}%</span></div>`
        }

        if (record.gpu_detailed) {
          html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid ${chartThemeColors.value.splitLineColor}">`
          for (const detail of Object.values(record.gpu_detailed)) {
            const name = detail.device_name || (detail.device_index === undefined ? 'GPU' : `GPU ${detail.device_index}`)
            const usage = detail.usage == null ? '-' : `${detail.usage.toFixed(1)}%`
            const memory = detail.memory == null ? '-' : `${detail.memory.toFixed(1)}%`
            const temp = detail.temperature == null ? '' : ` · ${Math.round(detail.temperature)}℃`
            html += `<div style="display:flex;align-items:center;gap:8px;color:${chartThemeColors.value.textSecondary}"><span>${escapeTooltipHtml(name)}</span><span style="margin-left:auto">${usage} / ${memory}${temp}</span></div>`
          }
          html += '</div>'
        }

        html += '</div>'
        return html
      },
    },
    legend: {
      data: ['GPU 使用率', '显存使用率', ...gpuDeviceUsageEChartSeries.value.map(series => series.name)],
      bottom: 4,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 20,
      icon: 'roundRect',
      textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
    },
    grid: chartMarginWithLegend,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: 'GPU %',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      min: 0,
      max: 100,
      axisLabel: { ...baseYAxisConfig.value.axisLabel, formatter: '{value}%' },
    },
    series: [
      {
        name: 'GPU 使用率',
        type: 'line',
        data: chartData.value.map(r => r.gpu_usage ?? r.gpu),
        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.senary, cap: 'round' as const },
      },
      {
        name: '显存使用率',
        type: 'line',
        data: chartData.value.map(r => r.gpu_memory),
        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
      },
      ...gpuDeviceUsageEChartSeries.value,
    ],
  }))

  const chartDashboardCards = computed(() => appStore.chartDashboardTemplate.cards)

  function isChartCardEnabled(key: ChartDashboardCardKey): boolean {
    if (!chartDashboardCards.value.includes(key))
      return false

    switch (key) {
      case 'gpu':
        return appStore.gpuChartEnabled && hasGpuData.value
      case 'gpuMemory':
        return appStore.gpuChartEnabled && hasGpuMemoryData.value
      case 'traffic':
        return hasTrafficData.value
      case 'temperature':
        return hasTemperatureData.value
      case 'ping':
        return hasPingData.value
      case 'pingLoss':
        return hasPingLossData.value
      default:
        return true
    }
  }

  function getChartCardOrder(key: ChartDashboardCardKey): number {
    const index = chartDashboardCards.value.indexOf(key)
    return index < 0 ? 99 : index
  }

  function getChartCardStyle(key: ChartDashboardCardKey): Record<string, string> {
    return { order: String(getChartCardOrder(key)) }
  }

  // 连接数图表
  const connectionsChartOption = computed(() => ({
    animation: false,
    color: [chartColors.primary, chartColors.tertiary],
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
          const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${safeTooltipColor(item.color)};margin-right:8px;flex-shrink:0"></span>`
          const displayValue = item.value != null ? Math.round(item.value) : '-'
          html += `<div style="display:flex;align-items:center">${colorDot}<span>${escapeTooltipHtml(item.seriesName)}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${displayValue}</span></div>`
        }
        html += '</div>'
        return html
      },
    },
    legend: {
      data: ['TCP', 'UDP'],
      bottom: 4,
      itemWidth: 12,
      itemHeight: 12,
      itemGap: 20,
      icon: 'roundRect',
      textStyle: { fontSize: 11, color: chartThemeColors.value.textSecondary },
    },
    grid: chartMarginWithLegend,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: '连接数',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      min: 0,
      axisLabel: {
        ...baseYAxisConfig.value.axisLabel,
        formatter: (val: number) => Math.round(val).toString(),
      },
    },
    series: [
      {
        name: 'TCP',
        type: 'line',
        data: chartData.value.map(r => r.connections),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
      },
      {
        name: 'UDP',
        type: 'line',
        data: chartData.value.map(r => r.connections_udp),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.tertiary, cap: 'round' as const },
      },
    ],
  }))

  // 进程数图表
  const processChartOption = computed(() => ({
    animation: false,
    color: [chartColors.quaternary],
    tooltip: {
      ...baseTooltipConfig.value,
      formatter: (params: unknown) => {
        const p = params as Array<{ dataIndex: number, value: number, color: string }>
        if (!p.length)
          return ''
        const firstParam = p[0]
        if (!firstParam)
          return ''
        const record = chartData.value[firstParam.dataIndex]
        if (!record)
          return ''

        const timeStr = formatMetricTooltipTime(record.time, effectiveHistoryHours.value)
        const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${firstParam.color};margin-right:8px;flex-shrink:0"></span>`
        const displayValue = firstParam.value != null ? Math.round(firstParam.value) : '-'

        let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
        html += '<div style="display:flex;flex-direction:column;gap:4px">'
        html += `<div style="display:flex;align-items:center">${colorDot}<span>进程数</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${displayValue}</span></div>`
        html += '</div>'
        return html
      },
    },
    grid: chartMargin,
    xAxis: baseXAxisConfig.value,
    yAxis: {
      ...baseYAxisConfig.value,
      name: '进程',
      nameTextStyle: { color: chartThemeColors.value.textSecondary, padding: [0, 40, 0, 0] },
      min: 0,
      axisLabel: {
        ...baseYAxisConfig.value.axisLabel,
        formatter: (val: number) => Math.round(val).toString(),
      },
    },
    series: [
      {
        name: '进程数',
        type: 'line',
        data: chartData.value.map(r => r.process),

        showSymbol: false,
        lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(167, 139, 250, 0.25)' },
              { offset: 1, color: 'rgba(167, 139, 250, 0.02)' },
            ],
          },
        },
      },
    ],
  }))

  return {
    networkChartOption,
    gpuChartOption,
    connectionsChartOption,
    processChartOption,
    isChartCardEnabled,
    getChartCardOrder,
    getChartCardStyle,
  }
}
