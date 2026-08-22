<script setup lang="ts">
import type { SetupWizardPresetFields } from '@/utils/setupWizardPresets'
import { Icon } from '@iconify/vue'
import { computed, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { useSetupWizard } from '@/composables/useSetupWizard'
import {
  CHART_DASHBOARD_PRESETS,
  DETAIL_METRIC_CARD_PRESETS,
  GENERAL_CARD_PRESETS,
  HOME_QUICK_CONTROL_PRESETS,
} from '@/stores/app.settings.constants'
import { formatBeijingTime } from '@/utils/topologyReport'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const wizard = useSetupWizard()

watch(() => props.open, (open) => {
  if (open)
    wizard.reset()
}, { immediate: true })

const STEP_LABELS = ['欢迎', '选择预设', '自动检测', '确认应用']
const stepIndex = computed(() => {
  if (wizard.step.value === 'welcome')
    return 0
  if (wizard.step.value === 'preset' || wizard.step.value === 'advanced')
    return 1
  if (wizard.step.value === 'detect')
    return 2
  return 3
})

const selectClass = 'h-9 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40'
const checkboxClass = 'size-3.5 accent-emerald-500'

const cardSizeScale: Record<SetupWizardPresetFields['nodeCardSize'], string> = {
  mini: 'p-1.5 text-[10px]',
  compact: 'p-2 text-xs',
  comfortable: 'p-3 text-sm',
  large: 'p-4 text-base',
}

const previewCounts = computed(() => ({
  generalCards: GENERAL_CARD_PRESETS[wizard.fields.value.generalCardPreset]?.length ?? 0,
  quickControls: HOME_QUICK_CONTROL_PRESETS[wizard.fields.value.homeQuickControlPreset]?.length ?? 0,
  detailMetricCards: DETAIL_METRIC_CARD_PRESETS[wizard.fields.value.detailMetricCardPreset]?.length ?? 0,
  chartCards: wizard.fields.value.chartDashboardPreset === 'advanced' ? null : CHART_DASHBOARD_PRESETS[wizard.fields.value.chartDashboardPreset]?.length ?? 0,
}))

function close(): void {
  emit('update:open', false)
}

function closeWithoutApplying(): void {
  wizard.dismiss()
  close()
}

async function handleApply(): Promise<void> {
  if (await wizard.apply())
    close()
}
</script>

<template>
  <AppDialog
    :open="open"
    title="Transit 设置中心"
    description="几步选出一套贴合场景的默认展示，随时可以重新打开。"
    content-class="max-w-2xl"
    icon="tabler:wand"
    @update:open="emit('update:open', $event)"
  >
    <div class="space-y-4">
      <div v-if="wizard.step.value !== 'welcome'" class="flex items-center text-xs">
        <template v-for="(label, index) in STEP_LABELS.slice(1)" :key="label">
          <div class="mx-2 h-px w-6 shrink-0 first:ml-0" :class="index > 0 ? (stepIndex > index ? 'bg-primary/40' : 'bg-border') : 'hidden'" />
          <div class="flex items-center gap-1.5" :class="stepIndex >= index + 1 ? 'text-primary' : 'text-muted-foreground'">
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]"
              :class="stepIndex > index + 1 ? 'border border-primary/50 bg-primary/10' : stepIndex === index + 1 ? 'bg-primary text-primary-foreground' : 'border border-current'"
            >
              <Icon v-if="stepIndex > index + 1" icon="tabler:check" width="11" height="11" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            {{ label }}
          </div>
        </template>
      </div>

      <template v-if="wizard.step.value === 'welcome'">
        <div class="space-y-2 rounded-lg border border-border/60 bg-background/45 p-4 text-sm">
          <p>三步选出适合当前场景的首页展示方式：预设或自定义 → 自动检测环境 → 确认应用。</p>
          <p class="text-xs text-muted-foreground">
            只调整卡片密度、信息量、图表深度和几个默认关闭的功能，不会动到背景、公告、配色等个性化设置。所有 58 项配置仍可在 Komari 后台完整编辑。
          </p>
        </div>
        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" @click="closeWithoutApplying">
            以后再说，不再自动弹出
          </Button>
          <Button size="sm" @click="wizard.goToPreset">
            开始设置
          </Button>
        </div>
      </template>

      <template v-else-if="wizard.step.value === 'preset'">
        <div class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="preset in wizard.presets"
            :key="preset.id"
            type="button"
            class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors"
            :class="wizard.selection.value === preset.id ? 'border-primary bg-primary/5' : 'border-border/60 bg-background/45 hover:bg-background/70'"
            @click="wizard.selectPreset(preset.id)"
          >
            <div class="flex items-center gap-1.5 text-sm font-medium">
              <Icon :icon="preset.icon" width="15" height="15" />
              {{ preset.label }}
            </div>
            <p class="text-xs text-muted-foreground">
              {{ preset.description }}
            </p>
          </button>
          <button
            type="button"
            class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors"
            :class="wizard.selection.value === 'custom' ? 'border-primary bg-primary/5' : 'border-border/60 bg-background/45 hover:bg-background/70'"
            @click="wizard.selectPreset('custom')"
          >
            <div class="flex items-center gap-1.5 text-sm font-medium">
              <Icon icon="tabler:adjustments" width="15" height="15" />
              自定义
            </div>
            <p class="text-xs text-muted-foreground">
              从当前设置开始，逐项调整。
            </p>
          </button>
        </div>

        <div class="rounded-lg border border-border/60 bg-background/45 p-3">
          <p class="mb-2 text-xs font-medium text-muted-foreground">
            预览（示意，非精确还原）
          </p>
          <div class="rounded-md border border-dashed border-border" :class="cardSizeScale[wizard.fields.value.nodeCardSize]">
            <div class="font-medium">
              示例节点 · 东京 01
            </div>
            <div class="mt-1 h-1.5 w-full rounded-full bg-muted">
              <div class="h-full w-2/5 rounded-full bg-emerald-500" />
            </div>
          </div>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>总览卡片 {{ previewCounts.generalCards }} 项</span>
            <span>快捷操作 {{ previewCounts.quickControls }} 项</span>
            <span>详情指标卡 {{ previewCounts.detailMetricCards }} 项</span>
            <span>图表面板 {{ previewCounts.chartCards ?? '自定义模板' }}</span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <span class="rounded-full px-2 py-0.5 text-[10px]" :class="wizard.fields.value.topologyEnabled ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'">网络拓扑</span>
            <span class="rounded-full px-2 py-0.5 text-[10px]" :class="wizard.fields.value.diskPredictionEnabled ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'">磁盘预测</span>
            <span class="rounded-full px-2 py-0.5 text-[10px]" :class="wizard.fields.value.gpuChartEnabled ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'">GPU 图表</span>
            <span class="rounded-full px-2 py-0.5 text-[10px]" :class="wizard.fields.value.opsDashboardEnabled ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'">运维仪表盘</span>
          </div>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" @click="wizard.back">
            返回
          </Button>
          <Button size="sm" @click="wizard.goToAdvancedOrDetect">
            继续
          </Button>
        </div>
      </template>

      <template v-else-if="wizard.step.value === 'advanced'">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="space-y-1 text-xs">
            <span class="block font-medium text-muted-foreground">节点卡片大小</span>
            <select :value="wizard.customFields.value.nodeCardSize" :class="selectClass" @change="wizard.updateCustomField('nodeCardSize', ($event.target as HTMLSelectElement).value as SetupWizardPresetFields['nodeCardSize'])">
              <option value="mini">迷你</option>
              <option value="compact">紧凑</option>
              <option value="comfortable">舒适</option>
              <option value="large">大</option>
            </select>
          </label>
          <label class="space-y-1 text-xs">
            <span class="block font-medium text-muted-foreground">首页总览卡片</span>
            <select :value="wizard.customFields.value.generalCardPreset" :class="selectClass" @change="wizard.updateCustomField('generalCardPreset', ($event.target as HTMLSelectElement).value as SetupWizardPresetFields['generalCardPreset'])">
              <option value="basic">基础</option>
              <option value="ops">运维</option>
              <option value="full">完整</option>
            </select>
          </label>
          <label class="space-y-1 text-xs">
            <span class="block font-medium text-muted-foreground">首页快捷操作</span>
            <select :value="wizard.customFields.value.homeQuickControlPreset" :class="selectClass" @change="wizard.updateCustomField('homeQuickControlPreset', ($event.target as HTMLSelectElement).value as SetupWizardPresetFields['homeQuickControlPreset'])">
              <option value="basic">基础</option>
              <option value="ops">运维</option>
              <option value="full">完整</option>
            </select>
          </label>
          <label class="space-y-1 text-xs">
            <span class="block font-medium text-muted-foreground">节点详情指标卡</span>
            <select :value="wizard.customFields.value.detailMetricCardPreset" :class="selectClass" @change="wizard.updateCustomField('detailMetricCardPreset', ($event.target as HTMLSelectElement).value as SetupWizardPresetFields['detailMetricCardPreset'])">
              <option value="finance">财务</option>
              <option value="status">状态</option>
              <option value="resource">资源</option>
              <option value="full">完整</option>
            </select>
          </label>
          <label class="space-y-1 text-xs">
            <span class="block font-medium text-muted-foreground">节点详情图表</span>
            <select :value="wizard.customFields.value.chartDashboardPreset" :class="selectClass" @change="wizard.updateCustomField('chartDashboardPreset', ($event.target as HTMLSelectElement).value as SetupWizardPresetFields['chartDashboardPreset'])">
              <option value="compact">精简</option>
              <option value="resource">资源</option>
              <option value="all">全部</option>
              <option value="full">完整</option>
            </select>
          </label>
        </div>
        <div class="grid gap-2 sm:grid-cols-2">
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.topologyEnabled" @change="wizard.updateCustomField('topologyEnabled', ($event.target as HTMLInputElement).checked)">
            网络拓扑
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.diskPredictionEnabled" @change="wizard.updateCustomField('diskPredictionEnabled', ($event.target as HTMLInputElement).checked)">
            磁盘空间预测
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.gpuChartEnabled" @change="wizard.updateCustomField('gpuChartEnabled', ($event.target as HTMLInputElement).checked)">
            GPU 图表
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.opsDashboardEnabled" @change="wizard.updateCustomField('opsDashboardEnabled', ($event.target as HTMLInputElement).checked)">
            运维仪表盘
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.nodeListMetadataEnabled" @change="wizard.updateCustomField('nodeListMetadataEnabled', ($event.target as HTMLInputElement).checked)">
            节点列表元数据
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.disablePageAnimation" @change="wizard.updateCustomField('disablePageAnimation', ($event.target as HTMLInputElement).checked)">
            关闭页面动画
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.hideAdminEntryWhenLoggedOut" @change="wizard.updateCustomField('hideAdminEntryWhenLoggedOut', ($event.target as HTMLInputElement).checked)">
            未登录时隐藏管理员入口
          </label>
          <label class="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-background/70">
            <input type="checkbox" :class="checkboxClass" :checked="wizard.customFields.value.hidePriceWhenLoggedOut" @change="wizard.updateCustomField('hidePriceWhenLoggedOut', ($event.target as HTMLInputElement).checked)">
            未登录时隐藏价格
          </label>
        </div>
        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" @click="wizard.back">
            返回
          </Button>
          <Button size="sm" @click="wizard.goToDetect">
            继续
          </Button>
        </div>
      </template>

      <template v-else-if="wizard.step.value === 'detect'">
        <div class="divide-y divide-border/60 rounded-lg border border-border/60 bg-background/45 px-3">
          <div class="flex items-center justify-between gap-3 py-2.5">
            <div class="flex items-center gap-2.5 text-sm">
              <Icon icon="tabler:server-2" width="16" height="16" class="text-muted-foreground" />
              Komari 服务端版本
            </div>
            <span class="text-xs text-muted-foreground">
              <Icon v-if="wizard.detecting.value" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
              <template v-else>{{ wizard.serverVersion.value ? `v${wizard.serverVersion.value.version}` : '未知' }}</template>
            </span>
          </div>
          <div class="flex items-center justify-between gap-3 py-2.5">
            <div class="flex items-center gap-2.5 text-sm">
              <Icon icon="tabler:plug-connected" width="16" height="16" class="text-muted-foreground" />
              实时连接（WebSocket）
            </div>
            <span class="text-xs text-muted-foreground">
              {{ wizard.nodesStore.wsConnectionState === 'connected' ? '已连接' : wizard.nodesStore.wsConnectionState === 'connecting' ? '连接中' : wizard.nodesStore.wsConnectionState === 'reconnecting' ? '重连中' : '未连接（当前使用 HTTP 轮询）' }}
            </span>
          </div>
          <div class="flex items-center justify-between gap-3 py-2.5">
            <div class="flex items-center gap-2.5 text-sm">
              <Icon icon="tabler:route" width="16" height="16" class="text-muted-foreground" />
              回程检测伴生插件
            </div>
            <span class="text-xs text-muted-foreground">
              <Icon v-if="wizard.detecting.value" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
              <template v-else>{{ wizard.companionAvailable.value ? '已安装' : '未安装' }}</template>
            </span>
          </div>
        </div>

        <div v-if="!wizard.detecting.value && wizard.companionAvailable.value" class="rounded-lg border border-border/60 bg-background/45 p-3">
          <label class="flex items-start gap-2 text-xs">
            <input type="checkbox" class="mt-0.5" :class="checkboxClass" :checked="wizard.enableRouteProbe.value" @change="wizard.enableRouteProbe.value = ($event.target as HTMLInputElement).checked">
            <span>
              一并启用三网回程检测
              <span class="block text-[11px] text-muted-foreground">会对其他节点发起主动探测，请确认已获得相应授权；启用后仍需为每台境外节点安装节点助手，可稍后在首页入口重新打开设置向导。</span>
            </span>
          </label>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" @click="wizard.back">
            返回
          </Button>
          <Button size="sm" :disabled="wizard.detecting.value" @click="wizard.goToConfirm">
            继续
          </Button>
        </div>
      </template>

      <template v-else>
        <div class="rounded-lg border border-border/60 bg-background/45 p-3 text-sm">
          共 {{ wizard.diff.value.length }} 项将发生变化，确认后立即写入。
        </div>
        <ul v-if="wizard.diff.value.length" class="max-h-56 space-y-1 overflow-y-auto text-xs">
          <li v-for="entry in wizard.diff.value" :key="entry.key" class="flex flex-wrap items-baseline gap-x-2 rounded-md bg-background/60 px-2 py-1">
            <span class="font-mono">{{ entry.key }}</span>
            <span class="text-muted-foreground">{{ entry.kind === 'added' ? '新增' : entry.kind === 'removed' ? '移除' : '变更' }}</span>
            <span v-if="entry.kind !== 'added'" class="text-muted-foreground line-through">{{ JSON.stringify(entry.before) }}</span>
            <span v-if="entry.kind !== 'removed'" class="font-medium">{{ JSON.stringify(entry.after) }}</span>
          </li>
        </ul>
        <div v-else class="text-xs text-muted-foreground">
          与当前配置完全一致，没有需要写入的差异。
        </div>
        <p v-if="wizard.applyError.value" class="text-xs text-destructive">
          {{ wizard.applyError.value }}
        </p>
        <p class="text-[11px] text-muted-foreground">
          生成于 {{ formatBeijingTime(Date.now()) }}（北京时间）
        </p>
        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" :disabled="wizard.applying.value" @click="wizard.back">
            返回
          </Button>
          <Button size="sm" :disabled="wizard.applying.value" @click="handleApply">
            <Icon v-if="wizard.applying.value" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
            确认应用
          </Button>
        </div>
      </template>
    </div>
  </AppDialog>
</template>
