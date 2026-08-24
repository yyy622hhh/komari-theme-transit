import type { TopologyRouteProbeState } from '../../src/composables/useTopologyRoutePlanner'
import { describe, expect, test } from 'bun:test'
import { findUniquePresetEntryTask, formatTopologyEntryHint, formatTopologyRouteHint, isTopologyRouteHintDestructive, isTopologySegmentKeyForRoute } from '../../src/composables/useTopologyRoutePlanner'

describe('isTopologySegmentKeyForRoute', () => {
  test('does not treat route 10 as a hop of route 1', () => {
    expect(isTopologySegmentKeyForRoute('1', 1)).toBe(true)
    expect(isTopologySegmentKeyForRoute('1:2', 1)).toBe(true)
    expect(isTopologySegmentKeyForRoute('10:1', 1)).toBe(false)
    expect(isTopologySegmentKeyForRoute('10:1', 10)).toBe(true)
  })
})

describe('findUniquePresetEntryTask', () => {
  test('does not treat two unrelated unknown values as the same preset', () => {
    expect(findUniquePresetEntryTask(['custom-observer'], 'custom-entry')).toBe('')
  })

  test('returns one matching preset task but rejects ambiguous matches', () => {
    expect(findUniquePresetEntryTask(['北京电信'], '北京电信')).toBe('北京电信')
    expect(findUniquePresetEntryTask(['北京电信', '北京-电信'], '北京电信')).toBe('')
  })
})

function state(overrides: Partial<TopologyRouteProbeState> = {}): TopologyRouteProbeState {
  return {
    probe: { type: 'icmp' },
    verdict: 'healthy',
    exhausted: false,
    switchedFrom: null,
    targetAddress: '203.0.113.20',
    ...overrides,
  }
}

const baseInput = {
  planning: false,
  taskError: '',
  hasSource: true,
  hasLanding: true,
  state: undefined,
  pending: false,
}

describe('formatTopologyRouteHint', () => {
  test('reports planning before anything else', () => {
    expect(formatTopologyRouteHint({ ...baseInput, planning: true, taskError: 'ignored while planning' }))
      .toBe('正在自动挑选可用的探测方式…')
  })

  test('surfaces a task error verbatim', () => {
    expect(formatTopologyRouteHint({ ...baseInput, taskError: '无法按所选节点匹配 Ping 任务。' }))
      .toBe('无法按所选节点匹配 Ping 任务。')
  })

  test('asks for a relay before a landing', () => {
    expect(formatTopologyRouteHint({ ...baseInput, hasSource: false, hasLanding: false }))
      .toBe('请选择线路机。')
  })

  test('stays quiet when a relay-only topology intentionally has no landing', () => {
    expect(formatTopologyRouteHint({ ...baseInput, hasLanding: false }))
      .toBe('')
  })

  test('is silent until the first plan resolves', () => {
    expect(formatTopologyRouteHint({ ...baseInput, state: undefined })).toBe('')
  })

  test('reports exhaustion with the landing address once the ladder runs out', () => {
    const hint = formatTopologyRouteHint({
      ...baseInput,
      state: state({ exhausted: true, targetAddress: '198.51.100.7' }),
    })
    expect(hint).toContain('都探测不通')
    expect(hint).toContain('198.51.100.7')
  })

  test('announces an automatic switch away from a dead probe', () => {
    expect(formatTopologyRouteHint({
      ...baseInput,
      state: state({ switchedFrom: { type: 'icmp' }, probe: { type: 'tcp', port: 443 } }),
    })).toBe('ICMP 探测不通，已自动改用 TCP 443。')
  })

  test('reports a pending task creation before falling back to verdict text', () => {
    expect(formatTopologyRouteHint({
      ...baseInput,
      pending: true,
      state: state({ probe: { type: 'tcp', port: 80 } }),
    })).toBe('正在按 TCP 80 自动创建探测任务。')
  })

  test('reports a healthy binding', () => {
    expect(formatTopologyRouteHint({ ...baseInput, state: state({ verdict: 'healthy' }) }))
      .toBe('探测方式：ICMP · 正常')
  })

  test('reports a dead binding that is about to be switched', () => {
    expect(formatTopologyRouteHint({ ...baseInput, state: state({ verdict: 'dead' }) }))
      .toBe('探测方式：ICMP · 没有成功响应，正在自动换用其它方式。')
  })

  test('reports pending samples for anything else', () => {
    expect(formatTopologyRouteHint({ ...baseInput, state: state({ verdict: 'pending' }) }))
      .toBe('探测方式：ICMP · 正在等待首批采样')
  })
})

