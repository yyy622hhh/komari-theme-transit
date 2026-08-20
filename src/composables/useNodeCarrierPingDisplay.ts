import type { MaybeRefOrGetter } from 'vue'
import type { ChinaCarrierKey, NodePingHistoryPoint } from '@/composables/useNodePingStats'
import type { TelemetrySample, TelemetrySampleTone } from '@/types/telemetry'
import { computed } from 'vue'
import { useNodeCarrierPingStats } from '@/composables/useNodePingStats'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

export type CarrierPingBar = TelemetrySample

export interface CarrierPingDisplay {
  key: ChinaCarrierKey
  label: string
  dotClass: string
  taskNames: string[]
  latencyDisplay: string
  volatilityDisplay: string
  lossDisplay: string
  latencyBars: CarrierPingBar[]
  lossBars: CarrierPingBar[]
  latencyTooltip: string
  lossTooltip: string
  stale: boolean
}

const EMPTY_PING_BAR_COUNT = 20

const CARRIER_DOT_CLASSES: Record<ChinaCarrierKey, string> = {
  unicom: 'bg-rose-500',
  telecom: 'bg-blue-500',
  mobile: 'bg-emerald-500',
}

function getLatencyTone(latency: number): { tone: TelemetrySampleTone, toneClass: string } {
  if (latency <= 60)
    return { tone: 'healthy', toneClass: 'bg-emerald-600/90' }
  if (latency <= 100)
    return { tone: 'healthy', toneClass: 'bg-green-400/80' }
  if (latency <= 160)
    return { tone: 'notice', toneClass: 'bg-lime-400/80' }
  if (latency <= 200)
    return { tone: 'warning', toneClass: 'bg-yellow-400/80' }
  return { tone: 'critical', toneClass: 'bg-rose-500/80' }
}

function getLossTone(loss: number): { tone: TelemetrySampleTone, toneClass: string } {
  if (loss <= 1)
    return { tone: 'healthy', toneClass: 'bg-emerald-600/90' }
  if (loss <= 3)
    return { tone: 'healthy', toneClass: 'bg-green-400/90' }
  if (loss <= 6)
    return { tone: 'notice', toneClass: 'bg-lime-400/90' }
  if (loss <= 9)
    return { tone: 'warning', toneClass: 'bg-yellow-400/90' }
  return { tone: 'critical', toneClass: 'bg-rose-500/80' }
}

