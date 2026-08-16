import type { Page } from '@playwright/test'
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

test('admin entry keeps the supported Komari server route contract', async ({ page }) => {
  await installKomariFixture(page, { authenticated: true, pandaOps: true })
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

  await installKomariFixture(page, { authenticated: true, pandaOps: true })
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
