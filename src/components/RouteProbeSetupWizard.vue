<script setup lang="ts">
import type { NodeData } from '@/stores/nodes'
import { Icon } from '@iconify/vue'
import { computed, ref, watch } from 'vue'
import { AppDialog } from '@/components/ui/app-dialog'
import { Button } from '@/components/ui/button'
import { useRouteProbeSetupWizard } from '@/composables/useRouteProbeSetupWizard'
import { formatDateTime } from '@/utils/helper'

const props = defineProps<{ nodes: NodeData[], open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const wizard = useRouteProbeSetupWizard(() => props.nodes)
const copiedCommand = ref(false)
const copiedTokenUuid = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let copiedTokenTimer: ReturnType<typeof setTimeout> | undefined

// 父组件用 v-if 控制这个对话框的挂载/卸载，所以打开时 props.open 从挂载起就是
// true——非 immediate 的 watch 不会在初值上触发，必须显式 immediate 才能在打开
// 时真正跑一次环境检查。
watch(() => props.open, (open) => {
  if (!open)
    return
  wizard.reset()
  void wizard.runCheck()
}, { immediate: true })

/** 步骤条只有两个真实画面，但设计稿按三段展示——第 3 段只在确认页才点亮。 */
const stepperStage = computed(() => wizard.step.value === 'confirm' ? 3 : 1)

const pluginDescription = computed(() => {
  if (wizard.pluginInstalled.value === true)
    return '固定能力任务中继正常'
  if (wizard.pluginInstalled.value === false)
    return '尚未连接，请先安装并启用插件'
  return '检查失败，请重试'
})

function close(): void {
  emit('update:open', false)
}

async function copyInstallCommand(): Promise<void> {
  if (!navigator.clipboard?.writeText)
    return
  await navigator.clipboard.writeText(wizard.installCommand.value)
  copiedCommand.value = true
  if (copiedTimer)
    clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copiedCommand.value = false
  }, 2000)
}

/**
 * 命令本身不带 token——运行到 `helper.sh` 的交互式提示时，把这里复制的 token
 * 粘贴进去即可，token 就不会连同命令一起进 shell 历史或在 `ps` 里露出来。
 */
async function copyToken(uuid: string): Promise<void> {
  const token = wizard.tokenFor(uuid)
  if (!token || !navigator.clipboard?.writeText)
    return
  await navigator.clipboard.writeText(token)
  copiedTokenUuid.value = uuid
  if (copiedTokenTimer)
    clearTimeout(copiedTokenTimer)
  copiedTokenTimer = setTimeout(() => {
    copiedTokenUuid.value = ''
  }, 2000)
}

async function handleEnable(): Promise<void> {
  if (await wizard.enable())
    close()
}
</script>

