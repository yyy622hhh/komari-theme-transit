<script setup lang="ts">
import type { CarrierProbeHealth, CarrierProbeHealthStatus } from '@/services/carrier-probe.service'
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue/offline'
import { computed, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCarrierProbeHealthCenter } from '@/composables/useCarrierProbeHealthCenter'
import { formatDateTime } from '@/utils/helper'
import { PROBE_CURRENT_LABELS } from '@/utils/pingCurrentState'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const center = useCarrierProbeHealthCenter(() => props.nodes)
const expandedKey = ref('')
const customType = ref<'icmp' | 'tcp'>('icmp')
const customHost = ref('')
const customPort = ref('53')
const pendingConfirmation = ref('')

const statusMeta: Record<CarrierProbeHealthStatus, { label: string, icon: string, tone: string }> = {
  'healthy': { label: '健康', icon: 'tabler:circle-check', tone: 'text-emerald-600 dark:text-emerald-400' },
  'single-path-anomaly': { label: '单节点路径异常', icon: 'tabler:alert-triangle', tone: 'text-amber-600 dark:text-amber-400' },
  'shared-target-anomaly': { label: '公共目标异常', icon: 'tabler:world-x', tone: 'text-rose-600 dark:text-rose-400' },
  'insufficient-evidence': { label: '暂无数据', icon: 'tabler:help-circle', tone: 'text-muted-foreground' },
}

watch(() => props.open, (open) => {
  if (!open)
    return
  center.reset()
  expandedKey.value = ''
  pendingConfirmation.value = ''
  void center.refresh(true)
}, { immediate: true })

const selected = computed(() => center.health.value.find(item => item.key === expandedKey.value) ?? null)

