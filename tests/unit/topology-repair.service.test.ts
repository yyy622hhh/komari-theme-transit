import type { TopologyHopProbe, TopologyPingEndpoint } from '../../src/services/ping-task.service'
import type { EntryProbePlan, HopTaskPlan } from '../../src/services/topology-probe.service'
import type { TopologyRepairDeps, TopologyRepairManagerLike } from '../../src/services/topology-repair.service'
import type { NodeData } from '../../src/stores/nodes'
import type { TopologyRouteConfig } from '../../src/utils/topologyModel'
import { describe, expect, test } from 'bun:test'
import { canRunTopologyProbeRepair, listOwnedRetiredTaskIds, listOwnedUnboundTaskIds, liveTopologyTaskNames, runTopologyProbeRepair } from '../../src/services/topology-repair.service'
import { getTopologyProbe } from '../../src/utils/topologyPresets'

const relay: NodeData = { uuid: 'relay-uuid', name: 'Relay-JP', ipv4: '192.0.2.10' } as NodeData
const landing: NodeData = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20' } as NodeData
const nodes = [relay, landing]
const beijingTelecom = getTopologyProbe('beijing-telecom')

function route(overrides: Partial<{
  id: number
  sourceName: string
  landingName: string
  taskFilter: string
  nodeName: string
  live: boolean
  /**
   * 默认用一个不对应任何预设的自定义入口，避免意外触发入口段自愈——那部分
   * 有自己独立的测试套件（见 `describe('runTopologyProbeRepair entry segment')`）。
   */
  entryLabel: string
  entryTarget: string
  entryLive: boolean
  entryNodeName: string
  entryTaskFilter: string
}> = {}): TopologyRouteConfig {
  const sourceName = overrides.sourceName ?? relay.name
  const landingName = overrides.landingName ?? landing.name
  return {
    id: overrides.id ?? 1,
    enabled: true,
    nodes: [
      {
        name: overrides.entryLabel ?? '自定义入口',
        region: 'CN',
        role: '入口',
        ...(overrides.entryTarget ? { probeTarget: overrides.entryTarget } : {}),
      },
      { name: sourceName, region: '', role: '线路机' },
      { name: landingName, region: '', role: '落地机' },
    ],
    metrics: [
      {
        live: overrides.entryLive ?? false,
        nodeName: overrides.entryNodeName ?? '',
        taskFilter: overrides.entryTaskFilter ?? '',
        fallbackLatency: null,
        fallbackLoss: null,
      },
      {
        live: overrides.live ?? true,
        nodeName: overrides.nodeName ?? sourceName,
        taskFilter: overrides.taskFilter ?? 'Transit-Relay-JP-to-Exit-SG',
        fallbackLatency: null,
        fallbackLoss: null,
      },
    ],
  }
}

function hopPlan(overrides: Partial<HopTaskPlan> = {}): HopTaskPlan {
  return {
    task: { name: 'Transit-Relay-JP-to-Exit-SG', type: 'icmp', target: landing.ipv4!, clients: [relay.uuid], interval: 30, default_on: false },
    probe: { type: 'icmp' },
    verdict: 'healthy',
    needsCreation: false,
    exhausted: false,
    switchedFrom: null,
    targetAddress: landing.ipv4!,
    retiredTasks: [],
    ...overrides,
  }
}

function entryPlan(overrides: Partial<EntryProbePlan> = {}): EntryProbePlan {
  return {
    task: { name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30, default_on: false },
    probe: { type: 'icmp' },
    verdict: 'healthy',
    needsCreation: false,
    exhausted: false,
    switchedFrom: null,
    retiredTasks: [],
    ...overrides,
  }
}

interface ManagerCallLog {
  resetCalls: number
  withSaveLockCalls: number
  preflightSaveCalls: number
  saveCalls: Array<{ lockHeld?: boolean } | undefined>
}

function createManager(
  routes: TopologyRouteConfig[],
  options: { validationErrors?: string[], saveResult?: 'invalid' | 'saved' | 'changed' } = {},
): { manager: TopologyRepairManagerLike, log: ManagerCallLog } {
  const log: ManagerCallLog = { resetCalls: 0, withSaveLockCalls: 0, preflightSaveCalls: 0, saveCalls: [] }
  const initialSnapshot = JSON.stringify(routes)
  const manager: TopologyRepairManagerLike = {
    get routes() { return routes },
    get validationErrors() { return options.validationErrors ?? [] },
    get dirty() { return JSON.stringify(routes) !== initialSnapshot },
    reset: () => { log.resetCalls += 1 },
    withSaveLock: async (save) => {
      log.withSaveLockCalls += 1
      return save()
    },
    preflightSave: async () => { log.preflightSaveCalls += 1 },
    save: async (saveOptions) => {
      log.saveCalls.push(saveOptions)
      return options.saveResult ?? 'saved'
    },
  }
  return { manager, log }
}

