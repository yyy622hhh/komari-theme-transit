import type { Page, Route } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const VISUAL_FONT_FILES = {
  chinese: fileURLToPath(new URL('../../../node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff2', import.meta.url)),
  latin: fileURLToPath(new URL('../../../node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-latin-wght-normal.woff2', import.meta.url)),
}

const FIXED_NOW = '2026-07-25T12:00:00.000Z'
const GIB = 1024 ** 3
const TIB = 1024 ** 4
const FIRST_TOPOLOGY_METRIC_PATTERN = /^live@[^;]+/

/** 模拟节点交回来的 traceroute 输出：电信 CN2GIA、联通 4837、移动 CMIN2。 */
const VISUAL_TRACE_OUTPUT = [
  '__TRANSIT_ROUTE_CT__',
  ' 1  10.0.0.1  0.5 ms',
  ' 2  59.43.130.1  120.1 ms',
  ' 3  59.43.82.2  130.4 ms',
  ' 4  202.97.94.1  140.2 ms',
  '__TRANSIT_ROUTE_CU__',
  ' 1  219.158.16.1  150.0 ms',
  ' 2  219.158.3.65  152.1 ms',
  '__TRANSIT_ROUTE_CM__',
  ' 1  223.120.140.1  160.0 ms',
  ' 2  221.183.55.1  165.2 ms',
].join('\n')

/** 本次 fixture 安装期间记录到的远程执行与写回，供断言检查。 */
let routeProbeExecCalls: Array<{ command: string, clients: string[] }> = []
let routeProbeEdits: Array<{ uuid: string, tags: string }> = []
let routeProbeCompanionCalls: Array<{ clients: string[], city: string, guard: string | undefined }> = []
let routeProbeThemeSettingsSaves: Array<Record<string, unknown>> = []

export function readRouteProbeExecCalls(): Array<{ command: string, clients: string[] }> {
  return routeProbeExecCalls
}

export function readRouteProbeEdits(): Array<{ uuid: string, tags: string }> {
  return routeProbeEdits
}

export function readRouteProbeCompanionCalls(): Array<{ clients: string[], city: string, guard: string | undefined }> {
  return routeProbeCompanionCalls
}

export function readRouteProbeThemeSettingsSaves(): Array<Record<string, unknown>> {
  return routeProbeThemeSettingsSaves
}

const REGION_FIXTURES = [
  { code: 'US', name: '主控-洛杉矶', cpu: 'Intel Xeon Gold 6152 CPU @ 2.10GHz' },
  { code: 'HK', name: '香港边缘节点-超长名称布局测试', cpu: 'AMD EPYC 7551 32-Core Processor' },
  { code: 'JP', name: '东京-高负载', cpu: 'AMD EPYC 7B13 64-Core Processor' },
  { code: 'SG', name: '新加坡-A100', cpu: 'AMD EPYC 9654 96-Core Processor' },
  { code: 'DE', name: '法兰克福-2680', cpu: 'Intel Xeon CPU E5-2680 v4 @ 2.40GHz' },
  { code: 'GB', name: '伦敦-离线归档', cpu: 'Intel N100' },
  { code: 'TW', name: '台北-流量预警', cpu: 'Ampere Altra Max M128-30' },
  { code: 'AU', name: '悉尼-IPv6', cpu: 'AMD Ryzen 9 9950X 16-Core Processor' },
] as const

export interface VisualFixtureOptions {
  dark?: boolean
  earthRenderer?: 'cobe' | 'realistic' | 'tiled'
  colorVisionFriendly?: boolean
  viewMode?: 'card' | 'list'
  nodeCardSize?: 'mini' | 'compact' | 'comfortable' | 'large'
  freePriceNode?: boolean
  hideEarth?: boolean
  expiryThresholds?: boolean
  missingCpuMetricHistory?: boolean
  pingTaskOrdering?: boolean
  opsDashboard?: boolean
  authenticated?: boolean
  opsMissingNode?: boolean
  opsMissingPingSource?: boolean
  opsNoRecentTask?: boolean
  opsComparableRoutes?: boolean
  opsLiveFirstHop?: boolean
  topologyAutoRepairEnabled?: boolean
  opsCustomFirstMetric?: boolean
  opsKnownEntryCustomTask?: boolean
  opsOverlappingTask?: boolean
  opsStaticFirstMetric?: boolean
  opsAutoFirstMetric?: boolean
  opsTwoNodeRoute?: boolean
  opsTrailingEmptyNode?: boolean
  opsExternalOfflineSource?: boolean
  opsLegacyPingFallback?: boolean
  /** 为线路洞察生成 7 天小时样本、持续基线阶跃和一组唯一对向线路。 */
  opsTopologyInsights?: boolean
  opsSevereLoss?: boolean
  opsExtremeLatency?: boolean
  /** 让北京联通任务在多数节点的同两个时间桶同步失败。 */
  carrierCommonModeLoss?: boolean
  opsMetricDelayMs?: number
  quickTopologyCustomTask?: boolean
  quickTopologyPresetConflict?: boolean
  quickTopologyTaskFailure?: boolean
  quickTopologyTaskDelayMs?: number
  quickTopologyMutationDelayMs?: number
  /** 让健康中心迁移时删除旧任务失败，验证补偿会保留旧任务。 */
  carrierMigrationDeleteFailure?: boolean
  carrierRawSamples?: boolean
  carrierRecentOutcome?: 'healthy' | 'failed' | 'stale' | 'insufficient'
  /** 三网卡片数据协议；默认保留 TCP，用于覆盖迁移前场景。 */
  carrierProbeType?: 'icmp' | 'tcp'
  preserveOperationJournal?: boolean
  routeProbeStorageDegraded?: boolean
  /** 拒绝回程结果的主题设置保存，验证保存失败时不会清理旧标签。 */
  routeProbeThemeSaveFailure?: boolean
  quickTopologyNoTasks?: boolean
  quickTopologyNoAddress?: boolean
  /**
   * 给 1 号节点写一条回程判定标签。传 `stale` 时把采集时间挪到 30 天前，用来
   * 验证过期判定不再着色。
   */
  returnRouteTag?: 'unknown' | 'fresh' | 'stale' | 'inconclusive'
  /** 回程标签所在的 fixture 节点；默认为 1，用于精确复现同节点并发修改。 */
  returnRouteTagNodeIndex?: number
  /** 记录并模拟三网回程的远程执行（admin:exec / 结果轮询 / 写回）。 */
  routeProbeExec?: boolean
  /** 模拟优先的固定能力节点助手伴生插件路径。 */
  routeProbeCompanion?: boolean
  /** 设置向导的花名册模拟：这些 UUID 视为「从未连接」，用来测试缺助手的提示和安装命令。 */
  routeProbeMissingHelperUuids?: string[]
  /** 模拟花名册接口在插件已确认安装之后仍然失败，用来测试向导不会显示假的“0 台在线”。 */
  routeProbeRosterFails?: boolean
  /** 回程采集是显式启用的可选能力；默认关闭。 */
  routeProbeEnabled?: boolean
  /** 复现旧版默认开启键，验证升级后不会绕过新的显式同意。 */
  routeProbeLegacyAutoEnabled?: boolean
  /** 覆写远程执行回执，用来验证运行环境问题能被准确告知运营者。 */
  routeProbeResult?: 'success' | 'remote-disabled' | 'missing-traceroute'
  /** 模拟命令执行期间管理员新增的标签，用来验证写回不会拿旧快照覆盖它。 */
  routeProbeConcurrentTag?: string
  routeProbeEditFailure?: boolean
  /**
   * 覆写 `public:getPingMetricStats` 的采样结果，用来驱动第 2 段探测方式的
   * 自动挑选与自愈：`valid > 0` 代表这种探测方式通，`total > 0 && valid === 0`
   * 代表打不通。
   */
  topologyProbeStats?: Array<{ entity_id?: string, task_id: string | number, name?: string, total: number, valid: number }>
  /** 把第 1 条线路的 hop 任务改成主题自己会生成的名字，用来验证换下来的任务会被清理。 */
  topologyGeneratedHopName?: boolean
  themeSaveDelayMs?: number
  emptyTopology?: boolean
  /** 只写 JSON 配置、清空遗留字段，用来验证新读路径不依赖旧格式。 */
  opsJsonTopologyOnly?: boolean
  visitorInfoEnabled?: boolean
  visitorAuditClientEnabled?: boolean
  visitorAuditSupported?: boolean
  announcementEscaping?: boolean
  hidePriceWhenLoggedOut?: boolean
  orderSaveFailure?: boolean
  authenticationExpires?: boolean
  nodeCardWorstCase?: boolean
  nodeCardPanels?: Record<string, { mode: string, pingTasks?: string[] }>
  /** Generate a deterministic large node fleet for performance coverage. */
  nodeCount?: number
  /**
   * 默认把设置向导标记为"已看过"，这样其余场景不用逐个处理首次登录弹出的
   * 模态框。传 `true` 才会让向导按真实首次会话的样子自动弹出。
   */
  setupWizardFirstRun?: boolean
}

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

