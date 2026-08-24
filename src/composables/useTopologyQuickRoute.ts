import type { Ref } from 'vue'
import type { useTopologyRoutePlanner } from '@/composables/useTopologyRoutePlanner'
import type { useTopologyTaskCatalog } from '@/composables/useTopologyTaskCatalog'
import type { createTopologyPersistence } from '@/services/topology-persistence.service'
import type { NodeData } from '@/stores/nodes'
import type { TopologyQuickNode, TopologyRouteConfig } from '@/utils/topologyModel'
import { computed, nextTick, watch } from 'vue'
import { isTopologySegmentKeyForRoute } from '@/composables/useTopologyRoutePlanner'
import { topologyPingTargets } from '@/services/ping-task.service'
import { listUnusedQuickLandingUuids, nextQuickLandingUuid } from '@/utils/topologyHelper'
import { normalizeTopologyProbeTarget, TOPOLOGY_PROBE_OPTIONS } from '@/utils/topologyPresets'

export const DEFAULT_PROBE = TOPOLOGY_PROBE_OPTIONS[0]!.key

/**
 * `manager` 是 reactive() 包过的代理，顶层 ref/computed 会被自动解包，所以这里
 *  用解包后的纯值类型（对齐 topology-persistence.service.ts 里同样场景的写法），
 *  而不是 `ReturnType<typeof useTopologyManager>` ——那样会把这些字段误标成
 *  `Ref<...>`/`ComputedRef<...>`。
 */
interface TopologyQuickRouteManager {
  routes: TopologyRouteConfig[]
  quickNodes: NodeData[]
  quickSourceNode: NodeData | null
  isAmbiguousNodeName: (name: string) => boolean
  findDuplicateRoute: (sourceName: string, landingName?: string, sourceUuid?: string, landingUuid?: string, jumperName?: string, jumperUuid?: string) => number
  addQuickRoute: (
    taskNames?: string[],
    sourceUuid?: string,
    options?: { jumperUuid?: string | null, landingUuid?: string | null, entryTask?: string, hopTask?: string, finalTask?: string, probeKey?: string, entryLabel?: string, entryTarget?: string },
  ) => { route: TopologyRouteConfig, created: boolean } | null
}

export interface TopologyQuickRouteDeps {
  props: { nodes: NodeData[], open: boolean }
  manager: TopologyQuickRouteManager
  catalog: Pick<ReturnType<typeof useTopologyTaskCatalog>, 'loadTasks' | 'rememberTask' | 'taskErrors'>
  planner: Pick<ReturnType<typeof useTopologyRoutePlanner>, 'pendingRouteTasks' | 'planRouteTasks'>
  persistence: Pick<ReturnType<typeof createTopologyPersistence>, 'persistRoutes'>
  /**
   * 这四个 ref 由外层（`useTopologyManagerDialog`）创建并持有，不在这里创建，
   * 因为 `useTopologyTaskCatalog` 的完成回调也要读 `quickConfiguring`，而那个
   * 回调是在本组合式函数之前就构造好的——提前声明才不用互相前向引用。
   */
  quickConfiguring: Ref<boolean>
  quickSourceUuid: Ref<string>
  quickJumperUuid: Ref<string>
  quickLandingUuid: Ref<string>
  quickProbeKey: Ref<string>
  quickEntryLabel: Ref<string>
  quickEntryTarget: Ref<string>
  isCustomProbeValue: (value: string) => boolean
  bumpQuickConfigurationRun: () => number
  getQuickConfigurationRun: () => number
}

/**
 * “快速添加线路”这一整套流程（选线路机/落地机、探测方式换挡、建任务、保存、
 * 保存后聚焦到新行），从 `useTopologyManagerDialog` 拆出来只是为了把那个组合式
 * 函数顶到 600 行的部分挪走——`quickConfigurationRun` 这个跑批序号仍由外层持有
 * 并通过 `bumpQuickConfigurationRun`/`getQuickConfigurationRun` 注入，因为
 * 对话框关闭、`reset()`、以及本流程自身都需要用同一个计数器互相打断在途请求。
 */
