import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

const LIGHT_NODE_SURFACE = /^(?:rgba\(248, 250, 252, 0\.9\)|oklch\(0\.965 0\.008 252\))$/

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

async function openStablePage(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
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
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * targetRatio, { steps: 12 })
  await page.mouse.up()
  await page.mouse.move(1, 1)
  await page.waitForTimeout(200)
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
  await installKomariFixture(page, { pandaOps: true })
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
  await expect(page).toHaveScreenshot('transit-light-desktop.png', { fullPage: false })
})

test('Transit light mobile keeps the vertical route readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { pandaOps: true })
  await openStablePage(page)

  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(2)
  await expect(page.locator('.topology-scroll')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')).toHaveCSS('background-color', LIGHT_NODE_SURFACE)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
  await expect(page).toHaveScreenshot('transit-light-mobile.png', { fullPage: false })
})

test('Transit dark asset summary keeps a readable text hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true })
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
  await installKomariFixture(page, { pandaOps: true, dark: true })
  await openStablePage(page)

  await expect.poll(() => reliabilityRequests.length).toBe(4)
  expect(reliabilityRequests.every(request => Array.isArray(request.params?.entity_ids) && request.params.entity_ids.length === 2)).toBe(true)
  expect(reliabilityRequests.some(request => request.params?.entity_id !== undefined)).toBe(false)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  await expect(page.locator('[data-panda-alert-strip]')).toBeVisible()
  const alertStrip = page.locator('[data-panda-alert-strip]')
  await expect(alertStrip.getByRole('heading', { name: '11 个异常需要关注' })).toBeVisible()
  await expect(alertStrip.getByRole('button', { name: '另有 7 个' })).toBeVisible()
  const topologySection = page.getByRole('heading', { name: '线路状态' }).locator('xpath=ancestor::section[1]')
  await expect.poll(async () => {
    const [alertBox, topologyBox] = await Promise.all([alertStrip.boundingBox(), topologySection.boundingBox()])
    return alertBox && topologyBox ? Math.round(topologyBox.y - alertBox.y - alertBox.height) : 0
  }).toBe(12)
  await expect(page.locator('[data-topology-direction]')).toHaveCount(3)
  const routeScores = page.locator('[data-topology-route-score]')
  await expect(routeScores).toHaveCount(2)
  await expect(routeScores.first()).toContainText(/\d+ 分/)
  const historyButtons = page.getByRole('button', { name: '查看线路历史' })
  await expect(historyButtons).toHaveCount(4)
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
  const averageRenderedHeight = async (groupIndex: number) => {
    const heights = await segmentGroups.nth(groupIndex).locator('[data-topology-sample]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-topology-sample-height'))))
    return heights.reduce((sum, height) => sum + height, 0) / heights.length
  }
  expect(Math.abs(await averageRenderedHeight(1) - await averageRenderedHeight(2))).toBeLessThan(2)
  await expect(segmentGroups.nth(1).locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /\d{2,3} ms/)
  await expect(segmentGroups.nth(2).locator('[data-topology-sample]').first()).toHaveAttribute('aria-label', /[012] ms/)
  const firstSample = samples.first()
  await firstSample.hover()
  const sampleDetail = page.locator('[data-topology-sample-detail]')
  await expect(sampleDetail).toBeVisible()
  await expect(sampleDetail).toContainText(/\d+ ms/)
  await expect(sampleDetail).toContainText('丢包')
  await expect(sampleDetail).toContainText(/\d{2}:\d{2}:\d{2}/)
  await expect(firstSample).toHaveAttribute('aria-label', /ms，丢包/)
  await expect(firstSample).toHaveAttribute('data-sample-trigger', '')
  await expect(firstSample.locator('xpath=..')).toHaveAttribute('data-sample-kind', 'topology')
  const firstMetric = page.locator('[data-topology-current-metric]').first()
  const firstBaseline = page.locator('[data-topology-edge-baseline]').first()
  await expect.poll(async () => {
    const [metricBox, baselineBox] = await Promise.all([firstMetric.boundingBox(), firstBaseline.boundingBox()])
    return Boolean(metricBox && baselineBox && metricBox.y + metricBox.height < baselineBox.y)
  }).toBe(true)
  await page.getByRole('heading', { name: '线路状态' }).hover()
  await expect(sampleDetail).toBeHidden()
  await historyButtons.first().click()
  await expect(page.getByRole('dialog')).toContainText('查看每一段链路的实时延迟、丢包与历史波动。')
  await expect(page.getByRole('dialog')).toContainText('健康评分')
  await expect(page.getByRole('dialog').locator('[data-topology-score-detail]')).toContainText('1/2 段有数据')
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '查看异常时间线' }).click()
  const timelineDialog = page.getByRole('dialog', { name: '异常时间线' })
  await expect(timelineDialog).toBeVisible()
  await expect(timelineDialog.locator('[data-panda-incident-event]').first()).toBeVisible()
  await timelineDialog.getByRole('button', { name: '关闭' }).click()
  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(nodeCard).toBeVisible()
  const nodeCardSurface = nodeCard.locator('xpath=..')
  await expect(nodeCardSurface.locator('.panda-node-card__header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nodeCardSurface.locator('.panda-node-card__header')).toHaveCSS('border-bottom-width', '0px')
  const healthyCard = page.getByRole('button', { name: '查看节点 香港边缘节点-超长名称布局测试 详情' }).locator('xpath=..')
  await expect(healthyCard.locator('[data-node-status-edge]')).toHaveClass(/bg-emerald-500\/85/)
  await expect(healthyCard.locator('[data-node-alert-edge]')).toHaveCount(0)
  const carrierSample = nodeCardSurface.locator('[data-carrier-sample][aria-label*="ms"]').first()
  await carrierSample.hover()
  const carrierTooltip = page.locator('[data-carrier-sample-tooltip]')
  await expect(carrierTooltip).toBeVisible()
  await expect(carrierTooltip).toContainText(/ms/)
  await expect(carrierTooltip).toContainText('丢包')
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
  await expect(page.locator('[data-node-alert-reason]').first()).toBeVisible()
  const alertCard = page.getByRole('button', { name: '查看节点 东京-高负载 详情' }).locator('xpath=..')
  const plainCard = page.getByRole('button', { name: '查看节点 伦敦-离线归档 详情' }).locator('xpath=..')
  const alertReason = alertCard.locator('[data-node-alert-reason]')
  await expect(alertReason).toBeVisible()
  await expect(alertReason).toHaveCSS('border-top-width', '0px')
  await expect(alertCard.locator('[data-node-alert-edge]')).toBeVisible()
  await expect(alertCard.locator('[data-node-status-edge]')).toHaveClass(/bg-rose-500\/85/)
  await expect(plainCard.locator('[data-node-status-edge]')).toHaveCount(0)
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
  await installKomariFixture(page, { pandaOps: true, dark: true, pandaOpsComparableRoutes: true })
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

test('Transit mobile keeps document width contained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { pandaOps: true, dark: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  const mobileTelemetry = page.locator('#asset-summary .panda-telemetry-grid')
  await expect.poll(() => mobileTelemetry.evaluate((element) => {
    const style = getComputedStyle(element)
    return style.gridTemplateColumns.split(' ').filter(Boolean).length
  })).toBe(3)
  await expect.poll(() => mobileTelemetry.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const mobileAlertStrip = page.locator('[data-panda-alert-strip]')
  await expect(mobileAlertStrip.getByRole('heading', { name: '11 个异常需要关注' })).toBeVisible()
  await expect(mobileAlertStrip.getByRole('button', { name: '另有 9 个' })).toBeVisible()
  await mobileAlertStrip.getByRole('button', { name: '另有 9 个' }).click()
  await expect(mobileAlertStrip.getByRole('button', { name: '收起' })).toBeVisible()
  await expect(page.locator('[data-topology-mobile-route]')).toHaveCount(2)
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
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
})

test('Transit topology reports an unresolved configured node as an error', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, pandaOpsMissingNode: true })
  await openStablePage(page)

  await expect(page.getByText(/1 异常/)).toBeVisible()
  await expect(page.locator('[data-topology-route-status][data-status="error"]')).toHaveCount(1)
  await expect(page.getByText('异常', { exact: true })).toHaveCount(0)
})

