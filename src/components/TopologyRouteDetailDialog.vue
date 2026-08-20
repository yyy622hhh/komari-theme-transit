<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TelemetrySample } from '@/types/telemetry'
import type { TopologyRouteScore, TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologyRouteRanking, TopologyRouteReliability, TopologySegmentReliabilitySnapshot } from '@/utils/topologyIntelligence'
import { computed, ref } from 'vue'
import TelemetrySampleStrip from '@/components/TelemetrySampleStrip.vue'
import TopologySegmentHistory from '@/components/TopologySegmentHistory.vue'
import { AppDialog } from '@/components/ui/app-dialog'

export interface TopologyDirectionReading {
  sourceName: string
  targetName: string
  sourceUuid: string
  targetUuid: string
  taskName: string
  telemetry?: TopologySegmentTelemetry
}

export interface TopologyDirectionComparison {
  forward: TopologyDirectionReading
  reverse: TopologyDirectionReading
}

export interface TopologyRouteDetail {
  key: string
  sourceUuid?: string
  nodeNames: string[]
  metrics: string[]
  score: TopologyRouteScore
  reliability: TopologyRouteReliability
  ranking?: TopologyRouteRanking
  directionLabel: string
  segmentMetrics: Array<TopologySegmentTelemetry | undefined>
  segmentReliability: Array<TopologySegmentReliabilitySnapshot | undefined>
  directionComparison?: TopologyDirectionComparison
}

const props = defineProps<{ open: boolean, route: TopologyRouteDetail | null, nodes: NodeData[] }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const hours = ref(24)

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

const title = computed(() => props.route?.nodeNames.filter(Boolean).join(' → ') || '线路详情')

