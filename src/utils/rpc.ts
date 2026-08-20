import type { RpcClientOptions } from '@/utils/rpcClient'
import type { AuditLogsResponse, Client, MethodMeta, MetricDefinition, MetricQueryParams, MetricQueryResponse, NodeStatus, PingMetricStatsParams, PingMetricStatsResponse, PingRecord, PingTaskInfo, PingTaskMutation, PublicInfo, StatusRecord, VersionInfo, VisitorAuditEventParams, VisitorAuditEventResponse } from '@/utils/rpcTypes'
import { RpcClient } from '@/utils/rpcClient'

/**
 * Komari RPC2 的方法门面，以及整个应用共用的实例。
 *
 * 传输层在 `@/utils/rpcClient`，线上数据结构在 `@/utils/rpcTypes`。两者都从这里
 * 再导出——调用方谈的是「RPC」，不该被迫记住某个类型落在哪个内部文件；这和
 * topologyHelper 那种什么都能拿到的桶不同，这里转发的是同一套 RPC 公开接口。
 *
 * @see https://www.komari.wiki/dev/rpc.html
 */

export { isRpcPermissionError, RpcClient, RpcError } from '@/utils/rpcClient'
export type { RpcClientOptions } from '@/utils/rpcClient'
export * from '@/utils/rpcTypes'

/**
 * Komari RPC 高级封装
 * 提供常用的 Komari API 方法
 */
export class KomariRpc {
  private client: RpcClient

  constructor(options: RpcClientOptions = {}) {
    this.client = new RpcClient(options)
  }

  /**
   * 获取底层 RpcClient 实例
   */
  getClient(): RpcClient {
    return this.client
  }

  // ==================== 内置方法 ====================

  /**
   * 获取所有可用方法
   */
  async getMethods(internal = false): Promise<string[]> {
    return this.client.call<string[]>('rpc.methods', { internal })
  }

  /**
   * 获取帮助信息
   */
  async getHelp(): Promise<MethodMeta[]>
  async getHelp(method: string): Promise<MethodMeta>
  async getHelp(method?: string): Promise<MethodMeta[] | MethodMeta> {
    return this.client.call<MethodMeta[] | MethodMeta>('rpc.help', method ? { method } : undefined)
  }

  /**
   * Ping 测试
   */
  async ping(signal?: AbortSignal): Promise<string> {
    return this.client.call<string>('rpc.ping', undefined, signal)
  }

  /**
   * 获取版本信息
   */
  async getVersion(): Promise<string> {
    return this.client.call<string>('rpc.version')
  }

  // ==================== 通用方法 ====================

  /**
   * 获取所有节点信息
   */
  async getNodes(): Promise<Record<string, Client>> {
    return this.client.call<Record<string, Client>>('common:getNodes')
  }

  async getNodesOverHttp(signal?: AbortSignal): Promise<Record<string, Client>> {
    return this.client.callOverHttp<Record<string, Client>>('common:getNodes', undefined, signal)
  }

  /**
   * 获取所有节点最新状态
   */
  async getNodesLatestStatus(): Promise<Record<string, NodeStatus>> {
    return this.client.call<Record<string, NodeStatus>>('common:getNodesLatestStatus')
  }

  /**
   * 获取节点最近状态记录
   */
  async getNodeRecentStatus(uuid: string, limit?: number, signal?: AbortSignal): Promise<{ count: number, records: StatusRecord[] }> {
    return this.client.call<{ count: number, records: StatusRecord[] }>('common:getNodeRecentStatus', { uuid, limit }, signal)
  }

  /**
   * 获取公开的站点信息
   */
  async getPublicInfo(): Promise<PublicInfo> {
    return this.client.call<PublicInfo>('common:getPublicInfo')
  }

  /**
   * 获取后端版本
   */
  async getBackendVersion(): Promise<VersionInfo> {
    return this.client.call<VersionInfo>('common:getVersion')
  }

  // ==================== 历史记录方法 ====================

  /**
   * 获取历史记录（通用方法）
   */
  async getRecords(params: {
    type: 'load' | 'ping'
    uuid?: string
    hours?: number
    task_id?: number
    load_type?: string
    maxCount?: number
    max_count?: number
  }): Promise<unknown> {
    return this.client.call('common:getRecords', params)
  }

  /**
   * 获取负载记录
   */
  async getLoadRecords(uuid?: string, hours?: number, loadType?: string, maxCount?: number, signal?: AbortSignal): Promise<{ records: StatusRecord[] | Record<string, StatusRecord[]> }> {
    return this.client.call<{ records: StatusRecord[] | Record<string, StatusRecord[]> }>('common:getRecords', {
      type: 'load',
      uuid,
      hours,
      load_type: loadType,
      maxCount,
      max_count: maxCount,
    }, signal)
  }

  /**
   * 获取 Ping 记录
   */
  async getPingRecords(taskId?: number, hours?: number, maxCount?: number, signal?: AbortSignal, uuid?: string): Promise<{ records: PingRecord[], tasks?: PingTaskInfo[], basic_info?: Array<{ client: string, loss: number, min: number, max: number }> }> {
    return this.client.call<{ records: PingRecord[], tasks?: PingTaskInfo[], basic_info?: Array<{ client: string, loss: number, min: number, max: number }> }>('common:getRecords', {
      type: 'ping',
      uuid,
      task_id: taskId,
      hours,
      maxCount,
      max_count: maxCount,
    }, signal)
  }

