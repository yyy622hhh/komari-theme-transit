import type { TopologyRouteProbeState } from '../../src/composables/useTopologyRoutePlanner'
import { describe, expect, test } from 'bun:test'
import { formatTopologyEntryHint, formatTopologyRouteHint, isTopologyRouteHintDestructive } from '../../src/composables/useTopologyRoutePlanner'

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

  test('asks for a landing once a relay is picked', () => {
    expect(formatTopologyRouteHint({ ...baseInput, hasLanding: false }))
      .toBe('请选择落地机。')
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
  }

  test('stays silent until a source node is chosen', () => {
    expect(formatTopologyEntryHint({ ...preset, sourceName: '' })).toBe('')
    expect(formatTopologyEntryHint({ ...preset, sourceName: '   ' })).toBe('')
  })

  test('confirms the live binding without nagging', () => {
    expect(formatTopologyEntryHint({ ...preset, live: true })).toBe('入口探测：北京电信 · 实时')
  })

  test('names the missing task and the fix when a preset entry has no matching task', () => {
    const hint = formatTopologyEntryHint(preset)
    expect(hint).toContain('Relay-JP')
    expect(hint).toContain('北京电信')
    expect(hint).toContain('静态基线')
    // 必须给出可执行的下一步，而不只是陈述现状。
    expect(hint).toContain('创建同名任务')
  })

  test('explains a custom entry that carries no live task', () => {
    const hint = formatTopologyEntryHint({
      probeLabel: '',
      expectedTaskName: '',
      entryLabel: '自建入口',
      sourceName: 'Relay-JP',
      live: false,
    })
    expect(hint).toContain('自建入口')
    expect(hint).toContain('静态基线')
  })

  test('falls back to the entry label when a custom entry is live', () => {
    expect(formatTopologyEntryHint({
      probeLabel: '',
      expectedTaskName: '',
      entryLabel: '自建入口',
      sourceName: 'Relay-JP',
      live: true,
    })).toBe('入口探测：自建入口 · 实时')
  })
})
