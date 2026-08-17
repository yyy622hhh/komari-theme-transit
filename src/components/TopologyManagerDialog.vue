<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { TopologyRouteConfig } from '@/utils/topologyHelper'
import { Icon } from '@iconify/vue'
import { computed, nextTick, onScopeDispose, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { loadPingTaskNamesForNode } from '@/services/metrics.service'
import { findUniqueTopologyNode, listUnusedQuickLandingUuids, nextQuickLandingUuid, TOPOLOGY_LIMITS } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const QUICK_HOP_AUTO = '__auto__'
const manager = reactive(useTopologyManager(() => props.nodes))
const taskOptions = ref<Record<string, string[]>>({})
const taskLoading = ref<Record<string, boolean>>({})
const taskErrors = ref<Record<string, string>>({})
interface TaskLoadResult { tasks: string[], error: string }
const taskRequests = new Map<string, Promise<TaskLoadResult>>()
const quickConfiguring = ref(false)
const quickSourceUuid = ref('')
const quickLandingUuid = ref('')
const quickHopTask = ref(QUICK_HOP_AUTO)
let quickConfigurationRun = 0
let dialogSession = 0

const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
const quickSourceName = computed(() => manager.quickNodes.find(node => node.uuid === quickSourceUuid.value)?.name ?? '')
const quickHopTaskOptions = computed(() => nodeTasks(quickSourceName.value))

function unusedQuickLandingUuids(): string[] {
  return listUnusedQuickLandingUuids(
    manager.routes,
    quickSourceName.value,
    manager.quickNodes,
    quickSourceUuid.value,
  )
}

function syncQuickSelections(initialize = false): void {
  const sources = manager.quickNodes
  if (!sources.some(node => node.uuid === quickSourceUuid.value))
    quickSourceUuid.value = sources[0]?.uuid ?? ''
  const landingUuids = sources.map(node => node.uuid).filter((uuid): uuid is string => Boolean(uuid))
  quickLandingUuid.value = nextQuickLandingUuid(
    quickSourceUuid.value,
    quickLandingUuid.value,
    landingUuids,
    initialize,
    unusedQuickLandingUuids(),
  )
}

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

watch(() => props.open, (value) => {
  dialogSession += 1
  if (value) {
    manager.reset()
    quickHopTask.value = QUICK_HOP_AUTO
    syncQuickSelections(true)
    const sourceNames = [
      ...manager.routes.flatMap(route => route.metrics.map(metric => metric.nodeName)),
      quickSourceName.value,
    ].filter(Boolean)
    void Promise.all(Array.from(new Set(sourceNames), loadTasks))
  }
  else {
    cancelQuickConfiguration()
  }
}, { immediate: true })

watch(() => manager.quickNodes.map(node => node.uuid).join('|'), () => {
  if (props.open)
    syncQuickSelections()
})

onScopeDispose(() => {
  dialogSession += 1
  cancelQuickConfiguration()
})

function cancelQuickConfiguration(): void {
  quickConfigurationRun += 1
  quickConfiguring.value = false
}

function reset(): void {
  cancelQuickConfiguration()
  manager.reset()
}

async function loadTasks(nodeName: string): Promise<TaskLoadResult> {
  const node = findUniqueTopologyNode(props.nodes, nodeName)
  if (!node && manager.isAmbiguousNodeName(nodeName))
    return { tasks: [], error: '节点名称重复，无法唯一读取 Ping 任务。' }
  if (!node)
    return { tasks: [], error: '' }
  const pending = taskRequests.get(node.uuid)
  if (pending)
    return pending
  taskLoading.value = { ...taskLoading.value, [node.uuid]: true }
  taskErrors.value = { ...taskErrors.value, [node.uuid]: '' }

  const request = (async () => {
    try {
      const tasks = await loadPingTaskNamesForNode(node.uuid)
      taskOptions.value = { ...taskOptions.value, [node.uuid]: tasks }
      return { tasks, error: '' }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '无法读取 Ping 任务。'
      taskErrors.value = {
        ...taskErrors.value,
        [node.uuid]: message,
      }
      return { tasks: [], error: message }
    }
    finally {
      taskLoading.value = { ...taskLoading.value, [node.uuid]: false }
      taskRequests.delete(node.uuid)
    }
  })()
  taskRequests.set(node.uuid, request)
  return request
}

function nodeTasks(nodeName: string): string[] {
  const node = findUniqueTopologyNode(props.nodes, nodeName)
  return node ? taskOptions.value[node.uuid] ?? [] : []
}

function nodeTaskState(nodeName: string): { uuid: string, loading: boolean, error: string } {
  const uuid = findUniqueTopologyNode(props.nodes, nodeName)?.uuid ?? ''
  return {
    uuid,
    loading: Boolean(uuid && taskLoading.value[uuid]),
    error: manager.isAmbiguousNodeName(nodeName)
      ? '节点名称重复，无法唯一读取 Ping 任务。'
      : uuid ? taskErrors.value[uuid] ?? '' : '',
  }
}

function selectRouteNode(route: TopologyRouteConfig, index: number, nodeName: string): void {
  manager.selectNode(route, index, nodeName)
  for (const metric of route.metrics) {
    if (metric.live && metric.nodeName === nodeName)
      void loadTasks(nodeName)
  }
}

async function save(): Promise<void> {
  const session = dialogSession
  try {
    const result = await manager.save()
    if (session !== dialogSession || !props.open) {
      if (props.open)
        manager.reset()
      return
    }
    if (result === 'saved') {
      window.$message?.success('拓扑配置已保存。')
      isOpen.value = false
    }
    else if (result === 'changed') {
      window.$message?.warning('提交时的配置已保存，当前修改尚未保存。')
    }
  }
  catch (error) {
    if (session === dialogSession && props.open)
      window.$message?.error(error instanceof Error ? error.message : '拓扑保存失败。')
  }
}

function onQuickSourceChange(): void {
  const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
  if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName) >= 0)
    quickLandingUuid.value = ''
  if (!quickLandingUuid.value)
    syncQuickSelections(true)
  if (quickHopTask.value !== QUICK_HOP_AUTO && !quickHopTaskOptions.value.includes(quickHopTask.value))
    quickHopTask.value = QUICK_HOP_AUTO
  if (quickSourceName.value)
    void loadTasks(quickSourceName.value)
}

