import type { Locator, Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { installKomariFixture, readRouteProbeCompanionCalls, readRouteProbeEdits, readRouteProbeExecCalls } from './fixtures/komari'

const LIGHT_NODE_SURFACE = /^(?:rgba\(248, 250, 252, 0\.9\)|oklch\(0\.965 0\.008 252\))$/
const WALLPAPER_FIXTURE = fileURLToPath(new URL('../../docs/preview.png', import.meta.url))
const THEME_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL('../../komari-theme.json', import.meta.url)), 'utf8')) as { version: string }).version

const STABLE_STYLE = `
  @font-face {
    font-family: 'Transit Visual Fixture';
    font-style: normal;
    font-weight: 100 900;
    font-display: block;
    src: url('/__transit-visual-font-latin.woff2') format('woff2-variations');
    unicode-range: U+0000-024F;
  }
  @font-face {
    font-family: 'Transit Visual Fixture';
    font-style: normal;
    font-weight: 400;
    font-display: block;
    src: url('/__transit-visual-font-chinese.woff2') format('woff2');
    unicode-range: U+2E80-9FFF, U+F900-FAFF, U+FF00-FFEF;
  }
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
    font-family: 'Transit Visual Fixture', sans-serif !important;
    transition: none !important;
  }
  html { scroll-behavior: auto !important; }
  .earth-globe-host canvas,
  .earth-globe-canvas { opacity: 0 !important; }
`

async function expectSelectedNode(select: Locator, label: string): Promise<void> {
  await expect(select.locator('option:checked')).toHaveText(label)
}

async function selectQuickLanding(dialog: Locator, label = '香港边缘节点-超长名称布局测试'): Promise<void> {
  await dialog.getByLabel('添加线路落地机').selectOption({ label })
}

async function openTopologyManager(page: Page, trigger: 'manage' | 'empty' = 'manage'): Promise<Locator> {
  if (trigger === 'empty')
    await page.getByRole('button', { name: '配置第一条线路' }).click()
  else
    await page.getByRole('button', { name: '管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-topology-ready="true"]')).toBeVisible({ timeout: 15_000 })
  return dialog
}

async function openStablePage(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  // Full visual runs can briefly saturate Chromium while lazy chunks and test
  // fonts are decoded. Keep the product assertions strict, but give the shared
  // page-ready marker enough time to appear before taking deterministic shots.
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible({ timeout: 10_000 })
  await page.addStyleTag({ content: STABLE_STYLE })
  await page.evaluate(async () => {
    await document.fonts.load('400 16px "Transit Visual Fixture"', '线路 Transit')
    await document.fonts.ready
  })
  await expect(page.locator('body')).toHaveCSS('font-family', /Transit Visual Fixture/)
  await expect.poll(() => page.evaluate(() => document.fonts.check('400 16px "Transit Visual Fixture"', '线路 Transit'))).toBe(true)
  await page.waitForTimeout(700)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
}

async function dragOrderHandle(page: Page, handle: Locator, target: Locator, targetRatio = 0.75): Promise<void> {
  await handle.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()
  const sourceBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox)
    throw new Error('Drag source or target is not visible')

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height, { steps: 4 })
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 })
  await page.waitForTimeout(80)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * targetRatio, { steps: 4 })
  await page.waitForTimeout(80)
  await page.mouse.up()
  await page.mouse.move(1, 1)
  await page.waitForTimeout(200)
}

async function dragOrderHandleByTouch(page: Page, handle: Locator, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  // Keep the source handle in view last. On a vertical mobile grid this also
  // leaves the next compact card visible below it, avoiding a stale source box.
  await handle.scrollIntoViewIfNeeded()
  const sourceBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox)
    throw new Error('Touch drag source or target is not visible')

  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
  const viewport = page.viewportSize()
  const end = {
    x: targetBox.x + targetBox.width / 2,
    y: Math.min(targetBox.y + Math.min(140, targetBox.height * 0.55), (viewport?.height ?? 0) - 16),
  }
  if (!viewport || start.y < 0 || start.y > viewport.height || end.y < 0 || end.y > viewport.height)
    throw new Error(`Touch drag coordinates outside viewport: start=${JSON.stringify(start)}, end=${JSON.stringify(end)}, viewport=${JSON.stringify(viewport)}`)
  await handle.evaluate((element, point) => {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'touch',
    }))
  }, start)
  await page.waitForTimeout(240)
  for (let step = 1; step <= 16; step++) {
    const ratio = step / 16
    const x = start.x + (end.x - start.x) * ratio
    const y = start.y + (end.y - start.y) * ratio
    await page.evaluate(({ x: nextX, y: nextY }) => {
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: nextX,
        clientY: nextY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'touch',
      }))
    }, { x, y })
    await page.waitForTimeout(20)
  }
  // A taller responsive card can place the next item below the viewport.
  // Keep the touch pointer near the lower edge long enough for Sortable's
  // native fallback auto-scroll to bring that item under the pointer.
  for (let step = 0; step < 24; step++) {
    await page.evaluate(({ x: nextX, y: nextY }) => {
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        button: 0,
        buttons: 1,
        cancelable: true,
        clientX: nextX,
        clientY: nextY,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'touch',
      }))
    }, { x: end.x, y: end.y })
    await page.waitForTimeout(30)
  }
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      buttons: 0,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'touch',
    }))
  })
  await page.waitForTimeout(250)
}

async function expectNodeMetricIcons(page: Page): Promise<void> {
  for (const metric of ['cpu', 'memory', 'disk', 'traffic'])
    await expect(page.locator(`[data-node-metric-icon="${metric}"]`).first()).toBeVisible()
}

async function expectNodePingBars(page: Page): Promise<void> {
  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  for (const metric of ['latency', 'loss']) {
    const bars = card.locator(`[data-node-ping-bars="${metric}"]`)
    await expect(bars).toBeVisible()
    await expect(bars.locator('[data-sample-strip][data-sample-kind="ping"]')).toBeVisible()
    await expect.poll(() => bars.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
  }
}

async function expectSharedPingSampleInteraction(page: Page, scope = page.locator('body')): Promise<void> {
  const sample = scope.locator('[data-node-ping-sample][aria-label*="ms"]').first()
  await sample.hover()
  const tooltip = page.locator('[data-node-ping-sample-tooltip]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(/ms/)
  await expect(tooltip).toContainText('丢包')
  await sample.click()
  await expect(tooltip).toBeVisible()
  await page.getByRole('heading', { name: 'Komari Visual Lab' }).click()
  await expect(tooltip).toBeHidden()
}

test('home light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expectNodePingBars(page)
  await expectSharedPingSampleInteraction(page, page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }))
  await expect(page).toHaveScreenshot('home-light-desktop.png', { fullPage: false })
})

test('home dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-dark-mobile.png', { fullPage: false })
})

test('personal wallpaper upload persists with glass, blur and HD effects', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await installKomariFixture(page, { opsDashboard: true })
  await openStablePage(page)

  await expect(page.getByRole('link', { name: '后台管理' })).toHaveAttribute('href', '/admin/servers')
  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  const dialog = page.getByRole('dialog', { name: '壁纸与背景效果' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('选择本机壁纸').setInputFiles(WALLPAPER_FIXTURE)

  const background = page.locator('.background-container')
  await expect(page.getByText('本机壁纸已保存。')).toBeVisible()
  await expect(background).toHaveAttribute('data-personal-wallpaper', 'true')
  await expect(background).toHaveAttribute('data-wallpaper-effect', 'glass')
  await expect(page.locator('html')).toHaveClass(/personal-wallpaper-glass/)
  await expect(dialog.locator('[data-wallpaper-preview]')).toBeVisible()

  await dialog.getByRole('button', { name: /^模糊 / }).click()
  await expect(background).toHaveAttribute('data-wallpaper-effect', 'blur')
  await expect(page.locator('.background-media')).toHaveCSS('filter', 'blur(16px)')

  await dialog.getByRole('button', { name: /^玻璃化 / }).click()
  // Toast lifetime must not decide whether the transient overlay is in the baseline.
  await expect(page.getByText('本机壁纸已保存。')).toBeHidden()
  await expect(dialog).toHaveScreenshot('wallpaper-manager-desktop.png')
  await dialog.getByRole('button', { name: '关闭' }).click()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await expect(background).toHaveAttribute('data-personal-wallpaper', 'true')
  await expect(background).toHaveAttribute('data-wallpaper-effect', 'glass')

  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  await page.getByRole('dialog', { name: '壁纸与背景效果' }).getByRole('button', { name: /^高清 / }).click()
  await expect(background).toHaveAttribute('data-wallpaper-effect', 'hd')
  await expect(page.locator('.background-media')).toHaveCSS('filter', 'none')
  await page.getByRole('dialog', { name: '壁纸与背景效果' }).getByRole('button', { name: '移除壁纸' }).click()
  await expect(page.getByText('本机壁纸已移除。')).toBeVisible()
  await expect(background).not.toHaveAttribute('data-personal-wallpaper', 'true')
})

test('personal wallpaper keeps the previous image when local storage replacement fails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await installKomariFixture(page)
  await openStablePage(page)

  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  const dialog = page.getByRole('dialog', { name: '壁纸与背景效果' })
  const fileInput = dialog.getByLabel('选择本机壁纸')
  await fileInput.setInputFiles(WALLPAPER_FIXTURE)
  await expect(dialog.getByText('preview.png', { exact: true })).toBeVisible()

  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Visual quota failure', 'QuotaExceededError')
    } as IDBObjectStore['put']
  })
  await fileInput.setInputFiles({
    name: 'replacement.png',
    mimeType: 'image/png',
    buffer: await readFile(WALLPAPER_FIXTURE),
  })

  await expect(dialog.getByRole('alert')).toContainText('本地壁纸存储操作失败')
  await expect(dialog.getByText('preview.png', { exact: true })).toBeVisible()
  await expect(page.locator('.background-container')).toHaveAttribute('data-personal-wallpaper', 'true')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  await expect(page.getByRole('dialog', { name: '壁纸与背景效果' }).getByText('preview.png', { exact: true })).toBeVisible()
})

test('personal wallpaper can retry after the initial local database read fails', async ({ page }) => {
  await page.addInitScript(() => {
    const originalOpen = IDBFactory.prototype.open
    const state = { fail: true }
    Object.defineProperty(window, '__transitWallpaperDbTest', { value: state })
    IDBFactory.prototype.open = function (...args: Parameters<IDBFactory['open']>) {
      if (state.fail && args[0] === 'transit-personalization') {
        const request = {} as IDBOpenDBRequest
        queueMicrotask(() => request.onerror?.(new Event('error')))
        return request
      }
      return originalOpen.apply(this, args)
    }
  })
  await installKomariFixture(page)
  await openStablePage(page)

  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  const dialog = page.getByRole('dialog', { name: '壁纸与背景效果' })
  await expect(dialog.getByRole('alert')).toContainText('无法打开本地壁纸存储')
  await page.evaluate(() => {
    const state = (window as unknown as { __transitWallpaperDbTest: { fail: boolean } }).__transitWallpaperDbTest
    state.fail = false
  })
  await dialog.getByRole('button', { name: '重试读取' }).click()

  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(dialog.getByText('尚未上传本机壁纸')).toBeVisible()
})

test.describe('personal wallpaper mobile', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('manager stays in the viewport and rejects unsupported files', async ({ page }) => {
    await installKomariFixture(page, { dark: true })
    await openStablePage(page)

    await page.getByRole('button', { name: '壁纸与背景效果' }).click()
    const dialog = page.getByRole('dialog', { name: '壁纸与背景效果' })
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await dialog.getByLabel('选择本机壁纸').setInputFiles({
      name: 'unsafe.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    })
    await expect(dialog.getByRole('alert')).toContainText('仅支持 JPG、PNG、WebP 或 AVIF')
    await expect(page.locator('.background-container')).not.toHaveAttribute('data-personal-wallpaper', 'true')
    await expect(dialog).toHaveScreenshot('wallpaper-manager-mobile.png')
  })
})

test('announcement renders literal symbols without double escaping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { announcementEscaping: true })
  await openStablePage(page)

  const announcement = page.getByText('Status <green> & healthy', { exact: true })
  await expect(announcement).toBeVisible()
  await expect(announcement).toHaveText('Status <green> & healthy')
})

test('Transit light desktop uses light surfaces and readable telemetry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true })
  await openStablePage(page)

  const assetValue = page.locator('#asset-summary .telemetry-item strong').first()
  await expect(assetValue).toHaveCSS('color', 'rgb(30, 41, 59)')
  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
  await expect(nodeCard).toHaveCSS('background-color', LIGHT_NODE_SURFACE)
  await expect(nodeCard.getByRole('heading', { name: '主控-洛杉矶' })).toHaveCSS('color', /oklch\(0\.208/)
  await expect(page.getByLabel(/当前入口/).first()).toHaveCSS('color', /oklch\(0\.279/)

  const sample = nodeCard.locator('[data-carrier-sample][aria-label*="ms"]').first()
  await sample.hover()
  const tooltip = page.locator('[data-carrier-sample-tooltip]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toHaveCSS('background-color', /oklab\(.+\/ 0\.96\)/)
  // Hover may scroll the taller telemetry cards into view; capture the dashboard from its top.
  await page.mouse.move(0, 0)
  await expect(tooltip).toBeHidden()
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page).toHaveScreenshot('transit-light-desktop.png', { fullPage: false })
})

test('Transit light mobile keeps the vertical route readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { opsDashboard: true })
  await openStablePage(page)

  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(2)
  await expect(page.locator('.topology-scroll')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')).toHaveCSS('background-color', LIGHT_NODE_SURFACE)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
  await expect(page).toHaveScreenshot('transit-light-mobile.png', { fullPage: false })
})

test('Transit dark asset summary keeps a readable text hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true })
  await openStablePage(page)

  const telemetry = page.locator('#asset-summary .telemetry-item')
  await expect(telemetry.first()).toHaveCSS('color', 'rgb(148, 163, 184)')
  await expect(telemetry.first().locator('strong')).toHaveCSS('color', 'rgb(226, 232, 240)')
  await expect(telemetry.nth(1).locator('em')).toHaveCSS('color', 'rgb(125, 142, 166)')
  await expect(page).toHaveScreenshot('transit-dark-desktop.png', { fullPage: false })
})

