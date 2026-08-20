import type { CarrierPingDisplay } from '../../src/composables/useNodeCarrierPingDisplay'
import type { NodeData } from '../../src/stores/nodes'
import { describe, expect, test } from 'bun:test'
import { getCarrierNodeAlert, getPrimaryNodeAlert, getRealtimeNodeAlerts } from '../../src/utils/nodeAlert'

const GIB = 1024 ** 3

function node(overrides: Partial<NodeData> = {}): NodeData {
  return {
    uuid: 'node-1',
    name: 'Relay-JP',
    online: true,
    cpu: 10,
    ram: 10 * GIB,
    mem_total: 100 * GIB,
    disk: 10 * GIB,
    disk_total: 100 * GIB,
    ...overrides,
  } as NodeData
}

function carrier(overrides: Partial<CarrierPingDisplay> = {}): CarrierPingDisplay {
  const lossDisplay = overrides.lossDisplay ?? '0'
  return {
    key: 'telecom',
    label: '电信',
    dotClass: '',
    taskNames: [],
    latencyDisplay: '30',
    volatilityDisplay: '',
    lossDisplay,
    alertLoss: Number.isFinite(Number.parseFloat(lossDisplay)) ? Number.parseFloat(lossDisplay) : null,
    commonModeLossEvents: 0,
    latencyBars: [],
    lossBars: [],
    latencyTooltip: '',
    lossTooltip: '',
    delayed: false,
    stale: false,
    ...overrides,
  } as CarrierPingDisplay
}

describe('getRealtimeNodeAlerts', () => {
  test('an offline node reports only that, outranking every metric alert', () => {
    // 离线时上报的 CPU / 内存都是最后一次采样，拿它们再报一次警没有意义。
    const alerts = getRealtimeNodeAlerts(node({ online: false, cpu: 99, disk: 99 * GIB }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ detail: '节点离线', severity: 'critical', score: 400 })
  })

  test('a healthy node reports nothing', () => {
    expect(getRealtimeNodeAlerts(node())).toEqual([])
  })

  test('thresholds are inclusive at the boundary and split warning from critical', () => {
    expect(getRealtimeNodeAlerts(node({ cpu: 84.9 }))).toEqual([])
    expect(getRealtimeNodeAlerts(node({ cpu: 85 }))[0]).toMatchObject({ severity: 'warning', detail: 'CPU 85.0%' })
    expect(getRealtimeNodeAlerts(node({ cpu: 95 }))[0]).toMatchObject({ severity: 'critical' })
  })

  test('disk trips earlier than CPU, matching its lower threshold', () => {
    expect(getRealtimeNodeAlerts(node({ disk: 82 * GIB }))[0]).toMatchObject({ detail: '磁盘 82.0%' })
    expect(getRealtimeNodeAlerts(node({ cpu: 82 }))).toEqual([])
  })

  test('alerts come back worst-first', () => {
    const alerts = getRealtimeNodeAlerts(node({ cpu: 86, ram: 97 * GIB, disk: 90 * GIB }))
    expect(alerts.map(alert => alert.detail)).toEqual(['内存 97.0%', '磁盘 90.0%', 'CPU 86.0%'])
    expect(alerts[0]!.severity).toBe('critical')
  })

  test('traffic is only judged when the node actually has a quota', () => {
    const noQuota = node({ traffic_used: 900, traffic_limit: 0 })
    expect(getRealtimeNodeAlerts(noQuota).some(alert => alert.detail.startsWith('流量额度'))).toBe(false)
  })

  test('a non-finite metric is skipped rather than formatted as NaN%', () => {
    expect(getRealtimeNodeAlerts(node({ cpu: Number.NaN }))).toEqual([])
  })
})

describe('getCarrierNodeAlert', () => {
  test('stale carrier samples never raise an alert', () => {
    const stale = carrier({ stale: true, lossDisplay: '100', latencyDisplay: '900' })
    expect(getCarrierNodeAlert(node(), [stale], '北京三网')).toBeNull()
  })

  test('delayed carrier samples stay visible but never raise a new alert', () => {
    const delayed = carrier({ delayed: true, lossDisplay: '100', latencyDisplay: '900' })
    expect(getCarrierNodeAlert(node(), [delayed], '北京三网')).toBeNull()
  })

  test('shared target failures keep raw loss visible without raising a per-node alert', () => {
    const commonMode = carrier({ lossDisplay: '20', alertLoss: 0, commonModeLossEvents: 2 })
    expect(getCarrierNodeAlert(node(), [commonMode], '北京三网')).toBeNull()
  })

  test('an offline node reports no carrier alert', () => {
    expect(getCarrierNodeAlert(node({ online: false }), [carrier({ lossDisplay: '50' })], '北京三网')).toBeNull()
  })

  test('loss wins over latency on the same carrier', () => {
    // 同一个运营商同时丢包又高延迟时，丢包是更严重的症状，不该被延迟盖过去。
    const bad = carrier({ lossDisplay: '20', latencyDisplay: '900' })
    expect(getCarrierNodeAlert(node(), [bad], '北京三网')).toMatchObject({
      detail: '北京电信丢包 20.0%',
      severity: 'critical',
    })
  })

  test('the scope label becomes a prefix, and 多地区均值 contributes none', () => {
    const slow = carrier({ latencyDisplay: '210' })
    expect(getCarrierNodeAlert(node(), [slow], '北京三网')?.detail).toBe('北京电信延迟 210 ms')
    expect(getCarrierNodeAlert(node(), [slow], '多地区均值')?.detail).toBe('电信延迟 210 ms')
  })

  test('only the worst carrier is surfaced', () => {
    const alert = getCarrierNodeAlert(node(), [
      carrier({ key: 'telecom', label: '电信', latencyDisplay: '210' }),
      carrier({ key: 'unicom', label: '联通', lossDisplay: '30' }),
    ], '北京三网')
    expect(alert?.detail).toBe('北京联通丢包 30.0%')
  })

  test('unparsable display values are ignored', () => {
    expect(getCarrierNodeAlert(node(), [carrier({ latencyDisplay: '-', lossDisplay: '-' })], '北京三网')).toBeNull()
  })
})

describe('getPrimaryNodeAlert', () => {
  test('picks the single worst signal across realtime and carrier alerts', () => {
    // 运营商丢包 30% 得分 270，CPU 86% 得分 186——严重的链路问题应该盖过资源告警。
    const alert = getPrimaryNodeAlert(node({ cpu: 86 }), [carrier({ lossDisplay: '30' })], '北京三网')
    expect(alert?.detail).toBe('北京电信丢包 30.0%')
  })

  test('offline still wins over any carrier signal', () => {
    const alert = getPrimaryNodeAlert(node({ online: false }), [carrier({ lossDisplay: '90' })], '北京三网')
    expect(alert?.detail).toBe('节点离线')
  })

  test('a healthy node with healthy carriers has no primary alert', () => {
    expect(getPrimaryNodeAlert(node(), [carrier()], '北京三网')).toBeNull()
  })
})
