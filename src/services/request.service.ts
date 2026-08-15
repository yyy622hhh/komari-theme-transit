import { REQUEST_CONFIG } from '@/constants/request'

interface PendingRequest<T> {
  promise: Promise<T>
  controller: AbortController
  consumers: number
  settled: boolean
}

interface QueuedRequest<T> {
  key: string
  controller: AbortController
  task: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  timeout: number
  retryAttempts: number
  retryBaseDelay: number
  retryMaxDelay: number
  retryJitterRatio: number
  shouldRetry: (error: unknown) => boolean
}

export interface RequestManagerOptions {
  timeout?: number
  retryAttempts?: number
  retryBaseDelay?: number
  retryMaxDelay?: number
  retryJitterRatio?: number
  shouldRetry?: (error: unknown) => boolean
  signal?: AbortSignal
}

function createAbortError(message = 'Request aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted)
    return Promise.reject(createAbortError())

  let abort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(createAbortError())
    signal.addEventListener('abort', abort, { once: true })
  })

  return Promise.race([task, aborted])
    .finally(() => signal.removeEventListener('abort', abort))
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted)
    return Promise.reject(createAbortError())

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timeoutId)
      reject(createAbortError())
    }
    timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class RequestManager {
  private readonly pending = new Map<string, PendingRequest<unknown>>()
  private readonly queue: Array<QueuedRequest<unknown>> = []
  private activeCount = 0

  run<T>(key: string, task: (signal: AbortSignal) => Promise<T>, options: RequestManagerOptions = {}): Promise<T> {
    const existing = this.pending.get(key) as PendingRequest<T> | undefined
    if (existing)
      return this.consume(existing, options.signal)

    const controller = new AbortController()
    const timeout = options.timeout ?? REQUEST_CONFIG.timeout.default
    const retryAttempts = options.retryAttempts ?? REQUEST_CONFIG.retry.attempts
    const retryBaseDelay = options.retryBaseDelay ?? REQUEST_CONFIG.retry.baseDelay
    const retryMaxDelay = options.retryMaxDelay ?? REQUEST_CONFIG.retry.maxDelay
    const retryJitterRatio = options.retryJitterRatio ?? REQUEST_CONFIG.retry.jitterRatio
    const shouldRetry = options.shouldRetry ?? (() => true)

    const queuedPromise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        key,
        controller,
        task,
        resolve,
        reject,
        timeout,
        retryAttempts,
        retryBaseDelay,
        retryMaxDelay,
        retryJitterRatio,
        shouldRetry,
      } as QueuedRequest<unknown>)
      this.drainQueue()
    })
    const pending: PendingRequest<T> = {
      promise: queuedPromise,
      controller,
      consumers: 0,
      settled: false,
    }
    pending.promise = queuedPromise.finally(() => {
      pending.settled = true
      const current = this.pending.get(key)
      if (current?.controller === controller)
        this.pending.delete(key)
    })

    this.pending.set(key, pending)
    return this.consume(pending, options.signal)
  }

  abort(key: string): void {
    const pending = this.pending.get(key)
    if (!pending)
      return

    this.cancelPending(key, pending)
  }

  private consume<T>(pending: PendingRequest<T>, signal?: AbortSignal): Promise<T> {
    pending.consumers += 1
    let released = false
    const release = () => {
      if (released)
        return
      released = true
      pending.consumers = Math.max(0, pending.consumers - 1)
      if (pending.consumers === 0 && !pending.settled) {
        const entry = [...this.pending.entries()].find(([, current]) => current === pending)
        if (entry)
          this.cancelPending(entry[0], pending)
      }
    }

    const consumerPromise = signal
      ? raceWithAbort(pending.promise, signal)
      : pending.promise
    return consumerPromise.finally(release)
  }

  private cancelPending(key: string, pending: PendingRequest<unknown>): void {
    if (!pending.controller.signal.aborted)
      pending.controller.abort()
    if (this.pending.get(key) === pending)
      this.pending.delete(key)

    const index = this.queue.findIndex(request => request.controller === pending.controller)
    if (index < 0)
      return

    const [request] = this.queue.splice(index, 1)
    request?.reject(createAbortError())
  }

  abortAll(): void {
    for (const request of this.pending.values())
      request.controller.abort()

    for (const request of this.queue)
      request.reject(createAbortError())

    this.pending.clear()
    this.queue.length = 0
  }

  private drainQueue(): void {
    while (this.activeCount < REQUEST_CONFIG.pool.maxConcurrent && this.queue.length > 0) {
      const request = this.queue.shift()
      if (!request)
        return

      if (request.controller.signal.aborted) {
        request.reject(createAbortError())
        continue
      }

      this.startActiveRequest(request)
    }
  }

  private startActiveRequest<T>(request: QueuedRequest<T>): void {
    this.activeCount += 1
    void (async () => {
      try {
        await this.execute(request)
      }
      finally {
        this.activeCount = Math.max(0, this.activeCount - 1)
        this.drainQueue()
      }
    })()
  }

  private async execute<T>(request: QueuedRequest<T>): Promise<void> {
    try {
      const result = await this.runWithTimeoutAndRetry(request)
      request.resolve(result)
    }
    catch (error) {
      request.reject(error)
    }
  }

  private async runWithTimeoutAndRetry<T>(request: QueuedRequest<T>): Promise<T> {
    let lastError: unknown

    for (let attempt = 0; attempt <= request.retryAttempts; attempt++) {
      if (request.controller.signal.aborted)
        throw createAbortError()

      const attemptController = new AbortController()
      const abortAttempt = () => attemptController.abort()
      const timeoutId = setTimeout(() => attemptController.abort(createAbortError('Request timeout')), request.timeout)
      request.controller.signal.addEventListener('abort', abortAttempt, { once: true })

      try {
        return await raceWithAbort(request.task(attemptController.signal), attemptController.signal)
      }
      catch (error) {
        lastError = error
        if (request.controller.signal.aborted)
          throw error
        if (attempt >= request.retryAttempts || !request.shouldRetry(error))
          throw error
        const exponentialDelay = Math.min(request.retryBaseDelay * 2 ** attempt, request.retryMaxDelay)
        const jitter = exponentialDelay * request.retryJitterRatio * (Math.random() * 2 - 1)
        await waitForRetry(Math.max(0, Math.round(exponentialDelay + jitter)), request.controller.signal)
      }
      finally {
        clearTimeout(timeoutId)
        request.controller.signal.removeEventListener('abort', abortAttempt)
      }
    }

    throw lastError ?? new Error('Request failed')
  }
}

export const requestManager = new RequestManager()
