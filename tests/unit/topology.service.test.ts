import { beforeEach, describe, expect, mock, test } from 'bun:test'

const saveManagedThemeSettings = mock(async (options: { patch: Record<string, unknown> }) => options.patch)

mock.module('../../src/services/theme-settings.service', () => ({
  saveManagedThemeSettings,
}))

const { saveTopologyConfiguration } = await import('../../src/services/topology.service')

beforeEach(() => {
  saveManagedThemeSettings.mockClear()
})

describe('topology service', () => {
  test('persists clearing all routes as empty topology settings without hiding the manager entry', async () => {
    await expect(saveTopologyConfiguration({
      theme: 'Transit',
      routes: [],
      expected: { topologyRoute: '入口|CN|入口;线路|JP|线路机', topologyMetrics: '10,0' },
    })).resolves.toEqual({
      topologyEnabled: true,
      topologyRoute: '',
      topologyMetrics: '',
    })

    expect(saveManagedThemeSettings.mock.calls).toHaveLength(1)
    expect(saveManagedThemeSettings.mock.calls[0]?.[0]).toMatchObject({
      theme: 'Transit',
      patch: {
        topologyEnabled: true,
        topologyRoute: '',
        topologyMetrics: '',
      },
      expected: {
        topologyRoute: '入口|CN|入口;线路|JP|线路机',
        topologyMetrics: '10,0',
      },
      permission: 'nodeTopology',
    })
  })
})
