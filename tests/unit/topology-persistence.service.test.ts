import type { TopologyPendingRouteTask } from '../../src/composables/useTopologyRoutePlanner'
import type { NodeData } from '../../src/stores/nodes'
import type { TopologyRouteConfig } from '../../src/utils/topologyModel'
import { beforeEach, describe, expect, test } from 'bun:test'
import { computed, ref } from 'vue'
import { createTopologyPersistence } from '../../src/services/topology-persistence.service'
import { clearTopologyWriteLog, readTopologyWriteLog } from '../../src/utils/topologyWriteLog'

function createHarness(options: { blockingErrors?: string[], pendingValidation?: boolean } = {}) {
  const notifications: Array<{ kind: string, text: string }> = []
  let saveCalls = 0
  const persistence = createTopologyPersistence({
    props: { nodes: [], open: true },
    manager: {
      routes: [],
      quickNodes: [],
      preflightSave: async () => {},
      save: async () => {
        saveCalls += 1
        return 'saved'
      },
      withSaveLock: async save => save(),
    },
    taskValidationPending: computed(() => options.pendingValidation ?? false),
    persistBlockingErrors: computed(() => options.blockingErrors ?? []),
    pendingRouteTasks: ref({}),
    pendingEntryTasks: ref({}),
    routeRetiredTasks: ref({}),
    routeEntryRetiredTasks: ref({}),
    routeTaskErrors: ref({}),
    sessionCreatedTaskIds: new Set(),
    findEndpoint: () => undefined,
    rememberTask: () => {},
    clearPendingRouteTask: () => {},
    clearPendingEntryTask: () => {},
    clearRouteTaskError: () => {},
    hasPendingWork: () => false,
    getDialogSession: () => 1,
    getQuickConfigurationRun: () => 1,
    onOpenChange: () => {},
    refreshWriteLog: () => {},
    message: {
      success: text => notifications.push({ kind: 'success', text }),
      error: text => notifications.push({ kind: 'error', text }),
      warning: text => notifications.push({ kind: 'warning', text }),
      info: text => notifications.push({ kind: 'info', text }),
    },
  })
  return { notifications, persistence, saveCalls: () => saveCalls }
}

/** 写入流水存在 localStorage 里；测试环境没有，装一个内存实现才能观察到。 */
function installLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size
      },
    },
  })
}

