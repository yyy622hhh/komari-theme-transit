import { describe, expect, test } from 'bun:test'
import { topologyProbeDirection } from '../../src/utils/topologyProbeDirection'

describe('topology probe direction', () => {
  test('operator targets are probed from the relay; later hops point forward', () => {
    expect(topologyProbeDirection(0, true, 'relay', 'relay')).toBe('reverse')
    expect(topologyProbeDirection(1, true, 'relay', 'relay')).toBe('forward')
    expect(topologyProbeDirection(2, true, 'exit', 'exit')).toBe('forward')
  })

  test('static baselines or unresolved/external sources never imply a measured direction', () => {
    expect(topologyProbeDirection(0, false, 'relay', 'relay')).toBeUndefined()
    expect(topologyProbeDirection(0, true, undefined, 'relay')).toBeUndefined()
    expect(topologyProbeDirection(1, true, 'other-node', 'relay')).toBeUndefined()
    expect(topologyProbeDirection(1, true, 'relay', undefined)).toBeUndefined()
  })
})