test('Transit desktop topology and cards remain contained', async ({ page }) => {
  const reliabilityRequests: Array<{ method?: string, params?: Record<string, unknown> }> = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if ((payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats') && payload.params?.max_points === 240)
      reliabilityRequests.push(payload)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true })
  await openStablePage(page)

  await expect.poll(() => reliabilityRequests.length).toBe(4)
  expect(reliabilityRequests.every(request => Array.isArray(request.params?.entity_ids) && request.params.entity_ids.length === 2)).toBe(true)
  expect(reliabilityRequests.some(request => request.params?.entity_id !== undefined)).toBe(false)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  await expect(page.locator('[data-transit-alert-strip]')).toBeVisible()
  const alertStrip = page.locator('[data-transit-alert-strip]')
  await expect(alertStrip.getByRole('heading', { name: '11 个异常需要关注' })).toBeVisible()
  await expect(alertStrip.getByRole('button', { name: '另有 7 个' })).toBeVisible()
  const topologySection = page.getByRole('heading', { name: '线路状态' }).locator('xpath=ancestor::section[1]')
  await expect.poll(async () => {
    const [alertBox, topologyBox] = await Promise.all([alertStrip.boundingBox(), topologySection.boundingBox()])
    return alertBox && topologyBox ? Math.round(topologyBox.y - alertBox.y - alertBox.height) : 0
  }).toBe(12)
  await expect(page.locator('[data-topology-direction]')).toHaveCount(3)
  const topologyScroll = topologySection.locator('.topology-scroll')
  const firstDesktopRoute = topologySection.locator('[data-topology-route]').first()
  await expect.poll(async () => {
    const [scrollBox, routeBox] = await Promise.all([topologyScroll.boundingBox(), firstDesktopRoute.boundingBox()])
    return scrollBox && routeBox ? Math.round(Math.abs(scrollBox.width - routeBox.width)) : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(40)
  const routeScores = page.locator('[data-topology-route-score]')
  await expect(routeScores).toHaveCount(2)
  await expect(routeScores.first()).toContainText(/\d+ 分/)
  const historyButtons = page.getByRole('button', { name: /查看线路历史/ })
  await expect(historyButtons).toHaveCount(4)
  await expect(historyButtons.first()).toHaveAttribute('aria-label', /探测来源：[^，]+，当前：证据不足，近 1 小时平均 [^，]+，探测失败率 [^，]+，查看线路历史/)
  await expect(page.locator('[data-topology-status]')).toHaveCount(0)
  for (const line of await page.locator('[data-topology-edge-line]').all()) {
    await expect.poll(() => line.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(150)
    await expect.poll(() => line.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(600)
  }
  const samples = page.locator('[data-topology-sample]')
  await expect(samples).toHaveCount(30)
  const sampleHeights = await samples.evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-topology-sample-height'))))
  expect(sampleHeights.every(height => height >= 5 && height <= 9)).toBe(true)
  const segmentGroups = page.locator('[data-topology-edge-samples]')
  await expect(segmentGroups).toHaveCount(3)
  for (const segment of await segmentGroups.all())
    await expect(segment.locator('[data-topology-sample]')).toHaveCount(10)
  const healthySubMillisecondSamples = segmentGroups.nth(2).locator('[data-topology-sample][aria-label*="<1ms"][aria-label*="探测失败率 0.0%"]')
  await expect.poll(() => healthySubMillisecondSamples.count()).toBeGreaterThan(0)
  await expect.poll(() => healthySubMillisecondSamples.evaluateAll(samples => samples.every(sample => sample.firstElementChild?.classList.contains('bg-emerald-400')))).toBe(true)
  await expect(page.locator('[data-topology-static-samples]')).toHaveCount(0)
  const staticLabel = page.locator('[data-topology-probe-mode-label][data-probe-mode="static"]')
  await expect(staticLabel).toHaveCount(1)
  await expect(staticLabel).toHaveText('静态')
  await expect(staticLabel.locator('xpath=ancestor::*[@title][1]')).toHaveAttribute('title', '静态基线')
  const averageRenderedHeight = async (groupIndex: number) => {
    const heights = await segmentGroups.nth(groupIndex).locator('[data-topology-sample]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-topology-sample-height'))))
    return heights.reduce((sum, height) => sum + height, 0) / heights.length
  }
  expect(Math.abs(await averageRenderedHeight(1) - await averageRenderedHeight(2))).toBeLessThan(2)
  await expect(segmentGroups.nth(1).locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /\d{2,3}ms/)
  await expect(segmentGroups.nth(2).locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /(?:<1|[12])ms/)
  const firstSample = samples.first()
  await firstSample.hover()
  const sampleDetail = page.locator('[data-topology-sample-detail]')
  await expect(sampleDetail).toBeVisible()
  await expect(sampleDetail).toContainText(/(?:<1|\d+)ms/)
  await expect(sampleDetail).toContainText('探测失败率')
  await expect(sampleDetail).toContainText(/\d{2}:\d{2}:\d{2}/)
  await expect(firstSample).toHaveAttribute('aria-label', /ms，探测失败率/)
  await expect(firstSample).toHaveAttribute('data-sample-trigger', '')
  await expect(firstSample.locator('xpath=..')).toHaveAttribute('data-sample-kind', 'topology')
  const firstSampleGroup = firstSample.locator('xpath=..')
  await firstSampleGroup.focus()
  await firstSampleGroup.press('End')
  const initialActiveSample = await firstSampleGroup.getAttribute('aria-activedescendant')
  expect(initialActiveSample).toBeTruthy()
  await firstSampleGroup.press('ArrowLeft')
  await expect(firstSampleGroup).not.toHaveAttribute('aria-activedescendant', initialActiveSample!)
  await expect(firstSampleGroup.getByRole('option', { selected: true })).toHaveCount(1)
  const firstMetric = page.locator('[data-topology-current-metric]').first()
  const firstBaseline = page.locator('[data-topology-edge-baseline]').first()
  await expect.poll(async () => {
    const [metricBox, baselineBox] = await Promise.all([firstMetric.boundingBox(), firstBaseline.boundingBox()])
    return Boolean(metricBox && baselineBox && metricBox.y > baselineBox.y + baselineBox.height)
  }).toBe(true)
  await firstSampleGroup.press('Escape')
  await expect(sampleDetail).toBeHidden()
  await historyButtons.first().click()
  await expect(page.getByRole('dialog')).toContainText('当前连通性与历史统计分开显示；TCP 探测失败率不代表业务流量丢包。')
  await expect(page.getByRole('dialog')).toContainText('健康评分')
  await expect(page.getByRole('dialog').locator('[data-topology-score-detail]')).toContainText('1/2 段有数据')
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '查看异常时间线' }).click()
  const timelineDialog = page.getByRole('dialog', { name: '异常时间线' })
  await expect(timelineDialog).toBeVisible()
  await expect(timelineDialog.locator('[data-transit-incident-event]').first()).toBeVisible()
  await timelineDialog.getByRole('button', { name: '关闭' }).click()
  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(nodeCard).toBeVisible()
  const nodeCardSurface = nodeCard.locator('xpath=..')
  await expect(nodeCardSurface.locator('.transit-node-card__header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nodeCardSurface.locator('.transit-node-card__header')).toHaveCSS('border-bottom-width', '0px')
  const healthyCard = page.getByRole('button', { name: '查看节点 香港边缘节点-超长名称布局测试 详情' }).locator('xpath=..')
  await expect(healthyCard).toHaveAttribute('data-node-status-edge', '')
  await expect(healthyCard).not.toHaveAttribute('data-node-alert-edge', '')
  const healthyStatusRail = healthyCard.locator('[data-node-status-rail]')
  await expect(healthyStatusRail).toHaveCSS('width', '7px')
  await expect(healthyStatusRail).toHaveCSS('inset-inline-start', '0px')
  await expect(healthyStatusRail).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect.poll(() => healthyCard.evaluate((card) => {
    const name = card.querySelector<HTMLElement>('[data-node-name]')
    if (!name)
      return Number.NEGATIVE_INFINITY
    const cardBox = card.getBoundingClientRect()
    const borderWidth = Number.parseFloat(getComputedStyle(card).borderLeftWidth)
    return name.getBoundingClientRect().left - cardBox.left - borderWidth
  })).toBeGreaterThanOrEqual(22)
  await expect.poll(() => healthyCard.evaluate((card) => {
    const name = card.querySelector<HTMLElement>('[data-node-name]')
    const content = card.querySelector<HTMLElement>('[data-node-resource-grid]')
    if (!name || !content)
      return Number.POSITIVE_INFINITY
    return Math.abs(name.getBoundingClientRect().left - content.getBoundingClientRect().left)
  })).toBeLessThanOrEqual(0.5)
  const carrierSample = nodeCardSurface.locator('[data-carrier-sample][aria-label*="ms"]').first()
  await carrierSample.hover()
  const carrierTooltip = page.locator('[data-carrier-sample-tooltip]')
  await expect(carrierTooltip).toBeVisible()
  await expect(carrierTooltip).toContainText(/ms/)
  await expect(carrierTooltip).toContainText('探测失败率')
  await expect(carrierTooltip).toHaveAttribute('data-sample-kind', 'carrier')
  await page.getByRole('heading', { name: '线路状态' }).hover()
  await expect(carrierTooltip).toBeHidden()
  await carrierSample.click()
  await expect(carrierTooltip).toBeVisible()
  await expect(page).toHaveURL('/')
  const carrierStrip = carrierSample.locator('xpath=..')
  await carrierStrip.focus()
  await carrierStrip.press('ArrowLeft')
  await expect(carrierTooltip).toBeVisible()
  await carrierStrip.press('Escape')
  await expect(carrierTooltip).toBeHidden()
  await carrierSample.click()
  await page.getByRole('heading', { name: '线路状态' }).click()
  await expect(carrierTooltip).toBeHidden()
  const topologySamples = page.locator('[data-topology-sample]')
  await expect(topologySamples.first()).toHaveAttribute('aria-label', /探测来源：主控-洛杉矶 · Ping 任务：北京电信/)
  await expect(topologySamples.first()).not.toHaveAttribute('aria-label', /北京电信到主控-洛杉矶/)
  await expect(page.locator('[data-node-alert-reason]').first()).toBeVisible()
  const alertCard = page.getByRole('button', { name: '查看节点 东京-高负载 详情' }).locator('xpath=..')
  const plainCard = page.getByRole('button', { name: '查看节点 伦敦-离线归档 详情' }).locator('xpath=..')
  const alertReason = alertCard.locator('[data-node-alert-reason]')
  await expect(alertReason).toBeVisible()
  await expect(alertReason).toHaveCSS('border-top-width', '0px')
  await expect(alertCard).toHaveAttribute('data-node-alert-edge', '')
  await expect(alertCard.locator('[data-node-status-rail]')).toHaveCSS('width', '7px')
  await expect(plainCard).not.toHaveAttribute('data-node-status-edge', '')
  await expect(plainCard.locator('[data-node-status-rail]')).toHaveCSS('width', '7px')
  await expect(plainCard.locator('[data-node-alert-reason]')).toHaveCount(0)
  await alertReason.hover()
  await expect(page.locator('[data-node-alert-tooltip]')).toContainText('CPU 96.4%')
  await page.getByRole('heading', { name: '线路状态' }).hover()
  await expect(page.locator('[data-node-alert-tooltip]')).toBeHidden()
  await expect.poll(async () => {
    const [alertBox, plainBox] = await Promise.all([alertCard.boundingBox(), plainCard.boundingBox()])
    return alertBox && plainBox ? Math.abs(alertBox.height - plainBox.height) : Number.POSITIVE_INFINITY
  }).toBeLessThan(1)
  await expect.poll(async () => {
    const [alertBox, alertResourceBox, plainBox, plainResourceBox] = await Promise.all([
      alertCard.boundingBox(),
      alertCard.locator('[data-node-resource-grid]').boundingBox(),
      plainCard.boundingBox(),
      plainCard.locator('[data-node-resource-grid]').boundingBox(),
    ])
    if (!alertBox || !alertResourceBox || !plainBox || !plainResourceBox)
      return Number.POSITIVE_INFINITY
    return Math.abs((alertResourceBox.y - alertBox.y) - (plainResourceBox.y - plainBox.y))
  }).toBeLessThan(1)
  const expiryDate = page.getByRole('button', { name: '查看节点 台北-流量预警 详情' }).locator('xpath=..').locator('[data-node-expiry-date]')
  await expect(expiryDate).toHaveText('2026-08-02')
  await expect.poll(() => expiryDate.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
  await nodeCard.click({ position: { x: 18, y: 18 } })
  await expect(page).toHaveURL('/instance/00000000-0000-4000-8000-000000000001')
})

test('Transit ranks comparable routes with real reliability windows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsComparableRoutes: true })
  await openStablePage(page)

  const rankings = page.locator('[data-topology-route-ranking]')
  await expect(rankings).toHaveCount(2)
  const recommendation = page.locator('[data-topology-route-ranking="推荐"]')
  await expect(recommendation).toHaveCount(1)
  await expect(page.locator('[data-topology-route-ranking^="#"]')).toHaveCount(1)

  await recommendation.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[data-topology-detail-ranking]')).toContainText(/香港方向第 1 \/ 2/)
  await expect(dialog).toContainText('推荐依据')
  await expect(dialog).toContainText('24h 可用率')
  await expect(dialog).toContainText('7d 可用率')
  await expect(dialog).toContainText('24h P95')
  await expect(dialog).toContainText('相对智能基线')
  await expect(dialog).toContainText(/\d+\.\d+%/)
  await expect(dialog.locator('[data-topology-score-detail]')).toContainText('基线稳定')
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('Transit exposes topology insights without changing public route health', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as typeof window & { __copiedTopologyReport?: string }).__copiedTopologyReport = value
        },
      },
    })
  })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsTopologyInsights: true })
  await openStablePage(page)

  const baselineLabels = page.locator('[data-topology-baseline-shift]')
  const peakLabels = page.locator('[data-topology-peak-insight-home]')
  await expect(baselineLabels).toHaveCount(1)
  await expect(baselineLabels.first()).toContainText(/基线升高 \+70ms/)
  await expect(peakLabels).toHaveCount(1)
  await expect(peakLabels.first()).toContainText(/晚高峰 \+60ms/)
  await expect(page.locator('[data-topology-route-status][data-status="healthy"]')).toHaveCount(2)

  await baselineLabels.first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('[data-topology-direction-pair]')).toBeVisible()
  await expect(dialog.locator('[data-topology-direction-pair]')).toContainText('PandaOps-Local-Hop')
  await expect(dialog.locator('[data-topology-direction-pair]')).toContainText('00000000-0000-4000-8000-000000000001')
  await expect(dialog.locator('[data-topology-direction-delta]')).toBeVisible()
  await expect(dialog.locator('[data-topology-diagnosis]').first()).toContainText('可能存在排队或路径时延上升')
  await expect(dialog.locator('[data-topology-baseline-shift-detail]').first()).toContainText('可能与路径、探测方式或目标变化有关')
  await expect(dialog.locator('[data-topology-insight-evidence]')).toHaveCount(2)
  await expect(dialog.locator('[data-topology-insight-evidence]').first()).toContainText('24h 延迟基线')
  await expect(dialog.locator('[data-topology-insight-evidence]').first()).toContainText('7d 覆盖')
  await expect(dialog.locator('[data-topology-peak-insight]')).toHaveCount(2)
  await expect(dialog.locator('[data-topology-peak-insight]').first()).toContainText(/晚高峰延迟高 60 ms/)

  await dialog.locator('[data-copy-topology-diagnostic]').click()
  await expect(page.getByText('线路诊断已复制')).toBeVisible()
  const copiedReport = await page.evaluate(() => (window as typeof window & { __copiedTopologyReport?: string }).__copiedTopologyReport ?? '')
  expect(copiedReport).toContain(`Transit v${THEME_VERSION} 线路诊断`)
  expect(copiedReport).toContain('晚高峰延迟高 60 ms')
  expect(copiedReport).not.toContain('00000000-0000-4000-8000-000000000001')
  expect(copiedReport).not.toContain('PandaOps-Local-Hop')

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => Promise.reject(new Error('permission denied')) },
    })
  })
  await dialog.locator('[data-copy-topology-diagnostic]').click()
  await expect(page.getByText('复制失败，请检查浏览器剪贴板权限')).toBeVisible()

  const profiles = dialog.locator('[data-topology-hourly-profile]')
  await expect(profiles).toHaveCount(2)
  await expect(profiles.first()).toContainText('20:00–23:00 晚高峰')
  const hourlyStrip = profiles.first().locator('[data-sample-strip]')
  await expect(hourlyStrip.locator('[data-topology-sample]')).toHaveCount(24)
  await hourlyStrip.focus()
  await hourlyStrip.press('Home')
  const firstActive = await hourlyStrip.getAttribute('aria-activedescendant')
  expect(firstActive).toBeTruthy()
  await hourlyStrip.press('ArrowRight')
  await expect(hourlyStrip).not.toHaveAttribute('aria-activedescendant', firstActive!)
  await expect(page.locator('[data-topology-sample-detail]')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(2)
  await expect(page.locator('[data-topology-mobile-route]').first().locator('[data-topology-baseline-shift]')).toBeVisible()
  await expect(page.locator('[data-topology-mobile-route]').first().locator('[data-topology-peak-insight-home]')).toBeVisible()
  await page.locator('[data-topology-mobile-route]').first().locator('[data-topology-baseline-shift]').click()
  const mobileDialog = page.getByRole('dialog')
  await expect(mobileDialog.locator('[data-topology-direction-pair]')).toBeVisible()
  await expect.poll(() => mobileDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('Transit mobile keeps document width contained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { opsDashboard: true, dark: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  const mobileTelemetry = page.locator('#asset-summary .transit-telemetry-grid')
  await expect.poll(() => mobileTelemetry.evaluate((element) => {
    const style = getComputedStyle(element)
    return style.gridTemplateColumns.split(' ').filter(Boolean).length
  })).toBe(3)
  await expect.poll(() => mobileTelemetry.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const mobileAlertStrip = page.locator('[data-transit-alert-strip]')
  await expect(mobileAlertStrip.getByRole('heading', { name: '11 个异常需要关注' })).toBeVisible()
  await expect(mobileAlertStrip.getByRole('button', { name: '另有 9 个' })).toBeVisible()
  await mobileAlertStrip.getByRole('button', { name: '另有 9 个' }).click()
  await expect(mobileAlertStrip.getByRole('button', { name: '收起' })).toBeVisible()
  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(2)
  await expect(page.locator('[data-topology-peak-insight-home]')).toHaveCount(0)
  await expect(page.locator('.topology-scroll')).toHaveCount(0)
  await expect(page.locator('[data-topology-mobile-node]')).toHaveCount(4)
  const firstMobileRoute = page.locator('[data-topology-mobile-route]').first()
  await expect.poll(() => firstMobileRoute.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(150)
  const mobileSample = firstMobileRoute.locator('[data-topology-sample]').first()
  await mobileSample.click()
  await expect(page.locator('[data-sample-tooltip][data-sample-kind="topology"]')).toBeVisible()
  const singaporeDirection = page.getByRole('button', { name: '新加坡方向 1' })
  await singaporeDirection.click()
  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(1)
  await expect(page.locator('[data-topology-telemetry-observer]')).toHaveCount(2)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
})

test('Transit mobile topology manager remains contained and scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const scrollArea = dialog.locator('> div').last()
  await expect.poll(() => scrollArea.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeVisible()
  await dialog.getByRole('button', { name: '添加线路' }).click()
  const generatedRoute = dialog.locator('[data-topology-route-id]').last()
  await expect(generatedRoute).toBeInViewport()
  await expect(generatedRoute.getByLabel('第 3 条线路入口探测')).toBeFocused()
  await expect.poll(() => dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
})

test('reduced motion disables interface animations and smooth back-to-top scrolling', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installKomariFixture(page, { opsDashboard: true, visitorInfoEnabled: true })
  await openStablePage(page)

  await expect.poll(() => page.getByRole('button', { name: '壁纸与背景效果' }).evaluate((element) => {
    const style = getComputedStyle(element)
    return Math.max(...style.transitionDuration.split(',').map(value => Number.parseFloat(value) || 0))
  })).toBeLessThanOrEqual(0.01)

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const backTop = page.getByRole('button', { name: '返回顶部' })
  await expect(backTop).toBeVisible()
  await page.evaluate(() => {
    const original = window.scrollTo.bind(window)
    window.scrollTo = ((...args: Parameters<typeof window.scrollTo>) => {
      const first = args[0]
      if (typeof first === 'object')
        document.documentElement.dataset.backTopBehavior = first.behavior || ''
      original(...args)
    }) as typeof window.scrollTo
  })
  await backTop.click()
  await expect(page.locator('html')).toHaveAttribute('data-back-top-behavior', 'instant')
})

test('Transit topology reports an unresolved configured node as an error', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsMissingNode: true })
  await openStablePage(page)

  await expect(page.getByText(/1 异常/)).toBeVisible()
  await expect(page.locator('[data-topology-route-status][data-status="error"]')).toHaveCount(1)
  await expect(page.getByText('异常', { exact: true })).toHaveCount(0)
})

