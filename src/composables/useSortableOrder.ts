import type { SortableEvent } from 'sortablejs'
import type { MaybeRefOrGetter, Ref } from 'vue'
import Sortable from 'sortablejs'
import { nextTick, onScopeDispose, toValue, watch } from 'vue'

export function useSortableOrder(
  containers: Array<Ref<HTMLElement | null>>,
  enabled: MaybeRefOrGetter<boolean>,
  onMove: (fromIndex: number, toIndex: number) => void,
): void {
  let instances: Sortable[] = []

  function destroyInstances(): void {
    instances.forEach(instance => instance.destroy())
    instances = []
  }

  function handleEnd(event: SortableEvent): void {
    const fromIndex = event.oldDraggableIndex ?? event.oldIndex
    const toIndex = event.newDraggableIndex ?? event.newIndex
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex)
      return

    onMove(fromIndex, toIndex)
  }

  watch(
    () => toValue(enabled),
    async (isEnabled, _previous, onCleanup) => {
      destroyInstances()
      if (!isEnabled)
        return

      let cancelled = false
      onCleanup(() => {
        cancelled = true
        destroyInstances()
      })

      await nextTick()
      if (cancelled)
        return

      instances = containers.flatMap((container) => {
        if (!container.value)
          return []
        return [Sortable.create(container.value, {
          animation: 160,
          chosenClass: 'server-order-chosen',
          delay: 120,
          delayOnTouchOnly: true,
          dragClass: 'server-order-drag',
          draggable: '[data-server-order-item]',
          fallbackOnBody: true,
          forceFallback: true,
          ghostClass: 'server-order-ghost',
          handle: '[data-order-drag-handle]',
          onEnd: handleEnd,
          swapThreshold: 0.65,
          touchStartThreshold: 4,
        })]
      })
    },
    { flush: 'post', immediate: true },
  )

  onScopeDispose(destroyInstances)
}
