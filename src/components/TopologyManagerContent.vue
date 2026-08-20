<script setup lang="ts">
import type { useTopologyManagerDialog } from '@/composables/useTopologyManagerDialog'
import { Icon } from '@iconify/vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'

const { context } = defineProps<{ context: ReturnType<typeof useTopologyManagerDialog> }>()
const {
  nodes,
  isOpen,
  manager,
  managerBusy,
  rematchDone,
  recheckNow,
  rematching,
  quickProbeKey,
  quickConfiguring,
  PROBE_CITIES,
  TOPOLOGY_PROBE_OPTIONS,
  CUSTOM_PROBE,
  selectClass,
  quickSourceUuid,
  onQuickSourceChange,
  nodeOption,
  quickLandingUuid,
  quickLandingOptions,
  addQuickRoute,
  quickTaskError,
  validationErrors,
  routeProbeValue,
  pendingEntryTasks,
  routeEntryProbeStates,
  describeTopologyHopProbe,
  routeHopTask,
  pendingRouteTasks,
  routeProbeStates,
  moveRoute,
  removeRoute,
  hasCustomEntryOption,
  customEntryLabel,
  selectRouteProbe,
  selectRouteNode,
  routeEntryHint,
  routeEntryHintTone,
  routeHint,
  routeHintTone,
  writeLog,
  formatWriteLogTime,
  reset,
  taskValidationPending,
  hasPendingWork,
  persistBlockingErrors,
  save,
} = context
</script>

