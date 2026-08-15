import type { MaybeRefOrGetter, Ref } from 'vue'
import { ref, toValue } from 'vue'

interface OrderMoveFeedbackOptions<T> {
  items: MaybeRefOrGetter<readonly T[]>
  getId: (item: T) => string
  getLabel: (item: T) => string
  move: (fromIndex: number, toIndex: number) => void
}

export function resolveOrderMoveTarget(key: string, fromIndex: number, length: number): number | null {
  if (key === 'ArrowUp')
    return fromIndex > 0 ? fromIndex - 1 : null
  if (key === 'ArrowDown')
    return fromIndex + 1 < length ? fromIndex + 1 : null
  if (key === 'Home')
    return fromIndex > 0 ? 0 : null
  if (key === 'End')
    return fromIndex + 1 < length ? length - 1 : null
  return null
}

export function useOrderMoveFeedback<T>(options: OrderMoveFeedbackOptions<T>): {
  announcement: Ref<string>
  handleKeydown: (event: KeyboardEvent, item: T) => void
  moveWithFeedback: (fromIndex: number, toIndex: number) => void
  resetAnnouncement: () => void
} {
  const announcement = ref('')

  function resetAnnouncement(): void {
    announcement.value = ''
  }

  function moveWithFeedback(fromIndex: number, toIndex: number): void {
    const items = toValue(options.items)
    const item = items[fromIndex]
    if (!item || fromIndex === toIndex || toIndex < 0 || toIndex >= items.length)
      return

    options.move(fromIndex, toIndex)
    announcement.value = `${options.getLabel(item)} 已移动到第 ${toIndex + 1} 位，共 ${items.length} 位。`
  }

  function handleKeydown(event: KeyboardEvent, item: T): void {
    const items = toValue(options.items)
    const itemId = options.getId(item)
    const fromIndex = items.findIndex(candidate => options.getId(candidate) === itemId)
    if (fromIndex < 0)
      return

    const toIndex = resolveOrderMoveTarget(event.key, fromIndex, items.length)
    if (toIndex === null)
      return
    event.preventDefault()
    moveWithFeedback(fromIndex, toIndex)
  }

  return {
    announcement,
    handleKeydown,
    moveWithFeedback,
    resetAnnouncement,
  }
}
