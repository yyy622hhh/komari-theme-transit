import { describe, expect, test } from 'bun:test'
import { parseTopologyConfig, readTopologyRoutes, serializeTopologyConfig, TOPOLOGY_CONFIG_VERSION } from '../../src/utils/topologyConfig'
import { createTopologyRoute } from '../../src/utils/topologyHelper'

const LEGACY_ROUTE = '北京电信|CN|入口;主控-洛杉矶|US|线路机|relay-uuid;香港边缘|HK|落地机|exit-uuid'
const LEGACY_METRICS = 'live@主控-洛杉矶@北京电信@-@-;51,0'

function route(): ReturnType<typeof createTopologyRoute> {
  return createTopologyRoute(
    [
      { name: '北京电信', region: 'CN', role: '入口' },
      { name: '主控-洛杉矶', region: 'US', role: '线路机', uuid: 'relay-uuid' },
      { name: '香港边缘', region: 'HK', role: '落地机', uuid: 'exit-uuid' },
    ],
    [
      { live: true, nodeName: '主控-洛杉矶', taskFilter: '北京电信', fallbackLatency: null, fallbackLoss: null },
      { live: false, nodeName: '', taskFilter: '', fallbackLatency: 51, fallbackLoss: 0 },
    ],
  )
}

describe('serializeTopologyConfig', () => {
  test('round-trips a route through JSON without losing uuid, task binding or fallbacks', () => {
    const [parsed] = parseTopologyConfig(serializeTopologyConfig([route()]))!
    expect(parsed!.nodes).toEqual([
      { name: '北京电信', region: 'CN', role: '入口' },
      { name: '主控-洛杉矶', region: 'US', role: '线路机', uuid: 'relay-uuid' },
      { name: '香港边缘', region: 'HK', role: '落地机', uuid: 'exit-uuid' },
    ])
    expect(parsed!.metrics).toEqual([
      { live: true, nodeName: '主控-洛杉矶', taskFilter: '北京电信', fallbackLatency: null, fallbackLoss: null },
      { live: false, nodeName: '', taskFilter: '', fallbackLatency: 51, fallbackLoss: 0 },
    ])
  })

  test('keeps names that the delimiter format had to reject', () => {
    // 旧格式里 | ; @ 是保留字符，只能靠校验拒绝。JSON 存储没有这个限制——这正是
    // 换格式要拿到的东西，遗留字段停写后校验就能放开。
    const awkward = createTopologyRoute(
      [
        { name: '入口', region: '', role: '入口' },
        { name: 'relay|a;b@c', region: '', role: '线路机', uuid: 'relay-uuid' },
        { name: '落地', region: '', role: '落地机', uuid: 'exit-uuid' },
      ],
      [
        { live: true, nodeName: 'relay|a;b@c', taskFilter: 'task@1', fallbackLatency: null, fallbackLoss: null },
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
      ],
    )
    const [parsed] = parseTopologyConfig(serializeTopologyConfig([awkward]))!
    expect(parsed!.nodes[1]!.name).toBe('relay|a;b@c')
    expect(parsed!.metrics[0]!.taskFilter).toBe('task@1')
  })

  test('drops disabled routes and trailing empty nodes, like the legacy writer did', () => {
    const disabled = route()
    disabled.enabled = false
    const trailingEmpty = createTopologyRoute(
      [
        { name: '入口', region: '', role: '入口' },
        { name: '线路机', region: '', role: '线路机' },
        { name: '', region: '', role: '落地机' },
      ],
      [
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: 10, fallbackLoss: 0 },
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
      ],
    )
    const payload = JSON.parse(serializeTopologyConfig([disabled, trailingEmpty])) as { routes: unknown[] }
    expect(payload.routes).toHaveLength(1)
    expect(payload).toMatchObject({
      version: TOPOLOGY_CONFIG_VERSION,
      routes: [{ nodes: [{ name: '入口' }, { name: '线路机' }], metrics: [{ fallbackLatency: 10, fallbackLoss: 0 }] }],
    })
  })

  test('a route with fewer than two named nodes is not persisted', () => {
    const lonely = createTopologyRoute(
      [{ name: '只有入口', region: '', role: '入口' }, { name: '', region: '', role: '线路机' }, { name: '', region: '', role: '落地机' }],
      [{ live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null }],
    )
    expect(JSON.parse(serializeTopologyConfig([lonely]))).toEqual({ version: TOPOLOGY_CONFIG_VERSION, routes: [] })
  })
})

