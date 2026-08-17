import type {
  ChartDashboardCardKey,
  ChartDashboardTemplate,
  ColorVisionMode,
  DetailMetricCardKey,
  GeneralCardKey,
  GlassColorPreset,
  GlassCustomColors,
  HomeQuickControlKey,
  ManagedThemeMode,
  NodeListMetadataField,
  ThemeMode,
} from './app.types'
import type { ByteDecimalsConfig } from '@/utils/helper'

export type GeneralCardPreset = 'official' | 'basic' | 'ops' | 'resource' | 'finance' | 'traffic' | 'gpu' | 'asset' | 'full' | 'custom'
export type HomeQuickControlPreset = 'basic' | 'traffic' | 'ops' | 'full' | 'custom'
export type DetailMetricCardPreset = 'finance' | 'status' | 'resource' | 'network' | 'gpu' | 'full' | 'custom'
export type ChartDashboardPreset = 'all' | 'compact' | 'resource' | 'network' | 'gpu' | 'latency' | 'ops' | 'full' | 'custom' | 'advanced'

export type ThemeSettings = Record<string, unknown>

/** 固定的字节精度配置 */
export const BYTE_DECIMALS: ByteDecimalsConfig = {
  B: 0,
  KB: 0,
  MB: 1,
  GB: 1,
  TB: 2,
}

export const DEFAULT_GENERAL_CARD_ORDER: GeneralCardKey[] = [
  'memory',
  'disk',
  'remainingValue',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
]

export const ALL_GENERAL_CARD_KEYS = [
  'currentTime',
  'memory',
  'disk',
  'remainingValue',
  'monthlyCost',
  'totalTraffic',
  'uploadSpeed',
  'downloadSpeed',
  'onlineNodes',
  'offlineNodes',
  'avgCpu',
  'avgGpu',
  'avgLoad',
  'swap',
  'processes',
  'connections',
  'cpuCores',
  'gpuNodes',
  'gpuPeakNode',
  'trafficQuota',
  'trafficPeak',
  'uploadPeakNode',
  'downloadPeakNode',
  'highLoadNodes',
  'expiringNodes',
  'trafficWarnings',
  'connectionPeakNode',
  'regionDistribution',
  'systemDistribution',
  'virtualizationDistribution',
  'yearlyCost',
] as const satisfies readonly GeneralCardKey[]

export const DEFAULT_GENERAL_CARD_ENABLED: Record<GeneralCardKey, boolean> = {
  currentTime: false,
  memory: true,
  disk: true,
  remainingValue: true,
  totalTraffic: true,
  uploadSpeed: true,
  downloadSpeed: true,
  onlineNodes: false,
  avgCpu: false,
  avgGpu: false,
  avgLoad: false,
  swap: false,
  processes: false,
  connections: false,
  cpuCores: false,
  gpuNodes: false,
  gpuPeakNode: false,
  trafficQuota: false,
  trafficPeak: false,
  uploadPeakNode: false,
  downloadPeakNode: false,
  offlineNodes: false,
  highLoadNodes: false,
  expiringNodes: false,
  trafficWarnings: false,
  connectionPeakNode: false,
  regionDistribution: false,
  systemDistribution: false,
  virtualizationDistribution: false,
  monthlyCost: false,
  yearlyCost: false,
}

export const LEGACY_GENERAL_CARD_SETTING_KEYS: Partial<Record<GeneralCardKey, string>> = {
  memory: 'generalCardMemoryEnabled',
  disk: 'generalCardDiskEnabled',
  remainingValue: 'generalCardRemainingValueEnabled',
  totalTraffic: 'generalCardTotalTrafficEnabled',
  uploadSpeed: 'generalCardUploadSpeedEnabled',
  downloadSpeed: 'generalCardDownloadSpeedEnabled',
  onlineNodes: 'generalCardOnlineNodesEnabled',
  avgCpu: 'generalCardAvgCpuEnabled',
  avgLoad: 'generalCardAvgLoadEnabled',
  swap: 'generalCardSwapEnabled',
  processes: 'generalCardProcessesEnabled',
  connections: 'generalCardConnectionsEnabled',
  cpuCores: 'generalCardCpuCoresEnabled',
  trafficQuota: 'generalCardTrafficQuotaEnabled',
}

export const DEFAULT_HOME_QUICK_CONTROL_ORDER: HomeQuickControlKey[] = [
  'favorite',
  'totalTraffic',
  'peak',
  'offline',
  'highLoad',
  'expiring',
]

