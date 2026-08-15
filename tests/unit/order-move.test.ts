import { describe, expect, test } from 'bun:test'
import { resolveOrderMoveTarget } from '../../src/composables/useOrderMoveFeedback'

describe('resolveOrderMoveTarget', () => {
  test('supports adjacent and boundary keyboard moves', () => {
    expect(resolveOrderMoveTarget('ArrowUp', 2, 4)).toBe(1)
    expect(resolveOrderMoveTarget('ArrowDown', 1, 4)).toBe(2)
    expect(resolveOrderMoveTarget('Home', 2, 4)).toBe(0)
    expect(resolveOrderMoveTarget('End', 1, 4)).toBe(3)
  })

  test('ignores unsupported keys and moves beyond the list boundaries', () => {
    expect(resolveOrderMoveTarget('ArrowUp', 0, 4)).toBeNull()
    expect(resolveOrderMoveTarget('ArrowDown', 3, 4)).toBeNull()
    expect(resolveOrderMoveTarget('Home', 0, 4)).toBeNull()
    expect(resolveOrderMoveTarget('End', 3, 4)).toBeNull()
    expect(resolveOrderMoveTarget('Enter', 1, 4)).toBeNull()
  })
})
