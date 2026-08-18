import { describe, expect, test } from 'bun:test'
import {
  applyTopologyProbeToRoute,
  buildQuickTopologyRoute,
  createTopologyRoute,
  findDuplicateTopologyRouteIndex,
  findTopologyProbeKey,
  findUniqueTopologyNode,
  formatTopologyLatency,
  formatTopologyMetricForProbe,
  formatTopologyTelemetryLabel,
  getQuickTopologySourceNode,
  getTopologyProbe,
  getTopologyProbeStorageKey,
  getTopologyRouteProbeKey,
  listUnusedQuickLandingUuids,
  nextQuickLandingUuid,
  parseTopologyMetric,
  parseTopologyRoutes,
  pickQuickHopTaskName,
  pickQuickTopologyTaskName,
  serializeTopologyRoutes,
  shouldAutoApplyTopologyProbe,
  splitTopologyGroups,
  TOPOLOGY_LIMITS,
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

  test('serializes empty node fields without colliding with route separators', () => {
    const [route] = parseTopologyRoutes('入口|-|入口;目标|US|线路机', '15,0')

    expect(route?.nodes[0]).toMatchObject({ name: '入口', region: '', role: '入口' })
    expect(serializeTopologyRoutes(route ? [route] : [])).toEqual({
      topologyRoute: '入口|-|入口;目标|US|线路机',
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

describe('quick topology configuration', () => {
  test('prefers online nodes and exact probe task names for the first route', () => {
    const route = buildQuickTopologyRoute([
      { name: '离线东京', region: 'JP', online: false },
      { name: '在线新加坡', region: 'SG', online: true },
      { name: '在线洛杉矶', region: 'US', online: true },
    ], ['自定义任务', '北京-电信'])

    expect(route?.nodes.map(node => node.name)).toEqual(['北京电信', '在线新加坡', '在线洛杉矶'])
    expect(route?.metrics[0]).toMatchObject({
      live: true,
      nodeName: '在线新加坡',
      taskFilter: '北京-电信',
    })
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('uses an explicit probe even when the source has no matching Ping task', () => {
    const route = buildQuickTopologyRoute(
      [
        { uuid: 'relay', name: 'Riven-JP', region: 'JP', online: true },
        { uuid: 'exit', name: 'V.PS-SG', region: 'SG', online: true },
      ],
      { sourceUuid: 'relay', landingUuid: 'exit', sourceTasks: [], probeKey: 'beijing-unicom' },
    )

    expect(route?.nodes.map(node => node.name)).toEqual(['北京联通', 'Riven-JP', 'V.PS-SG'])
    expect(route?.metrics[0]).toMatchObject({ live: false, taskFilter: '' })
    expect(getTopologyRouteProbeKey(route!)).toBe('beijing-unicom')
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('rewrites a route entry to the selected probe and unique matching task', () => {
    const route = createTopologyRoute(
      [{ name: '自定义入口', region: '', role: '入口' }, { name: 'Riven-JP', region: 'JP', role: '线路机' }],
      [{ live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null }],
    )

    applyTopologyProbeToRoute(route, 'beijing-telecom', 'Riven-JP', ['北京电信', '北京联通'], ['北京电信'])

    expect(route.nodes[0]?.name).toBe('北京电信入口')
    expect(route.metrics[0]).toMatchObject({
      live: true,
      nodeName: 'Riven-JP',
      taskFilter: '北京电信',
    })
  })

  test('does not auto-apply a probe when the first segment already uses a custom task', () => {
    const custom = createTopologyRoute(
      [{ name: '北京电信', region: 'CN', role: '入口' }, { name: 'Riven-JP', region: 'JP', role: '线路机' }],
      [{ live: true, nodeName: 'Riven-JP', taskFilter: 'Tokyo', fallbackLatency: 72, fallbackLoss: 0 }],
    )
    expect(getTopologyRouteProbeKey(custom)).toBe('beijing-telecom')
    expect(shouldAutoApplyTopologyProbe(custom)).toBe(false)
    expect(shouldAutoApplyTopologyProbe(createTopologyRoute(
      [{ name: '北京电信', region: 'CN', role: '入口' }],
      [{ live: true, nodeName: 'Riven-JP', taskFilter: '北京电信', fallbackLatency: null, fallbackLoss: null }],
    ))).toBe(true)
    expect(shouldAutoApplyTopologyProbe(createTopologyRoute(
      [{ name: '北京电信', region: 'CN', role: '入口' }],
      [{ live: false, nodeName: '', taskFilter: '', fallbackLatency: null, fallbackLoss: null }],
    ))).toBe(true)
  })

  test('generates a valid static draft when no Ping task is available', () => {
    const route = buildQuickTopologyRoute([{ name: '边缘节点', region: 'HK', online: true }])

    expect(route?.nodes.map(node => node.name)).toEqual(['自定义入口', '边缘节点', ''])
    expect(serializeTopologyRoutes(route ? [route] : [])).toEqual({
      topologyRoute: '自定义入口|-|入口;边缘节点|HK|线路机',
      topologyMetrics: '-,-',
    })
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('does not guess a custom task as the entry probe', () => {
    const route = buildQuickTopologyRoute([{ name: '北京电信', region: 'CN', online: true }], ['my-ping'])

    expect(route?.nodes[0]?.name).toBe('自定义入口')
    expect(route?.metrics[0]).toMatchObject({ live: false, taskFilter: '' })
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('does not guess between multiple task names for the same entry probe', () => {
    expect(pickQuickTopologyTaskName(['北京电信', '北京-电信'], getTopologyProbe('beijing-telecom'))).toBe('')
  })

  test('keeps preset entry semantics aligned when the preset label is also a node name', () => {
    const route = buildQuickTopologyRoute([{ name: '北京电信', region: 'CN', online: true }], ['北京电信'])

    expect(route?.nodes[0]?.name).toBe('北京电信入口')
    expect(route?.metrics[0]?.taskFilter).toBe('北京电信')
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('locks quick generation to the selected source after async task loading', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'node-a', name: 'source-a', region: 'US', online: true },
      { uuid: 'node-b', name: 'source-b', region: 'JP', online: true },
    ], { sourceUuid: 'node-b', landingUuid: null, sourceTasks: ['Tokyo'], entryTask: 'Tokyo' })

    expect(route?.nodes[1]?.name).toBe('source-b')
    expect(route?.metrics[0]).toMatchObject({ nodeName: 'source-b', taskFilter: 'Tokyo' })
  })

  test('locks sources by UUID when names are reused or normalize alike', () => {
    expect(buildQuickTopologyRoute([
      { uuid: 'node-a', name: 'edge-us', online: true },
      { uuid: 'node-b', name: 'edge us', online: true },
    ], ['Tokyo'], 'node-b')?.nodes.slice(1).map(node => node.name)).toEqual(['edge us', 'edge-us'])

    expect(buildQuickTopologyRoute([
      { uuid: 'replacement', name: 'same-name', online: true },
    ], ['Tokyo'], 'removed-node')).toBeNull()
  })

  test('skips names and tasks that cannot be serialized', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'invalid', name: 'bad|source', online: true },
      { uuid: 'safe', name: 'safe-source', region: 'US', online: true },
    ], { sourceTasks: ['bad@task', 'safe-task'], entryTask: 'safe-task' })

    expect(route?.nodes[1]?.name).toBe('safe-source')
    expect(route?.metrics[0]?.taskFilter).toBe('safe-task')
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('keeps generated entry labels unique across large node sets', () => {
    const conflictingNodes = [
      { uuid: 'source', name: 'source', online: true },
      { name: '北京电信', online: true },
      { name: '北京电信入口', online: true },
      ...Array.from({ length: 99 }, (_, index) => ({ name: `北京电信入口${index + 2}`, online: true })),
    ]
    const route = buildQuickTopologyRoute(conflictingNodes, ['北京电信'], 'source')

    expect(route?.nodes[0]?.name).toBe('北京电信入口101')
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('does not offer an offline node as a quick topology source', () => {
    expect(getQuickTopologySourceNode([
      { name: 'offline-a', online: false },
      { name: 'offline-b', online: false },
    ])).toBeNull()
    expect(buildQuickTopologyRoute([{ name: 'offline-a', online: false }])).toBeNull()
  })

  test('does not auto-configure an ambiguous duplicate node name', () => {
    const nodes = [
      { uuid: 'node-a', name: 'edge', region: 'US', online: true },
      { uuid: 'node-b', name: 'edge', region: 'JP', online: true },
    ]

    expect(findUniqueTopologyNode(nodes, 'edge')).toBeUndefined()
    expect(getQuickTopologySourceNode(nodes)).toBeNull()
  })

  test('exposes the quick source node and task picker separately', () => {
    expect(getQuickTopologySourceNode([
      { name: 'offline', online: false },
      { name: 'online', online: true },
    ])?.name).toBe('online')
    expect(pickQuickTopologyTaskName(['上海移动备用', '探测任务'])).toBe('')
    expect(pickQuickTopologyTaskName(['探测任务', '北京-电信'])).toBe('北京-电信')
    expect(buildQuickTopologyRoute([])).toBeNull()
  })

  test('binds the second hop only when a source task matches the landing node', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', region: 'JP', online: true },
      { uuid: 'exit', name: '落地机-洛杉矶', region: 'US', online: true },
    ], {
      sourceUuid: 'relay',
      landingUuid: 'exit',
      sourceTasks: ['北京电信', '落地机-洛杉矶', '备用探测'],
    })

    expect(route?.nodes.map(node => node.name)).toEqual(['北京电信', '线路机-东京', '落地机-洛杉矶'])
    expect(route?.metrics[0]).toMatchObject({ live: true, nodeName: '线路机-东京', taskFilter: '北京电信' })
    expect(route?.metrics[1]).toMatchObject({ live: true, nodeName: '线路机-东京', taskFilter: '落地机-洛杉矶' })
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
    expect(pickQuickHopTaskName(['北京电信', 'Relay-to-落地机-洛杉矶'], '落地机-洛杉矶', '北京电信')).toBe('Relay-to-落地机-洛杉矶')
    expect(pickQuickHopTaskName(['北京电信', 'Tokyo'], '东京-高负载', '北京电信')).toBe('Tokyo')
    expect(pickQuickHopTaskName(['北京电信', '香港'], '香港边缘节点-超长名称布局测试', '北京电信')).toBe('香港')
  })

  test('keeps a two-node draft when the landing is left empty', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', region: 'JP', online: true },
      { uuid: 'exit', name: '落地机-洛杉矶', region: 'US', online: true },
    ], {
      sourceUuid: 'relay',
      landingUuid: '',
      sourceTasks: ['北京电信'],
    })

    expect(route?.nodes.map(node => node.name)).toEqual(['北京电信', '线路机-东京', ''])
    expect(route?.metrics[1]).toMatchObject({ live: false, taskFilter: '' })
    expect(validateTopologyRoutes(route ? [route] : [])).toEqual([])
  })

  test('keeps an explicitly empty landing selection empty until initialized', () => {
    expect(nextQuickLandingUuid('relay', '', ['relay', 'exit'], true)).toBe('exit')
    expect(nextQuickLandingUuid('relay', '', ['relay', 'exit'], false)).toBe('')
    expect(nextQuickLandingUuid('relay', 'gone', ['relay', 'exit'], false)).toBe('exit')
    expect(nextQuickLandingUuid('relay', '', ['relay', 'used', 'free'], true, ['free'])).toBe('free')
    expect(listUnusedQuickLandingUuids(
      [{ nodes: [{ name: '入口', region: 'CN', role: '入口' }, { name: '线路机-东京', region: 'JP', role: '线路机' }, { name: '落地机-洛杉矶', region: 'US', role: '落地机' }] }],
      '线路机-东京',
      [
        { uuid: 'relay', name: '线路机-东京' },
        { uuid: 'used', name: '落地机-洛杉矶' },
        { uuid: 'free', name: '落地机-新加坡' },
      ],
      'relay',
    )).toEqual(['free'])
  })

  test('uses an explicit hop task instead of guessing the landing name', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', region: 'JP', online: true },
      { uuid: 'exit', name: '落地机-洛杉矶', region: 'US', online: true },
    ], {
      sourceUuid: 'relay',
      landingUuid: 'exit',
      sourceTasks: ['北京电信', 'to-us'],
      hopTask: 'to-us',
    })

    expect(route?.metrics[1]).toMatchObject({ live: true, nodeName: '线路机-东京', taskFilter: 'to-us' })
  })

  test('detects a duplicate relay and landing pair', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', online: true },
      { uuid: 'exit', name: '落地机-洛杉矶', online: true },
    ], { sourceUuid: 'relay', landingUuid: 'exit', sourceTasks: ['北京电信'] })

    expect(findDuplicateTopologyRouteIndex(route ? [route] : [], '线路机-东京', '落地机-洛杉矶')).toBe(0)
    expect(findDuplicateTopologyRouteIndex(route ? [route] : [], '线路机-东京', '')).toBe(-1)
  })

  test('does not invent a second hop from an unrelated leftover task', () => {
    const route = buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', region: 'JP', online: true },
      { uuid: 'exit', name: '落地机-洛杉矶', region: 'US', online: true },
    ], {
      sourceUuid: 'relay',
      landingUuid: 'exit',
      sourceTasks: ['北京电信', '上海移动'],
    })

    expect(route?.metrics[1]).toMatchObject({ live: false, taskFilter: '' })
    expect(pickQuickHopTaskName(['北京电信', '节点'], '香港边缘节点-超长名称布局测试', '北京电信')).toBe('')
    expect(buildQuickTopologyRoute([
      { uuid: 'relay', name: '线路机-东京', online: true },
    ], { sourceUuid: 'relay', landingUuid: 'missing' })).toBeNull()
  })
})