export const ALL_HOME_QUICK_CONTROL_KEYS = [
  ...DEFAULT_HOME_QUICK_CONTROL_ORDER,
  'monthlyCost',
  'upload',
  'download',
] as const satisfies readonly HomeQuickControlKey[]

export const DEFAULT_NODE_LIST_METADATA_FIELDS: NodeListMetadataField[] = [
  'provider',
  'region',
  'asn',
]

export const DEFAULT_CHART_DASHBOARD_CARDS: ChartDashboardCardKey[] = ['cpu', 'memory', 'disk', 'network', 'gpu', 'connections', 'process']
export const ALL_CHART_DASHBOARD_CARDS = [
  ...DEFAULT_CHART_DASHBOARD_CARDS,
  'traffic',
  'gpuMemory',
  'temperature',
  'ping',
  'pingLoss',
] as const satisfies readonly ChartDashboardCardKey[]

export const DEFAULT_DETAIL_METRIC_CARD_ORDER: DetailMetricCardKey[] = [
  'nodePrice',
  'monthlyCost',
  'remainingTime',
  'remainingValue',
]

export const ALL_DETAIL_METRIC_CARD_KEYS = [
  ...DEFAULT_DETAIL_METRIC_CARD_ORDER,
  'cpuUsage',
  'gpuUsage',
  'memoryUsage',
  'swapUsage',
  'diskUsage',
  'load',
  'temperature',
  'processes',
  'connections',
  'uptime',
  'uploadSpeed',
  'downloadSpeed',
  'totalTraffic',
  'trafficQuota',
] as const satisfies readonly DetailMetricCardKey[]

export const ALL_NODE_LIST_METADATA_FIELDS = [
  ...DEFAULT_NODE_LIST_METADATA_FIELDS,
  'tags',
  'group',
] as const satisfies readonly NodeListMetadataField[]

export const GENERAL_CARD_PRESETS: Record<GeneralCardPreset, GeneralCardKey[]> = {
  official: [
    'currentTime',
    'onlineNodes',
    'regionDistribution',
    'totalTraffic',
    'uploadSpeed',
    'downloadSpeed',
  ],
  basic: DEFAULT_GENERAL_CARD_ORDER,
  ops: [
    'onlineNodes',
    'offlineNodes',
    'highLoadNodes',
    'trafficWarnings',
    'avgCpu',
    'avgLoad',
  ],
  resource: [
    'avgCpu',
    'avgLoad',
    'memory',
    'disk',
    'swap',
    'cpuCores',
  ],
  finance: [
    'remainingValue',
    'monthlyCost',
    'yearlyCost',
    'expiringNodes',
    'totalTraffic',
    'trafficQuota',
  ],
  traffic: [
    'totalTraffic',
    'trafficQuota',
    'uploadSpeed',
    'downloadSpeed',
    'trafficPeak',
    'trafficWarnings',
  ],
  gpu: [
    'gpuNodes',
    'avgGpu',
    'gpuPeakNode',
    'avgCpu',
    'memory',
    'trafficPeak',
  ],
  asset: [
    'onlineNodes',
    'regionDistribution',
    'systemDistribution',
    'virtualizationDistribution',
    'cpuCores',
    'gpuNodes',
  ],
  full: [...ALL_GENERAL_CARD_KEYS],
  custom: DEFAULT_GENERAL_CARD_ORDER,
}

export const HOME_QUICK_CONTROL_PRESETS: Record<HomeQuickControlPreset, HomeQuickControlKey[]> = {
  basic: ['favorite', 'peak', 'offline'],
  traffic: ['favorite', 'totalTraffic', 'peak'],
  ops: ['favorite', 'offline', 'highLoad', 'expiring'],
  full: DEFAULT_HOME_QUICK_CONTROL_ORDER,
  custom: DEFAULT_HOME_QUICK_CONTROL_ORDER,
}

