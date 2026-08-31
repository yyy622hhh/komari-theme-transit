import type { MaybeRefOrGetter } from 'vue'
import { onScopeDispose, ref, toValue, watch } from 'vue'
import { subscribeTelemetryViewportRefresh } from '@/composables/useTelemetryViewportRefresh'

/** Same-page navigation shares the sample tooltips' frame-throttled viewport listener. */
export function useDashboardSection(enabled: MaybeRefOrGetter<boolean>) {
  const activeSection = ref('network-overview')
  let stop: (() => void) | undefined

  function refresh() {
    const topology = document.getElementById('network-topology')
    const headerHeight = document.querySelector('.site-header')?.getBoundingClientRect().height ?? 64
    const top = topology?.getBoundingClientRect().top
    // A short final section cannot reach the header when the document hits its bottom.
    const atBottom = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2
    activeSection.value = top !== undefined && (top <= headerHeight + 32 || (atBottom && top < window.innerHeight))
      ? 'network-topology'
      : 'network-overview'
  }

  watch(() => toValue(enabled), (value) => {
    stop?.()
    stop = undefined
    activeSection.value = 'network-overview'
    if (value) {
      refresh()
      stop = subscribeTelemetryViewportRefresh(refresh)
    }
  }, { immediate: true, flush: 'post' })
  onScopeDispose(() => stop?.())
  return activeSection
}
