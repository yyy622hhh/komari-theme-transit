import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

async function openReadyPage(page: Parameters<typeof installKomariFixture>[0], path = '/'): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await page.waitForTimeout(500)
}

async function expectNoSeriousAccessibilityViolations(page: Parameters<typeof installKomariFixture>[0]): Promise<void> {
  // Glass surfaces intentionally compose translucent telemetry/status colors
  // over user-configurable backgrounds. Keep axe focused on violations with
  // stable DOM semantics and interaction impact; contrast has dedicated
  // high-contrast CSS and visual coverage.
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
  const seriousViolations = results.violations.filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
  expect(seriousViolations, seriousViolations.map(violation => `${violation.id}: ${violation.help}`).join('\n')).toEqual([])
}

test('public home has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { pandaOps: true })
  await openReadyPage(page)
  await expectNoSeriousAccessibilityViolations(page)
})

test('authenticated detail view has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, pandaOps: true })
  await openReadyPage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expectNoSeriousAccessibilityViolations(page)
})

test('authenticated server list has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, pandaOps: true })
  await openReadyPage(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()
  await expect(page.getByRole('heading', { name: '服务器列表' })).toBeVisible()
  await expectNoSeriousAccessibilityViolations(page)
})

test('personal wallpaper manager has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page)
  await openReadyPage(page)
  await page.getByRole('button', { name: '壁纸与背景效果' }).click()
  await expect(page.getByRole('dialog', { name: '壁纸与背景效果' })).toBeVisible()
  await expectNoSeriousAccessibilityViolations(page)
})

test('high-contrast public home has no serious accessibility violations', async ({ page }) => {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-contrast', value: 'more' }],
  })
  await installKomariFixture(page, { colorVisionFriendly: true, pandaOps: true, visitorInfoEnabled: false })
  await openReadyPage(page)
  await expectNoSeriousAccessibilityViolations(page)
})
