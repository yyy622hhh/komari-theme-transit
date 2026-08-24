import { describe, expect, test } from 'bun:test'
import { effectScope, nextTick, ref } from 'vue'
import {
  createTopologyRepairRunner,
  formatTopologyRepairError,
  isAbortLikeError,
  nextTopologyRepairLastError,
  shouldAnnounceTopologyRepairError,
  useTopologyProbeRepairTrigger,
} from '../../src/composables/useTopologyProbeRepair'
import { TIME_MS } from '../../src/constants/time'

describe('topology probe repair error signaling', () => {
  test('treats AbortError as a cancellation instead of a failure', () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    expect(isAbortLikeError(abort)).toBe(true)
    expect(isAbortLikeError(new Error('保存失败'))).toBe(false)
  })

  test('uses the original message when one exists', () => {
    expect(formatTopologyRepairError(new Error('登录状态已过期，请重新登录后保存。'))).toBe('登录状态已过期，请重新登录后保存。')
    expect(formatTopologyRepairError('nope')).toBe('拓扑探测自愈失败')
  })

  test('keeps a previous failure visible when the next round is skipped', () => {
    expect(nextTopologyRepairLastError('拓扑探测自愈失败', 'skipped')).toBe('拓扑探测自愈失败')
    expect(nextTopologyRepairLastError('拓扑探测自愈失败', 'no-op')).toBe('')
    expect(nextTopologyRepairLastError('拓扑探测自愈失败', 'repaired')).toBe('')
    expect(nextTopologyRepairLastError('', 'cleanup-failed')).toBe('已换挡的旧探测任务清理失败，将在下一轮重试')
  })

  test('rate-limits operator notices', () => {
    expect(shouldAnnounceTopologyRepairError(0, 1)).toBe(true)
    expect(shouldAnnounceTopologyRepairError(1_000, 1_000 + TIME_MS.minute)).toBe(false)
    expect(shouldAnnounceTopologyRepairError(1_000, 1_000 + 5 * TIME_MS.minute)).toBe(true)
  })
})

describe('useTopologyProbeRepairTrigger', () => {
  test('runs an immediate repair when conditions are already satisfied at startup', () => {
    const scope = effectScope()
    const calls: string[] = []
    scope.run(() => {
      useTopologyProbeRepairTrigger({
        canRepair: () => true,
        repairNow: () => calls.push('repair'),
        abortActive: () => calls.push('abort'),
        intervalMs: 60_000,
      })
    })
    // 不等 60 秒定时器：组件挂载时条件已经满足就必须立刻跑一轮。
    expect(calls).toEqual(['repair'])
    scope.stop()
  })

  test('does not repair or abort anything when conditions are unmet at startup', () => {
    const scope = effectScope()
    const calls: string[] = []
    scope.run(() => {
      useTopologyProbeRepairTrigger({
        canRepair: () => false,
        repairNow: () => calls.push('repair'),
        abortActive: () => calls.push('abort'),
        intervalMs: 60_000,
      })
    })
    expect(calls).toEqual([])
    scope.stop()
  })

  test('triggers a repair once login is confirmed after startup', async () => {
    // 模拟 appStore.privateFeaturesAllowed 从未确认变成 true，其余条件已经满足。
    const loggedIn = ref(false)
    const scope = effectScope()
    const calls: string[] = []
    scope.run(() => {
      useTopologyProbeRepairTrigger({
        canRepair: () => loggedIn.value,
        repairNow: () => calls.push('repair'),
        abortActive: () => calls.push('abort'),
        intervalMs: 60_000,
      })
    })
    expect(calls).toEqual([])
    loggedIn.value = true
    await nextTick()
    expect(calls).toEqual(['repair'])
    scope.stop()
  })

  test('triggers a repair once the page becomes visible again while other conditions hold', async () => {
    const loggedIn = ref(true)
    const pageVisible = ref(false)
    const scope = effectScope()
    const calls: string[] = []
    scope.run(() => {
      useTopologyProbeRepairTrigger({
        canRepair: () => loggedIn.value && pageVisible.value,
        repairNow: () => calls.push('repair'),
        abortActive: () => calls.push('abort'),
        intervalMs: 60_000,
      })
    })
    expect(calls).toEqual([])
    pageVisible.value = true
    await nextTick()
    expect(calls).toEqual(['repair'])
    scope.stop()
  })

  test('aborts the in-flight repair once conditions stop being met, but not on the initial unmet check', async () => {
    const available = ref(false)
    const scope = effectScope()
    const calls: string[] = []
    scope.run(() => {
      useTopologyProbeRepairTrigger({
        canRepair: () => available.value,
        repairNow: () => calls.push('repair'),
        abortActive: () => calls.push('abort'),
        intervalMs: 60_000,
      })
    })
    expect(calls).toEqual([])
    available.value = true
    await nextTick()
    available.value = false
    await nextTick()
    expect(calls).toEqual(['repair', 'abort'])
    scope.stop()
  })

  test('stops watching and clears the interval when disposed', () => {
    const scope = effectScope()
    let stop: (() => void) | undefined
    scope.run(() => {
      stop = useTopologyProbeRepairTrigger({
        canRepair: () => true,
        repairNow: () => {},
        abortActive: () => {},
        intervalMs: 60_000,
      })
    })
    expect(() => stop?.()).not.toThrow()
    scope.stop()
  })
})

