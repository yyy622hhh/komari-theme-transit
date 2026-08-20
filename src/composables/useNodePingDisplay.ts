import type { MaybeRefOrGetter } from 'vue'
import type { TelemetrySample, TelemetrySampleTone } from '@/types/telemetry'
import { computed, toValue } from 'vue'
import { useNodePingStats } from '@/composables/useNodePingStats'
import { PING_SUMMARY_MAX_COUNT } from '@/constants/load'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'

export type NodePingMetric = 'latency' | 'loss'

export type NodePingBar = TelemetrySample

interface UseNodePingDisplayOptions {
  enabled?: MaybeRefOrGetter<boolean>
  loadingDisplayText?: string
  emptyDisplayText?: string
  loadingPanelTooltipText?: Partial<Record<NodePingMetric, string>>
  emptyPanelTooltipText?: Partial<Record<NodePingMetric, string>>
}

const EMPTY_PING_BAR_COUNT = 20

function getLatencyTone(latency: number): { tone: TelemetrySampleTone, toneClass: string } {
  if (latency <= 60)
    return { tone: 'healthy', toneClass: 'bg-signal-1' }
  if (latency <= 100)
    return { tone: 'healthy', toneClass: 'bg-signal-2' }
  if (latency <= 160)
    return { tone: 'notice', toneClass: 'bg-signal-3 ping-signal-pattern-2' }
  if (latency <= 200)
    return { tone: 'warning', toneClass: 'bg-signal-4 ping-signal-pattern-3' }
  return { tone: 'critical', toneClass: 'bg-signal-5 ping-signal-pattern-4' }
}

function getLossTone(loss: number): { tone: TelemetrySampleTone, toneClass: string } {
  if (loss <= 1)
    return { tone: 'healthy', toneClass: 'bg-signal-1' }
  if (loss <= 3)
    return { tone: 'healthy', toneClass: 'bg-signal-2' }
  if (loss <= 6)
    return { tone: 'notice', toneClass: 'bg-signal-3 ping-signal-pattern-2' }
  if (loss <= 9)
    return { tone: 'warning', toneClass: 'bg-signal-4 ping-signal-pattern-3' }
  return { tone: 'critical', toneClass: 'bg-signal-5 ping-signal-pattern-4' }
}

function formatLoss(value: number | null): string {
  if (value === null)
    return '-'
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

export function useNodePingDisplay(
  uuid: MaybeRefOrGetter<string>,
  options: UseNodePingDisplayOptions = {},
) {
  const appStore = useAppStore()

  const pingStatsEnabled = computed(() => {
    if (toValue(options.enabled) === false)
      return false
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

  const pingStats = useNodePingStats(uuid, {
    hours: pingStatsHours,
    enabled: pingStatsEnabled,
    maxCount: PING_SUMMARY_MAX_COUNT,
  })

  function buildPingBars(metric: NodePingMetric): NodePingBar[] {
    const points = pingStats.history.value
    if (!points.length)
      return []

    return points.map((point, index) => {
      const value = point[metric]
      const visual = value === null
        ? { tone: 'muted' as const, toneClass: 'bg-muted-foreground/15' }
        : metric === 'latency'
          ? getLatencyTone(value)
          : getLossTone(value)
      const latencyText = point.latency === null ? '无响应' : `${Math.round(point.latency)} ms`
      const lossText = `丢包 ${formatLoss(point.loss)}`

      return {
        key: `${metric}-${points.length - 1 - index}`,
        ...visual,
        valueText: metric === 'latency' ? latencyText : lossText,
        secondaryText: metric === 'latency' ? lossText : latencyText,
        timeText: formatDateTime(point.time, 'HH:mm:ss'),
        ariaLabel: `${latencyText}，${lossText}，${formatDateTime(point.time)}`,
      }
    })
  }

  function buildEmptyPingBars(metric: NodePingMetric): NodePingBar[] {
    const tooltip = pingStats.loading.value
      ? '加载中'
      : pingStats.error.value
        ? '加载失败'
        : !pingStatsEnabled.value
            ? '未启用记录'
            : metric === 'latency'
              ? '无采样数据'
              : '无采样数据'

    return Array.from({ length: EMPTY_PING_BAR_COUNT }, (_, index) => ({
      key: `${metric}-empty-${index}`,
      tone: 'muted',
      toneClass: 'bg-muted-foreground/10',
      valueText: tooltip,
      ariaLabel: tooltip,
    }))
  }

  const latencyBars = computed(() => buildPingBars('latency'))
  const lossBars = computed(() => buildPingBars('loss'))
  const latencyRenderBars = computed(() => latencyBars.value.length ? latencyBars.value : buildEmptyPingBars('latency'))
  const lossRenderBars = computed(() => lossBars.value.length ? lossBars.value : buildEmptyPingBars('loss'))

  const latencyDisplay = computed(() => {
    if (pingStats.hasLatencyData.value)
      return `${Math.round(pingStats.avgLatency.value)} ms`
    if (pingStats.hasData.value)
      return '无响应'
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const lossDisplay = computed(() => {
    if (pingStats.hasData.value)
      return `${pingStats.avgLoss.value.toFixed(1)}%`
    if (pingStats.loading.value)
      return options.loadingDisplayText ?? '加载中'
    return options.emptyDisplayText ?? '-'
  })

  const latencyPanelTooltip = computed(() => {
    if (!pingStats.hasLatencyData.value) {
      if (pingStats.hasData.value)
        return '没有成功的延迟样本'
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.latency ?? ''
      return options.emptyPanelTooltipText?.latency ?? ''
    }
    return `平均延迟 ${Math.round(pingStats.avgLatency.value)} ms`
  })

  const lossPanelTooltip = computed(() => {
    if (!pingStats.hasData.value) {
      if (pingStats.loading.value)
        return options.loadingPanelTooltipText?.loss ?? ''
      return options.emptyPanelTooltipText?.loss ?? ''
    }

    const volatility = pingStats.avgVolatility.value > 0
      ? `，平均波动 ${pingStats.avgVolatility.value.toFixed(2)}`
      : ''
    return `平均丢包 ${pingStats.avgLoss.value.toFixed(1)}%${volatility}`
  })

  return {
    pingStats,
    pingStatsEnabled,
    pingStatsHours,
    latencyRenderBars,
    lossRenderBars,
    latencyDisplay,
    lossDisplay,
    latencyPanelTooltip,
    lossPanelTooltip,
  }
}
