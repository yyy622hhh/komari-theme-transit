import { expect, test } from 'bun:test'
import { effectScope, nextTick, ref } from 'vue'
import { useDashboardSection } from '../../src/composables/useDashboardSection'

test('dashboard navigation follows scrolling/resizing and releases the shared listener outside home', async () => {
  const originals = new Map(['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map<string, () => void>()
  let frame: (() => void) | undefined
  let top = 1200
  let present = true
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    scrollY: 0,
    innerHeight: 900,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    removeEventListener: (name: string) => listeners.delete(name),
    requestAnimationFrame: (callback: () => void) => {
      frame = callback
      return 1
    },
    cancelAnimationFrame: () => { frame = undefined },
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { scrollHeight: 2000 },
    getElementById: () => present ? { getBoundingClientRect: () => ({ top }) } : null,
    querySelector: () => ({ getBoundingClientRect: () => ({ height: 72 }) }),
  } })
  const scope = effectScope()
  const enabled = ref(true)
  try {
    const active = scope.run(() => useDashboardSection(enabled))!
    expect(active.value).toBe('network-overview')
    Object.assign(window, { scrollY: 1100 })
    top = 300
    listeners.get('scroll')!()
    frame!()
    expect(active.value).toBe('network-topology')
    expect(listeners.size).toBe(2)
    top = 80
    listeners.get('scroll')!()
    frame!()
    expect(active.value).toBe('network-topology')
    top = 600
    Object.assign(window, { scrollY: 0 })
    listeners.get('resize')!()
    frame!()
    expect(active.value).toBe('network-overview')
    enabled.value = false
    await nextTick()
    expect(listeners.size).toBe(0)
    present = false
    enabled.value = true
    await nextTick()
    expect(active.value).toBe('network-overview')
    scope.stop()
    expect(listeners.size).toBe(0)
  }
  finally {
    scope.stop()
    for (const [key, descriptor] of originals) {
      if (descriptor)
        Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
