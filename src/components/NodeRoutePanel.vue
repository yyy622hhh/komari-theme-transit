<script setup lang="ts">
import type { RouteGrade } from '@/utils/routeClassification'
import type { NodeRouteEntry } from '@/utils/routeTag'
import { computed } from 'vue'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { ROUTE_ASN_LABELS } from '@/utils/routeClassification'
import { parseNodeRouteTag } from '@/utils/routeTag'

/**
 * 节点卡上的「三网回程」面板：一行一家运营商，箭头指向判定出的骨干线路。
 *
 * 箭头朝向就是回程的方向——从国内运营商回到这台机器。三网质量那一行回答「现在
 * 快不快」，这个面板回答「走的是哪条线」，两个并排看才完整。
 */
const props = defineProps<{
  /** 节点的原始 `tags` 字段；没有回程标签时整个面板不渲染。 */
  tags?: string | null
}>()

const CARRIER_DOT_CLASSES: Record<string, string> = {
  CT: 'bg-blue-500',
  CU: 'bg-rose-500',
  CM: 'bg-emerald-500',
}

/** 线路用运营商色，和终点圆点、三网质量那一行保持同一套配色。 */
const CARRIER_ARROW_CLASSES: Record<string, string> = {
  CT: 'text-blue-500/70',
  CU: 'text-rose-500/70',
  CM: 'text-emerald-500/70',
}

/** 按线路档次着色；判不出档次的走静音色，不借颜色暗示好坏。 */
const GRADE_CLASSES: Record<string, string> = {
  精品线路: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  优质线路: 'border-sky-500/40 text-sky-600 dark:text-sky-400',
  普通线路: 'border-amber-500/40 text-amber-600 dark:text-amber-500',
}

const MUTED_CLASS = 'border-muted-foreground/20 text-muted-foreground'

const appStore = useAppStore()

/**
 * 相对时间和过期判定都跟着全站共享的分钟时钟走。
 *
 * 只读 `Date.now()` 的话，computed 的依赖里没有时间，`props.tags` 不变就永远不
 * 重算——页面开着不动时「1小时前」会一直停在那儿，超过 7 天转静音色的降级也不会
 * 真的发生。
 */
const now = computed(() => appStore.minuteTick.getTime())
const report = computed(() => parseNodeRouteTag(props.tags, now.value))

/** 过期或采集时间未知的判定不再着色，避免把历史结果暗示成当前状态。 */
const untrusted = computed(() => report.value?.freshness === 'stale' || report.value?.freshness === 'unknown')

function gradeClass(grade: RouteGrade): string {
  if (untrusted.value || !grade)
    return MUTED_CLASS
  return GRADE_CLASSES[grade] ?? MUTED_CLASS
}

/** 档次后缀去掉「线路」二字，卡片上宽度紧张：精品线路 -> 精品。 */
function gradeText(grade: RouteGrade): string {
  return grade ? grade.replace('线路', '') : ''
}

/** 徽章主体只留线路名，运营商由左侧的圆点和名字表示：电信CN2GIA -> CN2GIA。 */
const CARRIER_PREFIX_PATTERN = /^(?:电信|联通|移动)/

function lineText(label: string, grade: RouteGrade): string {
  return grade ? label.replace(CARRIER_PREFIX_PATTERN, '') : label
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 采集时间的相对描述。跨度可能到几天，所以不复用 Ping 那套只到小时的格式化。 */
const measuredAgo = computed(() => {
  const measuredAt = report.value?.measuredAt
  if (!measuredAt)
    return ''
  const age = Math.max(0, now.value - measuredAt)
  if (age < HOUR)
    return `${Math.max(1, Math.floor(age / MINUTE))}分钟前`
  if (age < DAY)
    return `${Math.floor(age / HOUR)}小时前`
  return `${Math.floor(age / DAY)}天前`
})

const freshnessNote = computed(() => {
  switch (report.value?.freshness) {
    case 'unknown':
      return '\n采集时间未知，判定结果仅供参考。'
    case 'stale':
      return '\n已超过 7 天未更新，判定结果仅供参考。'
    case 'delayed':
      return '\n已超过 1 天未更新。'
    default:
      return ''
  }
})

const measuredText = computed(() => report.value?.measuredAt
  ? `采集于 ${formatDateTime(new Date(report.value.measuredAt))}`
  : '采集时间未知')

function hopChain(asns: string[]): string {
  if (!asns.length)
    return '未识别到骨干网跳点'
  return asns.map(asn => `${asn}（${ROUTE_ASN_LABELS[asn] ?? '未知'}）`).join(' → ')
}

function routeDetails(entry: NodeRouteEntry): string {
  return `${entry.carrierLabel}回程\n${hopChain(entry.asns)}\n判定依据：${entry.classification.evidence}\n${measuredText.value}${freshnessNote.value}`
}
</script>

<template>
  <div v-if="report" data-node-route-panel class="node-card-cell min-w-0 px-2.5 py-2">
    <div class="flex items-center justify-between gap-2 text-[9px] text-slate-500">
      <span>三网回程</span>
      <span
        v-if="measuredAgo || report.freshness === 'unknown'"
        class="shrink-0 tabular-nums"
        :class="report.freshness === 'stale' ? 'text-amber-600 dark:text-amber-500' : ''"
      >
        {{ report.freshness === 'unknown' ? '时间未知' : measuredAgo }}
      </span>
    </div>

    <div class="mt-1.5 flex flex-col gap-1">
      <DataTooltip
        v-for="entry in report.entries"
        :key="entry.carrier"
        as="button"
        type="button"
        class="pointer-events-auto flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60"
        :content="routeDetails(entry)"
        content-class="whitespace-pre-line text-left"
        :aria-label="routeDetails(entry)"
        @click.stop
      >
        <span
          class="flex min-w-0 shrink items-baseline gap-1 truncate rounded border px-1.5 py-px text-[9px] leading-tight"
          :class="gradeClass(entry.classification.grade)"
        >
          <span class="truncate font-medium">{{ lineText(entry.classification.label, entry.classification.grade) }}</span>
          <span v-if="gradeText(entry.classification.grade)" class="shrink-0 opacity-75">{{ gradeText(entry.classification.grade) }}</span>
        </span>

        <!-- 卡片本身是起点：节点（隐含）→ 骨干线路 → 国内运营商终点。 -->
        <svg
          class="h-2 min-w-3 flex-1"
          :class="untrusted ? 'text-muted-foreground/40' : CARRIER_ARROW_CLASSES[entry.carrier]"
          viewBox="0 0 24 8"
          preserveAspectRatio="none"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="2.5" cy="4" r="2" stroke="currentColor" stroke-width="1" />
          <path d="M5.5 4h13" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" />
          <path d="M18 1.5 22.5 4 18 6.5z" fill="currentColor" />
        </svg>

        <span class="shrink-0 text-[9px] text-slate-500">{{ entry.carrierLabel }}</span>
        <span class="size-1.5 shrink-0 rounded-full" :class="untrusted ? 'bg-muted-foreground/40' : CARRIER_DOT_CLASSES[entry.carrier]" />
      </DataTooltip>
    </div>
  </div>
</template>