  // ==================== Admin 方法（需登录权限） ====================

  async getAuditLogs(limit?: string, page?: string, msgType?: string, signal?: AbortSignal): Promise<AuditLogsResponse> {
    return this.client.callOverHttp<AuditLogsResponse>('admin:getLogs', { limit, page, msg_type: msgType }, signal)
  }

  async updateAdminSettings(settings: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    await this.client.callOverHttp('admin:editSettings', settings, signal)
  }

  async orderClients(order: Record<string, number>, signal?: AbortSignal): Promise<void> {
    await this.client.callOverHttp('admin:orderClients', order, signal)
  }

  async getAllPingTasks(signal?: AbortSignal): Promise<PingTaskInfo[]> {
    return this.client.callOverHttp<PingTaskInfo[]>('admin:getAllPingTasks', undefined, signal)
  }

  async addPingTask(task: PingTaskMutation, signal?: AbortSignal): Promise<void> {
    await this.client.callOverHttp('admin:addPingTask', task, signal)
  }

  /** 批量更新 Ping 任务。Komari 用这个接口改 clients 列表，没有单独的“加一台机器”。 */
  async editPingTasks(tasks: PingTaskMutation[], signal?: AbortSignal): Promise<void> {
    await this.client.callOverHttp('admin:editPingTask', { tasks }, signal)
  }

  /** 删除 Ping 任务；Komari 会连带清掉这些任务的历史采样。 */
  async deletePingTasks(ids: number[], signal?: AbortSignal): Promise<void> {
    await this.client.callOverHttp('admin:deletePingTask', { id: ids }, signal)
  }

  // ==================== Public 方法（主题/公开页优先使用） ====================

  async getPublicMe(): Promise<unknown> {
    return this.client.call('public:getMe')
  }

  async getPublicNodesInformation(): Promise<Client[]> {
    return this.client.call<Client[]>('public:getNodesInformation')
  }

  async getPublicSettings(): Promise<PublicInfo> {
    return this.client.call<PublicInfo>('public:getPublicSettings')
  }

  async recordPublicVisitorEvent(params: VisitorAuditEventParams, signal?: AbortSignal): Promise<VisitorAuditEventResponse> {
    return this.client.call<VisitorAuditEventResponse>('public:recordVisitorEvent', params, signal)
  }

  async getPublicVersion(): Promise<VersionInfo> {
    return this.client.call<VersionInfo>('public:getVersion')
  }

  async getPublicClientRecentRecords(uuid: string, signal?: AbortSignal): Promise<StatusRecord[]> {
    return this.client.call<StatusRecord[]>('public:getClientRecentRecords', { uuid }, signal)
  }

  async getPublicRecordsByUUID(params: { uuid: string, load_type?: string, hours?: number | string }, signal?: AbortSignal): Promise<{ count: number, records: Array<Partial<StatusRecord>>, load_type?: string, has_gpu_data?: boolean, gpu_devices?: Record<string, unknown> }> {
    return this.client.call<{ count: number, records: Array<Partial<StatusRecord>>, load_type?: string, has_gpu_data?: boolean, gpu_devices?: Record<string, unknown> }>('public:getRecordsByUUID', {
      ...params,
      hours: params.hours === undefined ? undefined : String(params.hours),
    }, signal)
  }

  async getPublicPingRecords(params: { uuid?: string, task_id?: string | number, hours?: number | string }, signal?: AbortSignal): Promise<{ count: number, records: PingRecord[], tasks?: PingTaskInfo[], basic_info?: Array<{ client: string, loss: number, min: number, max: number }> }> {
    return this.client.call<{ count: number, records: PingRecord[], tasks?: PingTaskInfo[], basic_info?: Array<{ client: string, loss: number, min: number, max: number }> }>('public:getPingRecords', {
      ...params,
      task_id: params.task_id === undefined ? undefined : String(params.task_id),
      hours: params.hours === undefined ? undefined : String(params.hours),
    }, signal)
  }

  async getPublicPingTasks(): Promise<PingTaskInfo[]> {
    return this.client.call<PingTaskInfo[]>('public:getPublicPingTasks')
  }

  async listPublicMetricDefinitions(): Promise<MetricDefinition[]> {
    return this.client.call<MetricDefinition[]>('public:listMetricDefinitions')
  }

  async queryPublicMetrics(params: MetricQueryParams, signal?: AbortSignal): Promise<MetricQueryResponse> {
    return this.client.call<MetricQueryResponse>('public:queryMetrics', params, signal)
  }

  async getPublicPingMetricStats(params: PingMetricStatsParams, signal?: AbortSignal): Promise<PingMetricStatsResponse> {
    return this.client.call<PingMetricStatsResponse>('public:getPingMetricStats', params, signal)
  }

  /**
   * 关闭连接
   */
  close(): void {
    this.client.close()
  }
}

// ==================== 单例 ====================

let sharedRpc: KomariRpc | null = null

/**
 * 获取共享的 KomariRpc 实例
 */
export function getSharedRpc(): KomariRpc {
  if (!sharedRpc) {
    sharedRpc = new KomariRpc()
  }
  return sharedRpc
}

/**
 * 重置共享实例
 */
export function resetSharedRpc(): void {
  if (sharedRpc) {
    sharedRpc.close()
    sharedRpc = null
  }
}
