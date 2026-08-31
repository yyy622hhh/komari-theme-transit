import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from '../visual/fixtures/komari'

const uuid = '00000000-0000-4000-8000-000000000004'
const payload = '<img src="data:image/png;base64,AA==" onerror="document.title=\'TRANSIT_XSS_EXECUTED\'">'
const fixedNow = Date.parse('2026-07-25T12:00:00.000Z')

async function maliciousMetrics(page: Page) {
  await installKomariFixture(page)
  await page.route('**/api/public', route => route.fulfill({ json: {
    status: 'success',
    data: {
      sitename: 'Komari Visual Lab',
      theme: 'Transit',
      record_enabled: true,
      record_preserve_time: 720,
      ping_record_preserve_time: 720,
      theme_settings: { disablePageAnimation: true, chartDashboardPreset: 'full', gpuChartEnabled: true },
    },
  } }))
  await page.route('**/api/rpc2', (route) => {
    const body = route.request().postDataJSON()
    if (body.method === 'public:getPublicPingTasks')
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: [{ id: 11, name: payload, type: 'icmp', interval: 30 }] } })
    if (body.method === 'public:getPingMetricStats')
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { stats: [{ entity_id: uuid, task_id: '11', name: payload, interval: 30, total: 48, loss: 0, loss_approximate: false, avg: 22, min: 20, max: 24 }] } } })
    if (body.method !== 'public:queryMetrics')
      return route.fallback()
    const series = (body.params.metric_keys as string[]).map(metric_key => ({
      metric_key,
      entity_id: uuid,
      type: 'gauge',
      tags: metric_key.startsWith('gpu.')
        ? { device_index: '0', device_name: payload }
        : metric_key.startsWith('ping.') ? { task_id: '11', task_name: payload } : {},
      points: Array.from({ length: 48 }, (_, index) => ({ time: new Date(fixedNow - (47 - index) * 75_000).toISOString(), value: 20 + index % 5 })),
    }))
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { series, count: series.length } } })
  })
}

test('GPU and metric card HTML tooltips render untrusted device names as text', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  await maliciousMetrics(page)
  await page.goto(`/instance/${uuid}`)
  await page.getByRole('tab', { name: '4 小时', exact: true }).click()
  for (const title of ['GPU 利用率', 'GPU 显存', '温度', 'Ping 延迟']) {
    const card = page.getByText(title, { exact: true }).locator('xpath=ancestor::div[contains(@class,"text-card-foreground")][1]')
    const chart = card.locator('.echarts')
    await expect(chart).toBeVisible()
    await chart.scrollIntoViewIfNeeded()
    // Hover the actual canvas; the tooltip must exist, not merely avoid running a payload.
    const box = await chart.boundingBox()
    await chart.hover({ position: { x: box!.width * 0.85, y: 80 } })
    const tooltip = chart.locator('div[style*="z-index:"]')
    await expect(tooltip).toBeVisible()
    await expect(tooltip).toContainText(payload)
    await expect(tooltip.locator('img, svg[onload]')).toHaveCount(0)
    await expect(page).not.toHaveTitle('TRANSIT_XSS_EXECUTED')
    await page.mouse.move(0, 0)
  }
})

test('Ping history HTML tooltip does not execute a task name', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  await maliciousMetrics(page)
  await page.goto(`/instance/${uuid}`)
  const chart = page.locator('.echarts').last()
  await expect(page.locator('[data-ping-task-id="11"]')).toBeVisible()
  await chart.scrollIntoViewIfNeeded()
  await chart.hover({ position: { x: 160, y: 80 } })
  const tooltip = chart.locator('div[style*="z-index:"]')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText(payload)
  await expect(tooltip.locator('img')).toHaveCount(0)
  await expect(page).not.toHaveTitle('TRANSIT_XSS_EXECUTED')
})

test('HTTPS wizard copies a private fail-closed installer without node credentials', async ({ page, baseURL }) => {
  // Only the app's static assets are proxied to the local test server; fixture API routes
  // take precedence. No traffic or credentials go to an external HTTPS server.
  await page.route('https://transit.test/**', async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}`, headers: { ...route.request().headers(), host: new URL(baseURL!).host } })
    await route.fulfill({ response })
  })
  await installKomariFixture(page, { authenticated: true, routeProbeCompanion: true, routeProbeMissingHelperUuids: [uuid] })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as any).copiedCommand = value },
    } })
  })
  await page.goto('https://transit.test/')
  await page.getByRole('button', { name: '配置回程检测', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '复制安装命令' }).click()
  const command = await page.evaluate(() => (window as any).copiedCommand as string)
  const version = JSON.parse(readFileSync('komari-theme.json', 'utf8')).version
  expect(command).toContain(`releases/download/v${version}/transit-route-probe-helper.sh`)
  expect(command).toContain(`releases/download/v${version}/transit-collect-return-route.sh`)
  expect(command).toContain('mktemp -d /tmp/transit-route-probe-install.XXXXXX')
  expect(command).toContain('--endpoint \'https://transit.test\'')
  expect(command).toContain('|| exit 1')
  expect(command).not.toMatch(/agent-token|--token|--allow-insecure-http/)
})
