import { readonly, shallowRef } from 'vue'

export type MessageKind = 'success' | 'error' | 'warning' | 'info'

export interface MessageItem {
  id: number
  kind: MessageKind
  text: string
}

export interface MessageApi {
  success: (msg: string) => void
  error: (msg: string) => void
  warning: (msg: string) => void
  info: (msg: string) => void
}

const MESSAGE_DURATION_MS = 4_000
const MAX_VISIBLE_MESSAGES = 4
const items = shallowRef<MessageItem[]>([])
let nextMessageId = 0

export const messageItems = readonly(items)

export function dismissMessage(id: number): void {
  items.value = items.value.filter(item => item.id !== id)
}

function show(kind: MessageKind, text: string): void {
  const id = ++nextMessageId
  items.value = [...items.value, { id, kind, text }].slice(-MAX_VISIBLE_MESSAGES)
  globalThis.setTimeout(dismissMessage, MESSAGE_DURATION_MS, id)
}

export const message: MessageApi = {
  success: (msg: string) => show('success', msg),
  error: (msg: string) => show('error', msg),
  warning: (msg: string) => show('warning', msg),
  info: (msg: string) => show('info', msg),
}