<template>
  <AppDialog
    v-model:open="isOpen"
    title="拓扑管理"
    description="选入口和线路机即可；需要展示下一跳时再选落地机。添加和修改都会自动保存，探测任务会自动创建或复用。"
    content-class="max-w-3xl"
  >
    <fieldset
      class="min-w-0 space-y-4"
      :disabled="managerBusy"
      :data-topology-ready="rematchDone ? 'true' : 'false'"
    >
      <div class="space-y-3 rounded-lg border border-border/60 bg-background/45 px-3 py-3">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="max-w-prose text-xs text-muted-foreground">
            入口只是线路图上的标签，例如北京电信或北京联通。实时数据由线路机发出 Ping。落地机可选：不选时显示“入口 → 线路机”，选中后显示“入口 → 线路机 → 落地机”。添加或修改线路都会立刻保存；入口探测会自动创建或把线路机加进已有的同名任务，第 2 段按落地机地址自动创建或复用。探测方式也会自动挑选，打不通会自动换一种。主题自己建的任务会记在配置里，关页后再开仍可安全清理。<br>
            新建线路只列出在线节点（需要当场验证探测）；下方已有线路可以选到离线节点，方便节点掉线后继续修改。没有公网 IP 的节点不能作为落地机。重名节点只要能选中就会按 UUID 绑定。
          </p>
          <Button
            size="sm"
            variant="outline"
            class="h-8"
            :disabled="managerBusy || !manager.routes.length"
            data-topology-recheck
            @click="recheckNow"
          >
            <Icon :icon="rematching ? 'tabler:loader-2' : 'tabler:refresh'" :class="rematching && 'animate-spin'" />
            重新检测
          </Button>
        </div>
        <div class="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口探测
            <select
              v-model="quickProbeKey"
              :disabled="quickConfiguring"
              aria-label="添加线路入口探测"
              :class="selectClass"
            >
              <optgroup v-for="city in PROBE_CITIES" :key="city" :label="city">
                <option
                  v-for="option in TOPOLOGY_PROBE_OPTIONS.filter(item => item.city === city)"
                  :key="option.key"
                  :value="option.key"
                >
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              v-model="quickSourceUuid"
              :disabled="quickConfiguring"
              aria-label="添加线路线路机"
              :class="selectClass"
              @change="onQuickSourceChange"
            >
              <option v-if="!manager.quickNodes.length" value="">
                没有可用节点
              </option>
              <option
                v-for="option in manager.quickNodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'source').disabled"
              >
                {{ nodeOption(option, 'source').label }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机（可选）
            <select
              v-model="quickLandingUuid"
              :disabled="quickConfiguring"
              aria-label="添加线路落地机"
              :class="selectClass"
            >
              <option value="">
                不选（仅入口 → 线路机）
              </option>
              <option
                v-for="option in quickLandingOptions"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'landing').disabled"
              >
                {{ nodeOption(option, 'landing').label }}
              </option>
            </select>
          </label>
          <Button
            size="sm"
            class="h-9"
            :disabled="managerBusy || !manager.quickConfigurationAvailable || !manager.canAddRoute"
            :aria-busy="managerBusy"
            @click="addQuickRoute"
          >
            <Icon :icon="quickConfiguring ? 'tabler:loader-2' : 'tabler:plus'" :class="quickConfiguring && 'animate-spin'" />
            {{ quickConfiguring ? '添加中' : '添加线路' }}
          </Button>
        </div>
        <p v-if="quickTaskError" role="alert" class="text-xs text-destructive">
          {{ quickTaskError }}
        </p>
      </div>
      <span class="sr-only" aria-live="polite">{{ rematching ? '正在校正已有线路' : quickConfiguring ? '正在添加拓扑线路' : '' }}</span>

      <div v-if="validationErrors.length" role="alert" class="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive">
        <div v-for="error in validationErrors" :key="error">
          {{ error }}
        </div>
      </div>

      <article
        v-for="(route, routeIndex) in manager.routes"
        :key="route.id"
        :data-topology-route-id="route.id"
        :data-topology-entry-probe="routeProbeValue(route)"
        :data-topology-entry-task="route.metrics[0]?.taskFilter || ''"
        :data-topology-entry-pending="pendingEntryTasks[route.id] ? 'true' : 'false'"
        :data-topology-entry-hop-probe="routeEntryProbeStates[route.id] ? describeTopologyHopProbe(routeEntryProbeStates[route.id]!.probe) : ''"
        :data-topology-entry-verdict="routeEntryProbeStates[route.id]?.verdict ?? ''"
        :data-topology-hop-task="routeHopTask(route)"
        :data-topology-hop-pending="pendingRouteTasks[route.id] ? 'true' : 'false'"
        :data-topology-hop-probe="routeProbeStates[route.id] ? describeTopologyHopProbe(routeProbeStates[route.id]!.probe) : ''"
        :data-topology-hop-verdict="routeProbeStates[route.id]?.verdict ?? ''"
        class="rounded-xl border border-border/65 bg-background/40 p-3"
      >
        <header class="mb-2 flex items-center justify-between gap-3">
          <span class="text-sm font-semibold">线路 {{ routeIndex + 1 }}</span>
          <div class="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === 0" aria-label="上移线路" @click="moveRoute(routeIndex, -1)">
              <Icon icon="tabler:arrow-up" />
            </Button>
            <Button size="icon-xs" variant="ghost" :disabled="routeIndex === manager.routes.length - 1" aria-label="下移线路" @click="moveRoute(routeIndex, 1)">
              <Icon icon="tabler:arrow-down" />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="删除线路" @click="removeRoute(routeIndex)">
              <Icon icon="tabler:trash" />
            </Button>
          </div>
        </header>

        <div class="grid items-end gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口
            <select
              :value="routeProbeValue(route)"
              :aria-label="`第 ${routeIndex + 1} 条线路入口探测`"
              :class="selectClass"
              @change="selectRouteProbe(route, ($event.target as HTMLSelectElement).value)"
            >
              <option v-if="hasCustomEntryOption(route)" :value="CUSTOM_PROBE">
                {{ customEntryLabel(route) }}
              </option>
              <optgroup v-for="city in PROBE_CITIES" :key="`${route.id}-${city}`" :label="city">
                <option
                  v-for="option in TOPOLOGY_PROBE_OPTIONS.filter(item => item.city === city)"
                  :key="option.key"
                  :value="option.key"
                >
                  {{ option.label }}
                </option>
              </optgroup>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground sm:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            线路机
            <select
              :value="route.nodes[1]?.uuid || route.nodes[1]?.name || ''"
              :aria-label="`第 ${routeIndex + 1} 条线路线路机`"
              :class="selectClass"
              @change="selectRouteNode(route, 1, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option
                v-for="option in nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'source', route.nodes[2]?.uuid, route.nodes[2]?.name).disabled"
              >
                {{ nodeOption(option, 'source', route.nodes[2]?.uuid, route.nodes[2]?.name).label }}
              </option>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground sm:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
            <select
              :value="route.nodes[2]?.uuid || route.nodes[2]?.name || ''"
              :aria-label="`第 ${routeIndex + 1} 条线路落地机`"
              :class="selectClass"
              @change="selectRouteNode(route, 2, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option
                v-for="option in nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'landing', route.nodes[1]?.uuid, route.nodes[1]?.name).disabled"
              >
                {{ nodeOption(option, 'landing', route.nodes[1]?.uuid, route.nodes[1]?.name).label }}
              </option>
            </select>
          </label>
        </div>
        <p
          v-if="routeEntryHint(route)"
          data-topology-entry-hint
          class="mt-2 text-[11px]"
          :class="routeEntryHintTone(route) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'"
        >
          {{ routeEntryHint(route) }}
        </p>
        <p
          v-if="routeHint(route)"
          data-topology-hop-hint
          class="mt-1 text-[11px]"
          :class="routeHintTone(route) ? 'text-destructive' : 'text-muted-foreground'"
        >
          {{ routeHint(route) }}
        </p>
      </article>

      <div v-if="!manager.routes.length" class="rounded-xl border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
        还没有线路。选择入口和线路机即可添加；落地机可选，添加后会立即保存。
      </div>

      <details v-if="writeLog.length" data-topology-write-log class="rounded-xl border border-border/60 px-4 py-3">
        <summary class="cursor-pointer text-xs text-muted-foreground">
          本次会话的后端写入记录（{{ writeLog.length }} 条）
        </summary>
        <ul class="mt-2 flex flex-col gap-1.5">
          <li v-for="(entry, index) in writeLog" :key="`${entry.at}-${index}`" class="flex flex-wrap items-baseline gap-x-2 text-[11px]">
            <span class="font-mono text-muted-foreground">{{ formatWriteLogTime(entry.at) }}</span>
            <span class="text-muted-foreground">{{ entry.trigger === 'auto' ? '自动修复' : '手动操作' }}</span>
            <span :class="entry.outcome === 'failed' ? 'text-destructive' : ''">{{ entry.action }}</span>
            <span v-if="entry.detail" class="text-muted-foreground">— {{ entry.detail }}</span>
          </li>
        </ul>
      </details>

      <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border/60 bg-card/95 pt-3 backdrop-blur-xl" :aria-busy="managerBusy">
        <Button variant="outline" :disabled="managerBusy" @click="reset">
          恢复已保存配置
        </Button>
        <Button :disabled="managerBusy || taskValidationPending || !hasPendingWork() || persistBlockingErrors.length > 0" @click="save">
          <Icon :icon="manager.saving ? 'tabler:loader-2' : 'tabler:device-floppy'" :class="manager.saving && 'animate-spin'" />
          {{ manager.saving ? '保存中' : '保存并应用' }}
        </Button>
      </footer>
    </fieldset>
  </AppDialog>
</template>