describe('isTopologyRouteHintDestructive', () => {
  test('is destructive when there is a task error', () => {
    expect(isTopologyRouteHintDestructive({ taskError: '出错了', exhausted: false })).toBe(true)
  })

  test('is destructive once the probe ladder is exhausted', () => {
    expect(isTopologyRouteHintDestructive({ taskError: '', exhausted: true })).toBe(true)
  })

  test('is not destructive otherwise', () => {
    expect(isTopologyRouteHintDestructive({ taskError: '', exhausted: false })).toBe(false)
  })
})

describe('formatTopologyEntryHint', () => {
  const preset = {
    probeLabel: '北京电信',
    expectedTaskName: '北京电信',
    entryLabel: '北京电信',
    sourceName: 'Relay-JP',
    live: false,
    pending: false,
    state: undefined,
  }

  test('stays silent until a source node is chosen', () => {
    expect(formatTopologyEntryHint({ ...preset, sourceName: '' })).toBe('')
    expect(formatTopologyEntryHint({ ...preset, sourceName: '   ' })).toBe('')
  })

  test('confirms the live binding and clarifies the probe direction', () => {
    const hint = formatTopologyEntryHint({ ...preset, live: true })
    expect(hint).toContain('入口探测：北京电信 · 实时')
    // 线路机主动探测运营商落地点，方向和「该运营商用户访问线路机」相反，必须说清楚。
    expect(hint).toContain('不代表该运营商用户访问这台线路机的真实体验')
  })

  test('reports the auto-created entry task while it is still pending', () => {
    const hint = formatTopologyEntryHint({ ...preset, live: true, pending: true })
    expect(hint).toContain('正在为入口自动创建探测任务')
    expect(hint).toContain('北京电信')
  })

  test('names the missing task when a preset entry has no matching task and is not yet planned', () => {
    const hint = formatTopologyEntryHint(preset)
    expect(hint).toContain('Relay-JP')
    expect(hint).toContain('北京电信')
    expect(hint).toContain('正在自动创建')
  })

  test('reports a ladder switch in progress while the replacement task is pending', () => {
    const hint = formatTopologyEntryHint({
      ...preset,
      live: true,
      pending: true,
      state: state({ probe: { type: 'tcp', port: 443 }, switchedFrom: { type: 'icmp' } }),
    })
    expect(hint).toContain('北京电信')
    expect(hint).toContain('ICMP 探测不通')
    expect(hint).toContain('自动改用 TCP 443')
  })

  test('reports the ladder as exhausted once every probe type has been tried', () => {
    const hint = formatTopologyEntryHint({
      ...preset,
      live: true,
      state: state({ exhausted: true, targetAddress: '219.141.140.10' }),
    })
    expect(hint).toContain('北京电信')
    expect(hint).toContain('都探测不通')
    expect(hint).toContain('219.141.140.10')
  })

  test('quotes the custom ladder, not TCP 53, when a custom entry is exhausted', () => {
    const hint = formatTopologyEntryHint({
      probeLabel: '',
      expectedTaskName: 'Transit-entry-custom-tcp-22',
      entryLabel: '自建入口',
      sourceName: 'Relay-JP',
      live: true,
      pending: false,
      state: state({ exhausted: true, targetAddress: '203.0.113.10' }),
    })
    expect(hint).toContain('TCP 443')
    expect(hint).not.toContain('TCP 53')
  })

  test('explains a custom entry that carries no live task', () => {
    const hint = formatTopologyEntryHint({
      probeLabel: '',
      expectedTaskName: '',
      entryLabel: '自建入口',
      sourceName: 'Relay-JP',
      live: false,
      pending: false,
      state: undefined,
    })
    expect(hint).toContain('自建入口')
    expect(hint).toContain('静态基线')
  })

  test('falls back to the entry label when a custom entry is live, without the direction caveat', () => {
    expect(formatTopologyEntryHint({
      probeLabel: '',
      expectedTaskName: '',
      entryLabel: '自建入口',
      sourceName: 'Relay-JP',
      live: true,
      pending: false,
      state: undefined,
    })).toBe('入口探测：自建入口 · 实时')
  })
})
