<script setup lang="ts">
import type { ChartDashboardCardKey } from '@/stores/app'
import type { RecordFormat } from '@/utils/recordHelper'
import type { MetricSeries, StatusRecord } from '@/utils/rpc'
import { Icon } from '@iconify/vue'
import { useIntervalFn } from '@vueuse/core'
import dayjs from 'dayjs'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import VChart from 'vue-echarts'
import { CardX } from '@/components/ui/card-x'
import { Empty } from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { loadNodeLoadRecords, useNodeLoadStats } from '@/composables/useNodeLoadStats'
import { LOAD_RECORD_MAX_COUNT } from '@/constants/load'
import { loadMetricDefinitions, queryMetrics } from '@/services/metrics.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { formatBytes, formatBytesSplit } from '@/utils/helper'
import { metricTags, normalizeMetricSeriesList } from '@/utils/metricSeries'
import { fillMissingTimePoints } from '@/utils/recordHelper'
import { getSharedRpc } from '@/utils/rpc'
import '@/utils/echarts' // 共享 ECharts 配置

const props = defineProps<{
  uuid: string
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()

// 从 publicSettings 获取记录保留时间
const maxRecordPreserveTime = computed(() => appStore.publicSettings?.record_preserve_time || 720)

const dataUpdateInterval = computed(() => appStore.dataUpdateInterval * 1000)
const detailLoadStatsHours = computed(() => appStore.publicSettings?.record_preserve_time || 720)

// 使用 store 中的 isDark computed
const isDark = computed(() => appStore.isDark)

// 优化后的图表配色方案（基于 Material Design 色彩）
const chartColors = {
  // 主色调 - 珊瑚红
  primary: '#FF6B6B',
  primaryArea: 'rgba(255, 107, 107, 0.15)',
  // 次要色 - 琥珀黄
  secondary: '#FFB347',
  // 第三色 - 青绿色
  tertiary: '#4ECDC4',
  // 第四色 - 紫罗兰
  quaternary: '#A78BFA',
  // 第五色 - 天蓝色
  quinary: '#60A5FA',
  senary: '#34D399',
}

const LOAD_METRIC_KEYS = [
  'cpu.usage',
  'load.average',
  'memory.used',
  'swap.used',
  'disk.used',
  'net.in.rate',
  'net.out.rate',
  'net.total.down',
  'net.total.up',
  'process.count',
  'connections.tcp',
  'connections.udp',
  'gpu.usage',
  'gpu.device.usage',
  'gpu.memory.used',
  'gpu.memory.total',
  'gpu.temperature',
] as const

type LoadMetricKey = typeof LOAD_METRIC_KEYS[number]

// 图表主题相关颜色
const chartThemeColors = computed(() => ({
  text: isDark.value ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
  textSecondary: isDark.value ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.55)',
  textTertiary: isDark.value ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
  borderColor: isDark.value ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
  splitLineColor: isDark.value ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
  tooltipBg: isDark.value ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.8)',
  tooltipShadow: isDark.value ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.06)',
  crosshairColor: isDark.value ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
}))

// 通用 Tooltip 配置
const baseTooltipConfig = computed(() => ({
  trigger: 'axis' as const,
  confine: false,
  backgroundColor: chartThemeColors.value.tooltipBg,
  borderColor: 'transparent',
  borderWidth: 0,
  borderRadius: 6,
  textStyle: {
    color: chartThemeColors.value.text,
    fontSize: 12,
    lineHeight: 20,
  },
  extraCssText: `backdrop-filter: blur(5px);z-index:9;box-shadow:0 0 0 1px ${chartThemeColors.value.tooltipShadow}, 0 0 16px ${chartThemeColors.value.tooltipShadow}`,
  axisPointer: {
    type: 'cross' as const,
    crossStyle: {
      color: chartThemeColors.value.textTertiary,
    },
    lineStyle: {
      color: chartThemeColors.value.crosshairColor,
      width: 1,
      type: 'dashed' as const,
    },
    shadowStyle: {
      color: chartThemeColors.value.crosshairColor,
    },
  },
}))

