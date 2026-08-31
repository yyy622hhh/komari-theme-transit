import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

test('busy helpers stay out of installation guidance and expired leases refresh without manual checks', async ({ page }) => {
  const now = Date.parse('2026-07-25T12:00:00.000Z')
  await page.clock.install({ time: now })
  await installKomariFixture(page, { authenticated: true, routeProbeCompanion: true, carrierRawSamples: true })
  let rosterReads = 0
  await page.route('**/api/transit-route-probe/v1/roster?*', async (route) => {
    rosterReads++
    const clients = (new URL(route.request().url()).searchParams.get('clients') ?? '').split(',')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ clients: clients.map(client => ({
      client,
      helper_seen_at: now - 41_000,
      active_job_until: now + 20_000,
      helper_version: '1.3.12',
    })) }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '配置回程检测', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('执行中', { exact: true }).first()).toBeVisible()
  await expect(dialog).not.toContainText('境外节点助手未连接')
  const initialReads = rosterReads
  // The same existing 15-second refresh must run even when nobody is missing.
  await page.clock.fastForward(31_000)
  await expect(dialog).toContainText('境外节点助手未连接，请检查安装或服务状态')
  await expect(dialog.getByText('执行中', { exact: true })).toHaveCount(0)
  expect(rosterReads).toBeGreaterThan(initialReads)
  await expect(dialog).not.toContainText('境外节点未安装助手')
})