function focusTopologyRoute(routeId: number): void {
  const routeElement = document.querySelector<HTMLElement>(`[data-topology-route-id="${routeId}"]`)
  routeElement?.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true })
  routeElement?.scrollIntoView({ block: 'nearest' })
}

async function addQuickRoute(): Promise<void> {
  if (quickConfiguring.value)
    return
  const source = manager.quickNodes.find(node => node.uuid === quickSourceUuid.value) ?? manager.quickSourceNode
  if (!source?.uuid) {
    window.$message?.error('请先选择一台线路机。')
    return
  }

  const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
  const duplicateIndex = manager.findDuplicateRoute(source.name, landingName)
  if (duplicateIndex >= 0) {
    const existing = manager.routes[duplicateIndex]
    window.$message?.warning('已有相同线路机和落地机的线路，请直接编辑。')
    if (existing)
      await nextTick().then(() => focusTopologyRoute(existing.id))
    return
  }

  const runId = ++quickConfigurationRun
  const selectedSourceUuid = source.uuid
  const selectedLandingUuid = quickLandingUuid.value
  const selectedHopTask = quickHopTask.value
  quickConfiguring.value = true
  try {
    const result = await loadTasks(source.name)
    if (runId !== quickConfigurationRun || !props.open)
      return
    if (result.error) {
      window.$message?.error(result.error)
      return
    }
    const latestSource = manager.quickNodes.find(node => node.uuid === selectedSourceUuid)
    const latestLandingName = manager.quickNodes.find(node => node.uuid === selectedLandingUuid)?.name ?? ''
    if (!latestSource || manager.findDuplicateRoute(latestSource.name, latestLandingName) >= 0) {
      window.$message?.warning('节点或线路已变化，请重新选择后生成。')
      return
    }
    const route = manager.addQuickRoute(result.tasks, selectedSourceUuid, {
      landingUuid: selectedLandingUuid || null,
      hopTask: selectedHopTask === QUICK_HOP_AUTO ? undefined : selectedHopTask,
    })
    if (!route) {
      window.$message?.error('所选节点已变化，请重新选择后生成。')
      return
    }
    if (selectedLandingUuid) {
      quickLandingUuid.value = ''
      syncQuickSelections(true)
    }
    await nextTick()
    focusTopologyRoute(route.id)
    const hopBound = Boolean(route.nodes[2]?.name.trim() && route.metrics[1]?.live && route.metrics[1]?.taskFilter)
    window.$message?.success(
      hopBound || !route.nodes[2]?.name.trim()
        ? '已生成拓扑草稿，确认后保存。'
        : '已生成拓扑草稿。第 2 段未自动绑定，请在下方选择线路机上的 Ping 任务。',
    )
  }
  finally {
    if (runId === quickConfigurationRun)
      quickConfiguring.value = false
  }
}