// 图表边距配置
const chartMargin = { top: 30, right: 24, bottom: 32, left: 56 }
const chartMarginWithLegend = { top: 30, right: 24, bottom: 52, left: 56 }

// 视图选项
const presetViews = [
  { label: '4 小时', hours: 4 },
  { label: '1 天', hours: 24 },
  { label: '7 天', hours: 168 },
  { label: '30 天', hours: 720 },
]

// 可用视图列表
const availableViews = computed(() => {
  const views: { label: string, hours?: number }[] = [{ label: '实时' }]
  const maxHours = maxRecordPreserveTime.value

  for (const v of presetViews) {
    if (maxHours >= v.hours) {
      views.push({ label: v.label, hours: v.hours })
    }
  }

  const maxPreset = presetViews.at(-1)
  if (maxPreset && maxHours > maxPreset.hours) {
    const label = maxHours % 24 === 0
      ? `${Math.floor(maxHours / 24)} 天`
      : `${maxHours} 小时`
    views.push({ label, hours: maxHours })
  }
  else if (maxHours > 4 && !presetViews.some(v => v.hours === maxHours)) {
    const label = maxHours % 24 === 0
      ? `${Math.floor(maxHours / 24)} 天`
      : `${maxHours} 小时`
    views.push({ label, hours: maxHours })
  }

  return views
})

// 当前选中的视图
const selectedView = ref<string>('实时')
const selectedHours = computed(() => {
  const view = availableViews.value.find(v => v.label === selectedView.value)
  return view?.hours
})
const isRealtime = computed(() => selectedView.value === '实时')

// 数据状态
const remoteData = shallowRef<StatusRecord[]>([])
const metricData = shallowRef<RecordFormat[] | null>(null)
const loading = ref(false)
const isInitialLoad = ref(true) // 是否为首次加载（用于控制实时模式下的 NSpin 显示）
const error = ref<string | null>(null)

// 节点信息
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))
const { diskPrediction } = useNodeLoadStats(
  () => props.uuid,
  {
    hours: () => detailLoadStatsHours.value,
    enabled: () => appStore.diskPredictionEnabled && appStore.privateFeaturesAllowed,
    diskTotal: () => nodeInfo.value?.disk_total ?? 0,
    online: () => nodeInfo.value?.online ?? false,
    permission: 'diskPrediction',
  },
)
const diskPredictionSummary = computed(() => {
  const prediction = diskPrediction.value
  if (!appStore.diskPredictionEnabled || !appStore.privateFeaturesAllowed || !prediction)
    return ''

  const days = Math.max(0, Math.ceil(prediction.daysUntilFull))
  const growth = formatBytesSplit(prediction.dailyGrowthBytes, appStore.byteDecimals)
  return days <= 0
    ? `按最近 ${prediction.sampleDays.toFixed(1)} 天趋势，磁盘预计已满`
    : `按最近 ${prediction.sampleDays.toFixed(1)} 天趋势，预计 ${days} 天后满 · 日增 ${growth.value} ${growth.unit}`
})

// RPC 客户端
const rpc = getSharedRpc()

// ==================== 数据获取 ====================

function gpuDetailsFromStatus(record: StatusRecord): RecordFormat['gpu_detailed'] {
  if (!record.gpu_detailed_info?.length)
    return undefined

  const details: NonNullable<RecordFormat['gpu_detailed']> = {}
  record.gpu_detailed_info.forEach((item, index) => {
    const deviceIndex = item.device_index ?? index
    const memUsed = metricValue(item.memory_used)
    const memTotal = metricValue(item.memory_total)
    details[deviceIndex] = {
      usage: metricValue(item.utilization ?? item.usage),
      memory: memUsed != null && memTotal && memTotal > 0 ? memUsed / memTotal * 100 : null,
      temperature: metricValue(item.temperature),
      device_index: deviceIndex,
      device_name: item.device_name || item.name,
      mem_total: memTotal ?? undefined,
      mem_used: memUsed ?? undefined,
    }
  })
  return details
}