describe('createTopologyRepairRunner', () => {
  test('the repairing lock prevents overlapping runs from concurrent triggers', async () => {
    const repairing = ref(false)
    let runCalls = 0
    const resolvers: Array<() => void> = []
    const attempt = createTopologyRepairRunner({
      canRepair: () => true,
      repairing,
      run: () => new Promise<void>((resolve) => {
        runCalls += 1
        resolvers.push(resolve)
      }),
    })

    // 模拟 watch、visibilitychange 和定时器几乎同时触发。
    const first = attempt()
    const second = attempt()
    const third = attempt()
    expect(runCalls).toBe(1)
    expect(repairing.value).toBe(true)

    resolvers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(runCalls).toBe(2)
    resolvers.shift()?.()
    await Promise.all([first, second, third])
    expect(runCalls).toBe(2)
    expect(repairing.value).toBe(false)

    // 排队补跑结束后，新的触发可以再跑一轮。
    const fourth = attempt()
    expect(runCalls).toBe(3)
    resolvers.shift()?.()
    await fourth
    expect(repairing.value).toBe(false)
  })

  test('a trigger during an in-flight run waits for that run instead of resolving as a skip', async () => {
    const repairing = ref(false)
    const resolvers: Array<() => void> = []
    const attempt = createTopologyRepairRunner({
      canRepair: () => true,
      repairing,
      run: () => new Promise<void>((resolve) => {
        resolvers.push(resolve)
      }),
    })

    const first = attempt()
    const skipped = attempt()
    let skippedSettled = false
    void skipped.then(() => {
      skippedSettled = true
    })
    await Promise.resolve()
    expect(skippedSettled).toBe(false)

    resolvers.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    resolvers.shift()?.()
    await Promise.all([first, skipped])
    expect(skippedSettled).toBe(true)
    expect(repairing.value).toBe(false)
  })

  test('does not run when canRepair is false', async () => {
    const repairing = ref(false)
    let runCalls = 0
    const attempt = createTopologyRepairRunner({
      canRepair: () => false,
      repairing,
      run: async () => { runCalls += 1 },
    })
    await attempt()
    expect(runCalls).toBe(0)
    expect(repairing.value).toBe(false)
  })

  test('clears the lock even when the run throws', async () => {
    const repairing = ref(false)
    const attempt = createTopologyRepairRunner({
      canRepair: () => true,
      repairing,
      run: async () => { throw new Error('admin:getAllPingTasks 502') },
    })
    await expect(attempt()).rejects.toThrow('admin:getAllPingTasks 502')
    expect(repairing.value).toBe(false)
  })
})