function createDeps(overrides: Partial<TopologyRepairDeps> & { manager: TopologyRepairManagerLike }): TopologyRepairDeps {
  return {
    nodes: () => nodes,
    canRepair: () => true,
    requireLoginPermission: async () => true,
    planWorkingHopTask: async () => hopPlan(),
    ensureTopologyPingTask: async () => ({ task: hopPlan().task, created: false }),
    deleteTopologyPingTasks: async () => true,
    planEntryProbeTask: async () => entryPlan(),
    ensureTopologyEntryProbeTask: async () => ({ task: entryPlan().task, created: false }),
    ...overrides,
  }
}

describe('owned retired task selection', () => {
  test('keeps tasks that are still bound or were not created in this session', () => {
    const ids = listOwnedRetiredTaskIds(
      [
        { id: 1, name: 'owned-dead' },
        { id: 2, name: 'still-bound' },
        { id: 3, name: 'someone-else' },
      ],
      new Set([1, 2]),
      new Set(['still-bound']),
    )
    expect(ids).toEqual([1])
  })

  test('lists owned entry tasks that no route still binds', () => {
    expect(listOwnedUnboundTaskIds(
      new Set([7, 8, 9]),
      [
        { id: 7, name: '北京电信' },
        { id: 8, name: 'Transit-Relay-JP-to-Exit-SG' },
      ],
      new Set(['Transit-Relay-JP-to-Exit-SG']),
    )).toEqual([7])
    expect(listOwnedUnboundTaskIds(new Set([4]), [{ id: 5, name: 'other' }], new Set())).toEqual([])
  })

  test('collects live task names from every enabled metric', () => {
    expect([...liveTopologyTaskNames([
      route({ taskFilter: 'alpha' }),
      route({ id: 2, live: false, taskFilter: 'ignored' }),
    ])]).toEqual(['alpha'])
  })
})

describe('canRunTopologyProbeRepair', () => {
  const healthy = { disposed: false, autoRepairEnabled: true, managerOpen: false, privateFeaturesAllowed: true, topologyRoute: '北京电信|CN|入口', pageVisible: true }

  test('allows when every condition is satisfied', () => {
    expect(canRunTopologyProbeRepair(healthy)).toBe(true)
  })

  test('blocks when the site owner disabled unattended auto repair', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, autoRepairEnabled: false })).toBe(false)
  })

  test('blocks when the composable is disposed', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, disposed: true })).toBe(false)
  })

  test('blocks while the topology manager dialog is open', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, managerOpen: true })).toBe(false)
  })

  test('blocks when the visitor is not an authenticated admin', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, privateFeaturesAllowed: false })).toBe(false)
  })

  test('blocks when no topology has been configured yet', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, topologyRoute: '' })).toBe(false)
    expect(canRunTopologyProbeRepair({ ...healthy, topologyRoute: '   ' })).toBe(false)
  })

  test('blocks while the page is hidden in the background', () => {
    expect(canRunTopologyProbeRepair({ ...healthy, pageVisible: false })).toBe(false)
  })
})

describe('runTopologyProbeRepair gating', () => {
  test('does nothing when canRepair is false from the start', async () => {
    const { manager, log } = createManager([route()])
    let permissionChecked = false
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      canRepair: () => false,
      requireLoginPermission: async () => {
        permissionChecked = true
        return true
      },
    }))
    expect(outcome).toBe('skipped')
    expect(permissionChecked).toBe(false)
    expect(log.resetCalls).toBe(0)
    expect(log.withSaveLockCalls).toBe(0)
  })

  test('does not persist when login permission is denied', async () => {
    const { manager, log } = createManager([route()])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      requireLoginPermission: async () => false,
    }))
    expect(outcome).toBe('skipped')
    expect(log.resetCalls).toBe(0)
    expect(log.withSaveLockCalls).toBe(0)
  })

  test('re-checks canRepair after the permission round-trip', async () => {
    const { manager, log } = createManager([route()])
    let calls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      canRepair: () => {
        calls += 1
        return calls === 1
      },
    }))
    expect(outcome).toBe('skipped')
    expect(log.resetCalls).toBe(0)
  })

  test('does not persist when the manager reports validation errors after reset', async () => {
    const { manager, log } = createManager([route()], { validationErrors: ['第 1 条线路存在重复节点'] })
    const outcome = await runTopologyProbeRepair(createDeps({ manager }))
    expect(outcome).toBe('skipped')
    expect(log.resetCalls).toBe(1)
    expect(log.withSaveLockCalls).toBe(0)
  })

  test('is a no-op when the binding is already correct and no task needs creating', async () => {
    const { manager, log } = createManager([route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG' })])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } }),
    }))
    expect(outcome).toBe('no-op')
    expect(log.withSaveLockCalls).toBe(0)
  })

  test('skips a route whose relay or landing node no longer resolves uniquely', async () => {
    const { manager } = createManager([route({ sourceName: 'Unknown-Relay' })])
    let planCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => {
        planCalls += 1
        return hopPlan()
      },
    }))
    expect(outcome).toBe('no-op')
    expect(planCalls).toBe(0)
  })

  test('skips a route whose second segment is not live', async () => {
    const { manager } = createManager([route({ live: false })])
    let planCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => {
        planCalls += 1
        return hopPlan()
      },
    }))
    expect(outcome).toBe('no-op')
    expect(planCalls).toBe(0)
  })
})

