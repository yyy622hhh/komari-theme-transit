import type { CDPSession, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from '../visual/fixtures/komari'

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined)
    return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`)
  return value
}

const LARGE_NODE_COUNT = readPositiveInteger('TRANSIT_PERF_NODE_COUNT', 2_000)
const STABILITY_ROUNDS = readPositiveInteger('TRANSIT_PERF_STABILITY_ROUNDS', 12)
const MAX_RENDERED_NODE_ROWS = 40
const MAX_HOME_READY_MS = 8_000
const MAX_SCROLL_FRAME_MS = 500
const MAX_HEAP_GROWTH_BYTES = 32 * 1024 * 1024

interface RuntimeCounters {
  intervals: number
  timeouts: number
}

interface PerformanceMemory {
  usedJSHeapSize: number
}

interface DomCounters {
  documents: number
  jsEventListeners: number
  nodes: number
}

async function installRuntimeCounters(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counters = { intervals: 0, timeouts: 0 }
    const activeIntervals = new Set<number>()
    const activeTimeouts = new Set<number>()
    const nativeSetInterval = window.setInterval.bind(window)
    const nativeClearInterval = window.clearInterval.bind(window)
    const nativeSetTimeout = window.setTimeout.bind(window)
    const nativeClearTimeout = window.clearTimeout.bind(window)

    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = nativeSetInterval(handler, timeout, ...args)
      activeIntervals.add(id)
      counters.intervals = activeIntervals.size
      return id
    }) as typeof window.setInterval
    window.clearInterval = ((id?: number) => {
      if (typeof id === 'number')
        activeIntervals.delete(id)
      counters.intervals = activeIntervals.size
      nativeClearInterval(id)
    }) as typeof window.clearInterval
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      let id = 0
      const wrapped = typeof handler === 'function'
        ? (...handlerArgs: unknown[]) => {
            activeTimeouts.delete(id)
            counters.timeouts = activeTimeouts.size
            handler(...handlerArgs)
          }
        : handler
      id = nativeSetTimeout(wrapped, timeout, ...args)
      activeTimeouts.add(id)
      counters.timeouts = activeTimeouts.size
      return id
    }) as typeof window.setTimeout
    window.clearTimeout = ((id?: number) => {
      if (typeof id === 'number')
        activeTimeouts.delete(id)
      counters.timeouts = activeTimeouts.size
      nativeClearTimeout(id)
    }) as typeof window.clearTimeout

    Object.defineProperty(window, '__transitRuntimeCounters', {
      configurable: false,
      value: counters,
    })
  })
}

async function readRuntimeCounters(page: Page): Promise<RuntimeCounters> {
  return page.evaluate(() => (window as typeof window & {
    __transitRuntimeCounters: RuntimeCounters
  }).__transitRuntimeCounters)
}

async function forceGarbageCollection(page: Page): Promise<void> {
  await page.requestGC()
  await page.waitForTimeout(50)
}

async function readHeap(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const memory = (performance as Performance & { memory?: PerformanceMemory }).memory
    return memory?.usedJSHeapSize ?? null
  })
}

async function readDomCounters(session: CDPSession): Promise<DomCounters> {
  return await session.send('Memory.getDOMCounters') as DomCounters
}

test.describe('large fleet and long-stability budgets', () => {
  test('virtualizes a large node fleet and keeps scroll work bounded', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await installKomariFixture(page, {
      hideEarth: true,
      nodeCount: LARGE_NODE_COUNT,
      viewMode: 'list',
      visitorInfoEnabled: false,
    })

    const startedAt = Date.now()
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible({ timeout: MAX_HOME_READY_MS })
    const readyMs = Date.now() - startedAt
    const rows = page.getByRole('button', { name: /^查看节点 .* 详情$/ })
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeLessThanOrEqual(MAX_RENDERED_NODE_ROWS)

    const viewport = rows.first().locator('xpath=../..')
    const scrollStartedAt = Date.now()
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll'))
    })
    const lastFixtureIndex = LARGE_NODE_COUNT - 1
    const lastFixtureBaseName = [
      '主控-洛杉矶',
      '香港边缘节点-超长名称布局测试',
      '东京-高负载',
      '新加坡-A100',
      '法兰克福-2680',
      '伦敦-离线归档',
      '台北-流量预警',
      '悉尼-IPv6',
    ][lastFixtureIndex % 8]
    const lastNodeName = `${lastFixtureBaseName}-${LARGE_NODE_COUNT}`
    await expect(page.getByRole('button', { name: `查看节点 ${lastNodeName} 详情` })).toBeVisible()
    const scrollMs = Date.now() - scrollStartedAt

    expect(readyMs).toBeLessThanOrEqual(MAX_HOME_READY_MS)
    expect(scrollMs).toBeLessThanOrEqual(MAX_SCROLL_FRAME_MS)
    expect(await rows.count()).toBeLessThanOrEqual(MAX_RENDERED_NODE_ROWS)
  })

  test('repeated detail navigation does not grow timers, listeners or heap without bound', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await installRuntimeCounters(page)
    await installKomariFixture(page, { hideEarth: true, visitorInfoEnabled: false })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()

    // Warm the lazy detail route and its chart chunks before measuring retained
    // resources. One-time module/style initialization is not a lifecycle leak.
    await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
    await expect(page).toHaveURL(/\/instance\//)
    await page.getByRole('link', { name: '返回首页' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })).toBeVisible()

    const cdp = await page.context().newCDPSession(page)
    await forceGarbageCollection(page)
    const baselineCounters = await readRuntimeCounters(page)
    const baselineDom = await readDomCounters(cdp)
    const baselineHeap = await readHeap(page)

    for (let round = 0; round < STABILITY_ROUNDS; round++) {
      await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
      await expect(page).toHaveURL(/\/instance\//)
      await page.getByRole('link', { name: '返回首页' }).click()
      await expect(page).toHaveURL('/')
      await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })).toBeVisible()
    }

    await forceGarbageCollection(page)
    const finalCounters = await readRuntimeCounters(page)
    const finalDom = await readDomCounters(cdp)
    const finalHeap = await readHeap(page)

    expect(finalCounters.intervals).toBeLessThanOrEqual(baselineCounters.intervals + 2)
    expect(finalCounters.timeouts).toBeLessThanOrEqual(baselineCounters.timeouts + 8)
    expect(finalDom.documents).toBeLessThanOrEqual(baselineDom.documents + 2)
    expect(finalDom.nodes).toBeLessThanOrEqual(baselineDom.nodes + 500)
    expect(finalDom.jsEventListeners).toBeLessThanOrEqual(baselineDom.jsEventListeners + 100)
    if (baselineHeap !== null && finalHeap !== null)
      expect(finalHeap - baselineHeap).toBeLessThanOrEqual(MAX_HEAP_GROWTH_BYTES)
  })
})
