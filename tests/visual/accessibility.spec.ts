import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

async function openReadyPage(page: Parameters<typeof installKomariFixture>[0], path = '/'): Promise<void> {
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible({ timeout: 10_000 })
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

async function getAccessibilityViolations(page: Parameters<typeof installKomariFixture>[0]) {
  return (await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()).violations
}

test('public home has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { opsDashboard: true })
  await openReadyPage(page)
  await expectNoSeriousAccessibilityViolations(page)
  expect(await getAccessibilityViolations(page)).toEqual([])
})

test('authenticated detail view has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openReadyPage(page, '/instance/00000000-0000-4000-8000-000000000001')
  await expectNoSeriousAccessibilityViolations(page)
  expect(await getAccessibilityViolations(page)).toEqual([])
})

test('authenticated server list has no serious accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
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
  await installKomariFixture(page, { colorVisionFriendly: true, opsDashboard: true, visitorInfoEnabled: false })
  await openReadyPage(page)
  await expectNoSeriousAccessibilityViolations(page)
})

test('authenticated mobile tools and dialogs have no accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openReadyPage(page)

  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()
  await expect(page.getByRole('heading', { name: '服务器列表' })).toBeVisible()
  expect(await getAccessibilityViolations(page)).toEqual([])

  await page.getByRole('button', { name: /网络：/ }).click()
  await page.getByRole('button', { name: '管理', exact: true }).click()
  const topologyDialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(topologyDialog).toBeVisible()
  expect(await getAccessibilityViolations(page)).toEqual([])
  await topologyDialog.getByRole('button', { name: '快速生成' }).click()
  await expect(topologyDialog.locator('[data-topology-route-id]')).toHaveCount(3)
  expect(await getAccessibilityViolations(page)).toEqual([])
})

test('keyboard sorting surfaces have no accessibility violations', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openReadyPage(page)
  await page.getByRole('button', { name: '编辑首页顺序' }).click()
  expect(await getAccessibilityViolations(page)).toEqual([])
  await page.getByRole('button', { name: '列表视图' }).click()
  expect(await getAccessibilityViolations(page)).toEqual([])
})

test('all interactive controls expose an accessible name', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openReadyPage(page)

  async function expectNamedControls(scope = page.locator('body')): Promise<void> {
    const unnamedControls = await scope.locator('button, a[href], input:not([type="hidden"]), select, textarea').evaluateAll((elements) => {
      return elements.flatMap((element) => {
        const name = (element.getAttribute('aria-label')
          || (element.getAttribute('aria-labelledby') && element.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
          || element.getAttribute('title')
          || (element as HTMLInputElement).labels?.[0]?.textContent
          || element.textContent
          || (element as HTMLInputElement).placeholder
          || '').trim()
        return name ? [] : [element.outerHTML.slice(0, 240)]
      })
    })
    expect(unnamedControls).toEqual([])
  }

  await expectNamedControls()
  await page.getByRole('button', { name: '显示首页工具' }).click()
  for (const tool of [/对比：/, /服务器：/, /网络：/, /性价比：/, /健康：/, /导出：/, /日志：/]) {
    await page.getByRole('button', { name: tool }).click()
    await expectNamedControls()
  }
  await page.getByRole('button', { name: /网络：/ }).click()
  await page.getByRole('button', { name: '管理', exact: true }).click()
  await expectNamedControls(page.getByRole('dialog', { name: '拓扑管理' }))
})

test('forced colors keeps focus and selected controls visually distinguishable', async ({ page }) => {
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'forced-colors', value: 'active' }],
  })
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openReadyPage(page)

  const toolsButton = page.getByRole('button', { name: '显示首页工具' })
  await toolsButton.focus()
  await expect(toolsButton).toHaveCSS('outline-style', 'solid')
  await toolsButton.click()
  await expect(page.getByRole('button', { name: '收起首页工具' })).toHaveAttribute('aria-pressed', 'true')

  const cardView = page.getByRole('button', { name: '卡片视图' })
  await expect(cardView).toHaveAttribute('aria-pressed', 'true')
  await expect(cardView).toHaveCSS('outline-style', 'solid')
})
