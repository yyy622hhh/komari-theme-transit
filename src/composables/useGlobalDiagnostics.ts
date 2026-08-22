import type { CompanionHealth } from '@/services/route-probe-companion.service'
import type { VersionInfo } from '@/utils/api'
import { computed, onMounted, ref } from 'vue'
import { getCompanionRouteProbeHealth } from '@/services/route-probe-companion.service'
import { loadServerVersion } from '@/services/version.service'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { buildDiagnosticReport } from '@/utils/diagnosticReport'
import { message } from '@/utils/message'
import { readTopologyWriteLog } from '@/utils/topologyWriteLog'

/**
 * 全局诊断中心的数据抓取与报告生成。版本、伴生插件健康检查都是即时快照，
 * 挂载时抓一次，提供 refresh() 手动重抓——不做后台轮询，诊断页本来就是
 * “出问题时点进来看一眼”，不需要常驻定时器。
 */
export function useGlobalDiagnostics() {
  const appStore = useAppStore()
  const nodesStore = useNodesStore()

  const serverVersion = ref<VersionInfo | null>(null)
  const serverVersionLoading = ref(false)
  const companionHealth = ref<CompanionHealth | null>(null)
  const companionHealthLoading = ref(false)

  async function refresh(): Promise<void> {
    serverVersionLoading.value = true
    serverVersion.value = await loadServerVersion()
    serverVersionLoading.value = false

    if (!appStore.routeProbeEnabled) {
      companionHealth.value = null
      return
    }
    companionHealthLoading.value = true
    companionHealth.value = await getCompanionRouteProbeHealth().catch(() => null)
    companionHealthLoading.value = false
  }

  onMounted(refresh)

  const lastNodeUpdateAt = computed<number | null>(() => {
    const timestamps = nodesStore.nodes
      .map(node => node.status_updated_at ? new Date(node.status_updated_at).getTime() : Number.NaN)
      .filter(Number.isFinite)
    return timestamps.length > 0 ? Math.max(...timestamps) : null
  })

  const enabledFeatures = computed(() => [
    { label: '网络拓扑', enabled: appStore.topologyEnabled },
    { label: '拓扑自动修复', enabled: appStore.topologyAutoRepairEnabled },
    { label: '回程线路采集', enabled: appStore.routeProbeEnabled },
    { label: '首页快捷操作', enabled: appStore.homeQuickControlsEnabled },
    { label: '磁盘空间预测', enabled: appStore.diskPredictionEnabled },
    { label: '访客审计采集', enabled: appStore.visitorAuditClientEnabled },
    { label: '运维仪表盘', enabled: appStore.opsDashboardEnabled },
    { label: 'GPU 图表', enabled: appStore.gpuChartEnabled },
  ])

  function buildReport(): string {
    return buildDiagnosticReport({
      themeVersion: __BUILD_VERSION__,
      gitHash: __BUILD_GIT_HASH__,
      generatedAt: Date.now(),
      serverVersion: serverVersion.value,
      rpcTransportMode: appStore.rpcTransportMode,
      wsConnectionState: nodesStore.wsConnectionState,
      wsReconnectAttempts: nodesStore.wsReconnectAttempts,
      nodeTotal: nodesStore.totalCount,
      nodeOnline: nodesStore.onlineCount,
      lastNodeUpdateAt: lastNodeUpdateAt.value,
      enabledFeatures: enabledFeatures.value,
      topologyEnabled: appStore.topologyEnabled,
      topologyAutoRepairEnabled: appStore.topologyAutoRepairEnabled,
      routeProbeEnabled: appStore.routeProbeEnabled,
      lastTopologyWrite: readTopologyWriteLog()[0] ?? null,
      companionHealth: companionHealth.value,
    })
  }

  async function copyReport(): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(buildReport())
      message.success('诊断报告已复制')
    }
    catch (error) {
      console.error('Failed to copy diagnostic report', error)
      message.error('复制失败，请检查浏览器剪贴板权限')
    }
  }

  return {
    serverVersion,
    serverVersionLoading,
    companionHealth,
    companionHealthLoading,
    lastNodeUpdateAt,
    enabledFeatures,
    refresh,
    copyReport,
  }
}
