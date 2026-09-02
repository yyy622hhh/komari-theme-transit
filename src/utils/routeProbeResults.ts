import { isNodeRouteTag, parseNodeRouteTag } from '@/utils/routeTag'

/** Public theme-setting key used instead of Komari's user-visible node tags. */
export const ROUTE_PROBE_RESULTS_SETTING = 'pandaOpsRouteProbeResults'

export type RouteProbeResults = Record<string, string>

export const ROUTE_PROBE_MAX_RESULTS = 10_000
const MAX_NODE_ID_LENGTH = 256
const MAX_ROUTE_TAG_LENGTH = 4096

function parseRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    }
    catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
}

/** Normalize the untrusted public setting and retain only complete route tags. */
export function normalizeRouteProbeResults(raw: unknown): RouteProbeResults {
  const validByUuid = new Map<string, { uuid: string, tag: string, measuredAt: number }>()
  for (const [uuid, value] of Object.entries(parseRecord(raw))) {
    const nodeId = uuid.trim()
    if (!nodeId || nodeId.length > MAX_NODE_ID_LENGTH || typeof value !== 'string')
      continue
    const tag = value.trim()
    if (tag.length > MAX_ROUTE_TAG_LENGTH)
      continue
    const report = parseNodeRouteTag(tag)
    if (report?.raw === tag) {
      const candidate = { uuid: nodeId, tag, measuredAt: report.measuredAt ?? 0 }
      const previous = validByUuid.get(nodeId)
      if (!previous || candidate.measuredAt >= previous.measuredAt)
        validByUuid.set(nodeId, candidate)
    }
  }

  // The setting is append-heavy. Keep the newest evidence rather than the
  // first object keys, otherwise deleted nodes can eventually crowd out a
  // freshly probed node. UUID is a deterministic tie-breaker for old tags
  // without a timestamp.
  const valid = [...validByUuid.values()]
    .sort((left, right) => right.measuredAt - left.measuredAt || left.uuid.localeCompare(right.uuid))
  const normalized: RouteProbeResults = Object.create(null) as RouteProbeResults
  for (const entry of valid.slice(0, ROUTE_PROBE_MAX_RESULTS))
    normalized[entry.uuid] = entry.tag
  return normalized
}

/** Prefer the newest valid result while continuing to read v1.4.1 node tags. */
export function resolveNodeRouteTag(
  uuid: string,
  nodeTags: string | null | undefined,
  results: RouteProbeResults,
): string {
  const stored = Object.hasOwn(results, uuid) ? results[uuid] : undefined
  const storedReport = stored ? parseNodeRouteTag(stored) : null
  const legacyReport = parseNodeRouteTag(nodeTags)
  if (!storedReport)
    return legacyReport?.raw ?? ''
  if (!legacyReport)
    return storedReport.raw

  const storedAt = storedReport.measuredAt ?? 0
  const legacyAt = legacyReport.measuredAt ?? 0
  return legacyAt > storedAt ? legacyReport.raw : storedReport.raw
}

/** Remove only Transit-owned metadata and preserve every operator tag verbatim. */
export function stripNodeRouteTags(tags: string | null | undefined): string {
  return String(tags ?? '')
    .split(';')
    .map(tag => tag.trim())
    .filter(tag => tag && !isNodeRouteTag(tag))
    .join(';')
}

/** Choose the newest valid result so migration can never overwrite a fresh probe. */
export function mergeRouteProbeResults(
  current: RouteProbeResults,
  incoming: RouteProbeResults,
  activeNodeIds?: readonly string[],
): RouteProbeResults {
  const allowed = activeNodeIds
    ? new Set(activeNodeIds.map(uuid => uuid.trim()).filter(Boolean))
    : null
  const merged: RouteProbeResults = Object.create(null) as RouteProbeResults
  for (const [uuid, tag] of Object.entries(current)) {
    if (!allowed || allowed.has(uuid))
      merged[uuid] = tag
  }
  for (const [uuid, candidate] of Object.entries(incoming)) {
    if (allowed && !allowed.has(uuid))
      continue
    const candidateReport = parseNodeRouteTag(candidate)
    if (!candidateReport)
      continue
    const existing = merged[uuid]
    const existingReport = existing ? parseNodeRouteTag(existing) : null
    if (!existingReport || (candidateReport.measuredAt ?? 0) >= (existingReport.measuredAt ?? 0))
      merged[uuid] = candidateReport.raw
  }
  return normalizeRouteProbeResults(merged)
}