function buildClients(freePriceNode = false, expiryThresholds = false, nodeCount = 12) {
  return Object.fromEntries(Array.from({ length: nodeCount }, (_, index) => {
    const fixture = REGION_FIXTURES[index % REGION_FIXTURES.length]
    const uuid = uuidFor(index)
    return [uuid, {
      uuid,
      token: `agent-token-${index}`,
      name: index < REGION_FIXTURES.length ? fixture.name : `${fixture.name}-${index + 1}`,
      cpu_name: fixture.cpu,
      virtualization: index % 3 === 0 ? 'docker' : 'kvm',
      arch: index % 4 === 0 ? 'aarch64' : 'x86_64',
      cpu_cores: index % 4 + 1,
      cpu_physical_cores: Math.max(1, index % 3 + 1),
      os: index % 2 === 0 ? 'Ubuntu 24.04.4 LTS' : 'Debian GNU/Linux 12',
      kernel_version: '6.8.0-visual-test',
      gpu_name: index === 3 ? 'NVIDIA A100 80GB PCIe' : '',
      ipv4: `192.0.2.${index + 10}`,
      ipv6: `2001:db8:abcd:${index + 1}::${index + 10}`,
      region: fixture.code,
      public_remark: index === 1 ? '长备注用于验证文本换行与裁切' : '',
      mem_total: (index % 4 + 1) * GIB,
      swap_total: index % 3 === 0 ? 2 * GIB : 0,
      disk_total: (index % 3 + 1) * 40 * GIB,
      version: '1.2.6-visual',
      weight: index,
      price: freePriceNode && index === 0 ? -1 : index === 5 ? 0 : 9.9 + index,
      billing_cycle: 365,
      auto_renewal: index % 2 === 0,
      currency: 'USD',
      expired_at: expiryThresholds && index === 0
        ? '2026-07-30T12:00:00.000Z'
        : expiryThresholds && index === 1
          ? '2026-08-04T12:00:00.000Z'
          : index === 6 ? '2026-08-02T00:00:00.000Z' : '2027-07-25T00:00:00.000Z',
      group: index < 6 ? '生产' : '测试,边缘',
      tags: index % 2 === 0 ? 'core<jade>,visual<blue>' : 'edge<orange>',
      hidden: false,
      traffic_limit: index === 6 ? 2 * TIB : 20 * TIB,
      traffic_limit_type: 'sum',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: FIXED_NOW,
    }]
  }))
}

function buildStatuses(nodeCount = 12) {
  return Object.fromEntries(Array.from({ length: nodeCount }, (_, index) => {
    const uuid = uuidFor(index)
    const offline = index === 5
    const highLoad = index === 2
    const trafficWarning = index === 6
    const memTotal = (index % 4 + 1) * GIB
    const diskTotal = (index % 3 + 1) * 40 * GIB
    return [uuid, {
      client: uuid,
      time: FIXED_NOW,
      cpu: offline ? 0 : highLoad ? 96.4 : 8 + index * 2.7,
      gpu: index === 3 ? 72.5 : 0,
      gpu_count: index === 3 ? 1 : 0,
      gpu_average_usage: index === 3 ? 72.5 : 0,
      gpu_detailed_info: index === 3 ? [{ name: 'NVIDIA A100', utilization: 72.5, memory_total: 80 * GIB, memory_used: 52 * GIB, temperature: 61 }] : [],
      ram: offline ? 0 : Math.round(memTotal * (0.28 + index * 0.025)),
      ram_total: memTotal,
      swap: index % 3 === 0 ? (index + 1) * 64 * 1024 ** 2 : 0,
      swap_total: index % 3 === 0 ? 2 * GIB : 0,
      load: offline ? 0 : 0.18 + index * 0.11,
      load5: offline ? 0 : 0.14 + index * 0.09,
      load15: offline ? 0 : 0.1 + index * 0.07,
      temp: offline ? 0 : 36 + index,
      disk: Math.round(diskTotal * (0.18 + index * 0.035)),
      disk_total: diskTotal,
      net_in: offline ? 0 : 32_000 + index * 91_000,
      net_out: offline ? 0 : 18_000 + index * 63_000,
      net_total_up: (index + 1) * 45 * GIB,
      net_total_down: trafficWarning ? 1.78 * TIB : (index + 1) * 62 * GIB,
      traffic_up: (index + 1) * 3 * GIB,
      traffic_down: (index + 1) * 5 * GIB,
      process: offline ? 0 : 72 + index * 4,
      connections: offline ? 0 : 140 + index * 17,
      connections_udp: offline ? 0 : 8 + index,
      online: !offline,
      uptime: offline ? 0 : (index + 3) * 86_400,
      message: '',
      updated_at: FIXED_NOW,
      ping: {
        1: { name: 'Tokyo', latest: offline ? -1 : 42 + index * 13, avg: 50 + index * 11, tail: 88 + index * 14, loss: offline ? 100 : index * 2.3, min: 32, max: 260 },
      },
    }]
  }))
}

const clients = buildClients()
const statuses = buildStatuses()

