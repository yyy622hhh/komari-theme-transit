import type { AdminPingTask, TopologyHopProbe } from '../../src/services/ping-task.model'
import type { NodeData } from '../../src/stores/nodes'
import type { TopologyMetricConfig, TopologyNodeConfig } from '../../src/utils/topologyModel'
import { describe, expect, mock, test } from 'bun:test'
import { useTopologyRoutePlanner } from '../../src/composables/useTopologyRoutePlanner'
import { createTopologyRoute } from '../../src/utils/topologyModel'
import { createCustomTopologyProbe } from '../../src/utils/topologyPresets'

// 这个文件只用真实的 planEntryProbeTask / planWorkingHopTask（不 mock 它们所在的
// 桶模块）：bun 的 mock.module 是整个测试进程共享的，而 topology-probe.service.test.ts
// 已经在同一进程里直接测试这两个函数。mock 掉桶模块会让那边的用例读到假实现。
// 所以这里只覆盖不会真正触达这两个函数的分支——未识别的自定义入口、静态基线、
// 节点解析失败、离线节点——用真实实现走过而不产生网络请求。

const customProbe = createCustomTopologyProbe('自定义入口', '203.0.113.5')!

function adminTask(overrides: Partial<AdminPingTask> = {}): AdminPingTask {
  return { name: 'task', clients: [], type: 'icmp', target: '203.0.113.5', interval: 30, ...overrides }
}

function hopProbe(overrides: Partial<TopologyHopProbe> = {}): TopologyHopProbe {
  return { type: 'icmp', ...overrides }
}

function entryPlan(overrides: Record<string, unknown> = {}) {
  return {
    task: adminTask({ name: 'entry-task' }),
    probe: hopProbe(),
    verdict: 'pending' as const,
    needsCreation: true,
    exhausted: false,
    switchedFrom: null,
    retiredTasks: [] as AdminPingTask[],
    ...overrides,
  }
}

function node(partial: Pick<NodeData, 'uuid' | 'name'> & Partial<NodeData>): NodeData {
  return {
    uuid: partial.uuid,
    name: partial.name,
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 1,
    os: '',
    kernel_version: '',
    region: 'CN',
    public_remark: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    weight: 0,
    price: 0,
    billing_cycle: 0,
    auto_renewal: false,
    currency: '',
    expired_at: null,
    group: '',
    groups: [],
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: '',
    online: true,
    time: '',
    cpu: 0,
    gpu: 0,
    ram: 0,
    swap: 0,
    load: 0,
    load5: 0,
    load15: 0,
    temp: 0,
    disk: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    uptime: 0,
    ...partial,
  }
}

function autoMetric(overrides: Partial<TopologyMetricConfig> = {}): TopologyMetricConfig {
  return { probeMode: 'auto', live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null, ...overrides }
}

function staticMetric(): TopologyMetricConfig {
  return { probeMode: 'static', live: false, nodeName: '', taskFilter: '', fallbackLatency: 10, fallbackLoss: 0 }
}

function topologyNode(partial: Partial<TopologyNodeConfig> & Pick<TopologyNodeConfig, 'name' | 'role'>): TopologyNodeConfig {
  return { region: 'CN', ...partial }
}

function makeCatalog(taskNames: string[] = []) {
  const loadTasks = mock(async (_name: string, _uuid?: string) => ({ tasks: taskNames, error: '' }))
  const rememberTask = mock((_uuid: string, _taskName: string) => {})
  return { loadTasks, rememberTask }
}

const relay = node({ uuid: 'relay', name: 'Relay' })
const landing = node({ uuid: 'landing', name: 'Landing' })

/** 入口名字既不匹配任何内置预设也没有自定义目标，`getTopologyRouteEntryProbe` 会返回 null。 */
function unresolvableEntryRoute(nodeCount: 2 | 3 = 2): ReturnType<typeof createTopologyRoute> {
  const nodes: TopologyNodeConfig[] = [
    topologyNode({ name: '无法识别的入口', role: '入口' }),
    topologyNode({ name: relay.name, role: '线路机', uuid: relay.uuid }),
  ]
  const metrics: TopologyMetricConfig[] = [autoMetric()]
  if (nodeCount === 3) {
    nodes.push(topologyNode({ name: landing.name, role: '落地机', uuid: landing.uuid }))
    metrics.push(autoMetric())
  }
  return createTopologyRoute(nodes, metrics)
}

