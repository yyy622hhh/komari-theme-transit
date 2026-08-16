import { expect, test } from '@playwright/test'
import { installKomariFixture } from '../visual/fixtures/komari'

test('component errors are isolated, redacted and recoverable', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error')
      consoleErrors.push(message.text())
  })

  await installKomariFixture(page)
  await page.goto('/?component-boundary-test=1')
  await expect(page.getByText('测试组件暂时无法显示')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
  expect(consoleErrors.join('\n')).not.toContain('boundary-secret-canary')

  await page.getByRole('button', { name: '重试' }).click()
  await expect(page.getByTestId('boundary-recovered')).toHaveText('组件已恢复')
})