function formatLoss(value: number | null): string {
  if (value === null)
    return '-'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function buildHistoryBars(
  carrierLabel: string,
  carrierKey: ChinaCarrierKey,
  history: NodePingHistoryPoint[],
  metric: 'latency' | 'loss',
): CarrierPingBar[] {
  return history.map((point, index) => {
    const value = point[metric]
    const visual = value === null
      ? { tone: 'muted' as const, toneClass: 'bg-muted-foreground/15' }
      : metric === 'latency'
        ? getLatencyTone(value)
        : getLossTone(value)
    const latencyText = point.latency === null ? '无响应' : `${Math.round(point.latency)} ms`
    const lossText = `丢包 ${formatLoss(point.loss)}`

    return {
      key: `${carrierKey}-${metric}-${history.length - 1 - index}`,
      ...visual,
      valueText: metric === 'latency' ? latencyText : lossText,
      secondaryText: metric === 'latency' ? lossText : latencyText,
      timeText: formatDateTime(point.time, 'HH:mm:ss'),
      title: carrierLabel,
      ariaLabel: `${carrierLabel}，${latencyText}，${lossText}，${formatDateTime(point.time)}`,
    }
  })
}

function buildEmptyBars(carrierLabel: string, carrierKey: ChinaCarrierKey, metric: 'latency' | 'loss', reason: string): CarrierPingBar[] {
  return Array.from({ length: EMPTY_PING_BAR_COUNT }, (_, index) => ({
    key: `${carrierKey}-${metric}-empty-${index}`,
    tone: 'muted',
    toneClass: 'bg-muted-foreground/10',
    valueText: reason,
    title: carrierLabel,
    ariaLabel: `${carrierLabel}，${reason}`,
  }))
}

export function useNodeCarrierPingDisplay(uuid: MaybeRefOrGetter<string>) {
  const appStore = useAppStore()

  const carrierRegionConfig = computed(() => {
    const fallback = { filter: '北京', labelZh: '北京三网', labelEn: 'Beijing carriers' }
    const configs: Record<string, { filter: string, labelZh: string, labelEn: string }> = {
      all: { filter: '', labelZh: '多地区均值', labelEn: 'Multi-region average' },
      beijing: fallback,
      shanghai: { filter: '上海', labelZh: '上海三网', labelEn: 'Shanghai carriers' },
      guangdong: { filter: '广东', labelZh: '广东三网', labelEn: 'Guangdong carriers' },
    }
    return configs[appStore.carrierPingRegion] ?? fallback
  })

  const carrierScopeLabel = computed(() => appStore.lang === 'zh-CN'
    ? carrierRegionConfig.value.labelZh
    : carrierRegionConfig.value.labelEn)

  const pingStatsEnabled = computed(() => {
    if (appStore.publicSettings?.record_enabled === false)
      return false
    return appStore.publicSettings?.ping_record_preserve_time !== 0
  })

  const pingStatsHours = computed(() => {
    const preserveTime = appStore.publicSettings?.ping_record_preserve_time
    if (typeof preserveTime === 'number' && preserveTime > 0)
      return Math.min(preserveTime, 1)
    return 1
  })

  const carrierStats = useNodeCarrierPingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
    taskNameFilter: () => carrierRegionConfig.value.filter,
  })

  const carrierDisplays = computed<CarrierPingDisplay[]>(() => carrierStats.carriers.value.map((carrier) => {
    const label = appStore.lang === 'zh-CN' ? carrier.labelZh : carrier.labelEn
    const taskHint = carrier.taskNames.length
      ? carrier.taskNames.join(' / ')
      : appStore.lang === 'zh-CN'
        ? `未匹配${carrier.labelZh} Ping 任务`
        : `No ${carrier.labelEn} ping task matched`

    const emptyReason = carrierStats.loading.value
      ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
      : carrierStats.error.value
        ? (appStore.lang === 'zh-CN' ? '加载失败' : 'Load failed')
        : !pingStatsEnabled.value
            ? (appStore.lang === 'zh-CN' ? '未启用 Ping 记录' : 'Ping records disabled')
            : taskHint

    const baseLatencyBars = carrier.stats.history.length
      ? buildHistoryBars(label, carrier.key, carrier.stats.history, 'latency')
      : buildEmptyBars(label, carrier.key, 'latency', emptyReason)
    const baseLossBars = carrier.stats.history.length
      ? buildHistoryBars(label, carrier.key, carrier.stats.history, 'loss')
      : buildEmptyBars(label, carrier.key, 'loss', emptyReason)
    const markStale = (bar: CarrierPingBar): CarrierPingBar => ({
      ...bar,
      tone: 'muted',
      toneClass: 'bg-muted-foreground/20',
      title: `${label} 数据已过期`,
      ariaLabel: `${bar.ariaLabel}，数据已过期`,
    })
    const latencyBars = carrier.stale ? baseLatencyBars.map(markStale) : baseLatencyBars
    const lossBars = carrier.stale ? baseLossBars.map(markStale) : baseLossBars

    const latencyDisplay = carrier.stale
      ? (appStore.lang === 'zh-CN' ? '过期' : 'Stale')
      : carrier.hasLatency
        ? `${Math.round(carrier.stats.avgLatency)} ms`
        : carrierStats.loading.value
          ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
          : '-'
    const lossDisplay = carrier.stale
      ? '-'
      : carrier.stats.hasData
        ? `${carrier.stats.avgLoss.toFixed(1)}%`
        : carrierStats.loading.value
          ? (appStore.lang === 'zh-CN' ? '加载中' : 'Loading')
          : '-'
    const volatilityDisplay = carrier.hasLatency
      ? `±${carrier.stats.avgVolatility.toFixed(1)} ms`
      : '-'

    const latencyTooltip = carrier.hasLatency
      ? `${taskHint}\n${appStore.lang === 'zh-CN' ? '平均延迟' : 'Average latency'} ${Math.round(carrier.stats.avgLatency)} ms`
      : taskHint
    const volatility = carrier.stats.avgVolatility > 0
      ? `，${appStore.lang === 'zh-CN' ? '平均抖动' : 'average jitter'} ${carrier.stats.avgVolatility.toFixed(1)} ms`
      : ''
    const lossTooltip = carrier.stats.hasData
      ? `${taskHint}\n${appStore.lang === 'zh-CN' ? '平均丢包' : 'Average loss'} ${carrier.stats.avgLoss.toFixed(1)}%${volatility}`
      : taskHint

    return {
      key: carrier.key,
      label,
      dotClass: CARRIER_DOT_CLASSES[carrier.key],
      taskNames: carrier.taskNames,
      latencyDisplay,
      volatilityDisplay,
      lossDisplay,
      latencyBars,
      lossBars,
      latencyTooltip,
      lossTooltip,
      stale: carrier.stale,
    }
  }))

  return {
    carrierDisplays,
    carrierScopeLabel,
    loading: carrierStats.loading,
    error: carrierStats.error,
    stale: carrierStats.stale,
  }
}
