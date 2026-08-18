import type { TopologyHopProbe, TopologyPingEndpoint } from '../../src/services/ping-task.service'
import type { HopTaskPlan } from '../../src/services/topology-probe.service'
import type { TopologyRepairDeps, TopologyRepairManagerLike } from '../../src/services/topology-repair.service'
import type { NodeData } from '../../src/stores/nodes'
import type { TopologyRouteConfig } from '../../src/utils/topologyHelper'
import { describe, expect, test } from 'bun:test'
import { canRunTopologyProbeRepair, runTopologyProbeRepair } from '../../src/services/topology-repair.service'

const relay: NodeData = { uuid: 'relay-uuid', name: 'Relay-JP', ipv4: '192.0.2.10' } as NodeData
const landing: NodeData = { uuid: 'exit-uuid', name: 'Exit-SG', ipv4: '203.0.113.20' } as NodeData
const nodes = [relay, landing]

function route(overrides: Partial<{ id: number, sourceName: string, landingName: string, taskFilter: string, nodeName: string, live: boolean }> = {}): TopologyRouteConfig {
  const sourceName = overrides.sourceName ?? relay.name
  const landingName = overrides.landingName ?? landing.name
  return {
    id: overrides.id ?? 1,
    enabled: true,
    nodes: [
      { name: '北京电信', region: 'CN', role: '入口' },
      { name: sourceName, region: '', role: '线路机' },
      { name: landingName, region: '', role: '落地机' },
    ],
    metrics: [
      { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
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
    ...overrides,
  }
}

describe('canRunTopologyProbeRepair', () => {
  const healthy = { disposed: false, managerOpen: false, privateFeaturesAllowed: true, topologyRoute: '北京电信|CN|入口' }

  test('allows when every condition is satisfied', () => {
    expect(canRunTopologyProbeRepair(healthy)).toBe(true)
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
    expect(log.preflightSaveCalls).toBe(1)
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