test('Transit keeps a configured first-segment static baseline static', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsStaticFirstMetric: true })
  await openStablePage(page)

  const firstMetric = page.locator('[data-topology-current-metric]').first()
  await expect(firstMetric).toContainText('51ms')
  await expect(firstMetric.locator('[data-topology-probe-mode-label][data-probe-mode="static"]')).toHaveText('静态')
  await expect(firstMetric.locator('xpath=..')).toHaveAttribute('title', /^静态基线/)
  await expect(firstMetric.locator('xpath=..')).not.toHaveAttribute('data-topology-edge-samples', '')
})

test('Transit shows an automatic segment as waiting for a task instead of a static baseline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    dark: true,
    opsJsonTopologyOnly: true,
    opsAutoFirstMetric: true,
    topologyAutoRepairEnabled: false,
  })
  await openStablePage(page)

  const firstMetric = page.locator('[data-topology-current-metric]').first()
  await expect(firstMetric.locator('xpath=..')).toHaveAttribute('title', /^等待自动创建探测任务/)
  await expect(firstMetric.locator('xpath=..')).not.toHaveAttribute('title', /^静态基线/)
  await expect(firstMetric.locator('[data-topology-probe-mode-label][data-probe-mode="auto"]')).toHaveText('待探测')
})

test('opening topology manager never promotes an explicit static hop to a live task', async ({ page }) => {
  const addedTasks: Array<Record<string, unknown>> = []
  const saves: Array<Record<string, unknown>> = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)
  page.on('request', (request) => {
    if (request.method() !== 'POST')
      return
    if (request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addedTasks.push(request.postDataJSON().params as Record<string, unknown>)
    if (request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON() as Record<string, unknown>)
  })

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await expect(firstRoute).toHaveAttribute('data-topology-hop-task', '')
  await expect(firstRoute).toHaveAttribute('data-topology-hop-pending', 'false')
  expect(addedTasks).toEqual([])
  expect(saves).toEqual([])
})

test('Transit matches topology Ping tasks exactly instead of aggregating similarly named tasks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsOverlappingTask: true })
  await openStablePage(page)

  await expect(page.locator('[data-topology-current-metric]').first()).toContainText('112ms')
  await expect(page.locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /Ping 任务：北京电信/)
})

test('Transit preserves task names when topology falls back to legacy Ping records', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsLegacyPingFallback: true })
  await openStablePage(page)

  await expect(page.locator('[data-topology-current-metric]').first()).toContainText('112ms')
  await expect(page.locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /Ping 任务：北京电信/)
})

test('Transit marks an external offline Ping source as offline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsExternalOfflineSource: true })
  await openStablePage(page)

  const firstRoute = page.locator('.topology-scroll article').first()
  await expect(firstRoute.locator('[data-topology-route-status]')).toHaveAttribute('data-status', 'offline')
  await expect(firstRoute.locator('[data-topology-current-metric]').first().locator('xpath=..')).toHaveAttribute('title', /探测来源节点已离线/)
  await expect(page.getByText(/1 失联/)).toBeVisible()
})

test('Transit treats complete Ping loss as an error', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsSevereLoss: true })
  await openStablePage(page)

  const firstRoute = page.locator('.topology-scroll article').first()
  await expect(firstRoute.locator('[data-topology-route-status]')).toHaveAttribute('data-status', 'error')
  const metric = firstRoute.locator('[data-topology-current-metric]').first()
  await expect(metric).toContainText('无响应')
  await expect(metric).toContainText('100.0%')
  await expect(metric).not.toContainText('0ms')
})

test('Transit keeps extreme latency status consistent between the route and segment detail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsExtremeLatency: true })
  await openStablePage(page)

  const firstRoute = page.locator('.topology-scroll article').first()
  await expect(firstRoute.locator('[data-topology-route-status]')).toHaveAttribute('data-status', 'error')
  await firstRoute.locator('[data-topology-route-score]').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('延迟异常')
  await expect(dialog).not.toContainText('实时稳定')
})

test('Transit keeps an open route detail synchronized with delayed telemetry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsMetricDelayMs: 2_000 })
  await openStablePage(page)

  await page.locator('[data-topology-route-score]').first().click()
  const scoreLabel = page.getByRole('dialog').locator('[data-topology-detail-score-label]')
  await expect(scoreLabel).toHaveText('待数据')
  await expect(scoreLabel).not.toHaveText('待数据', { timeout: 5_000 })
})

test('Transit preserves a custom first-segment task and entry label', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsCustomFirstMetric: true })
  await openStablePage(page)

  const customEntry = page.getByLabel('当前入口 北京联通家宽，点击切换').first()
  await expect(customEntry).toBeVisible()
  await expect(customEntry).toHaveAttribute('title', '北京联通家宽')
  expect((await customEntry.boundingBox())?.width ?? 0).toBeGreaterThan(90)
  await expect(page.locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /Ping 任务：Relay-JP-to-Exit-US/)
})

test('Transit does not replace a custom first-segment task when the entry uses a preset label', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, opsKnownEntryCustomTask: true })
  await openStablePage(page)

  await expect(page.getByLabel('当前入口 北京电信，点击切换').first()).toBeVisible()
  await expect(page.locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /Ping 任务：Relay-JP-to-Exit-US/)
  await expect(page.locator('[data-topology-current-metric]').first()).toContainText('77ms')

  const probe = page.locator('select[aria-label^="当前入口"]').first()
  const firstEdge = page.locator('[data-topology-current-metric]').first().locator('xpath=..')
  await probe.selectOption('shanghai-telecom')
  await expect(firstEdge).toHaveAttribute('title', /上海电信/)
  await expect(probe.locator('option').first()).toContainText('恢复原始配置')
  await probe.selectOption('')
  await expect(firstEdge).toHaveAttribute('title', /Relay-JP-to-Exit-US/)
})

test('Transit renders topology from the JSON config alone, with the legacy fields empty', async ({ page }) => {
  // 新装或已迁移的站点只有 topologyConfig。读路径必须完全不依赖旧的两条字符串，
  // 否则迁移完成的那一刻首页就空了。
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, opsJsonTopologyOnly: true })
  await openStablePage(page)

  // 两条线路都从 JSON 解析出来
  await expect(page.locator('[data-topology-route-status]')).toHaveCount(2)
  // 节点名来自 JSON 的 nodes 数组
  const firstRoute = page.locator('[data-topology-route]').first()
  await expect(firstRoute).toContainText('北京电信')
  await expect(firstRoute).toContainText('主控-洛杉矶')
  await expect(firstRoute).toContainText('香港边缘节点-超长名称布局测试')
  await expect(firstRoute.locator('[data-topology-line-node]')).toHaveCSS('justify-content', 'center')
  // 实时绑定也要跟着 JSON 走，而不是退回静态基线。
  await expect(page.locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /Ping 任务：北京电信/)
})

test('Transit renders and edits a two-node topology with a trailing empty slot without a phantom segment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true, opsTwoNodeRoute: true, opsTrailingEmptyNode: true })
  await openStablePage(page)

  const desktopRoutes = page.locator('.topology-scroll article')
  await expect(desktopRoutes.first().locator('[data-topology-current-metric]')).toHaveCount(1)
  await expect.poll(async () => {
    const route = desktopRoutes.first()
    const entry = route.locator(':scope > div').first()
    const landing = route.locator(':scope > button').last()
    const [routeBox, entryBox, landingBox] = await Promise.all([route.boundingBox(), entry.boundingBox(), landing.boundingBox()])
    return Boolean(routeBox && entryBox && landingBox
      && landingBox.x > routeBox.x + routeBox.width * 0.7
      && entryBox.x < routeBox.x + routeBox.width * 0.2)
  }).toBe(true)
  const dialog = await openTopologyManager(page)
  await expect(dialog.getByLabel('第 1 条线路落地机')).toBeVisible()
  await expect(dialog.getByLabel('第 1 条线路落地机')).toHaveValue('')
})

test('Transit empty topology guides an authenticated operator into the manager', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '还没有配置线路' })).toBeVisible()
  await page.getByRole('button', { name: '配置第一条线路' }).click()
  await expect(page.getByRole('heading', { name: '拓扑管理' })).toBeVisible()
})

test('Transit topology manager creates both the entry and hop tasks when no task exists', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true, quickTopologyNoTasks: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  const route = dialog.locator('[data-topology-route-id]').first()
  await expect(dialog.getByLabel('第 1 条线路入口探测')).toHaveValue('beijing-telecom')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '主控-洛杉矶')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路落地机'), '香港边缘节点-超长名称布局测试')
  // 入口段线路机上没有名为「北京电信」的任务时，Transit 会自动建一个指向该
  // 运营商落地测速点的 ICMP 任务并绑定，不再停留在静态基线。
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(route).toHaveAttribute('data-topology-hop-task', 'Transit-主控-洛杉矶-to-香港边缘节点-超长名称布局测试')
  await expect(dialog).toBeVisible()
  await expect.poll(() => saves.length).toBe(1)
  // 线路机/落地机的 uuid 也写进配置，只比名称部分。
  const saved = saves[0] as { topologyRoute: string, topologyMetrics: string }
  expect(saved.topologyRoute.split(';').map(node => node.split('|')[0])).toEqual([
    '北京电信',
    '主控-洛杉矶',
    '香港边缘节点-超长名称布局测试',
  ])
  expect(saved.topologyMetrics).toBe('live@主控-洛杉矶@北京电信@-@-;live@主控-洛杉矶@Transit-主控-洛杉矶-to-香港边缘节点-超长名称布局测试@-@-')

  // 主题替操作者建了两个后端任务，事后必须能查到是什么时候、由什么触发建的。
  const writeLog = dialog.locator('[data-topology-write-log]')
  await expect(writeLog).toBeVisible()
  await expect(writeLog).toContainText('创建入口探测任务 北京电信')
  await expect(writeLog).toContainText('手动操作')
})

test('Transit topology creates and renders an optional jumper without manual tasks', async ({ page }) => {
  const saves: Array<{ topologyConfig?: string }> = []
  const addedTasks: Array<Record<string, unknown>> = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true, quickTopologyNoTasks: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addedTasks.push(request.postDataJSON().params as Record<string, unknown>)
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await dialog.getByLabel('添加线路入口探测').selectOption('__custom_probe__')
  await dialog.getByLabel('自定义入口名称').fill('深圳家宽')
  await dialog.getByLabel('自定义入口探测目标').fill('202.97.0.1')
  await dialog.getByLabel('添加线路线路机').selectOption({ label: '主控-洛杉矶' })
  await dialog.getByLabel('添加线路跳板').selectOption({ label: '东京-高负载' })
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '新加坡-A100' })
  await dialog.getByRole('button', { name: '添加线路' }).click()

  const route = dialog.locator('[data-topology-route-id]').first()
  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '主控-洛杉矶')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路跳板'), '东京-高负载')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路落地机'), '新加坡-A100')
  await expect(route).toHaveAttribute('data-topology-hop-task', 'Transit-主控-洛杉矶-to-东京-高负载')
  await expect(route).toHaveAttribute('data-topology-final-task', 'Transit-东京-高负载-to-新加坡-A100')
  await expect.poll(() => saves.length).toBe(1)
  await expect.poll(() => addedTasks.length).toBe(3)
  expect(addedTasks.some(params => JSON.stringify(params).includes('202.97.0.1'))).toBe(true)
  const quickEntrySelect = dialog.getByLabel('添加线路入口探测')
  await expect(quickEntrySelect.getByRole('option', { name: '深圳家宽 · 202.97.0.1' })).toHaveCount(1)
  await quickEntrySelect.selectOption({ label: '北京电信' })
  await quickEntrySelect.selectOption({ label: '深圳家宽 · 202.97.0.1' })
  await expect(dialog.getByLabel('自定义入口名称', { exact: true })).toHaveValue('深圳家宽')
  await expect(dialog.getByLabel('自定义入口探测目标', { exact: true })).toHaveValue('202.97.0.1')

  const payload = JSON.parse(saves[0]?.topologyConfig ?? '{}') as { routes?: Array<{ nodes?: Array<{ name?: string, role?: string, probeTarget?: string }>, metrics?: unknown[] }> }
  expect(payload.routes?.[0]?.nodes?.map(node => [node.name, node.role, node.probeTarget])).toEqual([
    ['深圳家宽', '入口', '202.97.0.1'],
    ['主控-洛杉矶', '线路机', undefined],
    ['东京-高负载', '跳板', undefined],
    ['新加坡-A100', '落地机', undefined],
  ])
  expect(payload.routes?.[0]?.metrics).toHaveLength(3)

  await dialog.getByRole('button', { name: '关闭' }).click()
  const homeRoute = page.locator('[data-topology-route]').first()
  await expect(homeRoute).toContainText('深圳家宽')
  await expect(homeRoute).toContainText('东京-高负载')
  await expect(homeRoute.locator('[data-topology-current-metric]')).toHaveCount(3)
})

test('Transit topology manager adds a relay-only route when the optional landing is not selected', async ({ page }) => {
  const saves: Array<{ topologyRoute?: string, topologyMetrics?: string }> = []
  const addedTasks: Array<Record<string, unknown>> = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true, quickTopologyNoTasks: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addedTasks.push(request.postDataJSON().params as Record<string, unknown>)
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await expect(dialog.getByLabel('添加线路落地机')).toHaveValue('')
  await expect(dialog.getByLabel('添加线路落地机').locator('option:checked')).toHaveText('不选（仅入口 → 线路机）')
  await dialog.getByRole('button', { name: '添加线路' }).click()

  const route = dialog.locator('[data-topology-route-id]').first()
  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '主控-洛杉矶')
  await expect(dialog.getByLabel('第 1 条线路落地机')).toHaveValue('')
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(route).toHaveAttribute('data-topology-hop-task', '')
  await expect(route.locator('[data-topology-hop-hint]')).toHaveCount(0)
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]?.topologyRoute?.split(';').map(node => node.split('|')[0])).toEqual(['北京电信', '主控-洛杉矶'])
  expect(saves[0]?.topologyMetrics).toBe('live@主控-洛杉矶@北京电信@-@-')
  expect(addedTasks).toHaveLength(1)
  expect(addedTasks[0]?.name).toBe('北京电信')
})

test('Transit topology creates a TCP hop when the relay cannot use ICMP', async ({ page }) => {
  const addedTasks: Array<Record<string, unknown>> = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    // 线路机上 ICMP 任务一次都没成功；三网入口任务健康，但它们打的是运营商测速
    // 点，不是这条新线路的落地机，不能拿它们用的端口（TCP 80）当作新落地机也
    // 开放同一端口的证据——新线路必须统一从阶梯第一个 TCP 档（443）开始试。
    topologyProbeStats: [
      { task_id: 1, name: 'Tokyo', total: 48, valid: 0 },
      { task_id: 11, name: '北京联通', total: 48, valid: 47 },
      { task_id: 12, name: '北京电信', total: 48, valid: 48 },
    ],
  })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addedTasks.push(request.postDataJSON().params as Record<string, unknown>)
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await dialog.getByLabel('添加线路线路机').selectOption({ label: '东京-高负载' })
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '新加坡-A100' })
  await dialog.getByRole('button', { name: '添加线路' }).click()

  const route = dialog.locator('[data-topology-route-id]').first()
  await expect(route).toHaveAttribute('data-topology-hop-probe', 'TCP 443')
  await expect(route).toHaveAttribute('data-topology-hop-task', 'Transit-东京-高负载-to-新加坡-A100-tcp-443')
  await expect.poll(() => addedTasks.length).toBe(1)
  expect(addedTasks[0]).toMatchObject({ type: 'tcp', target: '192.0.2.13:443' })
})