export const DETAIL_METRIC_CARD_PRESETS: Record<DetailMetricCardPreset, DetailMetricCardKey[]> = {
  finance: ['nodePrice', 'monthlyCost', 'remainingTime', 'remainingValue', 'totalTraffic', 'trafficQuota', 'uptime', 'connections'],
  status: ['cpuUsage', 'memoryUsage', 'diskUsage', 'load', 'temperature', 'uptime', 'processes', 'connections'],
  resource: ['cpuUsage', 'gpuUsage', 'memoryUsage', 'swapUsage', 'diskUsage', 'load', 'temperature', 'processes', 'connections', 'uptime', 'uploadSpeed', 'downloadSpeed'],
  network: ['uploadSpeed', 'downloadSpeed', 'totalTraffic', 'trafficQuota', 'connections', 'processes', 'uptime', 'remainingTime'],
  gpu: ['gpuUsage', 'cpuUsage', 'memoryUsage', 'temperature', 'load', 'processes', 'connections', 'uptime'],
  full: ['nodePrice', 'monthlyCost', 'remainingTime', 'remainingValue', 'cpuUsage', 'gpuUsage', 'memoryUsage', 'swapUsage', 'diskUsage', 'load', 'temperature', 'processes', 'connections', 'uploadSpeed', 'downloadSpeed', 'totalTraffic'],
  custom: DEFAULT_DETAIL_METRIC_CARD_ORDER,
}

export const CHART_DASHBOARD_PRESETS: Record<Exclude<ChartDashboardPreset, 'advanced'>, ChartDashboardCardKey[]> = {
  all: DEFAULT_CHART_DASHBOARD_CARDS,
  compact: ['cpu', 'memory', 'network'],
  resource: ['cpu', 'memory', 'disk', 'temperature', 'process'],
  network: ['network', 'traffic', 'connections'],
  gpu: ['gpu', 'gpuMemory', 'temperature', 'cpu', 'memory'],
  latency: ['ping', 'pingLoss', 'network'],
  ops: ['cpu', 'memory', 'disk', 'network', 'temperature', 'connections', 'process', 'ping', 'pingLoss'],
  full: ['cpu', 'memory', 'disk', 'network', 'traffic', 'gpu', 'gpuMemory', 'temperature', 'connections', 'process', 'ping', 'pingLoss'],
  custom: DEFAULT_CHART_DASHBOARD_CARDS,
}

export const GENERAL_CARD_PRESET_ALIASES: Record<string, GeneralCardPreset> = {
  official: 'official',
  官方: 'official',
  basic: 'basic',
  基础: 'basic',
  ops: 'ops',
  运维: 'ops',
  resource: 'resource',
  资源: 'resource',
  finance: 'finance',
  财务: 'finance',
  traffic: 'traffic',
  流量: 'traffic',
  gpu: 'gpu',
  GPU: 'gpu',
  asset: 'asset',
  资产: 'asset',
  full: 'full',
  完整: 'full',
  custom: 'custom',
  自定义: 'custom',
}

export const GENERAL_CARD_SLOT_COUNT = 8
export const GENERAL_CARD_LABEL_ALIASES: Record<string, GeneralCardKey> = {
  当前时间: 'currentTime',
  内存用量: 'memory',
  硬盘用量: 'disk',
  剩余价值: 'remainingValue',
  累计流量: 'totalTraffic',
  实时上行: 'uploadSpeed',
  实时下行: 'downloadSpeed',
  在线节点: 'onlineNodes',
  离线节点: 'offlineNodes',
  平均CPU: 'avgCpu',
  平均GPU: 'avgGpu',
  平均负载: 'avgLoad',
  交换内存: 'swap',
  进程总数: 'processes',
  连接数: 'connections',
  CPU核心: 'cpuCores',
  GPU节点: 'gpuNodes',
  GPU峰值: 'gpuPeakNode',
  流量配额: 'trafficQuota',
  实时峰值: 'trafficPeak',
  上行最高: 'uploadPeakNode',
  下行最高: 'downloadPeakNode',
  高负载节点: 'highLoadNodes',
  即将到期: 'expiringNodes',
  流量预警: 'trafficWarnings',
  连接峰值: 'connectionPeakNode',
  地区分布: 'regionDistribution',
  系统分布: 'systemDistribution',
  虚拟化分布: 'virtualizationDistribution',
  月费用估算: 'monthlyCost',
  年费用估算: 'yearlyCost',
}

export const DETAIL_METRIC_CARD_SLOT_COUNT = 8
export const DETAIL_METRIC_CARD_PRESET_ALIASES: Record<string, DetailMetricCardPreset> = {
  finance: 'finance',
  财务: 'finance',
  status: 'status',
  状态: 'status',
  resource: 'resource',
  资源: 'resource',
  network: 'network',
  网络: 'network',
  gpu: 'gpu',
  GPU: 'gpu',
  full: 'full',
  综合: 'full',
  custom: 'custom',
  自定义: 'custom',
}