function buildRecords(uuid = uuidFor(0)) {
  const status = statuses[uuid] ?? statuses[uuidFor(0)]
  return Array.from({ length: 48 }, (_, index) => ({
    ...status,
    client: uuid,
    time: new Date(Date.parse(FIXED_NOW) - (47 - index) * 75_000).toISOString(),
    cpu: Math.max(1, Number(status.cpu) + Math.sin(index / 5) * 8),
    ram: Math.max(0, Number(status.ram) + index * 2 * 1024 ** 2),
    disk: Math.max(0, Number(status.disk) + index * 4 * 1024 ** 2),
    net_in: 80_000 + index * 12_000,
    net_out: 50_000 + index * 9_000,
  }))
}

const METRIC_KEYS = [
  'cpu.usage',
  'load.average',
  'memory.used',
  'memory.total',
  'swap.used',
  'swap.total',
  'temperature',
  'disk.used',
  'disk.total',
  'net.in.rate',
  'net.out.rate',
  'net.total.down',
  'net.total.up',
  'traffic.down',
  'traffic.up',
  'process.count',
  'connections.tcp',
  'connections.udp',
  'gpu.usage',
  'gpu.device.usage',
  'gpu.memory.used',
  'gpu.memory.total',
  'gpu.temperature',
  'ping.latency_ms',
  'ping.loss',
] as const

function metricValue(key: string, index: number): number {
  const values: Record<string, number> = {
    'cpu.usage': 22 + Math.sin(index / 4) * 12,
    'load.average': 0.45 + Math.sin(index / 6) * 0.2,
    'memory.used': 1.2 * GIB + index * 3 * 1024 ** 2,
    'memory.total': 4 * GIB,
    'swap.used': 260 * 1024 ** 2 + index * 1024 ** 2,
    'swap.total': 2 * GIB,
    'temperature': 44 + Math.sin(index / 5) * 5,
    'disk.used': 18 * GIB + index * 4 * 1024 ** 2,
    'disk.total': 80 * GIB,
    'net.in.rate': 420_000 + index * 13_000,
    'net.out.rate': 280_000 + index * 9_000,
    'net.total.down': 860 * GIB + index * 11 * GIB,
    'net.total.up': 540 * GIB + index * 8 * GIB,
    'traffic.down': 8 * GIB + index * 2 * GIB,
    'traffic.up': 5 * GIB + index * GIB,
    'process.count': 86 + index % 9,
    'connections.tcp': 220 + index * 2,
    'connections.udp': 12 + index % 4,
    'gpu.usage': 0,
    'gpu.device.usage': 0,
    'gpu.memory.used': 0,
    'gpu.memory.total': 0,
    'gpu.temperature': 0,
    'ping.latency_ms': 88 + Math.sin(index / 3) * 15,
    'ping.loss': index % 13 === 0 ? 0.08 : 0.015,
  }
  return values[key] ?? 0
}

