import type { AdminPingTask } from '../../src/services/ping-task.model'
import { afterEach, expect, mock, test } from 'bun:test'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { invalidatePublicPingTasksCache, loadPublicPingTasks } from '../../src/services/metrics.service'
import { createAdminPingTask, invalidateAdminPingTasksCache } from '../../src/services/ping-task.service'
import { resetSharedRpc } from '../../src/utils/rpc'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
  resetSharedRpc()
  setAuthSessionFromLogin(false)
  invalidateAdminPingTasksCache()
  invalidatePublicPingTasksCache()
})

test('lost create response resolves only one full-matching new snapshot; ambiguity never chooses newest', async () => {
  for (const ambiguous of [false, true]) {
    const tasks: AdminPingTask[] = []
    let creates = 0
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      if (!init?.body)
        return Response.json({ logged_in: true, username: 'admin' })
      const request = JSON.parse(String(init.body))
      if (request.method === 'admin:getAllPingTasks' || request.method === 'public:getPublicPingTasks')
        return Response.json({ jsonrpc: '2.0', id: request.id, result: tasks })
      if (request.method === 'admin:addPingTask') {
        creates++
        tasks.push({ ...request.params, id: 20 })
        tasks.push({ ...request.params, id: 21, clients: ambiguous ? request.params.clients : ['different-source'] })
        throw new Error('response lost after commit')
      }
      throw new Error(`unexpected ${request.method}`)
    }) as typeof fetch
    expect(await loadPublicPingTasks()).toEqual([])
    const operation = createAdminPingTask({ name: '北京移动', type: 'tcp', target: '192.0.2.1:53', clients: ['a'], default_on: true, interval: 30 })
    if (ambiguous)
      await expect(operation).rejects.toThrow('归属不明确')
    else
      expect((await operation).id).toBe(20)
    expect(creates).toBe(1)
    expect(await loadPublicPingTasks()).toHaveLength(2)
    resetSharedRpc()
    invalidateAdminPingTasksCache()
    invalidatePublicPingTasksCache()
  }
})
