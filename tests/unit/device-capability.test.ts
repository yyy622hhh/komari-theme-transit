import { afterEach, describe, expect, test } from 'bun:test'
import { detectWebglSupport, isLowPowerDevice, resetWebglSupportCache } from '../../src/utils/deviceCapability'
import { resolveStaticEarthRenderer } from '../../src/utils/renderModeState'

const originalNavigator = globalThis.navigator
const originalDocument = globalThis.document
const originalMatchMedia = globalThis.matchMedia

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: originalMatchMedia })
  resetWebglSupportCache()
})

function installCanvasGetContext(handler: (type: string) => unknown): { lost: string[] } {
  const lost: string[] = []
  const context = (label: string) => ({
    getExtension: (name: string) => {
      if (name !== 'WEBGL_lose_context')
        return null
      return { loseContext: () => lost.push(label) }
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: (type: string) => handler(type) === true ? context(type) : handler(type),
      }),
    },
  })
  resetWebglSupportCache()
  return { lost }
}

describe('detectWebglSupport', () => {
  test('reports no support instead of throwing when document is unavailable (SSR/non-browser)', () => {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined })
    resetWebglSupportCache()
    expect(detectWebglSupport()).toEqual({ webgl2: false, webgl1: false })
  })

  test('releases a WebGL1 probe context when WebGL2 is unavailable', () => {
    const { lost } = installCanvasGetContext(type => type === 'webgl' || type === 'experimental-webgl')
    expect(detectWebglSupport()).toEqual({ webgl2: false, webgl1: true })
    expect(lost).toContain('webgl')
  })

  test('releases a WebGL2 probe context', () => {
    const { lost } = installCanvasGetContext(type => type === 'webgl2')
    expect(detectWebglSupport()).toEqual({ webgl2: true, webgl1: true })
    expect(lost).toContain('webgl2')
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
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    })
    expect(isLowPowerDevice()).toBe(false)
  })
})

describe('resolveStaticEarthRenderer', () => {
  test('does not probe WebGL when the configured renderer is already tiled', () => {
    let probed = false
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({
          getContext: () => {
            probed = true
            return null
          },
        }),
      },
    })
    resetWebglSupportCache()
    expect(resolveStaticEarthRenderer('tiled')).toEqual({ active: 'tiled', reason: null })
    expect(probed).toBe(false)
  })

  test('falls back from realistic to tiled when no WebGL is available', () => {
    installCanvasGetContext(() => null)
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 16 } })
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    })
    expect(resolveStaticEarthRenderer('realistic').active).toBe('tiled')
  })

  test('falls back from realistic to cobe when only WebGL1 is available', () => {
    installCanvasGetContext(type => type === 'webgl' || type === 'experimental-webgl')
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: 16 } })
    Object.defineProperty(globalThis, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false }),
    })
    expect(resolveStaticEarthRenderer('realistic').active).toBe('cobe')
  })
})
