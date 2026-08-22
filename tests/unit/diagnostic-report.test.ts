import type { DiagnosticReportInput } from '../../src/utils/diagnosticReport'
import { describe, expect, test } from 'bun:test'
import { buildDiagnosticReport } from '../../src/utils/diagnosticReport'

function baseInput(overrides: Partial<DiagnosticReportInput> = {}): DiagnosticReportInput {
  return {
    themeVersion: '1.3.0',
    gitHash: 'abc1234',
    generatedAt: Date.parse('2026-08-22T08:00:00Z'),
    serverVersion: { version: '1.4.3', hash: 'def5678' },
    rpcTransportMode: 'websocket',
    wsConnectionState: 'connected',
    wsReconnectAttempts: 0,
    nodeTotal: 10,
    nodeOnline: 9,
    lastNodeUpdateAt: Date.parse('2026-08-22T07:59:00Z'),
    enabledFeatures: [
      { label: '网络拓扑', enabled: true },
      { label: '磁盘空间预测', enabled: false },
    ],
    topologyEnabled: true,
    topologyAutoRepairEnabled: true,
    routeProbeEnabled: false,
    lastTopologyWrite: null,
    companionHealth: null,
    ...overrides,
  }
}

describe('buildDiagnosticReport', () => {
  test('renders 未知 when the Komari server version could not be loaded', () => {
    const report = buildDiagnosticReport(baseInput({ serverVersion: null }))
    expect(report).toContain('Komari 服务端：未知')
  })

  test('renders the server version and hash when available', () => {
    const report = buildDiagnosticReport(baseInput())
    expect(report).toContain('Komari 服务端：v1.4.3（def5678）')
  })

  test('omits the 回程插件 section entirely when routeProbeEnabled is false', () => {
    const report = buildDiagnosticReport(baseInput({ routeProbeEnabled: false }))
    expect(report).not.toContain('回程插件')
  })

  test('shows companion plugin health when routeProbeEnabled is true', () => {
    const report = buildDiagnosticReport(baseInput({
      routeProbeEnabled: true,
      companionHealth: { ok: true, protocol: 1, version: '0.4.0' },
    }))
    expect(report).toContain('回程插件')
    expect(report).toContain('正常')
    expect(report).toContain('v0.4.0')
  })

  test('reports 不可用 when routeProbeEnabled is true but the companion health check failed', () => {
    const report = buildDiagnosticReport(baseInput({ routeProbeEnabled: true, companionHealth: null }))
    expect(report).toContain('不可用')
  })

  test('shows 暂无记录 when there is no topology write log entry', () => {
    const report = buildDiagnosticReport(baseInput({ lastTopologyWrite: null }))
    expect(report).toContain('暂无记录')
  })

  test('shows the latest topology write entry with a Chinese success/failure label', () => {
    const report = buildDiagnosticReport(baseInput({
      lastTopologyWrite: { at: Date.parse('2026-08-22T07:00:00Z'), trigger: 'auto', action: '创建探测任务', outcome: 'ok' },
    }))
    expect(report).toContain('创建探测任务')
    expect(report).toContain('成功')
  })

  test('only lists enabled features, comma-separated', () => {
    const report = buildDiagnosticReport(baseInput({
      enabledFeatures: [
        { label: '网络拓扑', enabled: true },
        { label: '磁盘空间预测', enabled: false },
        { label: 'GPU 图表', enabled: true },
      ],
    }))
    expect(report).toContain('网络拓扑、GPU 图表')
    expect(report).not.toContain('磁盘空间预测')
  })

  test('shows （无） when no features are enabled', () => {
    const report = buildDiagnosticReport(baseInput({ enabledFeatures: [{ label: '网络拓扑', enabled: false }] }))
    expect(report).toContain('（无）')
  })

  test('redacts UUIDs and task IDs surfaced through the topology write log entry', () => {
    const report = buildDiagnosticReport(baseInput({
      lastTopologyWrite: {
        at: Date.parse('2026-08-22T07:00:00Z'),
        trigger: 'manual',
        action: '删除任务 00000000-0000-4000-8000-000000000001',
        outcome: 'failed',
        detail: '任务 ID：19',
      },
    }))
    expect(report).not.toContain('00000000-0000-4000-8000-000000000001')
    expect(report).toContain('[已隐藏]')
  })
})
