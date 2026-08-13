import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { computed, ref, toValue } from 'vue'
import { saveTopologyConfiguration } from '@/services/topology.service'
import { useAppStore } from '@/stores/app'
import { createTopologyRoute, parseTopologyRoutes } from '@/utils/topologyHelper'

function defaultMetric(nodeName = '', taskFilter = ''): TopologyMetricConfig {
  return { live: Boolean(nodeName && taskFilter), nodeName, taskFilter, fallbackLatency: null, fallbackLoss: null }
}

function nodeConfig(node?: NodeData, role = '节点'): TopologyNodeConfig {
  return { name: node?.name ?? '', region: node?.region ?? '', role }
}

export function useTopologyManager(nodes: MaybeRefOrGetter<NodeData[]>) {
  const appStore = useAppStore()
  const saving = ref(false)
  const routes = ref<TopologyRouteConfig[]>([])
  const savedSnapshot = ref('')

  const availableNodes = computed(() => toValue(nodes))

  function reset(): void {
    routes.value = parseTopologyRoutes(appStore.topologyRoute, appStore.topologyMetrics)
    savedSnapshot.value = JSON.stringify(routes.value)
  }

  const dirty = computed(() => JSON.stringify(routes.value) !== savedSnapshot.value)
  const validationErrors = computed(() => routes.value.flatMap((route, routeIndex) => {
    const errors: string[] = []
    const names = route.nodes.map(node => node.name.trim()).filter(Boolean)
    if (names.length < 2)
      errors.push(`第 ${routeIndex + 1} 条线路至少需要两个节点`)
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
      errors.push(`第 ${routeIndex + 1} 条线路存在重复节点`)
    route.metrics.slice(0, Math.max(1, route.nodes.length - 1)).forEach((metric, metricIndex) => {
      if (metric.live && (!metric.nodeName.trim() || !metric.taskFilter.trim()))
        errors.push(`第 ${routeIndex + 1} 条线路第 ${metricIndex + 1} 段缺少实时任务来源`)
    })
    return errors
  }))

  function addRoute(): void {
    const first = availableNodes.value[0]
    const second = availableNodes.value[1]
    routes.value.push(createTopologyRoute(
      [nodeConfig(undefined, '入口'), nodeConfig(first, '线路机'), nodeConfig(second, '落地机')],
      [defaultMetric(first?.name ?? ''), defaultMetric(first?.name ?? '')],
    ))
  }

  function removeRoute(index: number): void {
    routes.value.splice(index, 1)
  }

  function moveRoute(index: number, offset: -1 | 1): void {
    const target = index + offset
    if (target < 0 || target >= routes.value.length)
      return
    const [route] = routes.value.splice(index, 1)
    if (route)
      routes.value.splice(target, 0, route)
  }

  function selectNode(route: TopologyRouteConfig, index: number, nodeName: string): void {
    const selected = availableNodes.value.find(node => node.name === nodeName)
    const previous = route.nodes[index]
    route.nodes[index] = nodeConfig(selected, previous?.role || (index === 1 ? '线路机' : index === 2 ? '落地机' : '入口'))
    if (index > 0 && route.metrics[index - 1] && !route.metrics[index - 1]!.nodeName)
      route.metrics[index - 1]!.nodeName = nodeName
  }

  function setMetricMode(metric: TopologyMetricConfig, live: boolean): void {
    metric.live = live
    if (!live) {
      metric.nodeName = ''
      metric.taskFilter = ''
    }
  }

  async function save(): Promise<boolean> {
    if (validationErrors.value.length)
      return false

    const publicSettings = appStore.publicSettings
    if (!publicSettings)
      throw new Error('站点配置尚未加载完成。')

    saving.value = true
    try {
      const payload = await saveTopologyConfiguration({
        theme: publicSettings.theme,
        themeSettings: publicSettings.theme_settings ?? {},
        routes: routes.value,
      })
      appStore.publicSettings = { ...publicSettings, theme_settings: payload }
      savedSnapshot.value = JSON.stringify(routes.value)
      return true
    }
    finally {
      saving.value = false
    }
  }

  return {
    saving,
    routes,
    availableNodes,
    dirty,
    validationErrors,
    reset,
    addRoute,
    removeRoute,
    moveRoute,
    selectNode,
    setMetricMode,
    save,
  }
}