describe('runTopologyProbeRepair persistence', () => {
  test('rebinds a stale task name and saves under the lock', async () => {
    const staleRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG-tcp-443' })
    const { manager, log } = createManager([staleRoute])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async (_source, _landing, currentTaskName) => hopPlan({
        needsCreation: false,
        task: { ...hopPlan().task, name: currentTaskName === 'Transit-Relay-JP-to-Exit-SG-tcp-443' ? 'Transit-Relay-JP-to-Exit-SG' : currentTaskName },
      }),
    }))
    expect(outcome).toBe('repaired')
    expect(log.preflightSaveCalls).toBe(2)
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(staleRoute.metrics[1]?.taskFilter).toBe('Transit-Relay-JP-to-Exit-SG')
    expect(staleRoute.metrics[1]?.nodeName).toBe(relay.name)
  })

  test('creates the missing task via ensureTopologyPingTask before binding it', async () => {
    const missingRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG-tcp-80' })
    const { manager } = createManager([missingRoute])
    let ensureCalls = 0
    let ensuredProbe: TopologyHopProbe | undefined
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({
        needsCreation: true,
        probe: { type: 'tcp', port: 443 },
        task: { name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', type: 'tcp', target: `${landing.ipv4}:443`, clients: [relay.uuid], interval: 30 },
      }),
      ensureTopologyPingTask: async (_source, _landing, options) => {
        ensureCalls += 1
        ensuredProbe = options.probe
        return { task: { id: 42, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', type: 'tcp', target: `${landing.ipv4}:443`, clients: [relay.uuid], interval: 30 }, created: true }
      },
    }))
    expect(outcome).toBe('repaired')
    expect(ensureCalls).toBe(1)
    expect(ensuredProbe).toEqual({ type: 'tcp', port: 443 })
    expect(missingRoute.metrics[1]?.taskFilter).toBe('Transit-Relay-JP-to-Exit-SG-tcp-443')
  })

  test('re-plans inside the lock and abandons a route that changed between phases', async () => {
    const changedRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG-tcp-443' })
    const { manager, log } = createManager([changedRoute])
    let planCallCount = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => {
        planCallCount += 1
        // First call (outside the lock) reports a fix is needed; second call
        // (inside the lock, after a hypothetical concurrent edit) reports the
        // binding is already fine — the repair must not clobber it.
        return planCallCount === 1
          ? hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } })
          : hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443' } })
      },
    }))
    expect(planCallCount).toBe(2)
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
    expect(changedRoute.metrics[1]?.taskFilter).toBe('Transit-Relay-JP-to-Exit-SG-tcp-443')
  })

  test('requests a fresh (uncached) plan for the in-lock re-check but not for the initial pass', async () => {
    const staleRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG-tcp-443' })
    const { manager } = createManager([staleRoute])
    const freshFlagsSeen: Array<boolean | undefined> = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async (_source, _landing, _currentTaskName, options) => {
        freshFlagsSeen.push(options?.fresh)
        return hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } })
      },
    }))
    expect(outcome).toBe('repaired')
    // Outside the save lock we can tolerate a cached snapshot; once we hold
    // the lock we must not silently reuse the same snapshot the outer pass
    // already saw, or a concurrent tab's create/delete of a competing task
    // goes unnoticed and the repair binds to (or duplicates) a stale task.
    expect(freshFlagsSeen).toEqual([undefined, true])
  })

  test('aborts mid-repair once canRepair turns false without saving', async () => {
    const staleRoute = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([staleRoute])
    let calls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      // Stays true through the initial gate and the outer plan, then flips
      // false once we are inside withSaveLock — simulating the dialog being
      // opened mid-flight.
      canRepair: () => {
        calls += 1
        return calls <= 3
      },
      planWorkingHopTask: async () => hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } }),
    }))
    expect(outcome).toBe('no-op')
    expect(log.preflightSaveCalls).toBe(0)
    expect(log.saveCalls).toEqual([])
    expect(staleRoute.metrics[1]?.taskFilter).toBe('stale-name')
  })

  test('removes a task created just before the repair is cancelled', async () => {
    const staleRoute = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([staleRoute])
    let available = true
    const deleted: number[][] = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      canRepair: () => available,
      planWorkingHopTask: async () => hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'created-task' } }),
      ensureTopologyPingTask: async () => {
        available = false
        return { task: { ...hopPlan().task, id: 42, name: 'created-task' }, created: true }
      },
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))

    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
    expect(deleted).toEqual([[42]])
  })

  test('removes newly created tasks when the final preflight no longer permits saving', async () => {
    const staleRoute = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([staleRoute])
    manager.preflightSave = async () => {
      log.preflightSaveCalls += 1
      if (log.preflightSaveCalls === 2)
        throw new Error('登录状态已过期，请重新登录后保存。')
    }
    const deleted: number[][] = []
    await expect(runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'created-task' } }),
      ensureTopologyPingTask: async () => ({ task: { ...hopPlan().task, id: 43, name: 'created-task' }, created: true }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))).rejects.toThrow('登录状态已过期')
    expect(log.saveCalls).toEqual([])
    expect(deleted).toEqual([[43]])
  })

  test('removes newly created tasks when saving fails before the expected snapshot changes', async () => {
    const staleRoute = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([staleRoute])
    manager.save = async (options) => {
      log.saveCalls.push(options)
      throw new Error('保存失败（HTTP 500）')
    }
    const deleted: number[][] = []
    await expect(runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'created-task' } }),
      ensureTopologyPingTask: async () => ({ task: { ...hopPlan().task, id: 44, name: 'created-task' }, created: true }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))).rejects.toThrow('保存失败')
    expect(log.preflightSaveCalls).toBe(3)
    expect(deleted).toEqual([[44]])
  })

  test('keeps newly created tasks when a failed save has ambiguous persistence', async () => {
    const staleRoute = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([staleRoute])
    manager.save = async (options) => {
      log.saveCalls.push(options)
      throw new Error('写入后校验失败')
    }
    manager.preflightSave = async () => {
      log.preflightSaveCalls += 1
      if (log.preflightSaveCalls === 3)
        throw new Error('拓扑配置已被其他会话修改')
    }
    const deleted: number[][] = []
    await expect(runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'created-task' } }),
      ensureTopologyPingTask: async () => ({ task: { ...hopPlan().task, id: 45, name: 'created-task' }, created: true }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))).rejects.toThrow('写入后校验失败')
    expect(deleted).toEqual([])
  })

  test('does not save when nothing ends up dirty even though repairs were planned', async () => {
    const staleRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG-tcp-443' })
    const { manager, log } = createManager([staleRoute])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443' } }),
      ensureTopologyPingTask: async () => ({ task: { name: 'Transit-Relay-JP-to-Exit-SG-tcp-443', type: 'tcp', target: `${landing.ipv4}:443`, clients: [relay.uuid], interval: 30 }, created: true }),
    }))
    // planWorkingHopTask reports needsCreation on the outer pass (queues the repair),
    // but the re-plan inside the lock resolves to the same name already bound,
    // so nothing is mutated and dirty stays false.
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
  })

  test('repairs multiple independent routes in one pass', async () => {
    const routeA = route({ id: 1, sourceName: relay.name, landingName: landing.name, taskFilter: 'stale-a' })
    const otherLanding: NodeData = { uuid: 'other-uuid', name: 'Other-Landing', ipv4: '203.0.113.99' } as NodeData
    const routeB = route({ id: 2, sourceName: relay.name, landingName: otherLanding.name, taskFilter: 'stale-b' })
    const { manager, log } = createManager([routeA, routeB])
    const plans: Record<string, TopologyPingEndpoint> = {}
    const outcome = await runTopologyProbeRepair(createDeps({
      nodes: () => [relay, landing, otherLanding],
      manager,
      planWorkingHopTask: async (_source, landingEndpoint) => {
        plans[landingEndpoint.name] = landingEndpoint
        return hopPlan({
          needsCreation: false,
          targetAddress: landingEndpoint.ipv4 ?? '',
          task: { ...hopPlan().task, name: `fixed-${landingEndpoint.name}` },
        })
      },
    }))
    expect(outcome).toBe('repaired')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(routeA.metrics[1]?.taskFilter).toBe('fixed-Exit-SG')
    expect(routeB.metrics[1]?.taskFilter).toBe('fixed-Other-Landing')
  })

  test('an ensure failure on one route does not roll back another route created task', async () => {
    const routeA = route({ id: 1, taskFilter: 'stale-a' })
    const otherLanding: NodeData = { uuid: 'other-uuid', name: 'Other-Landing', ipv4: '203.0.113.99' } as NodeData
    const routeB = route({ id: 2, sourceName: relay.name, landingName: otherLanding.name, taskFilter: 'stale-b' })
    const { manager, log } = createManager([routeA, routeB])
    const deleted: number[][] = []
    let ensureCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      nodes: () => [relay, landing, otherLanding],
      manager,
      planWorkingHopTask: async (_source, landingEndpoint) => hopPlan({
        needsCreation: true,
        targetAddress: landingEndpoint.ipv4 ?? '',
        task: { ...hopPlan().task, name: `fixed-${landingEndpoint.name}` },
      }),
      ensureTopologyPingTask: async (_source, landingEndpoint) => {
        ensureCalls += 1
        if (landingEndpoint.name === otherLanding.name)
          throw new Error('admin:addPingTask 502')
        return { task: { ...hopPlan().task, id: 42, name: `fixed-${landingEndpoint.name}` }, created: true }
      },
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(ensureCalls).toBe(2)
    expect(outcome).toBe('repaired')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(routeA.metrics[1]?.taskFilter).toBe('fixed-Exit-SG')
    expect(routeB.metrics[1]?.taskFilter).toBe('stale-b')
    expect(deleted).toEqual([])
  })

  test('a route that throws while planning does not block the others', async () => {
    const brokenRoute = route({ id: 1, taskFilter: 'stale-broken' })
    const okRoute = route({ id: 2, sourceName: relay.name, landingName: landing.name, taskFilter: 'stale-ok' })
    const { manager, log } = createManager([brokenRoute, okRoute])
    let call = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => {
        call += 1
        if (call === 1)
          throw new Error('落地机地址失效')

        return hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'fixed-ok' } })
      },
    }))
    expect(outcome).toBe('repaired')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(brokenRoute.metrics[1]?.taskFilter).toBe('stale-broken')
    expect(okRoute.metrics[1]?.taskFilter).toBe('fixed-ok')
  })
})

