export interface PandaOpsNodeControl {
  maintenanceUntil?: number
  silenceUntil?: number
}

export type PandaOpsNodeControls = Record<string, PandaOpsNodeControl>

function validUntil(value: unknown, now: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > now ? value : undefined
}

export function parsePandaOpsNodeControls(value: unknown, now = Date.now()): PandaOpsNodeControls {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}

    const controls: PandaOpsNodeControls = {}
    for (const [uuid, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        continue
      const source = raw as Record<string, unknown>
      const maintenanceUntil = validUntil(source.maintenanceUntil, now)
      const silenceUntil = validUntil(source.silenceUntil, now)
      if (maintenanceUntil || silenceUntil)
        controls[uuid] = { maintenanceUntil, silenceUntil }
    }
    return controls
  }
  catch {
    return {}
  }
}

export function serializePandaOpsNodeControls(value: PandaOpsNodeControls): string {
  return JSON.stringify(value)
}

export function updatePandaOpsNodeControl(
  controls: PandaOpsNodeControls,
  uuid: string,
  key: keyof PandaOpsNodeControl,
  until?: number,
): PandaOpsNodeControls {
  const next = { ...controls }
  const control = { ...next[uuid] }
  if (until)
    control[key] = until
  else
    delete control[key]

  if (control.maintenanceUntil || control.silenceUntil)
    next[uuid] = control
  else
    delete next[uuid]
  return next
}

export function formatNodeControlRemaining(until: number, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000))
  if (minutes < 60)
    return `${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24)
    return `${hours} 小时`
  return `${Math.ceil(hours / 24)} 天`
}