function statusToRecordFormat(records: StatusRecord[]): RecordFormat[] {
  return records.map((r) => {
    const gpuDetailed = gpuDetailsFromStatus(r)
    return {
      client: r.client,
      time: r.time,
      cpu: r.cpu ?? null,
      gpu: r.gpu_average_usage ?? r.gpu ?? null,
      gpu_usage: r.gpu_average_usage ?? r.gpu ?? null,
      gpu_memory: null,
      gpu_detailed: gpuDetailed,
      ram: r.ram ?? null,
      ram_total: r.ram_total ?? null,
      swap: r.swap ?? null,
      swap_total: r.swap_total ?? null,
      load: r.load ?? null,
      temp: r.temp ?? null,
      disk: r.disk ?? null,
      disk_total: r.disk_total ?? null,
      net_in: r.net_in ?? null,
      net_out: r.net_out ?? null,
      net_total_up: r.net_total_up ?? null,
      net_total_down: r.net_total_down ?? null,
      process: r.process ?? null,
      connections: r.connections ?? null,
      connections_udp: r.connections_udp ?? null,
    }
  })
}

function metricValue(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getMetricDeviceKey(series: MetricSeries): string {
  const tags = metricTags(series)
  const index = tags.device_index ?? tags.gpu_index ?? tags.index
  const name = tags.device_name ?? tags.gpu_name ?? tags.name
  return String(index ?? name ?? '0')
}

function getMetricDeviceIndex(series: MetricSeries): number {
  const tags = metricTags(series)
  const rawIndex = tags.device_index ?? tags.gpu_index ?? tags.index
  const numericIndex = Number(rawIndex)
  return Number.isFinite(numericIndex) ? numericIndex : Math.abs(getMetricDeviceKey(series).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0))
}

