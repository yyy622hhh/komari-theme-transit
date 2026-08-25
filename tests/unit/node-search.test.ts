import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import { isNodeMatchSearch } from '../../src/utils/nodeSearch'

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    uuid: 'node-uuid-1',
    name: 'Relay-JP',
    cpu_name: 'Intel Xeon',
    virtualization: 'kvm',
    arch: 'amd64',
    cpu_cores: 4,
    os: 'Debian 12',
    kernel_version: '6.1.0',
    gpu_name: '',
    ipv4: '203.0.113.5',
    ipv6: '',
    region: '🇯🇵',
    remark: '',
    public_remark: '主力线路机',
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

describe('isNodeMatchSearch', () => {
  test('an empty or whitespace-only search matches every node', () => {
    expect(isNodeMatchSearch(node(), '')).toBe(true)
    expect(isNodeMatchSearch(node(), '   ')).toBe(true)
  })

  test('matches on the node name, case-insensitively', () => {
    expect(isNodeMatchSearch(node({ name: 'Relay-JP' }), 'relay')).toBe(true)
    expect(isNodeMatchSearch(node({ name: 'Relay-JP' }), 'RELAY-JP')).toBe(true)
  })

  test('matches on uuid, cpu name, os, kernel version, virtualization, arch, tags and remarks', () => {
    const n = node({
      uuid: 'abc-123',
      cpu_name: 'AMD EPYC',
      os: 'Ubuntu 24.04',
      kernel_version: '6.8.0-generic',
      virtualization: 'lxc',
      arch: 'arm64',
      tags: '香港<blue>;中转',
      public_remark: '备用节点',
      remark: '内部备注:勿动',
    })
    expect(isNodeMatchSearch(n, 'abc-123')).toBe(true)
    expect(isNodeMatchSearch(n, 'epyc')).toBe(true)
    expect(isNodeMatchSearch(n, 'ubuntu')).toBe(true)
    expect(isNodeMatchSearch(n, '6.8.0-generic')).toBe(true)
    expect(isNodeMatchSearch(n, 'lxc')).toBe(true)
    expect(isNodeMatchSearch(n, 'arm64')).toBe(true)
    expect(isNodeMatchSearch(n, '中转')).toBe(true)
    expect(isNodeMatchSearch(n, '备用节点')).toBe(true)
    expect(isNodeMatchSearch(n, '勿动')).toBe(true)
  })

  test('matches a group even when it is not the primary group field', () => {
    const n = node({ group: '香港', groups: ['香港', '中转专线'] })
    expect(isNodeMatchSearch(n, '中转专线')).toBe(true)
  })

  test('a multi-term search requires every term to match, possibly across different fields', () => {
    const n = node({ name: 'Relay-JP', cpu_name: 'AMD EPYC' })
    expect(isNodeMatchSearch(n, 'relay epyc')).toBe(true)
    expect(isNodeMatchSearch(n, 'relay intel')).toBe(false)
  })

  test('matches an IPv4 address by substring', () => {
    expect(isNodeMatchSearch(node({ ipv4: '203.0.113.5' }), '203.0.113')).toBe(true)
  })

  test('matches an IPv4 address against an x/*-wildcard pattern', () => {
    const n = node({ ipv4: '203.0.113.5' })
    expect(isNodeMatchSearch(n, '203.0.113.x')).toBe(true)
    expect(isNodeMatchSearch(n, '203.0.*.5')).toBe(true)
    expect(isNodeMatchSearch(n, '203.0.113.9')).toBe(false)
  })

  test('matches an IPv6 address by substring', () => {
    expect(isNodeMatchSearch(node({ ipv6: '2001:db8::1' }), '2001:db8')).toBe(true)
  })

  test('matches the region by its display name or alias, not just the stored emoji', () => {
    const n = node({ region: '🇭🇰' })
    expect(isNodeMatchSearch(n, 'hong kong')).toBe(true)
    expect(isNodeMatchSearch(n, '香港')).toBe(true)
    expect(isNodeMatchSearch(n, 'japan')).toBe(false)
  })

  test('does not match an unrelated term', () => {
    expect(isNodeMatchSearch(node(), 'no-such-term-anywhere')).toBe(false)
  })
})
