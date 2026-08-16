<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { loadPingTaskNamesForNode } from '@/services/metrics.service'
import { topologyPingTaskName } from '@/services/topology-tasks.service'
import { TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyHelper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const manager = reactive(useTopologyManager(() => props.nodes))
const taskOptions = ref<Record<string, string[]>>({})
const taskLoading = ref<Record<string, boolean>>({})
const taskErrors = ref<Record<string, string>>({})
const advancedRouteIds = ref<Set<number>>(new Set())
const quickSavingRouteIds = ref<Set<number>>(new Set())
const taskRequests = new Map<string, Promise<boolean>>()
const CUSTOM_ENTRY_VALUE = '__transit_custom_entry__'
const entryOptions = TOPOLOGY_PROBE_OPTIONS.map(option => option.label)

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

watch(() => props.open, (value) => {
  if (value) {
    manager.reset()
    taskOptions.value = {}
    taskLoading.value = {}
    taskErrors.value = {}
    advancedRouteIds.value = new Set()
    quickSavingRouteIds.value = new Set()
    const sourceNames = manager.routes.flatMap(route => route.metrics.map(metric => metric.nodeName)).filter(Boolean)
    void Promise.all(Array.from(new Set(sourceNames), loadTasks))
  }
}, { immediate: true })

async function loadTasks(nodeName: string): Promise<boolean> {
  const node = props.nodes.find(item => item.name === nodeName)
  if (!node)
    return false

  const pending = taskRequests.get(node.uuid)
  if (pending)
    return pending

  const request = (async () => {
    taskLoading.value = { ...taskLoading.value, [node.uuid]: true }
    taskErrors.value = { ...taskErrors.value, [node.uuid]: '' }
    try {
      taskOptions.value = { ...taskOptions.value, [node.uuid]: await loadPingTaskNamesForNode(node.uuid) }
      return true
    }
    catch (error) {
      taskErrors.value = {
        ...taskErrors.value,
        [node.uuid]: error instanceof Error ? error.message : '无法读取 Ping 任务。',
      }
      return false
    }
    finally {
      taskLoading.value = { ...taskLoading.value, [node.uuid]: false }
    }
  })()
  taskRequests.set(node.uuid, request)
  try {
    return await request
  }
  finally {
    if (taskRequests.get(node.uuid) === request)
      taskRequests.delete(node.uuid)
  }
}

function nodeTasks(nodeName: string): string[] {
  const node = props.nodes.find(item => item.name === nodeName)
  return node ? taskOptions.value[node.uuid] ?? [] : []
}

function nodeTaskState(nodeName: string): { uuid: string, loading: boolean, error: string } {
  const uuid = props.nodes.find(item => item.name === nodeName)?.uuid ?? ''
  return {
    uuid,
    loading: Boolean(uuid && taskLoading.value[uuid]),
    error: uuid ? taskErrors.value[uuid] ?? '' : '',
  }
}

async function save(): Promise<void> {
  try {
    if (await manager.save()) {
      window.$message?.success('拓扑配置已保存。')
      isOpen.value = false
    }
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '拓扑保存失败。')
  }
}

function isAdvanced(routeId: number): boolean {
  return advancedRouteIds.value.has(routeId)
}

function toggleAdvanced(routeId: number): void {
  const next = new Set(advancedRouteIds.value)
  if (next.has(routeId))
    next.delete(routeId)
  else
    next.add(routeId)
  advancedRouteIds.value = next
}

function quickSaving(routeId: number): boolean {
  return quickSavingRouteIds.value.has(routeId)
}

function setQuickNode(route: typeof manager.routes[number], index: 1 | 2, name: string): void {
  manager.selectNode(route, index, name)
  manager.prepareQuickRoute(route)
  if (index === 1 && name)
    void loadTasks(name)
}

function isCustomEntry(name: string): boolean {
  return Boolean(name && !entryOptions.includes(name))
}

function setQuickEntry(route: typeof manager.routes[number], value: string): void {
  manager.prepareQuickRoute(route)
  if (value === CUSTOM_ENTRY_VALUE) {
    route.nodes[0]!.name = ''
    if (!isAdvanced(route.id))
      toggleAdvanced(route.id)
    return
  }
  route.nodes[0]!.name = value
}

function matchingQuickTask(sourceName: string, targetName: string): string {
  const source = props.nodes.find(node => node.name === sourceName)
  const target = props.nodes.find(node => node.name === targetName)
  if (!source || !target)
    return ''
  const expected = topologyPingTaskName(source, target)
  return nodeTasks(sourceName).find(task => task === expected) ?? ''
}

