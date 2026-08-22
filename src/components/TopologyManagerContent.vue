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
  customEntryOptions,
  CUSTOM_PROBE,
  selectClass,
  quickSourceUuid,
  quickJumperUuid,
  onQuickSourceChange,
  onQuickJumperChange,
  nodeOption,
  quickLandingUuid,
  quickLandingOptions,
  quickJumperOptions,
  quickEntryLabel,
  quickEntryTarget,
  isCustomProbeValue,
  onQuickProbeChange,
  addQuickRoute,
  quickTaskError,
  validationErrors,
  routeProbeValue,
  pendingEntryTasks,
  routeEntryProbeStates,
  describeTopologyHopProbe,
  routeHopTask,
  moveRoute,
  removeRoute,
  hasCustomEntryOption,
  customEntryLabel,
  selectRouteProbe,
  updateRouteEntryLabel,
  updateRouteEntryTarget,
  selectRouteNode,
  selectRouteJumper,
  routeEntryHint,
  routeEntryHintTone,
  routeHint,
  routeHintTone,
  routeSegmentPending,
  routeSegmentState,
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
    description="按顺序选择节点即可生成线路；跳板可选，所有可探测线路段都会自动创建或复用任务。"
    content-class="max-w-5xl"
  >
    <fieldset
      class="min-w-0 space-y-4"
      :disabled="managerBusy"
      :data-topology-ready="rematchDone ? 'true' : 'false'"
    >
      <div class="space-y-3 rounded-lg border border-border/60 bg-background/45 px-3 py-3">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="max-w-3xl text-xs text-muted-foreground">
            只需选择“入口 → 线路机 → 可选跳板 → 落地机”，系统会自动匹配、创建并保存每一段 Ping 任务。自定义入口填写名称和探测目标后也会自动探测，并保留在入口下拉框中供以后复用；旧线路无需改动。
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
        <div class="grid items-end gap-2 md:grid-cols-[1.05fr_1fr_1fr_1fr_auto]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口探测
            <select
              v-model="quickProbeKey"
              :disabled="quickConfiguring"
              aria-label="添加线路入口探测"
              :class="selectClass"
              @change="onQuickProbeChange"
            >
              <option :value="CUSTOM_PROBE">
                自定义入口…
              </option>
              <optgroup v-if="customEntryOptions.length" label="已保存入口">
                <option v-for="option in customEntryOptions" :key="option.key" :value="option.key">
                  {{ option.label }} · {{ option.target }}
                </option>
              </optgroup>
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
            <input
              v-if="isCustomProbeValue(quickProbeKey)"
              v-model="quickEntryLabel"
              maxlength="120"
              class="mt-1"
              placeholder="例如：深圳家宽"
              aria-label="自定义入口名称"
              :class="selectClass"
            >
            <input
              v-if="isCustomProbeValue(quickProbeKey)"
              v-model="quickEntryTarget"
              maxlength="253"
              class="mt-1 font-mono"
              placeholder="探测目标，例如：202.97.0.1"
              aria-label="自定义入口探测目标"
              spellcheck="false"
              :class="selectClass"
            >
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
            跳板（可选）
            <select
              v-model="quickJumperUuid"
              :disabled="quickConfiguring"
              aria-label="添加线路跳板"
              :class="selectClass"
              @change="onQuickJumperChange"
            >
              <option value="">
                不使用跳板
              </option>
              <option
                v-for="option in quickJumperOptions"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="nodeOption(option, 'jumper', quickLandingUuid).disabled"
              >
                {{ nodeOption(option, 'jumper', quickLandingUuid).label }}
              </option>
            </select>
          </label>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
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
        :data-topology-hop-pending="routeSegmentPending(route, 1) ? 'true' : 'false'"
        :data-topology-hop-probe="routeSegmentState(route, 1) ? describeTopologyHopProbe(routeSegmentState(route, 1)!.probe) : ''"
        :data-topology-hop-verdict="routeSegmentState(route, 1)?.verdict ?? ''"
        :data-topology-final-task="route.nodes.length >= 4 ? routeHopTask(route, 2) : ''"
        :data-topology-final-pending="route.nodes.length >= 4 && routeSegmentPending(route, 2) ? 'true' : 'false'"
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

        <div class="grid items-end gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr]">
          <label class="space-y-1 text-[11px] text-muted-foreground">
            入口
            <select
              :value="routeProbeValue(route)"
              :aria-label="`第 ${routeIndex + 1} 条线路入口探测`"
              :class="selectClass"
              @change="selectRouteProbe(route, ($event.target as HTMLSelectElement).value)"
            >
              <option :value="CUSTOM_PROBE">
                {{ hasCustomEntryOption(route) ? customEntryLabel(route) : '自定义入口…' }}
              </option>
              <optgroup v-if="customEntryOptions.length" label="已保存入口">
                <option v-for="option in customEntryOptions" :key="`${route.id}-${option.key}`" :value="option.key">
                  {{ option.label }} · {{ option.target }}
                </option>
              </optgroup>
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
            <input
              v-if="isCustomProbeValue(routeProbeValue(route))"
              :value="route.nodes[0]?.name"
              maxlength="120"
              class="mt-1"
              placeholder="例如：深圳家宽"
              :aria-label="`第 ${routeIndex + 1} 条线路自定义入口名称`"
              :class="selectClass"
              @change="updateRouteEntryLabel(route, ($event.target as HTMLInputElement).value)"
            >
            <input
              v-if="isCustomProbeValue(routeProbeValue(route))"
              :value="route.nodes[0]?.probeTarget || ''"
              maxlength="253"
              class="mt-1 font-mono"
              placeholder="探测目标，例如：202.97.0.1"
              :aria-label="`第 ${routeIndex + 1} 条线路自定义入口探测目标`"
              spellcheck="false"
              :class="selectClass"
              @change="updateRouteEntryTarget(route, ($event.target as HTMLInputElement).value)"
            >
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground md:block" aria-hidden="true">→</span>
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
                :disabled="route.nodes.slice(2).some(node => node.uuid === option.uuid) || nodeOption(option, 'source').disabled"
              >
                {{ nodeOption(option, 'source').label }}
              </option>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground md:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            跳板（可选）
            <select
              :value="route.nodes.length >= 4 ? route.nodes[2]?.uuid || route.nodes[2]?.name || '' : ''"
              :aria-label="`第 ${routeIndex + 1} 条线路跳板`"
              :class="selectClass"
              @change="selectRouteJumper(route, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                不使用跳板
              </option>
              <option
                v-for="option in nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="option.uuid === route.nodes[1]?.uuid || option.uuid === route.nodes[route.nodes.length - 1]?.uuid || nodeOption(option, 'jumper').disabled"
              >
                {{ nodeOption(option, 'jumper').label }}
              </option>
            </select>
          </label>
          <span class="hidden pb-2 text-xs text-muted-foreground md:block" aria-hidden="true">→</span>
          <label class="space-y-1 text-[11px] text-muted-foreground">
            落地机
            <select
              :value="route.nodes[route.nodes.length - 1]?.uuid || route.nodes[route.nodes.length - 1]?.name || ''"
              :aria-label="`第 ${routeIndex + 1} 条线路落地机`"
              :class="selectClass"
              @change="selectRouteNode(route, route.nodes.length - 1, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                选择节点
              </option>
              <option
                v-for="option in nodes"
                :key="option.uuid"
                :value="option.uuid"
                :disabled="route.nodes.slice(1, -1).some(node => node.uuid === option.uuid) || nodeOption(option, 'landing').disabled"
              >
                {{ nodeOption(option, 'landing').label }}
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
          本机后端写入记录（{{ writeLog.length }} 条，保存在本浏览器）
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
