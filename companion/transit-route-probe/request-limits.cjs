'use strict'

/** Per authenticated node, bounded memory; never key this by raw tokens or public input. */
class ClientRequestLimiter {
  constructor(now = Date.now) {
    this.now = now
    this.clients = new Map()
    this.lastCleanupAt = 0
  }

  take(client, kind) {
    const now = this.now()
    // Even at capacity, never turn a rejected request into a full-map scan.
    if (now - this.lastCleanupAt >= 60000) {
      for (const [key, value] of this.clients) {
        if (now - value.seenAt >= 600000)
          this.clients.delete(key)
      }
      this.lastCleanupAt = now
    }
    let state = this.clients.get(client)
    if (!state) {
      if (this.clients.size >= 5000)
        return 60
      state = { seenAt: now }
      this.clients.set(client, state)
    }
    state.seenAt = now
    const capacity = kind === 'poll' ? 6 : 8
    const interval = kind === 'poll' ? 5000 : 15000
    const bucket = state[kind] || { tokens: capacity, at: now }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) / interval)
    bucket.at = now
    state[kind] = bucket
    if (bucket.tokens < 1)
      return Math.max(1, Math.ceil((1 - bucket.tokens) * interval / 1000))
    bucket.tokens -= 1
    return 0
  }
}

module.exports = { ClientRequestLimiter }
