<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import type { PandaOpsNodeControl } from '@/utils/pandaOpsNodeControl'
import { Icon } from '@iconify/vue'
import { computed, ref } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { recordPandaOpsControlEvent } from '@/composables/usePandaOpsIncidentTimeline'
import { savePandaOpsNodeControls } from '@/services/pandaOpsControl.service'
import { useAppStore } from '@/stores/app'
import { formatDateTime } from '@/utils/helper'
import { formatNodeControlRemaining, updatePandaOpsNodeControl } from '@/utils/pandaOpsNodeControl'

const props = defineProps<{ open: boolean, node: NodeData | null }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()
const appStore = useAppStore()
const saving = ref<'maintenance' | 'silence' | null>(null)

const isOpen = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})
const control = computed<PandaOpsNodeControl>(() => props.node
  ? appStore.pandaOpsNodeControls[props.node.uuid] ?? {}
  : {})

async function updateControl(key: keyof PandaOpsNodeControl, durationMinutes?: number): Promise<void> {
  const node = props.node
  const publicSettings = appStore.publicSettings
  if (!node || !publicSettings)
    return

  const until = durationMinutes ? Date.now() + durationMinutes * 60_000 : undefined
  const nextControls = updatePandaOpsNodeControl(appStore.pandaOpsNodeControls, node.uuid, key, until)
  saving.value = key === 'maintenanceUntil' ? 'maintenance' : 'silence'
  try {
    const payload = await savePandaOpsNodeControls({
      theme: publicSettings.theme,
      themeSettings: publicSettings.theme_settings ?? {},
      controls: nextControls,
    })
    appStore.publicSettings = { ...publicSettings, theme_settings: payload }

    if (key === 'maintenanceUntil') {
      recordPandaOpsControlEvent(
        node.uuid,
        node.name,
        until ? 'maintenanceStarted' : 'maintenanceEnded',
        until ? `进入维护，预计 ${formatDateTime(new Date(until), 'MM-DD HH:mm')} 结束` : '维护已结束',
      )
      window.$message?.success(until ? '维护状态已启用。' : '维护状态已结束。')
    }
    else {
      recordPandaOpsControlEvent(
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
    description="临时维护会从在线统计和告警中排除节点；告警静默仅隐藏首页告警。"
    content-class="max-w-lg"
  >
    <div v-if="node" class="space-y-3" data-panda-node-control-dialog>
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
