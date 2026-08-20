/**
 * Komari RPC2 的线上数据结构。
 *
 * 单独成文件的理由很直白：这些接口占了原 rpc.ts 的三分之一，而它们几乎不变，
 * 夹在传输层和方法门面中间只会让后两者难找。对外仍从 `@/utils/rpc` 引用。
 *
 * @see https://www.komari.wiki/dev/rpc.html
 */

/** JSON-RPC 2.0 请求结构 */
export interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown> | unknown[]
  id: number | string
}

/** JSON-RPC 2.0 成功响应 */
export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: '2.0'
  result: T
  id: number | string
}

/** JSON-RPC 2.0 错误响应 */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  error: {
    code: number
    message: string
    data?: unknown
  }
  id: number | string | null
}

/** JSON-RPC 2.0 响应 */
export type JsonRpcResponse<T = unknown> = JsonRpcSuccessResponse<T> | JsonRpcErrorResponse

/** RPC 方法元数据 */
export interface MethodMeta {
  name: string
  summary: string
  description: string
  params: ParamMeta[]
  returns: string
}

/** 参数元数据 */
export interface ParamMeta {
  name: string
  type: string
  description: string
}

/** 节点客户端信息 */
export interface Client {
  uuid: string
  token?: string
  name: string
  cpu_name: string
  virtualization: string
  arch: string
  cpu_cores: number
  cpu_physical_cores?: number
  os: string
  kernel_version: string
  gpu_name?: string
  ipv4?: string
  ipv6?: string
  region: string
  remark?: string
  public_remark: string
  mem_total: number
  swap_total: number
  disk_total: number
  version?: string
  weight: number
  price: number
  billing_cycle: number
  auto_renewal: boolean
  currency: string
  expired_at: string | null
  group: string
  tags: string
  hidden: boolean
  traffic_limit: number
  traffic_limit_type: string
  created_at: string
  updated_at: string
}

/** 公开站点信息 */
export interface PublicInfo {
  allow_cors: boolean
  custom_body: string
  custom_head: string
  description: string
  disable_password_login: boolean
  oauth_enable: boolean
  oauth_provider: string
  ping_record_preserve_time?: number
  private_site: boolean
  record_enabled?: boolean
  record_preserve_time?: number
  sitename: string
  theme: string
  theme_settings: Record<string, unknown>
  visitor_audit_enabled?: boolean
}

/** 版本信息 */
export interface VersionInfo {
  version: string
  hash: string
}

/**
 * 单个 Ping 任务的最新探测汇总
 * 注意：该字段在 getNodesLatestStatus 响应中实际存在，但官方文档与旧类型定义遗漏，键为 task_id 字符串
 */
export interface NodeStatusPing {
  name: string
  /** 最新探测延迟（毫秒）；<0 表示丢包，与 PingRecord.value === -1 同义 */
  latest: number
  avg: number
  tail: number
  /** 丢包率（%） */
  loss: number
  min: number
  max: number
}

export interface GpuDetailedInfo {
  name?: string
  device_name?: string
  device_index?: number
  memory_total?: number
  memory_used?: number
  utilization?: number
  usage?: number
  temperature?: number
}

/** 节点状态 */
export interface NodeStatus {
  client: string
  time: string
  cpu: number
  gpu: number
  gpu_count?: number
  gpu_average_usage?: number
  gpu_detailed_info?: GpuDetailedInfo[]
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  traffic_up?: number
  traffic_down?: number
  process: number
  connections: number
  connections_udp: number
  online: boolean
  uptime: number
  message?: string
  updated_at?: string
  /** 各 Ping 任务最新探测汇总，键为 task_id 字符串 */
  ping?: Record<string, NodeStatusPing>
}

/** 状态记录 */
export interface StatusRecord {
  client: string
  time: string
  cpu: number
  gpu: number
  gpu_count?: number
  gpu_average_usage?: number
  gpu_detailed_info?: GpuDetailedInfo[]
  ram: number
  ram_total: number
  swap: number
  swap_total: number
  load: number
  load5: number
  load15: number
  temp: number
  disk: number
  disk_total: number
  net_in: number
  net_out: number
  net_total_up: number
  net_total_down: number
  traffic_up?: number
  traffic_down?: number
  process: number
  connections: number
  connections_udp: number
}

