<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import { useRouteProbe } from '@/composables/useRouteProbe'
import { useAppStore } from '@/stores/app'

/**
 * 三网回程检测的入口。
 *
 * 单独成组件并由首页懒加载，是为了把判定、标签编解码和采集编排这一整条依赖链
 * 移出 HomeView 的首屏 chunk——它有 30 KiB gzip 的硬预算（`audit-performance.ts`），
 * 这条链直接进去会破线。副作用是自动检测也随这个组件一起延后加载，而它本来就
 * 是「打开首页若干秒后才跑」的后台任务，延后没有实际影响。
 */
const props = defineProps<{
  nodes: NodeData[]
}>()

const appStore = useAppStore()
const routeProbe = useRouteProbe(() => props.nodes)

// 待测台数跟着节点列表走：写回标签后节点对象变化，这里自然掉到 0，按钮随之消失。
const pending = computed(() => props.nodes.length ? routeProbe.pendingCount() : 0)
const visible = computed(() => appStore.privateFeaturesAllowed && (routeProbe.probing.value || pending.value > 0))
const summaryHasFailure = computed(() => Boolean(routeProbe.lastError.value)
  || routeProbe.lastOutcomes.value.some(outcome => outcome.status !== 'updated'))
</script>

<template>
  <div v-if="visible" class="flex min-w-0 items-center gap-1.5">
    <UiButton
      variant="ghost"
      size="sm"
      class="h-8 shrink-0 gap-1 rounded-md bg-background/50 px-2 text-xs backdrop-blur-xs"
      :disabled="routeProbe.probing.value"
      :title="routeProbe.lastSummary.value || '对还没测过或结果已过期的在线节点执行一次 traceroute，判定三网回程线路'"
      @click="() => routeProbe.probeNow()"
    >
      <Icon
        :icon="routeProbe.probing.value ? 'tabler:loader-2' : 'tabler:route'"
        :class="routeProbe.probing.value && 'animate-spin'"
        :width="14"
        :height="14"
      />
      <span>{{ routeProbe.probing.value ? '检测回程中' : `检测回程 ${pending}` }}</span>
    </UiButton>

    <span
      v-if="routeProbe.lastSummary.value && !routeProbe.probing.value"
      data-route-probe-summary
      class="flex min-w-0 max-w-[18rem] items-center gap-1 truncate rounded-md border px-2 py-1 text-[10px]"
      :class="summaryHasFailure
        ? 'border-amber-500/20 bg-amber-500/8 text-amber-700 dark:text-amber-400'
        : 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-400'"
      :title="routeProbe.lastSummary.value"
      aria-live="polite"
    >
      <Icon :icon="summaryHasFailure ? 'tabler:alert-triangle' : 'tabler:circle-check'" class="shrink-0" :width="12" :height="12" />
      <span class="truncate">{{ routeProbe.lastSummary.value }}</span>
    </span>
  </div>
</template>