export function useTopologyQuickRoute(deps: TopologyQuickRouteDeps) {
  const { props, manager, catalog, planner, persistence, quickConfiguring, quickSourceUuid, quickJumperUuid, quickLandingUuid, quickProbeKey, quickEntryLabel, quickEntryTarget } = deps
  const { loadTasks, taskErrors } = catalog
  const { pendingRouteTasks, planRouteTasks } = planner

  const quickJumperOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value))
  const quickLandingOptions = computed(() => manager.quickNodes.filter(node => node.uuid !== quickSourceUuid.value && node.uuid !== quickJumperUuid.value))
  const quickLandingCandidates = computed(() => quickLandingOptions.value.filter(node => topologyPingTargets(node).length > 0))
  const quickSourceName = computed(() => manager.quickNodes.find(node => node.uuid === quickSourceUuid.value)?.name ?? '')
  const quickTaskError = computed(() => quickSourceUuid.value ? taskErrors.value[quickSourceUuid.value] ?? '' : '')

  function unusedQuickLandingUuids(): string[] {
    return listUnusedQuickLandingUuids(
      manager.routes,
      quickSourceName.value,
      manager.quickNodes,
      quickSourceUuid.value,
    )
  }

  function syncQuickSelections(initialize = false): void {
    const sources = manager.quickNodes
    if (!sources.some(node => node.uuid === quickSourceUuid.value))
      quickSourceUuid.value = sources[0]?.uuid ?? ''
    if (quickJumperUuid.value === quickSourceUuid.value || !sources.some(node => node.uuid === quickJumperUuid.value))
      quickJumperUuid.value = ''
    const pingableLandings = new Set(quickLandingCandidates.value.map(node => node.uuid))
    const landingUuids = sources
      .map(node => node.uuid)
      .filter((uuid): uuid is string => Boolean(uuid) && pingableLandings.has(uuid))
    quickLandingUuid.value = nextQuickLandingUuid(
      quickSourceUuid.value,
      quickLandingUuid.value,
      landingUuids,
      initialize,
      unusedQuickLandingUuids().filter(uuid => pingableLandings.has(uuid)),
    )
  }

  watch(() => manager.quickNodes.map(node => node.uuid).join('|'), () => {
    if (props.open)
      syncQuickSelections()
  })

  function resetQuickProbeKey(): void {
    quickProbeKey.value = DEFAULT_PROBE
  }

  function cancel(): void {
    deps.bumpQuickConfigurationRun()
    quickConfiguring.value = false
  }

  function onQuickSourceChange(): void {
    const landingName = manager.quickNodes.find(node => node.uuid === quickLandingUuid.value)?.name ?? ''
    if (quickLandingUuid.value === quickSourceUuid.value || manager.findDuplicateRoute(quickSourceName.value, landingName, quickSourceUuid.value, quickLandingUuid.value) >= 0)
      quickLandingUuid.value = ''
    if (!quickLandingUuid.value)
      syncQuickSelections()
    if (quickJumperUuid.value === quickSourceUuid.value || quickJumperUuid.value === quickLandingUuid.value)
      quickJumperUuid.value = ''
    if (quickSourceName.value)
      void loadTasks(quickSourceName.value, quickSourceUuid.value)
  }

  function onQuickJumperChange(): void {
    if (quickJumperUuid.value === quickLandingUuid.value)
      quickLandingUuid.value = ''
  }

  function focusTopologyRoute(routeId: number): void {
    const routeElement = document.querySelector<HTMLElement>(`[data-topology-route-id="${routeId}"]`)
    routeElement?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true })
    routeElement?.scrollIntoView({ block: 'nearest' })
  }

  async function addQuickRoute(): Promise<void> {
    if (quickConfiguring.value)
      return
    const source = manager.quickNodes.find(node => node.uuid === quickSourceUuid.value) ?? manager.quickSourceNode
    if (!source?.uuid) {
      window.$message?.error('请先选择一台线路机。')
      return
    }
    const runId = deps.bumpQuickConfigurationRun()
    const selectedSourceUuid = source.uuid
    const selectedJumperUuid = quickJumperUuid.value
    const selectedLandingUuid = quickLandingUuid.value
    const selectedProbeKey = quickProbeKey.value
    const selectedEntryLabel = quickEntryLabel.value.trim()
    const customEntry = deps.isCustomProbeValue(selectedProbeKey)
    const selectedEntryTarget = normalizeTopologyProbeTarget(quickEntryTarget.value)
    if (customEntry && !selectedEntryLabel) {
      window.$message?.error('请输入自定义入口名称。')
      return
    }
    if (customEntry && !selectedEntryTarget) {
      window.$message?.error('请输入有效的自定义入口探测目标（IP 或域名）。')
      return
    }
    if (selectedJumperUuid && !selectedLandingUuid) {
      window.$message?.error('选择跳板后还需要选择落地机。')
      return
    }
    quickConfiguring.value = true
    try {
      const result = await loadTasks(source.name, source.uuid)
      if (runId !== deps.getQuickConfigurationRun() || !props.open)
        return
      if (result.error) {
        window.$message?.error(result.error)
        return
      }
      const latestSource = manager.quickNodes.find(node => node.uuid === selectedSourceUuid)
      const latestJumper = selectedJumperUuid ? manager.quickNodes.find(node => node.uuid === selectedJumperUuid) : undefined
      const latestLanding = selectedLandingUuid ? manager.quickNodes.find(node => node.uuid === selectedLandingUuid) : undefined
      if (!latestSource || (selectedJumperUuid && !latestJumper) || (selectedLandingUuid && !latestLanding)) {
        window.$message?.warning('节点已变化，请重新选择后添加。')
        return
      }
      if (latestSource.online === false || latestJumper?.online === false || latestLanding?.online === false) {
        window.$message?.warning('线路机、跳板或落地机已离线，请上线后再添加。')
        return
      }
      const configured = manager.addQuickRoute(
        result.tasks,
        selectedSourceUuid,
        {
          jumperUuid: selectedJumperUuid || null,
          landingUuid: selectedLandingUuid || null,
          probeKey: customEntry ? undefined : selectedProbeKey,
          entryLabel: customEntry ? selectedEntryLabel : undefined,
          entryTarget: customEntry ? selectedEntryTarget : undefined,
        },
      )
      if (!configured) {
        window.$message?.error('所选节点已变化，请重新选择后添加。')
        return
      }
      await planRouteTasks(configured.route)
      if (runId !== deps.getQuickConfigurationRun() || !props.open)
        return
      if (configured.created) {
        quickJumperUuid.value = ''
        quickLandingUuid.value = ''
        syncQuickSelections()
      }
      const persistResult = await persistence.persistRoutes({
        keepOpen: true,
        runId,
        successMessage: configured.created
          ? (Object.keys(pendingRouteTasks.value).some(key => isTopologySegmentKeyForRoute(key, configured.route.id)) ? '已添加线路并自动创建探测任务。' : '已添加并保存。')
          : '已更新现有线路并保存。',
      })
      if (runId !== deps.getQuickConfigurationRun() || !props.open || persistResult === 'invalid')
        return
      await nextTick()
      setTimeout(() => {
        if (runId === deps.getQuickConfigurationRun() && props.open)
          focusTopologyRoute(configured.route.id)
      })
    }
    catch (error) {
      if (runId === deps.getQuickConfigurationRun() && props.open)
        window.$message?.error(error instanceof Error ? error.message : '添加线路失败。')
    }
    finally {
      if (runId === deps.getQuickConfigurationRun())
        quickConfiguring.value = false
    }
  }

  const selectClass = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring'

  /**
   * 下拉选项的可用性与标注，线路机/落地机共用一套口径。
   *
   * 原则是「不能用的选项要在点下去之前就说清楚」：以前无公网 IP 的落地机可以照常
   * 选中，直到点了「添加线路」才弹一句红字报错，而重名节点早就是预先置灰的。
   */
  function nodeOption(option: TopologyQuickNode, role: 'source' | 'jumper' | 'landing', otherUuid = '', otherName = ''): { disabled: boolean, label: string } {
    const name = option.name
    if (manager.isAmbiguousNodeName(name) && !option.uuid)
      return { disabled: true, label: `${name}（重名，不可用）` }
    // 落地机是被 Ping 的一方，没有可探测地址就建不出任务；线路机只负责发探测，不需要地址。
    if (role !== 'source' && !topologyPingTargets(option).length)
      return { disabled: true, label: `${name}（无公网 IP，不可用）` }
    if (otherUuid && option.uuid === otherUuid)
      return { disabled: true, label: name }
    if (!otherUuid && otherName && name === otherName)
      return { disabled: true, label: name }
    return { disabled: false, label: option.online === false ? `${name}（离线）` : name }
  }

  return {
    quickConfiguring,
    quickSourceUuid,
    quickJumperUuid,
    quickLandingUuid,
    quickProbeKey,
    quickLandingOptions,
    quickJumperOptions,
    quickTaskError,
    selectClass,
    syncQuickSelections,
    resetQuickProbeKey,
    cancel,
    onQuickSourceChange,
    onQuickJumperChange,
    addQuickRoute,
    nodeOption,
  }
}