function scoreTone(score: TopologyRouteScore): string {
  if (score.tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (score.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (score.tone === 'pending')
    return 'text-slate-500 dark:text-slate-400'
  return 'text-emerald-700 dark:text-emerald-300'
}

function formatAvailability(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(value >= 99.95 ? 2 : 1)}%`
}

function formatLatency(value: number | null): string {
  return value === null ? '-' : `${Math.round(value)} ms`
}

function formatLoss(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function isFreshTelemetry(telemetry: TopologySegmentTelemetry | undefined): telemetry is TopologySegmentTelemetry {
  return Boolean(telemetry?.hasLiveData && !telemetry.stale && telemetry.latency !== null)
}

function directionLatencyDelta(comparison: TopologyDirectionComparison): string | null {
  const forward = comparison.forward.telemetry
  const reverse = comparison.reverse.telemetry
  if (!isFreshTelemetry(forward) || !isFreshTelemetry(reverse))
    return null
  const delta = (forward.latency ?? 0) - (reverse.latency ?? 0)
  const rounded = Math.round(delta)
  if (Math.abs(rounded) < 1)
    return '两个方向延迟接近'
  return rounded > 0 ? `正向高 ${rounded} ms` : `反向高 ${Math.abs(rounded)} ms`
}

function directionFreshnessLabel(reading: TopologyDirectionReading): string {
  if (!reading.telemetry?.hasLiveData)
    return '待数据'
  return reading.telemetry.stale ? '数据已过期' : '实时'
}

function hourlySamples(snapshot: TopologySegmentReliabilitySnapshot, segmentIndex: number): TelemetrySample[] {
  const profile = snapshot.insights?.hourlyProfile ?? []
  const validLatencies = profile.flatMap(bucket => bucket.latencyMedian === null ? [] : [bucket.latencyMedian])
  const maxLatency = Math.max(1, ...validLatencies)
  return profile.map((bucket) => {
    const evening = bucket.hour >= 20 && bucket.hour <= 23
    const hasData = bucket.latencyMedian !== null || bucket.lossMedian !== null
    const latencyText = bucket.latencyMedian === null ? '无延迟数据' : `${Math.round(bucket.latencyMedian)} ms`
    const lossText = bucket.lossMedian === null ? '无丢包数据' : `${bucket.lossMedian.toFixed(bucket.lossMedian >= 10 ? 0 : 1)}% 丢包`
    return {
      key: `segment-${segmentIndex}-hour-${bucket.hour}`,
      tone: hasData ? (evening ? 'warning' : 'healthy') : 'muted',
      toneClass: hasData ? (evening ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-muted-foreground/15',
      valueText: latencyText,
      secondaryText: lossText,
      timeText: `${String(bucket.hour).padStart(2, '0')}:00–${String((bucket.hour + 1) % 24).padStart(2, '0')}:00 · ${bucket.sampleCount} 个样本`,
      title: evening ? '晚高峰 · 北京时间' : '北京时间',
      ariaLabel: `${bucket.hour} 时，${latencyText}，${lossText}，${bucket.sampleCount} 个样本${evening ? '，晚高峰' : ''}`,
      height: hasData && bucket.latencyMedian !== null ? Math.round(4 + bucket.latencyMedian / maxLatency * 8) : 4,
    }
  })
}

function diagnosisTone(diagnosis: NonNullable<NonNullable<TopologySegmentReliabilitySnapshot['insights']>['diagnosis']>): string {
  return diagnosis.kind === 'both'
    ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300'
    : 'border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
}

function baselineShiftLabel(snapshot: TopologySegmentReliabilitySnapshot): string {
  const shift = snapshot.insights?.baselineShift
  if (!shift)
    return ''
  const delta = Math.round(Math.abs(shift.deltaMs))
  return shift.direction === 'degraded' ? `延迟基线升高 ${delta} ms` : `延迟基线降低 ${delta} ms`
}

function formatDeviation(value: number | null): string {
  if (value === null)
    return '待数据'
  const rounded = Math.round(value)
  return `${rounded > 0 ? '+' : ''}${rounded}%`
}

function baselineTone(reliability: TopologyRouteReliability): string {
  if (reliability.adaptive.tone === 'critical')
    return 'text-rose-600 dark:text-rose-400'
  if (reliability.adaptive.tone === 'warning')
    return 'text-amber-700 dark:text-amber-300'
  if (reliability.adaptive.tone === 'healthy')
    return 'text-emerald-700 dark:text-emerald-300'
  return 'text-muted-foreground'
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    :title="title"
    description="查看每一段链路的实时延迟、丢包与历史波动。"
    content-class="max-w-4xl"
  >
    <div v-if="route" class="space-y-4">
      <section data-topology-score-detail class="grid gap-3 rounded-xl border border-border/60 bg-background/35 p-3.5 sm:grid-cols-[120px_1fr]">
        <div class="flex items-baseline gap-2 sm:block">
          <strong class="text-3xl font-semibold tabular-nums" :class="scoreTone(route.score)">{{ route.score.score }}</strong>
          <span data-topology-detail-score-label class="text-xs font-medium" :class="scoreTone(route.score)">{{ route.score.label }}</span>
          <div class="mt-1 hidden text-[10px] text-muted-foreground sm:block">
            线路健康评分
          </div>
        </div>
        <div class="min-w-0">
          <div class="flex min-w-0 items-center justify-between gap-3 text-[10px] text-muted-foreground">
            <span>主要扣分项</span>
            <span v-if="route.ranking && route.ranking.total > 1" data-topology-detail-ranking class="min-w-0 truncate text-right">
              {{ route.directionLabel }}第 {{ route.ranking.rank }} / {{ route.ranking.total }}
              <span v-if="route.ranking.recommended" class="ml-1 text-emerald-700 dark:text-emerald-300">推荐</span>
            </span>
          </div>
          <div v-if="route.score.deductions.length" class="mt-1.5 grid gap-1 sm:grid-cols-2">
            <div v-for="item in route.score.deductions.slice(0, 4)" :key="item.key" class="flex min-w-0 items-center justify-between gap-3 text-[11px]">
              <span class="truncate text-foreground/80">{{ item.label }}</span>
              <span class="shrink-0 tabular-nums text-muted-foreground">-{{ item.points }}</span>
            </div>
          </div>
          <div v-else class="mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
            当前没有明显扣分项
          </div>
          <div v-if="route.ranking?.recommended" class="mt-1.5 truncate text-[10px] text-muted-foreground" :title="route.ranking.reason">
            推荐依据：{{ route.ranking.reason }}
          </div>
        </div>

        <div class="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/50 pt-3 sm:col-span-2 sm:grid-cols-4">
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              24h 可用率
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatAvailability(route.reliability.day.availability) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.day.hasData ? `最弱分段 · ${route.reliability.day.sampleCount} 次` : `${route.reliability.completeSegments}/${route.reliability.totalSegments} 段有数据` }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              7d 可用率
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatAvailability(route.reliability.week.availability) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.week.hasData ? `最弱分段 · ${route.reliability.week.sampleCount} 次` : '历史数据待积累' }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              24h P95
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums">
              {{ formatLatency(route.reliability.day.p95Latency) }}
            </div>
            <div class="truncate text-[9px] text-muted-foreground">
              {{ route.reliability.day.p95Latency !== null ? '高位延迟参考' : route.reliability.day.hasData && route.reliability.totalSegments > 1 ? '需端到端样本' : '高位延迟参考' }}
            </div>
          </div>
          <div class="min-w-0">
            <div class="text-[9px] text-muted-foreground">
              相对智能基线
            </div>
            <div class="mt-0.5 text-sm font-semibold tabular-nums" :class="baselineTone(route.reliability)">
              {{ formatDeviation(route.reliability.adaptive.deviationPercent) }}
            </div>
            <div class="truncate text-[9px]" :class="baselineTone(route.reliability)">
              {{ route.reliability.adaptive.label }}
            </div>
          </div>
        </div>
      </section>

      <section
        v-if="route.directionComparison"
        data-topology-direction-pair
        class="rounded-xl border border-sky-500/20 bg-sky-500/[0.045] p-3.5"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="text-xs font-semibold text-foreground">
              线路机与落地机双向探测
            </div>
            <div class="mt-0.5 text-[10px] text-muted-foreground">
              两条已配置的实时线路互为对向；每个方向仍保留自己的探测任务与来源。
            </div>
          </div>
          <span
            v-if="directionLatencyDelta(route.directionComparison)"
            data-topology-direction-delta
            class="rounded-md border border-sky-500/20 bg-background/55 px-2 py-1 text-[10px] font-medium tabular-nums text-sky-700 dark:text-sky-300"
          >
            {{ directionLatencyDelta(route.directionComparison) }}
          </span>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          <div
            v-for="(reading, direction) in route.directionComparison"
            :key="direction"
            class="min-w-0 rounded-lg border border-border/50 bg-background/45 p-3"
          >
            <div class="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>{{ direction === 'forward' ? '正向' : '反向' }}</span>
              <span>{{ directionFreshnessLabel(reading) }}</span>
            </div>
            <div class="mt-1 truncate text-xs font-semibold" :title="`${reading.sourceName} → ${reading.targetName}`">
              {{ reading.sourceName }} → {{ reading.targetName }}
            </div>
            <div class="mt-2 flex gap-4 text-[11px] tabular-nums">
              <span>延迟 <strong>{{ formatLatency(reading.telemetry?.latency ?? null) }}</strong></span>
              <span>丢包 <strong>{{ formatLoss(reading.telemetry?.loss) }}</strong></span>
            </div>
            <dl class="mt-2 grid gap-1 text-[9px] text-muted-foreground">
              <div class="flex min-w-0 gap-2">
                <dt class="shrink-0">
                  任务
                </dt>
                <dd class="truncate" :title="reading.taskName || '未识别'">
                  {{ reading.taskName || '未识别' }}
                </dd>
              </div>
              <div class="flex min-w-0 gap-2">
                <dt class="shrink-0">
                  来源
                </dt>
                <dd class="truncate font-mono" :title="reading.sourceUuid">
                  {{ reading.sourceUuid }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div v-if="!directionLatencyDelta(route.directionComparison)" class="mt-2 text-[9px] text-muted-foreground">
          任一方向数据缺失或过期时不计算延迟差。
        </div>
      </section>

      <section
        v-for="(snapshot, index) in route.segmentReliability"
        :key="`${route.key}-insight-${index}`"
        class="space-y-2"
      >
        <div
          v-if="snapshot?.insights?.diagnosis"
          data-topology-diagnosis
          class="rounded-lg border px-3 py-2 text-[11px]"
          :class="diagnosisTone(snapshot.insights.diagnosis)"
        >
          <strong>{{ route.nodeNames[index] }} → {{ route.nodeNames[index + 1] }}</strong>
          <span class="ml-1">{{ snapshot.insights.diagnosis.message }}</span>
        </div>

        <div
          v-if="snapshot?.insights?.hourlyProfile?.length"
          data-topology-hourly-profile
          class="rounded-xl border border-border/60 bg-background/35 p-3.5"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="truncate text-xs font-semibold">
                {{ route.nodeNames[index] }} → {{ route.nodeNames[index + 1] }} · 24 小时质量曲线
              </div>
              <div class="mt-0.5 text-[9px] text-muted-foreground">
                最近 7 天按北京时间归桶；每小时少于 3 个有效点时显示无数据。
              </div>
            </div>
            <span class="shrink-0 rounded border border-amber-500/20 bg-amber-500/[0.06] px-1.5 py-0.5 text-[9px] text-amber-700 dark:text-amber-300">
              20:00–23:00 晚高峰
            </span>
          </div>
          <div class="relative mt-3 h-4">
            <TelemetrySampleStrip
              :samples="hourlySamples(snapshot, index)"
              :label="`${route.nodeNames[index]}至${route.nodeNames[index + 1]}北京时间24小时质量`"
              kind="topology"
              variant="ticks"
            />
          </div>
          <div class="mt-1 flex justify-between text-[8px] tabular-nums text-muted-foreground">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
          </div>
        </div>

        <div
          v-if="snapshot?.insights?.baselineShift"
          data-topology-baseline-shift-detail
          class="rounded-lg border border-sky-500/20 bg-sky-500/[0.045] px-3 py-2 text-[10px] text-foreground/85"
        >
          <strong>{{ baselineShiftLabel(snapshot) }}</strong>
          <span class="ml-1">延迟基线显著变化，可能与路径、探测方式或目标变化有关。</span>
        </div>
      </section>

      <div class="flex items-center justify-between gap-3">
        <div class="text-xs text-muted-foreground">
          实时数据由探测来源节点执行绑定的 Ping 任务；上方视觉线路不代表反向探测。没有样本时显示备用基线。
        </div>
        <div class="flex shrink-0 rounded-md border border-border/60 bg-background/45 p-0.5" role="group" aria-label="线路历史时间范围">
          <button
            v-for="period in [{ value: 1, label: '1h' }, { value: 24, label: '24h' }, { value: 168, label: '7d' }]"
            :key="period.value"
            type="button"
            class="h-7 rounded px-2.5 text-[11px] text-muted-foreground transition-colors"
            :class="hours === period.value ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
            :aria-pressed="hours === period.value"
            @click="hours = period.value"
          >
            {{ period.label }}
          </button>
        </div>
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <TopologySegmentHistory
          v-for="(metric, index) in route.metrics.slice(0, Math.max(1, route.nodeNames.length - 1))"
          :key="`${route.key}-${index}`"
          :metric="metric"
          :nodes="nodes"
          :source-label="route.nodeNames[index] || `节点 ${index + 1}`"
          :target-label="route.nodeNames[index + 1] || `节点 ${index + 2}`"
          :source-uuid="route.sourceUuid"
          :hours="hours"
        />
      </div>
    </div>
  </AppDialog>
</template>