function toggleDetails(item: CarrierProbeHealth): void {
  expandedKey.value = expandedKey.value === item.key ? '' : item.key
  customType.value = 'icmp'
  customHost.value = ''
  customPort.value = '53'
  pendingConfirmation.value = ''
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`
}

function abnormalNames(item: CarrierProbeHealth): string {
  return item.abnormalNodeUuids.map(uuid => center.nodeNames.value.get(uuid) ?? uuid).join('、')
}

async function verifyCustom(): Promise<void> {
  if (!selected.value)
    return
  const accepted = await center.verifyCustom(
    selected.value,
    customType.value,
    customHost.value,
    customType.value === 'tcp' ? Number(customPort.value) : undefined,
  )
  if (accepted)
    pendingConfirmation.value = ''
}

async function confirmMigration(item: CarrierProbeHealth): Promise<void> {
  const key = `migrate:${item.key}`
  if (pendingConfirmation.value !== key) {
    pendingConfirmation.value = key
    return
  }
  pendingConfirmation.value = ''
  await center.migrate(item)
}

async function confirmRebuild(item: CarrierProbeHealth): Promise<void> {
  const key = `rebuild:${item.key}`
  if (pendingConfirmation.value !== key) {
    pendingConfirmation.value = key
    return
  }
  pendingConfirmation.value = ''
  await center.rebuild(item)
}
</script>

<template>
  <AppDialog
    :open="open"
    title="监测目标健康"
    description="当前任务状态来自 Komari；内置目标只作为候选，验证并确认后才会迁移。"
    content-class="max-w-4xl"
    icon="tabler:heart-rate-monitor"
    @update:open="emit('update:open', $event)"
  >
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/45 px-3 py-2">
        <p class="text-[11px] leading-5 text-muted-foreground">
          不会自动修改现有任务。内置候选目标只建立 Komari Ping 临时任务，不会交给回程助手或写入 Shell 命令。
        </p>
        <Button variant="outline" size="xs" :disabled="center.loading.value" @click="center.refresh()">
          <Icon :icon="center.loading.value ? 'tabler:loader-2' : 'tabler:refresh'" :class="center.loading.value && 'animate-spin'" />
          刷新
        </Button>
      </div>

      <p v-if="center.error.value" class="rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">
        {{ center.error.value }}
      </p>
      <p v-if="center.activeKey.value && center.operation.value" role="status" class="rounded-md bg-primary/5 px-3 py-2 text-xs">
        {{ center.operation.value.message }} 关闭此窗口后继续；刷新或关闭浏览器会中断，需要回查。
      </p>
      <p v-else-if="center.operation.value?.phase === 'failed' && !center.migration.value && !center.error.value" class="rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive">
        {{ center.operation.value.message }}
      </p>
      <p v-if="!center.mutationSupported" class="text-xs text-amber-700 dark:text-amber-300">
        当前浏览器不支持 Web Locks，迁移和重建已禁用；查看和验证仍可使用。
      </p>
      <div v-for="record in center.recovery.value" :key="record.id" class="rounded-md border border-amber-500/40 p-3 text-xs">
        <p>{{ record.original.name }}：{{ record.message }}</p>
        <Button class="mt-2" size="xs" variant="outline" :disabled="!center.mutationSupported || Boolean(center.activeKey.value)" @click="pendingConfirmation === `recover:${record.id}` ? center.recover(record) : pendingConfirmation = `recover:${record.id}`">
          {{ pendingConfirmation === `recover:${record.id}` ? '再次确认：保留原任务，清理本次残留资源' : '核对并清理残留资源' }}
        </Button>
      </div>
      <p
        v-if="center.migration.value"
        class="rounded-md px-3 py-2 text-xs"
        :class="center.migration.value.ok ? 'bg-emerald-500/8 text-emerald-700 dark:text-emerald-300' : 'bg-destructive/8 text-destructive'"
      >
        {{ center.migration.value.message }}
      </p>

      <div v-if="center.loading.value && !center.health.value.length" class="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Icon icon="tabler:loader-2" class="animate-spin" />
        正在汇总最近一小时样本…
      </div>

      <div v-else class="max-h-[65vh] space-y-2 overflow-y-auto pr-1">
        <section
          v-for="item in center.health.value"
          :key="item.key"
          class="rounded-lg border border-border/60 bg-background/40"
        >
          <button
            type="button"
            class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left"
            :aria-expanded="expandedKey === item.key"
            @click="toggleDetails(item)"
          >
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="text-sm font-medium">{{ item.label }}</span>
                <span class="inline-flex items-center gap-1 text-[11px]" :class="statusMeta[item.status].tone">
                  <Icon :icon="statusMeta[item.status].icon" width="13" height="13" />
                  {{ statusMeta[item.status].label }}
                </span>
              </div>
              <p class="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {{ item.task ? `${item.probeType.toUpperCase()} · ${item.currentTarget}` : '未找到对应 Ping 任务' }}
              </p>
            </div>
            <div class="flex items-center gap-3 text-right">
              <div class="hidden sm:block">
                <p class="text-xs tabular-nums">
                  近1h成功 {{ percent(item.successRate) }}
                </p>
                <p class="text-[10px] text-muted-foreground">
                  {{ item.sampleCount }} 样本 · {{ item.onlineNodes }} 在线
                </p>
              </div>
              <Icon :icon="expandedKey === item.key ? 'tabler:chevron-up' : 'tabler:chevron-down'" class="text-muted-foreground" />
            </div>
          </button>

          <div v-if="expandedKey === item.key" class="space-y-3 border-t border-border/60 px-3 py-3">
            <div class="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
              <p>当前：{{ PROBE_CURRENT_LABELS[item.current.status] }}</p>
              <p>最近成功：{{ item.current.lastSuccessAt ? formatDateTime(new Date(item.current.lastSuccessAt)) : '窗口内无成功' }}</p>
              <p>样本更新：{{ item.current.latestAt ? formatDateTime(new Date(item.current.latestAt)) : '未知' }}</p>
              <p v-if="item.recovered" class="sm:col-span-3 text-emerald-700 dark:text-emerald-300">
                已恢复，近 1 小时窗口内曾异常；历史统计保留。
              </p>
              <p>分配 {{ item.assignedNodes }} 台 / 在线 {{ item.onlineNodes }} 台</p>
              <p>达到采样门槛 {{ item.sampledNodes }} 台</p>
              <p>近 1 小时同步目标异常 {{ item.commonModeEvents }} 次</p>
              <p v-if="item.abnormalNodeUuids.length" class="sm:col-span-3 text-amber-700 dark:text-amber-300">
                近 1 小时异常节点：{{ abnormalNames(item) }}
              </p>
            </div>

            <template v-if="item.task">
              <div v-if="item.fallback" class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 p-2.5">
                <div>
                  <p class="text-xs font-medium">
                    内置候选目标
                  </p>
                  <p class="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    {{ item.fallback.type.toUpperCase() }} · {{ item.fallback.target }}
                  </p>
                </div>
                <Button size="xs" variant="outline" :disabled="Boolean(center.activeKey.value)" @click="center.verify(item, item.fallback)">
                  <Icon v-if="center.activeKey.value === item.key" icon="tabler:loader-2" class="animate-spin" />
                  验证候选目标
                </Button>
              </div>
              <p v-else class="rounded-md border border-border/50 bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
                当前任务已在使用内置候选目标，没有别的内置地址可比较；如需验证，请在下方填写自定义候选。
              </p>

              <div class="grid gap-2 rounded-md border border-border/50 p-2.5 sm:grid-cols-[7rem_minmax(0,1fr)_6rem_auto]">
                <select v-model="customType" aria-label="候选探测类型" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
                  <option value="icmp">
                    ICMP
                  </option>
                  <option value="tcp">
                    TCP
                  </option>
                </select>
                <Input v-model="customHost" class="h-8 text-xs" placeholder="IPv4 或主机名" aria-label="自定义候选目标" />
                <Input v-if="customType === 'tcp'" v-model="customPort" class="h-8 text-xs" inputmode="numeric" placeholder="端口" aria-label="TCP 端口" />
                <span v-else class="hidden sm:block" />
                <Button size="xs" variant="outline" :disabled="Boolean(center.activeKey.value) || !customHost.trim()" @click="verifyCustom">
                  验证自定义
                </Button>
              </div>

              <div v-if="center.results.value[item.key]" class="rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p :class="center.results.value[item.key].migratable ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'">
                      {{ center.results.value[item.key].reason }}
                    </p>
                    <p class="mt-1 font-mono text-[11px] text-muted-foreground">
                      {{ center.results.value[item.key].target }} · 成功率 {{ percent(center.results.value[item.key].successRate) }}
                    </p>
                  </div>
                  <Button
                    v-if="center.results.value[item.key].migratable"
                    size="xs"
                    :variant="pendingConfirmation === `migrate:${item.key}` ? 'default' : 'outline'"
                    :disabled="Boolean(center.activeKey.value) || !center.mutationSupported"
                    @click="confirmMigration(item)"
                  >
                    {{ pendingConfirmation === `migrate:${item.key}` ? '再次点击确认迁移' : '迁移到此目标' }}
                  </Button>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
                <p class="text-[11px] text-muted-foreground">
                  目标未变但历史被手工修改污染时，可重建任务获得新 ID。
                </p>
                <Button
                  size="xs"
                  variant="ghost"
                  :disabled="Boolean(center.activeKey.value) || !center.mutationSupported"
                  @click="confirmRebuild(item)"
                >
                  {{ pendingConfirmation === `rebuild:${item.key}` ? '再次点击确认重建' : '重建当前任务' }}
                </Button>
              </div>
            </template>
          </div>
        </section>
      </div>
    </div>
  </AppDialog>
</template>
