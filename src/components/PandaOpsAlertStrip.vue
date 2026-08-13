<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsAlert } from '@/utils/pandaOpsAlert'
import { Icon } from '@iconify/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import PandaOpsNodeAlertObserver from '@/components/PandaOpsNodeAlertObserver.vue'
import { useAppStore } from '@/stores/app'
import { getRealtimeNodeAlerts } from '@/utils/pandaOpsAlert'
import { parseTopologyNodes, splitTopologyGroups } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[] }>()
const appStore = useAppStore()
const router = useRouter()
const carrierAlerts = ref<Record<string, PandaOpsAlert | null>>({})

const topologyNodeNames = computed(() => new Set(
  splitTopologyGroups(appStore.topologyRoute)
    .flatMap(group => parseTopologyNodes(group).slice(1).map(node => node.name.trim().toLowerCase()))
    .filter(Boolean),
))

const observedNodes = computed(() => props.nodes
  .filter(node => topologyNodeNames.value.has(node.name.trim().toLowerCase()))
  .slice(0, 12))

const alerts = computed(() => props.nodes
  .map((node) => {
    const candidates = [...getRealtimeNodeAlerts(node)]
    const carrier = carrierAlerts.value[node.uuid]
    if (carrier)
      candidates.push(carrier)
    return candidates.sort((left, right) => right.score - left.score)[0] ?? null
  })
  .filter((alert): alert is PandaOpsAlert => Boolean(alert))
  .sort((left, right) => right.score - left.score)
  .slice(0, 4))

function updateCarrierAlert(uuid: string, alert: PandaOpsAlert | null): void {
  if (carrierAlerts.value[uuid]?.key === alert?.key && carrierAlerts.value[uuid]?.detail === alert?.detail)
    return
  carrierAlerts.value = { ...carrierAlerts.value, [uuid]: alert }
}

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
      v-for="node in observedNodes"
      :key="node.uuid"
      :node="node"
      @change="updateCarrierAlert(node.uuid, $event)"
    />

    <section
      v-if="alerts.length"
      data-panda-alert-strip
      class="panda-panel overflow-hidden rounded-2xl"
      aria-labelledby="panda-alert-title"
    >
      <div class="grid min-h-12 md:grid-cols-[220px_1fr]">
        <div class="panda-divider flex items-center gap-2 border-b px-4 py-3 md:border-b-0 md:border-r">
          <Icon icon="tabler:alert-circle" :width="16" class="text-amber-700 dark:text-amber-300" />
          <h2 id="panda-alert-title" class="text-xs font-semibold text-slate-800 dark:text-slate-200">
            {{ alerts.length }} 个异常需要关注
          </h2>
        </div>
        <div class="panda-alert-grid grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
          <button
            v-for="alert in alerts"
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