describe('topology persistence orchestration', () => {
  beforeEach(() => {
    installLocalStorage()
    clearTopologyWriteLog()
  })

  test('does nothing when neither the draft nor task bindings changed', async () => {
    const harness = createHarness()
    expect(await harness.persistence.persistRoutes()).toBe('cancelled')
    expect(harness.saveCalls()).toBe(0)
    expect(harness.notifications).toEqual([])
  })

  test('reports a completed quick run even when another save already persisted its work', async () => {
    const harness = createHarness()
    expect(await harness.persistence.persistRoutes({ runId: 1, successMessage: '已保存' })).toBe('saved')
    expect(harness.notifications).toEqual([{ kind: 'success', text: '已保存' }])
    expect(harness.saveCalls()).toBe(0)
  })

  test('blocks manual saves while task validation is pending or the draft is invalid', async () => {
    const validating = createHarness({ pendingValidation: true })
    expect(await validating.persistence.persistRoutes()).toBe('invalid')
    expect(validating.notifications[0]).toEqual({ kind: 'warning', text: '正在验证 Ping 任务，请稍后再保存。' })

    const invalid = createHarness({ blockingErrors: ['missing node'] })
    expect(await invalid.persistence.persistRoutes()).toBe('invalid')
    expect(invalid.notifications[0]).toEqual({ kind: 'error', text: '请先修正无效的线路配置。' })
  })

  test('rolls back tasks created earlier in the batch when a later route task fails', async () => {
    const endpoints = new Map([
      ['source-a', { uuid: 'source-a', name: 'Source A', ipv4: '192.0.2.10' }],
      ['landing-a', { uuid: 'landing-a', name: 'Landing A', ipv4: '192.0.2.20' }],
      ['source-b', { uuid: 'source-b', name: 'Source B', ipv4: '192.0.2.30' }],
      ['landing-b', { uuid: 'landing-b', name: 'Landing B', ipv4: '192.0.2.40' }],
    ])
    const route = (id: number, sourceUuid: string, sourceName: string, landingUuid: string, landingName: string, taskName: string): TopologyRouteConfig => ({
      id,
      enabled: true,
      nodes: [
        { name: '北京电信', region: 'CN', role: 'entry' },
        { name: sourceName, uuid: sourceUuid, region: 'JP', role: 'source' },
        { name: landingName, uuid: landingUuid, region: 'US', role: 'landing' },
      ],
      metrics: [
        { live: false, nodeName: sourceName, taskFilter: '北京电信', fallbackLatency: null, fallbackLoss: null },
        { live: true, nodeName: sourceName, taskFilter: taskName, fallbackLatency: null, fallbackLoss: null },
      ],
    })
    const routes = [
      route(1, 'source-a', 'Source A', 'landing-a', 'Landing A', 'Source A → Landing A'),
      route(2, 'source-b', 'Source B', 'landing-b', 'Landing B', 'Source B → Landing B'),
    ]
    const pendingRouteTasks = ref<Record<number, TopologyPendingRouteTask>>({
      1: { sourceUuid: 'source-a', targetUuid: 'landing-a', taskName: 'Source A → Landing A', probe: { type: 'icmp' } },
      2: { sourceUuid: 'source-b', targetUuid: 'landing-b', taskName: 'Source B → Landing B', probe: { type: 'icmp' } },
    })
    const deletedTaskIds: number[][] = []
    let saveCalls = 0
    const persistence = createTopologyPersistence({
      props: { nodes: [...endpoints.values()] as NodeData[], open: true },
      manager: {
        routes,
        quickNodes: [],
        preflightSave: async () => {},
        save: async () => {
          saveCalls += 1
          return 'saved'
        },
        withSaveLock: async save => save(),
      },
      taskValidationPending: computed(() => false),
      persistBlockingErrors: computed(() => []),
      pendingRouteTasks,
      pendingEntryTasks: ref({}),
      routeRetiredTasks: ref({}),
      routeEntryRetiredTasks: ref({}),
      routeTaskErrors: ref({}),
      sessionCreatedTaskIds: new Set(),
      findEndpoint: uuid => endpoints.get(uuid),
      rememberTask: () => {},
      clearPendingRouteTask: routeId => delete pendingRouteTasks.value[routeId],
      clearPendingEntryTask: () => {},
      clearRouteTaskError: () => {},
      hasPendingWork: () => true,
      getDialogSession: () => 1,
      getQuickConfigurationRun: () => 1,
      onOpenChange: () => {},
      refreshWriteLog: () => {},
      message: undefined,
      operations: {
        ensureRouteTask: async (_source, target) => {
          if (target.uuid === 'landing-b')
            throw new Error('creation failed')
          return {
            task: { id: 101, name: 'Source A → Landing A', clients: ['source-a'], type: 'icmp', target: '192.0.2.20', interval: 60 },
            created: true,
          }
        },
        deleteTasks: async (ids) => {
          deletedTaskIds.push([...ids])
          return true
        },
      },
    })

    expect(await persistence.persistRoutes()).toBe('invalid')
    expect(deletedTaskIds).toEqual([[101]])
    expect(saveCalls).toBe(0)
    expect(Object.keys(pendingRouteTasks.value).sort()).toEqual(['1', '2'])

    // 回滚必须留下痕迹：只记「创建成功」而不记「已删除」，事后看流水会得出与
    // 现实相反的结论——那正是这份流水存在要避免的事。
    const log = readTopologyWriteLog()
    expect(log[0]).toMatchObject({
      trigger: 'manual',
      action: '回滚本轮新建的探测任务（1 个）',
      outcome: 'ok',
      detail: '同一批中有线路创建失败',
    })
    expect(log[1]).toMatchObject({ action: '创建第 2 段探测任务 Source A → Landing A', outcome: 'ok' })
  })

  test('records a failed rollback so an undeleted task is not silently forgotten', async () => {
    const endpoints = new Map([
      ['source-a', { uuid: 'source-a', name: 'Source A', ipv4: '192.0.2.10' }],
      ['landing-a', { uuid: 'landing-a', name: 'Landing A', ipv4: '192.0.2.20' }],
      ['source-b', { uuid: 'source-b', name: 'Source B', ipv4: '192.0.2.30' }],
      ['landing-b', { uuid: 'landing-b', name: 'Landing B', ipv4: '192.0.2.40' }],
    ])
    const makeRoute = (id: number, sourceUuid: string, sourceName: string, landingUuid: string, landingName: string, taskName: string): TopologyRouteConfig => ({
      id,
      enabled: true,
      nodes: [
        { name: '北京电信', region: 'CN', role: 'entry' },
        { name: sourceName, uuid: sourceUuid, region: 'JP', role: 'source' },
        { name: landingName, uuid: landingUuid, region: 'US', role: 'landing' },
      ],
      metrics: [
        { live: false, nodeName: sourceName, taskFilter: '北京电信', fallbackLatency: null, fallbackLoss: null },
        { live: true, nodeName: sourceName, taskFilter: taskName, fallbackLatency: null, fallbackLoss: null },
      ],
    })
    const routes = [
      makeRoute(1, 'source-a', 'Source A', 'landing-a', 'Landing A', 'Source A → Landing A'),
      makeRoute(2, 'source-b', 'Source B', 'landing-b', 'Landing B', 'Source B → Landing B'),
    ]
    const pendingRouteTasks = ref<Record<number, TopologyPendingRouteTask>>({
      1: { sourceUuid: 'source-a', targetUuid: 'landing-a', taskName: 'Source A → Landing A', probe: { type: 'icmp' } },
      2: { sourceUuid: 'source-b', targetUuid: 'landing-b', taskName: 'Source B → Landing B', probe: { type: 'icmp' } },
    })
    const sessionCreatedTaskIds = new Set<number>()
    const persistence = createTopologyPersistence({
      props: { nodes: [...endpoints.values()] as NodeData[], open: true },
      manager: {
        routes,
        quickNodes: [],
        preflightSave: async () => {},
        save: async () => 'saved',
        withSaveLock: async save => save(),
      },
      taskValidationPending: computed(() => false),
      persistBlockingErrors: computed(() => []),
      pendingRouteTasks,
      pendingEntryTasks: ref({}),
      routeRetiredTasks: ref({}),
      routeEntryRetiredTasks: ref({}),
      routeTaskErrors: ref({}),
      sessionCreatedTaskIds,
      findEndpoint: uuid => endpoints.get(uuid),
      rememberTask: () => {},
      clearPendingRouteTask: routeId => delete pendingRouteTasks.value[routeId],
      clearPendingEntryTask: () => {},
      clearRouteTaskError: () => {},
      hasPendingWork: () => true,
      getDialogSession: () => 1,
      getQuickConfigurationRun: () => 1,
      onOpenChange: () => {},
      refreshWriteLog: () => {},
      message: undefined,
      operations: {
        ensureRouteTask: async (_source, target) => {
          if (target.uuid === 'landing-b')
            throw new Error('creation failed')
          return {
            task: { id: 202, name: 'Source A → Landing A', clients: ['source-a'], type: 'icmp', target: '192.0.2.20', interval: 60 },
            created: true,
          }
        },
        // 删除请求失败：任务还在后端，所有权必须保留，否则以后没人敢再碰它。
        deleteTasks: async () => false,
      },
    })

    expect(await persistence.persistRoutes()).toBe('invalid')
    expect(sessionCreatedTaskIds.has(202)).toBe(true)
    expect(readTopologyWriteLog()[0]).toMatchObject({
      action: '回滚本轮新建的探测任务（1 个）',
      outcome: 'failed',
    })
  })
})
