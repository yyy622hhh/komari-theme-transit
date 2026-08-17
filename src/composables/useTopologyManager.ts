import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { computed, ref, toValue } from 'vue'
import { assertManagedThemeSettingsCurrent, createThemeSettingsSnapshot, withManagedThemeSettingsLock } from '@/services/theme-settings.service'
import { saveTopologyConfiguration } from '@/services/topology.service'
import { useAppStore } from '@/stores/app'
import { buildQuickTopologyRoute, findDuplicateTopologyRouteIndex, findUniqueTopologyNode, getQuickTopologySourceNode, listQuickTopologyNodes, parseTopologyRoutes, TOPOLOGY_LIMITS, validateTopologyRoutes } from '@/utils/topologyHelper'

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
  const quickNodes = computed(() => listQuickTopologyNodes(availableNodes.value).filter(node => node.uuid))
  const quickConfigurationAvailable = computed(() => quickNodes.value.length > 0)

  function isAmbiguousNodeName(name: string): boolean {
    return duplicateNodeNames.value.has(name.trim().toLowerCase())
  }

  function findDuplicateRoute(sourceName: string, landingName = ''): number {
    return findDuplicateTopologyRouteIndex(routes.value, sourceName, landingName)
  }

  function addQuickRoute(
    taskNames: string[] = [],
    sourceUuid = '',
    options: { landingUuid?: string | null, entryTask?: string, hopTask?: string, probeKey?: string } = {},
  ): { route: TopologyRouteConfig, created: boolean } | null {
    const route = buildQuickTopologyRoute(availableNodes.value, {
      sourceTasks: taskNames,
      sourceUuid,
      landingUuid: options.landingUuid,
      entryTask: options.entryTask,
      hopTask: options.hopTask,
      probeKey: options.probeKey,
    })
    if (!route)
      return null
    const duplicateIndex = findDuplicateTopologyRouteIndex(
      routes.value,
      route.nodes[1]?.name ?? '',
      route.nodes[2]?.name ?? '',
    )
    if (duplicateIndex >= 0) {
      const existing = routes.value[duplicateIndex]
      if (!existing)
        return null
      const replacement = { ...route, id: existing.id }
      routes.value.splice(duplicateIndex, 1, replacement)
      return { route: replacement, created: false }
    }
    if (!canAddRoute.value)
      return null
    routes.value.push(route)
    return { route, created: true }
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
    else if (index === 2 && route.metrics[1]?.live) {
      route.metrics[1].nodeName = route.nodes[1]?.name.trim() ?? ''
      if (previousName !== nextName)
        route.metrics[1].taskFilter = ''
    }
  }

  function setMetricMode(metric: TopologyMetricConfig, live: boolean): void {
    metric.live = live
    if (!live) {
      metric.nodeName = ''
      metric.taskFilter = ''
    }
  }

  async function preflightSave(): Promise<void> {
    const publicSettings = appStore.publicSettings
    if (!publicSettings)
      throw new Error('站点配置尚未加载完成。')
    await assertManagedThemeSettingsCurrent({
      theme: publicSettings.theme,
      expected: expectedTopologySettings.value,
      permission: 'nodeTopology',
    })
  }

  async function withSaveLock<T>(save: () => Promise<T>): Promise<T> {
    const theme = appStore.publicSettings?.theme
    if (!theme)
      throw new Error('站点配置尚未加载完成。')
    return withManagedThemeSettingsLock(theme, save)
  }

  async function save(options: { lockHeld?: boolean } = {}): Promise<'invalid' | 'saved' | 'changed'> {
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
        lockHeld: options.lockHeld,
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
    quickNodes,
    quickConfigurationAvailable,
    isAmbiguousNodeName,
    findDuplicateRoute,
    reset,
    addQuickRoute,
    removeRoute,
    moveRoute,
    selectNode,
    setMetricMode,
    preflightSave,
    withSaveLock,
    save,
  }
}