describe('topology configuration validation', () => {
  test('allows an empty route list so operators can clear topology settings', () => {
    expect(validateTopologyRoutes([])).toEqual([])
    expect(serializeTopologyRoutes([])).toEqual({
      topologyRoute: '',
      topologyMetrics: '',
    })
  })

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

  test('rejects hidden extra nodes and metrics instead of truncating them on save', () => {
    const [route] = parseTopologyRoutes(
      '入口|CN|入口;线路机|US|线路机;落地机|HK|落地机;额外节点|JP|节点',
      '10,0;20,0;30,0',
    )

    expect(validateTopologyRoutes(route ? [route] : [])).toContain('第 1 条线路最多支持三个节点，高级配置包含未显示的额外节点')
    expect(validateTopologyRoutes(route ? [route] : [])).toContain('第 1 条线路最多支持两段指标，高级配置包含未显示的额外指标')
  })

  test('rejects live metrics with unexpected extra separators instead of rewriting task names', () => {
    const metric = parseTopologyMetric('live@B@task@with@10@0')
    const [route] = parseTopologyRoutes(
      'A|CN|入口;B|JP|线路机',
      'live@B@task@with@10@0',
    )

    expect(metric).toMatchObject({
      live: true,
      nodeName: 'B',
      taskFilter: 'task',
      fallbackLatency: null,
      fallbackLoss: 10,
      parseErrors: ['实时指标包含非法“@”分隔符'],
    })
    expect(validateTopologyRoutes(route ? [route] : [])).toContain('第 1 条线路第 1 段实时指标包含非法“@”分隔符')
    for (const rawMetric of ['live@B@北京电@信@10@0', 'live@B@北@京电信@10@0']) {
      expect(parseTopologyMetric(rawMetric).parseErrors).toEqual(['实时指标包含非法“@”分隔符'])
    }
  })

  test('keeps orphan and malformed static metrics visible so save is blocked', () => {
    const orphanRoutes = parseTopologyRoutes('', 'live@B@task@with@10@0')
    const staticMetric = parseTopologyMetric('10,0,99')

    expect(orphanRoutes).toHaveLength(1)
    expect(validateTopologyRoutes(orphanRoutes)).toContain('第 1 条线路第 1 段实时指标包含非法“@”分隔符')
    expect(staticMetric.parseErrors).toEqual(['静态指标包含非法“,”分隔符'])
    expect(validateTopologyRoutes(parseTopologyRoutes('入口|CN|入口;线路机|JP|线路机', '10,0,99')))
      .toContain('第 1 条线路第 1 段静态指标包含非法“,”分隔符')
  })

  test('rejects duplicate route endpoints regardless of how they were added', () => {
    const routes = parseTopologyRoutes(
      '入口一|CN|入口;线路机|JP|线路机;落地机|US|落地机||入口二|CN|入口;线路机|JP|线路机;落地机|US|落地机',
      '10,0;20,0||11,0;21,0',
    )

    expect(validateTopologyRoutes(routes)).toContain('第 2 条线路与第 1 条线路使用了相同的线路机和落地机')
  })

  test('keeps explicit legacy live metrics only when the numeric fallback boundary is unambiguous', () => {
    const metric = parseTopologyMetric('live@Relay@北京@电信@72@0')
    expect(metric).toMatchObject({
      live: true,
      nodeName: 'Relay',
      taskFilter: '北京电信',
      fallbackLatency: 72,
      fallbackLoss: 0,
    })
    expect(metric.parseErrors).toBeUndefined()
  })

  test('keeps legacy live metrics with empty fallback baselines', () => {
    const metric = parseTopologyMetric('live@Relay@北京@电信@-@-')
    expect(metric).toMatchObject({
      live: true,
      nodeName: 'Relay',
      taskFilter: '北京电信',
      fallbackLatency: null,
      fallbackLoss: null,
    })
    expect(metric.parseErrors).toBeUndefined()
    expect(validateTopologyRoutes(parseTopologyRoutes(
      '入口|CN|入口;Relay|JP|线路机',
      'live@Relay@北京@电信@-@-',
    ))).toEqual([])
  })

  test('bounds oversized route groups before allocating editor rows', () => {
    const routes = parseTopologyRoutes('||'.repeat(TOPOLOGY_LIMITS.maxRoutes + 10), '')

    expect(routes).toHaveLength(1)
    expect(validateTopologyRoutes(routes)).toContain(`第 1 条线路拓扑线路不能超过 ${TOPOLOGY_LIMITS.maxRoutes} 条`)
  })

  test('rejects product-level field limits and non-numeric suffixes', () => {
    const route = createTopologyRoute([
      { name: 'a'.repeat(TOPOLOGY_LIMITS.nodeNameLength + 1), region: 'CN', role: '入口' },
      { name: 'target', region: 'US', role: '线路机' },
    ], [{
      live: true,
      nodeName: 'target',
      taskFilter: 't'.repeat(TOPOLOGY_LIMITS.taskNameLength + 1),
      fallbackLatency: null,
      fallbackLoss: null,
    }])

    expect(validateTopologyRoutes([route])).toContain(`第 1 条线路节点名称不能超过 ${TOPOLOGY_LIMITS.nodeNameLength} 个字符`)
    expect(validateTopologyRoutes([route])).toContain(`第 1 条线路第 1 段Ping 任务不能超过 ${TOPOLOGY_LIMITS.taskNameLength} 个字符`)
    expect(parseTopologyMetric('12ms,5pct')).toMatchObject({ fallbackLatency: null, fallbackLoss: null })
  })

  test('keeps valid sub-millisecond topology latency visible', () => {
    expect(formatTopologyLatency(0.1875)).toBe('<1ms')
  })
})