test('Transit topology switches the hop probe once ICMP is proven dead', async ({ page }) => {
  const addedTasks: Array<Record<string, unknown>> = []
  const deletedTaskIds: number[][] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsLiveFirstHop: true,
    topologyAutoRepairEnabled: false,
    // 已绑定的 ICMP 中转任务采满样本却一次都没成功，且线路机上没有别的健康任务
    // 可以参考，只能靠阶梯回退到 TCP。
    topologyProbeStats: [{ task_id: 18, name: 'PandaOps-Local-Hop', total: 48, valid: 0 }],
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:addPingTask')
      addedTasks.push(payload.params as Record<string, unknown>)
    if (payload.method === 'admin:deletePingTask')
      deletedTaskIds.push((payload.params?.id as number[] | undefined) ?? [])
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await expect(firstRoute).toHaveAttribute('data-topology-hop-probe', 'TCP 443')
  await expect(firstRoute.locator('[data-topology-hop-hint]')).toContainText('ICMP 探测不通，已自动改用 TCP 443')
  await expect.poll(() => addedTasks.some(task => task.type === 'tcp' && task.target === '192.0.2.11:443')).toBe(true)
  // 换下来的是操作者自己建的任务（名字不属于主题命名空间），绝不能顺手删掉。
  expect(deletedTaskIds).toEqual([])
})

test('Transit topology repairs a dead hop after the manager is closed', async ({ page }) => {
  const addedTasks: Array<Record<string, unknown>> = []
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsComparableRoutes: true,
    topologyProbeStats: [{ task_id: 18, total: 48, valid: 0 }],
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST')
      return
    if (request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addedTasks.push(request.postDataJSON().params as Record<string, unknown>)
    if (request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
  })

  await page.clock.install()
  await openStablePage(page)
  await expect(page.locator('.topology-scroll article').first()).toBeVisible()
  await page.clock.fastForward(60_000)

  await expect.poll(() => addedTasks.some(task => task.type === 'tcp' && task.target === '192.0.2.11:443')).toBe(true)
  await expect.poll(() => saves.length).toBeGreaterThan(0)
})

test('Transit background hop repair preserves explicitly static segments', async ({ page }) => {
  const saves: Array<Record<string, unknown>> = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    topologyProbeStats: [{ task_id: 18, total: 48, valid: 0 }],
  })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON() as Record<string, unknown>)
  })

  await page.clock.install()
  await openStablePage(page)
  await page.clock.fastForward(60_000)

  await expect.poll(() => saves.length).toBeGreaterThan(0)
  expect(saves.at(-1)?.topologyMetrics).toContain(';84,0||')
})

test('Transit topology never deletes a pre-existing task based on its name alone', async ({ page }) => {
  const deletedTaskIds: number[][] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsLiveFirstHop: true,
    topologyGeneratedHopName: true,
    topologyProbeStats: [{ task_id: 18, total: 48, valid: 0 }],
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:deletePingTask')
      deletedTaskIds.push((payload.params?.id as number[] | undefined) ?? [])
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await expect(dialog.locator('[data-topology-route-id]').first()).toHaveAttribute('data-topology-hop-probe', 'TCP 443')
  expect(deletedTaskIds).toEqual([])
})

test('Transit topology retires only a probe task created in the current session', async ({ page }) => {
  const probeStats: Array<{ task_id: number, total: number, valid: number }> = []
  const deletedTaskIds: number[][] = []
  const hopTaskIds: number[] = []
  let nextPingTaskId = 101
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyNoTasks: true,
    topologyProbeStats: probeStats,
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:deletePingTask')
      deletedTaskIds.push((payload.params?.id as number[] | undefined) ?? [])
    if (payload.method === 'admin:addPingTask') {
      const id = nextPingTaskId
      nextPingTaskId += 1
      if (String(payload.params?.name ?? '').startsWith('Transit-'))
        hopTaskIds.push(id)
    }
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  const route = dialog.locator('[data-topology-route-id]').first()
  await expect(route).toHaveAttribute('data-topology-hop-probe', 'ICMP')
  await expect.poll(() => hopTaskIds.length).toBeGreaterThan(0)

  probeStats.push({ task_id: hopTaskIds[0]!, total: 48, valid: 0 })
  await dialog.getByRole('button', { name: '重新检测' }).click()
  await expect(route).toHaveAttribute('data-topology-hop-probe', 'TCP 443')
  await expect.poll(() => deletedTaskIds.flat()).toContain(hopTaskIds[0]!)
})

test('Transit topology switches the entry probe once ICMP is proven dead, retiring the task it created', async ({ page }) => {
  const probeStats: Array<{ task_id: number, total: number, valid: number }> = []
  const deletedTaskIds: number[][] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyNoTasks: true,
    topologyProbeStats: probeStats,
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:deletePingTask')
      deletedTaskIds.push((payload.params?.id as number[] | undefined) ?? [])
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  const route = dialog.locator('[data-topology-route-id]').first()
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(route).toHaveAttribute('data-topology-entry-hop-probe', 'ICMP')

  // 没有其它任务的情况下，线路机建的第一个任务是入口（第 1 段先建），第二个
  // 是 hop（第 2 段）；mock 按创建顺序从 101 起分配 id，所以入口任务是 102。
  probeStats.push({ task_id: 102, total: 48, valid: 0 })
  await dialog.getByRole('button', { name: '重新检测' }).click()
  await expect(route).toHaveAttribute('data-topology-entry-hop-probe', 'TCP 53')
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect.poll(() => deletedTaskIds.flat()).toContain(102)
})

test('Transit topology creates the replacement entry task even when deleting the old one keeps failing', async ({ page }) => {
  // 两阶段提交的关键属性：新任务的创建不依赖旧任务先删除成功。
  const probeStats: Array<{ task_id: number, total: number, valid: number }> = []
  const addedTasks: Array<Record<string, unknown>> = []
  let deleteAttempts = 0
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyNoTasks: true,
    topologyProbeStats: probeStats,
  })
  await page.route('**/api/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { id: number, method: string }
    if (payload.method !== 'admin:deletePingTask') {
      await route.fallback()
      return
    }
    deleteAttempts += 1
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: '模拟删除失败' } }),
    })
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:addPingTask')
      addedTasks.push(payload.params as Record<string, unknown>)
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  const route = dialog.locator('[data-topology-route-id]').first()
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(route).toHaveAttribute('data-topology-entry-hop-probe', 'ICMP')

  probeStats.push({ task_id: 102, total: 48, valid: 0 })
  await dialog.getByRole('button', { name: '重新检测' }).click()
  // 删除持续失败，但新任务照样建成功、探测方式照样换过去。
  await expect(route).toHaveAttribute('data-topology-entry-hop-probe', 'TCP 53')
  await expect(route).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect.poll(() => deleteAttempts).toBeGreaterThan(0)
  await expect.poll(() => addedTasks.filter(task => task.name === '北京电信').length).toBe(2)
})

test('Transit topology quick generation uses the selected source and landing nodes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await dialog.getByLabel('添加线路线路机').selectOption({ label: '东京-高负载' })
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '新加坡-A100' })
  await dialog.getByRole('button', { name: '添加线路' }).click()

  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '东京-高负载')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路落地机'), '新加坡-A100')
})

test('Transit topology discards a planned task when the landing is cleared', async ({ page }) => {
  const saves: unknown[] = []
  let addTaskCalls = 0
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true, quickTopologyNoTasks: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addTaskCalls += 1
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expect.poll(() => saves.length).toBe(1)
  // 没有匹配任务时入口和第 2 段各自建一个任务：「北京电信」和 Transit 生成的
  // hop 任务。
  expect(addTaskCalls).toBe(2)
  await dialog.getByLabel('第 1 条线路落地机').selectOption('')
  await expect.poll(() => saves.length).toBe(2)
  // 清空落地机只丢弃第 2 段的规划中任务；入口段已经创建并保存的任务不受影响，
  // 不应该再触发新的创建请求。
  expect(addTaskCalls).toBe(2)
  expect((saves[1] as { topologyMetrics: string }).topologyMetrics).toBe('live@主控-洛杉矶@北京电信@-@-')
  await expect(dialog).toBeVisible()
})

test('Transit topology changing the landing cancels delayed automatic task planning', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    quickTopologyTaskDelayMs: 500,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await dialog.getByLabel('第 1 条线路落地机').selectOption('新加坡-A100')
  await dialog.getByLabel('第 1 条线路落地机').selectOption('')
  await page.waitForTimeout(700)

  await expect(dialog.getByLabel('第 1 条线路落地机')).toHaveValue('')
  await expect(dialog.locator('[data-topology-route-id]').first()).toHaveAttribute('data-topology-hop-task', '')
})

test('Transit topology clearing a planning source does not leave saving pending', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    quickTopologyTaskDelayMs: 500,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstSource = dialog.getByLabel('第 1 条线路线路机')
  await firstSource.selectOption('东京-高负载')
  await firstSource.selectOption('')
  await dialog.getByRole('button', { name: '删除线路' }).first().click()

  await expect(dialog.getByRole('button', { name: '添加线路' })).toBeEnabled({ timeout: 2_000 })
  await expect(dialog.getByRole('button', { name: '保存并应用' })).not.toHaveText('保存中')
})

test('Transit topology adding the same source and landing updates the existing route', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, emptyTopology: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '主控-洛杉矶')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路落地机'), '香港边缘节点-超长名称布局测试')

  await dialog.getByLabel('添加线路线路机').selectOption({ label: '主控-洛杉矶' })
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '香港边缘节点-超长名称布局测试' })
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expect(page.getByText('已更新现有线路并保存。')).toBeVisible()
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(1)
})

test('Transit topology manager saves through managed theme API', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await dialog.getByLabel('添加线路线路机').selectOption({ label: '东京-高负载' })
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '香港边缘节点-超长名称布局测试' })
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => {
    const saved = saves.at(-1) as { topologyRoute?: string } | undefined
    return saved?.topologyRoute?.split('||').length ?? 0
  }).toBe(3)
  const saved = saves.at(-1) as { topologyRoute: string, topologyMetrics: string }
  expect(saved).toMatchObject({ topologyEnabled: true })
  const savedRoutes = saved.topologyRoute.split('||')
  const savedMetricGroups = saved.topologyMetrics.split('||')
  expect(savedRoutes).toHaveLength(3)
  expect(savedRoutes[2]?.split(';').map(node => node.split('|')[0])).toEqual([
    '北京电信',
    '东京-高负载',
    '香港边缘节点-超长名称布局测试',
  ])
  expect(savedMetricGroups).toHaveLength(3)
  expect(savedMetricGroups[2]).toMatch(/^live@东京-高负载@北京电信@-@-;/)
})

test('Transit topology manager can delete every route and persist an empty topology', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(2)
  while (await dialog.locator('[data-topology-route-id]').count())
    await dialog.getByRole('button', { name: '删除线路' }).first().click()
  await expect(dialog.getByText('还没有线路。选择入口和线路机即可添加；落地机可选，添加后会立即保存。')).toBeVisible()
  await expect.poll(() => saves.some(item => (item as { topologyRoute?: string }).topologyRoute === '')).toBe(true)
  const emptied = [...saves].reverse().find(item => (item as { topologyRoute?: string }).topologyRoute === '')
  expect(emptied).toMatchObject({
    topologyEnabled: true,
    topologyRoute: '',
    topologyMetrics: '',
  })
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('heading', { name: '还没有配置线路' })).toBeVisible()
})

test('Transit topology quick generation waits for task loading and creates the selected hop on save', async ({ page }) => {
  const saves: unknown[] = []
  let addTaskCalls = 0
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    dark: true,
    authenticated: true,
    quickTopologyCustomTask: true,
    quickTopologyTaskDelayMs: 1_500,
  })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addTaskCalls += 1
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await selectQuickLanding(dialog, '东京-高负载')
  const addButton = dialog.getByRole('button', { name: '添加线路' })
  await addButton.evaluate((element) => {
    element.click()
    element.click()
  })
  await expect(dialog.getByRole('button', { name: '添加中' })).toHaveAttribute('aria-busy', 'true')
  await expect(dialog.getByRole('button', { name: '添加中' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '添加线路' })).toBeEnabled({ timeout: 15_000 })
  const generated = dialog.locator('[data-topology-route-id]').last()
  await expect(dialog.getByLabel('第 3 条线路入口探测')).toHaveValue('beijing-telecom')
  await expect(dialog.getByLabel('第 3 条线路入口探测')).toBeFocused()
  await expectSelectedNode(dialog.getByLabel('第 3 条线路线路机'), '主控-洛杉矶')
  await expectSelectedNode(dialog.getByLabel('第 3 条线路落地机'), '东京-高负载')
  await expect(generated).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(generated).toHaveAttribute('data-topology-hop-task', 'Transit-主控-洛杉矶-to-东京-高负载')
  await expect(dialog.getByLabel('添加线路落地机').locator('option:checked')).toHaveText('不选（仅入口 → 线路机）')
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(3)
  await expect(dialog).toBeVisible()
  await expect.poll(() => {
    const saved = saves.at(-1) as { topologyRoute?: string } | undefined
    return saved?.topologyRoute?.split('||').length ?? 0
  }).toBe(3)
  const saved = saves.at(-1) as { topologyRoute: string, topologyMetrics: string }
  const savedRoutes = saved.topologyRoute.split('||')
  const savedMetricGroups = saved.topologyMetrics.split('||')
  expect(savedRoutes[2]?.split(';').map(node => node.split('|')[0])).toEqual([
    '北京电信',
    '主控-洛杉矶',
    '东京-高负载',
  ])
  expect(savedMetricGroups[2]).toBe('live@主控-洛杉矶@北京电信@-@-;live@主控-洛杉矶@Transit-主控-洛杉矶-to-东京-高负载@-@-')
  expect(addTaskCalls).toBeGreaterThanOrEqual(1)
})

test('Transit topology quick generation stops on Ping task failures', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyTaskFailure: true,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await dialog.getByRole('button', { name: '添加线路' }).click()

  await expect(dialog.getByRole('alert')).toHaveText('无法读取 Ping 任务，请稍后重试。')
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeDisabled()
})

test('Transit topology marks a landing without a public IP as unusable before it can be picked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyNoAddress: true,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  const landingSelect = dialog.getByLabel('添加线路落地机')
  const unusable = landingSelect.getByRole('option', { name: '香港边缘节点-超长名称布局测试（无公网 IP，不可用）', exact: true })

  // 事前标注并禁用，而不是等到点了「添加线路」才弹红字报错。
  // 断言属性而非 toBeDisabled()：Playwright 的 disabled 判定不覆盖 <option> 自身的属性。
  await expect(unusable).toHaveAttribute('disabled', '')
  // 默认选中项也不能落在这个禁用选项上，否则等于把同一个坑从默认值绕回来。
  await expect(landingSelect).not.toHaveValue((await unusable.getAttribute('value')) ?? '')

  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(1)
  await expect(page.getByText(/没有可用于 Ping 的 IPv4 或 IPv6 地址/)).toHaveCount(0)
})

test('Transit topology still reports a planning error when an existing landing loses its address', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsLiveFirstHop: true,
    // 默认拓扑第 1 条线路的落地机正是这台被清空 IP 的节点。
    quickTopologyNoAddress: true,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  // 校验区汇总一条，出问题那条线路的 hop 提示行再说一次。
  await expect(dialog.getByText(/没有可用于 Ping 的 IPv4 或 IPv6 地址/).first()).toBeVisible()
  await expect(dialog.locator('[data-topology-hop-hint]').first())
    .toHaveText('落地机“香港边缘节点-超长名称布局测试”没有可用于 Ping 的 IPv4 或 IPv6 地址。')
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeDisabled()
})

test('Transit topology can switch a custom entry to a preset and back without losing it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, opsCustomFirstMetric: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const entrySelect = dialog.getByLabel('第 1 条线路入口探测')
  await expect(entrySelect).toHaveValue('__custom_probe__')

  // 切到预设会覆盖 nodes[0] 与 metrics[0]，且改动立刻自动保存。
  await entrySelect.selectOption('beijing-unicom')
  await expect(entrySelect).toHaveValue('beijing-unicom')

  // 自定义项必须仍然留在下拉里，否则这一步就是不可逆的数据丢失。
  const customOption = entrySelect.getByRole('option', { name: '北京联通家宽', exact: true })
  await expect(customOption).toHaveCount(1)

  await entrySelect.selectOption('__custom_probe__')
  await expect(entrySelect).toHaveValue('__custom_probe__')
  await expect(dialog.locator('[data-topology-route-id]').first())
    .toHaveAttribute('data-topology-entry-task', 'Relay-JP-to-Exit-US')
})

test('Transit topology blocks saving existing routes when task validation fails', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    quickTopologyTaskFailure: true,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  await expect(dialog.getByText(/无法验证探测任务|无法读取 Ping 任务/).first()).toBeVisible()
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeDisabled()
})

test('Transit topology rematch keeps a custom first-segment task when the entry uses a preset label', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsKnownEntryCustomTask: true,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await expect(firstRoute).toHaveAttribute('data-topology-entry-task', 'Relay-JP-to-Exit-US')
  await expect(dialog.getByLabel('第 1 条线路入口探测')).toHaveValue('beijing-telecom')
})

