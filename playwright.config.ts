import { release } from 'node:os'
import process from 'node:process'
import { defineConfig } from '@playwright/test'

/**
 * CI 用版本库里提交的基线；本地用按平台分开、且不进版本库的目录。
 *
 * 基线由 visual-baseline.yml 在固定的 macos-15 runner 上生成。在别的系统版本上
 * 跑同一份基线，字体栅格化差异会让一批用例恒定失败——那不是回归，但它会淹没
 * 真正的回归，最后的结果是本地干脆不跑截图，改 UI 只能推上去等 CI。
 *
 * 分开之后本地第一次运行会写入缺失的基线并把那一轮标记为失败，第二次起就是
 * 真实比对了。
 */
const snapshotRoot = process.env.CI
  ? 'snapshots'
  : `snapshots-local/${process.platform}-${release().split('.')[0]}`

export default defineConfig({
  testDir: './tests/visual',
  outputDir: 'test-results/artifacts',
  snapshotPathTemplate: `{testDir}/${snapshotRoot}/{projectName}/{arg}{ext}`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
      ]
    : [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
      ],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      // 基线由 .github/workflows/visual-baseline.yml 在 macos-15 runner 上生成，
      // 与比对环境完全一致，因此不需要为跨环境色彩/栅格化差异留余量。放宽到
      // 百分之几就足以放过整块卡片的数据或配色回归。
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      },
    },
  ],
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
