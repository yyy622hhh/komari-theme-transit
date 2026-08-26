import { describe, expect, test } from 'bun:test'
import { buildRouteProbeInstallCommand } from '../../src/composables/useRouteProbeSetupWizard'

describe('route probe helper install command', () => {
  test('downloads the release-safe collector name to the helper contract filename', () => {
    const command = buildRouteProbeInstallCommand('https://status.example.com', 'v1.3.11')
    expect(command).toContain('/v1.3.11/transit-collect-return-route.sh -o collect-return-route.sh')
    expect(command).not.toContain('/v1.3.11/collect-return-route.sh')
  })

  test('quotes the endpoint and adds --allow-insecure-http for HTTP origins', () => {
    const command = buildRouteProbeInstallCommand('http://192.168.1.10:25774', 'v1.3.6')
    expect(command).toContain(`install --endpoint 'http://192.168.1.10:25774' --allow-insecure-http`)
  })

  test('quotes IPv6 origins so bash does not treat [::1] as a glob', () => {
    const command = buildRouteProbeInstallCommand('https://[::1]:25774', 'v1.3.6')
    expect(command).toContain(`install --endpoint 'https://[::1]:25774'`)
    expect(command).not.toContain('--allow-insecure-http')
  })
})
