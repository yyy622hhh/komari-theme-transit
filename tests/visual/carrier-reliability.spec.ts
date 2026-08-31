import type { Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

for (const initial of ['missing', 'stale'] as const) {
  for (const dark of [false, true]) {
    test(`topology labels ${initial} history as fallback and restores live labels (${dark ? 'dark mobile' : 'light desktop'})`, async ({ page }) => {
      await page.setViewportSize({ width: dark ? 390 : 1440, height: 1000 })
      await installKomariFixture(page, { opsDashboard: true, dark, topologyAutoRepairEnabled: false })
      let outcome: 'missing' | 'stale' | 'healthy' = initial
      await page.route('**/api/rpc2', async (route) => {
        const payload = route.request().postDataJSON()
        const params = payload.params ?? {}
        const clients: string[] = params.entity_ids ?? [params.entity_id ?? params.uuid]
        const now = Date.parse('2026-07-25T12:00:00.000Z')
        const latest = now - (outcome === 'stale' ? 40 * 60_000 : 1000)
        let result: unknown
        if (payload.method === 'public:queryMetrics' && params.metric_keys?.every((key: string) => key.startsWith('ping.'))) {
          const series = outcome === 'missing'
            ? []
            : clients.flatMap(entity_id => params.metric_keys.map((metric_key: string) => ({
                entity_id,
                metric_key,
                downsampled: params.downsample !== false,
                tags: { task_id: '12', task_name: '北京电信' },
                points: Array.from({ length: 3 }, (_, index) => ({ time: new Date(latest - (2 - index) * 60_000).toISOString(), value: metric_key === 'ping.loss' ? 0 : 222, count: 1 })),
              })))
          result = { series, count: series.length }
        }
        else if (payload.method === 'public:getPingMetricStats') {
          const stats = outcome === 'missing' ? [] : clients.map(entity_id => ({ entity_id, task_id: '12', name: '北京电信', total: 3, valid: 3, avg: 222, latest: 222, loss: 0, loss_approximate: false }))
          result = { stats, count: stats.length }
        }
        else if (payload.method === 'public:getPingRecords' || (payload.method === 'common:getRecords' && params.type === 'ping')) {
          result = { count: 0, records: [], tasks: [] }
        }
        else {
          await route.fallback()
          return
        }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) })
      })
      await page.goto('/')
      const edge = page.locator('[data-topology-current-metric]').first()
      const container = edge.locator('xpath=..')
      await expect(container).toHaveAttribute('title', initial === 'stale' ? /实时数据已过期/ : /暂无匹配的实时数据/)
      await expect(edge).toHaveAttribute('data-topology-history-source', 'fallback')
      await expect(edge).toContainText('备用基线')
      await expect(edge).toContainText('51ms')
      await expect(edge).not.toContainText('近 1 小时')
      await expect(edge).not.toContainText('均值')
      await expect(edge).toHaveAttribute('aria-label', /备用配置基线 51ms/)
      await expect(container).toHaveAttribute('aria-label', /备用配置基线/)
      await test.info().attach(`topology-${initial}-fallback`, { body: await container.screenshot(), contentType: 'image/png' })
      outcome = 'healthy'
      // Use the existing shared resume scheduler; no component-local polling is introduced.
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await expect(edge).toHaveAttribute('data-topology-history-source', 'history')
      await expect(edge).toContainText('近 1 小时')
      await expect(edge.locator('strong')).toHaveText('222ms')
      await expect(edge).toContainText('近 1 小时均值')
      await expect(edge).not.toContainText('备用基线')
      await expect(edge).toHaveAttribute('aria-label', /近 1 小时平均 222ms/)
      await expect(container.locator('[data-topology-current]')).toHaveText('正常')
    })
  }
}