test('Transit topology rematches a live metric whose source node was deleted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    opsMissingPingSource: true,
    topologyAutoRepairEnabled: false,
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await expect(firstRoute).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(page.getByText('已按当前节点校正并保存。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '保存并应用' })).toBeDisabled()
})

test('Transit topology task correction follows the landing IP and saves the missing hop', async ({ page }) => {
  let addTaskCalls = 0
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/rpc2') && request.postDataJSON().method === 'admin:addPingTask')
      addTaskCalls += 1
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const secondRoute = dialog.locator('[data-topology-route-id]').nth(1)
  await expect(secondRoute).toHaveAttribute('data-topology-entry-task', 'Tokyo')
  await expect(secondRoute).toHaveAttribute('data-topology-hop-task', 'Transit-东京-高负载-to-新加坡-A100')
  expect(addTaskCalls).toBeGreaterThanOrEqual(1)
})

test('Transit topology quick generation discards delayed work after closing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    quickTopologyCustomTask: true,
    quickTopologyTaskDelayMs: 1_500,
  })
  await openStablePage(page)

  let dialog = await openTopologyManager(page)
  await selectQuickLanding(dialog, '东京-高负载')
  await dialog.getByRole('button', { name: '添加线路' }).evaluate(element => (element as HTMLButtonElement).click())
  await expect.poll(async () => Promise.all([
    dialog.getByRole('button', { name: '添加中' }).isVisible(),
    dialog.getByLabel('添加线路线路机').isDisabled(),
    dialog.getByLabel('添加线路落地机').isDisabled(),
    dialog.getByRole('button', { name: '添加中' }).isDisabled(),
  ])).toEqual([true, true, true, true])
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: '管理', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-topology-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1_800)
  await expect(dialog.locator('[data-topology-route-id]')).toHaveCount(2)
})

test('Transit topology removes a task committed while its editor is closing', async ({ page }) => {
  const deletedTaskIds: number[][] = []
  const hopTaskIds: number[] = []
  let nextPingTaskId = 101
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyNoTasks: true,
    quickTopologyMutationDelayMs: 500,
  })
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method: string, params?: Record<string, unknown> }
    if (payload.method === 'admin:deletePingTask')
      deletedTaskIds.push((payload.params?.id as number[] | undefined) ?? [])
    if (payload.method === 'admin:addPingTask') {
      const id = nextPingTaskId
      nextPingTaskId += 1
      if (String(payload.params?.name ?? '').startsWith('Transit-'))
        hopTaskIds.push(id)
    }
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  const mutationStarted = page.waitForRequest(request => request.method() === 'POST'
    && request.url().endsWith('/api/rpc2')
    && request.postDataJSON().method === 'admin:addPingTask'
    && String(request.postDataJSON().params?.name ?? '').startsWith('Transit-'))
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await mutationStarted
  await dialog.getByRole('button', { name: '关闭' }).click()

  await expect(dialog).toBeHidden()
  await expect.poll(() => hopTaskIds.length).toBeGreaterThan(0)
  await expect.poll(() => deletedTaskIds.flat()).toContain(hopTaskIds[0]!)
})

test('Transit topology save cannot close or overwrite a reopened editor session', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    themeSaveDelayMs: 500,
  })
  await openStablePage(page)

  let dialog = await openTopologyManager(page)
  const entry = dialog.getByLabel('第 1 条线路入口探测')
  await entry.selectOption('shanghai-telecom')
  await expect(page.getByText('线路已保存。')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: '管理', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-topology-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByLabel('第 1 条线路入口探测')).toHaveValue('shanghai-telecom')
  await expect(dialog).toBeVisible()
})

test('Transit topology quick generation keeps preset task semantics when the source node has the same name', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    authenticated: true,
    emptyTopology: true,
    quickTopologyPresetConflict: true,
  })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON())
  })
  await openStablePage(page)

  const dialog = await openTopologyManager(page, 'empty')
  await selectQuickLanding(dialog)
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await expect(dialog.getByLabel('第 1 条线路入口探测')).toHaveValue('beijing-telecom')
  await expectSelectedNode(dialog.getByLabel('第 1 条线路线路机'), '北京电信')
  await expect(dialog.locator('[data-topology-route-id]').first()).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(dialog.locator('[data-topology-route-id]').first()).toHaveAttribute('data-topology-entry-probe', 'beijing-telecom')
  await expect(dialog).toBeVisible()
  await expect.poll(() => saves.length).toBe(1)
  const saved = saves[0] as { topologyRoute: string, topologyMetrics: string }
  expect(saved.topologyRoute.split('||')[0]?.split(';').map(node => node.split('|')[0])).toEqual([
    '北京电信入口',
    '北京电信',
    '香港边缘节点-超长名称布局测试',
  ])
  expect(saved.topologyMetrics.split('||')[0]).toBe('live@北京电信@北京电信@-@-;live@北京电信@PandaOps-Local-Hop@-@-')
})

test('Transit rematches the entry task when the probe stays the same and the relay changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await dialog.getByLabel('第 1 条线路线路机').selectOption('东京-高负载')
  await expect(firstRoute).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(page.getByText('线路已保存。')).toBeVisible()
})

test('Transit automatically rematches Ping tasks when its followed route node changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true, opsComparableRoutes: true })
  await openStablePage(page)

  const dialog = await openTopologyManager(page)
  const firstRoute = dialog.locator('[data-topology-route-id]').first()
  await dialog.getByLabel('第 1 条线路线路机').selectOption('东京-高负载')

  await expect(firstRoute).toHaveAttribute('data-topology-entry-task', '北京电信')
  await expect(firstRoute).toHaveAttribute('data-topology-hop-task', 'PandaOps-Local-Hop')
  await expect(page.getByText('线路已保存。')).toBeVisible()
})

test('Transit documentation screenshots', async ({ browser }) => {
  test.skip(!process.env.UPDATE_DOCS_SCREENSHOT, 'Set UPDATE_DOCS_SCREENSHOT=1 to refresh documentation screenshots')

  async function capture(
    viewport: { width: number, height: number },
    options: Parameters<typeof installKomariFixture>[1],
    screenshot: (page: Page) => Promise<Buffer>,
  ): Promise<void> {
    const context = await browser.newContext({
      colorScheme: options?.dark ? 'dark' : 'light',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport,
    })
    const page = await context.newPage()
    try {
      await installKomariFixture(page, options)
      await openStablePage(page)
      await screenshot(page)
    }
    finally {
      await context.close()
    }
  }

  await capture(
    { width: 1440, height: 900 },
    { opsDashboard: true, dark: true },
    page => page.screenshot({ path: 'docs/screenshots/transit-overview-dark.png' }),
  )
  await capture(
    { width: 1440, height: 900 },
    { opsDashboard: true },
    page => page.screenshot({ path: 'docs/screenshots/transit-overview-light.png' }),
  )
  await capture(
    { width: 1280, height: 720 },
    { opsDashboard: true, dark: true },
    page => page.screenshot({ path: 'docs/preview.png' }),
  )
  await capture(
    { width: 1440, height: 900 },
    { opsDashboard: true, dark: true, authenticated: true },
    async (page) => {
      const dialog = await openTopologyManager(page)
      return dialog.screenshot({ path: 'docs/screenshots/transit-topology-manager.png' })
    },
  )
})

test('Transit node maintenance saves globally and updates alerts immediately', async ({ page }) => {
  const saves: Record<string, unknown>[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON() as Record<string, unknown>)
  })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: '查看节点 东京-高负载 详情' }).locator('xpath=..')
  await nodeCard.getByRole('button', { name: '管理节点 东京-高负载' }).click()
  const dialog = page.getByRole('dialog', { name: /节点运维/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '30 分钟' }).click()

  // 拓扑后台自愈现在页面一打开就可能立即跑一轮，也会写同一个主题设置接口；
  // 两次保存互相独立、按内容而非到达顺序区分，不能假设这次点击触发的一定是
  // saves[0]。
  await expect.poll(() => saves.some(save => 'pandaOpsNodeControls' in save)).toBe(true)
  const maintenanceSave = saves.find(save => 'pandaOpsNodeControls' in save)!
  const controls = JSON.parse(String(maintenanceSave.pandaOpsNodeControls)) as Record<string, { maintenanceUntil?: number }>
  expect(Object.values(controls).some(control => Number(control.maintenanceUntil) > 0)).toBe(true)
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(nodeCard).toContainText('维护中')
  await expect(page.locator('[data-transit-alert-strip]').getByRole('heading', { name: '10 个异常需要关注' })).toBeVisible()
})

test('Transit node cards render per-node insight panels without changing card height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    dark: true,
    authenticated: true,
    nodeCardPanels: {
      '00000000-0000-4000-8000-000000000001': { mode: 'system' },
      '00000000-0000-4000-8000-000000000002': { mode: 'traffic' },
      '00000000-0000-4000-8000-000000000003': { mode: 'storage' },
      '00000000-0000-4000-8000-000000000004': { mode: 'gpu' },
      '00000000-0000-4000-8000-000000000005': { mode: 'compact' },
      '00000000-0000-4000-8000-000000000006': { mode: 'ping', pingTasks: ['Tokyo', 'PandaOps-Local-Hop'] },
      '00000000-0000-4000-8000-000000000007': { mode: 'carrier' },
    },
  })
  await openStablePage(page)

  const cards = page.locator('[data-node-card-grid] .transit-node-card')
  await expect(cards.nth(0).locator('[data-node-insight-mode="system"]')).toContainText('系统状态')
  await expect(cards.nth(1).locator('[data-node-insight-mode="traffic"]')).toContainText('流量状态')
  await expect(cards.nth(2).locator('[data-node-insight-mode="storage"]')).toContainText('存储状态')
  await expect(cards.nth(3).locator('[data-node-insight-mode="gpu"]')).toContainText('NVIDIA A100')
  await expect(cards.nth(4).locator('[data-node-insight-mode="compact"]')).toContainText('精简信息')
  await expect(cards.nth(5).locator('[data-node-insight-mode="ping"]')).toContainText('Tokyo')
  await expect(cards.nth(6).locator('[data-node-insight-mode="carrier"] [data-node-carrier-row]')).toHaveCount(3)

  await expect.poll(() => cards.locator('[data-node-insight-panel]').evaluateAll(panels => panels.every((panel) => {
    const panelBox = panel.getBoundingClientRect()
    const content = [...panel.querySelectorAll<HTMLElement>('[data-node-carrier-row], [data-node-custom-ping-row]')]
    return panel.scrollHeight <= panel.clientHeight + 1
      && content.every((row) => {
        const rowBox = row.getBoundingClientRect()
        return rowBox.top >= panelBox.top - 1 && rowBox.bottom <= panelBox.bottom + 1
      })
  }))).toBe(true)

  const firstRowHeights = await cards.evaluateAll(elements => elements.slice(0, 3).map(element => element.getBoundingClientRect().height))
  expect(Math.max(...firstRowHeights) - Math.min(...firstRowHeights)).toBeLessThanOrEqual(1)
})

test('Transit separates synchronized target failures from per-node carrier alerts', async ({ page }) => {
  const pingMetricBatchSizes: number[] = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: { entity_ids?: unknown[] } } | null
    if (payload?.method === 'public:queryMetrics' && Array.isArray(payload.params?.entity_ids))
      pingMetricBatchSizes.push(payload.params.entity_ids.length)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, carrierCommonModeLoss: true })
  await openStablePage(page)

  expect(Math.max(...pingMetricBatchSizes)).toBeGreaterThanOrEqual(5)
  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
  const incident = nodeCard.locator('[data-carrier-target-incident]')
  await expect(incident).toHaveText('4.2%')
  await expect(incident).toHaveAttribute('title', /2 次为多节点同步目标异常，未计入节点告警/)
  await expect(nodeCard.locator('[data-node-insight-mode="carrier"]')).toContainText('近 1 小时曾异常')
  await expect(nodeCard.locator('[data-node-alert-reason]')).toHaveCount(0)
  await expect(nodeCard).not.toHaveAttribute('data-node-alert-edge', '')
})

test('Transit node panel editor saves selected custom Ping tasks by UUID', async ({ page }) => {
  const saves: Record<string, unknown>[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true, pingTaskOrdering: true })
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit'))
      saves.push(request.postDataJSON() as Record<string, unknown>)
  })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
  await nodeCard.getByRole('button', { name: '管理节点 主控-洛杉矶' }).click()
  const dialog = page.getByRole('dialog', { name: /节点运维/ })
  await dialog.getByLabel('面板类型').selectOption('ping')
  await dialog.getByRole('checkbox', { name: '浙江联通' }).check()
  await dialog.getByRole('checkbox', { name: '浙江移动' }).check()
  await dialog.getByRole('button', { name: '保存面板' }).click()

  // 同上：拓扑后台自愈可能抢在这次保存前先写一次同一个接口，按内容而非到达
  // 顺序区分。
  await expect.poll(() => saves.some(save => 'nodeCardPanels' in save)).toBe(true)
  const panelSave = saves.find(save => 'nodeCardPanels' in save)!
  const configs = JSON.parse(String(panelSave.nodeCardPanels)) as Record<string, { mode: string, pingTasks: string[] }>
  expect(configs['00000000-0000-4000-8000-000000000001']).toEqual({
    mode: 'ping',
    pingTasks: ['浙江联通', '浙江移动'],
  })
  await dialog.getByRole('button', { name: '关闭' }).click()
  const insightPanel = nodeCard.locator('[data-node-insight-panel]')
  await expect(insightPanel).toHaveAttribute('data-node-insight-mode', 'ping')
  await expect(insightPanel).toContainText('浙江联通')
})

test('home quick controls, node comparison and network data change visible results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, authenticated: true })
  await openStablePage(page)

  await page.getByRole('button', { name: /切换到离线节点/ }).click()
  await expect(page.getByRole('button', { name: '查看节点 伦敦-离线归档 详情' })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })).toHaveCount(0)
  await page.getByRole('button', { name: /切换到离线节点/ }).click()
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })).toBeVisible()

  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /对比：/ }).click()
  await page.getByRole('button', { name: '主控-洛杉矶', exact: true }).click()
  await page.getByRole('button', { name: '东京-高负载', exact: true }).click()
  await expect(page.getByText('已选 2 / 4')).toBeVisible()
  await expect(page.getByText('实时快照')).toBeVisible()
  await expect(page.getByText('96.4%', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: /网络：/ }).click()
  await expect(page.getByText('IP 网络归属')).toBeVisible()
  await expect(page.getByText(/不包含 BGP 路由或 traceroute 推断/)).toBeVisible()
  await expect(page.getByText('ASN / BGP 拓扑')).toHaveCount(0)
})

test('homepage cards can be reordered directly and saved to the official global order', async ({ page }) => {
  const savedOrders: Array<Record<string, number>> = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, number> } | null
    if (payload?.method === 'admin:orderClients' && payload.params)
      savedOrders.push(payload.params)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)

  const search = page.getByRole('textbox', { name: '搜索节点' })
  await search.fill('东京')
  await expect(page.locator('[data-node-card-grid] > div')).toHaveCount(2)
  await page.getByRole('button', { name: '编辑首页顺序' }).click()
  const toolbar = page.locator('[data-home-order-toolbar]')
  const grid = page.locator('[data-node-card-grid]')
  await expect(toolbar).toBeVisible()
  await expect(search).toHaveValue('')
  await expect(grid.locator('[data-server-order-item]')).toHaveCount(12)
  await page.locator('.sticky').first().evaluate((element) => {
    element.setAttribute('style', 'display: none !important')
  })
  await expect(toolbar).toHaveScreenshot('home-order-edit-toolbar-desktop.png')

  await page.getByRole('button', { name: '列表视图' }).click()
  const list = page.locator('[data-server-order-item]')
  const listHandle = page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ })
  await expect(list).toHaveCount(12)
  await expect(page.getByRole('button', { name: /收藏 主控-洛杉矶/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开延迟和丢包监测' })).toHaveCount(0)
  await listHandle.press('ArrowDown')
  await expect(list.first()).toContainText('香港边缘节点-超长名称布局测试')
  await listHandle.press('ArrowUp')
  await expect(list.first()).toContainText('主控-洛杉矶')
  await page.getByRole('button', { name: '卡片视图' }).click()

  const firstHandle = page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ })
  await firstHandle.press('ArrowDown')
  await expect(grid.locator('[data-server-order-item]').first()).toContainText('香港边缘节点-超长名称布局测试')
  await firstHandle.press('ArrowUp')
  await expect(grid.locator('[data-server-order-item]').first()).toContainText('主控-洛杉矶')
  await dragOrderHandle(page, firstHandle, grid.locator('[data-server-order-item]').nth(1))
  await expect(grid.locator('[data-server-order-item]').first()).toContainText('香港边缘节点-超长名称布局测试')
  await expect(firstHandle).toHaveAccessibleName(/当前第 2 位/)
  await page.getByRole('button', { name: '保存顺序' }).click()

  await expect.poll(() => savedOrders.length).toBe(1)
  expect(savedOrders[0]?.['00000000-0000-4000-8000-000000000001']).toBe(1)
  expect(savedOrders[0]?.['00000000-0000-4000-8000-000000000002']).toBe(0)
  await expect(search).toHaveValue('东京')
  await expect(grid.locator('> div')).toHaveCount(2)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await expect(grid.locator('> div').first()).toContainText('香港边缘节点-超长名称布局测试')
})

