import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig, TopologyRouteConfig } from '@/utils/topologyHelper'
import { computed, ref, toValue } from 'vue'
import { assertManagedThemeSettingsCurrent, createThemeSettingsSnapshot, withManagedThemeSettingsLock } from '@/services/theme-settings.service'
import { saveTopologyConfiguration } from '@/services/topology.service'
import { useAppStore } from '@/stores/app'
import { normalizeThemeSettings } from '@/utils/themeSettings'
import { readTopologyRoutes } from '@/utils/topologyConfig'
import { adoptTopologyCreatedTaskIds, parseTopologyOwnedPingTaskIds } from '@/utils/topologyCreatedTasks'
import { buildQuickTopologyRoute, findDuplicateTopologyRouteIndex, getQuickTopologySourceNode, hydrateTopologyRouteNodes, listQuickTopologyNodes, resolveTopologyNode, TOPOLOGY_LIMITS, validateTopologyRoutes } from '@/utils/topologyHelper'

function nodeConfig(node?: NodeData, role = '节点'): TopologyNodeConfig {
  return { name: node?.name ?? '', region: node?.region ?? '', role, uuid: node?.uuid }
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
    const settings = normalizeThemeSettings(appStore.publicSettings?.theme_settings)
    routes.value = readTopologyRoutes(appStore.topologyConfig, appStore.topologyRoute, appStore.topologyMetrics)
    hydrateTopologyRouteNodes(routes.value, availableNodes.value)
    savedSnapshot.value = JSON.stringify(routes.value)
    adoptTopologyCreatedTaskIds(parseTopologyOwnedPingTaskIds(settings.topologyOwnedPingTaskIds))
    expectedTopologySettings.value = createThemeSettingsSnapshot(
      settings,
      ['topologyConfig', 'topologyRoute', 'topologyMetrics', 'topologyOwnedPingTaskIds'],
    )
  }

  const dirty = computed(() => JSON.stringify(routes.value) !== savedSnapshot.value)
  const validationErrors = computed(() => {
    const errors = validateTopologyRoutes(routes.value)
    routes.value.forEach((route, routeIndex) => {
      const unresolved = route.nodes.slice(1).filter(node => node.name.trim() && !node.uuid && isAmbiguousNodeName(node.name))
      for (const node of unresolved)
        errors.push(`第 ${routeIndex + 1} 条线路的节点“${node.name}”名称重复，无法唯一绑定`)
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

  function findDuplicateRoute(sourceName: string, landingName = '', sourceUuid = '', landingUuid = ''): number {
    return findDuplicateTopologyRouteIndex(routes.value, sourceName, landingName, sourceUuid, landingUuid)
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
      route.nodes[1]?.uuid ?? '',
      route.nodes[2]?.uuid ?? '',
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
    const selected = resolveTopologyNode(availableNodes.value, nodeName, nodeName)
    if (nodeName.trim() && !selected)
      return
    const previous = route.nodes[index]
    const previousName = previous?.name.trim() ?? ''
    const previousUuid = previous?.uuid?.trim() ?? ''
    const nextName = selected?.name.trim() || nodeName.trim()
    const nextUuid = selected?.uuid?.trim() ?? ''
    const followingMetrics = index === 1
      ? route.metrics.filter(metric => !metric.nodeName.trim() || metric.nodeName.trim() === previousName)
      : []
    route.nodes[index] = nodeConfig(selected, previous?.role || (index === 1 ? '线路机' : index === 2 ? '落地机' : '入口'))
    if (index === 1) {
      for (const metric of followingMetrics) {
        if (metric.nodeName.trim() !== nextName)
          metric.taskFilter = ''
        metric.nodeName = nextName
      }
    }
    else if (index === 2 && route.metrics[1]?.live) {
      route.metrics[1].nodeName = route.nodes[1]?.name.trim() ?? ''
      if (previousName !== nextName || previousUuid !== nextUuid)
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
      onPublicSettings: appStore.applyPublicSettings,
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
        onPublicSettings: appStore.applyPublicSettings,
      })
      expectedTopologySettings.value = {
        topologyRoute: payload.topologyRoute,
        topologyMetrics: payload.topologyMetrics,
        ...(Object.hasOwn(payload, 'topologyOwnedPingTaskIds')
          ? { topologyOwnedPingTaskIds: payload.topologyOwnedPingTaskIds }
          : {}),
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
