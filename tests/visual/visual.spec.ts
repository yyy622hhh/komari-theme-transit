import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

const STABLE_STYLE = `
  *, *::before, *::after {
    animation: none !important;
    caret-color: transparent !important;
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
  await page.waitForTimeout(700)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
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
    await expect.poll(() => bars.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0)
  }
}

test('home light desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page)
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expectNodePingBars(page)
  await expect(page).toHaveScreenshot('home-light-desktop.png', { fullPage: false })
})

test('home dark mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { dark: true })
  await openStablePage(page)
  await expectNodeMetricIcons(page)
  await expect(page).toHaveScreenshot('home-dark-mobile.png', { fullPage: false })
})

test('PandaOps desktop topology and cards remain contained', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看线路历史' })).toHaveCount(2)
  for (const status of await page.locator('[data-topology-status]').all()) {
    await expect(status).toHaveCSS('white-space', 'nowrap')
    await expect.poll(() => status.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  }
  for (const line of await page.locator('[data-topology-edge-line]').all()) {
    await expect.poll(() => line.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(7)
    await expect.poll(() => line.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(64)
  }
  const samples = page.locator('[data-topology-sample]')
  await expect.poll(() => samples.count()).toBeGreaterThan(0)
  const firstSample = samples.first()
  await firstSample.hover()
  const sampleDetail = page.locator('[data-topology-sample-detail]')
  await expect(sampleDetail).toBeVisible()
  await expect(sampleDetail).toContainText(/\d+ ms/)
  await expect(sampleDetail).toContainText('丢包')
  await expect(sampleDetail).toContainText(/第 [12] 段/)
  await expect(firstSample).toHaveAttribute('aria-label', /ms，丢包/)
  await page.getByRole('heading', { name: '线路状态' }).hover()
  await expect(sampleDetail).toBeHidden()
  const nodeCard = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })
  await expect(nodeCard).toBeVisible()
  await expect(nodeCard.locator('.panda-node-card__header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nodeCard.locator('.panda-node-card__header')).toHaveCSS('border-bottom-width', '0px')
  const expiryDate = page.getByRole('button', { name: '查看节点 台北-流量预警 详情' }).locator('[data-node-expiry-date]')
  await expect(expiryDate).toHaveText('2026-08-02')
  await expect.poll(() => expiryDate.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
})

test('PandaOps mobile keeps document width contained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { pandaOps: true, dark: true })
  await openStablePage(page)

  await expect(page.getByRole('heading', { name: '线路状态' })).toBeVisible()
  await expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.locator('html').evaluate(element => element.clientWidth))
})

test('PandaOps topology reports an unresolved configured node as an error', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, pandaOpsMissingNode: true })
  await openStablePage(page)

  await expect(page.getByText(/1 异常/)).toBeVisible()
  await expect(page.getByText('异常', { exact: true })).toBeVisible()
})

test('PandaOps topology manager saves through managed theme API', async ({ page }) => {
  const saves: unknown[] = []
  await page.setViewportSize({ width: 1440, height: 900 })
  await installKomariFixture(page, { pandaOps: true, dark: true, authenticated: true })
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/api/admin/theme/config?short=PandaOps'))
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

test('PandaOps topology manager lists configured Ping tasks without recent samples', async ({ page }) => {
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
  await expect(page.getByText('96.4%')).toBeVisible()

  await page.getByRole('button', { name: /网络：/ }).click()
  await expect(page.getByText('IP 网络归属')).toBeVisible()
  await expect(page.getByText(/不包含 BGP 路由或 traceroute 推断/)).toBeVisible()
  await expect(page.getByText('ASN / BGP 拓扑')).toHaveCount(0)
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

test('home accessible list desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await installKomariFixture(page, { colorVisionFriendly: true, viewMode: 'list', hideEarth: true })
  await openStablePage(page)
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
