export interface AsyncGeneration {
  begin: () => number
  isCurrent: (generation: number) => boolean
  invalidate: () => void
  dispose: () => void
}

/**
 * Creates a lightweight commit gate for async work that cannot safely abort a
 * shared request. Starting newer work invalidates every older generation, and
 * disposal permanently prevents late results from being published.
 */
export function createAsyncGeneration(): AsyncGeneration {
  let currentGeneration = 0
  let disposed = false

  return {
    begin() {
      currentGeneration += 1
      return currentGeneration
    },
    isCurrent(generation) {
      return !disposed && generation === currentGeneration
    },
    invalidate() {
      currentGeneration += 1
    },
    dispose() {
      disposed = true
      currentGeneration += 1
    },
  }
}