test('Transit empty topology guides an authenticated operator into the manager', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, authenticated: true, emptyTopology: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '还没有配置线路' })).toBeVisible()
  await page.getByRole('button', { name: '配置第一条线路' }).click()
  await expect(page.getByRole('heading', { name: '拓扑管理' })).toBeVisible()
})

test('Transit topology manager saves through managed theme API', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/admin/theme/config?short=Transit'))
      saves.push(request.postDataJSON())
  })
  await openStablePage(page)

  await page.getByRole('button', { name: '管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '添加线路' }).click()
  await dialog.getByRole('button', { name: '保存并应用' }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(() => saves.length).toBe(1)
  expect(saves[0]).toMatchObject({ topologyEnabled: true })
})

test('Transit topology manager lists configured Ping tasks without recent samples', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, {
    pandaOps: true,
    dark: true,
    authenticated: true,
    pandaOpsNoRecentTask: true,
  })
  await openStablePage(page)

  await page.getByRole('button', { name: '管理', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '拓扑管理' })
  const taskSelect = dialog.getByLabel('第 2 条线路第 1 段 Ping 任务')
  await expect(taskSelect).toBeVisible()
  await expect(taskSelect.locator('option')).toContainText(['Configured-No-Recent-Sample'])
})

test('Transit node maintenance saves globally and updates alerts immediately', async ({ page }) => {
  const saves: Record<string, unknown>[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/admin/theme/config?short=Transit'))
      saves.push(request.postDataJSON() as Record<string, unknown>)
  })
  await openStablePage(page)

  const nodeCard = page.getByRole('button', { name: '查看节点 东京-高负载 详情' }).locator('xpath=..')
  await nodeCard.getByRole('button', { name: '管理节点 东京-高负载' }).click()
  const dialog = page.getByRole('dialog', { name: /节点运维/ })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '30 分钟' }).click()

  await expect.poll(() => saves.length).toBe(1)
  const controls = JSON.parse(String(saves[0]?.pandaOpsNodeControls)) as Record<string, { maintenanceUntil?: number }>
  expect(Object.values(controls).some(control => Number(control.maintenanceUntil) > 0)).toBe(true)
  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(nodeCard).toContainText('维护中')
  await expect(page.locator('[data-panda-alert-strip]').getByRole('heading', { name: '10 个异常需要关注' })).toBeVisible()
})

