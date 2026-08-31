export interface CompanionStorageHealth {
  status: 'healthy' | 'degraded' | 'unavailable'
  last_success_at: number | null
  last_error: 'permission-denied' | 'no-space' | 'io-error' | 'storage-unavailable' | null
  recovered_from_corrupt: boolean
}

export function parseCompanionStorage(input: unknown): CompanionStorageHealth | undefined {
  const value = input as Record<string, unknown> | null

  if (!value || typeof value !== 'object' || !['healthy', 'degraded', 'unavailable'].includes(String(value.status))
    || (value.last_success_at !== null && (typeof value.last_success_at !== 'number' || !Number.isFinite(value.last_success_at)))
    || (value.last_error !== null && !['permission-denied', 'no-space', 'io-error', 'storage-unavailable'].includes(String(value.last_error)))
    || typeof value.recovered_from_corrupt !== 'boolean') {
    return undefined
  }
  return { status: value.status as CompanionStorageHealth['status'], last_success_at: value.last_success_at as number | null, last_error: value.last_error as CompanionStorageHealth['last_error'], recovered_from_corrupt: value.recovered_from_corrupt }
}

export function companionStorageLabel(storage?: CompanionStorageHealth): string {
  if (!storage)
    return '存储状态未报告（旧插件兼容）'
  const labels = { healthy: '存储正常', degraded: '存储降级', unavailable: '存储不可用' }
  const errors = { 'permission-denied': '目录权限不足', 'no-space': '存储空间不足', 'io-error': '读写失败', 'storage-unavailable': '存储目录不可用' }
  return `${labels[storage.status]}${storage.last_error ? `：${errors[storage.last_error]}` : ''}${storage.status !== 'healthy' ? '；重启可能丢失未保存状态' : ''}${storage.recovered_from_corrupt ? '；曾从损坏文件恢复，副本已保留' : ''}`
}