function getMetricDeviceName(series: MetricSeries): string | undefined {
  const tags = metricTags(series)
  const name = tags.device_name ?? tags.gpu_name ?? tags.name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

function ensureMetricRow(rows: Map<string, RecordFormat>, time: string): RecordFormat {
  const existing = rows.get(time)
  if (existing)
    return existing

  const node = nodeInfo.value
  const row: RecordFormat = {
    client: props.uuid,
    time,
    cpu: null,
    gpu: null,
    gpu_usage: null,
    gpu_memory: null,
    ram: null,
    ram_total: node?.mem_total ?? null,
    swap: null,
    swap_total: node?.swap_total ?? null,
    load: null,
    temp: null,
    disk: null,
    disk_total: node?.disk_total ?? null,
    net_in: null,
    net_out: null,
    net_total_up: null,
    net_total_down: null,
    process: null,
    connections: null,
    connections_udp: null,
  }
  rows.set(time, row)
  return row
}

function applyMetricPoint(row: RecordFormat, key: LoadMetricKey, value: number | null, series: MetricSeries): void {
  switch (key) {
    case 'cpu.usage':
      row.cpu = value
      break
    case 'load.average':
      row.load = value
      break
    case 'memory.used':
      row.ram = value
      break
    case 'swap.used':
      row.swap = value
      break
    case 'disk.used':
      row.disk = value
      break
    case 'net.in.rate':
      row.net_in = value
      break
    case 'net.out.rate':
      row.net_out = value
      break
    case 'net.total.down':
      row.net_total_down = value
      break
    case 'net.total.up':
      row.net_total_up = value
      break
    case 'process.count':
      row.process = value
      break
    case 'connections.tcp':
      row.connections = value
      break
    case 'connections.udp':
      row.connections_udp = value
      break
    case 'gpu.usage':
      row.gpu = value
      row.gpu_usage = value
      break
    case 'gpu.device.usage': {
      const deviceIndex = getMetricDeviceIndex(series)
      row.gpu_detailed ??= {}
      row.gpu_detailed[deviceIndex] ??= { usage: null, memory: null, temperature: null, device_index: deviceIndex, device_name: getMetricDeviceName(series) }
      row.gpu_detailed[deviceIndex].usage = value
      row.gpu_usage = row.gpu_usage ?? value
      row.gpu = row.gpu ?? value
      break
    }
    case 'gpu.memory.used': {
      const deviceIndex = getMetricDeviceIndex(series)
      row.gpu_detailed ??= {}
      row.gpu_detailed[deviceIndex] ??= { usage: null, memory: null, temperature: null, device_index: deviceIndex, device_name: getMetricDeviceName(series) }
      row.gpu_detailed[deviceIndex].mem_used = value ?? undefined
      row.gpu_memory = row.gpu_memory ?? value
      break
    }
    case 'gpu.memory.total': {
      const deviceIndex = getMetricDeviceIndex(series)
      row.gpu_detailed ??= {}
      row.gpu_detailed[deviceIndex] ??= { usage: null, memory: null, temperature: null, device_index: deviceIndex, device_name: getMetricDeviceName(series) }
      row.gpu_detailed[deviceIndex].mem_total = value ?? undefined
      break
    }
    case 'gpu.temperature': {
      const deviceIndex = getMetricDeviceIndex(series)
      row.gpu_detailed ??= {}
      row.gpu_detailed[deviceIndex] ??= { usage: null, memory: null, temperature: null, device_index: deviceIndex, device_name: getMetricDeviceName(series) }
      row.gpu_detailed[deviceIndex].temperature = value
      break
    }
  }
}

function finalizeGpuRows(rows: RecordFormat[]): RecordFormat[] {
  for (const row of rows) {
    if (!row.gpu_detailed)
      continue

    const usages: number[] = []
    const memories: number[] = []
    for (const detail of Object.values(row.gpu_detailed)) {
      if (detail.mem_used != null && detail.mem_total && detail.mem_total > 0)
        detail.memory = detail.mem_used / detail.mem_total * 100
      if (typeof detail.usage === 'number' && Number.isFinite(detail.usage))
        usages.push(detail.usage)
      if (typeof detail.memory === 'number' && Number.isFinite(detail.memory))
        memories.push(detail.memory)
    }

    if (row.gpu_usage == null && usages.length)
      row.gpu_usage = usages.reduce((sum, value) => sum + value, 0) / usages.length
    row.gpu ??= row.gpu_usage
    if (row.gpu_memory == null && memories.length)
      row.gpu_memory = memories.reduce((sum, value) => sum + value, 0) / memories.length
  }
  return rows
}

function getGpuDeviceNames(record: RecordFormat | null): string {
  if (!record?.gpu_detailed)
    return nodeInfo.value?.gpu_name || ''
  return Object.values(record.gpu_detailed)
    .map(detail => detail.device_name || (detail.device_index === undefined ? '' : `GPU ${detail.device_index}`))
    .filter(Boolean)
    .join(' / ')
}

function metricSeriesToRecordFormat(seriesList: MetricSeries[]): RecordFormat[] {
  const rows = new Map<string, RecordFormat>()
  const normalizedSeriesList = normalizeMetricSeriesList(seriesList)

  for (const series of normalizedSeriesList) {
    if (!LOAD_METRIC_KEYS.includes(series.metric_key as LoadMetricKey))
      continue

    const key = series.metric_key as LoadMetricKey
    for (const point of series.points) {
      const row = ensureMetricRow(rows, point.time)
      applyMetricPoint(row, key, metricValue(point.value), series)
    }
  }

  return finalizeGpuRows([...rows.values()].sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf()))
}

