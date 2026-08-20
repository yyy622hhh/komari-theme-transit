import { describe, expect, test } from 'bun:test'
import { mergeNodeControls, parseNodeControls, updateNodeControl } from '../../src/utils/nodeControl'

describe('node control merge', () => {
  test('keeps unknown node entries and extra fields when updating one UUID', () => {
    const now = 1_000_000
    const raw = {
      'node-1': { maintenanceUntil: now + 60_000, note: 'keep' },
      'node-2': { custom: true },
    }

    const merged = mergeNodeControls(raw, current => updateNodeControl(current, 'node-1', 'silenceUntil', now + 120_000), now)

    expect(merged).toEqual({
      'node-1': { maintenanceUntil: now + 60_000, note: 'keep', silenceUntil: now + 120_000 },
      'node-2': { custom: true },
    })
    expect(parseNodeControls(merged, now)['node-1']).toEqual({
      maintenanceUntil: now + 60_000,
      silenceUntil: now + 120_000,
    })
  })
})
