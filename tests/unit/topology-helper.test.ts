import { describe, expect, test } from 'bun:test'
import {
  createTopologyRoute,
  findTopologyProbeKey,
  formatTopologyMetricForProbe,
  formatTopologyTelemetryLabel,
  getTopologyProbeStorageKey,
  parseTopologyRoutes,
  serializeTopologyRoutes,
  splitTopologyGroups,
  validateTopologyRoutes,
} from '@/utils/topologyHelper'

describe('topology telemetry direction labels', () => {
  test('describes live metrics by their real Komari probe source and task', () => {
    expect(formatTopologyTelemetryLabel(
      'live@东京-高负载@北京电信@72@0',
      '北京电信',
      '东京-高负载',
    )).toBe('探测来源：东京-高负载 · Ping 任务：北京电信')
  })

  test('keeps the configured visual direction only for an explicit static baseline', () => {
    expect(formatTopologyTelemetryLabel('84,0', '线路机', '落地机'))
      .toBe('线路机 → 落地机（静态基线）')
  })

  test('does not invent missing live source or task names', () => {
    expect(formatTopologyTelemetryLabel('live@@@-@-', '北京电信', '东京'))
      .toBe('探测来源：未指定来源节点 · Ping 任务：未指定任务')
  })
})

describe('topology route and metric alignment', () => {
  test('preserves empty metric groups when aligning metrics to routes', () => {
    expect(splitTopologyGroups('51,0||||84,0', true)).toEqual(['51,0', '', '84,0'])
    expect(splitTopologyGroups('51,0||||84,0')).toEqual(['51,0', '84,0'])
  })

  test('does not borrow an earlier route metric when a route has no metric group', () => {
    const routes = parseTopologyRoutes(
      '入口甲|CN|入口;线路甲|JP|线路机||入口乙|CN|入口;线路乙|US|线路机',
      '51,0',
    )

    expect(routes).toHaveLength(2)
    expect(routes[0]?.metrics[0]).toMatchObject({ fallbackLatency: 51, fallbackLoss: 0 })
    expect(routes[1]?.metrics[0]).toMatchObject({ fallbackLatency: null, fallbackLoss: null })
  })

  test('preserves an empty first segment inside one metric group', () => {
    const [route] = parseTopologyRoutes(
      '入口|CN|入口;线路机|JP|线路机;落地机|US|落地机',
      ';84,0',
    )

    expect(route?.metrics[0]).toMatchObject({ fallbackLatency: null, fallbackLoss: null })
    expect(route?.metrics[1]).toMatchObject({ fallbackLatency: 84, fallbackLoss: 0 })
    expect(serializeTopologyRoutes(route ? [route] : []).topologyMetrics).toBe('-,-;84,0')
  })

  test('keeps empty route groups aligned with their metric positions', () => {
    const routes = parseTopologyRoutes(
      '入口甲|CN|入口;线路甲|JP|线路机||||入口丙|CN|入口;线路丙|US|线路机',
      '11,0||||33,0',
    )

    expect(routes).toHaveLength(2)
    expect(routes.map(route => route.nodes[1]?.name)).toEqual(['线路甲', '线路丙'])
    expect(routes.map(route => route.metrics[0]?.fallbackLatency)).toEqual([11, 33])
  })

  test('round-trips a two-node route without serializing padded empty slots', () => {
    const [route] = parseTopologyRoutes('入口|CN|入口;目标|US|落地机', '15,0')
    expect(route?.nodes).toHaveLength(3)
    expect(route?.metrics).toHaveLength(2)
    expect(serializeTopologyRoutes(route ? [route] : [])).toEqual({
      topologyRoute: '入口|CN|入口;目标|US|落地机',
      topologyMetrics: '15,0',
    })
  })

  test('preserves an empty middle node slot instead of shifting the landing node forward', () => {
    const routes = parseTopologyRoutes('入口|CN|入口;;落地|US|落地机', '-,-;84,0')

    expect(routes[0]?.nodes.map(node => node.name)).toEqual(['入口', '', '落地'])
    expect(routes[0]?.metrics.map(metric => metric.fallbackLatency)).toEqual([null, 84])
    expect(validateTopologyRoutes(routes)).toContain('第 1 条线路节点顺序存在空位')
  })

  test('retains extra node field separators so invalid configuration is visible', () => {
    const routes = parseTopologyRoutes('入口|CN|入口|额外字段;线路|JP|线路机', '-,-')

    expect(routes[0]?.nodes[0]?.role).toBe('入口|额外字段')
    expect(validateTopologyRoutes(routes)).toContain('第 1 条线路节点名称、地区或角色不能包含“|”或“;”')
  })
})

describe('topology probe overrides', () => {
  test('does not turn a static or missing metric into a live probe', () => {
    expect(formatTopologyMetricForProbe('51,0', 'beijing-telecom', 'Relay')).toBe('51,0')
    expect(formatTopologyMetricForProbe('', 'beijing-telecom', 'Relay')).toBe('-,-')
  })

  test('matches only known probe task names and preserves custom tasks', () => {
    expect(findTopologyProbeKey('北京-电信')).toBe('beijing-telecom')
    expect(findTopologyProbeKey('北京电信-备用')).toBeUndefined()
    expect(findTopologyProbeKey('Relay-JP-to-Exit-US')).toBeUndefined()
  })

  test('isolates saved probe choices by full route and metric identity', () => {
    const telecom = getTopologyProbeStorageKey(
      '北京电信|CN|入口;Relay|JP|线路机;Exit|US|落地机',
      'live@Relay@北京电信@-@-',
    )
    const unicom = getTopologyProbeStorageKey(
      '北京联通|CN|入口;Relay|JP|线路机;Exit|US|落地机',
      'live@Relay@北京联通@-@-',
    )
    expect(telecom).not.toBe(unicom)
  })
})

describe('topology configuration validation', () => {
  test('rejects gaps, reserved delimiters and invalid fallback ranges', () => {
    const route = createTopologyRoute(
      [
        { name: '入口', region: 'CN', role: '入口' },
        { name: '', region: '', role: '线路机' },
        { name: 'Exit|US', region: 'US', role: '落地机' },
      ],
      [
        { live: true, nodeName: 'Relay', taskFilter: 'Ping@Primary', fallbackLatency: -1, fallbackLoss: 101 },
        { live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null },
      ],
    )

    expect(validateTopologyRoutes([route])).toEqual([
      '第 1 条线路节点顺序存在空位',
      '第 1 条线路节点名称、地区或角色不能包含“|”或“;”',
      '第 1 条线路第 1 段来源节点或 Ping 任务不能包含“@”、“;”或“||”',
      '第 1 条线路第 1 段备用延迟不能小于 0',
      '第 1 条线路第 1 段备用丢包必须在 0 到 100 之间',
    ])
  })
})
