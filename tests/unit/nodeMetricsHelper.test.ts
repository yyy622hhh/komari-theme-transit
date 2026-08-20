import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import {
  computeOnlineNodeStats,
  formatDistributionTooltip,
  formatExpiryNodeLine,
  formatMetricDecimal,
  formatNodeCount,
  formatNodeNameList,
  getCapacityPeakPercentage,
  getConnectionCount,
  getDiskPercentage,
  getKnownNodeDistribution,
  getMemoryPercentage,
  getNodeDistribution,
  normalizeConnectionCounts,
} from '../../src/utils/nodeMetricsHelper'

function node(overrides: Partial<NodeData> & Pick<NodeData, 'uuid' | 'name'>): NodeData {
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
    ...overrides,
  }
}

describe('Komari latest connection normalization', () => {
  test('separates TCP from a latest-status TCP + UDP total', () => {
    const connections = normalizeConnectionCounts(120, 20)
    expect(connections).toEqual({ tcp: 100, udp: 20 })
    expect(getConnectionCount({ connections: connections.tcp, connections_udp: connections.udp })).toBe(120)
  })

  test('clamps inconsistent backend values instead of exposing negative TCP counts', () => {
    expect(normalizeConnectionCounts(5, 20)).toEqual({ tcp: 0, udp: 5 })
    expect(getConnectionCount({ connections: 0, connections_udp: 5 })).toBe(5)
  })

  test('does not let a larger UDP count inflate the reported total', () => {
    const connections = normalizeConnectionCounts(5, 20)
    expect(connections.tcp + connections.udp).toBe(5)
  })
})

describe('computeOnlineNodeStats', () => {
  test('returns all-zero stats for an empty node list', () => {
    const stats = computeOnlineNodeStats([], 80)
    expect(stats.count).toBe(0)
    expect(stats.avgCpu).toBe(0)
    expect(stats.trafficPeak).toBeNull()
    expect(stats.highLoadNodes).toEqual([])
  })

  test('excludes offline nodes from every sum, average and peak', () => {
    const online = node({ uuid: 'a', name: 'A', online: true, cpu: 40, net_out: 100 })
    const offline = node({ uuid: 'b', name: 'B', online: false, cpu: 100, net_out: 10_000 })
    const stats = computeOnlineNodeStats([online, offline], 80)
    expect(stats.count).toBe(1)
    expect(stats.avgCpu).toBe(40)
    expect(stats.totalSpeed.up).toBe(100)
    expect(stats.uploadPeakNode?.node.uuid).toBe('a')
  })

  test('averages cpu and load only across online nodes', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', cpu: 20, load: 1, load5: 2, load15: 3 }),
      node({ uuid: 'b', name: 'B', cpu: 60, load: 3, load5: 4, load15: 5 }),
    ]
    const stats = computeOnlineNodeStats(nodes, 80)
    expect(stats.avgCpu).toBe(40)
    expect(stats.avgLoad).toBe(2)
    expect(stats.avgLoad5).toBe(3)
    expect(stats.avgLoad15).toBe(4)
  })

  test('only counts nodes with a GPU toward gpuNodeCount and totalGpu', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', gpu: 50, gpu_name: 'RTX 4090' }),
      node({ uuid: 'b', name: 'B', gpu: 0 }),
    ]
    const stats = computeOnlineNodeStats(nodes, 80)
    expect(stats.gpuNodeCount).toBe(1)
    expect(stats.totalGpu).toBe(50)
    expect(stats.gpuPeakNode?.node.uuid).toBe('a')
  })

  test('tracks the highest-value node per peak metric independently', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', net_out: 500, net_in: 10, connections: 5, connections_udp: 0 }),
      node({ uuid: 'b', name: 'B', net_out: 100, net_in: 900, connections: 50, connections_udp: 0 }),
    ]
    const stats = computeOnlineNodeStats(nodes, 80)
    expect(stats.uploadPeakNode?.node.uuid).toBe('a')
    expect(stats.downloadPeakNode?.node.uuid).toBe('b')
    expect(stats.connectionPeakNode?.node.uuid).toBe('b')
  })

  test('collects nodes exceeding the high-load threshold, and only those', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', cpu: 95 }),
      node({ uuid: 'b', name: 'B', cpu: 10 }),
    ]
    const stats = computeOnlineNodeStats(nodes, 80)
    expect(stats.highLoadNodes.map(n => n.uuid)).toEqual(['a'])
  })
})

describe('capacity percentages', () => {
  test('treats an unavailable capacity total as unknown instead of a full disk or memory alert', () => {
    const incomplete = node({ uuid: 'a', name: 'A', disk: 20, disk_total: 0, ram: 20, mem_total: 0 })

    expect(getDiskPercentage(incomplete)).toBe(0)
    expect(getMemoryPercentage(incomplete)).toBe(0)
    expect(computeOnlineNodeStats([incomplete], 80).highLoadNodes).toEqual([])
  })

  test('does not invent a 100% peak when history rows omit capacity totals', () => {
    expect(getCapacityPeakPercentage([
      { used: 8_000_000_000, total: 0 },
      { used: 4_000_000_000, total: null },
    ], 0)).toBe(0)
    expect(getCapacityPeakPercentage([
      { used: 8, total: 0 },
      { used: 4, total: 16 },
    ], 16)).toBe(50)
  })
})

describe('node summary formatting helpers', () => {
  test('formats counts with locale grouping', () => {
    expect(formatNodeCount(12345)).toBe('12,345')
    expect(formatNodeCount(3.6)).toBe('4')
  })

  test('formats decimals and falls back to 0 for non-finite input', () => {
    expect(formatMetricDecimal(3.14159, 2)).toBe('3.14')
    expect(formatMetricDecimal(Number.NaN)).toBe('0')
  })

  test('lists node names and collapses beyond the max count', () => {
    expect(formatNodeNameList([])).toBe('暂无节点')
    const nodes = Array.from({ length: 3 }, (_, index) => node({ uuid: `n${index}`, name: `Node-${index}` }))
    expect(formatNodeNameList(nodes, undefined, 2)).toBe('Node-0\nNode-1\n… 还有 1 台')
  })

  test('formats the expiry line for a node with unknown, expired and future dates', () => {
    expect(formatExpiryNodeLine(node({ uuid: 'a', name: 'A', expired_at: null }))).toBe('A: 未知')
    expect(formatExpiryNodeLine(node({ uuid: 'a', name: 'A', expired_at: '2000-01-01T00:00:00.000Z' }))).toBe('A: 已过期')
  })

  test('getNodeDistribution groups by selector and falls back to 未知', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', os: 'Linux' }),
      node({ uuid: 'b', name: 'B', os: 'Linux' }),
      node({ uuid: 'c', name: 'C', os: '' }),
    ]
    expect(getNodeDistribution(nodes, n => n.os)).toEqual([['Linux', 2], ['未知', 1]])
  })

  test('getKnownNodeDistribution drops empty selector values instead of grouping them', () => {
    const nodes = [
      node({ uuid: 'a', name: 'A', os: 'Linux' }),
      node({ uuid: 'b', name: 'B', os: '' }),
    ]
    expect(getKnownNodeDistribution(nodes, n => n.os)).toEqual([['Linux', 1]])
  })

  test('formats a distribution tooltip, capped at 8 entries', () => {
    expect(formatDistributionTooltip([])).toBe('暂无数据')
    expect(formatDistributionTooltip([['Linux', 3], ['Windows', 1]])).toBe('Linux: 3 台\nWindows: 1 台')
  })
})
