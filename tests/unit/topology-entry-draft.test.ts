import { describe, expect, test } from 'bun:test'
import { useTopologyEntryDraft } from '../../src/composables/useTopologyEntryDraft'
import { createTopologyRoute } from '../../src/utils/topologyModel'

const CUSTOM = '__custom_probe__'

function customNamedLikePreset() {
  return createTopologyRoute(
    [
      { name: '北京电信', region: 'CN', role: '入口', probeTarget: 'probe.example.com' },
      { name: 'Relay-JP', region: 'JP', role: '线路机', uuid: 'relay' },
      { name: '', region: '', role: '落地机' },
    ],
    [
      { live: true, nodeName: 'Relay-JP', taskFilter: 'Transit-entry-custom-abc', fallbackLatency: null, fallbackLoss: null },
      { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
    ],
  )
}

describe('custom topology entry draft', () => {
  test('treats a custom target as custom even when its label matches a built-in preset', () => {
    const draft = useTopologyEntryDraft(CUSTOM)
    const route = customNamedLikePreset()
    expect(draft.probeValue(route)).toBe(CUSTOM)

    draft.remember(route)
    route.nodes[0] = { name: '北京联通', region: 'CN', role: '入口' }
    route.metrics[0] = { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null }

    expect(draft.restore(route)).toBe(true)
    expect(route.nodes[0]).toMatchObject({ name: '北京电信', probeTarget: 'probe.example.com' })
    expect(route.metrics[0]?.taskFilter).toBe('Transit-entry-custom-abc')
  })
})
