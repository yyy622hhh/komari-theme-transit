import { describe, expect, test } from 'bun:test'
import { mergeRouteTag, ROUTE_PROBE_MAX_NODES, selectRouteProbeCandidates } from '../../src/services/route-probe.service'

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function tagAt(msAgo: number): string {
  return `transit-route:ct=4134.4134@${Math.floor((NOW - msAgo) / 1000)}`
}

function node(overrides: Partial<{ uuid: string, name: string, tags: string, online: boolean }> = {}) {
  return { uuid: 'u1', name: 'n1', tags: '', online: true, ...overrides }
}

describe('采集节点的挑选（频率控制）', () => {
  test('没有回程标签的在线节点会被采集', () => {
    expect(selectRouteProbeCandidates([node()], NOW).map(c => c.uuid)).toEqual(['u1'])
  })

  test('标签还新鲜的节点跳过，不会重复跑', () => {
    const nodes = [node({ tags: tagAt(2 * DAY) })]
    expect(selectRouteProbeCandidates(nodes, NOW)).toEqual([])
  })

  test('标签超过 7 天才重新采集', () => {
    expect(selectRouteProbeCandidates([node({ tags: tagAt(6 * DAY) })], NOW)).toEqual([])
    expect(selectRouteProbeCandidates([node({ tags: tagAt(8 * DAY) })], NOW).map(c => c.uuid)).toEqual(['u1'])
  })

  test('离线节点不下发', () => {
    expect(selectRouteProbeCandidates([node({ online: false })], NOW)).toEqual([])
  })

  test('没有 uuid 的节点跳过', () => {
    expect(selectRouteProbeCandidates([node({ uuid: '' })], NOW)).toEqual([])
  })

  test('一次最多下发固定台数', () => {
    const nodes = Array.from({ length: ROUTE_PROBE_MAX_NODES + 5 }, (_, i) => node({ uuid: `u${i}` }))
    expect(selectRouteProbeCandidates(nodes, NOW)).toHaveLength(ROUTE_PROBE_MAX_NODES)
  })

  test('带坏标签的节点当作没有标签，会被重新采集', () => {
    expect(selectRouteProbeCandidates([node({ tags: 'transit-route:garbage' })], NOW).map(c => c.uuid)).toEqual(['u1'])
  })

  test('挑选时原样带上现有 tags，供写回时合并', () => {
    const picked = selectRouteProbeCandidates([node({ tags: '香港<blue>;中转' })], NOW)
    expect(picked[0]!.tags).toBe('香港<blue>;中转')
  })
})

describe('标签写回合并', () => {
  const routeTag = 'transit-route:ct=4809.4809@1755000000'

  test('保留运营者自己的标签', () => {
    expect(mergeRouteTag('香港<blue>;中转', routeTag)).toBe(`香港<blue>;中转;${routeTag}`)
  })

  test('替换旧的回程标签而不是追加', () => {
    const merged = mergeRouteTag(`香港;transit-route:ct=4134.4134@1700000000;中转`, routeTag)
    expect(merged).toBe(`香港;中转;${routeTag}`)
    expect(merged.match(/transit-route:/g)).toHaveLength(1)
  })

  test('原本没有标签时只留回程标签', () => {
    expect(mergeRouteTag('', routeTag)).toBe(routeTag)
  })

  test('空白与多余分隔符被清掉', () => {
    expect(mergeRouteTag('  香港 ; ; 中转  ;', routeTag)).toBe(`香港;中转;${routeTag}`)
  })
})
