import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import { DEFAULT_EXCHANGE_RATES } from '../../src/utils/financeHelper'
import { applyHomeQuickControl, countHomeQuickControl, resolveActiveHomeQuickControl } from '../../src/utils/homeQuickControls'

function node(partial: Partial<NodeData> & Pick<NodeData, 'uuid' | 'name'>): NodeData {
  return {
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 1,
    os: '',
    kernel_version: '',
    region: '',
    public_remark: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    weight: 0,
    price: 0,
    billing_cycle: 30,
    auto_renewal: false,
    currency: 'CNY',
    expired_at: null,
    group: '',
    groups: [],
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: '',
    online: true,
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
    ...partial,
  }
}

const context = {
  isFavorite: (uuid: string) => uuid === 'fav',
  isMaintenance: (item: NodeData) => item.uuid === 'maint',
  highLoadThreshold: 80,
  expiringDays: 30,
  offlineNodesLast: true,
  exchangeRates: DEFAULT_EXCHANGE_RATES,
}

describe('home quick controls', () => {
  test('sorts visible monthly cost from highest to lowest', () => {
    const nodes = [
      node({ uuid: 'cheap', name: 'cheap', price: 30, billing_cycle: 30 }),
      node({ uuid: 'pricey', name: 'pricey', price: 300, billing_cycle: 30 }),
      node({ uuid: 'mid', name: 'mid', price: 90, billing_cycle: 30 }),
    ]

    expect(applyHomeQuickControl(nodes, 'monthlyCost', context).map(item => item.uuid)).toEqual([
      'pricey',
      'mid',
      'cheap',
    ])
    expect(countHomeQuickControl(nodes, 'monthlyCost', context)).toBe(3)
  })

  test('clears monthly cost when the control is no longer visible', () => {
    expect(resolveActiveHomeQuickControl('monthlyCost', true, ['favorite', 'peak'])).toBeNull()
    expect(resolveActiveHomeQuickControl('monthlyCost', false, ['favorite', 'monthlyCost', 'peak'])).toBeNull()
    expect(resolveActiveHomeQuickControl('monthlyCost', true, ['favorite', 'monthlyCost', 'peak'])).toBe('monthlyCost')
  })

  test('keeps favorite filtering independent of monthly cost', () => {
    const nodes = [
      node({ uuid: 'fav', name: 'fav' }),
      node({ uuid: 'other', name: 'other' }),
    ]

    expect(applyHomeQuickControl(nodes, 'favorite', context).map(item => item.uuid)).toEqual(['fav'])
    expect(countHomeQuickControl(nodes, 'favorite', context)).toBe(1)
  })
})
