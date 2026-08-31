import { expect, test } from '@playwright/test'
import { installKomariFixture } from './fixtures/komari'

test('saving topology cannot delete a task repurposed by another administrator', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await installKomariFixture(page, { authenticated: true, opsDashboard: true, emptyTopology: true, quickTopologyNoTasks: true, topologyAutoRepairEnabled: false })
  const deleted: number[] = []
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/rpc2'))
      return
    const payload = request.postDataJSON()
    if (payload.method === 'admin:deletePingTask')
      deleted.push(...payload.params.id)
  })
  await page.goto('/')
  await page.getByRole('button', { name: '配置第一条线路' }).click()
  const dialog = page.getByRole('dialog', { name: '拓扑管理' })
  await expect(dialog.locator('[data-topology-ready="true"]')).toBeVisible()
  await dialog.getByLabel('添加线路落地机').selectOption({ label: '香港边缘节点-超长名称布局测试' })
  await dialog.getByRole('button', { name: '添加线路', exact: true }).click()
  await expect(dialog.locator('[data-topology-write-log]')).toContainText('创建入口探测任务')
  // Simulate an external administrator's real RPC edit, without touching frontend state.
  const changedId = await page.evaluate(async () => {
    const rpc = async (method: string, params = {}) => (await (await fetch('/api/rpc2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 999, method, params }),
    })).json()).result
    const tasks = await rpc('admin:getAllPingTasks')
    const task = tasks.find((item: { name: string }) => item.name === '北京电信')
    await rpc('admin:editPingTask', { tasks: [{ id: task.id, name: '接管后的业务监测', target: '192.0.2.88', interval: 60 }] })
    return task.id as number
  })
  await dialog.getByRole('button', { name: '删除线路', exact: true }).click()
  await expect(dialog.locator('[data-topology-write-log]')).toContainText('缺少一致快照')
  expect(deleted).not.toContain(changedId)
  const remaining = await page.evaluate(async () => (await (await fetch('/api/rpc2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1000, method: 'admin:getAllPingTasks', params: {} }),
  })).json()).result)
  expect(remaining).toEqual(expect.arrayContaining([expect.objectContaining({ id: changedId, name: '接管后的业务监测', target: '192.0.2.88' })]))
})