test('homepage order save failure keeps the draft available for retry', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { authenticated: true, orderSaveFailure: true, opsDashboard: true })
  await openStablePage(page)

  await page.getByRole('button', { name: '编辑首页顺序' }).click()
  const grid = page.locator('[data-node-card-grid]')
  const firstHandle = page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ })
  await firstHandle.press('ArrowDown')
  await expect(grid.locator('[data-server-order-item]').first()).toContainText('香港边缘节点-超长名称布局测试')
  await page.getByRole('button', { name: '保存顺序' }).click()

  await expect(page.getByText('保存服务器顺序失败：visual order save failed')).toBeVisible()
  await expect(page.locator('[data-home-order-toolbar]')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存顺序' })).toBeEnabled()
  await expect(grid.locator('[data-server-order-item]').first()).toContainText('香港边缘节点-超长名称布局测试')
})

test('homepage order save and cancel return keyboard focus to the edit trigger', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openStablePage(page)

  const editTrigger = page.getByRole('button', { name: '编辑首页顺序' })
  await editTrigger.click()
  await page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ }).press('ArrowDown')
  await page.getByRole('button', { name: '保存顺序' }).click()
  await expect(editTrigger).toBeFocused()

  await editTrigger.click()
  await page.getByRole('button', { name: '取消' }).click()
  await expect(editTrigger).toBeFocused()
})

test('expired login blocks homepage order editing before a private RPC call', async ({ page }) => {
  const privateRequests: string[] = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string } | null
    if (payload?.method?.startsWith('admin:'))
      privateRequests.push(payload.method)
  })

  await installKomariFixture(page, { authenticated: true, authenticationExpires: true, opsDashboard: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '编辑首页顺序' }).click()

  await expect(page.getByText('登录状态已过期，请重新登录后编辑首页顺序。')).toBeVisible()
  await expect(page.locator('[data-home-order-toolbar]')).toHaveCount(0)
  expect(privateRequests).toEqual([])
})

test.describe('mobile touch sorting', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('homepage order supports mobile touch dragging', async ({ page }) => {
    await installKomariFixture(page, { authenticated: true, nodeCardSize: 'mini', opsDashboard: true })
    await openStablePage(page)

    await page.getByRole('button', { name: '编辑首页顺序' }).click()
    const grid = page.locator('[data-node-card-grid]')
    await expect(grid.locator('[data-server-order-item]')).toHaveCount(12)
    await page.waitForTimeout(300)
    await dragOrderHandleByTouch(
      page,
      page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ }),
      grid.locator('[data-server-order-item]').nth(1),
    )
    await expect(grid.locator('[data-server-order-item]').first()).toContainText('香港边缘节点-超长名称布局测试')
  })
})

test('Transit server list filters and sorts reactive nodes without the blocked admin endpoint', async ({ page }) => {
  let blockedAdminListRequests = 0
  let nodeMetadataRequests = 0
  const savedOrders: Array<Record<string, number>> = []
  const savedPanelConfigs: Array<Record<string, { mode: string }>> = []
  page.on('request', (request) => {
    if (request.url().includes('/api/admin/client/list'))
      blockedAdminListRequests++
    if (request.method() === 'POST' && request.url().includes('/api/admin/theme/settings?theme=Transit')) {
      const body = request.postDataJSON() as { nodeCardPanels?: string } | null
      if (body?.nodeCardPanels)
        savedPanelConfigs.push(JSON.parse(body.nodeCardPanels) as Record<string, { mode: string }>)
    }
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, number> } | null
    if (payload?.method === 'common:getNodes')
      nodeMetadataRequests++
    if (payload?.method === 'admin:orderClients' && payload.params)
      savedOrders.push(payload.params)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)

  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()

  const panel = page.locator('[data-server-list-panel]')
  await expect(panel.getByRole('heading', { name: '服务器列表' })).toBeVisible()
  await expect(panel).toContainText('12 台服务器')
  await expect(panel.locator('tbody tr')).toHaveCount(12)
  await expect(panel.getByRole('combobox', { name: '排序方式' })).toHaveValue('official')
  await expect(panel.locator('tbody tr').first()).toContainText('主控-洛杉矶')
  await expect(panel.getByRole('link', { name: '官方后台' })).toHaveAttribute('href', '/admin/servers')
  await page.locator('.sticky').first().evaluate((element) => {
    element.setAttribute('style', 'display: none !important')
  })
  await expect(panel).toHaveScreenshot('server-list-desktop.png')

  await panel.getByRole('button', { name: '批量卡片面板' }).click()
  const bulkDialog = page.getByRole('dialog', { name: '批量设置节点卡片面板' })
  await bulkDialog.getByLabel('面板类型').selectOption('system')
  await bulkDialog.getByRole('button', { name: '应用到 12 台' }).click()
  await expect.poll(() => savedPanelConfigs.length).toBe(1)
  expect(Object.values(savedPanelConfigs[0] ?? {})).toHaveLength(12)
  expect(Object.values(savedPanelConfigs[0] ?? {}).every(config => config.mode === 'system')).toBe(true)

  await panel.getByRole('button', { name: /离线\s*1/ }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(1)
  await expect(panel).toContainText('伦敦-离线归档')

  await panel.getByRole('button', { name: /全部\s*12/ }).click()
  await panel.getByRole('textbox', { name: '搜索服务器' }).fill('东京')
  await expect(panel.locator('tbody tr')).toHaveCount(2)
  await expect(panel).toContainText('东京-高负载')
  await expect(panel).not.toContainText('主控-洛杉矶')

  await panel.getByRole('textbox', { name: '搜索服务器' }).fill('')
  await panel.getByRole('button', { name: /^CPU/ }).click()
  await expect(panel.locator('tbody tr').first()).toContainText('东京-高负载')
  await panel.getByRole('button', { name: '运维 东京-高负载', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /节点运维/ })).toBeVisible()
  await page.getByRole('dialog', { name: /节点运维/ }).getByRole('button', { name: '关闭' }).click()

  await panel.getByRole('textbox', { name: '搜索服务器' }).fill('东京')
  await panel.getByRole('button', { name: '编辑首页顺序' }).click()
  await expect(panel.locator('tbody tr')).toHaveCount(12)
  await panel.getByRole('button', { name: '取消' }).click()
  await expect(panel.getByRole('textbox', { name: '搜索服务器' })).toHaveValue('东京')
  await expect(panel.getByRole('combobox', { name: '排序方式' })).toHaveValue('cpu')
  await expect(panel.locator('tbody tr')).toHaveCount(2)

  await panel.getByRole('textbox', { name: '搜索服务器' }).fill('')
  await panel.getByRole('combobox', { name: '排序方式' }).selectOption('official')
  await panel.getByRole('button', { name: '编辑首页顺序' }).click()
  await expect(panel).toHaveScreenshot('server-list-order-edit-desktop.png')
  const firstOrderHandle = panel.getByRole('button', { name: /^拖动 主控-洛杉矶，/ })
  await firstOrderHandle.press('ArrowDown')
  await expect(panel.locator('tbody tr').first()).toContainText('香港边缘节点-超长名称布局测试')
  await firstOrderHandle.press('ArrowUp')
  await expect(panel.locator('tbody tr').first()).toContainText('主控-洛杉矶')
  await dragOrderHandle(page, firstOrderHandle, panel.locator('tbody tr').nth(1))
  await expect(panel.locator('tbody tr').first()).toContainText('香港边缘节点-超长名称布局测试')
  await expect(firstOrderHandle).toHaveAccessibleName(/当前第 2 位/)
  await expect(page.locator('.sortable-fallback, .server-order-drag')).toHaveCount(0)
  await dragOrderHandle(page, firstOrderHandle, panel.locator('tbody tr').nth(3), 0.95)
  await expect(panel.locator('tbody tr').nth(3)).toContainText('主控-洛杉矶')
  await firstOrderHandle.press('Home')
  await expect(panel.locator('tbody tr').first()).toContainText('主控-洛杉矶')
  await expect(panel).toContainText('主控-洛杉矶 已移动到第 1 位，共 12 位。')
  await dragOrderHandle(page, firstOrderHandle, panel.locator('tbody tr').nth(1))
  await expect(panel.locator('tbody tr').first()).toContainText('香港边缘节点-超长名称布局测试')
  await panel.getByRole('button', { name: '保存顺序' }).click()
  await expect.poll(() => savedOrders.length).toBe(1)
  expect(savedOrders[0]?.['00000000-0000-4000-8000-000000000001']).toBe(1)
  expect(savedOrders[0]?.['00000000-0000-4000-8000-000000000002']).toBe(0)
  await expect(panel.locator('tbody tr').first()).toContainText('香港边缘节点-超长名称布局测试')

  const requestsBeforeFocus = nodeMetadataRequests
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => nodeMetadataRequests).toBeGreaterThan(requestsBeforeFocus)

  expect(blockedAdminListRequests).toBe(0)
})

test('Transit server list stays contained on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)

  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()

  const panel = page.locator('[data-server-list-panel]')
  await expect(panel.locator('table')).toBeHidden()
  await expect(panel.locator('article')).toHaveCount(12)
  await panel.getByRole('combobox', { name: '排序方式' }).selectOption('cpu')
  await expect(panel.locator('article').first()).toContainText('东京-高负载')
  await panel.getByRole('button', { name: '当前降序，切换为升序' }).click()
  await expect(panel.locator('article').first()).toContainText('伦敦-离线归档')
  await panel.getByRole('button', { name: /离线\s*1/ }).click()
  await expect(panel.locator('article')).toHaveCount(1)
  await expect(panel).toContainText('伦敦-离线归档')
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
  await expect(panel).toHaveScreenshot('server-list-mobile.png')

  await panel.getByRole('button', { name: '编辑首页顺序' }).click()
  await expect(panel.locator('article').first()).toHaveScreenshot('server-list-order-edit-mobile-card.png')
  await dragOrderHandle(page, panel.getByRole('button', { name: /^拖动 主控-洛杉矶，/ }), panel.locator('article').nth(1))
  await expect(panel.locator('article').first()).toContainText('香港边缘节点-超长名称布局测试')
})

test('server list order save and cancel return keyboard focus to the edit trigger', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()

  const panel = page.locator('[data-server-list-panel]')
  const editTrigger = panel.getByRole('button', { name: '编辑首页顺序' })
  await editTrigger.click()
  await panel.getByRole('button', { name: /^拖动 主控-洛杉矶，/ }).press('ArrowDown')
  await panel.getByRole('button', { name: '保存顺序' }).click()
  await expect(editTrigger).toBeFocused()

  await editTrigger.click()
  await panel.getByRole('button', { name: '取消' }).click()
  await expect(editTrigger).toBeFocused()
})

test('health range reloads the selected period and snapshot export downloads real data', async ({ page }) => {
  const healthHours: number[] = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'common:getRecords' && typeof payload.params?.hours === 'number')
      healthHours.push(payload.params.hours)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, freePriceNode: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /健康：/ }).click()
  await page.getByRole('button', { name: '生成摘要' }).click()
  await expect(page.getByText(/当前范围：周/)).toBeVisible()
  await expect.poll(() => healthHours.filter(hours => hours === 168).length).toBeGreaterThan(0)

  await page.getByRole('button', { name: '日', exact: true }).click()
  await expect(page.getByText(/当前范围：日/)).toBeVisible()
  await expect.poll(() => healthHours.filter(hours => hours === 24).length).toBeGreaterThan(0)

  await page.getByRole('button', { name: /导出：/ }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^komari-snapshot-\d+\.json$/)
  const downloadPath = await download.path()
  expect(downloadPath).toBeTruthy()
  const snapshot = JSON.parse(await readFile(downloadPath!, 'utf8')) as {
    summary: { nodes: number, online: number, offline: number }
    nodes: Array<{ billing: { price: string }, status: string }>
  }
  expect(snapshot.summary.nodes).toBe(snapshot.nodes.length)
  expect(snapshot.summary.online + snapshot.summary.offline).toBe(snapshot.nodes.length)
  expect(snapshot.nodes[0]?.billing.price).toBe('免费')
  await expect(page.getByText(/已导出 12 台节点的 JSON 快照/)).toBeVisible()
})

test('snapshot export does not download or notify after its tool is closed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /导出：/ }).click()

  let releasePermission!: () => void
  const permissionReleased = new Promise<void>((resolve) => {
    releasePermission = resolve
  })
  let permissionRequested!: () => void
  const permissionRequestStarted = new Promise<void>((resolve) => {
    permissionRequested = resolve
  })
  await page.route('**/api/me', async (route) => {
    permissionRequested()
    await permissionReleased
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ logged_in: true, username: 'visual-admin' }),
    })
  })

  let downloads = 0
  page.on('download', () => downloads++)
  await page.getByRole('button', { name: '导出 JSON' }).click()
  await permissionRequestStarted
  await page.getByRole('button', { name: /对比：/ }).click()
  await expect(page.getByText('选择 2 至 4 台节点进行横向对比')).toBeVisible()

  const permissionResponse = page.waitForResponse(response => response.url().endsWith('/api/me'))
  releasePermission()
  await permissionResponse
  await page.waitForTimeout(500)

  expect(downloads).toBe(0)
  await expect(page.getByText(/已导出 .* JSON 快照|导出 JSON 失败/)).toHaveCount(0)
})

test('audit tool shows real core logs without unsupported visitor controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /日志：/ }).click()

  await expect(page.getByText('更新主题配置')).toBeVisible()
  await expect(page.getByText('管理员登录')).toBeVisible()
  await expect(page.getByRole('tab', { name: '访客安全' })).toHaveCount(0)
  await expect(page.getByText(/等待核心发布访客审计能力/)).toHaveCount(0)
})

test('audit export does not download or notify after its tool is closed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /日志：/ }).click()
  await expect(page.getByText('更新主题配置')).toBeVisible()

  let releaseAuditExport!: () => void
  const auditExportReleased = new Promise<void>((resolve) => {
    releaseAuditExport = resolve
  })
  let auditExportRequested!: () => void
  const auditExportRequestStarted = new Promise<void>((resolve) => {
    auditExportRequested = resolve
  })
  await page.route('**/api/rpc2', async (route) => {
    const payload = route.request().postDataJSON() as { id: number, method: string }
    if (payload.method !== 'admin:getLogs') {
      await route.fallback()
      return
    }
    auditExportRequested()
    await auditExportReleased
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          total: 2,
          logs: [
            { id: 2, ip: '198.51.100.22', uuid: 'visual-admin', message: '更新主题配置', msg_type: 'update', time: '2026-07-25T12:00:00.000Z' },
            { id: 1, ip: '198.51.100.10', uuid: 'visual-admin', message: '管理员登录', msg_type: 'login', time: '2026-07-25T11:50:00.000Z' },
          ],
        },
      }),
    })
  })

  let downloads = 0
  page.on('download', () => downloads++)
  await page.getByRole('button', { name: 'JSON', exact: true }).click()
  await auditExportRequestStarted
  await page.getByRole('button', { name: /对比：/ }).click()
  await expect(page.getByText('选择 2 至 4 台节点进行横向对比')).toBeVisible()

  releaseAuditExport()
  await page.waitForTimeout(500)

  expect(downloads).toBe(0)
  await expect(page.getByText(/已导出 .* 条审计日志|导出审计日志失败/)).toHaveCount(0)
})

test('provider value sorting changes the ranked node order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /性价比：/ }).click()

  const table = page.getByRole('table')
  const firstNodeCell = table.locator('tbody tr').first().locator('td').first()
  await page.getByRole('columnheader', { name: /^月成本/ }).click()
  await expect(firstNodeCell).toContainText('主控-洛杉矶')
  await page.getByRole('columnheader', { name: /^月成本/ }).click()
  await expect(firstNodeCell).toContainText('新加坡-A100-12')
})

test('supported visitor audit toggle writes the core setting', async ({ page }) => {
  const settingUpdates: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'admin:editSettings')
      settingUpdates.push(payload.params ?? {})
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true, visitorAuditSupported: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /日志：/ }).click()

  await expect(page.getByRole('tab', { name: '访客安全' })).toBeEnabled()
  await page.getByRole('button', { name: '启用采集' }).click()
  await expect.poll(() => settingUpdates.length).toBe(1)
  expect(settingUpdates[0]).toMatchObject({ visitor_audit_enabled: true })
  await expect(page.getByRole('button', { name: '暂停采集' })).toBeVisible()
})

test('logged-out public home does not call visitor or node IP lookup providers', async ({ page }) => {
  const visitorLookupUrls = new Set([
    'https://ipwho.is/',
    'https://ipapi.co/json/',
    'https://api.ip.sb/geoip',
  ])
  const requests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const nodeGeoLookup = /^https:\/\/(?:api\.ip\.sb\/geoip\/|ipinfo\.io\/|ipwho\.is\/|ipapi\.co\/)/.test(url)
    if (visitorLookupUrls.has(url) || nodeGeoLookup)
      requests.push(request.url())
  })

  await installKomariFixture(page, { visitorInfoEnabled: false })
  await openStablePage(page)
  await page.waitForTimeout(250)

  expect(requests).toEqual([])
})