function buildMetricResponse(
  payload: Record<string, unknown>,
  options: VisualFixtureOptions,
  pingTasks: Array<{ id: number, name: string }>,
) {
  const requested = Array.isArray(payload.metric_keys) ? payload.metric_keys.map(String) : METRIC_KEYS
  const entityIds = Array.isArray(payload.entity_ids)
    ? payload.entity_ids.map(String)
    : [typeof payload.entity_id === 'string' ? payload.entity_id : uuidFor(0)]
  if (options.carrierRecentOutcome && payload.downsample === false) {
    const outcome = options.carrierRecentOutcome
    const series = entityIds.flatMap(entity_id => pingTasks.flatMap(task => requested.map(metric_key => ({
      entity_id,
      metric_key,
      downsampled: false,
      tags: { task_id: String(task.id) },
      points: outcome === 'insufficient'
        ? []
        : Array.from({ length: 3 }, (_, index) => ({
            time: new Date(Date.parse(FIXED_NOW) - (outcome === 'stale' ? 300_000 : 1000) - (2 - index) * 60_000).toISOString(),
            value: metric_key === 'ping.loss' ? (outcome === 'failed' ? 1 : 0) : outcome === 'failed' ? -1 : 50,
            count: 1,
          })),
    }))))
    return { start: payload.start, end: FIXED_NOW, series, count: series.length }
  }
  if (options.carrierRawSamples && payload.downsample === false) {
    const start = Date.parse(String(payload.start))
    const end = Date.parse(FIXED_NOW)
    const series = entityIds.flatMap(entity_id => pingTasks.flatMap(task => requested.map(metric_key => ({
      entity_id,
      metric_key,
      type: 'gauge',
      downsampled: false,
      tags: { task_id: String(task.id), task_name: task.name },
      points: Array.from({ length: 5 }, (_, index) => ({ time: new Date(Math.max(start, end - 120_000) + index).toISOString(), value: metric_key === 'ping.loss' ? 0 : 15, count: 1 })),
    }))))
    return { start: payload.start, end: FIXED_NOW, series, count: series.length }
  }
  const insightHours = Number(payload.hours)
  const detailedInsightWindow = options.opsTopologyInsights
    && Number(payload.max_points) === 240
    && (insightHours === 24 || insightHours === 168)
    && requested.every(key => key.startsWith('ping.'))
  const pointCount = detailedInsightWindow ? insightHours : 48
  const pointInterval = detailedInsightWindow ? 60 * 60 * 1000 : 75_000
  const points = Array.from({ length: pointCount }, (_, index) => ({
    time: new Date(Date.parse(FIXED_NOW) - (pointCount - 1 - index) * pointInterval).toISOString(),
    index,
  }))
  const metricPingTasks = options.pingTaskOrdering
    ? [pingTasks[2]!, pingTasks[0]!, pingTasks[1]!]
    : pingTasks
  const series = entityIds.flatMap(uuid => requested
    .filter(key => !options.missingCpuMetricHistory || key !== 'cpu.usage')
    .flatMap((key) => {
      const taskList = key.startsWith('ping.') ? metricPingTasks : [null]
      return taskList.map(task => ({
        metric_key: key,
        entity_id: uuid,
        type: 'gauge',
        tags: task ? { task_id: String(task.id), task_name: task.name } : {},
        points: points.map((point) => {
          const beijingHour = (new Date(point.time).getUTCHours() + 8) % 24
          const eveningPenalty = insightHours === 168 && beijingHour >= 20 && beijingHour <= 23 ? 60 : 0
          return {
            time: point.time,
            value: task?.name === 'PandaOps-Local-Hop' && key === 'ping.latency_ms'
              ? options.opsTopologyInsights && detailedInsightWindow
                ? (insightHours === 168 && point.index >= 120 ? 151 : 81) + eveningPenalty
                : 1.1 + Math.sin(point.index / 4) * 0.15
              : task?.name === 'PandaOps-Local-Hop' && key === 'ping.loss'
                ? 0
                : key === 'ping.loss'
                  ? options.carrierCommonModeLoss
                    ? task?.id === 11 && (options.carrierRecentOutcome ? point.index === 10 || point.index === 20 : point.index >= pointCount - 2) ? 1 : 0
                    : options.opsTopologyInsights ? 0 : metricValue(key, point.index)
                  : options.opsTopologyInsights && detailedInsightWindow
                    ? (insightHours === 168 && point.index >= 120 ? 150 : 80) + (task?.id ?? 0) + eveningPenalty
                    : options.opsTopologyInsights
                      ? 155 + (task?.id ?? 0)
                      : metricValue(key, point.index) + (task?.id ?? 0),
          }
        }),
      }))
    }))
  return { start: points[0].time, end: points.at(-1)?.time, series, count: series.length }
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleRpc(
  route: Route,
  clientFixtures = clients,
  statusFixtures = statuses,
  options: VisualFixtureOptions = {},
  adminPingTasks: Array<Record<string, unknown>> = [],
): Promise<void> {
  const payload = route.request().postDataJSON() as { id: unknown, method: string, params?: Record<string, unknown> }
  const uuid = typeof payload.params?.uuid === 'string'
    ? payload.params.uuid
    : typeof payload.params?.entity_id === 'string'
      ? payload.params.entity_id
      : uuidFor(0)
  if ((options.quickTopologyTaskFailure || options.opsLegacyPingFallback)
    && (payload.method === 'public:getPublicPingTasks'
      || payload.method === 'public:getPingMetricStats'
      || payload.method === 'admin:getAllPingTasks')) {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(jsonRpcError(payload.id, -32000, 'visual Ping task failure')),
    })
    return
  }
  if (options.opsMetricDelayMs && (payload.method === 'public:queryMetrics' || payload.method === 'public:getPingMetricStats'))
    await new Promise(resolve => setTimeout(resolve, options.opsMetricDelayMs))
  if (options.quickTopologyTaskDelayMs && payload.method === 'admin:getAllPingTasks')
    await new Promise(resolve => setTimeout(resolve, options.quickTopologyTaskDelayMs))
  const pingTasks = options.pingTaskOrdering
    ? [
        { id: 30, name: '浙江移动', interval: 60, loss: 0, weight: 0 },
        { id: 10, name: '浙江联通', interval: 60, loss: 0, weight: 1 },
        { id: 20, name: '浙江电信', interval: 60, loss: 0, weight: 2 },
      ]
    : options.opsDashboard
      ? [
          { id: 1, name: 'Tokyo', interval: 60, loss: 3.2, weight: 1 },
          { id: 11, name: '北京联通', type: options.carrierProbeType ?? 'tcp', interval: 60, loss: 0, weight: 2 },
          { id: 12, name: '北京电信', type: options.carrierProbeType ?? 'tcp', interval: 60, loss: 0, weight: 3 },
          { id: 13, name: '北京移动', type: options.carrierProbeType ?? 'tcp', interval: 60, loss: 0, weight: 4 },
          { id: 18, name: 'PandaOps-Local-Hop', interval: 30, loss: 0, weight: 5 },
        ]
      : [{ id: 1, name: 'Tokyo', interval: 60, loss: 3.2, weight: 1 }]
  if (options.opsNoRecentTask) {
    pingTasks.push({
      id: 99,
      name: 'Configured-No-Recent-Sample',
      interval: 30,
      loss: 0,
      weight: 99,
      all_clients: true,
      clients: [uuidFor(2)],
    })
  }
  if (options.opsOverlappingTask) {
    pingTasks.push({
      id: 112,
      name: '北京电信-备用',
      interval: 60,
      loss: 0,
      weight: 112,
      clients: [uuid],
    })
  }
  if (options.opsCustomFirstMetric || options.opsKnownEntryCustomTask) {
    pingTasks.push({
      id: 77,
      name: 'Relay-JP-to-Exit-US',
      interval: 60,
      loss: 0,
      weight: 77,
      clients: [uuid],
    })
  }
  if (options.quickTopologyCustomTask) {
    pingTasks.push({
      id: 88,
      name: 'Relay-Custom-Hop',
      interval: 60,
      loss: 0,
      weight: 88,
      clients: [uuidFor(0)],
    })
  }
  if (options.quickTopologyPresetConflict) {
    pingTasks.push({
      id: 89,
      name: '北京电信',
      interval: 60,
      loss: 0,
      weight: 89,
      clients: [uuidFor(0)],
    })
  }
  const metricPingTasks = options.pingTaskOrdering
    ? [pingTasks[2]!, pingTasks[0]!, pingTasks[1]!]
    : pingTasks
  const pingRecords = pingTasks.flatMap(task => Array.from({ length: 48 }, (_, index) => ({
    task_id: task.id,
    client: uuid,
    time: new Date(Date.parse(FIXED_NOW) - (47 - index) * 75_000).toISOString(),
    value: options.opsSevereLoss && task.name === '北京电信'
      ? -1
      : options.opsExtremeLatency && task.name === '北京电信'
        ? 5_000
        : uuid !== uuidFor(1) && index % 17 === 0
          ? -1
          : options.nodeCardWorstCase
            ? 9_876 + index * 13 + task.id
            : task.name === 'PandaOps-Local-Hop'
              ? 1.1 + Math.sin(index / 4) * 0.15
              : 76 + index + task.id,
  })))
  let result: unknown

  if (payload.method === 'admin:orderClients' && options.orderSaveFailure) {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(jsonRpcError(payload.id, -32000, 'visual order save failed')),
    })
    return
  }

  switch (payload.method) {
    case 'rpc.ping':
      result = 'pong'
      break
    // 远程执行只在明确开启时才应答。别的用例里保持「未实现」，这样任何一处
    // 意外触发采集都会当场失败，而不是被一个万能 mock 悄悄吃掉。
    case 'admin:exec':
      if (!options.routeProbeExec)
        break
      routeProbeExecCalls.push({
        command: String(payload.params?.command ?? ''),
        clients: Array.isArray(payload.params?.clients) ? payload.params.clients.map(String) : [],
      })
      result = { task_id: 'visual-route-task', clients: payload.params?.clients ?? [], queued_clients: [] }
      break
    case 'admin:getTaskResultsByTaskId':
      if (!options.routeProbeExec)
        break
      result = (routeProbeExecCalls.at(-1)?.clients ?? []).map((client) => {
        const probeResult = options.routeProbeResult ?? 'success'
        return {
          client,
          result: probeResult === 'remote-disabled'
            ? 'Remote control is disabled.'
            : probeResult === 'missing-traceroute'
              ? '__TRANSIT_ROUTE_NO_TRACEROUTE__'
              : VISUAL_TRACE_OUTPUT,
          exit_code: probeResult === 'remote-disabled' ? -1 : 0,
          finished_at: FIXED_NOW,
          created_at: FIXED_NOW,
        }
      })
      break
    case 'admin:editClient':
      if (options.routeProbeEditFailure) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(jsonRpcError(payload.id, -32000, '模拟旧标签清理失败')),
        })
        return
      }
      routeProbeEdits.push({
        uuid: String(payload.params?.uuid ?? ''),
        tags: String(payload.params?.tags ?? ''),
      })
      // Komari 的 Go 端成功写入后返回 nil，JSON 通过 omitempty 不包含 result。
      // 这里刻意复现生产响应，避免「实际已写回、界面却报探测失败」回归。
      result = undefined
      break
    case 'common:getNodes':
      if (options.routeProbeConcurrentTag && routeProbeExecCalls.length) {
        const latestClients = structuredClone(clientFixtures)
        const latestNode = latestClients[uuidFor(0)]!
        latestNode.tags = `${latestNode.tags};${options.routeProbeConcurrentTag}`
        result = latestClients
      }
      else {
        result = clientFixtures
      }
      break
    case 'common:getNodesLatestStatus':
      result = statusFixtures
      break
    case 'admin:listPlugins':
      result = []
      break
    case 'common:getNodeRecentStatus':
      result = { count: 48, records: buildRecords(uuid) }
      break
    case 'common:getRecords':
      result = payload.params?.type === 'ping'
        ? { count: 48, records: pingRecords, tasks: pingTasks }
        : { count: 48, records: buildRecords(uuid) }
      break
    case 'public:getClientRecentRecords':
      result = buildRecords(uuid)
      break
    case 'public:getRecordsByUUID':
      result = { count: 48, records: buildRecords(uuid), load_type: 'all', has_gpu_data: false }
      break
    case 'public:getPingRecords':
      result = { count: 48, records: pingRecords, tasks: pingTasks }
      break
    case 'public:getPublicPingTasks':
      if (options.quickTopologyTaskDelayMs)
        await new Promise(resolve => setTimeout(resolve, options.quickTopologyTaskDelayMs))
      result = pingTasks
      break
    case 'public:listMetricDefinitions':
      result = METRIC_KEYS.map(name => ({ name, description: name, type: 'gauge', retention_days: 30 }))
      break
    case 'public:queryMetrics':
      result = buildMetricResponse(payload.params ?? {}, options, options.carrierRawSamples ? adminPingTasks as Array<{ id: number, name: string }> : pingTasks)
      break
    case 'public:getPingMetricStats':
      result = options.topologyProbeStats
        ? (() => {
            const requestedEntityIds = Array.isArray(payload.params?.entity_ids)
              ? payload.params.entity_ids.map(String)
              : [uuid]
            const stats = requestedEntityIds.flatMap(entityId => options.topologyProbeStats!
              .filter(stat => !stat.entity_id || stat.entity_id === entityId)
              .map(stat => ({
                entity_id: stat.entity_id ?? entityId,
                task_id: String(stat.task_id),
                name: stat.name,
                total: stat.total,
                valid: stat.valid,
                loss: stat.valid > 0 ? 0 : 100,
                loss_approximate: false,
                avg: stat.valid > 0 ? 80 : undefined,
                latest: stat.valid > 0 ? 82 : undefined,
              })))
            return { start: FIXED_NOW, end: FIXED_NOW, interval_seconds: 60, stats, count: stats.length }
          })()
        : options.carrierCommonModeLoss
          ? (() => {
              const requestedEntityIds = Array.isArray(payload.params?.entity_ids)
                ? payload.params.entity_ids.map(String)
                : [uuid]
              const stats = requestedEntityIds.flatMap(entityId => metricPingTasks.map(task => ({
                entity_id: entityId,
                task_id: String(task.id),
                name: task.name,
                interval: task.interval,
                tags: { task_id: String(task.id), task_name: task.name },
                total: options.carrierRecentOutcome ? 61 : 48,
                valid: (options.carrierRecentOutcome ? 61 : 48) - (task.id === 11 ? 2 : 0),
                loss: task.id === 11 ? 200 / (options.carrierRecentOutcome ? 61 : 48) : 0,
                loss_approximate: false,
                avg: 80 + task.id,
                latest: 90 + task.id,
              })))
              return { start: FIXED_NOW, end: FIXED_NOW, interval_seconds: 60, stats, count: stats.length }
            })()
          : options.pingTaskOrdering || options.opsTopologyInsights
            ? {
                start: FIXED_NOW,
                end: FIXED_NOW,
                interval_seconds: 60,
                stats: metricPingTasks.map(task => ({
                  entity_id: uuid,
                  task_id: String(task.id),
                  name: task.name,
                  interval: task.interval,
                  tags: { task_id: String(task.id), task_name: task.name },
                  total: 48,
                  valid: 48,
                  loss: 0,
                  loss_approximate: false,
                  min: options.opsTopologyInsights ? 70 : 40 + task.id,
                  max: options.opsTopologyInsights ? 145 : 120 + task.id,
                  avg: options.opsTopologyInsights ? (task.name === 'PandaOps-Local-Hop' ? 105 : 125) : 80 + task.id,
                  latest: options.opsTopologyInsights ? (task.name === 'PandaOps-Local-Hop' ? 108 : 128) : 90 + task.id,
                })),
                count: metricPingTasks.length,
              }
            : { start: FIXED_NOW, end: FIXED_NOW, interval_seconds: 60, stats: [], count: 0 }
      break
    case 'public:getNodesInformation':
      result = Object.values(clientFixtures)
      break
    case 'admin:getLogs':
      result = {
        total: 2,
        logs: [
          { id: 2, ip: '198.51.100.22', uuid: uuidFor(0), message: '更新主题配置', msg_type: 'update', time: FIXED_NOW },
          { id: 1, ip: '198.51.100.10', uuid: uuidFor(0), message: '管理员登录', msg_type: 'login', time: '2026-07-25T11:50:00.000Z' },
        ],
      }
      break
    case 'admin:getAllPingTasks':
      result = adminPingTasks
      break
    case 'admin:deletePingTask': {
      const removedIds = new Set((payload.params?.id as number[] | undefined ?? []).map(Number))
      if (options.carrierMigrationDeleteFailure && removedIds.has(13)) {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(jsonRpcError(payload.id, -32000, 'visual migration cleanup failed')),
        })
        return
      }
      for (let index = adminPingTasks.length - 1; index >= 0; index--) {
        if (removedIds.has(Number(adminPingTasks[index]?.id)))
          adminPingTasks.splice(index, 1)
      }
      result = undefined
      break
    }
    case 'admin:addPingTask':
      if (options.quickTopologyMutationDelayMs)
        await new Promise(resolve => setTimeout(resolve, options.quickTopologyMutationDelayMs))
      adminPingTasks.push({
        id: Math.max(100, ...adminPingTasks.map(task => Number(task.id) || 0)) + 1,
        weight: adminPingTasks.length,
        ...(payload.params ?? {}),
      })
      result = undefined
      break
    case 'admin:editPingTask': {
      const edits = (payload.params?.tasks as Array<Record<string, unknown>> | undefined) ?? []
      for (const edit of edits) {
        const current = adminPingTasks.find(task => Number(task.id) === Number(edit.id))
        if (current)
          Object.assign(current, edit)
      }
      result = undefined
      break
    }
    case 'admin:orderClients':
      for (const [uuid, weight] of Object.entries(payload.params ?? {})) {
        const client = clientFixtures[uuid]
        if (client && typeof weight === 'number')
          client.weight = weight
      }
      // Komari's Go JSON response omits a nil result via `omitempty`.
      result = undefined
      break
    case 'public:getMe':
      result = { logged_in: false }
      break
    case 'public:getVersion':
    case 'common:getVersion':
      result = { version: '1.2.6-visual', hash: 'visual' }
      break
    case 'rpc.version':
      result = '2.0'
      break
    default:
      result = null
  }

  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(jsonRpcResult(payload.id, result)),
  })
}