describe('runTopologyProbeRepair resilience', () => {
  test('a stale snapshot during the first preflight resets and skips instead of throwing', async () => {
    const target = route({ taskFilter: 'stale-name' })
    const { manager, log } = createManager([target])
    manager.preflightSave = async () => {
      log.preflightSaveCalls += 1
      throw new Error('拓扑配置已被其他会话修改，请重新打开管理器后再保存。')
    }
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } }),
    }))
    expect(outcome).toBe('no-op')
    expect(log.resetCalls).toBe(2)
    expect(log.saveCalls).toEqual([])
    expect(target.metrics[1]?.taskFilter).toBe('stale-name')
  })

  test('an offline landing is left alone instead of walking the probe ladder', async () => {
    const offlineLanding = { ...landing, online: false } as NodeData
    const target = route({ taskFilter: 'stale-icmp' })
    const { manager, log } = createManager([target])
    let planned = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      nodes: () => [relay, offlineLanding],
      planWorkingHopTask: async () => {
        planned += 1
        return hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443' } })
      },
    }))
    expect(outcome).toBe('no-op')
    expect(planned).toBe(0)
    expect(log.saveCalls).toEqual([])
    expect(target.metrics[1]?.taskFilter).toBe('stale-icmp')
  })

  test('an offline relay is left alone too', async () => {
    const offlineRelay = { ...relay, online: false } as NodeData
    const target = route({ taskFilter: 'stale-icmp' })
    const { manager, log } = createManager([target])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      nodes: () => [offlineRelay, landing],
      planWorkingHopTask: async () => hopPlan({ needsCreation: true }),
    }))
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
    expect(target.metrics[1]?.taskFilter).toBe('stale-icmp')
  })

  test('deletes a session-created retired task after the new binding is saved', async () => {
    const target = route({ taskFilter: 'stale-icmp' })
    const { manager } = createManager([target])
    const sessionCreatedTaskIds = new Set<number>([7])
    const deleted: number[][] = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds,
      planWorkingHopTask: async () => hopPlan({
        needsCreation: true,
        task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443' },
        retiredTasks: [{ id: 7, name: 'stale-icmp', type: 'icmp', target: landing.ipv4!, clients: [relay.uuid], interval: 30 }],
      }),
      ensureTopologyPingTask: async () => ({
        task: { ...hopPlan().task, id: 8, name: 'Transit-Relay-JP-to-Exit-SG-tcp-443' },
        created: true,
      }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(outcome).toBe('repaired')
    expect(sessionCreatedTaskIds.has(8)).toBe(true)
    expect(sessionCreatedTaskIds.has(7)).toBe(false)
    expect(deleted).toEqual([[7]])
  })

  test('does not delete a retired task that this session did not create', async () => {
    const target = route({ taskFilter: 'stale-icmp' })
    const { manager } = createManager([target])
    const deleted: number[][] = []
    await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds: new Set<number>(),
      planWorkingHopTask: async () => hopPlan({
        needsCreation: false,
        task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' },
        retiredTasks: [{ id: 7, name: 'stale-icmp', type: 'icmp', target: landing.ipv4!, clients: [relay.uuid], interval: 30 }],
      }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(deleted).toEqual([])
  })

  test('does not retire tasks when a failed save is rolled back', async () => {
    const target = route({ taskFilter: 'stale-name' })
    const { manager } = createManager([target])
    manager.save = async () => {
      throw new Error('保存失败（HTTP 500）')
    }
    const sessionCreatedTaskIds = new Set<number>([7])
    const deleted: number[][] = []
    await expect(runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds,
      planWorkingHopTask: async () => hopPlan({
        needsCreation: true,
        task: { ...hopPlan().task, name: 'created-task' },
        retiredTasks: [{ id: 7, name: 'stale-name', type: 'icmp', target: landing.ipv4!, clients: [relay.uuid], interval: 30 }],
      }),
      ensureTopologyPingTask: async () => ({ task: { ...hopPlan().task, id: 44, name: 'created-task' }, created: true }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))).rejects.toThrow('保存失败')
    expect(deleted).toEqual([[44]])
    expect(sessionCreatedTaskIds.has(7)).toBe(true)
  })

  test('a re-plan that throws inside the lock does not roll back other routes tasks', async () => {
    const routeA = route({ id: 1, taskFilter: 'stale-a' })
    const routeB = route({ id: 2, taskFilter: 'stale-b' })
    const { manager, log } = createManager([routeA, routeB])
    const deleted: number[][] = []
    let planCall = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async (_source, _landing, _taskFilter, options) => {
        planCall += 1
        // 锁外那遍两条都成功；锁内重新规划时 B 撞上瞬时故障。
        if (options?.fresh && planCall > 3)
          throw new Error('admin:getAllPingTasks 502')
        return hopPlan({ needsCreation: true, task: { ...hopPlan().task, name: `fixed-${planCall}` } })
      },
      ensureTopologyPingTask: async () => ({ task: { ...hopPlan().task, id: 42, name: 'fixed-a' }, created: true }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(outcome).toBe('repaired')
    // 关键断言：为 A 创建的任务 42 必须保留，不能因为 B 失败而被回滚。
    expect(deleted).toEqual([])
    expect(routeA.metrics[1]?.taskFilter).toBe('fixed-a')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
  })
})

