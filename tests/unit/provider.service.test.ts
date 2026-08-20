import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import { buildNodeProviderMetadata, getNodeIps, getNodeProviderFingerprint, getProviderMetadataText } from '../../src/services/provider.service'

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    uuid: 'node-1',
    name: 'Relay-JP',
    region: 'JP',
    ...overrides,
  } as NodeData
}

describe('getNodeIps', () => {
  test('keeps both families in v4-then-v6 order', () => {
    expect(getNodeIps(node({ ipv4: '203.0.113.5', ipv6: '2001:db8::1' }))).toEqual(['203.0.113.5', '2001:db8::1'])
  })

  test('drops missing and blank addresses', () => {
    expect(getNodeIps(node({ ipv4: '', ipv6: '2001:db8::1' }))).toEqual(['2001:db8::1'])
    expect(getNodeIps(node({ ipv4: '   ' }))).toEqual([])
    expect(getNodeIps(node())).toEqual([])
  })
})

describe('getProviderMetadataText', () => {
  test('joins the identifying fields and skips the empty ones', () => {
    const text = getProviderMetadataText(node({ public_remark: 'Tokyo', remark: '', tags: 'edge', group: 'asia' }))
    expect(text).toBe('Relay-JP Tokyo edge asia JP')
  })
})

describe('getNodeProviderFingerprint', () => {
  test('changes whenever any identifying field changes', () => {
    const base = getNodeProviderFingerprint(node(), '', true)
    expect(getNodeProviderFingerprint(node({ name: 'Relay-SG' }), '', true)).not.toBe(base)
    expect(getNodeProviderFingerprint(node({ region: 'SG' }), '', true)).not.toBe(base)
    expect(getNodeProviderFingerprint(node(), 'alias=x', true)).not.toBe(base)
  })

  test('ignores IPs when geo lookup is off, so turning it off does not force a refetch loop', () => {
    const withIps = node({ ipv4: '203.0.113.5', ipv6: '2001:db8::1' })
    expect(getNodeProviderFingerprint(withIps, '', false)).toBe(getNodeProviderFingerprint(node(), '', false))
    expect(getNodeProviderFingerprint(withIps, '', true)).not.toBe(getNodeProviderFingerprint(node(), '', true))
  })

  test('distinguishes the same text moved between adjacent fields', () => {
    // 指纹用来判断「要不要重新查一次归属」。字段之间用不可见的 U+001F 分隔正是为了
    // 这个：直接拼接的话，把备注里的文字挪进名称会算出同一个指纹，面板就会一直停在
    // 旧的归属信息上。这条用例把那个分隔符钉住，避免后来有人「顺手」改成 join('')。
    const split = node({ name: 'Relay', public_remark: 'JP' })
    const merged = node({ name: 'RelayJP', public_remark: '' })
    expect(getNodeProviderFingerprint(split, '', true)).not.toBe(getNodeProviderFingerprint(merged, '', true))
  })
})

describe('buildNodeProviderMetadata', () => {
  test('passes the loading flag and geo straight through', () => {
    const geo = { org: 'Example ISP', asn: 'AS64500' } as never
    const metadata = buildNodeProviderMetadata(node(), '', geo, true)
    expect(metadata.loading).toBe(true)
    expect(metadata.geo).toBe(geo)
  })

  test('resolves a provider even with no geo data, using node metadata alone', () => {
    const metadata = buildNodeProviderMetadata(node({ name: 'akile-tokyo' }), '', null, false)
    expect(metadata.geo).toBeNull()
    expect(metadata.provider).not.toBeNull()
  })
})