for (const [outcome, label] of [['healthy', '已恢复'], ['failed', '持续失败'], ['stale', '数据过期'], ['insufficient', '证据不足']] as const) {
  test(`carrier current ${outcome} does not overwrite the historical 3.3%`, async ({ page }) => {
    await installKomariFixture(page, { opsDashboard: true, carrierCommonModeLoss: true, carrierRecentOutcome: outcome })
    await page.goto('/')
    const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
    const row = card.locator('[data-node-carrier-row]').filter({ hasText: '联通' })
    await expect(row.locator('[data-probe-current]')).toHaveText(label)
    await expect(row.locator('[data-carrier-target-incident]')).toHaveText('3.3%')
    await expect(row.locator('[data-carrier-target-incident]')).toHaveAttribute('title', /近 1 小时探测失败率 3\.3%/)
    await expect(card.locator('[data-carrier-table-head]')).toContainText('失败率')
    await expect(card.locator('[data-node-insight-mode="carrier"]')).toContainText('近 1 小时曾异常')
    await expect(page.locator('[data-topology-current]').first()).toContainText(outcome === 'healthy' ? '正常' : label)
    await expect(page.locator('[data-topology-current-metric]').first()).toHaveAttribute('aria-label', /近 1 小时平均 .*探测失败率/)
    const statusBox = await page.locator('[data-topology-current]').first().boundingBox()
    const railBox = await page.locator('[data-topology-edge-line]').first().boundingBox()
    expect(statusBox!.y + statusBox!.height).toBeLessThan(railBox!.y)
    if (outcome === 'healthy') {
      await test.info().attach('current-normal-historical-3.3', { body: await card.screenshot(), contentType: 'image/png' })
      await page.locator('[data-topology-current-metric]').first().click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText('近 1 小时线路健康评分')
      await expect(dialog.locator('[data-segment-current]').first()).toContainText('当前：正常')
      await expect(dialog).toContainText('TCP 探测失败率不代表业务流量丢包')
      await expect(dialog).not.toContainText('实时稳定')
    }
  })
}

