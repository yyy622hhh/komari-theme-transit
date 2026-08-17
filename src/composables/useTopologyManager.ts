import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { computed, ref, toValue } from 'vue'
import { createThemeSettingsSnapshot } from '@/services/theme-settings.service'
import { saveTopologyConfiguration } from '@/services/topology.service'
import { useAppStore } from '@/stores/app'
import { buildQuickTopologyRoute, createTopologyRoute, findUniqueTopologyNode, getQuickTopologySourceNode, getTopologyProbe, parseTopologyRoutes, TOPOLOGY_LIMITS, validateTopologyRoutes } from '@/utils/topologyHelper'

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
  const expectedTopologySettings = ref<Record<string, unknown>>({})

  const availableNodes = computed(() => toValue(nodes))
  const duplicateNodeNames = computed(() => {
    const counts = new Map<string, number>()
    for (const node of availableNodes.value) {
      const name = node.name.trim().toLowerCase()
      if (name)
        counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
  })

  function reset(): void {
    routes.value = parseTopologyRoutes(appStore.topologyRoute, appStore.topologyMetrics)
    savedSnapshot.value = JSON.stringify(routes.value)
    const serverSettings = appStore.publicSettings?.theme_settings
    expectedTopologySettings.value = createThemeSettingsSnapshot(serverSettings ?? {}, ['topologyRoute', 'topologyMetrics'])
  }

  const dirty = computed(() => JSON.stringify(routes.value) !== savedSnapshot.value)
  const validationErrors = computed(() => {
    const errors = validateTopologyRoutes(routes.value)
    routes.value.forEach((route, routeIndex) => {
      const ambiguousNames = new Set([
        ...route.nodes.slice(1).map(node => node.name),
        ...route.metrics.filter(metric => metric.live).map(metric => metric.nodeName),
      ].map(name => name.trim()).filter(name => isAmbiguousNodeName(name)))
      for (const name of ambiguousNames)
        errors.push(`第 ${routeIndex + 1} 条线路的节点“${name}”名称重复，无法唯一绑定`)
    })
    return errors
  })
  const canAddRoute = computed(() => routes.value.length < TOPOLOGY_LIMITS.maxRoutes)
  const quickSourceNode = computed(() => getQuickTopologySourceNode(availableNodes.value))
  const quickConfigurationAvailable = computed(() => canAddRoute.value && Boolean(quickSourceNode.value))

  function isAmbiguousNodeName(name: string): boolean {
    return duplicateNodeNames.value.has(name.trim().toLowerCase())
  }

  function addRoute(): void {
    if (!canAddRoute.value)
      return
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

  function addQuickRoute(taskNames: string[] = [], sourceUuid = ''): TopologyRouteConfig | null {
    if (!canAddRoute.value)
      return null
    const route = buildQuickTopologyRoute(availableNodes.value, taskNames, sourceUuid)
    if (!route)
      return null
    routes.value.push(route)
    return route
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
    if (nodeName && isAmbiguousNodeName(nodeName))
      return
    const selected = findUniqueTopologyNode(availableNodes.value, nodeName)
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
    if (nodeName && isAmbiguousNodeName(nodeName))
      return
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

  async function save(): Promise<'invalid' | 'saved' | 'changed'> {
    if (validationErrors.value.length)
      return 'invalid'

    const publicSettings = appStore.publicSettings
    if (!publicSettings)
      throw new Error('站点配置尚未加载完成。')

    const submittedSnapshot = JSON.stringify(routes.value)
    const submittedRoutes = JSON.parse(submittedSnapshot) as TopologyRouteConfig[]
    saving.value = true
    try {
      const payload = await saveTopologyConfiguration({
        theme: publicSettings.theme,
        routes: submittedRoutes,
        expected: expectedTopologySettings.value,
      })
      const latestPublicSettings = appStore.publicSettings
      if (latestPublicSettings?.theme === publicSettings.theme)
        appStore.publicSettings = { ...latestPublicSettings, theme_settings: payload }
      expectedTopologySettings.value = {
        topologyRoute: payload.topologyRoute,
        topologyMetrics: payload.topologyMetrics,
      }
      savedSnapshot.value = submittedSnapshot
      return JSON.stringify(routes.value) === submittedSnapshot ? 'saved' : 'changed'
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
    canAddRoute,
    quickSourceNode,
    quickConfigurationAvailable,
    isAmbiguousNodeName,
    reset,
    addRoute,
    addQuickRoute,
    removeRoute,
    moveRoute,
    selectNode,
    selectMetricSource,
    setMetricMode,
    save,
  }
}
