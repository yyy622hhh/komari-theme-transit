import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { computed, ref, toValue } from 'vue'
import { saveTopologyConfiguration } from '@/services/topology.service'
import { useAppStore } from '@/stores/app'
import { createTopologyRoute, getTopologyProbe, parseTopologyRoutes, validateTopologyRoutes } from '@/utils/topologyHelper'

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
  const validationErrors = computed(() => validateTopologyRoutes(routes.value))

  function addRoute(): void {
    const first = availableNodes.value[0]
    const second = availableNodes.value[1]
    const defaultProbe = getTopologyProbe('')
    routes.value.push(createTopologyRoute(
      [
        { name: defaultProbe.label, region: 'CN', role: '入口' },
        nodeConfig(first, '线路机'),
        nodeConfig(second, '落地机'),
      ],
      [defaultMetric(first?.name ?? '', defaultProbe.taskFilter), defaultMetric(first?.name ?? '')],
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
    const previousName = previous?.name.trim() ?? ''
    const nextName = nodeName.trim()
    const followingMetrics = index === 1
      ? route.metrics.filter(metric => !metric.nodeName.trim() || metric.nodeName.trim() === previousName)
      : []
    route.nodes[index] = nodeConfig(selected, previous?.role || (index === 1 ? '线路机' : index === 2 ? '落地机' : '入口'))
    if (index === 1) {
      for (const metric of followingMetrics) {
        if (metric.nodeName.trim() !== nextName)
          metric.taskFilter = ''
        metric.nodeName = nodeName
      }
    }
    else if (index > 0 && route.metrics[index - 1] && !route.metrics[index - 1]!.nodeName.trim()) {
      if (route.metrics[index - 1]!.nodeName.trim() !== nextName)
        route.metrics[index - 1]!.taskFilter = ''
      route.metrics[index - 1]!.nodeName = nodeName
    }
  }

  function selectMetricSource(metric: TopologyMetricConfig, nodeName: string): void {
    if (metric.nodeName === nodeName)
      return
    metric.nodeName = nodeName
    metric.taskFilter = ''
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
    selectMetricSource,
    setMetricMode,
    save,
  }
}
