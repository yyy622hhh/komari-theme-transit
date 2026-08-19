<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { NodeCardPanelMode } from '@/utils/nodeCardPanel'
import type { NodeControl } from '@/utils/nodeControl'
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { recordControlEvent } from '@/composables/useIncidentTimeline'
import { loadPingTaskNamesForNode } from '@/services/metrics.service'
import { saveNodeCardPanelConfigs } from '@/services/node-card-panel.service'
import { saveNodeControls } from '@/services/node-control.service'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { NODE_CARD_PANEL_OPTIONS, nodeCardPanelModeLabel, updateNodeCardPanelConfig } from '@/utils/nodeCardPanel'
import { formatNodeControlRemaining, updateNodeControl } from '@/utils/nodeControl'

const props = defineProps<{ open: boolean, node: NodeData | null }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const appStore = useAppStore()
const saving = ref<'maintenance' | 'silence' | null>(null)
const savingPanel = ref(false)
const panelMode = ref<'inherit' | NodeCardPanelMode>('inherit')
const selectedPingTasks = ref<string[]>([])
const pingTaskOptions = ref<string[]>([])
const loadingPingTasks = ref(false)
let pingTaskLoadGeneration = 0

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})
const control = computed<NodeControl>(() => props.node
  ? appStore.nodeControls[props.node.uuid] ?? {}
  : {})
const inheritedPanelLabel = computed(() => nodeCardPanelModeLabel(appStore.nodeCardPanelDefault))

async function loadPingTasks(): Promise<void> {
  const node = props.node
  if (!node)
    return
  const generation = ++pingTaskLoadGeneration
  loadingPingTasks.value = true
  const uuid = node.uuid
  try {
    const taskNames = await loadPingTaskNamesForNode(uuid)
    if (generation === pingTaskLoadGeneration && props.node?.uuid === uuid)
      pingTaskOptions.value = [...new Set([...taskNames, ...selectedPingTasks.value])]
  }
  catch (error) {
    if (generation === pingTaskLoadGeneration && props.node?.uuid === uuid)
      window.$message?.error(error instanceof Error ? error.message : 'Ping 任务读取失败。')
  }
  finally {
    if (generation === pingTaskLoadGeneration)
      loadingPingTasks.value = false
  }
}

watch(
  () => [isOpen.value, props.node?.uuid] as const,
  ([open, uuid]) => {
    pingTaskLoadGeneration += 1
    loadingPingTasks.value = false
    if (!open || !uuid)
      return
    const saved = appStore.nodeCardPanels[uuid]
    panelMode.value = saved?.mode ?? 'inherit'
    selectedPingTasks.value = [...(saved?.pingTasks ?? [])]
    pingTaskOptions.value = [...selectedPingTasks.value]
    if (saved?.mode === 'ping')
      void loadPingTasks()
  },
  { immediate: true },
)

function handlePanelModeChange(): void {
  if (panelMode.value === 'ping')
    void loadPingTasks()
}

function togglePingTask(taskName: string, checked: boolean): void {
  if (!checked) {
    selectedPingTasks.value = selectedPingTasks.value.filter(task => task !== taskName)
    return
  }
  if (selectedPingTasks.value.length >= 3) {
    window.$message?.warning('每台节点最多选择 3 个 Ping 任务。')
    return
  }
  selectedPingTasks.value = [...selectedPingTasks.value, taskName]
}

async function savePanel(): Promise<void> {
  const node = props.node
  const publicSettings = appStore.publicSettings
  if (!node || !publicSettings)
    return
  if (panelMode.value === 'ping' && selectedPingTasks.value.length === 0) {
    window.$message?.warning('请至少选择一个 Ping 任务。')
    return
  }

  const nextConfig = panelMode.value === 'inherit'
    ? undefined
    : { mode: panelMode.value, pingTasks: panelMode.value === 'ping' ? selectedPingTasks.value : undefined }
  savingPanel.value = true
  try {
    const payload = await saveNodeCardPanelConfigs({
      theme: publicSettings.theme,
      apply: current => updateNodeCardPanelConfig(current, node.uuid, nextConfig),
    })
    appStore.publicSettings = { ...publicSettings, theme_settings: payload }
    window.$message?.success(panelMode.value === 'inherit' ? '节点已恢复跟随全局面板。' : '节点卡片面板已保存。')
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '节点卡片面板保存失败。')
  }
  finally {
    savingPanel.value = false
  }
}

