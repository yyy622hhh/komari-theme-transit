import type { CompanionHealth } from '@/services/route-probe-companion.service'
import type { RpcTransportMode } from '@/stores/app.types'
import type { WsConnectionState } from '@/stores/nodes'
import type { VersionInfo } from '@/utils/api'
import type { TopologyWriteEntry } from '@/utils/topologyWriteLog'
import { formatBeijingTime, redactDiagnosticReport } from '@/utils/topologyReport'

export interface DiagnosticReportInput {
  themeVersion: string
  gitHash: string
  generatedAt: number
  serverVersion: VersionInfo | null
  rpcTransportMode: RpcTransportMode
  wsConnectionState: WsConnectionState
  wsReconnectAttempts: number
  nodeTotal: number
  nodeOnline: number
  lastNodeUpdateAt: number | null
  enabledFeatures: { label: string, enabled: boolean }[]
  topologyEnabled: boolean
  topologyAutoRepairEnabled: boolean
  routeProbeEnabled: boolean
  lastTopologyWrite: TopologyWriteEntry | null
  companionHealth: CompanionHealth | null
}

export const WS_STATE_LABELS: Record<WsConnectionState, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  disconnected: '未连接',
}

/**
 * “全局诊断中心”的文本报告，走和 topologyReport.ts 里
 * buildTopologyDiagnosticReport 一样的「拼行 → join → 脱敏」流程，复用同一套
 * 脱敏正则（redactDiagnosticReport）而不是重新写一遍。
 */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const lines = [
    `Transit v${input.themeVersion} (${input.gitHash}) 运行诊断`,
    `生成时间：${formatBeijingTime(input.generatedAt)}（北京时间）`,
    '',
    '版本：',
    `  Transit：v${input.themeVersion}（commit ${input.gitHash}）`,
    `  Komari 服务端：${input.serverVersion ? `v${input.serverVersion.version}（${input.serverVersion.hash}）` : '未知'}`,
    '',
    '连接：',
    `  配置模式：${input.rpcTransportMode === 'websocket' ? 'WebSocket' : 'HTTP'}`,
    `  当前状态：${WS_STATE_LABELS[input.wsConnectionState]}${input.wsReconnectAttempts > 0 ? `（已重连 ${input.wsReconnectAttempts} 次）` : ''}`,
    '',
    '节点：',
    `  共 ${input.nodeTotal} 台，在线 ${input.nodeOnline} 台`,
    `  最近状态更新：${formatBeijingTime(input.lastNodeUpdateAt)}`,
    '',
    '已启用功能：',
    input.enabledFeatures.filter(f => f.enabled).map(f => f.label).join('、') || '（无）',
    '',
    '拓扑：',
    `  总开关：${input.topologyEnabled ? '已启用' : '已关闭'}`,
    `  自动修复：${input.topologyAutoRepairEnabled ? '已启用' : '已关闭'}`,
    `  回程采集：${input.routeProbeEnabled ? '已启用' : '已关闭'}`,
    `  最近一次写入：${input.lastTopologyWrite
      ? `${formatBeijingTime(input.lastTopologyWrite.at)} · ${input.lastTopologyWrite.action} · ${input.lastTopologyWrite.outcome === 'ok' ? '成功' : '失败'}`
      : '暂无记录'}`,
  ]

  if (input.routeProbeEnabled) {
    lines.push(
      '',
      '回程插件：',
      `  状态：${input.companionHealth ? (input.companionHealth.ok ? '正常' : '异常') : '不可用'}`,
      `  版本：${input.companionHealth?.version ? `v${input.companionHealth.version}` : '未知'}`,
    )
  }

  lines.push('', '说明：本报告已对 UUID、IP、任务 ID 做脱敏处理，仅用于故障排查。')

  return redactDiagnosticReport(lines.join('\n'))
}
