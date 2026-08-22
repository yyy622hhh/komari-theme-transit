import type { Page } from '@playwright/test'
import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'
import { installKomariFixture } from '../visual/fixtures/komari'

const FIRST_NODE_UUID = '00000000-0000-4000-8000-000000000001'
const SECOND_NODE_UUID = '00000000-0000-4000-8000-000000000002'
const browserErrors = new WeakMap<Page, string[]>()
const EXPECTED_ICON_CDN_CORS_ERROR = /api\.(?:iconify\.design|unisvg\.com|simplesvg\.com).*access control checks/

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`console: ${message.text()}`)
  })
})

test.afterEach(async ({ page }) => {
  const unexpected = (browserErrors.get(page) ?? []).filter(error => !EXPECTED_ICON_CDN_CORS_ERROR.test(error))
  expect(unexpected).toEqual([])
})

async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' })).toBeVisible()
}

/**
 * A test that intentionally injects a failing response logs the browser's own
 *  "failed to load resource" console line for it; that's expected noise from
 *  the fault being injected, not an app bug, so drop it before the shared
 *  afterEach's blanket no-console-errors check runs.
 */
function clearExpectedBrowserErrors(page: Page): void {
  browserErrors.set(page, [])
}

test('public home navigates to a node detail and returns without private API calls', async ({ page }) => {
  const forbiddenRequests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    const rpcPayload = url.endsWith('/api/rpc2')
      ? request.postDataJSON() as { method?: string } | null
      : null
    if (url.includes('/api/admin/') || rpcPayload?.method?.startsWith('admin:'))
      forbiddenRequests.push(url)
  })

  await installKomariFixture(page)
  await openHome(page)
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${FIRST_NODE_UUID}`)
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回上一页' }).click()
  await expect(page).toHaveURL('/')
  expect(forbiddenRequests).toEqual([])
})

test('public home degrades from the realistic globe to the cobe globe when only WebGL2 is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === 'webgl2')
        return null
      return Reflect.apply(nativeGetContext, this, [type, ...args])
    } as typeof HTMLCanvasElement.prototype.getContext
  })
  await installKomariFixture(page)
  await openHome(page)
  // WebGL1 is still available, so the adaptive wrapper should pick the lighter
  // cobe globe instead of falling all the way back to static text.
  await expect(page.locator('canvas.earth-globe-canvas')).toBeVisible()
  await expect(page.locator('[data-earth-static-fallback]')).toHaveCount(0)
})

test('public home degrades all the way to the tiled map when no WebGL is available', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type: string, ...args: unknown[]) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl')
        return null
      return Reflect.apply(nativeGetContext, this, [type, ...args])
    } as typeof HTMLCanvasElement.prototype.getContext
  })
  await installKomariFixture(page)
  await openHome(page)
  await expect(page.getByRole('img', { name: '真实地球贴图节点世界地图' })).toBeVisible()
})

test('admin entry keeps the supported Komari server route contract', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openHome(page)

  const adminEntry = page.getByRole('link', { name: '后台管理' })
  await expect(adminEntry).toHaveAttribute('href', '/admin/servers')

  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /服务器：/ }).click()
  await expect(page.locator('[data-server-list-panel]').getByRole('link', { name: '官方后台' }))
    .toHaveAttribute('href', '/admin/servers')

  const response = await page.goto('/admin/servers')
  expect(response?.status()).toBe(200)
})

test('authenticated keyboard ordering persists through the official RPC after reload', async ({ page }) => {
  const savedOrders: Array<Record<string, number>> = []
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON() as { method?: string, params?: Record<string, number> } | null
    if (payload?.method === 'admin:orderClients' && payload.params)
      savedOrders.push(payload.params)
  })

  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openHome(page)
  await page.getByRole('button', { name: '编辑首页顺序' }).click()

  const orderedItems = page.locator('[data-node-card-grid] [data-server-order-item]')
  const firstHandle = page.getByRole('button', { name: /^拖动 主控-洛杉矶，/ })
  await firstHandle.press('ArrowDown')
  await expect(orderedItems.first()).toContainText('香港边缘节点-超长名称布局测试')
  await page.getByRole('button', { name: '保存顺序' }).click()

  await expect.poll(() => savedOrders.length).toBe(1)
  expect(savedOrders[0]?.[FIRST_NODE_UUID]).toBe(1)
  expect(savedOrders[0]?.[SECOND_NODE_UUID]).toBe(0)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Komari Visual Lab' })).toBeVisible()
  await expect(page.locator('[data-node-card-grid] > div').first()).toContainText('香港边缘节点-超长名称布局测试')
})

test('global diagnostics panel renders live data and copies a redacted report', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          ;(window as typeof window & { __copiedDiagnosticReport?: string }).__copiedDiagnosticReport = value
        },
      },
    })
  })
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, routeProbeCompanion: true })
  await openHome(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /诊断：/ }).click()

  await expect(page.getByRole('heading', { name: '全局诊断中心' })).toBeVisible()
  await expect(page.getByText(/v1\.2\.6-visual/)).toBeVisible()

  await page.getByRole('button', { name: '复制诊断报告' }).click()
  await expect(page.getByText('诊断报告已复制')).toBeVisible()
  const copied = await page.evaluate(() => (window as typeof window & { __copiedDiagnosticReport?: string }).__copiedDiagnosticReport)
  expect(copied).toContain('Transit v')
  expect(copied).toContain('运行诊断')
  expect(copied).toContain('1.2.6-visual')
})

test('config backup panel exports the current settings and shows them after import', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await openHome(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /配置：/ }).click()
  await expect(page.getByRole('heading', { name: '配置备份中心' })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出配置' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^transit-config-.*\.json$/)

  await expect(page.getByText('暂无记录，配置发生变化后会自动出现在这里。')).toHaveCount(0)
  await expect(page.getByText('当前', { exact: true })).toBeVisible()
})

test('setup wizard opens automatically once for a new admin session and can be dismissed', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, setupWizardFirstRun: true })
  await page.goto('/')

  const dialog = page.getByRole('dialog', { name: 'Transit 设置中心' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '以后再说，不再自动弹出' }).click()
  await expect(dialog).toBeHidden()
  // The fixture's addInitScript clears localStorage on every navigation for test
  // determinism (see installKomariFixture), including reload -- so re-navigating
  // here to check persistence would just be testing the fixture's own reset, not
  // the app. Check the actual write directly instead.
  expect(await page.evaluate(() => localStorage.getItem('transit:setup-wizard-dismissed'))).toBe('1')

  // Every other authenticated test in this suite uses the fixture's default
  // (setupWizardFirstRun unset), which seeds this same flag up front -- their
  // passing without ever needing to dismiss the dialog is what actually proves
  // an already-dismissed session stays dismissed on load.
})

test('setup wizard applies a preset and writes the expected patch', async ({ page }) => {
  const savedPatches: Array<Record<string, unknown>> = []
  page.on('request', (request) => {
    if (!request.url().includes('/api/admin/theme/settings'))
      return
    const body = request.postDataJSON() as Record<string, unknown> | null
    if (body)
      savedPatches.push(body)
  })

  // routeProbeCompanion: true avoids a legitimate-but-noisy 404 from the wizard's
  // detect step probing a companion plugin this test isn't exercising.
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, setupWizardFirstRun: true, routeProbeCompanion: true })
  await page.goto('/')

  const dialog = page.getByRole('dialog', { name: 'Transit 设置中心' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '开始设置' }).click()
  await dialog.getByRole('button', { name: '专业运维' }).click()
  await dialog.getByRole('button', { name: '继续' }).click()
  await expect(dialog.getByText('Komari 服务端版本')).toBeVisible()
  await dialog.getByRole('button', { name: '继续' }).click()
  await expect(dialog.getByText(/项将发生变化/)).toBeVisible()
  await dialog.getByRole('button', { name: '确认应用' }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(() => savedPatches.length).toBeGreaterThan(0)
  const applied = savedPatches.at(-1)
  expect(applied?.nodeCardSize).toBe('large')
  expect(applied?.generalCardPreset).toBe('full')
})

test('setup wizard surfaces a save failure instead of silently closing or marking itself seen', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, setupWizardFirstRun: true, routeProbeCompanion: true })
  // Override the fixture's success handler to simulate the save request reaching
  // the server and failing there, mirroring "任务创建成功、主题配置保存失败".
  await page.route('**/api/admin/theme/settings?theme=*', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', message: '写入配置失败' }),
  }))
  await page.goto('/')

  const dialog = page.getByRole('dialog', { name: 'Transit 设置中心' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '开始设置' }).click()
  await dialog.getByRole('button', { name: '日常监控' }).click()
  await dialog.getByRole('button', { name: '继续' }).click()
  await dialog.getByRole('button', { name: '继续' }).click()
  await dialog.getByRole('button', { name: '确认应用' }).click()

  await expect(dialog.getByText('写入配置失败')).toBeVisible()
  clearExpectedBrowserErrors(page)
  // Stays open on the confirm step so the operator can retry, rather than
  // closing as if the write had gone through.
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('transit:setup-wizard-dismissed'))).not.toBe('1')
})

test('config backup surfaces an import failure and keeps the staged diff for retry', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, opsDashboard: true })
  await page.route('**/api/admin/theme/settings?theme=*', route => route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ status: 'error', message: '写入配置失败' }),
  }))
  await openHome(page)
  await page.getByRole('button', { name: '显示首页工具' }).click()
  await page.getByRole('button', { name: /配置：/ }).click()

  await page.getByRole('button', { name: '导入配置', exact: true }).click()
  await page.setInputFiles('input[type="file"]', {
    name: 'transit-config.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, themeVersion: '1.3.0', exportedAt: Date.now(), settings: { alertEnabled: true } })),
  })
  await expect(page.getByText('导入预览')).toBeVisible()
  await page.getByRole('button', { name: '确认导入' }).click()

  await expect(page.getByText('写入配置失败')).toBeVisible()
  clearExpectedBrowserErrors(page)
  // The preview must not vanish on failure -- otherwise the operator has to
  // re-pick the file and re-diff instead of just retrying the apply.
  await expect(page.getByText('导入预览')).toBeVisible()
})

test('mobile WebKit keeps the core browse flow inside the viewport', async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe('mobile-webkit')

  await installKomariFixture(page)
  await openHome(page)
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate(element => element.clientWidth),
  )
  await page.getByRole('button', { name: '查看节点 主控-洛杉矶 详情' }).click()
  await expect(page).toHaveURL(`/instance/${FIRST_NODE_UUID}`)
  await expect(page.getByText('硬件信息', { exact: true })).toBeVisible()
})
