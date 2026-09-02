import { describe, expect, test } from 'bun:test'
import {
  mergeRouteProbeResults,
  normalizeRouteProbeResults,
  resolveNodeRouteTag,
  ROUTE_PROBE_MAX_RESULTS,
  stripNodeRouteTags,
} from '../../src/utils/routeProbeResults'

const OLD = 'transit-route:ct=4134,cu=4837,cm=9808@1755000000'
const NEW = 'transit-route:ct=4809.4809,cu=9929,cm=58807@1756000000'

describe('route probe result storage boundary', () => {
  test('normalizes JSON strings and drops malformed or oversized entries', () => {
    const normalized = normalizeRouteProbeResults(JSON.stringify({
      nodeA: OLD,
      malformed: 'transit-route:garbage',
      huge: `transit-route:ct=${'1'.repeat(5000)}`,
      object: { tag: OLD },
    }))

    expect(normalized).toEqual({ nodeA: OLD })
    expect(Object.getPrototypeOf(normalized)).toBeNull()
  })

  test('chooses the newest valid result and falls back across storage formats', () => {
    expect(resolveNodeRouteTag('nodeA', `custom;${OLD}`, { nodeA: NEW })).toBe(NEW)
    expect(resolveNodeRouteTag('nodeA', `custom;${NEW}`, { nodeA: OLD })).toBe(NEW)
    expect(resolveNodeRouteTag('nodeB', `custom;${OLD}`, {})).toBe(OLD)
    expect(resolveNodeRouteTag('nodeB', 'custom', {})).toBe('')
  })

  test('does not read inherited object keys as node results', () => {
    expect(resolveNodeRouteTag('toString', `custom;${OLD}`, {})).toBe(OLD)
  })

  test('strips only legacy Transit metadata and preserves operator tags', () => {
    expect(stripNodeRouteTags(` core<jade> ; ${OLD} ;命令后新增<purple>; TRANSIT-ROUTE:ct=4134 `))
      .toBe('core<jade>;命令后新增<purple>')
  })

  test('merges by timestamp without prototype mutation', () => {
    const malicious = JSON.parse(`{"__proto__":"${NEW}","nodeA":"${NEW}"}`) as Record<string, string>
    const merged = mergeRouteProbeResults({ nodeA: NEW }, { nodeA: OLD, ...malicious })

    expect(merged.nodeA).toBe(NEW)
    expect(Object.getPrototypeOf(merged)).toBeNull()
    expect(Object.hasOwn(merged, '__proto__')).toBe(true)
  })

  test('invalid leading entries do not consume the valid-result limit', () => {
    const malformed = Object.fromEntries(
      Array.from({ length: ROUTE_PROBE_MAX_RESULTS + 1 }, (_, index) => [`bad-${index}`, 'not-a-route-tag']),
    )
    const normalized = normalizeRouteProbeResults({ ...malformed, newest: NEW })

    expect(normalized.newest).toBe(NEW)
    expect(Object.keys(normalized)).toHaveLength(1)
  })

  test('retains newest evidence at capacity so a fresh node cannot be crowded out', () => {
    const current = Object.fromEntries(
      Array.from({ length: ROUTE_PROBE_MAX_RESULTS }, (_, index) => [
        `old-${index}`,
        `transit-route:ct=4134@${1_700_000_000 + index}`,
      ]),
    )
    const merged = mergeRouteProbeResults(current, { fresh: 'transit-route:ct=4809@1900000000' })

    expect(Object.keys(merged)).toHaveLength(ROUTE_PROBE_MAX_RESULTS)
    expect(merged.fresh).toBe('transit-route:ct=4809@1900000000')
    expect(merged['old-0']).toBeUndefined()
  })

  test('prunes results for nodes no longer present when an active catalogue is supplied', () => {
    const merged = mergeRouteProbeResults(
      { removed: OLD, retained: OLD },
      { fresh: NEW },
      ['retained', 'fresh'],
    )

    expect(merged).toEqual({ fresh: NEW, retained: OLD })
    expect(merged.removed).toBeUndefined()
  })
})
