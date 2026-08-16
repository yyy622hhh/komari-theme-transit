import { describe, expect, test } from 'bun:test'
import { formatTopologyTelemetryLabel } from '@/utils/topologyHelper'

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