function customEntryRoute(): ReturnType<typeof createTopologyRoute> {
  return createTopologyRoute(
    [
      topologyNode({ name: '自定义入口', role: '入口', probeTarget: '203.0.113.5' }),
      topologyNode({ name: relay.name, role: '线路机', uuid: relay.uuid }),
    ],
    [autoMetric()],
  )
}

describe('reset', () => {
  test('clears every piece of planner state', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.routeProbeStates.value = { '1:1': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' } }
    planner.pendingRouteTasks.value = { '1:1': { segmentIndex: 1, sourceUuid: 'a', targetUuid: 'b', taskName: 't', probe: hopProbe() } }
    planner.routeTaskPlanning.value = { 1: true }
    planner.routeTaskErrors.value = { 1: 'boom' }

    planner.reset()

    expect(planner.routeProbeStates.value).toEqual({})
    expect(planner.pendingRouteTasks.value).toEqual({})
    expect(planner.routeTaskPlanning.value).toEqual({})
    expect(planner.routeTaskErrors.value).toEqual({})
  })
})

describe('clearPendingRouteTask', () => {
  test('without a segment index removes the bare route key and every segment of that route', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.pendingRouteTasks.value = {
      '1': { segmentIndex: 1, sourceUuid: 'a', targetUuid: 'b', taskName: 't', probe: hopProbe() },
      '1:2': { segmentIndex: 2, sourceUuid: 'b', targetUuid: 'c', taskName: 't2', probe: hopProbe() },
      '10:1': { segmentIndex: 1, sourceUuid: 'x', targetUuid: 'y', taskName: 't3', probe: hopProbe() },
    } as never

    planner.clearPendingRouteTask(1)

    expect(Object.keys(planner.pendingRouteTasks.value)).toEqual(['10:1'])
  })

  test('with a segment index of 1 also removes the legacy bare route key', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.pendingRouteTasks.value = {
      '1': { segmentIndex: 1, sourceUuid: 'a', targetUuid: 'b', taskName: 't', probe: hopProbe() },
      '1:2': { segmentIndex: 2, sourceUuid: 'b', targetUuid: 'c', taskName: 't2', probe: hopProbe() },
    } as never

    planner.clearPendingRouteTask(1, 1)

    expect(Object.keys(planner.pendingRouteTasks.value)).toEqual(['1:2'])
  })
})

describe('clearRouteProbeState', () => {
  test('clears both probe states and retired tasks for every segment of the route', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.routeProbeStates.value = {
      '1:1': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' },
      '1:2': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'y' },
      '2:1': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'z' },
    }
    planner.routeRetiredTasks.value = { '1:1': [{ id: 1, name: 'old' }] }

    planner.clearRouteProbeState(1)

    expect(planner.routeProbeStates.value).toEqual({
      '2:1': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'z' },
    })
    expect(planner.routeRetiredTasks.value).toEqual({})
  })

  test('with a segment index only clears that one segment, leaving the rest of the route intact', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.routeProbeStates.value = {
      '1:1': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' },
      '1:2': { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'y' },
    }

    planner.clearRouteProbeState(1, 2)

    expect(Object.keys(planner.routeProbeStates.value)).toEqual(['1:1'])
  })
})

