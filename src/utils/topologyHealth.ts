export type TopologyRouteHealth = 'healthy' | 'warning' | 'pending' | 'error' | 'offline'

export interface TopologySegmentTelemetry {
  status: TopologyRouteHealth
  latency: number | null
  loss: number | null
  volatility: number | null
  hasLiveData: boolean
  stale: boolean
}

export interface TopologyHealthDeduction {
  key: string
  label: string
  points: number
}

export interface TopologyRouteScore {
  score: number
  label: '优秀' | '稳定' | '波动' | '异常' | '待数据'
  tone: 'healthy' | 'warning' | 'critical' | 'pending'
  deductions: TopologyHealthDeduction[]
}

interface RouteScoreOptions {
  segments: Array<TopologySegmentTelemetry | undefined>
  segmentLabels: string[]
  hasOfflineNode: boolean
  hasMissingNode: boolean
}

function latencyPenalty(latency: number): number {
  if (latency <= 80)
    return 0
  if (latency <= 120)
    return (latency - 80) / 4
  if (latency <= 180)
    return 10 + (latency - 120) / 4
  if (latency <= 250)
    return 25 + (latency - 180) * 0.22
  return Math.min(55, 40 + (latency - 250) * 0.1)
}

function scoreLabel(score: number, states: TopologyRouteHealth[]): TopologyRouteScore['label'] {
  if (states.every(state => state === 'pending'))
    return '待数据'
  if (states.includes('offline') || states.includes('error') || score < 55)
    return '异常'
  if (states.includes('warning') || score < 75)
    return '波动'
  if (score < 90)
    return '稳定'
  return '优秀'
}

function scoreTone(label: TopologyRouteScore['label']): TopologyRouteScore['tone'] {
  if (label === '优秀' || label === '稳定')
    return 'healthy'
  if (label === '波动')
    return 'warning'
  if (label === '待数据')
    return 'pending'
  return 'critical'
}

export function calculateTopologyRouteScore(options: RouteScoreOptions): TopologyRouteScore {
  if (options.hasOfflineNode) {
    return {
      score: 0,
      label: '异常',
      tone: 'critical',
      deductions: [{ key: 'offline', label: '线路中存在离线节点', points: 100 }],
    }
  }

  if (options.hasMissingNode) {
    return {
      score: 25,
      label: '异常',
      tone: 'critical',
      deductions: [{ key: 'missing', label: '配置节点未纳入监控', points: 75 }],
    }
  }

  const deductions: TopologyHealthDeduction[] = []
  const states: TopologyRouteHealth[] = []
  const segmentPenalties = options.segments.map((segment, index) => {
    const label = options.segmentLabels[index] || `第 ${index + 1} 段`
    if (!segment) {
      states.push('pending')
      deductions.push({ key: `${index}:pending`, label: `${label}等待采样`, points: 18 })
      return 18
    }

    states.push(segment.status)
    if (segment.status === 'offline') {
      deductions.push({ key: `${index}:offline`, label: `${label}不可用`, points: 100 })
      return 100
    }
    if (segment.status === 'error') {
      deductions.push({ key: `${index}:error`, label: `${label}读取失败`, points: 55 })
      return 55
    }
    if (segment.status === 'pending' || segment.stale) {
      deductions.push({ key: `${index}:pending`, label: `${label}${segment.stale ? '数据已过期' : '等待采样'}`, points: 18 })
      return 18
    }

    let penalty = 0
    if (segment.latency !== null) {
      const points = Math.round(latencyPenalty(segment.latency))
      if (points > 0) {
        deductions.push({ key: `${index}:latency`, label: `${label}延迟 ${Math.round(segment.latency)} ms`, points })
        penalty += points
      }
    }
    if (segment.loss !== null && segment.loss > 0) {
      const points = Math.round(Math.min(45, segment.loss * 4))
      if (points > 0) {
        deductions.push({ key: `${index}:loss`, label: `${label}丢包 ${segment.loss.toFixed(1)}%`, points })
        penalty += points
      }
    }
    if (segment.volatility !== null && segment.volatility > 0.8) {
      const points = Math.round(Math.min(20, (segment.volatility - 0.8) * 8))
      if (points > 0) {
        deductions.push({ key: `${index}:volatility`, label: `${label}波动 ${segment.volatility.toFixed(2)}`, points })
        penalty += points
      }
    }
    return Math.min(100, penalty)
  })

  const averagePenalty = segmentPenalties.length
    ? segmentPenalties.reduce((sum, value) => sum + value, 0) / segmentPenalties.length
    : 18
  const score = Math.max(0, Math.round(100 - averagePenalty))
  const label = scoreLabel(score, states.length ? states : ['pending'])
  return {
    score,
    label,
    tone: scoreTone(label),
    deductions: deductions.sort((left, right) => right.points - left.points),
  }
}
