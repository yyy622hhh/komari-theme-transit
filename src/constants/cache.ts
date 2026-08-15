import { TIME_MS } from './time'

export const CACHE_CONFIG = {
  pingRecords: {
    maxSize: 500,
    ttl: 30 * TIME_MS.minute,
    localStorageMaxSize: 200,
  },
  loadRecords: {
    maxSize: 32,
    ttl: 30 * TIME_MS.minute,
  },
  publicPingTasks: {
    maxSize: 1,
    ttl: TIME_MS.minute,
  },
  providerMetadata: {
    maxSize: 1000,
    ttl: TIME_MS.day,
  },
  request: {
    ttl: 5 * TIME_MS.minute,
  },
  promise: {
    ttl: 30 * TIME_MS.second,
  },
  cleanup: {
    interval: 5 * TIME_MS.minute,
  },
} as const
