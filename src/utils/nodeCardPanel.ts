import type { NodeData } from '@/stores/nodes'

export type NodeCardPanelMode
  = | 'auto'
    | 'carrier'
    | 'ping'
    | 'system'
    | 'traffic'
    | 'storage'
    | 'gpu'
    | 'compact'

export type NodeCardPanelDefaultMode = Exclude<NodeCardPanelMode, 'ping'>

export interface NodeCardPanelConfig {
  mode: NodeCardPanelMode
  pingTasks?: string[]
}

export type NodeCardPanelConfigs = Record<string, NodeCardPanelConfig>

export const NODE_CARD_PANEL_OPTIONS: ReadonlyArray<{ value: NodeCardPanelMode, label: string }> = [
  { value: 'auto', label: '自动选择' },
  { value: 'carrier', label: '三网质量' },
  { value: 'ping', label: '自定义 Ping' },
  { value: 'system', label: '系统状态' },
  { value: 'traffic', label: '流量状态' },
  { value: 'storage', label: '存储状态' },
  { value: 'gpu', label: 'GPU 状态' },
  { value: 'compact', label: '精简信息' },
]

const PANEL_MODES = new Set<NodeCardPanelMode>(NODE_CARD_PANEL_OPTIONS.map(option => option.value))
const MAX_NODE_PANEL_CONFIGS = 5_000
const MAX_PING_TASKS = 3
const MAX_TASK_NAME_LENGTH = 160
const STORAGE_ROLE_PATTERN = /storage|backup|archive|nas|存储|备份|归档/
const UNSAFE_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function isNodeCardPanelMode(value: unknown): value is NodeCardPanelMode {
  return typeof value === 'string' && PANEL_MODES.has(value as NodeCardPanelMode)
}

export function isNodeCardPanelDefaultMode(value: unknown): value is NodeCardPanelDefaultMode {
  return isNodeCardPanelMode(value) && value !== 'ping'
}

function normalizePingTasks(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return [...new Set(value
    .filter((task): task is string => typeof task === 'string')
    .map(task => task.trim())
    .filter(task => task.length > 0 && task.length <= MAX_TASK_NAME_LENGTH))]
    .slice(0, MAX_PING_TASKS)
}

export function parseNodeCardPanelConfigs(value: unknown): NodeCardPanelConfigs {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {}

    const result: NodeCardPanelConfigs = {}
    for (const [uuid, raw] of Object.entries(parsed).slice(0, MAX_NODE_PANEL_CONFIGS)) {
      if (!uuid.trim() || UNSAFE_CONFIG_KEYS.has(uuid) || !raw || typeof raw !== 'object' || Array.isArray(raw))
        continue
      const source = raw as Record<string, unknown>
      if (!isNodeCardPanelMode(source.mode))
        continue
      const pingTasks = normalizePingTasks(source.pingTasks)
      result[uuid] = pingTasks.length ? { mode: source.mode, pingTasks } : { mode: source.mode }
    }
    return result
  }
  catch {
    return {}
  }
}

export function serializeNodeCardPanelConfigs(configs: NodeCardPanelConfigs): string {
  return JSON.stringify(configs)
}

export function updateNodeCardPanelConfig(
  configs: NodeCardPanelConfigs,
  uuid: string,
  config?: NodeCardPanelConfig,
): NodeCardPanelConfigs {
  const next = { ...configs }
  if (!uuid.trim() || UNSAFE_CONFIG_KEYS.has(uuid))
    return next
  if (!config) {
    delete next[uuid]
    return next
  }

  const pingTasks = normalizePingTasks(config.pingTasks)
  next[uuid] = pingTasks.length ? { mode: config.mode, pingTasks } : { mode: config.mode }
  return next
}

function hasStorageRole(node: NodeData): boolean {
  const searchable = [node.name, node.tags, node.public_remark, ...node.groups].join(' ').toLowerCase()
  return STORAGE_ROLE_PATTERN.test(searchable)
}

export function resolveNodeCardPanelMode(
  node: NodeData,
  config: NodeCardPanelConfig,
  carrierTasksAvailable: boolean,
  carrierTasksLoading = false,
): Exclude<NodeCardPanelMode, 'auto'> {
  if (config.mode !== 'auto')
    return config.mode
  if (node.gpu > 0 || Boolean(node.gpu_name?.trim()))
    return 'gpu'
  if (config.pingTasks?.length)
    return 'ping'
  if (carrierTasksAvailable || carrierTasksLoading)
    return 'carrier'
  if (node.traffic_limit > 0)
    return 'traffic'
  if (hasStorageRole(node))
    return 'storage'
  return 'system'
}

export function nodeCardPanelModeLabel(mode: NodeCardPanelMode): string {
  return NODE_CARD_PANEL_OPTIONS.find(option => option.value === mode)?.label ?? '三网质量'
}
