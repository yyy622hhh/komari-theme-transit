export function formatTopologyLatency(value: number | null): string {
  if (value === null)
    return '-'
  return value >= 0 && value < 1 ? '<1ms' : `${Math.round(value)}ms`
}

export function formatTopologyLoss(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(1)}%`
}

export type TopologySampleTone = 'healthy' | 'warning' | 'critical'

export function calculateTopologyLatencyBaseline(values: Array<number | null>): number | null {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right)
  if (!sorted.length)
    return null

  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2)
    return sorted[middle] ?? null
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

export function resolveTopologySampleTone(
  latency: number | null,
  loss: number | null,
  baseline: number | null,
): TopologySampleTone {
  if (latency === null || (loss ?? 0) >= 20)
    return 'critical'
  if ((loss ?? 0) > 3)
    return 'warning'

  const hasMeaningfulLatencySpike = baseline !== null
    && latency - baseline >= 5
    && (baseline <= 0 || latency > baseline * 1.18)
  return hasMeaningfulLatencySpike ? 'warning' : 'healthy'
}