export const DETAIL_METRIC_CARD_LABEL_ALIASES: Record<string, DetailMetricCardKey> = {
  节点价格: 'nodePrice',
  月均支出: 'monthlyCost',
  剩余时间: 'remainingTime',
  剩余价值: 'remainingValue',
  CPU使用率: 'cpuUsage',
  GPU使用率: 'gpuUsage',
  内存使用率: 'memoryUsage',
  交换内存使用率: 'swapUsage',
  硬盘使用率: 'diskUsage',
  系统负载: 'load',
  系统温度: 'temperature',
  进程数: 'processes',
  连接数: 'connections',
  运行时间: 'uptime',
  实时上行: 'uploadSpeed',
  实时下行: 'downloadSpeed',
  累计流量: 'totalTraffic',
  流量配额: 'trafficQuota',
}

export const CHART_DASHBOARD_SLOT_COUNT = 7
export const CHART_DASHBOARD_PRESET_ALIASES: Record<string, ChartDashboardPreset> = {
  all: 'all',
  默认: 'all',
  compact: 'compact',
  精简: 'compact',
  resource: 'resource',
  资源: 'resource',
  network: 'network',
  网络: 'network',
  gpu: 'gpu',
  GPU: 'gpu',
  latency: 'latency',
  延迟: 'latency',
  ops: 'ops',
  运维: 'ops',
  full: 'full',
  完整: 'full',
  custom: 'custom',
  自定义: 'custom',
  advanced: 'advanced',
  高级JSON: 'advanced',
}

export const CHART_DASHBOARD_LABEL_ALIASES: Record<string, ChartDashboardCardKey> = {
  CPU: 'cpu',
  内存: 'memory',
  硬盘: 'disk',
  网络: 'network',
  流量: 'traffic',
  GPU: 'gpu',
  GPU显存: 'gpuMemory',
  温度: 'temperature',
  连接: 'connections',
  进程: 'process',
  延迟: 'ping',
  丢包: 'pingLoss',
}

export const HOME_QUICK_CONTROL_PRESET_ALIASES: Record<string, HomeQuickControlPreset> = {
  basic: 'basic',
  基础: 'basic',
  traffic: 'traffic',
  流量: 'traffic',
  ops: 'ops',
  运维: 'ops',
  full: 'full',
  完整: 'full',
  custom: 'custom',
  自定义: 'custom',
}

export const GLASS_COLOR_PRESET_ALIASES: Record<string, GlassColorPreset> = {
  emerald: 'emerald',
  翡翠: 'emerald',
  soft: 'soft',
  柔和: 'soft',
  contrast: 'contrast',
  高对比: 'contrast',
  midnight: 'midnight',
  午夜: 'midnight',
  custom: 'custom',
  自定义: 'custom',
}

export const COLOR_VISION_MODE_ALIASES: Record<string, ColorVisionMode> = {
  default: 'default',
  标准: 'default',
  accessible: 'accessible',
  colorblind: 'accessible',
  色觉友好: 'accessible',
}

export const DEFAULT_GLASS_CUSTOM_COLORS: GlassCustomColors = {
  lightCard: '#f1f5f9bd',
  lightControl: '#e2e8f0c2',
  lightText: '#14151a',
  lightMutedText: '#3f4552',
  lightBorder: '#cbd5e199',
  darkCard: '#0d111ad9',
  darkControl: '#101624cc',
  darkText: '#f7f8fb',
  darkMutedText: '#d6dae4',
  darkBorder: '#ffffff2e',
}

export const HEX_COLOR_REGEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i
export const KEY_LIST_SEPARATOR_REGEX = /[\s,，;；]+/u

export function isValidThemeMode(value: unknown): value is ThemeMode {
  return value === 'auto' || value === 'light' || value === 'dark'
}

export function isValidManagedThemeMode(value: unknown): value is ManagedThemeMode {
  return value === 'beijing' || value === 'light' || value === 'dark'
}

export function getBeijingHour(timestamp: number): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(timestamp))

  const parsed = Number.parseInt(hour, 10)
  if (!Number.isFinite(parsed))
    return new Date(timestamp).getHours()

  return parsed === 24 ? 0 : parsed
}

export function isGeneralCardKey(value: string): value is GeneralCardKey {
  return (ALL_GENERAL_CARD_KEYS as readonly string[]).includes(value)
}

export function isDetailMetricCardKey(value: string): value is DetailMetricCardKey {
  return (ALL_DETAIL_METRIC_CARD_KEYS as readonly string[]).includes(value)
}

