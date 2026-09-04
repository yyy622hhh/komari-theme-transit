<script setup lang="ts">
import type { RouteGrade } from '@/utils/routeClassification'
import type { NodeRouteEntry } from '@/utils/routeTag'
import { Icon } from '@iconify/vue/offline'
import { computed } from 'vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { ROUTE_ASN_LABELS } from '@/utils/routeClassification'
import { parseNodeRouteTag } from '@/utils/routeTag'

/**
 * 节点卡上的「三网回程」面板：一行一家运营商，箭头指向判定出的骨干线路。
 *
 * 运营商名是每行的类别标签，右侧是该运营商对应的回程骨干判定；轨道只表达两者
 * 的对应关系，不冒充完整拓扑方向。真实方向与逐跳证据仍放在可聚焦的依据提示里。
 */
const props = defineProps<{
  /** 单条回程结果或兼容旧版的节点 `tags`；没有数据时整个面板不渲染。 */
  tags?: string | null
}>()

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
  <div v-if="report" data-node-route-panel class="node-card-cell node-route-panel min-w-0 overflow-hidden p-0">
    <div class="node-route-panel__header flex items-center justify-between gap-2 px-2.5 py-2 text-[9px] text-slate-500 dark:text-slate-400">
      <span>三网回程</span>
      <span
        v-if="measuredAgo || report.freshness === 'unknown'"
        class="shrink-0 tabular-nums"
        :class="report.freshness === 'stale' ? 'text-amber-600 dark:text-amber-500' : ''"
      >
        {{ report.freshness === 'unknown' ? '时间未知' : measuredAgo }}
      </span>
    </div>

    <TooltipProvider :delay-duration="160">
      <div class="flex flex-col gap-1 px-2.5 pb-2 pt-1.5">
        <Tooltip v-for="entry in report.entries" :key="entry.carrier">
          <TooltipTrigger as-child>
            <button
              type="button"
              class="node-route-row pointer-events-auto grid w-full min-w-0 grid-cols-[auto_1.25rem_minmax(0,1fr)_minmax(5.5rem,max-content)] items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60"
              :class="untrusted && 'node-route-row--untrusted'"
              :data-carrier="entry.carrier"
              :aria-label="routeDetails(entry)"
              @click.stop
            >
              <span
                aria-hidden="true"
                class="node-route-beacon grid size-3.5 shrink-0 place-items-center rounded-full border"
              >
                <span class="size-1.5 rounded-full bg-current" />
              </span>

              <span class="whitespace-nowrap text-[9px] text-slate-500 dark:text-slate-400">{{ entry.carrierLabel }}</span>

              <!-- 运营商是行标签，轨道把视线导向右侧的线路判定；真实探测方向见悬浮依据。 -->
              <span
                data-route-lane
                aria-hidden="true"
                class="node-route-lane flex min-w-0 items-center"
              >
                <span class="node-route-lane__origin size-1.5 shrink-0 rounded-full border" />
                <span class="node-route-lane__line min-w-2 flex-1" />
                <span class="node-route-lane__chevrons -ml-0.5 flex shrink-0 items-center">
                  <Icon icon="tabler:chevron-right" :width="8" :height="8" />
                  <Icon icon="tabler:chevron-right" class="-ml-1" :width="8" :height="8" />
                </span>
              </span>

              <span
                class="node-route-badge flex min-w-[5.5rem] shrink-0 items-baseline justify-between gap-1 rounded-md border px-1.5 py-0.5 text-[9px] leading-tight"
                :data-grade="untrusted ? '' : entry.classification.grade || ''"
              >
                <span class="whitespace-nowrap font-medium text-slate-700 dark:text-slate-200">{{ lineText(entry.classification.label, entry.classification.grade) }}</span>
                <span v-if="gradeText(entry.classification.grade)" class="node-route-badge__grade shrink-0 whitespace-nowrap font-medium">{{ gradeText(entry.classification.grade) }}</span>
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent
            data-route-evidence-tooltip
            side="top"
            :side-offset="8"
            class="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-line text-left text-[10px] leading-relaxed"
          >
            {{ routeDetails(entry) }}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  </div>
</template>

<style scoped>
.node-route-panel__header {
  border-bottom: 1px solid var(--transit-divider);
}

.node-route-row {
  --route-tone: 100 116 139;
  transition:
    background-color 150ms ease,
    box-shadow 150ms ease;
}

.node-route-row[data-carrier='CT'] {
  --route-tone: 59 130 246;
}

.node-route-row[data-carrier='CU'] {
  --route-tone: 244 63 94;
}

.node-route-row[data-carrier='CM'] {
  --route-tone: 16 185 129;
}

.node-route-row:hover,
.node-route-row:focus-visible {
  background: rgb(var(--route-tone) / 0.06);
}

.node-route-beacon {
  color: rgb(var(--route-tone));
  border-color: rgb(var(--route-tone) / 0.42);
  background: rgb(var(--route-tone) / 0.12);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.14),
    0 0 7px rgb(var(--route-tone) / 0.22);
}

.node-route-beacon > span {
  box-shadow: 0 0 5px rgb(var(--route-tone) / 0.72);
}

.node-route-lane {
  color: rgb(var(--route-tone) / 0.72);
}

.node-route-lane__origin {
  border-color: currentColor;
  background: rgb(var(--route-tone) / 0.08);
}

.node-route-lane__line {
  height: 1px;
  background: linear-gradient(90deg, currentColor 0 48%, transparent 48% 58%, currentColor 58% 100%);
  opacity: 0.72;
}

.node-route-lane__chevrons {
  filter: drop-shadow(0 0 3px rgb(var(--route-tone) / 0.32));
}

.node-route-badge {
  --grade-tone: 100 116 139;
  border-color: rgb(var(--grade-tone) / 0.28);
  background: linear-gradient(180deg, rgb(var(--grade-tone) / 0.13), rgb(var(--grade-tone) / 0.055));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.07);
}

.node-route-badge[data-grade='精品线路'] {
  --grade-tone: 16 185 129;
}

.node-route-badge[data-grade='优质线路'] {
  --grade-tone: 14 165 233;
}

.node-route-badge[data-grade='普通线路'] {
  --grade-tone: 245 158 11;
}

.node-route-badge__grade {
  color: rgb(var(--grade-tone));
}

.node-route-row--untrusted {
  --route-tone: 100 116 139 !important;
}

.node-route-row--untrusted .node-route-badge {
  --grade-tone: 100 116 139 !important;
}
</style>