test('logged-out public routes do not call private HTTP or RPC endpoints', async ({ page }) => {
  const privateRequests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.includes('/api/admin/')) {
      privateRequests.push(url)
      return
    }
    if (!url.endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string } | null
    if (payload?.method?.startsWith('admin:'))
      privateRequests.push(payload.method)
  })

  await installKomariFixture(page, { hidePriceWhenLoggedOut: true, opsDashboard: true, visitorInfoEnabled: false })
  await page.clock.install()
  await openStablePage(page)
  await page.clock.fastForward(60_000)
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL('/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.waitForTimeout(250)

  expect(privateRequests).toEqual([])
})

test('hidden public prices do not trigger exchange-rate providers', async ({ page }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (/^https:\/\/(?:open\.er-api\.com|api\.frankfurter\.app)\//.test(request.url()))
      requests.push(request.url())
  })

  await installKomariFixture(page, {
    hidePriceWhenLoggedOut: true,
    opsDashboard: true,
  })
  await openStablePage(page)
  await page.waitForTimeout(250)
  expect(requests).toEqual([])

  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL('/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.waitForTimeout(250)
  expect(requests).toEqual([])
})

test('home accessible list desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { colorVisionFriendly: true, viewMode: 'list', hideEarth: true })
  await openStablePage(page)
  await expectSharedPingSampleInteraction(page)
  await expect(page).toHaveScreenshot('home-accessible-list-desktop.png', { fullPage: false })
})

test('home cobe layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'cobe' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-cobe-desktop.png', { fullPage: false })
})

test('home tiled layout desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { earthRenderer: 'tiled' })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-tiled-desktop.png', { fullPage: false })
})

test('home mini card metric icons remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { nodeCardSize: 'mini', hideEarth: true })
  await openStablePage(page)

  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(card.locator('[data-node-metric-icon="cpu"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="memory"]')).toBeVisible()
  await expect(card.locator('[data-node-metric-icon="traffic"]')).toBeVisible()
  await expect(card.getByRole('img', { name: 'CPU' })).toBeVisible()
  await expect(card.getByRole('img', { name: '内存' })).toBeVisible()
})

test('Transit node card size changes the real desktop grid density', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 1000 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, nodeCardSize: 'mini' })
  await openStablePage(page)

  const grid = page.locator('[data-node-card-grid]')
  await expect(grid).toHaveAttribute('data-node-card-size', 'mini')
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4)
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')).toHaveAttribute('data-transit-node-card-size', 'mini')
})

test('Transit compact node card keeps expiry text and date fully visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { opsDashboard: true, dark: true, nodeCardSize: 'compact' })
  await openStablePage(page)

  const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
  const expiryText = card.locator('[data-node-expiry-text]')
  const expiryDate = card.locator('[data-node-expiry-date]')

  await expect(expiryText).toHaveText('剩余 365 天')
  await expect(expiryDate).toHaveText('2027-07-25')
  await expect(expiryText).toBeVisible()
  await expect(expiryDate).toBeVisible()
  await expect.poll(() => expiryText.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect.poll(() => expiryDate.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('Transit cards reserve the same expiry height when no date is configured', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installKomariFixture(page, {
    opsDashboard: true,
    dark: true,
    hideEarth: true,
    nodeCardSize: 'compact',
    nodeCardWorstCase: true,
  })
  await openStablePage(page)

  const datedCard = page.getByRole('button', { name: /查看节点 北京联通精品线路/ }).locator('xpath=..')
  const undatedCard = page.getByRole('button', { name: '查看节点 香港边缘节点-超长名称布局测试 详情' }).locator('xpath=..')
  const datedExpiry = datedCard.locator('[data-node-expiry-row]')
  const undatedExpiry = undatedCard.locator('[data-node-expiry-row]')

  await expect(undatedExpiry.locator('[data-node-expiry-text]')).toHaveText('未设置到期')
  await expect(undatedExpiry.locator('[data-node-expiry-date]')).toHaveCount(0)
  await expect.poll(async () => {
    const [datedBox, undatedBox] = await Promise.all([datedExpiry.boundingBox(), undatedExpiry.boundingBox()])
    return datedBox && undatedBox ? Math.abs(datedBox.height - undatedBox.height) : Number.POSITIVE_INFINITY
  }).toBeLessThan(1)
  await expect.poll(async () => {
    const [datedBox, undatedBox] = await Promise.all([datedCard.boundingBox(), undatedCard.boundingBox()])
    return datedBox && undatedBox ? Math.abs(datedBox.height - undatedBox.height) : Number.POSITIVE_INFINITY
  }).toBeLessThan(1)
})

test('Transit worst-case node cards remain complete and responsive across densities', async ({ page }) => {
  // 详情栅格最多两列：网络概览 | 三网回程，三网质量始终占满整行——一整排采样格
  // 挤进半列就读不出来了。窄卡退回单列。
  const cases = [
    { width: 320, height: 900, size: 'mini', columns: 1 },
    { width: 390, height: 900, size: 'compact', columns: 1 },
    { width: 768, height: 1000, size: 'comfortable', columns: 2 },
    { width: 1280, height: 900, size: 'compact', columns: 2 },
    { width: 1700, height: 1000, size: 'large', columns: 2 },
  ] as const

  for (const testCase of cases) {
    await page.setViewportSize({ width: testCase.width, height: testCase.height })
    await installKomariFixture(page, {
      opsDashboard: true,
      dark: true,
      hideEarth: true,
      nodeCardSize: testCase.size,
      nodeCardWorstCase: true,
    })
    await openStablePage(page)

    const card = page.getByRole('button', { name: /查看节点 北京联通精品线路/ }).locator('xpath=..')
    const detailGrid = card.locator('[data-node-card-detail-grid]')
    const expiryText = card.locator('[data-node-expiry-text]')
    const expiryDate = card.locator('[data-node-expiry-date]')
    const name = card.locator('[data-node-name]')

    await expect(card).toHaveAttribute('data-transit-node-card-size', testCase.size)
    await expect(name).toHaveAttribute('title', '北京联通精品线路-日本东京-A100-超长节点名称完整展示压力测试')
    await expect.poll(() => name.evaluate(element => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) * 2 + 1)).toBe(true)
    await expect.poll(() => card.evaluate((element) => {
      const nodeName = element.querySelector<HTMLElement>('[data-node-name]')
      if (!nodeName)
        return Number.NEGATIVE_INFINITY
      const cardBox = element.getBoundingClientRect()
      const borderWidth = Number.parseFloat(getComputedStyle(element).borderLeftWidth)
      return nodeName.getBoundingClientRect().left - cardBox.left - borderWidth
    })).toBeGreaterThanOrEqual(20)
    await expect(expiryText).toHaveText(/剩余 \d+ 天/)
    await expect(expiryDate).toHaveText('2037-01-01')
    await expect.poll(() => detailGrid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(testCase.columns)
    await expect.poll(async () => {
      const [textBox, dateBox] = await Promise.all([expiryText.boundingBox(), expiryDate.boundingBox()])
      return textBox && dateBox ? Math.abs(textBox.x - dateBox.x) : Number.POSITIVE_INFINITY
    }).toBeLessThan(1)

    const completeTextSelectors = [
      '[data-node-uptime]',
      '[data-node-price]',
      '[data-node-resource-value]',
      // 上下行改成了「标签 + 数值」两行，选择器跟着走；留 span 的话匹配为空、
      // every() 对空数组恒真，这条断言会静默失效。
      '[data-node-speed-cell] > div',
      '[data-node-traffic-value]',
      '[data-node-expiry-text]',
      '[data-node-expiry-date]',
      '[data-node-carrier-row] > span',
      '[data-node-carrier-row] > strong',
    ]
    for (const selector of completeTextSelectors) {
      const elements = card.locator(selector)
      await expect.poll(() => elements.evaluateAll(items => items.every(item => item.scrollWidth <= item.clientWidth + 1))).toBe(true)
    }

    await expect.poll(() => card.locator('[data-node-card-detail-grid] > .node-card-cell').evaluateAll((cells) => {
      const boxes = cells.map(cell => cell.getBoundingClientRect())
      return boxes.every((box, index) => boxes.every((other, otherIndex) => index === otherIndex
        || box.right <= other.left + 0.5
        || other.right <= box.left + 0.5
        || box.bottom <= other.top + 0.5
        || other.bottom <= box.top + 0.5))
    })).toBe(true)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    if (testCase.width >= 768) {
      const items = page.locator('[data-node-card-grid] > [data-server-order-item], [data-node-card-grid] > div')
      await expect.poll(() => items.evaluateAll((elements) => {
        const rows = new Map<number, number[]>()
        for (const item of elements) {
          const box = item.getBoundingClientRect()
          const rowKey = Math.round(box.top)
          rows.set(rowKey, [...(rows.get(rowKey) ?? []), box.height])
        }
        return [...rows.values()].every(heights => heights.length < 2 || Math.max(...heights) - Math.min(...heights) < 1)
      })).toBe(true)
    }

    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('node card expiry uses red through 5 days and yellow through 10 days', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { expiryThresholds: true, hideEarth: true })
  await openStablePage(page)

  const criticalCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  const warningCard = page.getByRole('button', { name: '查看节点 香港边缘节点-超长名称布局测试 详情' })
  const criticalExpiry = criticalCard.getByText('剩余', { exact: true }).locator('..')
  const warningExpiry = warningCard.getByText('剩余', { exact: true }).locator('..')

  await expect(criticalExpiry).toContainText('剩余5天')
  await expect(criticalExpiry).toHaveClass(/text-destructive/)
  await expect(warningExpiry).toContainText('剩余10天')
  await expect(warningExpiry).toHaveClass(/text-warning/)
})

test('free node pricing stays semantic across home, finance, and detail', async ({ page }) => {
  const freeNodeName = '主控-洛杉矶'
  const freeNodeUuid = '00000000-0000-4000-8000-000000000001'
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { freePriceNode: true, hideEarth: true })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: `查看节点 ${freeNodeName} 详情` })
  await expect(nodeCard.getByText('免费', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('无', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('免费 / 年', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '查看剩余价值明细' }).click()
  const financeDialog = page.getByRole('dialog', { name: '价值与费用明细' })
  await expect(financeDialog.getByText(freeNodeName, { exact: true })).toHaveCount(0)
  await financeDialog.getByLabel('排除免费节点').uncheck()
  const freeNodeRow = financeDialog.getByRole('cell', { name: freeNodeName, exact: true }).locator('..')
  await expect(freeNodeRow).toBeVisible()
  await expect(freeNodeRow.getByText('免费', { exact: true })).toBeVisible()
  await expect(freeNodeRow.getByText('无', { exact: true })).toBeVisible()

  await page.goto(`/instance/${freeNodeUuid}`)
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await expect(page.getByText('节点价格', { exact: true })).toBeVisible()
  await expect(page.getByText('剩余价值', { exact: true })).toBeVisible()
  await expect(page.getByText('无', { exact: true })).toBeVisible()
  await expect(page.getByText('免费 / 月', { exact: true })).toHaveCount(0)
})

test('Transit node card keeps the free-price sentinel visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { opsDashboard: true, freePriceNode: true, hideEarth: true })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
  await expect(nodeCard.getByText('免费', { exact: true })).toBeVisible()
  await expect(nodeCard.getByText('免费 / 月', { exact: true })).toHaveCount(0)
})

test('detail light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-light-desktop.png', { fullPage: false })
})

// 回程徽章挤进节点卡的标签行是这个功能唯一真正有布局风险的地方：TransitNodeCard
// 的 footer 单行不换行，NodeCard 的密度最小到 mini。逐档实测，每档一个独立 test，
// 因为 installKomariFixture 在同一个 page 上重复安装会叠加路由与 initScript。
// 默认节点卡把回程判定塞进标签行，最窄到 mini 密度都不能撑破。
for (const nodeCardSize of ['mini', 'compact', 'comfortable', 'large'] as const) {
  test(`return route badges fit the NodeCard tag row at ${nodeCardSize} density`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, { returnRouteTag: 'fresh', nodeCardSize })
    await openStablePage(page, '/')

    // 只有 1 号节点带回程标签，按徽章文本定位到它那张卡的标签行。
    const row = page.locator('[data-node-tag-row]').filter({ hasText: 'CN2GIA' }).first()
    await expect(row).toBeVisible()

    const layout = await row.evaluate(el => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      routeBadges: el.querySelectorAll('[data-slot="badge"]').length,
    }))

    expect(layout.scrollWidth, `NodeCard @ ${nodeCardSize} 标签行横向溢出`).toBeLessThanOrEqual(layout.clientWidth)
    expect(layout.routeBadges, `NodeCard @ ${nodeCardSize} 回程徽章数量不对`).toBeGreaterThanOrEqual(3)
  })
}

// 运维卡改用独立的「三网回程」面板，和「网络概览」并排；三网质量占满整行。
for (const nodeCardSize of ['mini', 'compact', 'comfortable', 'large'] as const) {
  test(`return route panel fits the TransitNodeCard at ${nodeCardSize} density`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await installKomariFixture(page, { returnRouteTag: 'fresh', nodeCardSize, opsDashboard: true, authenticated: true })
    await openStablePage(page, '/')

    const panel = page.locator('[data-node-route-panel]').first()
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('三网回程')
    await expect(panel).toContainText('CN2GIA')

    const layout = await panel.evaluate((el) => {
      const grid = el.closest('[data-node-card-detail-grid]')!
      const network = grid.querySelector('[data-node-network-cell]')!
      const insight = grid.querySelector('[data-node-insight-panel]')
      return {
        panelOverflow: el.scrollWidth - el.clientWidth,
        // 网络概览和三网回程必须并排（同一行顶部对齐），三网质量必须换行到下面。
        sameRowAsNetwork: Math.abs(el.getBoundingClientRect().top - network.getBoundingClientRect().top) < 2,
        insightBelow: insight ? insight.getBoundingClientRect().top > el.getBoundingClientRect().top : false,
        rows: el.querySelectorAll('[data-route-lane]').length,
      }
    })

    expect(layout.panelOverflow, `TransitNodeCard @ ${nodeCardSize} 回程面板横向溢出`).toBeLessThanOrEqual(0)
    expect(layout.sameRowAsNetwork, `TransitNodeCard @ ${nodeCardSize} 回程面板未与网络概览并排`).toBe(true)
    expect(layout.insightBelow, `TransitNodeCard @ ${nodeCardSize} 三网质量未换行到下方`).toBe(true)
    expect(layout.rows, `TransitNodeCard @ ${nodeCardSize} 回程面板应有三家运营商`).toBe(3)
  })
}

test('full-width network panel only spreads to four columns when the card is wide', async ({ page }) => {
  // `--full` 只说明这个节点没有回程数据，不代表容器很宽。窄卡上摊成四列会得到
  // 四个五十几像素的窄列，比同样宽度、有回程数据时的 2×2 还挤。
  await page.setViewportSize({ width: 320, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, nodeCardSize: 'mini', nodeCardWorstCase: true })
  await openStablePage(page, '/')

  const columns = await page.locator('[data-node-network-cell]').first().evaluate((el) => {
    const grid = el.querySelector<HTMLElement>('[data-node-network-grid]')!
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length
  })
  expect(columns, '窄卡上网络概览不应摊成四列').toBe(2)
})

test('transit card without route data lets the network panel span the full row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installKomariFixture(page, { opsDashboard: true, authenticated: true })
  await openStablePage(page, '/')

  await expect(page.locator('[data-node-route-panel]')).toHaveCount(0)
  const network = page.locator('[data-node-network-cell]').first()
  await expect(network).toHaveClass(/node-card-cell--full/)

  // 卡片够宽时才把四项摊成一排，窄卡的对照见上一个用例。
  const columns = await network.evaluate((el) => {
    const grid = el.querySelector<HTMLElement>('[data-node-network-grid]')!
    return getComputedStyle(grid).gridTemplateColumns.split(' ').length
  })
  expect(columns, '宽卡上网络概览应摊成四列').toBe(4)
})

test('return route lanes expose unclipped evidence and lead from carrier labels to route verdicts', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installKomariFixture(page, { returnRouteTag: 'fresh', opsDashboard: true, authenticated: true })
  await openStablePage(page, '/')

  const panel = page.locator('[data-node-route-panel]').first()
  const telecomLane = panel.getByRole('button', { name: /电信回程/ })
  await expect(telecomLane).toBeVisible()
  await expect(telecomLane.getByText('电信', { exact: true })).toHaveCSS('white-space', 'nowrap')

  const positions = await telecomLane.evaluate((lane) => {
    const labels = [...lane.querySelectorAll('span')]
    const route = labels.find(node => node.textContent?.trim() === 'CN2GIA')!
    const carrier = labels.find(node => node.textContent?.trim() === '电信')!
    return {
      routeX: route.getBoundingClientRect().x,
      carrierX: carrier.getBoundingClientRect().x,
    }
  })
  expect(positions.carrierX, '参考设计要求运营商在左、线路判定在右').toBeLessThan(positions.routeX)
  await expect(telecomLane.locator('[data-grade="精品线路"]')).toBeVisible()

  await expect(telecomLane).toHaveAttribute('aria-label', /AS4809/)
  await telecomLane.focus()
  const tooltip = page.locator('[data-route-evidence-tooltip]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('AS4809')
  const tooltipBounds = await tooltip.boundingBox()
  expect(tooltipBounds).not.toBeNull()
  expect(tooltipBounds!.x, '回程依据浮层不能越过视口左侧').toBeGreaterThanOrEqual(0)
  expect(tooltipBounds!.y, '回程依据浮层不能越过视口顶部').toBeGreaterThanOrEqual(0)
  expect(tooltipBounds!.x + tooltipBounds!.width, '回程依据浮层不能越过视口右侧').toBeLessThanOrEqual(1280)

  // 路线行用于查看依据，不应把点击透传给卡片底层的详情按钮。
  await telecomLane.click()
  expect(new URL(page.url()).pathname).toBe('/')
})

