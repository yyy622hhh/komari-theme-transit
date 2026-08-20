import type { CarrierPingDisplay } from '@/composables/useNodeCarrierPingDisplay'
import type { NodeData } from '@/stores/nodes'
import { OPS_ALERT_THRESHOLDS } from '@/constants/ops'
import { getDiskPercentage, getMemoryPercentage, getTrafficUsedPercentage, hasTrafficLimit } from '@/utils/nodeMetricsHelper'

export type NodeAlertSeverity = 'warning' | 'critical'

export interface NodeAlert {
  key: string
  nodeUuid: string
  nodeName: string
  detail: string
  severity: NodeAlertSeverity
  icon: string
  score: number
}

function metricAlert(
  node: NodeData,
  key: string,
  label: string,
  value: number,
  warningAt: number,
  criticalAt: number,
  icon: string,
): NodeAlert | null {
  if (!Number.isFinite(value) || value < warningAt)
    return null
  const critical = value >= criticalAt
  return {
    key: `${node.uuid}:${key}`,
    nodeUuid: node.uuid,
    nodeName: node.name,
    detail: `${label} ${value.toFixed(1)}%`,
    severity: critical ? 'critical' : 'warning',
    icon,
    score: (critical ? 200 : 100) + value,
  }
}

export function getRealtimeNodeAlerts(node: NodeData): NodeAlert[] {
  if (!node.online) {
    return [{
      key: `${node.uuid}:offline`,
      nodeUuid: node.uuid,
      nodeName: node.name,
      detail: '节点离线',
      severity: 'critical',
      icon: 'tabler:plug-connected-x',
      score: 400,
    }]
  }

  const alerts = [
    metricAlert(node, 'cpu', 'CPU', node.cpu, OPS_ALERT_THRESHOLDS.cpu.warning, OPS_ALERT_THRESHOLDS.cpu.critical, 'tabler:cpu'),
    metricAlert(node, 'memory', '内存', getMemoryPercentage(node), OPS_ALERT_THRESHOLDS.memory.warning, OPS_ALERT_THRESHOLDS.memory.critical, 'tabler:device-sd-card'),
    metricAlert(node, 'disk', '磁盘', getDiskPercentage(node), OPS_ALERT_THRESHOLDS.disk.warning, OPS_ALERT_THRESHOLDS.disk.critical, 'tabler:server-2'),
    hasTrafficLimit(node)
      ? metricAlert(node, 'traffic', '流量额度', getTrafficUsedPercentage(node), OPS_ALERT_THRESHOLDS.traffic.warning, OPS_ALERT_THRESHOLDS.traffic.critical, 'tabler:arrows-transfer-up-down')
      : null,
  ].filter((alert): alert is NodeAlert => Boolean(alert))

  return alerts.sort((left, right) => right.score - left.score)
}

function scopePrefix(scopeLabel: string): string {
  if (scopeLabel.endsWith('三网'))
    return scopeLabel.slice(0, -2)
  if (scopeLabel === '多地区均值')
    return ''
  return scopeLabel
}

export function getCarrierNodeAlert(
  node: NodeData,
  carriers: CarrierPingDisplay[],
  scopeLabel: string,
): NodeAlert | null {
  if (!node.online)
    return null

  const prefix = scopePrefix(scopeLabel)
  const issues = carriers.flatMap((carrier) => {
    if (carrier.delayed || carrier.stale)
      return []
    const loss = Number.parseFloat(carrier.lossDisplay)
    const latency = Number.parseFloat(carrier.latencyDisplay)
    const result: NodeAlert[] = []

    if (Number.isFinite(loss) && loss > OPS_ALERT_THRESHOLDS.carrierLoss.warning) {
      result.push({
        key: `${node.uuid}:carrier:${carrier.key}:loss`,
        nodeUuid: node.uuid,
        nodeName: node.name,
        detail: `${prefix}${carrier.label}丢包 ${loss.toFixed(1)}%`,
        severity: loss >= OPS_ALERT_THRESHOLDS.carrierLoss.critical ? 'critical' : 'warning',
        icon: 'tabler:wave-sine',
        score: (loss >= OPS_ALERT_THRESHOLDS.carrierLoss.critical ? 240 : 140) + loss,
      })
    }
    else if (Number.isFinite(latency) && latency > OPS_ALERT_THRESHOLDS.carrierLatency.warning) {
      result.push({
        key: `${node.uuid}:carrier:${carrier.key}:latency`,
        nodeUuid: node.uuid,
        nodeName: node.name,
        detail: `${prefix}${carrier.label}延迟 ${Math.round(latency)} ms`,
        severity: latency >= OPS_ALERT_THRESHOLDS.carrierLatency.critical ? 'critical' : 'warning',
        icon: 'tabler:clock-exclamation',
        score: (latency >= OPS_ALERT_THRESHOLDS.carrierLatency.critical ? 220 : 120) + latency / 10,
      })
    }

    return result
  })

  return issues.sort((left, right) => right.score - left.score)[0] ?? null
}

export function getPrimaryNodeAlert(
  node: NodeData,
  carriers: CarrierPingDisplay[] = [],
  scopeLabel = '',
): NodeAlert | null {
  const alerts = [...getRealtimeNodeAlerts(node)]
  const carrierAlert = getCarrierNodeAlert(node, carriers, scopeLabel)
  if (carrierAlert)
    alerts.push(carrierAlert)
  return alerts.sort((left, right) => right.score - left.score)[0] ?? null
}