test('home quick controls, node comparison and network data change visible results', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, authenticated: true })
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

test('Transit server list filters and sorts reactive nodes without the blocked admin endpoint', async ({ page }) => {
  let blockedAdminListRequests = 0
  let nodeMetadataRequests = 0
  const savedOrders: Array<Record<string, number>> = []
  page.on('request', (request) => {
    if (request.url().includes('/api/admin/client/list'))
      blockedAdminListRequests++
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, number> } | null
    if (payload?.method === 'common:getNodes')
      nodeMetadataRequests++
    if (payload?.method === 'admin:orderClients' && payload.params)
      savedOrders.push(payload.params)
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, authenticated: true })
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
  await installKomariFixture(page, { pandaOps: true, authenticated: true })
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
  await installKomariFixture(page, { pandaOps: true, authenticated: true })
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
  await expect(page.getByText(/已导出 12 台节点的 JSON 快照/)).toBeVisible()
})

test('audit tool shows real core logs without unsupported visitor controls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, authenticated: true })
  await openStablePage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /日志：/ }).click()

  await expect(page.getByText('更新主题配置')).toBeVisible()
  await expect(page.getByText('管理员登录')).toBeVisible()
  await expect(page.getByRole('tab', { name: '访客安全' })).toHaveCount(0)
  await expect(page.getByText(/等待核心发布访客审计能力/)).toHaveCount(0)
})

test('provider value sorting changes the ranked node order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, authenticated: true })
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
  await installKomariFixture(page, { pandaOps: true, authenticated: true, visitorAuditSupported: true })
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
  await installKomariFixture(page, { pandaOps: true, dark: true, nodeCardSize: 'mini' })
  await openStablePage(page)

  const grid = page.locator('[data-node-card-grid]')
  await expect(grid).toHaveAttribute('data-node-card-size', 'mini')
  await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4)
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')).toHaveAttribute('data-panda-node-card-size', 'mini')
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

test('detail light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-light-desktop.png', { fullPage: false })
})

test('detail dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000002')
  await expect(page.getByText('硬件信息')).toBeVisible()
  await expect(page).toHaveScreenshot('detail-dark-mobile.png', { fullPage: false })
})

test('detail short history falls back when metric history omits CPU', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { missingCpuMetricHistory: true })
  await openStablePage(page, '/instance/00000000-0000-4000-8000-000000000001')

  const cpuValue = page.locator('[data-load-chart-card="cpu"] [data-latest-cpu]')
  const loadRange = page.locator('[data-load-chart-range]')
  for (const view of ['4 小时', '1 天']) {
    await loadRange.getByRole('tab', { name: view, exact: true }).click()
    await expect(cpuValue).toHaveText(/^\d+\.\d$/)
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
  const homeSummaryCalls = metricCalls.filter(call => call.method === 'public:queryMetrics' && isPingMetricCall(call))
  expect(homeSummaryCalls.length).toBeGreaterThan(0)
  expect(homeSummaryCalls.every(call => call.params.max_points === 150)).toBe(true)

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