/**
 * 把 fixture 里的旧格式拓扑翻成 JSON，用来构造「只有新格式」的站点。
 *
 * 刻意不从 src/ 引 serializeTopologyConfig：夹具应该独立描述期望的存储形状，
 * 否则序列化写错了，用它生成夹具的测试也会跟着一起错，等于自证。
 */
function legacyTopologyToJson(routeValue: string, metricValue: string): string {
  const routeGroups = routeValue.split('||')
  const metricGroups = metricValue.split('||')
  return JSON.stringify({
    version: 1,
    routes: routeGroups.map((group, index) => ({
      nodes: group.split(';').filter(Boolean).map((segment) => {
        const [name = '', region = '', role = '', uuid = ''] = segment.split('|').map(part => part.trim())
        return { name, ...(region ? { region } : {}), ...(role ? { role } : {}), ...(uuid ? { uuid } : {}) }
      }),
      metrics: (metricGroups[index] ?? '').split(';').filter(Boolean).map((segment) => {
        const trimmedSegment = segment.trim()
        if (!trimmedSegment.startsWith('live@')) {
          const [latency = '', loss = ''] = trimmedSegment.split(',')
          return {
            ...(latency.trim() && latency.trim() !== '-' ? { fallbackLatency: Number(latency) } : {}),
            ...(loss.trim() && loss.trim() !== '-' ? { fallbackLoss: Number(loss) } : {}),
          }
        }
        const [, source = '', task = '', latency = '', loss = ''] = trimmedSegment.split('@')
        return {
          live: true,
          source: source.trim(),
          task: task.trim(),
          ...(latency.trim() && latency.trim() !== '-' ? { fallbackLatency: Number(latency) } : {}),
          ...(loss.trim() && loss.trim() !== '-' ? { fallbackLoss: Number(loss) } : {}),
        }
      }),
    })),
  })
}