for (const width of [320, 390, 768, 1440]) {
  for (const dark of [false, true]) {
    test(`approved carrier design stays contained at ${width}px in ${dark ? 'dark' : 'light'}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 })
      await installKomariFixture(page, { opsDashboard: true, dark, carrierCommonModeLoss: true, carrierRecentOutcome: 'failed', nodeCardSize: 'compact', returnRouteTag: 'fresh' })
      await page.goto('/')
      const card = page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).locator('xpath=..')
      const panel = card.locator('[data-node-insight-mode="carrier"]')
      await expect(panel.locator('[data-probe-current]').first()).toHaveText('持续失败')
      // Detect actual text rectangles, not just scrollWidth: overflow:hidden must not hide a regression.
      const checkLayout = async () => {
        expect(await panel.evaluate((element) => {
          const outer = element.getBoundingClientRect()
          return [...element.querySelectorAll<HTMLElement>('[data-carrier-table-head] > span, [data-node-carrier-row] > div, [data-carrier-details] p')].filter(cell => !cell.classList.contains('sr-only')).flatMap((cell) => {
            const range = document.createRange()
            range.selectNodeContents(cell)
            const box = cell.getBoundingClientRect()
            return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && (rect.left < box.left - 1 || rect.right > box.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1)).map(() => cell.textContent)
          })
        })).toEqual([])
      }
      await checkLayout()
      await expect(panel.locator('[data-carrier-sample]')).toHaveCount(36)
      await panel.getByRole('button', { name: '采样详情' }).click()
      await expect(panel.locator('[data-carrier-details]')).toContainText('近 1 小时探测失败率 3.3%')
      await expect(panel.locator('[data-carrier-details]')).toContainText('样本更新')
      await expect(page).toHaveURL(/\/$/)
      await checkLayout()
      await panel.getByRole('button', { name: '收起详情' }).click()
      await expect(panel.locator('[data-carrier-details]')).toHaveCount(0)
      const edges = page.locator('[data-topology-current-metric]')
      for (const edge of await edges.all()) {
        const bounds = await edge.locator('xpath=..').boundingBox()
        const current = await edge.locator('xpath=..').locator('[data-topology-current]').boundingBox()
        const history = await edge.boundingBox()
        const rail = await edge.locator('xpath=..').locator('[data-topology-edge-line]').boundingBox()
        expect(current!.y + current!.height).toBeLessThan(rail!.y)
        expect(history!.y).toBeGreaterThan(rail!.y + rail!.height)
        expect(history!.x).toBeGreaterThanOrEqual(bounds!.x)
        expect(history!.x + history!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      if (width === 1440) {
        await card.screenshot({ path: `test-results/design-review/carrier-${dark ? 'dark' : 'light'}.png` })
        await page.locator('[data-topology-route]').first().screenshot({ path: `test-results/design-review/topology-${dark ? 'dark' : 'light'}.png` })
        await page.getByRole('navigation', { name: '监控视图' }).getByRole('button', { name: '总览', exact: true }).click()
        await page.screenshot({ path: `test-results/design-review/overview-${dark ? 'dark' : 'light'}.png` })
      }
      if (width === 390)
        await card.screenshot({ path: `test-results/design-review/carrier-mobile-${dark ? 'dark' : 'light'}.png` })
    })
  }
}

async function openCenter(page: Page) {
  await page.getByRole('button', { name: '打开监测目标健康中心' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: /北京移动/ }).click()
  return dialog
}
async function setup(page: Page, delay = 0) {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, topologyAutoRepairEnabled: false, carrierRawSamples: true, preserveOperationJournal: true, quickTopologyMutationDelayMs: delay })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开监测目标健康中心' })).toBeVisible()
}

test('canary continues after dialog close and navigation; reload only reconciles', async ({ page }) => {
  await setup(page, 1200)
  let writes = 0
  page.on('request', (request) => {
    if (request.url().endsWith('/api/rpc2') && /admin:(?:add|delete|edit)PingTask/.test(request.postData() ?? ''))
      writes++
  })
  const dialog = await openCenter(page)
  await dialog.getByRole('button', { name: '验证备用目标' }).click()
  await expect(dialog.getByRole('button', { name: '验证备用目标' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(/\/instance\//)
  await page.getByRole('button', { name: '返回上一页' }).click()
  await openCenter(page)
  await expect(dialog).toContainText('候选目标已达到迁移门槛', { timeout: 15_000 })
  expect(writes).toBe(1)
  await page.keyboard.press('Escape')
  // A full refresh intentionally stops operations, unlike closing the dialog.
  await page.reload()
  await openCenter(page)
  await expect(dialog).toContainText('仅回查，未执行任何变更')
  expect(writes).toBe(1)
  await expect(dialog.getByRole('button', { name: '迁移到此目标' })).toHaveCount(0)
})

test('another same-origin tab holds the task lock; rejection unlocks busy UI', async ({ page, context }) => {
  await setup(page)
  const peer = await context.newPage()
  await setup(peer)
  await peer.evaluate(() => new Promise<void>((acquired) => {
    void navigator.locks.request('transit:carrier:13', () => {
      acquired()
      return new Promise(() => {})
    })
  }))
  const dialog = await openCenter(page)
  await dialog.getByRole('button', { name: '重建当前任务' }).click()
  await dialog.getByRole('button', { name: '再次点击确认重建' }).click()
  await expect(dialog).toContainText('其他标签页正在操作此任务')
  await expect(dialog.getByRole('button', { name: '重建当前任务' })).toBeEnabled()
  await peer.close()
})

test('without Web Locks viewing and candidate validation remain available but mutations are disabled', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }))
  await setup(page)
  const dialog = await openCenter(page)
  await expect(dialog).toContainText('Web Locks')
  await expect(dialog.getByRole('button', { name: '重建当前任务' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '验证备用目标' })).toBeEnabled()
  const violations = (await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()).violations
  expect(violations.filter(item => item.impact === 'serious' || item.impact === 'critical')).toEqual([])
})

test('storage degradation is distinct from installed/available plugin status', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, routeProbeCompanion: true, routeProbeStorageDegraded: true })
  await page.goto('/')
  await page.getByRole('button', { name: '配置回程检测' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('已安装')
  await expect(dialog).toContainText('存储降级：目录权限不足')
  await expect(dialog).toContainText('重启可能丢失未保存状态')
})