describe('clearRouteEntryProbeState', () => {
  test('clears both the entry probe state and its retired-task memory for the route', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.routeEntryProbeStates.value = { 1: { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' } }
    planner.routeEntryRetiredTasks.value = { 1: [{ id: 3, name: 'old-entry' }] }

    planner.clearRouteEntryProbeState(1)

    expect(planner.routeEntryProbeStates.value).toEqual({})
    expect(planner.routeEntryRetiredTasks.value).toEqual({})
  })
})

describe('cancelRouteTaskPlanning', () => {
  test('clears every in-flight planning flag and invalidates any run already awaiting a result', async () => {
    const route = unresolvableEntryRoute()
    let releaseLoad: (() => void) | undefined
    const catalog = {
      loadTasks: mock(async () => new Promise<{ tasks: string[], error: string }>((resolve) => {
        releaseLoad = () => resolve({ tasks: [], error: '' })
      })),
      rememberTask: mock(() => {}),
    }
    const planner = useTopologyRoutePlanner([relay], { routes: [route] }, catalog, () => true)

    const run = planner.planRouteTasks(route)
    expect(planner.routeTaskPlanning.value[route.id]).toBe(true)

    planner.cancelRouteTaskPlanning()
    expect(planner.routeTaskPlanning.value).toEqual({})

    releaseLoad!()
    await run

    // 取消之后即便这一轮真的解析完成，也不应该把 planning 标记重新置回去。
    expect(planner.routeTaskPlanning.value).toEqual({})
  })
})

describe('rememberRetiredTasks', () => {
  test('only remembers tasks with an integer id, dropping the key entirely when none qualify', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)

    planner.rememberRetiredTasks(1, [{ name: 'no id' }], 1)
    expect(planner.routeRetiredTasks.value).toEqual({})

    planner.rememberRetiredTasks(1, [{ id: 7, name: 'old-task' }], 1)
    expect(planner.routeRetiredTasks.value).toEqual({ '1:1': [{ id: 7, name: 'old-task' }] })
  })
})

describe('rememberEntryRetiredTasks', () => {
  test('keys retired entry tasks by the bare route id', () => {
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.rememberEntryRetiredTasks(3, [{ id: 9, name: 'old-entry' }])
    expect(planner.routeEntryRetiredTasks.value).toEqual({ 3: [{ id: 9, name: 'old-entry' }] })
  })
})

describe('reservedEntryNames', () => {
  test('excludes only the current route’s own entry name, case- and whitespace-insensitively', () => {
    const route = customEntryRoute()
    route.nodes[0]!.name = 'Relay'
    const planner = useTopologyRoutePlanner([
      node({ uuid: 'a', name: '  Relay ' }),
      node({ uuid: 'b', name: 'Other' }),
    ], { routes: [] }, makeCatalog(), () => true)

    expect(planner.reservedEntryNames(route)).toEqual(['Other'])
  })

  test('returns every node name when no route is given', () => {
    const planner = useTopologyRoutePlanner([
      node({ uuid: 'a', name: 'Relay' }),
      node({ uuid: 'b', name: 'Other' }),
    ], { routes: [] }, makeCatalog(), () => true)

    expect(planner.reservedEntryNames(undefined)).toEqual(['Relay', 'Other'])
  })
})

describe('routeHopTask', () => {
  test('prefers a pending task name over the saved metric filter', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    route.metrics[1]!.taskFilter = 'saved-task'
    planner.pendingRouteTasks.value = {
      [`${route.id}:1`]: { segmentIndex: 1, sourceUuid: relay.uuid, targetUuid: landing.uuid, taskName: 'pending-task', probe: hopProbe() },
    }
    expect(planner.routeHopTask(route, 1)).toBe('pending-task')
  })

  test('falls back to the saved metric filter, then to empty', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    route.metrics[1]!.taskFilter = 'saved-task'
    expect(planner.routeHopTask(route, 1)).toBe('saved-task')
    route.metrics[1]!.taskFilter = ''
    expect(planner.routeHopTask(route, 1)).toBe('')
  })
})

describe('routeHint', () => {
  test('reports the planning hint while a run is in flight, ignoring per-segment state', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    planner.routeTaskPlanning.value = { [route.id]: true }
    expect(planner.routeHint(route)).toBe('正在自动挑选可用的探测方式…')
  })

  test('reports the stored task error over per-segment state', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    planner.routeTaskErrors.value = { [route.id]: '无法按所选节点匹配 Ping 任务。' }
    expect(planner.routeHint(route)).toBe('无法按所选节点匹配 Ping 任务。')
  })

  test('prefixes each segment hint with its endpoint names once there are more than two segments', () => {
    const route = unresolvableEntryRoute(3)
    route.nodes.push(topologyNode({ name: 'Extra', role: '跳板', uuid: 'extra' }))
    route.metrics.push(autoMetric())
    const planner = useTopologyRoutePlanner([relay, landing, node({ uuid: 'extra', name: 'Extra' })], { routes: [] }, makeCatalog(), () => true)
    planner.routeProbeStates.value = {
      [`${route.id}:1`]: { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' },
    }
    const hint = planner.routeHint(route)
    expect(hint).toContain('Relay → Landing：')
  })
})

