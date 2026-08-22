import { afterEach, describe, expect, test } from 'bun:test'
import { detectWebglSupport, isLowPowerDevice } from '../../src/utils/deviceCapability'

const originalNavigator = globalThis.navigator

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
})

describe('detectWebglSupport', () => {
  test('reports no support instead of throwing when document is unavailable (SSR/non-browser)', () => {
    expect(detectWebglSupport()).toEqual({ webgl2: false, webgl1: false })
  })
})

describe('isLowPowerDevice', () => {
  test('is false instead of throwing when navigator is unavailable (SSR/non-browser)', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
    expect(isLowPowerDevice()).toBe(false)
  })

  test('is true when the device reports 4 or fewer logical cores', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 4 } })
    expect(isLowPowerDevice()).toBe(true)
  })

  test('is false for a capable device with no reduced-motion/coarse-pointer signal', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 16 } })
    expect(isLowPowerDevice()).toBe(false)
  })
})