describe('parseTopologyConfig', () => {
  test('returns null for anything that is not usable JSON, so callers fall back to the legacy fields', () => {
    expect(parseTopologyConfig(undefined)).toBeNull()
    expect(parseTopologyConfig('')).toBeNull()
    expect(parseTopologyConfig('   ')).toBeNull()
    expect(parseTopologyConfig('not json')).toBeNull()
    expect(parseTopologyConfig('[]')).toBeNull()
    expect(parseTopologyConfig('{"version":1}')).toBeNull()
    expect(parseTopologyConfig(42)).toBeNull()
  })

  test('an empty route list is a valid answer, not a missing one', () => {
    // 删光所有线路后必须解析成空数组。当成「没配置」会回退到遗留字段，刚删掉的
    // 线路一刷新又冒出来。
    expect(parseTopologyConfig('{"version":1,"routes":[]}')).toEqual([])
  })

  test('refuses a future version instead of guessing at an unknown shape', () => {
    expect(parseTopologyConfig(`{"version":${TOPOLOGY_CONFIG_VERSION + 1},"routes":[]}`)).toBeNull()
  })

  test('fills missing nodes and metrics so the UI always has three slots and two segments', () => {
    const [parsed] = parseTopologyConfig('{"version":1,"routes":[{"nodes":[{"name":"a"},{"name":"b"}],"metrics":[]}]}')!
    expect(parsed!.nodes.map(node => node.name)).toEqual(['a', 'b', ''])
    expect(parsed!.nodes.map(node => node.role)).toEqual(['入口', '线路机', '落地机'])
    expect(parsed!.metrics).toHaveLength(2)
    expect(parsed!.metrics.every(metric => !metric.live)).toBe(true)
  })

  test('tolerates junk field types without throwing', () => {
    const [parsed] = parseTopologyConfig('{"version":1,"routes":[{"nodes":[{"name":"a","uuid":5},null],"metrics":[{"live":"yes"}]}]}')!
    expect(parsed!.nodes[0]).toEqual({ name: 'a', region: '', role: '入口' })
    expect(parsed!.metrics[0]!.live).toBe(false)
  })

  test('caps routes at the configured maximum', () => {
    const many = { version: 1, routes: Array.from({ length: 80 }, () => ({ nodes: [{ name: 'a' }, { name: 'b' }], metrics: [] })) }
    expect(parseTopologyConfig(JSON.stringify(many))).toHaveLength(50)
  })
})

describe('readTopologyRoutes', () => {
  test('prefers the JSON config over the legacy strings', () => {
    const json = serializeTopologyConfig([route()])
    const routes = readTopologyRoutes(json, '完全不同|CN|入口;另一台|JP|线路机', '20,0')
    expect(routes[0]!.nodes[1]!.name).toBe('主控-洛杉矶')
  })

  test('falls back to the legacy strings when no JSON has been written yet', () => {
    const routes = readTopologyRoutes('', LEGACY_ROUTE, LEGACY_METRICS)
    expect(routes[0]!.nodes.map(node => node.name)).toEqual(['北京电信', '主控-洛杉矶', '香港边缘'])
    expect(routes[0]!.nodes[1]!.uuid).toBe('relay-uuid')
    expect(routes[0]!.metrics[0]).toMatchObject({ live: true, nodeName: '主控-洛杉矶', taskFilter: '北京电信' })
    expect(routes[0]!.metrics[1]).toMatchObject({ live: false, fallbackLatency: 51, fallbackLoss: 0 })
  })

  test('an old install upgrades to JSON without changing what the user sees', () => {
    const fromLegacy = readTopologyRoutes('', LEGACY_ROUTE, LEGACY_METRICS)
    const fromJson = readTopologyRoutes(serializeTopologyConfig(fromLegacy), '', '')
    expect(fromJson.map(entry => ({ nodes: entry.nodes, metrics: entry.metrics })))
      .toEqual(fromLegacy.map(entry => ({ nodes: entry.nodes, metrics: entry.metrics })))
  })

  test('corrupt JSON degrades to the legacy strings rather than showing an empty topology', () => {
    const routes = readTopologyRoutes('{"version":1,"routes":', LEGACY_ROUTE, LEGACY_METRICS)
    expect(routes[0]!.nodes[1]!.name).toBe('主控-洛杉矶')
  })
})
