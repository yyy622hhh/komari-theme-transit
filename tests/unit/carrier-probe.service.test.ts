import type { AdminPingTask } from '../../src/services/ping-task.model'
import { describe, expect, test } from 'bun:test'
import {
  assessCarrierProbeCandidate,
  buildCarrierProbeCandidate,
  classifyCarrierProbeHealth,
  selectCarrierProbeTask,
  staleTransitCanaryTaskIds,
} from '../../src/services/carrier-probe.service'
import { getTopologyProbe } from '../../src/utils/topologyPresets'

const CLIENTS = Array.from({ length: 5 }, (_, index) => `node-${index + 1}`)

function task(overrides: Partial<AdminPingTask> = {}): AdminPingTask {
  return {
    id: 10,
    name: '北京移动',
    clients: CLIENTS,
    default_on: false,
    type: 'icmp',
    target: '221.179.155.161',
    interval: 30,
    ...overrides,
  }
}

describe('carrier probe health and migration', () => {
  test('内置候选不会覆盖同名线上任务的真实目标', () => {
    const current = task()
    const preset = getTopologyProbe('beijing-mobile')
    expect(preset.landmarkAddress).toBe('221.130.33.52')
    expect(selectCarrierProbeTask([current], preset)).toBe(current)
    expect(selectCarrierProbeTask([current], preset)?.target).toBe('221.179.155.161')
  })

  test('区分四种目标健康状态并复用 5 台同步失败门槛', () => {
    expect(classifyCarrierProbeHealth({ onlineNodes: 0, observations: [], commonModeEvents: 0 })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 2,
      observations: [{ uuid: 'a', total: 3, valid: 3 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('healthy')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 1,
      observations: [{ uuid: 'a', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 3,
      observations: [{ uuid: 'a', total: 3, valid: 3 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('insufficient-evidence')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 2,
      observations: [{ uuid: 'a', total: 3, valid: 0 }, { uuid: 'b', total: 3, valid: 3 }],
      commonModeEvents: 0,
    })).toBe('single-path-anomaly')
    expect(classifyCarrierProbeHealth({
      onlineNodes: 5,
      observations: CLIENTS.map(uuid => ({ uuid, total: 3, valid: 0 })),
      commonModeEvents: 1,
    })).toBe('shared-target-anomaly')
  })

  test('候选门槛支持多节点 95% 和单节点连续五次的低置信度', () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ client: 'a', task_id: 1, value: 12, time: new Date(Date.now() - (5 - i) * 30_000).toISOString() }))
    expect(assessCarrierProbeCandidate([{ uuid: 'a', total: 5, valid: 5, records }])).toMatchObject({ migratable: true, lowConfidence: true, successRate: 1 })
    expect(assessCarrierProbeCandidate([{ uuid: 'a', total: 20, valid: 19 }]).migratable).toBeFalse()
    expect(assessCarrierProbeCandidate([{ uuid: 'a', total: 20, valid: 19, records: [...records.slice(0, 4), { ...records[4]!, value: -1 }] }]).migratable).toBeFalse()
    expect(assessCarrierProbeCandidate([
      { uuid: 'a', total: 20, valid: 19 },
      { uuid: 'b', total: 20, valid: 19 },
    ])).toMatchObject({ migratable: true, lowConfidence: false, successRate: 0.95 })
    expect(assessCarrierProbeCandidate([
      { uuid: 'a', total: 20, valid: 20 },
      { uuid: 'b', total: 3, valid: 0 },
    ])).toMatchObject({ migratable: false })
    expect(buildCarrierProbeCandidate('tcp', '221.130.33.52', 53, 'builtin')?.target).toBe('221.130.33.52:53')
    expect(buildCarrierProbeCandidate('icmp', '240e::1', undefined, 'custom')).toBeNull()
  })

  test('同类同名任务优先有成功样本，其次使用更新 ID', () => {
    const old = task({ id: 10 })
    const newest = task({ id: 11 })
    const unrelatedEntry = task({ id: 99, name: 'Transit-entry-beijing-mobile-icmp' })
    expect(selectCarrierProbeTask([old, newest, unrelatedEntry], getTopologyProbe('beijing-mobile'))?.id).toBe(11)
    expect(selectCarrierProbeTask([old, newest], getTopologyProbe('beijing-mobile'), new Map([
      [10, [{ uuid: 'a', total: 3, valid: 1 }]],
      [11, [{ uuid: 'a', total: 3, valid: 0 }]],
    ]))?.id).toBe(10)
    expect(selectCarrierProbeTask([old, newest], getTopologyProbe('beijing-mobile'), new Map([
      [10, []],
      [11, [{ uuid: 'a', total: 3, valid: 0 }]],
    ]))?.id).toBe(11)
  })

  test('只清理可识别且超过 30 分钟的 Transit canary', () => {
    const now = Date.UTC(2026, 7, 26, 12)
    expect(staleTransitCanaryTaskIds([
      task({ id: 1, name: `Transit-canary-beijing-mobile-${now - 31 * 60_000}` }),
      task({ id: 2, name: `Transit-canary-beijing-mobile-${now - 29 * 60_000}` }),
      task({ id: 3, name: `Other-canary-beijing-mobile-${now - 60 * 60_000}` }),
      task({ id: 4, name: `Transit-canary-unknown-${now - 60 * 60_000}` }),
    ], now)).toEqual([1])
  })
})
