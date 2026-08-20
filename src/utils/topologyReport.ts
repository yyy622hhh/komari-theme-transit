import type { TopologySegmentTelemetry } from '@/utils/topologyHealth'
import type { TopologySegmentReliabilitySnapshot } from '@/utils/topologyIntelligence'
import { describeTopologyPeakInsight } from '@/utils/topologyInsights'

export interface TopologyReportSegment {
  sourceName: string
  targetName: string
  telemetry?: TopologySegmentTelemetry
  reliability?: TopologySegmentReliabilitySnapshot
}

export interface TopologyReportDirection {
  label: '正向' | '反向'
  sourceName: string
  targetName: string
  telemetry?: TopologySegmentTelemetry
}

export interface TopologyDiagnosticReportInput {
  version: string
  generatedAt: number
  routeName: string
  segments: TopologyReportSegment[]
  directions?: TopologyReportDirection[]
}

const UUID_PATTERN = /\b[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\b/gi
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6_CANDIDATE_PATTERN = /[\da-f:.]*:[\da-f:.]+/gi
const TASK_ID_PATTERN = /(?:任务 ID|任务ID|task_id|task-id|task id)[:：=# ]{0,4}\d+/gi

function formatBeijingTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp))
    return '待数据'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
}

function latency(value: number | null | undefined): string {
  return value === null || value === undefined ? '待数据' : `${Math.round(value)} ms`
}

function loss(value: number | null | undefined): string {
  return value === null || value === undefined ? '待数据' : `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function freshness(value: TopologySegmentReliabilitySnapshot['insights']): string {
  const state = value?.evidence.freshness
  return state === 'stale' ? '已过期' : state === 'delayed' ? '可能延迟' : '实时'
}

function baselineShift(snapshot: TopologySegmentReliabilitySnapshot): string | null {
  const shift = snapshot.insights?.baselineShift
  if (!shift)
    return null
  const delta = Math.round(Math.abs(shift.deltaMs))
  return shift.direction === 'degraded' ? `延迟基线升高 ${delta} ms` : `延迟基线降低 ${delta} ms`
}

export function redactTopologyDiagnosticReport(value: string): string {
  return value
    .replace(UUID_PATTERN, '[已隐藏]')
    .replace(IPV4_PATTERN, '[已隐藏]')
    .replace(IPV6_CANDIDATE_PATTERN, candidate => candidate.includes('::') || candidate.split(':').length >= 8 ? '[已隐藏]' : candidate)
    .replace(TASK_ID_PATTERN, match => `${match.replace(/\d+$/, '').trim()} [已隐藏]`)
}

export function buildTopologyDiagnosticReport(input: TopologyDiagnosticReportInput): string {
  const lines = [
    `Transit v${input.version} 线路诊断`,
    `生成时间：${formatBeijingTime(input.generatedAt)}（北京时间）`,
    `线路：${input.routeName}`,
  ]

  input.segments.forEach((segment, index) => {
    const insights = segment.reliability?.insights
    const evidence = insights?.evidence
    lines.push('', `分段 ${index + 1}：${segment.sourceName} → ${segment.targetName}`)
    lines.push(`当前：延迟 ${latency(segment.telemetry?.latency)} / 丢包 ${loss(segment.telemetry?.loss)}`)
    if (!insights?.live || !evidence) {
      lines.push(`数据依据：${insights?.live === false ? '静态基线' : '待积累'}`)
      return
    }
    lines.push(`数据状态：${freshness(insights)}，最后样本 ${formatBeijingTime(evidence.latestSampleAt)}`)
    lines.push(`24h 基线：P50 ${latency(evidence.baselineLatencyP50)} / P95 ${latency(evidence.baselineLatencyP95)} / 丢包 ${loss(evidence.baselineLossMedian)} / ${evidence.baselineSampleCount} 个样本`)
    lines.push(`7d 覆盖：${formatBeijingTime(evidence.weekCoverage.from)} 至 ${formatBeijingTime(evidence.weekCoverage.to)} / ${evidence.weekCoverage.sampleCount} 个样本`)
    if (insights.peakInsight)
      lines.push(`晚高峰：${describeTopologyPeakInsight(insights.peakInsight)}`)
    if (insights.diagnosis)
      lines.push(`当前诊断：${insights.diagnosis.message}`)
    const shift = baselineShift(segment.reliability!)
    if (shift)
      lines.push(`近期变化：${shift}；可能与路径、探测方式或目标变化有关。`)
  })

  if (input.directions?.length) {
    lines.push('', '双向探测：')
    for (const direction of input.directions)
      lines.push(`${direction.label} ${direction.sourceName} → ${direction.targetName}：延迟 ${latency(direction.telemetry?.latency)} / 丢包 ${loss(direction.telemetry?.loss)}`)
  }

  lines.push('', '说明：本报告仅依据公开 Ping 样本生成，不代表确认发生路由变化。')
  return redactTopologyDiagnosticReport(lines.join('\n'))
}
