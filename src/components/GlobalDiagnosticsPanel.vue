<script setup lang="ts">
import { Icon } from '@iconify/vue/offline'
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { useGlobalDiagnostics } from '@/composables/useGlobalDiagnostics'
import { companionStorageLabel } from '@/services/route-probe-companion.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { WS_STATE_LABELS } from '@/utils/diagnosticReport'
import { formatBeijingTime } from '@/utils/topologyReport'

const appStore = useAppStore()
const nodesStore = useNodesStore()
const {
  serverVersion,
  serverVersionLoading,
  companionHealth,
  companionHealthLoading,
  lastNodeUpdateAt,
  enabledFeatures,
  earthRenderModeState,
  chartsPreloadState,
  refresh,
  copyReport,
} = useGlobalDiagnostics()

const CHARTS_PRELOAD_LABELS: Record<typeof chartsPreloadState.value, string> = {
  idle: '待触发',
  loading: '进行中',
  done: '已完成',
  failed: '失败',
}

const refreshing = computed(() => serverVersionLoading.value || companionHealthLoading.value)
const themeVersion = __BUILD_VERSION__
const themeGitHash = __BUILD_GIT_HASH__
</script>

<template>
  <div class="space-y-4">
    <CardX class="border-none bg-background/50">
      <template #header>
        <div>
          <h2 class="font-semibold">
            全局诊断中心
          </h2>
          <div class="text-xs text-muted-foreground">
            版本、连接与拓扑运行状态一览，报告已脱敏，可直接用于故障排查。
          </div>
        </div>
      </template>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="outline" class="bg-background/60" :disabled="refreshing" @click="refresh">
          <Icon :icon="refreshing ? 'tabler:loader-2' : 'tabler:refresh'" width="14" height="14" :class="refreshing && 'animate-spin'" />
          {{ refreshing ? '刷新中' : '刷新' }}
        </Button>
        <Button size="sm" @click="copyReport">
          <Icon icon="tabler:clipboard-text" width="14" height="14" />
          复制诊断报告
        </Button>
      </div>
    </CardX>

    <div class="grid gap-4 md:grid-cols-2">
      <CardX title="版本" size="small" class="border-none bg-background/50">
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              Transit
            </dt>
            <dd class="font-medium">
              v{{ themeVersion }}（{{ themeGitHash }}）
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              Komari 服务端
            </dt>
            <dd class="font-medium">
              <Icon v-if="serverVersionLoading" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
              <template v-else>
                {{ serverVersion ? `v${serverVersion.version}（${serverVersion.hash}）` : '未知' }}
              </template>
            </dd>
          </div>
        </dl>
      </CardX>

      <CardX title="连接" size="small" class="border-none bg-background/50">
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              配置模式
            </dt>
            <dd class="font-medium">
              {{ appStore.rpcTransportMode === 'websocket' ? 'WebSocket' : 'HTTP' }}
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              当前状态
            </dt>
            <dd class="font-medium">
              <Badge :variant="nodesStore.wsConnectionState === 'connected' ? 'default' : 'outline'">
                {{ WS_STATE_LABELS[nodesStore.wsConnectionState] }}
              </Badge>
              <span v-if="nodesStore.wsReconnectAttempts > 0" class="ml-1 text-xs text-muted-foreground">
                已重连 {{ nodesStore.wsReconnectAttempts }} 次
              </span>
            </dd>
          </div>
        </dl>
      </CardX>

      <CardX title="节点" size="small" class="border-none bg-background/50">
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              数量
            </dt>
            <dd class="font-medium">
              共 {{ nodesStore.totalCount }} 台，在线 {{ nodesStore.onlineCount }} 台
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              最近状态更新
            </dt>
            <dd class="font-medium">
              {{ formatBeijingTime(lastNodeUpdateAt) }}
            </dd>
          </div>
        </dl>
      </CardX>

      <CardX title="拓扑" size="small" class="border-none bg-background/50">
        <dl class="space-y-2 text-sm">
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              总开关 / 自动修复
            </dt>
            <dd class="font-medium">
              {{ appStore.topologyEnabled ? '已启用' : '已关闭' }} / {{ appStore.topologyAutoRepairEnabled ? '已启用' : '已关闭' }}
            </dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              回程采集
            </dt>
            <dd class="font-medium">
              {{ appStore.routeProbeEnabled ? '已启用' : '已关闭' }}
            </dd>
          </div>
          <div v-if="appStore.routeProbeEnabled" class="flex items-center justify-between">
            <dt class="text-muted-foreground">
              回程插件
            </dt>
            <dd class="font-medium">
              <Icon v-if="companionHealthLoading" icon="tabler:loader-2" width="14" height="14" class="animate-spin" />
              <template v-else>
                {{ companionHealth ? (companionHealth.ok ? `正常 · ${companionHealth.version ? `v${companionHealth.version}` : '未知'}` : '异常') : '不可用' }}
                <p v-if="companionHealth" class="mt-1 text-xs" :class="companionHealth.storage && companionHealth.storage.status !== 'healthy' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'">
                  {{ companionStorageLabel(companionHealth.storage) }}
                  <span v-if="companionHealth.storage?.last_success_at"> · 最后保存 {{ formatBeijingTime(companionHealth.storage.last_success_at) }}</span>
                </p>
              </template>
            </dd>
          </div>
        </dl>
      </CardX>
    </div>

    <CardX title="渲染" size="small" class="border-none bg-background/50">
      <dl class="space-y-2 text-sm">
        <div class="flex items-center justify-between">
          <dt class="text-muted-foreground">
            地球
          </dt>
          <dd class="font-medium">
            <template v-if="earthRenderModeState">
              {{ earthRenderModeState.active }}
              <span v-if="earthRenderModeState.reason" class="ml-1 text-xs font-normal text-amber-600 dark:text-amber-400">{{ earthRenderModeState.reason }}</span>
            </template>
            <template v-else>
              未渲染（当前首页布局不显示地球）
            </template>
          </dd>
        </div>
        <div class="flex items-center justify-between">
          <dt class="text-muted-foreground">
            图表预加载
          </dt>
          <dd class="font-medium">
            {{ CHARTS_PRELOAD_LABELS[chartsPreloadState] }}
          </dd>
        </div>
      </dl>
    </CardX>

    <CardX title="已启用功能" size="small" class="border-none bg-background/50">
      <div class="flex flex-wrap gap-1.5">
        <Badge v-for="feature in enabledFeatures" :key="feature.label" :variant="feature.enabled ? 'default' : 'outline'" class="font-normal">
          {{ feature.label }}
        </Badge>
      </div>
    </CardX>
  </div>
</template>
