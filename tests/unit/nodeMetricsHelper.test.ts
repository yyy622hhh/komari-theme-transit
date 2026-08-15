import { describe, expect, test } from 'bun:test'
import { getConnectionCount, normalizeLatestConnections } from '../../src/utils/nodeMetricsHelper'

describe('Komari latest connection normalization', () => {
  test('separates TCP from a latest-status TCP + UDP total', () => {
    const connections = normalizeLatestConnections(120, 20)
    expect(connections).toEqual({ tcp: 100, udp: 20 })
    expect(getConnectionCount({ connections: connections.tcp, connections_udp: connections.udp })).toBe(120)
  })

  test('clamps inconsistent backend values instead of exposing negative TCP counts', () => {
    expect(normalizeLatestConnections(5, 20)).toEqual({ tcp: 0, udp: 20 })
  })
})