test('route probe prefers the fixed-purpose node helper and writes its tag back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeCompanion: true,
    routeProbeEnabled: true,
  })
  await openStablePage(page, '/')

  await page.getByRole('button', { name: /检测回程/ }).click()
  await expect.poll(() => readRouteProbeEdits().length, { timeout: 15_000 }).toBeGreaterThan(0)
  const summary = page.locator('[data-route-probe-summary]')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('台已更新')
  await expect(summary).not.toContainText('探测失败')

  const calls = readRouteProbeCompanionCalls()
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ city: 'beijing', guard: '1' })
  expect(calls[0]!.clients.every(uuid => uuid.startsWith('00000000-0000-4000-8000'))).toBe(true)
  expect(readRouteProbeExecCalls()).toHaveLength(0)
  expect(readRouteProbeEdits()[0]!.tags).toMatch(/transit-route:ct=4809\.4809\.4134,cu=4837\.4837,cm=58807\.9808@\d+/)
})

test('long inconclusive return-route verdicts stay readable and their evidence escapes card clipping', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, {
    authenticated: true,
    opsDashboard: true,
    nodeCardSize: 'mini',
    returnRouteTag: 'inconclusive',
  })
  await openStablePage(page, '/')

  const panel = page.locator('[data-node-route-panel]').first()
  await expect(panel).toBeVisible()
  await expect(panel.getByText('仅见电信目的网', { exact: true })).toBeVisible()
  await expect(panel.getByText('仅见联通目的网', { exact: true })).toBeVisible()

  const layout = await panel.evaluate((el) => {
    const badges = [...el.querySelectorAll<HTMLElement>('.node-route-badge')]
    return {
      panelOverflow: el.scrollWidth - el.clientWidth,
      clippedBadges: badges.filter(badge => badge.scrollWidth > badge.clientWidth).length,
    }
  })
  expect(layout.panelOverflow, '长判定不能撑破回程面板').toBeLessThanOrEqual(0)
  expect(layout.clippedBadges, '长判定不能被省略或裁掉').toBe(0)

  await panel.getByRole('button', { name: /电信回程/ }).hover()
  const tooltip = page.locator('[data-route-evidence-tooltip]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('判定依据')
  const bounds = await tooltip.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
})

test('route probe dispatches a constant command and writes the tag back when the companion is absent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  // 不给任何节点预置回程标签，于是全部进候选。
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeExec: true,
    routeProbeEnabled: true,
    routeProbeConcurrentTag: '命令执行后新增<purple>',
  })
  await openStablePage(page, '/')

  const button = page.getByRole('button', { name: /检测回程/ })
  await expect(button).toBeVisible()
  await button.click()

  await expect.poll(() => readRouteProbeEdits().length, { timeout: 30_000 }).toBeGreaterThan(0)

  const calls = readRouteProbeExecCalls()
  expect(calls).toHaveLength(1)

  // 命令里只能出现三网测速点地址，绝不能出现节点 UUID 或节点 IP。
  const command = calls[0]!.command
  expect(command).toContain('219.141.140.10')
  expect(command).not.toMatch(/00000000-0000-4000-8000/)
  expect(command).not.toContain('192.0.2.')
  expect(command).not.toMatch(/\$\{|\$\(|`/)

  // 节点只通过 clients 数组传递。
  expect(calls[0]!.clients.every(uuid => uuid.startsWith('00000000-0000-4000-8000'))).toBe(true)

  // 写回的 tags 必须保留原有标签，并且只有一条 transit-route。
  const edit = readRouteProbeEdits()[0]!
  expect(edit.tags).toMatch(/transit-route:ct=4809\.4809\.4134,cu=4837\.4837,cm=58807\.9808@\d+/)
  expect(edit.tags.match(/transit-route:/g)).toHaveLength(1)
  expect(edit.tags).toMatch(/core|edge/)
  expect(edit.tags).toContain('命令执行后新增<purple>')
})

test('route probe reports disabled remote control without pretending the route was updated', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeExec: true,
    routeProbeResult: 'remote-disabled',
    routeProbeEnabled: true,
  })
  await openStablePage(page, '/')

  await page.getByRole('button', { name: /检测回程/ }).click()
  const summary = page.locator('[data-route-probe-summary]')
  await expect(summary).toBeVisible({ timeout: 30_000 })
  await expect(summary).toContainText('远程控制已关闭')
  expect(readRouteProbeEdits()).toHaveLength(0)
})

test('route probe stays hidden when the optional feature is disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeCompanion: true,
    routeProbeLegacyAutoEnabled: true,
  })
  await openStablePage(page, '/')

  await expect(page.getByRole('button', { name: /检测回程/ })).toHaveCount(0)
  expect(readRouteProbeCompanionCalls()).toHaveLength(0)
})

test('route probe stays hidden for logged-out visitors', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { routeProbeExec: true, routeProbeEnabled: true })
  await openStablePage(page, '/')

  await expect(page.getByRole('button', { name: /检测回程/ })).toHaveCount(0)
  expect(readRouteProbeExecCalls()).toHaveLength(0)
})

test('carrier target health center is admin-only and never changes targets on open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, topologyAutoRepairEnabled: false })
  await openStablePage(page, '/')

  await page.getByRole('button', { name: '打开监测目标健康中心' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('监测目标健康')
  await expect(dialog.getByText('北京移动', { exact: true })).toBeVisible()
  await expect(dialog.getByText('上海移动', { exact: true })).toBeVisible()
  await expect(dialog.getByText('广州移动', { exact: true })).toBeVisible()
  await expect(dialog).toContainText('不会自动修改现有任务')
  await dialog.getByRole('button', { name: /北京移动.*证据不足/ }).click()
  await expect(dialog.getByRole('button', { name: '验证备用目标' })).toBeVisible()

  // 打开与读取本身不创建任务；只有管理员明确点击验证后才允许 mutation。
  await expect(dialog.getByRole('button', { name: /证据不足/ })).toHaveCount(9)
})

test('carrier target health center is unavailable to logged-out visitors', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await installKomariFixture(page, { opsDashboard: true })
  await openStablePage(page, '/')
  await expect(page.getByRole('button', { name: '打开监测目标健康中心' })).toHaveCount(0)
})

test('carrier target migration validates a canary and switches to a fresh task id', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    opsDashboard: true,
    topologyAutoRepairEnabled: false,
    carrierRawSamples: true,
    topologyProbeStats: [11, 12, 13, 101, 102].map(taskId => ({ task_id: taskId, total: 5, valid: 5 })),
  })
  await openStablePage(page, '/')
  await page.getByRole('button', { name: '打开监测目标健康中心' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /北京移动/ }).click()
  await dialog.getByRole('button', { name: '验证备用目标' }).click()
  await expect(dialog).toContainText('候选目标已达到迁移门槛')
  const migrate = dialog.getByRole('button', { name: '迁移到此目标' })
  await migrate.click()
  await dialog.getByRole('button', { name: '再次点击确认迁移' }).click()
  await expect(dialog).toContainText('目标迁移成功，旧历史已隔离')
  await expect(dialog.getByText('TCP · 221.130.33.52:53', { exact: true }).first()).toBeVisible()
})

test('carrier target migration compensates a failed switch and reports the old task retained', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    opsDashboard: true,
    topologyAutoRepairEnabled: false,
    carrierMigrationDeleteFailure: true,
    carrierRawSamples: true,
    topologyProbeStats: [11, 12, 13, 101, 102].map(taskId => ({ task_id: taskId, total: 5, valid: 5 })),
  })
  await openStablePage(page, '/')
  await page.getByRole('button', { name: '打开监测目标健康中心' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /北京移动/ }).click()
  await dialog.getByRole('button', { name: '验证备用目标' }).click()
  await expect(dialog).toContainText('候选目标已达到迁移门槛')
  await dialog.getByRole('button', { name: '迁移到此目标' }).click()
  await dialog.getByRole('button', { name: '再次点击确认迁移' }).click()
  await expect(dialog).toContainText('旧任务已保留')
  await expect(dialog).toContainText('旧任务清理失败')
  await expect(dialog.getByText('TCP · 198.51.100.13:80', { exact: true }).first()).toBeVisible()
})

test('route probe setup wizard checks the environment without probing and enables detection', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as typeof window & { __copiedInstallCommand?: string }).__copiedInstallCommand = value
        },
      },
    })
  })
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeCompanion: true,
    routeProbeMissingHelperUuids: ['00000000-0000-4000-8000-000000000002'],
  })
  await openStablePage(page, '/')

  await expect(page.getByRole('button', { name: /检测回程/ })).toHaveCount(0)
  const openButton = page.getByRole('button', { name: '配置回程检测' })
  await expect(openButton).toBeVisible()
  await openButton.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('已安装 · v1.1.4-visual')
  // 12 台默认虚构节点里有 1 台离线（伦敦-离线归档），离线节点不计入候选，
  // 所以在线助手数是 12 - 1（离线）- 1（缺助手）= 10。
  await expect(dialog).toContainText('10 台在线')
  await expect(dialog).toContainText('还有 1 台境外节点助手未连接，请检查安装或服务状态')
  await expect(dialog).toContainText('v1.3.12')
  await expect(dialog).toContainText('版本提示不阻止探测')
  await expect(dialog).toContainText('耗时 1234 ms')

  // 环境检查阶段只读了花名册，不应该触发任何一次真实的探测入队。
  expect(readRouteProbeCompanionCalls()).toHaveLength(0)

  // HTTP 页面不得生成自动降级凭据传输的命令；HTTPS 命令另有浏览器回归。
  await expect(dialog.getByRole('button', { name: '复制安装命令' })).toBeDisabled()
  await expect(dialog).toContainText('请通过 HTTPS 地址打开面板后生成安装命令')
  const copiedCommand = await page.evaluate(() => (window as typeof window & { __copiedInstallCommand?: string }).__copiedInstallCommand ?? '')
  expect(copiedCommand).toBe('')

  await dialog.getByRole('button', { name: '香港边缘节点-超长名称布局测试' }).click()
  const copiedToken = await page.evaluate(() => (window as typeof window & { __copiedInstallCommand?: string }).__copiedInstallCommand ?? '')
  expect(copiedToken).toBe('agent-token-1')

  await dialog.getByRole('button', { name: '继续安装' }).click()
  await expect(dialog).toContainText('10 台境外节点助手在线')
  await dialog.getByRole('button', { name: '启用并开始首次检测' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /检测回程|重新检测回程/ })).toBeVisible()
  expect(readRouteProbeCompanionCalls()).toHaveLength(0)
})

test('route probe setup wizard does not show a false all-clear helper row when the roster fetch fails', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    authenticated: true,
    routeProbeCompanion: true,
    routeProbeRosterFails: true,
  })
  await openStablePage(page, '/')

  await page.getByRole('button', { name: '配置回程检测' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('已安装 · v1.1.4-visual')
  await expect(dialog.getByText('internal error')).toBeVisible()

  // 插件确认已装，但花名册没查成功——不该显示“节点助手”行或任何“N 台在线”，
  // 那会把一次失败的检查伪装成“0 台助手在线”的确定结果。
  await expect(dialog.getByText('节点助手', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText(/台在线/)).toHaveCount(0)

  await expect(dialog.getByRole('button', { name: '继续安装' })).toBeDisabled()
})

test('detail shows classified return routes and hides the raw route tag', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { returnRouteTag: 'fresh' })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()

  await expect(page.getByText('电信CN2GIA', { exact: true })).toBeVisible()
  await expect(page.getByText('联通4837', { exact: true })).toBeVisible()
  await expect(page.getByText('移动CMIN2', { exact: true })).toBeVisible()
  // 保留标签不能再以普通彩色标签的形式漏出来。
  await expect(page.getByText('transit-route:')).toHaveCount(0)
})

test('stale return routes drop their grade colour', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { returnRouteTag: 'stale' })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()

  const badge = page.locator('[data-slot="badge"]', { hasText: '电信CN2GIA' })
  await expect(badge).toBeVisible()
  // 精品线路的绿色只在数据还新鲜时给，过期后统一转静音色。
  await expect(badge).not.toHaveClass(/emerald/)
  await expect(badge).toHaveClass(/muted-foreground/)
})

test('return routes without a timestamp are marked unknown and drop their grade colour', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { returnRouteTag: 'unknown' })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()

  const trigger = page.getByRole('button', { name: /电信回程.*采集时间未知/ })
  const badge = trigger.locator('[data-slot="badge"]')
  await expect(badge).toBeVisible()
  await expect(badge).not.toHaveClass(/emerald/)
  await expect(badge).toHaveClass(/muted-foreground/)

  await trigger.focus()
  await expect(page.locator('[data-route-evidence-tooltip]')).toContainText('采集时间未知，判定结果仅供参考')
})

test('detail dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-dark-mobile.png', { fullPage: false })
})

test('detail return restores the previous route and direct entry falls back home', async ({ page }) => {
  const nodeUuid = '00000000-0000-4000-8000-000000000001'
  await installKomariFixture(page, { opsDashboard: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${nodeUuid}`)
  await page.getByRole('button', { name: '返回上一页' }).click()
  await expect(page).toHaveURL('/')

  await page.goto(`/instance/${nodeUuid}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.evaluate(() => history.replaceState({ ...history.state, back: null }, '', location.href))
  await page.getByRole('button', { name: '返回上一页' }).click()
  await expect(page).toHaveURL('/')
})

test('detail keeps metric history when CPU series is omitted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { missingCpuMetricHistory: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')

  const cpuCard = page.locator('[data-load-chart-card="cpu"]')
  const loadRange = page.locator('[data-load-chart-range]')
  for (const view of ['4 小时', '1 天']) {
    await loadRange.getByRole('tab', { name: view, exact: true }).click()
    await expect(cpuCard).toContainText('-')
    await expect(page.getByText('暂无负载数据')).toHaveCount(0)
  }
})

test('detail ping requests stay scoped to the current node', async ({ page }) => {
  const currentUuid = '00000000-0000-4000-8000-000000000001'
  const metricCalls: Array<{ method: string, params: Record<string, unknown> }> = []
  const isPingMetricCall = (call: { method: string, params: Record<string, unknown> }): boolean => {
    const metricKeys = Array.isArray(call.params.metric_keys) ? call.params.metric_keys : []
    return call.method === 'public:getPingMetricStats'
      || metricKeys.includes('ping.latency_ms')
      || metricKeys.includes('ping.loss')
  }

  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return

    const payload = request.postDataJSON() as { method?: string, params?: Record<string, unknown> } | null
    if (payload?.method === 'public:queryMetrics' || payload?.method === 'public:getPingMetricStats') {
      metricCalls.push({ method: payload.method, params: payload.params ?? {} })
    }
  })

  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)

  await expect.poll(() => metricCalls.filter(isPingMetricCall).length).toBeGreaterThan(0)
  const homeSummaryCalls = metricCalls.filter(call => call.method === 'public:queryMetrics' && isPingMetricCall(call) && call.params.downsample !== false)
  expect(homeSummaryCalls.length).toBeGreaterThan(0)
  expect(homeSummaryCalls.every(call => call.params.max_points === 150)).toBe(true)
  const rawCalls = metricCalls.filter(call => call.method === 'public:queryMetrics' && call.params.downsample === false)
  expect(rawCalls.length).toBeGreaterThan(0)
  for (const call of rawCalls) {
    expect(call.params.max_points).toBe(1000)
    expect(call.params.fill_empty).toBe(false)
    expect(Array.isArray(call.params.entity_ids)).toBe(true)
    expect(Date.parse('2026-07-25T12:00:00.000Z') - Date.parse(String(call.params.start))).toBeLessThan(600_000)
  }

  metricCalls.length = 0
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${currentUuid}`)
  await expect(page.getByText('硬件信息')).toBeVisible()
  await page.waitForTimeout(2_000)

  const detailPingCalls = metricCalls.filter(isPingMetricCall)
  expect(detailPingCalls.length).toBeGreaterThan(0)
  expect(new Set(detailPingCalls.map(call => call.params.entity_id))).toEqual(new Set([currentUuid]))
})

test('detail ping tasks follow the backend task order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { pingTaskOrdering: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')

  const taskCards = page.locator('[data-ping-task-id]')
  await expect(taskCards).toHaveCount(3)
  await expect(taskCards.first()).toHaveAttribute('data-ping-task-id', '30')
  await expect(taskCards.nth(1)).toHaveAttribute('data-ping-task-id', '10')
  await expect(taskCards.nth(2)).toHaveAttribute('data-ping-task-id', '20')
  await expect(taskCards).toContainText(['浙江移动', '浙江联通', '浙江电信'])
})
