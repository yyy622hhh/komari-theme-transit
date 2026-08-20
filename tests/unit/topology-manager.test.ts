import type { NodeData } from '../../src/stores/nodes'
import type { PublicSettings } from '../../src/utils/api'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useTopologyManager } from '../../src/composables/useTopologyManager'
import { setAuthSessionFromLogin } from '../../src/services/auth.service'
import { useAppStore } from '../../src/stores/app'

const saveTopologyConfiguration = mock(async () => ({
  topologyRoute: '入口|CN|入口;线路|JP|线路机',
  topologyMetrics: '10,0',
}))
const originalLocalStorage = globalThis.localStorage

mock.module('../../src/services/topology.service', () => ({
  saveTopologyConfiguration,
}))

function publicSettings(theme_settings: Record<string, unknown>): PublicSettings {
  return {
    allow_cors: false,
    custom_body: '',
    custom_head: '',
    description: '',
    disable_password_login: false,
    oauth_enable: false,
    oauth_provider: null,
    private_site: false,
    sitename: 'Transit',
    theme: 'Transit',
    theme_settings,
  }
}

function node(partial: Pick<NodeData, 'uuid' | 'name' | 'region' | 'online'>): NodeData {
  return {
    uuid: partial.uuid,
    name: partial.name,
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 1,
    os: '',
    kernel_version: '',
    region: partial.region,
    public_remark: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    weight: 0,
    price: 0,
    billing_cycle: 0,
    auto_renewal: false,
    currency: '',
    expired_at: null,
    group: '',
    groups: [],
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: '',
    online: partial.online,
    time: '',
    cpu: 0,
    gpu: 0,
    ram: 0,
    swap: 0,
    load: 0,
    load5: 0,
    load15: 0,
    temp: 0,
    disk: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    uptime: 0,
  }
}

beforeEach(() => {
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    },
  })
  setActivePinia(createPinia())
  saveTopologyConfiguration.mockClear()
  saveTopologyConfiguration.mockImplementation(async () => ({
    topologyRoute: '入口|CN|入口;线路|JP|线路机',
    topologyMetrics: '10,0',
  }))
  setAuthSessionFromLogin(true, { logged_in: true, username: 'admin' })
})

afterEach(() => {
  setAuthSessionFromLogin(false)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

describe('topology manager save snapshots', () => {
  test('captures missing topology fields distinctly from empty strings', async () => {
    const appStore = useAppStore()
    appStore.publicSettings = publicSettings({})
    const manager = useTopologyManager([
      node({ uuid: 'relay', name: '线路', region: 'JP', online: true }),
    ])

    manager.reset()
    manager.routes.value[0] = {
      id: 1,
      enabled: true,
      nodes: [
        { name: '入口', region: 'CN', role: '入口' },
        { name: '线路', region: 'JP', role: '线路机' },
        { name: '', region: '', role: '落地机' },
      ],
      metrics: [
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: 10, fallbackLoss: 0 },
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
      ],
    }

    await expect(manager.save()).resolves.toBe('saved')
    const options = saveTopologyConfiguration.mock.calls[0]?.[0]
    expect(options).toMatchObject({ theme: 'Transit' })
    expect(typeof options?.expected?.topologyRoute).toBe('symbol')
    expect(typeof options?.expected?.topologyMetrics).toBe('symbol')
  })

  test('updates expected snapshot from the verified persisted payload after save', async () => {
    const appStore = useAppStore()
    appStore.publicSettings = publicSettings({ topologyRoute: '', topologyMetrics: '' })
    const manager = useTopologyManager([])
    manager.reset()
    manager.routes.value[0] = {
      id: 1,
      enabled: true,
      nodes: [
        { name: '入口', region: 'CN', role: '入口' },
        { name: '线路', region: 'JP', role: '线路机' },
        { name: '', region: '', role: '落地机' },
      ],
      metrics: [
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: 10, fallbackLoss: 0 },
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
      ],
    }

    await expect(manager.save()).resolves.toBe('saved')
    manager.routes.value[0]!.metrics[0]!.fallbackLatency = 11
    saveTopologyConfiguration.mockClear()
    saveTopologyConfiguration.mockImplementation(async () => ({
      topologyRoute: '入口|CN|入口;线路|JP|线路机',
      topologyMetrics: '11,0',
    }))

    await nextTick()
    await expect(manager.save()).resolves.toBe('saved')
    expect(saveTopologyConfiguration.mock.calls[0]?.[0]).toMatchObject({
      expected: {
        topologyRoute: '入口|CN|入口;线路|JP|线路机',
        topologyMetrics: '10,0',
      },
    })
  })

  test('allows deleting every route and saving the cleared topology', async () => {
    const appStore = useAppStore()
    appStore.publicSettings = publicSettings({
      topologyRoute: '入口|CN|入口;线路|JP|线路机',
      topologyMetrics: '10,0',
    })
    const manager = useTopologyManager([
      node({ uuid: 'relay', name: '线路', region: 'JP', online: true }),
    ])
    manager.reset()
    manager.routes.value.splice(0)
    saveTopologyConfiguration.mockImplementation(async (options) => {
      const payload = { topologyEnabled: true, topologyRoute: '', topologyMetrics: '' }
      const current = useAppStore().publicSettings
      if (current)
        options.onPublicSettings?.({ ...current, theme_settings: { ...current.theme_settings, ...payload } })
      return payload
    })

    await expect(manager.save()).resolves.toBe('saved')
    expect(saveTopologyConfiguration.mock.calls[0]?.[0]).toMatchObject({
      theme: 'Transit',
      routes: [],
      expected: {
        topologyRoute: '入口|CN|入口;线路|JP|线路机',
        topologyMetrics: '10,0',
      },
    })
    expect(appStore.publicSettings.theme_settings).toMatchObject({
      topologyEnabled: true,
      topologyRoute: '',
      topologyMetrics: '',
    })
  })

  test('reads topology fields when the server stored theme_settings as a JSON string', async () => {
    const appStore = useAppStore()
    appStore.publicSettings = {
      ...publicSettings({}),
      theme_settings: JSON.stringify({
        topologyRoute: '入口|CN|入口;线路|JP|线路机',
        topologyMetrics: '10,0',
      }),
    }
    const manager = useTopologyManager([
      node({ uuid: 'relay', name: '线路', region: 'JP', online: true }),
    ])
    manager.reset()
    saveTopologyConfiguration.mockImplementation(async () => ({
      topologyRoute: '入口|CN|入口;线路|JP|线路机',
      topologyMetrics: '10,0',
    }))

    await expect(manager.save()).resolves.toBe('saved')
    expect(saveTopologyConfiguration.mock.calls[0]?.[0]).toMatchObject({
      expected: {
        topologyRoute: '入口|CN|入口;线路|JP|线路机',
        topologyMetrics: '10,0',
      },
    })
  })
})
