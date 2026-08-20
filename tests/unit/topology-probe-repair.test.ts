import { describe, expect, test } from 'bun:test'
import { formatTopologyRepairError, isAbortLikeError, shouldAnnounceTopologyRepairError } from '../../src/composables/useTopologyProbeRepair'
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

  test('rate-limits operator notices', () => {
    expect(shouldAnnounceTopologyRepairError(0, 1)).toBe(true)
    expect(shouldAnnounceTopologyRepairError(1_000, 1_000 + TIME_MS.minute)).toBe(false)
    expect(shouldAnnounceTopologyRepairError(1_000, 1_000 + 5 * TIME_MS.minute)).toBe(true)
  })
})