async function updateControl(key: keyof NodeControl, durationMinutes?: number): Promise<void> {
  const node = props.node
  const publicSettings = appStore.publicSettings
  if (!node || !publicSettings)
    return

  const until = durationMinutes ? Date.now() + durationMinutes * 60_000 : undefined
  saving.value = key === 'maintenanceUntil' ? 'maintenance' : 'silence'
  try {
    const payload = await saveNodeControls({
      theme: publicSettings.theme,
      apply: current => updateNodeControl(current, node.uuid, key, until),
    })
    appStore.publicSettings = { ...publicSettings, theme_settings: payload }

    if (key === 'maintenanceUntil') {
      recordControlEvent(
        node.uuid,
        node.name,
        until ? 'maintenanceStarted' : 'maintenanceEnded',
        until ? `进入维护，预计 ${formatDateTime(new Date(until), 'MM-DD HH:mm')} 结束` : '维护已结束',
      )
      window.$message?.success(until ? '维护状态已启用。' : '维护状态已结束。')
    }
    else {
      recordControlEvent(
        node.uuid,
        node.name,
        until ? 'silenced' : 'silenceEnded',
        until ? `告警静默至 ${formatDateTime(new Date(until), 'MM-DD HH:mm')}` : '告警静默已结束',
      )
      window.$message?.success(until ? '告警已静默。' : '告警静默已结束。')
    }
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '节点状态保存失败。')
  }
  finally {
    saving.value = null
  }
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    :title="node ? `节点运维 · ${node.name}` : '节点运维'"
    description="配置节点卡片观测面板、临时维护和告警静默。"
    content-class="max-w-lg"
  >
    <div v-if="node" class="space-y-3" data-transit-node-control-dialog>
      <section class="rounded-xl border border-border/65 bg-background/40 p-3" data-node-card-panel-settings>
        <div class="flex items-start gap-3">
          <Icon icon="tabler:layout-dashboard" :width="16" class="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-foreground">
              节点卡片观测面板
            </div>
            <p class="mt-1 text-[10px] leading-5 text-muted-foreground">
              每台节点可覆盖全局默认；所有面板保持同一布局高度，只展示 Komari 已上报的数据。
            </p>
          </div>
        </div>

        <label class="mt-3 block text-[10px] font-medium text-muted-foreground" for="node-card-panel-mode">面板类型</label>
        <select
          id="node-card-panel-mode"
          v-model="panelMode"
          class="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          :disabled="savingPanel"
          @change="handlePanelModeChange"
        >
          <option value="inherit">
            跟随全局（{{ inheritedPanelLabel }}）
          </option>
          <option v-for="option in NODE_CARD_PANEL_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <div v-if="panelMode === 'ping'" class="mt-3 rounded-lg border border-border/60 bg-muted/25 p-2.5">
          <div class="flex items-center justify-between gap-2 text-[10px]">
            <span class="font-medium text-foreground">选择 Ping 任务</span>
            <span class="text-muted-foreground">{{ selectedPingTasks.length }} / 3</span>
          </div>
          <p v-if="loadingPingTasks" class="mt-2 text-[10px] text-muted-foreground">
            正在读取该节点可用任务…
          </p>
          <div v-else-if="pingTaskOptions.length" class="mt-2 grid gap-1.5 sm:grid-cols-2">
            <label v-for="task in pingTaskOptions" :key="task" class="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[10px] hover:bg-background/70">
              <input
                type="checkbox"
                class="size-3.5 accent-emerald-500"
                :checked="selectedPingTasks.includes(task)"
                :disabled="savingPanel || (!selectedPingTasks.includes(task) && selectedPingTasks.length >= 3)"
                @change="togglePingTask(task, ($event.target as HTMLInputElement).checked)"
              >
              <span class="min-w-0 truncate" :title="task">{{ task }}</span>
            </label>
          </div>
          <p v-else class="mt-2 text-[10px] leading-5 text-muted-foreground">
            该节点还没有可用的 Ping 任务，请先在 Komari 后台创建任务并等待节点产生样本。
          </p>
        </div>

        <div class="mt-3 flex justify-end">
          <Button size="sm" :disabled="savingPanel || Boolean(saving)" @click="savePanel">
            <Icon :icon="savingPanel ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="savingPanel && 'animate-spin'" />
            {{ savingPanel ? '保存中' : '保存面板' }}
          </Button>
        </div>
      </section>

      <section class="rounded-xl border border-border/65 bg-background/40 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Icon icon="tabler:tools" :width="15" class="text-amber-600 dark:text-amber-300" />
              维护模式
            </div>
            <p class="mt-1 text-[10px] leading-5 text-muted-foreground">
              维护期间节点卡片保留显示，但不计入在线率、离线筛选和异常汇总。
            </p>
          </div>
          <span
            v-if="control.maintenanceUntil"
            class="shrink-0 rounded-full border border-amber-500/25 bg-amber-500/[0.08] px-2 py-1 text-[9px] font-medium text-amber-700 dark:text-amber-300"
          >
            剩余 {{ formatNodeControlRemaining(control.maintenanceUntil) }}
          </span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('maintenanceUntil', 30)">
            30 分钟
          </Button>
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('maintenanceUntil', 60)">
            1 小时
          </Button>
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('maintenanceUntil', 240)">
            4 小时
          </Button>
          <Button v-if="control.maintenanceUntil" size="sm" variant="ghost" :disabled="Boolean(saving)" @click="updateControl('maintenanceUntil')">
            结束维护
          </Button>
        </div>
      </section>

      <section class="rounded-xl border border-border/65 bg-background/40 p-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Icon icon="tabler:bell-off" :width="15" class="text-slate-500 dark:text-slate-300" />
              告警静默
            </div>
            <p class="mt-1 text-[10px] leading-5 text-muted-foreground">
              首页异常条会暂时隐藏此节点，节点卡片仍保留真实告警，便于排查。
            </p>
          </div>
          <span
            v-if="control.silenceUntil"
            class="shrink-0 rounded-full border border-slate-500/20 bg-slate-500/[0.07] px-2 py-1 text-[9px] font-medium text-slate-600 dark:text-slate-300"
          >
            剩余 {{ formatNodeControlRemaining(control.silenceUntil) }}
          </span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('silenceUntil', 60)">
            1 小时
          </Button>
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('silenceUntil', 240)">
            4 小时
          </Button>
          <Button size="sm" variant="outline" :disabled="Boolean(saving)" @click="updateControl('silenceUntil', 1440)">
            24 小时
          </Button>
          <Button v-if="control.silenceUntil" size="sm" variant="ghost" :disabled="Boolean(saving)" @click="updateControl('silenceUntil')">
            结束静默
          </Button>
        </div>
      </section>
    </div>
  </AppDialog>
</template>
