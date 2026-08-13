<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, reactive, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTopologyManager } from '@/composables/useTopologyManager'
import { loadPingTaskNamesForNode } from '@/services/metrics.service'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const manager = reactive(useTopologyManager(() => props.nodes))
const taskOptions = ref<Record<string, string[]>>({})
const taskLoading = ref<Record<string, boolean>>({})

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

watch(() => props.open, (value) => {
  if (value)
    manager.reset()
}, { immediate: true })

async function loadTasks(nodeName: string): Promise<void> {
  const node = props.nodes.find(item => item.name === nodeName)
  if (!node || taskOptions.value[node.uuid] || taskLoading.value[node.uuid])
    return
  taskLoading.value = { ...taskLoading.value, [node.uuid]: true }
  try {
    taskOptions.value = { ...taskOptions.value, [node.uuid]: await loadPingTaskNamesForNode(node.uuid) }
  }
  finally {
    taskLoading.value = { ...taskLoading.value, [node.uuid]: false }
  }
}

function nodeTasks(nodeName: string): string[] {
  const node = props.nodes.find(item => item.name === nodeName)
  return node ? taskOptions.value[node.uuid] ?? [] : []
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
    description="添加、排序线路，并为每一段选择实时 Ping 任务或静态基线。"
    content-class="max-w-6xl"
  >
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
        <div class="text-xs text-muted-foreground">
          修改会保存到 Komari 主题设置，所有设备同步生效。
        </div>
        <Button size="sm" variant="outline" @click="manager.addRoute">
          <Icon icon="tabler:plus" />添加线路
        </Button>
      </div>

      <div v-if="manager.validationErrors.length" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
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
              placeholder="北京电信"
            />
            <select
              v-else
              :value="node.name"
              class="h-9 w-full rounded-md border border-input bg-background/70 px-2 text-sm outline-none focus:border-ring"
              @change="manager.selectNode(route, nodeIndex, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">
                {{ option.name }}
              </option>
            </select>
            <Input v-model="node.role" placeholder="角色" class="h-8 text-xs" />
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
                class="rounded border border-input bg-background px-1.5 py-1 text-[11px]"
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
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                @focus="loadTasks(metric.nodeName)"
                @change="loadTasks(metric.nodeName)"
              >
                <option value="">
                  探测来源节点
                </option>
                <option v-for="option in props.nodes" :key="option.uuid" :value="option.name">
                  {{ option.name }}
                </option>
              </select>
              <input
                v-model="metric.taskFilter"
                :list="`tasks-${route.id}-${metricIndex}`"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:border-ring"
                placeholder="Ping 任务名称"
                @focus="loadTasks(metric.nodeName)"
              >
              <datalist :id="`tasks-${route.id}-${metricIndex}`">
                <option v-for="task in nodeTasks(metric.nodeName)" :key="task" :value="task" />
              </datalist>
              <p class="text-[10px] text-muted-foreground">
                {{ taskLoading[props.nodes.find(node => node.name === metric.nodeName)?.uuid || ''] ? '正在读取任务…' : '只统计来源节点上匹配该名称的任务' }}
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

      <footer class="sticky bottom-0 flex justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl">
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