/** Ping 记录 */
export interface PingRecord {
  client: string
  task_id: number
  time: string
  value: number
}

/** Ping 任务摘要 */
export interface PingTaskInfo {
  id: number
  weight?: number
  name: string
  interval: number
  loss: number
  all_clients?: boolean
  default_on?: boolean
  clients?: string[]
  p99?: number
  p50?: number
  p99_p50_ratio?: number
  min?: number
  max?: number
  avg?: number
  latest?: number
  total?: number
  valid?: number
  stddev?: number
  loss_approximate?: boolean
  type?: string
  target?: string
}

export interface PingTaskMutation {
  [key: string]: unknown
  clients: string[]
  default_on: boolean
  name: string
  target: string
  type: 'icmp' | 'tcp' | 'http' | string
  interval: number
}

export interface AuditLogEntry {
  id: number
  ip: string
  uuid: string
  message: string
  msg_type: string
  time: string
}

export interface AuditLogsResponse {
  logs: AuditLogEntry[]
  total: number
}

export interface VisitorAuditEventParams extends Record<string, unknown> {
  event: string
  path?: string
  route?: string
  target?: string
  detail?: Record<string, unknown>
}

export interface VisitorAuditEventResponse {
  status: 'success' | 'disabled' | 'rate_limited' | string
}

export interface MetricDefinition {
  name: string
  description: string | Record<string, string>
  type: string
  unit?: string
  retention_days: number
  metadata?: Record<string, string>
  created_at?: string
  updated_at?: string
}

export interface MetricPoint {
  time: string
  value: number | null
  count?: number
  /** @deprecated Komari 1.2.x compatibility alias; prefer tags. */
  tag?: Record<string, unknown>
  tags?: Record<string, unknown>
  labels?: Record<string, unknown>
}

export interface MetricSeries {
  metric_key: string
  entity_id: string
  type?: string
  unit?: string
  retention_days?: number
  /** @deprecated Komari 1.2.x compatibility alias; prefer tags. */
  tag?: Record<string, unknown>
  tags?: Record<string, unknown>
  downsampled: boolean
  downsample_algorithm?: string
  fill_empty?: boolean
  max_points?: number
  interval_seconds?: number
  count: number
  points: MetricPoint[]
}

export interface MetricQueryParams {
  [key: string]: unknown
  metric_key?: string
  metric_keys?: string[]
  metrics?: string[]
  entity_id?: string
  entity_ids?: string[]
  start?: string | number
  start_time?: string | number
  end?: string | number
  end_time?: string | number
  hours?: number
  tags?: Record<string, unknown>
  downsample?: boolean
  server_downsample?: boolean
  downsample_by_metric?: Record<string, boolean>
  server_downsample_by_metric?: Record<string, boolean>
  fill_empty?: boolean
  max_points?: number
  downsample_points?: number
  max_points_by_metric?: Record<string, number>
  points_by_metric?: Record<string, number>
  aggregation?: string
  downsample_algorithm?: string
  algorithm?: string
  aggregation_by_metric?: Record<string, string>
  downsample_algorithm_by_metric?: Record<string, string>
  algorithm_by_metric?: Record<string, string>
}

export interface MetricQueryResponse {
  start: string
  end: string
  server_downsample_default?: boolean
  default_points?: number
  series: MetricSeries[]
  count: number
}

export interface PingMetricStatsParams {
  [key: string]: unknown
  uuid?: string
  entity_id?: string
  entity_ids?: string[]
  task_id?: string | number
  task_ids?: Array<string | number>
  start?: string | number
  start_time?: string | number
  end?: string | number
  end_time?: string | number
  hours?: number
  max_points?: number
  downsample_points?: number
}

export interface PingMetricTaskStats {
  entity_id: string
  task_id: string
  name?: string
  type?: string
  interval?: number
  tags: Record<string, unknown>
  total: number
  valid: number
  loss: number
  loss_approximate: boolean
  min?: number
  max?: number
  avg?: number
  latest?: number
  p50?: number
  p99?: number
  stddev?: number
  p99_p50_ratio?: number
}

export interface PingMetricStatsResponse {
  start: string
  end: string
  interval_seconds: number
  stats: PingMetricTaskStats[]
  count: number
}
