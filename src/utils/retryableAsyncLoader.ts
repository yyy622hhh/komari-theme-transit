/**
 * Cache a successful async module/value load while allowing a later call to
 * retry after a transient failure. Concurrent callers still share one attempt.
 */
export function createRetryableAsyncLoader<T>(loader: () => Promise<T>): () => Promise<T> {
  let loaded = false
  let value: T
  let pending: Promise<T> | null = null

  return function load(): Promise<T> {
    if (loaded)
      return Promise.resolve(value)
    if (pending)
      return pending

    const attempt = Promise.resolve()
      .then(loader)
      .then((result) => {
        value = result
        loaded = true
        return result
      })
      .finally(() => {
        if (pending === attempt)
          pending = null
      })
    pending = attempt
    return attempt
  }
}