function updateFallback(metric: { fallbackLatency: number | null, fallbackLoss: number | null }, key: 'fallbackLatency' | 'fallbackLoss', event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  const value = Number.parseFloat(raw)
  metric[key] = raw && Number.isFinite(value) ? value : null
}
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="拓扑管理"
    description="选择线路机和落地机后快速生成，或手动编辑每一段的实时 Ping 任务和静态基线。"
    content-class="max-w-6xl"
  >
    <fieldset class="min-w-0 space-y-4" :disabled="manager.saving">
      <div class="space-y-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="text-xs text-muted-foreground">
            选择线路机和可选落地机后快速生成。实时数据由线路机发出 Ping；图画成入口 → 线路机，不等于入口网络正向打过来。修改会保存到 Komari 主题设置。
          </div>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="quickConfiguring || !manager.quickConfigurationAvailable" :aria-busy="quickConfiguring" @click="addQuickRoute">
              <Icon :icon="quickConfiguring ? 'tabler:loader-2' : 'tabler:sparkles'" :class="quickConfiguring && 'animate-spin'" />
              {{ quickConfiguring ? '生成中' : '快速生成' }}
            </Button>
            <Button size="sm" variant="outline" :disabled="quickConfiguring || !manager.canAddRoute" @click="manager.addRoute">
              <Icon icon="tabler:plus" />添加线路
            </Button>
          </div>
        </div>
        <div v-if="manager.canAddRoute" class="grid gap-2 sm:grid-cols-3">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              v-model="quickSourceUuid"
              :disabled="quickConfiguring"
              aria-label="快速生成线路机"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
              @change="onQuickSourceChange"
            >
              <option v-if="!manager.quickNodes.length" value="">
                没有可用节点
              </option>
              <option v-for="option in manager.quickNodes" :key="option.uuid" :value="option.uuid">
                {{ option.name }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机（可选）
            <select
              v-model="quickLandingUuid"
              :disabled="quickConfiguring"
              aria-label="快速生成落地机"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">
                仅入口到线路机
              </option>
              <option v-for="option in quickLandingOptions" :key="option.uuid" :value="option.uuid">
                {{ option.name }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            第 2 段任务
            <select
              v-model="quickHopTask"
              :disabled="quickConfiguring || !quickLandingUuid"
              aria-label="快速生成第 2 段 Ping 任务"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <option :value="QUICK_HOP_AUTO">
                自动匹配落地机
              </option>
              <option value="">
                不绑定，稍后手选
              </option>
              <option v-for="task in quickHopTaskOptions" :key="task" :value="task">
                {{ task }}
              </option>
            </select>
          </label>
        </div>
      </div>
      <span class="sr-only" aria-live="polite">{{ quickConfiguring ? '正在快速生成拓扑草稿' : '' }}</span>

      <div v-if="manager.validationErrors.length" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <div v-for="error in manager.validationErrors" :key="error">
          {{ error }}
        </div>
      </div>

      <article
        v-for="(route, routeIndex) in manager.routes"
        :key="route.id"
        :data-topology-route-id="route.id"
        class="rounded-xl border border-border/65 bg-background/40 p-3 sm:p-4"
      >
        <header class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold">线路 {{ routeIndex + 1 }}</span>
          </div>
          <div class="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === 0" aria-label="上移线路" @click="manager.moveRoute(routeIndex, -1)">
              <Icon icon="tabler:arrow-up" />
            </Button>
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === manager.routes.length - 1" aria-label="下移线路" @click="manager.moveRoute(routeIndex, 1)">
              <Icon icon="tabler:arrow-down" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="删除线路" @click="manager.removeRoute(routeIndex)">
              <Icon icon="tabler:trash" />
            </Button>
          </div>
        </header>

        <div class="grid gap-3 lg:grid-cols-[1fr_1.1fr_1fr_1.1fr_1fr]">
          <div
            v-for="(node, nodeIndex) in route.nodes"
            :key="`${route.id}-node-${nodeIndex}`"
            class="space-y-2 lg:row-start-1"
            :class="nodeIndex === 0 ? 'lg:col-start-1' : nodeIndex === 1 ? 'lg:col-start-3' : 'lg:col-start-5'"
          >
            <label class="block text-[11px] text-muted-foreground">{{ nodeIndex === 0 ? '入口' : nodeIndex === 1 ? '线路机' : '落地机' }}</label>
            <Input
              v-if="nodeIndex === 0"
              v-model="node.name"
              :maxlength="TOPOLOGY_LIMITS.nodeNameLength"
              :aria-label="`第 ${routeIndex + 1} 条线路入口名称`"
              placeholder="北京电信"
            />
            <select
              v-else
              :value="node.name"
              :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 1 ? '线路机' : '落地机'}节点`"
              class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
              @change="selectRouteNode(route, nodeIndex, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option v-for="option in props.nodes" :key="option.uuid" :value="option.name" :disabled="manager.isAmbiguousNodeName(option.name)">
                {{ option.name }}{{ manager.isAmbiguousNodeName(option.name) ? `（重名，${option.region || option.uuid.slice(-8)}，不可用）` : '' }}
              </option>
            </select>
            <Input
              v-if="nodeIndex === 0"
              v-model="node.region"
              :maxlength="TOPOLOGY_LIMITS.regionLength"
              :aria-label="`第 ${routeIndex + 1} 条线路入口地区`"
              placeholder="地区代码（可选）"
              class="h-8 text-xs"
            />
            <Input v-model="node.role" :maxlength="TOPOLOGY_LIMITS.roleLength" :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 0 ? '入口' : nodeIndex === 1 ? '线路机' : '落地机'}角色`" placeholder="角色" class="h-8 text-xs" />
          </div>

          <div
            v-for="(metric, metricIndex) in route.metrics.slice(0, 2)"
            :key="`${route.id}-metric-${metricIndex}`"
            class="space-y-2 rounded-lg border border-border/50 bg-card/35 p-2"
            :class="metricIndex === 0 ? 'lg:col-start-2 lg:row-start-1' : 'lg:col-start-4 lg:row-start-1'"
          >
            <div class="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>第 {{ metricIndex + 1 }} 段指标</span>
              <select
                :value="metric.live ? 'live' : 'baseline'"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段指标模式`"
                class="min-h-8 rounded border border-input bg-background px-1.5 py-1 text-[11px] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                @change="manager.setMetricMode(metric, ($event.target as HTMLSelectElement).value === 'live')"
              >
                <option value="live">
                  实时任务
                </option>
                <option value="baseline">
                  静态基线
                </option>
              </select>
            </div>
            <template v-if="metric.live">
              <select
                :value="metric.nodeName"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段探测来源`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                @change="manager.selectMetricSource(metric, ($event.target as HTMLSelectElement).value); loadTasks(metric.nodeName)"
              >
                <option value="">
                  探测来源节点
                </option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name" :disabled="manager.isAmbiguousNodeName(option.name)">
                  {{ option.name }}{{ manager.isAmbiguousNodeName(option.name) ? `（重名，${option.region || option.uuid.slice(-8)}，不可用）` : '' }}
                </option>
              </select>
              <select
                v-if="nodeTasks(metric.nodeName).length"
                v-model="metric.taskFilter"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段 Ping 任务`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">
                  选择 Ping 任务
                </option>
                <option v-if="metric.taskFilter && !nodeTasks(metric.nodeName).includes(metric.taskFilter)" :value="metric.taskFilter">
                  {{ metric.taskFilter }}（已配置）
                </option>
                <option v-for="task in nodeTasks(metric.nodeName)" :key="task" :value="task">
                  {{ task }}
                </option>
              </select>
              <input
                v-else
                v-model="metric.taskFilter"
                :maxlength="TOPOLOGY_LIMITS.taskNameLength"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段 Ping 任务`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                placeholder="Ping 任务名称"
                @focus="loadTasks(metric.nodeName)"
              >
              <p class="text-[10px] text-muted-foreground" aria-live="polite">
                <template v-if="nodeTaskState(metric.nodeName).loading">
                  正在读取任务…
                </template>
                <template v-else-if="nodeTaskState(metric.nodeName).error">
                  {{ nodeTaskState(metric.nodeName).error }}
                </template>
                <template v-else-if="nodeTasks(metric.nodeName).length">
                  已列出该来源节点可用的 Ping 任务
                </template>
                <template v-else>
                  未找到可用任务，可手动输入精确名称
                </template>
              </p>
            </template>
            <div class="grid grid-cols-2 gap-2">
              <label class="text-[10px] text-muted-foreground">备用延迟
                <input
                  type="number"
                  min="0"
                  step="1"
                  :value="metric.fallbackLatency ?? ''"
                  placeholder="ms"
                  class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                  @input="updateFallback(metric, 'fallbackLatency', $event)"
                >
              </label>
              <label class="text-[10px] text-muted-foreground">备用丢包
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  :value="metric.fallbackLoss ?? ''"
                  placeholder="%"
                  class="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                  @input="updateFallback(metric, 'fallbackLoss', $event)"
                >
              </label>
            </div>
          </div>
        </div>
      </article>

      <div v-if="!manager.routes.length" class="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        还没有线路。选择线路机和落地机后点击“快速生成”，或手动添加线路。
      </div>

      <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl" :aria-busy="manager.saving">
        <Button variant="outline" :disabled="manager.saving" @click="reset">
          恢复已保存配置
        </Button>
        <Button :disabled="manager.saving || quickConfiguring || !manager.dirty || manager.validationErrors.length > 0" @click="save">
          <Icon :icon="manager.saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="manager.saving && 'animate-spin'" />
          {{ manager.saving ? '保存中' : '保存并应用' }}
        </Button>
      </footer>
    </fieldset>
  </AppDialog>
</template>