describe('runTopologyProbeRepair entry segment', () => {
  test('does not plan an entry repair for a custom entry that matches no preset', async () => {
    const staleRoute = route({ taskFilter: 'Transit-Relay-JP-to-Exit-SG' })
    const { manager, log } = createManager([staleRoute])
    let entryPlanCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planEntryProbeTask: async () => {
        entryPlanCalls += 1
        return entryPlan()
      },
    }))
    expect(outcome).toBe('no-op')
    expect(entryPlanCalls).toBe(0)
    expect(log.saveCalls).toEqual([])
  })

  test('passes the previous binding when repairing a custom target change', async () => {
    const staleRoute = route({
      entryLabel: '湖北电信',
      entryTarget: 'new.example.com',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: 'Transit-entry-custom-old',
    })
    const { manager } = createManager([staleRoute])
    const currentTaskNames: Array<string | undefined> = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planEntryProbeTask: async (_source, probe, options) => {
        expect(probe.landmarkAddress).toBe('new.example.com')
        currentTaskNames.push(options?.currentTaskName)
        return entryPlan({
          needsCreation: true,
          task: { name: probe.taskFilter, type: 'icmp', target: 'new.example.com', clients: [relay.uuid], interval: 30 },
        })
      },
    }))
    expect(outcome).toBe('repaired')
    expect(currentTaskNames).toEqual(['Transit-entry-custom-old', 'Transit-entry-custom-old'])
  })

  test('rewrites a bound community taskFilter to the matched display-label task name', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '广州电信',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: '广东电信',
    })
    const { manager, log } = createManager([staleRoute])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planEntryProbeTask: async () => entryPlan({
        needsCreation: false,
        task: { name: '广州电信', type: 'icmp', target: getTopologyProbe('guangzhou-telecom').landmarkAddress, clients: [relay.uuid], interval: 30, default_on: false },
      }),
    }))
    expect(outcome).toBe('repaired')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, nodeName: relay.name, taskFilter: '广州电信' })
  })

  test('creates a missing entry task for a preset label and saves it', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
    })
    const { manager, log } = createManager([staleRoute])
    let ensureCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planEntryProbeTask: async () => entryPlan({ needsCreation: true }),
      ensureTopologyEntryProbeTask: async (_source, _probe, options) => {
        ensureCalls += 1
        expect(options?.hopProbe).toEqual({ type: 'icmp' })
        return { task: { id: 55, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }, created: true }
      },
    }))
    expect(outcome).toBe('repaired')
    expect(ensureCalls).toBe(1)
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, nodeName: relay.name, taskFilter: '北京电信' })
  })

  test('persists an exact custom task name when repairing exhausted legacy duplicates', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京联通家宽',
      entryTarget: '111.197.38.247',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: 'Transit-entry-custom-15yv9lt',
    })
    const exactName = 'Transit-entry-custom-15yv9lt-tcp-22'
    const oldTasks = [
      { id: 47, name: 'Transit-entry-custom-15yv9lt', type: 'tcp', target: '111.197.38.247:443', clients: [relay.uuid], interval: 30 },
      { id: 50, name: 'Transit-entry-custom-15yv9lt', type: 'tcp', target: '111.197.38.247:22', clients: [relay.uuid], interval: 30 },
    ]
    const { manager, log } = createManager([staleRoute])
    const deleted: number[][] = []
    let ensureCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds: new Set(),
      planEntryProbeTask: async () => entryPlan({
        task: { name: exactName, type: 'tcp', target: '111.197.38.247:22', clients: [relay.uuid], interval: 30 },
        probe: { type: 'tcp', port: 22 },
        verdict: 'pending',
        needsCreation: true,
        exhausted: false,
        switchedFrom: null,
        retiredTasks: oldTasks,
      }),
      ensureTopologyEntryProbeTask: async (_source, _probe, options) => {
        ensureCalls += 1
        expect(options).toMatchObject({ hopProbe: { type: 'tcp', port: 22 }, taskName: exactName })
        return { task: { id: 51, name: exactName, type: 'tcp', target: '111.197.38.247:22', clients: [relay.uuid], interval: 30 }, created: true }
      },
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(outcome).toBe('repaired')
    expect(ensureCalls).toBe(1)
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, nodeName: relay.name, taskFilter: exactName })
    // 两个旧任务都不是本会话创建的，迁移只改绑定，不按名称误删用户任务。
    expect(deleted).toEqual([])
  })

  test('escalates a dead entry task the current session created, creating the replacement before cleaning up the old one', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: '北京电信',
    })
    const { manager, log } = createManager([staleRoute])
    const deleted: number[][] = []
    let createCalls = 0
    let ensureCalls = 0
    const oldTask = { id: 55, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds: new Set([55]),
      planEntryProbeTask: async () => entryPlan({
        needsCreation: true,
        probe: { type: 'tcp', port: 443 },
        switchedFrom: { type: 'icmp' },
        retiredTasks: [oldTask],
      }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
      ensureTopologyEntryProbeTask: async () => {
        ensureCalls += 1
        throw new Error('a ladder switch must force-create, not find-and-reuse the dead task by name')
      },
      createTopologyEntryProbeTask: async (_source, _probe, hopProbe) => {
        createCalls += 1
        expect(hopProbe).toEqual({ type: 'tcp', port: 443 })
        return { id: 56, name: '北京电信', type: 'tcp', target: `${beijingTelecom.landmarkAddress}:443`, clients: [relay.uuid], interval: 30 }
      },
    }))
    // 换挡前后 metrics[0] 的 nodeName/taskFilter 都是「北京电信」不变——探测方式
    // 本来就不写进持久化的 topologyMetrics，只是背后指向的 Ping 任务从 ICMP 换
    // 成了 TCP 443——所以 `manager.dirty` 判不出变化，不需要保存，复用了和第 2
    // 段一样的既有约定（见 `else if (!deps.manager.dirty)` 分支的注释）：只创建
    // /清理了 Ping 任务、没有触发保存的修复，`outcome` 仍报告为 'no-op'。真正的
    // 修复效果由下面对 createCalls/deleted/metrics 的断言验证。
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
    expect(ensureCalls).toBe(0)
    expect(createCalls).toBe(1)
    // 新任务先建成功，旧任务的清理是后一步、独立于创建结果。
    expect(deleted).toEqual([[55]])
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, taskFilter: '北京电信' })
  })

  test('does not clean up a duplicate entry task that was not created by this session', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: '北京电信',
    })
    const { manager } = createManager([staleRoute])
    const deleted: number[][] = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds: new Set(),
      planEntryProbeTask: async () => entryPlan({
        needsCreation: false,
        retiredTasks: [{ id: 55, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }],
      }),
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(outcome).toBe('no-op')
    expect(deleted).toEqual([])
  })

  test('creating the replacement does not depend on the old task being cleaned up first, even if cleanup keeps failing', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: '北京电信',
    })
    const { manager } = createManager([staleRoute])
    let createCalls = 0
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      sessionCreatedTaskIds: new Set([55]),
      planEntryProbeTask: async () => entryPlan({
        needsCreation: true,
        probe: { type: 'tcp', port: 443 },
        switchedFrom: { type: 'icmp' },
        retiredTasks: [{ id: 55, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }],
      }),
      // 旧任务删除持续失败——不该让新任务因此创建不了。
      deleteTopologyPingTasks: async () => false,
      createTopologyEntryProbeTask: async () => {
        createCalls += 1
        return { id: 56, name: '北京电信', type: 'tcp', target: `${beijingTelecom.landmarkAddress}:443`, clients: [relay.uuid], interval: 30 }
      },
    }))
    expect(outcome).toBe('no-op')
    expect(createCalls).toBe(1)
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, taskFilter: '北京电信' })
  })

  test('does not attempt anything once the entry ladder is exhausted', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
      entryLive: true,
      entryNodeName: relay.name,
      entryTaskFilter: '北京电信',
    })
    const { manager, log } = createManager([staleRoute])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planEntryProbeTask: async () => entryPlan({ verdict: 'dead', exhausted: true }),
    }))
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
  })

  test('repairs the entry and hop segments together in one save', async () => {
    const staleRoute = route({
      taskFilter: 'stale-hop',
      entryLabel: '北京电信',
    })
    const { manager, log } = createManager([staleRoute])
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      planWorkingHopTask: async () => hopPlan({ needsCreation: false, task: { ...hopPlan().task, name: 'Transit-Relay-JP-to-Exit-SG' } }),
      planEntryProbeTask: async () => entryPlan({ needsCreation: true }),
      ensureTopologyEntryProbeTask: async () => ({ task: { id: 60, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }, created: true }),
    }))
    expect(outcome).toBe('repaired')
    expect(log.saveCalls).toEqual([{ lockHeld: true }])
    expect(staleRoute.metrics[0]).toMatchObject({ live: true, taskFilter: '北京电信' })
    expect(staleRoute.metrics[1]).toMatchObject({ taskFilter: 'Transit-Relay-JP-to-Exit-SG' })
  })

  test('removes a newly created entry task if the save is cancelled mid-flight', async () => {
    const staleRoute = route({
      taskFilter: 'Transit-Relay-JP-to-Exit-SG',
      entryLabel: '北京电信',
    })
    const { manager, log } = createManager([staleRoute])
    let available = true
    const deleted: number[][] = []
    const outcome = await runTopologyProbeRepair(createDeps({
      manager,
      canRepair: () => available,
      planEntryProbeTask: async () => entryPlan({ needsCreation: true }),
      ensureTopologyEntryProbeTask: async () => {
        // 模拟创建完成的同一时刻对话框被打开——下一次 canContinue() 检查就会
        // 发现自愈已经不再被允许运行。
        available = false
        return { task: { id: 61, name: '北京电信', type: 'icmp', target: beijingTelecom.landmarkAddress, clients: [relay.uuid], interval: 30 }, created: true }
      },
      deleteTopologyPingTasks: async (ids) => {
        deleted.push([...ids])
        return true
      },
    }))
    expect(outcome).toBe('no-op')
    expect(log.saveCalls).toEqual([])
    expect(deleted).toEqual([[61]])
  })
})
