import { describe, expect, test } from 'bun:test'
import { createTouchTooltipState } from '../../src/composables/useTouchTooltipMode'

describe('createTouchTooltipState', () => {
  test('toggleTaskTooltip is a no-op outside touch mode', () => {
    const tooltip = createTouchTooltipState()
    tooltip.toggleTaskTooltip(1)
    expect(tooltip.activeTaskTooltipId.value).toBeNull()
  })

  test('toggleTaskTooltip opens, then closes the same task on a second toggle', () => {
    const tooltip = createTouchTooltipState()
    tooltip.isTouchTooltipMode.value = true
    tooltip.toggleTaskTooltip(1)
    expect(tooltip.activeTaskTooltipId.value).toBe(1)
    tooltip.toggleTaskTooltip(1)
    expect(tooltip.activeTaskTooltipId.value).toBeNull()
  })

  test('toggling a different task switches the open tooltip instead of stacking', () => {
    const tooltip = createTouchTooltipState()
    tooltip.isTouchTooltipMode.value = true
    tooltip.toggleTaskTooltip(1)
    tooltip.toggleTaskTooltip(2)
    expect(tooltip.activeTaskTooltipId.value).toBe(2)
  })

  test('opening a task tooltip closes the smooth-info tooltip, and vice versa', () => {
    const tooltip = createTouchTooltipState()
    tooltip.isTouchTooltipMode.value = true
    tooltip.toggleSmoothInfoTooltip()
    expect(tooltip.smoothInfoTooltipOpen.value).toBe(true)
    tooltip.toggleTaskTooltip(1)
    expect(tooltip.smoothInfoTooltipOpen.value).toBe(false)
    expect(tooltip.activeTaskTooltipId.value).toBe(1)

    tooltip.toggleSmoothInfoTooltip()
    expect(tooltip.smoothInfoTooltipOpen.value).toBe(true)
    expect(tooltip.activeTaskTooltipId.value).toBeNull()
  })

  test('setTaskTooltipOpen(id, true) opens exactly that task', () => {
    const tooltip = createTouchTooltipState()
    tooltip.setTaskTooltipOpen(3, true)
    expect(tooltip.activeTaskTooltipId.value).toBe(3)
  })

  test('setTaskTooltipOpen(id, false) only closes if that task is the one open', () => {
    const tooltip = createTouchTooltipState()
    tooltip.setTaskTooltipOpen(3, true)
    tooltip.setTaskTooltipOpen(4, false) // closing a task that isn't open should not disturb #3
    expect(tooltip.activeTaskTooltipId.value).toBe(3)
    tooltip.setTaskTooltipOpen(3, false)
    expect(tooltip.activeTaskTooltipId.value).toBeNull()
  })

  test('reset closes both tooltip kinds', () => {
    const tooltip = createTouchTooltipState()
    tooltip.isTouchTooltipMode.value = true
    tooltip.toggleTaskTooltip(1)
    tooltip.reset()
    expect(tooltip.activeTaskTooltipId.value).toBeNull()
    expect(tooltip.smoothInfoTooltipOpen.value).toBe(false)
  })
})
