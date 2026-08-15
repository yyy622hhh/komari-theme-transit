import { NETWORK_CONFIG } from './network'

export const REQUEST_CONFIG = {
  timeout: {
    default: NETWORK_CONFIG.timeout.request,
  },
  retry: {
    attempts: NETWORK_CONFIG.retry.attempts,
    baseDelay: 250,
    maxDelay: 2_000,
    jitterRatio: 0.2,
  },
  pool: {
    maxConcurrent: NETWORK_CONFIG.concurrency.maxRequests,
  },
  metrics: {
    entityBatchSize: 50,
  },
} as const
