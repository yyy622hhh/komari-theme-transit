import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const workflow = readFileSync(new URL('../../.github/workflows/release-on-version-bump.yml', import.meta.url), 'utf8')

describe('release workflow legacy Komari import compatibility', () => {
  test('keeps the theme package ahead of companion assets and verifies the live API order', () => {
    const themeAssetIndex = workflow.indexOf('            komari-theme-Transit-build*.zip')
    const collectorAssetIndex = workflow.indexOf('            transit-collect-return-route.sh')

    expect(workflow).toContain('cp scripts/collect-return-route.sh transit-collect-return-route.sh')
    expect(workflow).toContain('preserve_order: true')
    expect(themeAssetIndex).toBeGreaterThan(-1)
    expect(collectorAssetIndex).toBeGreaterThan(themeAssetIndex)
    expect(workflow).not.toMatch(/^\s+scripts\/collect-return-route\.sh$/m)
    expect(workflow).toContain('--jq \'.assets[0].name // ""\'')
    expect(workflow).toContain('Legacy Komari remote import would download')
  })
})