<template>
  <AppDialog
    :open="open"
    title="三网回程检测"
    description="完成环境检查后即可安全启用，无需进入主题设置。"
    content-class="max-w-2xl"
    icon="tabler:route"
    @update:open="emit('update:open', $event)"
  >
    <div class="space-y-4">
      <div class="flex items-center text-xs">
        <div class="flex items-center gap-1.5" :class="stepperStage >= 1 ? 'text-primary' : 'text-muted-foreground'">
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]"
            :class="stepperStage > 1 ? 'border border-primary/50 bg-primary/10' : 'bg-primary text-primary-foreground'"
          >
            <Icon v-if="stepperStage > 1" icon="tabler:check" width="11" height="11" />
            <template v-else>1</template>
          </span>
          环境检查
        </div>
        <div class="mx-2 h-px w-8 shrink-0" :class="stepperStage > 1 ? 'bg-primary/40' : 'bg-border'" />
        <div class="flex items-center gap-1.5" :class="stepperStage >= 2 ? 'text-primary' : 'text-muted-foreground'">
          <span class="flex size-5 shrink-0 items-center justify-center rounded-full border border-current text-[10px]">2</span>
          安装节点助手
        </div>
        <div class="mx-2 h-px w-8 shrink-0" :class="stepperStage > 2 ? 'bg-primary/40' : 'bg-border'" />
        <div class="flex items-center gap-1.5" :class="stepperStage >= 3 ? 'text-primary' : 'text-muted-foreground'">
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]"
            :class="stepperStage === 3 ? 'bg-primary text-primary-foreground' : 'border border-current'"
          >
            3
          </span>
          启用检测
        </div>
      </div>

      <template v-if="wizard.step.value === 'check'">
        <div class="divide-y divide-border/60 rounded-lg border border-border/60 bg-background/45 px-3">
          <div class="flex items-start justify-between gap-3 py-2.5">
            <div class="flex min-w-0 items-start gap-2.5">
              <Icon
                :icon="wizard.pluginInstalled.value === true ? 'tabler:circle-check' : 'tabler:alert-triangle'"
                :class="wizard.pluginInstalled.value === true ? 'text-emerald-500' : 'text-amber-500'"
                class="mt-0.5 shrink-0"
                width="16"
                height="16"
              />
              <div class="min-w-0">
                <p class="text-sm">
                  伴生插件
                </p>
                <p class="text-xs text-muted-foreground">
                  {{ wizard.checking.value ? '检查中…' : pluginDescription }}
                </p>
              </div>
            </div>
            <span class="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
              <template v-if="wizard.pluginInstalled.value === true">已安装{{ wizard.pluginVersion.value ? ` · v${wizard.pluginVersion.value}` : '' }}</template>
              <template v-else-if="wizard.pluginInstalled.value === false">未安装</template>
              <template v-else>未知</template>
            </span>
          </div>

          <div
            v-if="wizard.pluginInstalled.value && !wizard.checking.value && !wizard.checkError.value"
            class="flex items-start justify-between gap-3 py-2.5"
          >
            <div class="flex min-w-0 items-start gap-2.5">
              <Icon
                :icon="wizard.missingHelperNodes.value.length ? 'tabler:alert-triangle' : 'tabler:circle-check'"
                :class="wizard.missingHelperNodes.value.length ? 'text-amber-500' : 'text-emerald-500'"
                class="mt-0.5 shrink-0"
                width="16"
                height="16"
              />
              <div class="min-w-0">
                <p class="text-sm">
                  节点助手
                </p>
                <p class="text-xs text-muted-foreground">
                  境外节点已连接并可执行固定探测
                </p>
              </div>
            </div>
            <span class="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
              {{ wizard.onlineHelperCount.value }} 台在线
            </span>
          </div>

          <div
            v-if="wizard.pluginInstalled.value && !wizard.checking.value && wizard.onlineHelperNodes.value.length"
            class="py-2.5"
          >
            <div class="mb-2 flex items-center justify-between gap-2">
              <p class="text-sm">
                助手运行状态
              </p>
              <span
                v-if="wizard.mismatchedHelperNodes.value.length || wizard.legacyHelperNodes.value.length"
                class="text-[10px] text-amber-700 dark:text-amber-300"
              >
                版本提示不阻止探测
              </span>
            </div>
            <div class="space-y-1.5">
              <div
                v-for="node in wizard.onlineHelperNodes.value"
                :key="node.uuid"
                class="grid gap-1 rounded-md bg-muted/25 px-2 py-1.5 text-[11px] sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div class="min-w-0">
                  <p class="truncate text-foreground/85">
                    {{ node.name }}
                    <span
                      class="ml-1"
                      :class="node.helperVersionMatches === false || node.helperVersionMatches === null ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'"
                    >
                      {{ node.helperVersion ? `v${node.helperVersion}` : '旧版助手' }}
                    </span>
                  </p>
                  <p v-if="node.lastError" class="truncate text-destructive">
                    最近错误：{{ node.lastError }}
                  </p>
                  <p v-else class="truncate text-muted-foreground">
                    最后成功：{{ node.lastSuccessAt ? formatDateTime(new Date(node.lastSuccessAt)) : '暂无记录' }}
                  </p>
                </div>
                <p class="self-center tabular-nums text-muted-foreground">
                  {{ node.lastDurationMs === null ? '耗时 —' : `耗时 ${node.lastDurationMs} ms` }}
                </p>
              </div>
            </div>
          </div>

          <div v-if="wizard.mainlandCount.value" class="flex items-start justify-between gap-3 py-2.5">
            <div class="flex min-w-0 items-start gap-2.5">
              <Icon icon="tabler:info-circle" class="mt-0.5 shrink-0 text-muted-foreground" width="16" height="16" />
              <div class="min-w-0">
                <p class="text-sm">
                  中国大陆节点
                </p>
                <p class="text-xs text-muted-foreground">
                  境内节点不参与回程检测，也不计入失败
                </p>
              </div>
            </div>
            <span class="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
              {{ wizard.mainlandCount.value }} 台已自动排除
            </span>
          </div>
        </div>

        <p v-if="wizard.checkError.value" class="text-xs text-destructive">
          {{ wizard.checkError.value }}
        </p>

        <div v-if="wizard.pluginInstalled.value === false" class="rounded-lg border border-amber-500/20 bg-amber-500/8 p-3 text-xs text-amber-700 dark:text-amber-400">
          请先在 Komari「插件」页面安装并启用 Transit Route Probe 伴生插件，再回来重新打开本向导。
        </div>

        <div v-else-if="wizard.missingHelperNodes.value.length" class="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/8 p-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-xs text-amber-700 dark:text-amber-400">
              还有 {{ wizard.missingHelperNodes.value.length }} 台境外节点未安装助手
            </p>
            <Button
              variant="outline"
              size="xs"
              class="border-amber-500/30 bg-background/60 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
              @click="copyInstallCommand"
            >
              <Icon :icon="copiedCommand ? 'tabler:check' : 'tabler:copy'" width="12" height="12" />
              复制安装命令
            </Button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="node in wizard.missingHelperNodes.value"
              :key="node.uuid"
              type="button"
              class="flex items-center gap-1 rounded-full border border-amber-500/30 bg-background/60 px-2 py-0.5 text-xs transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!wizard.tokenFor(node.uuid)"
              :title="wizard.tokenFor(node.uuid) ? '点击复制该节点的 Agent token' : '未取得该节点的 Agent token'"
              @click="copyToken(node.uuid)"
            >
              <Icon :icon="copiedTokenUuid === node.uuid ? 'tabler:check' : 'tabler:key'" width="12" height="12" />
              {{ node.name }}
            </button>
          </div>
          <p class="text-[10px] text-muted-foreground">
            命令不含 token；在节点上执行后会提示输入 Agent token，届时点击对应节点名称复制粘贴即可。
          </p>
        </div>

        <div class="space-y-1 text-[11px] text-muted-foreground">
          <p>关闭向导不会执行任何探测。</p>
          <p class="flex items-center gap-1">
            <Icon icon="tabler:shield-check" width="12" height="12" />
            助手不开放端口，不接受任意命令。
          </p>
        </div>

        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" @click="close">
            稍后设置
          </Button>
          <Button size="sm" :disabled="!wizard.canEnable.value || wizard.checking.value" @click="wizard.goToConfirm()">
            继续安装
          </Button>
        </div>
      </template>

      <template v-else>
        <div class="space-y-2 rounded-lg border border-border/60 bg-background/45 p-3 text-sm">
          <p>
            {{ wizard.onlineHelperCount.value }} 台境外节点助手在线，启用后主题会在管理员打开首页约 20 秒时开始检测。
          </p>
          <p v-if="wizard.missingHelperNodes.value.length" class="text-xs text-muted-foreground">
            还有 {{ wizard.missingHelperNodes.value.length }} 台尚未安装助手的节点会先跳过，安装完成后下次自动检测会补上。
          </p>
        </div>

        <p v-if="wizard.saveError.value" class="text-xs text-destructive">
          {{ wizard.saveError.value }}
        </p>

        <div class="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" :disabled="wizard.saving.value" @click="wizard.goToCheck()">
            返回
          </Button>
          <Button size="sm" :disabled="wizard.saving.value" @click="handleEnable">
            <Icon v-if="wizard.saving.value" icon="tabler:loader-2" class="animate-spin" width="14" height="14" />
            启用并开始首次检测
          </Button>
        </div>
      </template>
    </div>
  </AppDialog>
</template>
