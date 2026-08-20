export interface NodeControl {
  maintenanceUntil?: number
  silenceUntil?: number
}

export type NodeControls = Record<string, NodeControl>

function validUntil(value: unknown, now: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > now ? value : undefined
}

export function parseNodeControls(value: unknown, now = Date.now()): NodeControls {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}

    const controls: NodeControls = {}
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

export function serializeNodeControls(value: NodeControls): string {
  return JSON.stringify(value)
}

function readNodeControlMap(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    return parsed as Record<string, unknown>
  }
  catch {
    return null
  }
}

function overlayNodeControl(raw: unknown, next: NodeControl): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {}
  if (next.maintenanceUntil)
    base.maintenanceUntil = next.maintenanceUntil
  else
    delete base.maintenanceUntil
  if (next.silenceUntil)
    base.silenceUntil = next.silenceUntil
  else
    delete base.silenceUntil
  return base
}

/** 在服务端原图上做增量修改，保留当前主题不认识的节点条目和额外字段。 */
export function mergeNodeControls(
  raw: unknown,
  apply: (current: NodeControls) => NodeControls,
  now = Date.now(),
): Record<string, unknown> {
  const rawMap = readNodeControlMap(raw) ?? {}
  const current = parseNodeControls(rawMap, now)
  const next = apply(current)
  const merged: Record<string, unknown> = {}

  for (const [uuid, value] of Object.entries(rawMap)) {
    if (!uuid.trim())
      continue
    if (Object.hasOwn(current, uuid) && !Object.hasOwn(next, uuid))
      continue
    merged[uuid] = Object.hasOwn(next, uuid) ? overlayNodeControl(value, next[uuid]!) : value
  }
  for (const [uuid, control] of Object.entries(next)) {
    if (!Object.hasOwn(merged, uuid))
      merged[uuid] = control
  }
  return merged
}

export function updateNodeControl(
  controls: NodeControls,
  uuid: string,
  key: keyof NodeControl,
  until?: number,
): NodeControls {
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
