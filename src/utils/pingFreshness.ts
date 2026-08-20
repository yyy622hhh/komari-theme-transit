import { OPS_PING_FRESHNESS } from '@/constants/ops'

export type PingFreshness = 'fresh' | 'delayed' | 'stale'

export function resolvePingFreshness(
  lastFetchedAt: number,
  now: number,
  options: { hasData: boolean, graceUntil?: number },
): PingFreshness {
  if (!options.hasData || now <= (options.graceUntil ?? 0))
    return 'fresh'
  if (lastFetchedAt <= 0)
    return 'stale'

  const age = Math.max(0, now - lastFetchedAt)
  if (age >= OPS_PING_FRESHNESS.staleAfterMs)
    return 'stale'
  if (age >= OPS_PING_FRESHNESS.delayedAfterMs)
    return 'delayed'
  return 'fresh'
}

export function formatPingFreshnessAge(lastFetchedAt: number, now: number, language: 'zh-CN' | string): string {
  const ageMinutes = Math.max(1, Math.floor(Math.max(0, now - lastFetchedAt) / 60_000))
  if (language === 'zh-CN')
    return ageMinutes < 60 ? `${ageMinutes} 分钟前` : `${Math.floor(ageMinutes / 60)} 小时前`
  return ageMinutes < 60
    ? `${ageMinutes} min ago`
    : `${Math.floor(ageMinutes / 60)} hr ago`
}
