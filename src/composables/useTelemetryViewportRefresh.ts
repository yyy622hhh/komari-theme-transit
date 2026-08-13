type ViewportRefresh = () => void

const refreshers = new Set<ViewportRefresh>()
let animationFrame = 0
let listening = false

function scheduleRefresh(): void {
  if (animationFrame)
    return
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0
    for (const refresh of refreshers)
      refresh()
  })
}

function startListening(): void {
  if (listening || typeof window === 'undefined')
    return
  listening = true
  window.addEventListener('resize', scheduleRefresh, { passive: true })
  window.addEventListener('scroll', scheduleRefresh, { passive: true, capture: true })
}

function stopListening(): void {
  if (!listening || refreshers.size)
    return
  listening = false
  window.removeEventListener('resize', scheduleRefresh)
  window.removeEventListener('scroll', scheduleRefresh, { capture: true })
  if (animationFrame) {
    window.cancelAnimationFrame(animationFrame)
    animationFrame = 0
  }
}

export function subscribeTelemetryViewportRefresh(refresh: ViewportRefresh): () => void {
  refreshers.add(refresh)
  startListening()

  let active = true
  return () => {
    if (!active)
      return
    active = false
    refreshers.delete(refresh)
    stopListening()
  }
}