async function loadMetricHistoryRecords(hours: number): Promise<RecordFormat[] | null> {
  const definitions = await loadMetricDefinitions()
  const availableKeys = new Set(definitions.map(definition => definition.name))
  const metricKeys = LOAD_METRIC_KEYS.filter(key => availableKeys.has(key))
  if (!metricKeys.length)
    return null

  const result = await queryMetrics({
    metric_keys: metricKeys,
    entity_id: props.uuid,
    hours,
    downsample: true,
    fill_empty: true,
    max_points: LOAD_RECORD_MAX_COUNT,
    aggregation: 'avg',
  })

  const records = metricSeriesToRecordFormat(result.series)
  return records.length ? records : null
}

async function fetchRecentData() {
  if (!props.uuid)
    return

  metricData.value = null

  // 只在首次加载时显示 loading
  if (isInitialLoad.value) {
    loading.value = true
  }
  error.value = null

  try {
    const result = await rpc.getNodeRecentStatus(props.uuid)
    const records = result?.records || []
    records.sort((a, b) => dayjs(a.time).valueOf() - dayjs(b.time).valueOf())
    const maxLength = 150
    remoteData.value = records.slice(-maxLength)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : '获取数据失败'
    remoteData.value = []
  }
  finally {
    loading.value = false
    isInitialLoad.value = false
  }
}

async function fetchHistoryData() {
  if (!props.uuid)
    return

  const hours = selectedHours.value || 4

  loading.value = true
  error.value = null

  try {
    const metricRecords = await loadMetricHistoryRecords(hours).catch(() => null)
    if (metricRecords) {
      metricData.value = metricRecords
      remoteData.value = []
    }
    else {
      metricData.value = null
      remoteData.value = await loadNodeLoadRecords(props.uuid, hours)
    }
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : '获取数据失败'
    remoteData.value = []
    metricData.value = null
  }
  finally {
    loading.value = false
  }
}

async function fetchData() {
  if (isRealtime.value) {
    await fetchRecentData()
  }
  else {
    await fetchHistoryData()
  }
}

// ==================== 数据处理 ====================

const chartData = computed(() => {
  const data = metricData.value ?? statusToRecordFormat(remoteData.value)
  if (!data.length)
    return []

  if (isRealtime.value) {
    return data
  }

  const hours = selectedHours.value || 4
  const minute = 60
  const hour = minute * 60
  let intervalSec: number
  let maxGap: number

  if (hours <= 4) {
    intervalSec = minute
    maxGap = minute * 2
  }
  else if (hours > 120) {
    intervalSec = hour
    maxGap = hour * 2
  }
  else {
    intervalSec = minute * 15
    maxGap = minute * 30
  }

  return fillMissingTimePoints(data, intervalSec, hours * 3600, maxGap)
})

const latestStatus = computed(() => {
  const data = chartData.value
  if (!data.length)
    return null
  return data.at(-1) ?? null
})

const hasGpuData = computed(() => chartData.value.some(record => record.gpu != null || record.gpu_usage != null || record.gpu_memory != null || record.gpu_detailed))

// ==================== 工具函数 ====================

function formatTime(time: string, showDate: boolean): string {
  const date = dayjs(time)
  if (showDate) {
    return date.format('M/D HH:mm')
  }
  return date.format('HH:mm')
}

function formatTimeForTooltip(time: string, hours: number): string {
  const date = dayjs(time)
  if (hours < 24) {
    return date.format('HH:mm:ss')
  }
  return date.format('MM/DD HH:mm')
}

const showDateInAxis = computed(() => (selectedHours.value || 1) >= 24)