describe('routeHintTone', () => {
  test('is destructive when there is a stored task error', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    planner.routeTaskErrors.value = { [route.id]: '出错了' }
    expect(planner.routeHintTone(route)).toBe(true)
  })

  test('is destructive when any segment of the route is exhausted', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    planner.routeProbeStates.value = {
      [`${route.id}:1`]: { probe: hopProbe(), verdict: 'dead', exhausted: true, switchedFrom: null, targetAddress: 'x' },
    }
    expect(planner.routeHintTone(route)).toBe(true)
  })

  test('is not destructive otherwise', () => {
    const route = unresolvableEntryRoute(3)
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [] }, makeCatalog(), () => true)
    expect(planner.routeHintTone(route)).toBe(false)
  })
})

describe('routeEntryHint', () => {
  test('reports a static baseline without consulting live probe state', () => {
    const route = customEntryRoute()
    route.metrics[0] = staticMetric()
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    expect(planner.routeEntryHint(route)).toContain('静态基线')
  })

  test('reports a live custom-entry binding', () => {
    const route = customEntryRoute()
    route.metrics[0]!.live = true
    route.metrics[0]!.taskFilter = 'entry-task'
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    expect(planner.routeEntryHint(route)).toBe('入口探测：自定义入口 · 实时')
  })
})

describe('routeEntryHintTone', () => {
  test('is destructive once the entry probe ladder is exhausted, regardless of the hint text', () => {
    const route = customEntryRoute()
    route.metrics[0]!.live = true
    route.metrics[0]!.taskFilter = 'entry-task'
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.routeEntryProbeStates.value = { [route.id]: { probe: hopProbe(), verdict: 'dead', exhausted: true, switchedFrom: null, targetAddress: 'x' } }
    expect(planner.routeEntryHintTone(route)).toBe(true)
  })

  test('is not destructive for a live binding', () => {
    const route = customEntryRoute()
    route.metrics[0]!.live = true
    route.metrics[0]!.taskFilter = 'entry-task'
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    expect(planner.routeEntryHintTone(route)).toBe(false)
  })

  test('is destructive while still waiting for the first binding', () => {
    const route = customEntryRoute()
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    expect(planner.routeEntryHintTone(route)).toBe(true)
  })
})

describe('applyEntryTaskState', () => {
  test('clears pending and probe state when the state is null', () => {
    const route = customEntryRoute()
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.pendingEntryTasks.value = { [route.id]: { sourceUuid: relay.uuid, probeKey: '', taskName: 't', probe: hopProbe(), forceCreate: false } }
    planner.routeEntryProbeStates.value = { [route.id]: { probe: hopProbe(), verdict: 'healthy', exhausted: false, switchedFrom: null, targetAddress: 'x' } }

    planner.applyEntryTaskState(route, relay.uuid, relay.name, null)

    expect(planner.pendingEntryTasks.value[route.id]).toBeUndefined()
    expect(planner.routeEntryProbeStates.value[route.id]).toBeUndefined()
  })

  test('applies a plan that needs creation: updates metric, remembers the task, and queues creation', () => {
    const route = customEntryRoute()
    const catalog = makeCatalog()
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, catalog, () => true)
    const plan = entryPlan({ task: adminTask({ name: 'entry-task' }), needsCreation: true, switchedFrom: hopProbe({ type: 'tcp', port: 443 }) })

    planner.applyEntryTaskState(route, relay.uuid, relay.name, { probeKey: customProbe.key, probe: customProbe, plan: plan as never })

    expect(route.metrics[0]!.live).toBe(true)
    expect(route.metrics[0]!.probeMode).toBe('live')
    expect(route.metrics[0]!.taskFilter).toBe('entry-task')
    expect(catalog.rememberTask).toHaveBeenCalledWith(relay.uuid, 'entry-task')
    expect(planner.pendingEntryTasks.value[route.id]?.forceCreate).toBe(true)
  })

  test('clears any pending entry task once a plan no longer needs creation', () => {
    const route = customEntryRoute()
    const planner = useTopologyRoutePlanner([relay], { routes: [] }, makeCatalog(), () => true)
    planner.pendingEntryTasks.value = { [route.id]: { sourceUuid: relay.uuid, probeKey: '', taskName: 't', probe: hopProbe(), forceCreate: false } }
    const plan = entryPlan({ needsCreation: false })

    planner.applyEntryTaskState(route, relay.uuid, relay.name, { probeKey: customProbe.key, probe: customProbe, plan: plan as never })

    expect(planner.pendingEntryTasks.value[route.id]).toBeUndefined()
  })
})

