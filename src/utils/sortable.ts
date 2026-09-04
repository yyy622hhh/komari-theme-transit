import type { Options } from 'sortablejs'
import Sortable from 'sortablejs'

export type { SortableEvent } from 'sortablejs'

export function createSortable(element: HTMLElement, options: Options): Sortable {
  return Sortable.create(element, options)
}