export async function installKomariFixture(page: Page, options: VisualFixtureOptions = {}): Promise<void> {
  routeProbeExecCalls = []
  routeProbeEdits = []
  routeProbeCompanionCalls = []
  routeProbeThemeSettingsSaves = []

  await page.route('**/__transit-visual-font-chinese.woff2', route => route.fulfill({
    path: VISUAL_FONT_FILES.chinese,
    contentType: 'font/woff2',
  }))
  await page.route('**/__transit-visual-font-latin.woff2', route => route.fulfill({
    path: VISUAL_FONT_FILES.latin,
    contentType: 'font/woff2',
  }))

  const nodeCount = Math.max(1, Math.floor(options.nodeCount ?? 12))
  const sourceClients = options.freePriceNode || options.expiryThresholds || options.nodeCount
    ? buildClients(options.freePriceNode, options.expiryThresholds, nodeCount)
    : clients
  const clientFixtures = structuredClone(sourceClients)
  if (options.quickTopologyNoAddress) {
    Object.assign(clientFixtures[uuidFor(1)]!, {
      ipv4: '',
      ipv6: '',
    })
  }
  if (options.returnRouteTag) {
    // 时间被冻结在 FIXED_NOW，所以采集时间也按它推算：1 小时前算新鲜，30 天前算过期；
    // unknown 故意不带时间戳。
    const ageMs = options.returnRouteTag === 'stale' ? 30 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000
    const measuredAt = Math.floor((new Date(FIXED_NOW).getTime() - ageMs) / 1000)
    const node = clientFixtures[uuidFor(options.returnRouteTagNodeIndex ?? 1)]! as Record<string, unknown>
    const stamp = options.returnRouteTag === 'unknown' ? '' : `@${measuredAt}`
    const routes = options.returnRouteTag === 'inconclusive'
      ? 'ct=4134,cu=4837,cm=58453'
      : 'ct=4809.4809.4134,cu=4837.4837,cm=58807.9808'
    node.tags = `${node.tags || ''};transit-route:${routes}${stamp}`
  }
  const statusFixtures = options.nodeCount || options.nodeCardWorstCase
    ? structuredClone(options.nodeCount ? buildStatuses(nodeCount) : statuses)
    : statuses
  const allClientUuids = Object.keys(clientFixtures)
  const adminPingTasks: Array<Record<string, unknown>> = options.quickTopologyNoTasks
    ? []
    : [
        { id: 1, weight: 0, name: 'Tokyo', clients: [uuidFor(2)], default_on: false, type: 'icmp', target: '198.51.100.1', interval: 60 },
        { id: 11, weight: 1, name: '北京联通', clients: allClientUuids, default_on: true, type: options.carrierProbeType ?? 'tcp', target: options.carrierProbeType === 'icmp' ? '198.51.100.11' : '198.51.100.11:80', interval: 60 },
        { id: 12, weight: 2, name: '北京电信', clients: allClientUuids, default_on: true, type: options.carrierProbeType ?? 'tcp', target: options.carrierProbeType === 'icmp' ? '198.51.100.12' : '198.51.100.12:80', interval: 60 },
        { id: 13, weight: 3, name: '北京移动', clients: allClientUuids, default_on: true, type: options.carrierProbeType ?? 'tcp', target: options.carrierProbeType === 'icmp' ? '198.51.100.13' : '198.51.100.13:80', interval: 60 },
        { id: 18, weight: 4, name: options.topologyGeneratedHopName ? `Transit-主控-洛杉矶-to-${REGION_FIXTURES[1].name}` : 'PandaOps-Local-Hop', clients: [uuidFor(0), uuidFor(2)], default_on: false, type: 'icmp', target: clientFixtures[uuidFor(1)]?.ipv4 ?? '192.0.2.11', interval: 30 },
      ]
  if (options.opsNoRecentTask) {
    adminPingTasks.push({ id: 99, weight: 99, name: 'Configured-No-Recent-Sample', clients: [uuidFor(2)], default_on: false, type: 'icmp', target: '198.51.100.99', interval: 30 })
  }
  if (options.quickTopologyCustomTask) {
    adminPingTasks.push({ id: 88, weight: 88, name: 'Relay-Custom-Hop', clients: [uuidFor(0)], default_on: false, type: 'icmp', target: '198.51.100.88', interval: 60 })
  }
  if (options.nodeCardWorstCase) {
    Object.assign(clientFixtures[uuidFor(0)]!, {
      name: '北京联通精品线路-日本东京-A100-超长节点名称完整展示压力测试',
      mem_total: 128 * TIB,
      disk_total: 8 * 1024 * TIB,
      price: 1_234_567.89,
      billing_cycle: 3650,
      expired_at: '2036-12-31T23:59:59.000Z',
      traffic_limit: 8 * 1024 * TIB,
    })
    Object.assign(statusFixtures[uuidFor(0)]!, {
      ram: 98.765 * TIB,
      ram_total: 128 * TIB,
      disk: 6.789 * 1024 * TIB,
      disk_total: 8 * 1024 * TIB,
      net_in: 987.654 * GIB,
      net_out: 876.543 * GIB,
      net_total_up: 3.456 * 1024 * TIB,
      net_total_down: 2.345 * 1024 * TIB,
      uptime: 3652 * 86_400,
    })
    Object.assign(clientFixtures[uuidFor(1)]!, {
      expired_at: null,
    })
  }
  if (options.quickTopologyPresetConflict) {
    Object.assign(clientFixtures[uuidFor(0)]!, {
      name: '北京电信',
    })
  }
  const defaultTopologyRoute = `北京电信|CN|入口;主控-洛杉矶|US|线路机;${options.opsMissingNode ? '未纳管-西雅图' : '香港边缘节点-超长名称布局测试'}|${options.opsMissingNode ? 'US' : 'HK'}|落地机||北京电信|CN|入口;东京-高负载|JP|线路机;${options.opsComparableRoutes ? '香港边缘节点-超长名称布局测试-10|HK' : '新加坡-A100|SG'}|落地机`
  const defaultTopologyMetrics = options.opsComparableRoutes || options.opsLiveFirstHop
    ? 'live@主控-洛杉矶@北京电信@51@0;live@主控-洛杉矶@PandaOps-Local-Hop@84@0||live@东京-高负载@Tokyo@72@0;live@东京-高负载@PandaOps-Local-Hop@1.1@0'
    : 'live@主控-洛杉矶@北京电信@51@0;84,0||live@东京-高负载@Tokyo@72@0;live@东京-高负载@PandaOps-Local-Hop@1.1@0'
  let topologyRoute = options.opsTwoNodeRoute
    ? '北京电信|CN|入口;主控-洛杉矶|US|落地机||北京电信|CN|入口;东京-高负载|JP|线路机;新加坡-A100|SG|落地机'
    : options.opsCustomFirstMetric
      ? defaultTopologyRoute.replace('北京电信|CN|入口', '北京联通家宽|CN|入口')
      : defaultTopologyRoute
  if (options.opsTopologyInsights) {
    topologyRoute = '北京电信|CN|入口;主控-洛杉矶|US|线路机;香港边缘节点-超长名称布局测试|HK|落地机||北京电信|CN|入口;香港边缘节点-超长名称布局测试|HK|线路机;主控-洛杉矶|US|落地机'
  }
  if (options.opsTrailingEmptyNode) {
    const [firstRoute = '', ...remainingRoutes] = topologyRoute.split('||')
    topologyRoute = `${firstRoute.split(';').slice(0, 2).join(';')};||${remainingRoutes.join('||')}`
  }

  let topologyMetrics = options.opsStaticFirstMetric
    ? defaultTopologyMetrics.replace(FIRST_TOPOLOGY_METRIC_PATTERN, '51,0')
    : options.opsCustomFirstMetric || options.opsKnownEntryCustomTask
      ? defaultTopologyMetrics.replace(FIRST_TOPOLOGY_METRIC_PATTERN, 'live@主控-洛杉矶@Relay-JP-to-Exit-US@72@0')
      : options.opsTwoNodeRoute
        ? `51,0||${defaultTopologyMetrics.split('||')[1] ?? ''}`
        : defaultTopologyMetrics
  if (options.opsTopologyInsights) {
    topologyMetrics = 'live@主控-洛杉矶@北京电信@51@0;live@主控-洛杉矶@PandaOps-Local-Hop@84@0||live@香港边缘节点-超长名称布局测试@北京电信@51@0;live@香港边缘节点-超长名称布局测试@PandaOps-Local-Hop@84@0'
  }
  if (options.opsExternalOfflineSource)
    topologyMetrics = topologyMetrics.replace('live@主控-洛杉矶@北京电信', 'live@伦敦-离线归档@北京电信')
  if (options.opsMissingPingSource)
    topologyMetrics = topologyMetrics.replace('live@主控-洛杉矶@北京电信', 'live@已删除-线路机@北京电信')

  let settings: Record<string, unknown> = {
    alertEnabled: options.announcementEscaping ?? false,
    alertTitle: options.announcementEscaping ? '状态公告' : '',
    alertContent: options.announcementEscaping ? 'Status <green> & healthy' : '',
    themeMode: options.dark ? 'dark' : 'light',
    dataUpdateInterval: 60,
    rpcTransportMode: 'http',
    defaultViewMode: options.viewMode ?? 'card',
    nodeCardSize: options.nodeCardSize ?? 'compact',
    earthRenderer: options.earthRenderer ?? 'realistic',
    hideEarth: options.hideEarth ?? false,
    stopEarth: true,
    visitorInfoEnabled: options.visitorInfoEnabled ?? true,
    visitorAuditClientEnabled: options.visitorAuditClientEnabled ?? true,
    colorVisionMode: options.colorVisionFriendly ? '色觉友好' : '标准',
    hideAdminEntryWhenLoggedOut: false,
    hidePriceWhenLoggedOut: options.hidePriceWhenLoggedOut ?? false,
    disablePageAnimation: true,
    homeQuickControlsEnabled: true,
    homeQuickControlPreset: '完整',
    homeToolsEnabled: true,
    opsDashboardEnabled: options.opsDashboard ?? false,
    topologyEnabled: options.opsDashboard ?? false,
    topologyAutoRepairEnabled: options.topologyAutoRepairEnabled ?? true,
    carrierPingRegion: 'all',
    routeProbeEnabled: options.routeProbeEnabled,
    routeProbeAutoEnabled: options.routeProbeLegacyAutoEnabled,
    nodeCardPanels: options.nodeCardPanels ? JSON.stringify(options.nodeCardPanels) : undefined,
    topologyRoute: options.opsDashboard && !options.emptyTopology && !options.opsJsonTopologyOnly
      ? topologyRoute
      : '',
    topologyMetrics: options.opsDashboard && !options.emptyTopology && !options.opsJsonTopologyOnly
      ? topologyMetrics
      : '',
    topologyConfig: options.opsDashboard && !options.emptyTopology && options.opsJsonTopologyOnly
      ? legacyTopologyToJson(topologyRoute, topologyMetrics)
      : '',
  }
  if (options.opsAutoFirstMetric && typeof settings.topologyConfig === 'string' && settings.topologyConfig) {
    const config = JSON.parse(settings.topologyConfig) as { routes?: Array<{ metrics?: Array<Record<string, unknown>> }> }
    const metric = config.routes?.[0]?.metrics?.[0]
    if (metric) {
      metric.probeMode = 'auto'
      metric.live = false
      delete metric.source
      delete metric.task
    }
    settings.topologyConfig = JSON.stringify(config)
  }

  await page.addInitScript(({ fixedNow, dark, setupWizardFirstRun, movingClock, preserveJournal }) => {
    const journals = preserveJournal ? Object.entries(localStorage).filter(([key]) => key.startsWith('transit:carrier-operation:v1:')) : []
    localStorage.clear()
    journals.forEach(([key, value]) => localStorage.setItem(key, value))
    sessionStorage.clear()
    localStorage.setItem('appearance', dark ? 'dark' : 'light')
    localStorage.setItem('color', 'green')
    if (!setupWizardFirstRun)
      localStorage.setItem('transit:setup-wizard-dismissed', '1')
    const NativeDate = Date
    const reference = performance.now()
    class FixedDate extends NativeDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(args.length ? args[0] : FixedDate.now())
      }

      static now() {
        return new NativeDate(fixedNow).getTime() + (movingClock ? Math.floor(performance.now() - reference) : 0)
      }
    }
    window.Date = FixedDate as DateConstructor
  }, { fixedNow: FIXED_NOW, dark: options.dark ?? false, setupWizardFirstRun: options.setupWizardFirstRun ?? false, movingClock: options.carrierRawSamples ?? false, preserveJournal: options.preserveOperationJournal ?? false })

  await page.route('**/api/public', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      message: 'ok',
      data: {
        allow_cors: true,
        custom_body: '',
        custom_head: '',
        description: '固定虚构节点视觉回归环境',
        disable_password_login: false,
        oauth_enable: false,
        oauth_provider: null,
        private_site: false,
        record_enabled: true,
        record_preserve_time: 720,
        ping_record_preserve_time: 720,
        sitename: 'Komari Visual Lab',
        theme: options.opsDashboard ? 'Transit' : 'Glassmorphism',
        theme_settings: structuredClone(settings),
        ...(options.visitorAuditSupported ? { visitor_audit_enabled: false } : {}),
      },
    }),
  }))
  let meRequestCount = 0
  await page.route('**/api/me', (route) => {
    meRequestCount += 1
    const authenticated = Boolean(options.authenticated && !(options.authenticationExpires && meRequestCount > 1))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ logged_in: authenticated, username: authenticated ? 'visual-admin' : 'visual-guest' }),
    })
  })
  await page.route('**/api/admin/settings', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      message: 'ok',
      data: {
        sitename: 'Komari Visual Lab',
        description: '固定虚构节点视觉回归环境',
        eula_accepted: true,
        auto_discovery_key: 'VISUAL-TEST-AUTO-DISCOVERY-KEY',
        geo_ip_enabled: true,
        geo_ip_provider: 'mmdb',
        cors_origin_check_enabled: true,
      },
    }),
  }))
  await page.route('**/api/admin/database/size', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', data: { main: { size: 12 * 1024 ** 2 }, monitoring: { size: 486 * 1024 ** 2 } } }),
  }))
  await page.route('**/api/admin/theme/settings?theme=*', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown> | null
    if (options.themeSaveDelayMs)
      await new Promise(resolve => setTimeout(resolve, options.themeSaveDelayMs))
    if (body && Object.hasOwn(body, 'pandaOpsRouteProbeResults') && options.routeProbeThemeSaveFailure) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: '模拟主题数据保存失败' }),
      })
    }
    if (body)
      settings = structuredClone(body)
    if (body && Object.hasOwn(body, 'pandaOpsRouteProbeResults'))
      routeProbeThemeSettingsSaves.push(structuredClone(body))
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', message: 'ok' }),
    })
  })
  await page.route('**/api/admin/theme/config?short=*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', message: 'legacy ok' }),
  }))
  await page.route('**/api/version', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', message: 'ok', data: { version: '1.2.6-visual', hash: 'visual' } }),
  }))
  await page.route('**/api/transit-route-probe/v1/**', async (route) => {
    if (!options.routeProbeCompanion) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not installed"}' })
      return
    }
    const request = route.request()
    const url = new URL(request.url())
    const guard = request.headers()['x-transit-route-probe']
    if (url.pathname.endsWith('/health')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, protocol: 1, version: '1.1.4-visual', ...(options.routeProbeStorageDegraded ? { storage: { status: 'degraded', last_success_at: null, last_error: 'permission-denied', recovered_from_corrupt: false } } : {}) }),
      })
      return
    }
    if (url.pathname.endsWith('/roster')) {
      if (options.routeProbeRosterFails) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal error"}' })
        return
      }
      const missing = new Set(options.routeProbeMissingHelperUuids ?? [])
      const clients = (url.searchParams.get('clients') ?? '').split(',').filter(Boolean)
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          clients: clients.map(client => ({
            client,
            helper_seen_at: missing.has(client) ? null : Date.parse(FIXED_NOW),
            helper_version: missing.has(client) ? null : client.endsWith('000000000001') ? '1.3.12' : '1.4.0',
            last_job_at: missing.has(client) ? null : Date.parse(FIXED_NOW) - 60_000,
            last_success_at: missing.has(client) ? null : Date.parse(FIXED_NOW) - 30_000,
            last_error: null,
            last_duration_ms: missing.has(client) ? null : 1234,
          })),
        }),
      })
      return
    }
    if (url.pathname.endsWith('/enqueue')) {
      const body = request.postDataJSON() as { clients?: unknown, city?: unknown }
      const clients = Array.isArray(body.clients) ? body.clients.map(String) : []
      const city = String(body.city ?? '')
      routeProbeCompanionCalls.push({ clients, city, guard })
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          batch_id: 'b_visualcompanion0001',
          jobs: clients.map(client => ({
            client,
            city,
            status: 'queued',
            tag: null,
            error: null,
            attempts: 0,
            helper_seen_at: Date.parse(FIXED_NOW),
          })),
        }),
      })
      return
    }
    const clients = routeProbeCompanionCalls.at(-1)?.clients ?? []
    const city = routeProbeCompanionCalls.at(-1)?.city ?? 'beijing'
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        batch_id: 'b_visualcompanion0001',
        jobs: clients.map(client => ({
          client,
          city,
          status: 'completed',
          tag: `transit-route:ct=4809.4809.4134,cu=4837.4837,cm=58807.9808@${Math.floor(Date.parse(FIXED_NOW) / 1000)}`,
          error: null,
          attempts: 1,
          helper_seen_at: Date.parse(FIXED_NOW),
        })),
      }),
    })
  })
  await page.route('**/rpc2', route => handleRpc(route, clientFixtures, statusFixtures, options, adminPingTasks))
  for (const pattern of [
    'https://api.ip.sb/geoip/**',
    'https://ipinfo.io/**/json',
    'https://ipwho.is/**',
    'https://ipapi.co/**/json/',
  ]) {
    await page.route(pattern, route => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{}',
    }))
  }
  await page.route('https://ipwho.is/', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ success: true, ip: '2001:db8::25', city: 'Tokyo', region: 'Tokyo', country: 'Japan', connection: { org: 'Example Networks' } }),
  }))
  await page.route('https://open.er-api.com/v6/latest/CNY', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      rates: {
        CNY: 1,
        USD: 0.142536,
        HKD: 1.108377,
        EUR: 0.12102,
        GBP: 0.105581,
        JPY: 22.231552,
        RUB: 13.5,
        CHF: 0.12,
        INR: 11.8,
        VND: 3500,
        THB: 5,
        CAD: 0.19,
      },
    }),
  }))
}
