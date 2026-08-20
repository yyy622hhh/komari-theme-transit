import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import {
  mergeNodeCardPanelConfigs,
  parseNodeCardPanelConfigs,
  resolveNodeCardPanelMode,
  serializeNodeCardPanelConfigs,
  updateNodeCardPanelConfig,
} from '../../src/utils/nodeCardPanel'

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    uuid: 'node-1',
    name: '普通节点',
    gpu_name: '',
    gpu: 0,
    traffic_limit: 0,
    tags: '',
    public_remark: '',
    groups: [],
    ...overrides,
  } as NodeData
}

describe('node card panel configuration', () => {
  test('parses safe modes and limits custom Ping tasks', () => {
    const raw = JSON.parse('{"node-1":{"mode":"ping","pingTasks":[" Tokyo ","Tokyo","Local","Exit","Ignored"]},"node-2":{"mode":"unknown"},"node-3":null,"__proto__":{"mode":"gpu"}}')
    const parsed = parseNodeCardPanelConfigs(raw)
    expect(parsed).toEqual({
      'node-1': { mode: 'ping', pingTasks: ['Tokyo', 'Local', 'Exit'] },
    })
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false)
    expect(parseNodeCardPanelConfigs(JSON.stringify({
      'node-1': { mode: 'ping', pingTasks: [' Tokyo ', 'Tokyo', 'Local', 'Exit', 'Ignored'] },
      'node-2': { mode: 'unknown' },
      'node-3': null,
    }))).toEqual({
      'node-1': { mode: 'ping', pingTasks: ['Tokyo', 'Local', 'Exit'] },
    })
  })

  test('keeps unknown panel modes when merging a single-node update onto the raw map', () => {
    const raw = {
      'node-1': { mode: 'carrier' },
      'node-2': { mode: 'future-mode', pingTasks: ['Keep'] },
    }
    const merged = mergeNodeCardPanelConfigs(raw, current => updateNodeCardPanelConfig(current, 'node-1', { mode: 'system' }))
    expect(merged).toEqual({
      'node-1': { mode: 'system' },
      'node-2': { mode: 'future-mode', pingTasks: ['Keep'] },
    })
    expect(mergeNodeCardPanelConfigs(merged, current => updateNodeCardPanelConfig(current, 'node-1'))).toEqual({
      'node-2': { mode: 'future-mode', pingTasks: ['Keep'] },
    })
  })

  test('keeps extra fields on a known panel mode when another node is updated', () => {
    const raw = {
      'node-1': { mode: 'system', variant: 'wide' },
      'node-2': { mode: 'carrier' },
    }
    const merged = mergeNodeCardPanelConfigs(raw, current => updateNodeCardPanelConfig(current, 'node-2', { mode: 'compact' }))
    expect(merged).toEqual({
      'node-1': { mode: 'system', variant: 'wide' },
      'node-2': { mode: 'compact' },
    })
  })

  test('updates one UUID without mutating other node preferences', () => {
    const current = { 'node-1': { mode: 'carrier' as const } }
    const updated = updateNodeCardPanelConfig(current, 'node-2', { mode: 'system' })
    expect(updated).toEqual({
      'node-1': { mode: 'carrier' },
      'node-2': { mode: 'system' },
    })
    expect(current).toEqual({ 'node-1': { mode: 'carrier' } })
    expect(updateNodeCardPanelConfig(updated, 'node-2')).toEqual(current)
    expect(parseNodeCardPanelConfigs(serializeNodeCardPanelConfigs(updated))).toEqual(updated)
  })

  test('chooses automatic panels from real node capabilities', () => {
    expect(resolveNodeCardPanelMode(node({ gpu_name: 'NVIDIA A100' }), { mode: 'auto' }, true)).toBe('gpu')
    expect(resolveNodeCardPanelMode(node(), { mode: 'auto' }, true)).toBe('carrier')
    expect(resolveNodeCardPanelMode(node({ traffic_limit: 1024 }), { mode: 'auto' }, false)).toBe('traffic')
    expect(resolveNodeCardPanelMode(node({ groups: ['备份'] }), { mode: 'auto' }, false)).toBe('storage')
    expect(resolveNodeCardPanelMode(node(), { mode: 'auto' }, false)).toBe('system')
    expect(resolveNodeCardPanelMode(node(), { mode: 'compact' }, true)).toBe('compact')
  })
})