// 通用 X 轴配置
const baseXAxisConfig = computed(() => ({
  type: 'category' as const,
  data: chartData.value.map(r => formatTime(r.time, showDateInAxis.value)),
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

// ==================== 图表配置 ====================

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

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
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
            { offset: 0, color: 'rgba(255, 107, 107, 0.25)' },
            { offset: 1, color: 'rgba(255, 107, 107, 0.02)' },
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

      const ramUsed = record.ram ?? 0
      const ramTotal = record.ram_total ?? nodeInfo.value?.mem_total ?? 0
      const swapUsed = record.swap ?? 0
      const swapTotal = record.swap_total ?? nodeInfo.value?.swap_total ?? 0
      const ramPercent = ramTotal > 0 ? ((ramUsed / ramTotal) * 100).toFixed(1) : '0'
      const swapPercent = swapTotal > 0 ? ((swapUsed / swapTotal) * 100).toFixed(1) : '0'

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
        if (item.seriesName === 'RAM') {
          html += `<div style="display:flex;align-items:center">${colorDot}<span>RAM</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatBytes(ramUsed)} (${ramPercent}%)</span></div>`
        }
        else if (item.seriesName === 'Swap') {
          html += `<div style="display:flex;align-items:center">${colorDot}<span>Swap</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatBytes(swapUsed)} (${swapPercent}%)</span></div>`
        }
      }
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
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
      data: chartData.value.map(r => r.ram ?? 0),

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
            { offset: 0, color: 'rgba(255, 107, 107, 0.25)' },
            { offset: 1, color: 'rgba(255, 107, 107, 0.02)' },
          ],
        },
      },
    },
    {
      name: 'Swap',
      type: 'line',
      data: chartData.value.map(r => r.swap ?? 0),

      showSymbol: false,
      lineStyle: { width: 1.5, color: chartColors.secondary, cap: 'round' as const },
    },
  ],
}))

// 磁盘图表
const diskChartOption = computed(() => ({
  animation: false,
  color: [chartColors.tertiary],
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

      const diskUsed = record.disk ?? 0
      const diskTotal = record.disk_total ?? nodeInfo.value?.disk_total ?? 0
      const diskPercent = diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : '0'

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
      const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${firstParam.color};margin-right:8px;flex-shrink:0"></span>`

      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'
      html += `<div style="display:flex;align-items:center">${colorDot}<span>磁盘已用</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatBytes(diskUsed)} (${diskPercent}%)</span></div>`
      html += '</div>'
      return html
    },
  },
  grid: chartMargin,
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
      data: chartData.value.map(r => r.disk ?? 0),

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
            { offset: 0, color: 'rgba(78, 205, 196, 0.25)' },
            { offset: 1, color: 'rgba(78, 205, 196, 0.02)' },
          ],
        },
      },
    },
  ],
}))

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

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
        const label = item.seriesName === '下载' ? '↓ 下载' : '↑ 上传'
        html += `<div style="display:flex;align-items:center">${colorDot}<span>${label}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${formatBytes(item.value)}/s</span></div>`
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
      data: chartData.value.map(r => r.net_in ?? 0),

      showSymbol: false,
      lineStyle: { width: 1.5, color: chartColors.quinary, cap: 'round' as const },
    },
    {
      name: '上传',
      type: 'line',
      data: chartData.value.map(r => r.net_out ?? 0),

      showSymbol: false,
      lineStyle: { width: 1.5, color: chartColors.quaternary, cap: 'round' as const },
    },
  ],
}))

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

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
        html += `<div style="display:flex;align-items:center">${colorDot}<span>${item.seriesName}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${item.value?.toFixed(1) ?? '-'}%</span></div>`
      }

      if (record.gpu_detailed) {
        html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid ${chartThemeColors.value.splitLineColor}">`
        for (const detail of Object.values(record.gpu_detailed)) {
          const name = detail.device_name || (detail.device_index === undefined ? 'GPU' : `GPU ${detail.device_index}`)
          const usage = detail.usage == null ? '-' : `${detail.usage.toFixed(1)}%`
          const memory = detail.memory == null ? '-' : `${detail.memory.toFixed(1)}%`
          const temp = detail.temperature == null ? '' : ` · ${Math.round(detail.temperature)}℃`
          html += `<div style="display:flex;align-items:center;gap:8px;color:${chartThemeColors.value.textSecondary}"><span>${name}</span><span style="margin-left:auto">${usage} / ${memory}${temp}</span></div>`
        }
        html += '</div>'
      }

      html += '</div>'
      return html
    },
  },
  legend: {
    data: ['GPU 使用率', '显存使用率'],
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
  ],
}))