describe('planRouteTasks', () => {
  test('gives up quietly when the configured relay cannot be resolved among the known nodes', async () => {
    const route = customEntryRoute()
    route.nodes[1]!.name = 'Unknown relay'
    route.nodes[1]!.uuid = undefined
    const catalog = makeCatalog()
    const planner = useTopologyRoutePlanner([relay], { routes: [route] }, catalog, () => true)
    planner.routeTaskPlanning.value = { [route.id]: true }

    await planner.planRouteTasks(route)

    expect(catalog.loadTasks).not.toHaveBeenCalled()
    expect(planner.routeTaskPlanning.value[route.id]).toBeUndefined()
  })

  test('skips planning entirely when every configured segment is pinned to a static baseline', async () => {
    const route = unresolvableEntryRoute(3)
    route.metrics[0] = staticMetric()
    route.metrics[1] = staticMetric()
    const catalog = makeCatalog()
    const planner = useTopologyRoutePlanner([relay, landing], { routes: [route] }, catalog, () => true)

    await planner.planRouteTasks(route)

    expect(catalog.loadTasks).not.toHaveBeenCalled()
  })

  test('leaves the metric untouched when the entry name matches no preset and carries no custom target', async () => {
    const route = unresolvableEntryRoute()
    const catalog = makeCatalog()
    const planner = useTopologyRoutePlanner([relay], { routes: [route] }, catalog, () => true)

    await planner.planRouteTasks(route)

    expect(planner.routeTaskErrors.value[route.id]).toBe('')
    expect(planner.routeTaskPlanning.value[route.id]).toBe(false)
    expect(route.metrics[0]!.live).toBe(false)
    expect(planner.routeEntryProbeStates.value[route.id]).toBeUndefined()
  })

  test('does not attempt entry planning for an offline relay, which also skips the hop that starts from it', async () => {
    const offlineRelay = node({ uuid: relay.uuid, name: relay.name, online: false })
    const route = unresolvableEntryRoute(3)
    const catalog = makeCatalog()
    const planner = useTopologyRoutePlanner([offlineRelay, landing], { routes: [route] }, catalog, () => true)

    await planner.planRouteTasks(route)

    expect(planner.routeEntryProbeStates.value[route.id]).toBeUndefined()
    expect(route.metrics[1]!.live).toBe(false)
    // 中继离线：仍会拉一次任务目录（用于展示），但不会再深入规划。
    expect(catalog.loadTasks).toHaveBeenCalledTimes(1)
  })

  test('surfaces a task-catalog load failure as a route task error', async () => {
    const route = customEntryRoute()
    const catalog = {
      loadTasks: mock(async () => ({ tasks: [], error: '无法连接线路机。' })),
      rememberTask: mock(() => {}),
    }
    const planner = useTopologyRoutePlanner([relay], { routes: [route] }, catalog, () => true)

    await planner.planRouteTasks(route)

    expect(planner.routeTaskErrors.value[route.id]).toBe('无法连接线路机。')
    expect(planner.routeTaskPlanning.value[route.id]).toBe(false)
  })

  test('discards a stale run’s error once a newer run for the same route has already completed', async () => {
    const route = unresolvableEntryRoute()
    let releaseFirstLoad: (() => void) | undefined
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve
    })
    let callCount = 0
    const catalog = {
      loadTasks: mock(async () => {
        callCount += 1
        if (callCount === 1) {
          await firstLoadGate
          return { tasks: [], error: 'stale relay error' }
        }
        return { tasks: [], error: '' }
      }),
      rememberTask: mock(() => {}),
    }
    const planner = useTopologyRoutePlanner([relay], { routes: [route] }, catalog, () => true)

    const firstRun = planner.planRouteTasks(route)
    const secondRun = planner.planRouteTasks(route)
    releaseFirstLoad!()
    await Promise.all([firstRun, secondRun])

    // 第一轮解析出错时已经不是最新一轮了，这个错误不应该覆盖第二轮的成功结果。
    expect(planner.routeTaskErrors.value[route.id]).toBe('')
    expect(planner.routeTaskPlanning.value[route.id]).toBe(false)
  })
})
