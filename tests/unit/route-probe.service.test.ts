import { describe, expect, test } from 'bun:test'
import { classifyRouteProbeOutputFailure, mergeRouteTag, pickNodeAgentTokens, ROUTE_PROBE_MAX_NODES, selectRouteProbeCandidates } from '../../src/services/route-probe.service'

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

function tagAt(msAgo: number): string {
  return `transit-route:ct=4134.4134@${Math.floor((NOW - msAgo) / 1000)}`
}

function node(overrides: Partial<{ uuid: string, name: string, region: string, tags: string, online: boolean }> = {}) {
  return { uuid: 'u1', name: 'n1', region: 'US', tags: '', online: true, ...overrides }
}

describe('采集节点的挑选（频率控制）', () => {
  test('没有回程标签的在线节点会被采集', () => {
    expect(selectRouteProbeCandidates([node()], NOW).map(c => c.uuid)).toEqual(['u1'])
  })

  test('标签还新鲜的节点跳过，不会重复跑', () => {
    const nodes = [node({ tags: tagAt(2 * DAY) })]
    expect(selectRouteProbeCandidates(nodes, NOW)).toEqual([])
  })

  test('主题里的新结果优先于节点旧标签参与新鲜度判断', () => {
    const nodes = [node({ tags: tagAt(8 * DAY) })]
    const stored = { u1: tagAt(2 * DAY) }
    expect(selectRouteProbeCandidates(nodes, NOW, new Set(), false, stored)).toEqual([])
  })

  test('force 跳过新鲜度检查，但仍然排除离线和中国大陆节点', () => {
    const fresh = [node({ tags: tagAt(2 * DAY) })]
    expect(selectRouteProbeCandidates(fresh, NOW, new Set(), true).map(c => c.uuid)).toEqual(['u1'])
    expect(selectRouteProbeCandidates([node({ online: false, tags: tagAt(2 * DAY) })], NOW, new Set(), true)).toEqual([])
    expect(selectRouteProbeCandidates([node({ region: 'CN', tags: tagAt(2 * DAY) })], NOW, new Set(), true)).toEqual([])
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

  test('中国大陆节点不参与境外回程检测', () => {
    for (const region of ['CN', 'cn', '🇨🇳', '中国'])
      expect(selectRouteProbeCandidates([node({ region })], NOW)).toEqual([])
  })

  test('港澳台仍属于需要检测的境外线路', () => {
    const regions = ['HK', '🇭🇰', 'MO', '🇲🇴', 'TW', '🇹🇼']
    const nodes = regions.map((region, index) => node({ uuid: `u${index}`, region }))
    expect(selectRouteProbeCandidates(nodes, NOW).map(candidate => candidate.uuid)).toEqual(
      regions.map((_, index) => `u${index}`),
    )
  })

  test('一次最多下发固定台数', () => {
    const nodes = Array.from({ length: ROUTE_PROBE_MAX_NODES + 5 }, (_, i) => node({ uuid: `u${i}` }))
    expect(selectRouteProbeCandidates(nodes, NOW)).toHaveLength(ROUTE_PROBE_MAX_NODES)
  })

  test('带坏标签的节点当作没有标签，会被重新采集', () => {
    expect(selectRouteProbeCandidates([node({ tags: 'transit-route:garbage' })], NOW).map(c => c.uuid)).toEqual(['u1'])
  })

  test('候选不携带旧 tags，写回必须重新读取最新值', () => {
    const picked = selectRouteProbeCandidates([node({ tags: '香港<blue>;中转' })], NOW)
    expect(picked[0]).toEqual({ uuid: 'u1', name: 'n1' })
  })

  test('跳过清单在截断台数之前生效，后面的节点不会被饿死', () => {
    // 前 20 台永远失败时，若先截断再过滤，候选会恒为空，第 21 台起一次也轮不到。
    const nodes = Array.from({ length: ROUTE_PROBE_MAX_NODES + 5 }, (_, i) => node({ uuid: `u${i}` }))
    const skip = new Set(nodes.slice(0, ROUTE_PROBE_MAX_NODES).map(n => n.uuid))

    const picked = selectRouteProbeCandidates(nodes, NOW, skip)
    expect(picked).toHaveLength(5)
    expect(picked.map(c => c.uuid)).toEqual(['u20', 'u21', 'u22', 'u23', 'u24'])
  })

  test('采集时间未知的标签按「该重测」处理，不会被永久钉在轮换之外', () => {
    // 手写或从文档抄来的标签可能没有 @<unix> 后缀；无从判断新鲜度就该重测。
    const picked = selectRouteProbeCandidates([node({ tags: 'transit-route:ct=4134.4134' })], NOW)
    expect(picked.map(c => c.uuid)).toEqual(['u1'])
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

describe('采集执行失败归因', () => {
  test('远程控制关闭不会被误报成普通探测失败', () => {
    expect(classifyRouteProbeOutputFailure('Remote control is disabled.')).toBe('remote-disabled')
  })

  test('未安装 traceroute 有独立状态', () => {
    expect(classifyRouteProbeOutputFailure('__TRANSIT_ROUTE_NO_TRACEROUTE__\n')).toBe('no-traceroute')
  })

  test('没有任何分段标记的空回执归普通失败', () => {
    expect(classifyRouteProbeOutputFailure('')).toBe('failed')
  })

  test('带有效分段标记的回执交给线路解析继续处理', () => {
    expect(classifyRouteProbeOutputFailure('__TRANSIT_ROUTE_CT__\n 1 59.43.1.1 1 ms')).toBeNull()
  })
})

describe('节点 Agent token 过滤', () => {
  test('只留下指定 UUID 的 token，忽略空白和缺 token 的节点', () => {
    expect(pickNodeAgentTokens({
      missing: { token: 'keep-me' },
      online: { token: 'drop-me' },
      empty: { token: '  ' },
      none: {},
    }, ['missing', 'empty', 'none', ' missing ', ''])).toEqual({
      missing: 'keep-me',
    })
  })
})
