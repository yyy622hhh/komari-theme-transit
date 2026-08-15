import type { RecordFormat } from '@/utils/recordHelper'
import type { MetricSeries, StatusRecord } from '@/utils/rpc'
import dayjs from 'dayjs'
import { metricTags, normalizeMetricSeriesList } from '@/utils/metricSeries'

export const LOAD_METRIC_KEYS = [
  'cpu.usage',
  'load.average',
  'memory.used',
  'memory.total',
  'swap.used',
  'swap.total',
  'temperature',
  'disk.used',
  'disk.total',
  'net.in.rate',
  'net.out.rate',
  'net.total.down',
  'net.total.up',
  'traffic.down',
  'traffic.up',
  'process.count',
  'connections.tcp',
  'connections.udp',
  'gpu.usage',
  'gpu.device.usage',
  'gpu.memory.used',
  'gpu.memory.total',
  'gpu.temperature',
  'ping.latency_ms',
  'ping.loss',
] as const

export type LoadMetricKey = typeof LOAD_METRIC_KEYS[number]

interface MetricRecordContext {
  uuid: string
  memoryTotal?: number | null
  swapTotal?: number | null
  diskTotal?: number | null
}

export function metricValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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

export function statusRecordsToChartRecords(records: StatusRecord[]): RecordFormat[] {
  return records.map((record) => {
    const gpuDetailed = gpuDetailsFromStatus(record)
    return {
      client: record.client,
      time: record.time,
      cpu: metricValue(record.cpu),
      gpu: metricValue(record.gpu_average_usage ?? record.gpu),
      gpu_usage: metricValue(record.gpu_average_usage ?? record.gpu),
      gpu_memory: null,
      gpu_detailed: gpuDetailed,
      ram: metricValue(record.ram),
      ram_total: metricValue(record.ram_total),
      swap: metricValue(record.swap),
      swap_total: metricValue(record.swap_total),
      load: metricValue(record.load),
      temp: metricValue(record.temp),
      disk: metricValue(record.disk),
      disk_total: metricValue(record.disk_total),
      net_in: metricValue(record.net_in),
      net_out: metricValue(record.net_out),
      net_total_up: metricValue(record.net_total_up),
      net_total_down: metricValue(record.net_total_down),
      traffic_up: metricValue(record.traffic_up),
      traffic_down: metricValue(record.traffic_down),
      process: metricValue(record.process),
      connections: metricValue(record.connections),
      connections_udp: metricValue(record.connections_udp),
    }
  })
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

function ensureMetricRow(rows: Map<string, RecordFormat>, time: string, context: MetricRecordContext): RecordFormat {
  const existing = rows.get(time)
  if (existing)
    return existing

  const row: RecordFormat = {
    client: context.uuid,
    time,
    cpu: null,
    gpu: null,
    gpu_usage: null,
    gpu_memory: null,
    ram: null,
    ram_total: context.memoryTotal ?? null,
    swap: null,
    swap_total: context.swapTotal ?? null,
    load: null,
    temp: null,
    disk: null,
    disk_total: context.diskTotal ?? null,
    net_in: null,
    net_out: null,
    net_total_up: null,
    net_total_down: null,
    traffic_up: null,
    traffic_down: null,
    process: null,
    connections: null,
    connections_udp: null,
  }
  rows.set(time, row)
  return row
}

function ensureGpuDetail(row: RecordFormat, series: MetricSeries) {
  const deviceIndex = getMetricDeviceIndex(series)
  row.gpu_detailed ??= {}
  row.gpu_detailed[deviceIndex] ??= {
    usage: null,
    memory: null,
    temperature: null,
    device_index: deviceIndex,
    device_name: getMetricDeviceName(series),
  }
  return row.gpu_detailed[deviceIndex]
}

function applyMetricPoint(row: RecordFormat, key: LoadMetricKey, value: number | null, series: MetricSeries): void {
  const directFields: Partial<Record<LoadMetricKey, keyof RecordFormat>> = {
    'cpu.usage': 'cpu',
    'load.average': 'load',
    'memory.used': 'ram',
    'memory.total': 'ram_total',
    'swap.used': 'swap',
    'swap.total': 'swap_total',
    'temperature': 'temp',
    'disk.used': 'disk',
    'disk.total': 'disk_total',
    'net.in.rate': 'net_in',
    'net.out.rate': 'net_out',
    'net.total.down': 'net_total_down',
    'net.total.up': 'net_total_up',
    'traffic.down': 'traffic_down',
    'traffic.up': 'traffic_up',
    'process.count': 'process',
    'connections.tcp': 'connections',
    'connections.udp': 'connections_udp',
  }
  const field = directFields[key]
  if (field) {
    ;(row[field] as number | null | undefined) = value
    return
  }

  if (key === 'gpu.usage') {
    row.gpu = value
    row.gpu_usage = value
    return
  }

  const detail = ensureGpuDetail(row, series)
  if (key === 'gpu.device.usage') {
    detail.usage = value
    row.gpu_usage ??= value
    row.gpu ??= value
  }
  else if (key === 'gpu.memory.used') {
    detail.mem_used = value ?? undefined
    row.gpu_memory ??= value
  }
  else if (key === 'gpu.memory.total') {
    detail.mem_total = value ?? undefined
  }
  else if (key === 'gpu.temperature') {
    detail.temperature = value
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

export function metricSeriesToChartRecords(seriesList: MetricSeries[], context: MetricRecordContext): RecordFormat[] {
  const rows = new Map<string, RecordFormat>()
  for (const series of normalizeMetricSeriesList(seriesList)) {
    if (!LOAD_METRIC_KEYS.includes(series.metric_key as LoadMetricKey))
      continue
    const key = series.metric_key as LoadMetricKey
    if (key === 'ping.latency_ms' || key === 'ping.loss')
      continue
    for (const point of series.points)
      applyMetricPoint(ensureMetricRow(rows, point.time, context), key, metricValue(point.value), series)
  }
  return finalizeGpuRows([...rows.values()].sort((left, right) => dayjs(left.time).valueOf() - dayjs(right.time).valueOf()))
}

export function getGpuDeviceNames(record: RecordFormat | null, fallbackName = ''): string {
  if (!record?.gpu_detailed)
    return fallbackName
  return Object.values(record.gpu_detailed)
    .map(detail => detail.device_name || (detail.device_index === undefined ? '' : `GPU ${detail.device_index}`))
    .filter(Boolean)
    .join(' / ')
}