async function configureQuickRoute(route: typeof manager.routes[number]): Promise<void> {
  if (quickSaving(route.id) || manager.saving)
    return
  manager.prepareQuickRoute(route)
  const entryName = route.nodes[0]?.name.trim()
  const relayName = route.nodes[1]?.name.trim()
  const targetName = route.nodes[2]?.name.trim()
  if (!entryName || !relayName || !targetName) {
    window.$message?.warning('填写入口名称，选择线路机和落地机后即可一键完成。')
    return
  }

  const saving = new Set(quickSavingRouteIds.value)
  saving.add(route.id)
  quickSavingRouteIds.value = saving
  try {
    if (!await loadTasks(relayName))
      throw new Error('无法确认已有 Ping 任务，为避免重复创建，请稍后重试。')
    const existing = matchingQuickTask(relayName, targetName)
    const metric = route.metrics[1]
    if (existing && metric) {
      metric.live = true
      metric.nodeName = relayName
      metric.taskFilter = existing
    }
    else {
      const created = await manager.createQuickRouteTask(route)
      const source = props.nodes.find(node => node.name === relayName)
      if (source) {
        taskOptions.value = {
          ...taskOptions.value,
          [source.uuid]: [...new Set([...nodeTasks(relayName), created.name])],
        }
      }
    }

    if (await manager.save()) {
      window.$message?.success(existing
        ? `已复用任务 ${existing}，线路已保存。`
        : 'Ping 任务已创建、绑定并保存。')
    }
    else {
      window.$message?.warning('任务已绑定；请补全其他线路后，再点击底部保存。')
    }
  }
  catch (error) {
    window.$message?.error(error instanceof Error ? error.message : '一键配置失败，请稍后重试。')
  }
  finally {
    const next = new Set(quickSavingRouteIds.value)
    next.delete(route.id)
    quickSavingRouteIds.value = next
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
    description="填入口、选择线路机和落地机；系统会自动创建并绑定 Ping 任务。"
    content-class="max-w-6xl"
  >
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
        <div class="text-xs text-muted-foreground">
          快速配置会创建「线路机 → 落地机」的 ICMP Ping 任务，并保存到 Komari 主题设置。
        </div>
        <Button size="sm" variant="outline" @click="manager.addRoute">
          <Icon icon="tabler:plus" />添加线路
        </Button>
      </div>

      <div v-if="manager.validationErrors.length" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <div v-for="error in manager.validationErrors" :key="error">
          {{ error }}
        </div>
      </div>

      <article
        v-for="(route, routeIndex) in manager.routes"
        :key="route.id"
        class="rounded-xl border border-border/65 bg-background/40 p-3 sm:p-4"
      >
        <header class="mb-3 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold">线路 {{ routeIndex + 1 }}</span>
            <span class="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">快速配置</span>
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

        <section class="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.045] p-3" :aria-label="`第 ${routeIndex + 1} 条线路快速配置`">
          <div class="grid gap-3 md:grid-cols-3">
            <label class="space-y-1 text-xs font-medium">
              <span>1. 入口运营商</span>
              <select
                :value="route.nodes[0]?.name ?? ''"
                :aria-label="`第 ${routeIndex + 1} 条线路入口运营商`"
                class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                @change="setQuickEntry(route, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">选择入口运营商</option>
                <option v-for="option in entryOptions" :key="option" :value="option">{{ option }}</option>
                <option v-if="isCustomEntry(route.nodes[0]?.name ?? '')" :value="route.nodes[0]!.name">当前自定义：{{ route.nodes[0]!.name }}</option>
                <option :value="CUSTOM_ENTRY_VALUE">自定义入口…</option>
              </select>
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>2. 线路机</span>
              <select
                :value="route.nodes[1]?.name ?? ''"
                :aria-label="`第 ${routeIndex + 1} 条线路快速线路机`"
                class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                @change="setQuickNode(route, 1, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">选择线路机</option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">{{ option.name }}</option>
              </select>
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>3. 落地机</span>
              <select
                :value="route.nodes[2]?.name ?? ''"
                :aria-label="`第 ${routeIndex + 1} 条线路快速落地机`"
                class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
                @change="setQuickNode(route, 2, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">选择落地机</option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">{{ option.name }}</option>
              </select>
            </label>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" :disabled="quickSaving(route.id) || manager.saving" @click="configureQuickRoute(route)">
              <Icon :icon="quickSaving(route.id) ? 'tabler:loader-2' : 'tabler:wand-stars'" :class="quickSaving(route.id) && 'animate-spin'" />
              {{ quickSaving(route.id) ? '正在配置…' : '一键创建任务并保存' }}
            </Button>
            <span class="text-[10px] text-muted-foreground">同名任务会自动复用；需要细调时再打开高级设置。</span>
            <Button size="xs" variant="ghost" class="ml-auto" @click="toggleAdvanced(route.id)">
              <Icon :icon="isAdvanced(route.id) ? 'tabler:chevron-up' : 'tabler:adjustments'" />
              {{ isAdvanced(route.id) ? '收起高级设置' : '高级设置' }}
            </Button>
          </div>
        </section>

        <div v-if="isAdvanced(route.id)" class="mt-3 grid gap-3 border-t border-border/50 pt-3 lg:grid-cols-[1fr_1.1fr_1fr_1.1fr_1fr]">
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
              :aria-label="`第 ${routeIndex + 1} 条线路入口名称`"
              placeholder="北京电信"
            />
            <select
              v-else
              :value="node.name"
              :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 1 ? '线路机' : '落地机'}节点`"
              class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
              @change="manager.selectNode(route, nodeIndex, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">
                {{ option.name }}
              </option>
            </select>
            <Input v-model="node.role" :aria-label="`第 ${routeIndex + 1} 条线路${nodeIndex === 0 ? '入口' : nodeIndex === 1 ? '线路机' : '落地机'}角色`" placeholder="角色" class="h-8 text-xs" />
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
                v-model="metric.nodeName"
                :aria-label="`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段探测来源`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                @change="loadTasks(metric.nodeName)"
              >
                <option value="">
                  探测来源节点
                </option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">
                  {{ option.name }}
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

      <div v-if="!manager.routes.length" class="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        还没有线路，点击“添加线路”开始配置。
      </div>

      <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl" :aria-busy="manager.saving">
        <Button variant="outline" :disabled="manager.saving" @click="manager.reset">
          恢复已保存配置
        </Button>
        <Button :disabled="manager.saving || !manager.dirty || manager.validationErrors.length > 0" @click="save">
          <Icon :icon="manager.saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="manager.saving && 'animate-spin'" />
          {{ manager.saving ? '保存中' : '保存并应用' }}
        </Button>
      </footer>
    </div>
  </AppDialog>
</template>