export function isHomeQuickControlKey(value: string): value is HomeQuickControlKey {
  return (ALL_HOME_QUICK_CONTROL_KEYS as readonly string[]).includes(value)
}

export function isNodeListMetadataField(value: string): value is NodeListMetadataField {
  return (ALL_NODE_LIST_METADATA_FIELDS as readonly string[]).includes(value)
}

export function isChartDashboardCardKey(value: string): value is ChartDashboardCardKey {
  return (ALL_CHART_DASHBOARD_CARDS as readonly string[]).includes(value)
}

export function parseGeneralCardPreset(value: unknown): GeneralCardPreset {
  if (typeof value !== 'string')
    return 'basic'

  return GENERAL_CARD_PRESET_ALIASES[value.trim()] ?? 'basic'
}

export function parseDetailMetricCardPreset(value: unknown): DetailMetricCardPreset {
  if (typeof value !== 'string')
    return 'finance'

  return DETAIL_METRIC_CARD_PRESET_ALIASES[value.trim()] ?? 'finance'
}

export function parseChartDashboardPreset(value: unknown): ChartDashboardPreset {
  if (typeof value !== 'string')
    return 'all'

  return CHART_DASHBOARD_PRESET_ALIASES[value.trim()] ?? 'all'
}

export function parseGeneralCardSlots(settings: ThemeSettings): GeneralCardKey[] {
  const keys: GeneralCardKey[] = []
  const seenKeys = new Set<GeneralCardKey>()

  for (let index = 1; index <= GENERAL_CARD_SLOT_COUNT; index += 1) {
    const value = settings[`generalCardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isGeneralCardKey(normalized)
      ? normalized
      : GENERAL_CARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseDetailMetricCardSlots(settings: ThemeSettings): DetailMetricCardKey[] {
  const keys: DetailMetricCardKey[] = []
  const seenKeys = new Set<DetailMetricCardKey>()

  for (let index = 1; index <= DETAIL_METRIC_CARD_SLOT_COUNT; index += 1) {
    const value = settings[`detailMetricCardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isDetailMetricCardKey(normalized)
      ? normalized
      : DETAIL_METRIC_CARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseChartDashboardSlots(settings: ThemeSettings): ChartDashboardCardKey[] {
  const keys: ChartDashboardCardKey[] = []
  const seenKeys = new Set<ChartDashboardCardKey>()

  for (let index = 1; index <= CHART_DASHBOARD_SLOT_COUNT; index += 1) {
    const value = settings[`chartDashboardSlot${index}`]
    if (typeof value !== 'string')
      continue

    const normalized = value.trim()
    const key = isChartDashboardCardKey(normalized)
      ? normalized
      : CHART_DASHBOARD_LABEL_ALIASES[normalized]
    if (!key || seenKeys.has(key))
      continue

    keys.push(key)
    seenKeys.add(key)
  }

  return keys
}

export function parseHomeQuickControlPreset(value: unknown): HomeQuickControlPreset {
  if (typeof value !== 'string')
    return 'full'

  return HOME_QUICK_CONTROL_PRESET_ALIASES[value.trim()] ?? 'full'
}

export function normalizeHomeQuickControlOrder(keys: HomeQuickControlKey[]): HomeQuickControlKey[] {
  return [...new Set(keys)]
}

export function parseKeyList<T extends string>(rawValue: unknown, isValid: (value: string) => value is T, fallback: readonly T[]): T[] {
  const parsedKeys: T[] = []
  const seenKeys = new Set<T>()

  const rawItems = Array.isArray(rawValue)
    ? rawValue
    : typeof rawValue === 'string'
      ? rawValue.split(KEY_LIST_SEPARATOR_REGEX)
      : []

  for (const item of rawItems) {
    const key = typeof item === 'string' ? item.trim() : ''
    if (!isValid(key) || seenKeys.has(key))
      continue
    parsedKeys.push(key)
    seenKeys.add(key)
  }

  return parsedKeys.length > 0 ? parsedKeys : [...fallback]
}

export function parseChartDashboardTemplate(rawValue: unknown): ChartDashboardTemplate {
  if (!rawValue)
    return { cards: [...DEFAULT_CHART_DASHBOARD_CARDS] }

  let value: unknown = rawValue
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    }
    catch {
      return { cards: parseKeyList(value, isChartDashboardCardKey, DEFAULT_CHART_DASHBOARD_CARDS) }
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { cards: [...DEFAULT_CHART_DASHBOARD_CARDS] }

  const record = value as Record<string, unknown>
  return {
    cards: parseKeyList(record.cards ?? record.layout, isChartDashboardCardKey, DEFAULT_CHART_DASHBOARD_CARDS),
  }
}

export function readBooleanSetting(settings: ThemeSettings, key: string, fallback: boolean): boolean {
  const value = settings[key]
  return typeof value === 'boolean' ? value : fallback
}

export function readNumberSetting(settings: ThemeSettings, key: string, fallback: number, min: number, max: number): number {
  const value = settings[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    return fallback

  return Math.min(Math.max(value, min), max)
}

export function readStringSetting(settings: ThemeSettings, key: string, fallback = ''): string {
  const value = settings[key]
  return typeof value === 'string' ? value.trim() : fallback
}

export function readColorSetting(settings: ThemeSettings, key: string, fallback: string): string {
  const trimmed = readStringSetting(settings, key, fallback)
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed : fallback
}

export function readColorValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string')
    return fallback
  const trimmed = value.trim()
  return HEX_COLOR_REGEX.test(trimmed) ? trimmed : fallback
}

export function parseGlassCustomColors(settings: ThemeSettings): GlassCustomColors {
  const legacyColors: GlassCustomColors = {
    lightCard: readColorSetting(settings, 'glassLightCardColor', DEFAULT_GLASS_CUSTOM_COLORS.lightCard),
    lightControl: readColorSetting(settings, 'glassLightControlColor', DEFAULT_GLASS_CUSTOM_COLORS.lightControl),
    lightText: readColorSetting(settings, 'glassLightTextColor', DEFAULT_GLASS_CUSTOM_COLORS.lightText),
    lightMutedText: readColorSetting(settings, 'glassLightMutedTextColor', DEFAULT_GLASS_CUSTOM_COLORS.lightMutedText),
    lightBorder: readColorSetting(settings, 'glassLightBorderColor', DEFAULT_GLASS_CUSTOM_COLORS.lightBorder),
    darkCard: readColorSetting(settings, 'glassDarkCardColor', DEFAULT_GLASS_CUSTOM_COLORS.darkCard),
    darkControl: readColorSetting(settings, 'glassDarkControlColor', DEFAULT_GLASS_CUSTOM_COLORS.darkControl),
    darkText: readColorSetting(settings, 'glassDarkTextColor', DEFAULT_GLASS_CUSTOM_COLORS.darkText),
    darkMutedText: readColorSetting(settings, 'glassDarkMutedTextColor', DEFAULT_GLASS_CUSTOM_COLORS.darkMutedText),
    darkBorder: readColorSetting(settings, 'glassDarkBorderColor', DEFAULT_GLASS_CUSTOM_COLORS.darkBorder),
  }

  let rawValue = settings.glassCustomColors
  if (typeof rawValue === 'string') {
    try {
      rawValue = JSON.parse(rawValue) as unknown
    }
    catch {
      return legacyColors
    }
  }

  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue))
    return legacyColors

  const record = rawValue as Record<keyof GlassCustomColors, unknown>
  return {
    lightCard: readColorValue(record.lightCard, legacyColors.lightCard),
    lightControl: readColorValue(record.lightControl, legacyColors.lightControl),
    lightText: readColorValue(record.lightText, legacyColors.lightText),
    lightMutedText: readColorValue(record.lightMutedText, legacyColors.lightMutedText),
    lightBorder: readColorValue(record.lightBorder, legacyColors.lightBorder),
    darkCard: readColorValue(record.darkCard, legacyColors.darkCard),
    darkControl: readColorValue(record.darkControl, legacyColors.darkControl),
    darkText: readColorValue(record.darkText, legacyColors.darkText),
    darkMutedText: readColorValue(record.darkMutedText, legacyColors.darkMutedText),
    darkBorder: readColorValue(record.darkBorder, legacyColors.darkBorder),
  }
}

export function parseGlassColorPreset(value: unknown): GlassColorPreset {
  if (typeof value !== 'string')
    return 'emerald'
  return GLASS_COLOR_PRESET_ALIASES[value.trim()] ?? 'emerald'
}

export function parseColorVisionMode(value: unknown): ColorVisionMode {
  if (typeof value !== 'string')
    return 'default'
  return COLOR_VISION_MODE_ALIASES[value.trim()] ?? 'default'
}
