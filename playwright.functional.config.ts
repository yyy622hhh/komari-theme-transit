import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/functional',
  outputDir: 'test-results/functional',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { outputFolder: 'playwright-functional-report', open: 'never' }],
      ]
    : [
        ['list'],
        ['html', { outputFolder: 'playwright-functional-report', open: 'never' }],
      ],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      grepInvert: /mobile WebKit/,
      use: { browserName: 'chromium' },
    },
    {
      name: 'firefox',
      grepInvert: /mobile WebKit/,
      use: { browserName: 'firefox' },
    },
    {
      name: 'webkit',
      grepInvert: /mobile WebKit/,
      use: { browserName: 'webkit' },
    },
    {
      name: 'mobile-webkit',
      grep: /mobile WebKit/,
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
      },
    },
  ],
  webServer: {
    command: 'VITE_COMPONENT_BOUNDARY_TEST=true node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
