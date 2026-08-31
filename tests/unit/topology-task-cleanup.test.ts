import type { AdminPingTask } from '../../src/services/ping-task.model'
import { afterEach, expect, test } from 'bun:test'
import { computed, ref } from 'vue'
import { createTopologyPersistence } from '../../src/services/topology-persistence.service'
import { deleteOwnedTopologyPingTasks } from '../../src/services/topology-task-cleanup.service'
import { matchesCreatedTopologyTask, rememberCreatedTopologyTask, resetTopologyTaskSnapshotsCache } from '../../src/utils/topologyTaskSnapshot'

const storage = globalThis.sessionStorage
afterEach(() => {
  if (storage)
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  else
    Reflect.deleteProperty(globalThis, 'sessionStorage')
  resetTopologyTaskSnapshotsCache()
})
const original = (): AdminPingTask => ({ id: 4242, name: 'Transit-original', type: 'icmp', target: '192.0.2.10', clients: ['node-a', 'node-b'], interval: 30, default_on: false })

for (const change of [
  { name: 'repurposed business monitor' },
  { type: 'tcp' },
  { target: '192.0.2.20' },
  { clients: ['other-node'] },
  { interval: 60 },
  { default_on: true },
] as Partial<AdminPingTask>[]) {
  test(`saving topology preserves a repurposed task: ${Object.keys(change)[0]}`, async () => {
    rememberCreatedTopologyTask(original())
    const removed: number[] = []
    const deleteTasks = (ids: readonly number[]) => deleteOwnedTopologyPingTasks(ids, {
      loadTasks: async () => [{ ...original(), ...change }],
      deleteTasks: async (ids) => {
        removed.push(...ids)
        return true
      },
    })
    const persistence = createTopologyPersistence({
      props: { nodes: [], open: true },
      manager: { routes: [], quickNodes: [], preflightSave: async () => {}, save: async () => 'saved', withSaveLock: async fn => fn() },
      taskValidationPending: computed(() => false),
      persistBlockingErrors: computed(() => []),
      pendingRouteTasks: ref({}),
      pendingEntryTasks: ref({}),
      routeRetiredTasks: ref({}),
      routeEntryRetiredTasks: ref({}),
      routeTaskErrors: ref({}),
      sessionCreatedTaskIds: new Set([4242]),
      findEndpoint: () => undefined,
      rememberTask: () => {},
      clearPendingRouteTask: () => {},
      clearPendingEntryTask: () => {},
      clearRouteTaskError: () => {},
      hasPendingWork: () => true,
      getDialogSession: () => 1,
      getQuickConfigurationRun: () => 1,
      onOpenChange: () => {},
      refreshWriteLog: () => {},
      message: undefined,
      operations: { loadTasks: async () => [{ ...original(), ...change }], deleteTasks },
    })
    expect(await persistence.persistRoutes()).toBe('saved')
    expect(removed).toEqual([])
  })
}

test('legacy IDs without creation proof are retained, including a mixed batch', async () => {
  rememberCreatedTopologyTask(original())
  const deleted: number[] = []
  expect(await deleteOwnedTopologyPingTasks([4242, 4243], {
    loadTasks: async () => [original(), { ...original(), id: 4243 }],
    deleteTasks: async (ids) => {
      deleted.push(...ids)
      return true
    },
  })).toBeFalse()
  expect(deleted).toEqual([])
})

test('unchanged creation proof survives reload and does not alias later mutations', async () => {
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  } })
  const created = original()
  rememberCreatedTopologyTask(created)
  created.clients.push('new-client')
  expect(matchesCreatedTopologyTask(created)).toBeFalse()
  resetTopologyTaskSnapshotsCache()
  const deleted: number[] = []
  expect(await deleteOwnedTopologyPingTasks([4242], {
    loadTasks: async () => [{ ...original(), clients: ['node-b', 'node-a'] }],
    deleteTasks: async (ids) => {
      deleted.push(...ids)
      return true
    },
  })).toBeTrue()
  expect(deleted).toEqual([4242])
  expect(matchesCreatedTopologyTask(original())).toBeFalse()
})

test('failed permission/read prevents deletion and lost response is reconciled', async () => {
  rememberCreatedTopologyTask(original())
  let calls = 0
  expect(await deleteOwnedTopologyPingTasks([4242], {
    loadTasks: async () => { throw new Error('expired permission') },
    deleteTasks: async () => {
      calls++
      return true
    },
  })).toBeFalse()
  expect(calls).toBe(0)
  let live = [original()]
  expect(await deleteOwnedTopologyPingTasks([4242], {
    loadTasks: async () => live,
    deleteTasks: async () => {
      live = []
      return false
    },
  })).toBeTrue()
})

test('failed compensation retains proof for an explicit retry', async () => {
  rememberCreatedTopologyTask(original())
  expect(await deleteOwnedTopologyPingTasks([4242], {
    loadTasks: async () => [original()],
    deleteTasks: async () => false,
  })).toBeFalse()
  expect(matchesCreatedTopologyTask(original())).toBeTrue()
})
