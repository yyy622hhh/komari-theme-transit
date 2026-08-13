<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsAlert } from '@/utils/pandaOpsAlert'
import { Icon } from '@iconify/vue'
import { useMediaQuery } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PandaOpsNodeAlertObserver from '@/components/PandaOpsNodeAlertObserver.vue'
import { getPandaOpsNodeAlert } from '@/composables/usePandaOpsAlertState'
import { PANDA_OPS_ALERT_LIMITS } from '@/constants/pandaOps'
import { useAppStore } from '@/stores/app'

const props = defineProps<{ nodes: NodeData[] }>()
const router = useRouter()
const appStore = useAppStore()
const expanded = ref(false)
const isMobile = useMediaQuery('(max-width: 639px)')

const alerts = computed(() => props.nodes
  .filter(node => !appStore.pandaOpsNodeControls[node.uuid]?.maintenanceUntil
    && !appStore.pandaOpsNodeControls[node.uuid]?.silenceUntil)
  .map(node => getPandaOpsNodeAlert(node.uuid))
  .filter((alert): alert is PandaOpsAlert => Boolean(alert))
  .sort((left, right) => right.score - left.score))

const collapsedLimit = computed(() => isMobile.value
  ? PANDA_OPS_ALERT_LIMITS.mobileCollapsed
  : PANDA_OPS_ALERT_LIMITS.desktop)
const visibleAlerts = computed(() => expanded.value ? alerts.value : alerts.value.slice(0, collapsedLimit.value))
const hiddenAlertCount = computed(() => Math.max(0, alerts.value.length - visibleAlerts.value.length))

watch(alerts, (items) => {
  if (expanded.value && items.length <= collapsedLimit.value)
    expanded.value = false
})

function toneClass(alert: PandaOpsAlert): string {
  return alert.severity === 'critical'
    ? 'text-rose-600 dark:text-rose-400'
    : 'text-amber-700 dark:text-amber-300'
}

function openNode(alert: PandaOpsAlert): void {
  router.push({ name: 'instance-detail', params: { id: alert.nodeUuid } })
}
</script>

<template>
  <div :class="alerts.length ? 'block' : 'contents'">
    <PandaOpsNodeAlertObserver
      v-for="node in nodes"
      :key="node.uuid"
      :node="node"
    />

    <section
      v-if="alerts.length"
      data-panda-alert-strip
      class="panda-panel overflow-hidden rounded-2xl"
      aria-labelledby="panda-alert-title"
      aria-live="polite"
    >
      <div class="grid min-h-12 md:grid-cols-[220px_1fr]">
        <div class="panda-divider flex items-center gap-2 border-b px-4 py-3 md:border-b-0 md:border-r">
          <Icon icon="tabler:alert-circle" :width="16" class="text-amber-700 dark:text-amber-300" />
          <h2 id="panda-alert-title" class="min-w-0 flex-1 text-xs font-semibold text-slate-800 dark:text-slate-200">
            {{ alerts.length }} 个异常需要关注
          </h2>
          <button
            v-if="alerts.length > collapsedLimit"
            type="button"
            class="ml-auto shrink-0 text-[10px] font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 dark:hover:text-slate-200"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
          >
            {{ expanded ? '收起' : `另有 ${hiddenAlertCount} 个` }}
          </button>
        </div>
        <div class="panda-alert-grid grid divide-y sm:grid-cols-2 xl:grid-cols-4">
          <button
            v-for="alert in visibleAlerts"
            :key="alert.key"
            type="button"
            class="panda-hover-surface group flex min-w-0 items-center gap-2 px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-500/60"
            @click="openNode(alert)"
          >
            <Icon :icon="alert.icon" :width="15" class="shrink-0" :class="toneClass(alert)" />
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-[11px] font-semibold text-slate-800 dark:text-slate-200">{{ alert.nodeName }}</strong>
              <span class="mt-0.5 block truncate text-[9px] tabular-nums" :class="toneClass(alert)">{{ alert.detail }}</span>
            </span>
            <Icon icon="tabler:chevron-right" :width="13" class="shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 dark:text-slate-600" />
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panda-alert-grid > :not(:last-child) {
  border-color: var(--panda-divider);
}
</style>