const chartDashboardCards = computed(() => appStore.chartDashboardTemplate.cards)

function isChartCardEnabled(key: ChartDashboardCardKey): boolean {
  return chartDashboardCards.value.includes(key) && (key !== 'gpu' || (appStore.gpuChartEnabled && hasGpuData.value))
}

function getChartCardStyle(key: ChartDashboardCardKey): Record<string, string> {
  const index = chartDashboardCards.value.indexOf(key)
  return { order: String(index < 0 ? 99 : index) }
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

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
      let html = `<div style="font-weight:600;margin-bottom:6px;color:${chartThemeColors.value.textSecondary}">${timeStr}</div>`
      html += '<div style="display:flex;flex-direction:column;gap:4px">'

      for (const item of p) {
        const colorDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${item.color};margin-right:8px;flex-shrink:0"></span>`
        const displayValue = item.value != null ? Math.round(item.value) : '-'
        html += `<div style="display:flex;align-items:center">${colorDot}<span>${item.seriesName}</span><span style="margin-left:auto;font-weight:600;margin-left:16px">${displayValue}</span></div>`
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
      data: chartData.value.map(r => r.connections ?? 0),

      showSymbol: false,
      lineStyle: { width: 1.5, color: chartColors.primary, cap: 'round' as const },
    },
    {
      name: 'UDP',
      type: 'line',
      data: chartData.value.map(r => r.connections_udp ?? 0),

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

      const timeStr = formatTimeForTooltip(record.time, selectedHours.value || 1)
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
      data: chartData.value.map(r => r.process ?? 0),

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

// ==================== 实时更新 ====================

// 使用 VueUse 的 useIntervalFn 自动管理定时器
const { pause: pauseRealtimeUpdate, resume: resumeRealtimeUpdate } = useIntervalFn(
  () => fetchData(),
  dataUpdateInterval,
  { immediate: false },
)

// 根据是否为实时模式控制定时器
watch(isRealtime, (realtime) => {
  if (realtime) {
    resumeRealtimeUpdate()
  }
  else {
    pauseRealtimeUpdate()
  }
}, { immediate: true })

// 生命周期 ====================

watch(selectedView, () => {
  isInitialLoad.value = true // 切换视图时重置首次加载状态
  fetchData()
})

watch(() => props.uuid, () => {
  remoteData.value = []
  isInitialLoad.value = true // 切换节点时重置首次加载状态
  fetchData()
})

onMounted(() => {
  fetchData()
})
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 时间选择器 -->
    <Tabs v-model="selectedView" class="w-full items-center">
      <TabsList class="h-8 bg-background/50 backdrop-blur-xl pointer-events-auto rounded-md">
        <TabsTrigger
          v-for="view in availableViews" :key="view.label" :value="view.label"
          class="h-6.5 text-xs border-none data-[state=active]:text-green-600 shadow-none rounded-sm"
        >
          {{ view.label }}
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <!-- 内容区域 -->
    <Spinner :show="loading">
      <div v-if="error" class="text-red-500 py-8 text-center">
        {{ error }}
      </div>
      <div v-else-if="chartData.length === 0 && !loading" class="py-8">
        <Empty description="暂无负载数据" />
      </div>

      <!-- 图表网格 -->
      <div v-else class="gap-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <!-- CPU 卡片 -->
        <CardX v-if="isChartCardEnabled('cpu')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('cpu')">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">CPU</span>
              <div v-if="latestStatus?.cpu != null" class="text-xs flex gap-0.5 items-baseline">
                <span>{{ latestStatus.cpu.toFixed(1) }}</span>
                <span>%</span>
              </div>
              <span v-else>-</span>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="cpuChartOption" autoresize />
          </div>
        </CardX>

        <!-- 内存卡片 -->
        <CardX v-if="isChartCardEnabled('memory')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('memory')">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">内存</span>
              <div class="text-xs flex gap-1 items-baseline">
                <template v-if="latestStatus?.ram != null">
                  <span>{{ formatBytesSplit(latestStatus.ram).value }}</span>
                  <span>{{ formatBytesSplit(latestStatus.ram).unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="nodeInfo?.mem_total">
                  <span>{{
                    formatBytesSplit(nodeInfo.mem_total).value }}</span>
                  <span>{{ formatBytesSplit(nodeInfo.mem_total).unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="memoryChartOption" autoresize />
          </div>
        </CardX>

        <!-- 磁盘卡片 -->
        <CardX v-if="isChartCardEnabled('disk')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('disk')">
          <template #header>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <span class="text-base font-bold">磁盘</span>
                <div v-if="diskPredictionSummary" class="text-[10px] text-orange-500 truncate" :title="diskPredictionSummary">
                  {{ diskPredictionSummary }}
                </div>
              </div>
              <div class="text-xs flex gap-1 items-baseline shrink-0">
                <template v-if="latestStatus?.disk != null">
                  <span>{{ formatBytesSplit(latestStatus.disk).value }}</span>
                  <span>{{ formatBytesSplit(latestStatus.disk).unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="nodeInfo?.disk_total">
                  <span>{{ formatBytesSplit(nodeInfo.disk_total).value }}</span>
                  <span>{{ formatBytesSplit(nodeInfo.disk_total).unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="diskChartOption" autoresize />
          </div>
        </CardX>

        <!-- 网络卡片 -->
        <CardX v-if="isChartCardEnabled('network')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('network')">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">网络</span>
              <div class="text-xs flex gap-2 items-baseline">
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-up" width="12" height="12" />
                  <template v-if="latestStatus?.net_out != null">
                    {{ formatBytesSplit(latestStatus.net_out).value }}
                    {{ formatBytesSplit(latestStatus.net_out).unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-down" width="12" height="12" />
                  <template v-if="latestStatus?.net_in != null">
                    {{ formatBytesSplit(latestStatus.net_in).value }}
                    {{ formatBytesSplit(latestStatus.net_in).unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="networkChartOption" autoresize />
          </div>
        </CardX>

        <!-- GPU 卡片 -->
        <CardX v-if="isChartCardEnabled('gpu')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('gpu')">
          <template #header>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <span class="text-base font-bold">GPU</span>
                <div v-if="getGpuDeviceNames(latestStatus)" class="text-[10px] text-foreground/55 truncate" :title="getGpuDeviceNames(latestStatus)">
                  {{ getGpuDeviceNames(latestStatus) }}
                </div>
              </div>
              <div class="text-xs flex gap-1 items-baseline shrink-0">
                <template v-if="latestStatus?.gpu_usage != null || latestStatus?.gpu != null">
                  <span>{{ (latestStatus.gpu_usage ?? latestStatus.gpu ?? 0).toFixed(1) }}</span>
                  <span>%</span>
                </template>
                <span v-else>-</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="gpuChartOption" autoresize />
          </div>
        </CardX>

        <!-- 连接数卡片 -->
        <CardX v-if="isChartCardEnabled('connections')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('connections')">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">连接</span>
              <div class="text-xs flex gap-1 items-baseline">
                <span>TCP: {{ latestStatus?.connections ?? '-' }}</span>
                <span>·</span>
                <span>UDP: {{ latestStatus?.connections_udp ?? '-' }}</span>
              </div>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="connectionsChartOption" autoresize />
          </div>
        </CardX>

        <!-- 进程卡片 -->
        <CardX v-if="isChartCardEnabled('process')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('process')">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="text-base font-bold">进程</span>
              <span class="text-xs">
                {{ latestStatus?.process ?? '-' }}
              </span>
            </div>
          </template>
          <div class="h-48">
            <VChart :option="processChartOption" autoresize />
          </div>
        </CardX>
      </div>
    </Spinner>
  </div>
</template>
