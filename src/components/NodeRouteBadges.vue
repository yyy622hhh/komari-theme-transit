<script setup lang="ts">
import type { RouteGrade } from '@/utils/routeClassification'
import type { NodeRouteEntry } from '@/utils/routeTag'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { DataTooltip } from '@/components/ui/data-tooltip'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { ROUTE_ASN_LABELS } from '@/utils/routeClassification'
import { parseNodeRouteTag } from '@/utils/routeTag'

const props = defineProps<{
  /** 节点的原始 `tags` 字段；没有回程标签时整个组件不渲染。 */
  tags?: string | null
  /**
   * 紧凑形态：去掉标签里的运营商前缀，改用一个运营商色点表示。
   * 节点卡的标签行不换行，三个「电信CN2GIA」这样的全名会把自定义标签挤掉。
   */
  compact?: boolean
}>()

/** 运营商色点。沿用三网质量那一套配色，同一个运营商在全站是同一个颜色。 */
const CARRIER_DOT_CLASSES: Record<string, string> = {
  CT: 'bg-blue-500',
  CU: 'bg-rose-500',
  CM: 'bg-emerald-500',
}

const CARRIER_PREFIX_PATTERN = /^(?:电信|联通|移动)/

/** 按线路档次着色。判不出档次的走静音色，不借颜色暗示好坏。 */
const GRADE_CLASSES: Record<string, string> = {
  精品线路: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  优质线路: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  普通线路: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-500',
}

const MUTED_CLASS = 'border-muted-foreground/15 bg-muted-foreground/5 text-muted-foreground'

const appStore = useAppStore()
// 跟着全站共享的分钟时钟，否则过期降级要等到刷新页面才会发生。理由见 NodeRoutePanel。
const report = computed(() => parseNodeRouteTag(props.tags, appStore.minuteTick.getTime()))

/** 过期或采集时间未知的判定不再着色，避免把历史结果暗示成当前状态。 */
const untrusted = computed(() => report.value?.freshness === 'stale' || report.value?.freshness === 'unknown')

function gradeClass(grade: RouteGrade): string {
  if (untrusted.value || !grade)
    return MUTED_CLASS
  return GRADE_CLASSES[grade] ?? MUTED_CLASS
}

const measuredText = computed(() => {
  const measuredAt = report.value?.measuredAt
  if (!measuredAt)
    return '采集时间未知'
  return `采集于 ${formatDateTime(new Date(measuredAt))}`
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

function hopChain(asns: string[]): string {
  if (!asns.length)
    return '未识别到骨干网跳点'
  return asns.map(asn => `${asn}（${ROUTE_ASN_LABELS[asn] ?? '未知'}）`).join(' → ')
}

function routeDetails(entry: NodeRouteEntry): string {
  return `${entry.carrierLabel}回程\n${hopChain(entry.asns)}\n判定依据：${entry.classification.evidence}\n${measuredText.value}${freshnessNote.value}`
}

/**
 * 紧凑形态下去掉运营商前缀，交给色点表示。
 * 「未见电信骨干」这类判不出的文案本身就是一句话，去掉前缀会读不通，保持原样。
 */
function badgeText(label: string, grade: RouteGrade): string {
  if (!props.compact || !grade)
    return label
  return label.replace(CARRIER_PREFIX_PATTERN, '')
}
</script>

<template>
  <div v-if="report" class="flex flex-wrap items-center gap-1">
    <DataTooltip
      v-for="entry in report.entries"
      :key="entry.carrier"
      as="button"
      type="button"
      class="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60"
      :content="routeDetails(entry)"
      content-class="whitespace-pre-line text-left"
      :aria-label="routeDetails(entry)"
      @click.stop
    >
      <Badge
        as="span"
        variant="outline"
        class="rounded py-0 font-normal"
        :class="[gradeClass(entry.classification.grade), compact ? '!h-auto !text-[9px] px-1 py-0.5 gap-0.5' : '!text-[11px] px-1.5']"
      >
        <span
          v-if="compact"
          class="size-1 shrink-0 rounded-full"
          :class="untrusted ? 'bg-muted-foreground/40' : CARRIER_DOT_CLASSES[entry.carrier]"
          :aria-label="entry.carrierLabel"
        />
        {{ badgeText(entry.classification.label, entry.classification.grade) }}
        <!-- 证据不足的那几种，label 本身已经说明了情况，不再加标记。 -->
        <span
          v-if="entry.classification.confidence === 'mixed'"
          class="opacity-60"
          title="证据存在矛盾，判定不确定"
        >?</span>
      </Badge>
    </DataTooltip>
  </div>
</template>
