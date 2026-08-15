export type ThemeMode = 'auto' | 'light' | 'dark'
export type ManagedThemeMode = 'beijing' | 'light' | 'dark'
export type Lang = 'zh-CN' | 'en-US'
export type NodeViewMode = 'card' | 'list'
export type NodeCardSize = 'mini' | 'compact' | 'comfortable' | 'large'
export type RpcTransportMode = 'websocket' | 'http'
export type EarthRenderer = 'realistic' | 'cobe' | 'tiled'
export type GlassColorPreset = 'emerald' | 'soft' | 'contrast' | 'midnight' | 'custom'
export type ColorVisionMode = 'default' | 'accessible'

export type GeneralCardKey
  = | 'currentTime'
    | 'memory'
    | 'disk'
    | 'remainingValue'
    | 'totalTraffic'
    | 'uploadSpeed'
    | 'downloadSpeed'
    | 'onlineNodes'
    | 'avgCpu'
    | 'avgGpu'
    | 'avgLoad'
    | 'swap'
    | 'processes'
    | 'connections'
    | 'cpuCores'
    | 'gpuNodes'
    | 'gpuPeakNode'
    | 'trafficQuota'
    | 'trafficPeak'
    | 'uploadPeakNode'
    | 'downloadPeakNode'
    | 'offlineNodes'
    | 'highLoadNodes'
    | 'expiringNodes'
    | 'trafficWarnings'
    | 'connectionPeakNode'
    | 'regionDistribution'
    | 'systemDistribution'
    | 'virtualizationDistribution'
    | 'monthlyCost'
    | 'yearlyCost'

export type HomeQuickControlKey
  = | 'favorite'
    | 'monthlyCost'
    | 'totalTraffic'
    | 'upload'
    | 'download'
    | 'peak'
    | 'offline'
    | 'highLoad'
    | 'expiring'

export type DetailMetricCardKey
  = | 'nodePrice'
    | 'monthlyCost'
    | 'remainingTime'
    | 'remainingValue'
    | 'cpuUsage'
    | 'gpuUsage'
    | 'memoryUsage'
    | 'swapUsage'
    | 'diskUsage'
    | 'load'
    | 'temperature'
    | 'processes'
    | 'connections'
    | 'uptime'
    | 'uploadSpeed'
    | 'downloadSpeed'
    | 'totalTraffic'
    | 'trafficQuota'

export type NodeListMetadataField
  = | 'provider'
    | 'region'
    | 'city'
    | 'asn'
    | 'tags'
    | 'group'

export type ChartDashboardCardKey
  = | 'cpu'
    | 'memory'
    | 'disk'
    | 'network'
    | 'traffic'
    | 'gpu'
    | 'gpuMemory'
    | 'temperature'
    | 'connections'
    | 'process'
    | 'ping'
    | 'pingLoss'

export interface GlassCustomColors {
  lightCard: string
  lightControl: string
  lightText: string
  lightMutedText: string
  lightBorder: string
  darkCard: string
  darkControl: string
  darkText: string
  darkMutedText: string
  darkBorder: string
}

export interface ChartDashboardTemplate {
  cards: ChartDashboardCardKey[]
}
