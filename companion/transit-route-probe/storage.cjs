'use strict'

function mergeHelpers(saved, current) {
  const helpers = new Map()
  // Live state was collected after startup: only fields it actually reported supersede disk.
  // In particular a heartbeat is not a probe result, while an explicit null error clears one.
  const fields = ['client', 'helperSeenAt', 'helperVersion', 'lastJobAt', 'lastSuccessAt', 'lastError', 'lastDurationMs']
  for (const helper of [...saved, ...current]) {
    if (!helper || typeof helper.client !== 'string')
      continue
    const merged = { ...helpers.get(helper.client) }
    for (const field of fields) {
      if (helper[field] !== undefined)
        merged[field] = helper[field]
    }
    helpers.set(helper.client, merged)
  }
  return [...helpers.values()]
}

/** Injected filesystem and clock keep failure/recovery tests executable without root. */
class StorageCheckpoint {
  constructor({ fs, path, directory, coordinator, now = Date.now, warn = () => {} }) {
    this.fs = fs
    this.path = path
    this.directory = directory
    this.coordinator = coordinator
    this.now = now
    this.warn = warn
    this.file = directory ? path.join(directory, 'state-v1.json') : ''
    this.restored = false
    this.failures = 0
    this.nextAttemptAt = 0
    this.health = { status: directory ? 'degraded' : 'unavailable', last_success_at: null, last_error: directory ? null : 'storage-unavailable', recovered_from_corrupt: false }
    if (!directory)
      warn('[route-probe] storage unavailable; restart may lose unsaved state')
  }

  failure(error) {
    const code = String((error && error.code) || '')
    const message = String((error && error.message) || '').toLowerCase()
    const category = code === 'EACCES' || code === 'EPERM' || message.includes('permission denied')
      ? 'permission-denied'
      : code === 'ENOSPC' || message.includes('no space') ? 'no-space' : 'io-error'
    if (this.health.last_error !== category)
      this.warn(`[route-probe] storage degraded: ${category}; restart may lose unsaved state`)
    this.health.status = 'degraded'
    this.health.last_error = category
    this.nextAttemptAt = this.now() + [15000, 30000, 60000][Math.min(this.failures++, 2)]
  }

  restore() {
    if (!this.file || this.now() < this.nextAttemptAt)
      return
    try {
      if (this.fs.existsSync(this.file)) {
        // Read errors are not corrupt JSON. Preserve the source and retry restoration later.
        const source = this.fs.readFileSync(this.file, 'utf8')
        const current = this.coordinator.exportState()
        try {
          const loaded = JSON.parse(source)
          if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.jobs) || !Array.isArray(loaded.batches) || !Array.isArray(loaded.helpers))
            throw new Error('invalid state')
          // Requests may have created work while a read permission failure was backing off.
          const merge = (old, live, key) => [...new Map([...old, ...live].filter(Boolean).map(value => [value[key], value])).values()]
          this.coordinator.importState({ ...loaded, jobs: merge(loaded.jobs, current.jobs, 'id'), batches: merge(loaded.batches, current.batches, 'id'), helpers: mergeHelpers(loaded.helpers, current.helpers) })
        }
        catch {
          this.fs.renameSync(this.file, this.path.join(this.directory, `state-v1.corrupt-${this.now()}.json`))
          this.coordinator.importState(current)
          this.health.recovered_from_corrupt = true
          this.warn('[route-probe] corrupt state preserved; started with empty state')
        }
      }
      this.restored = true
    }
    catch (error) { this.failure(error) }
  }

  persist(force = false) {
    if (!this.file || (!force && this.now() < this.nextAttemptAt))
      return
    if (!this.restored) {
      // Never overwrite an unreadable state file with a new empty snapshot.
      this.restore()
      if (!this.restored)
        return
    }
    const temporary = `${this.file}.tmp`
    try {
      this.fs.mkdirSync(this.directory, { recursive: true })
      // A pre-existing temp file may have broader permissions; mode only applies on creation.
      if (this.fs.existsSync(temporary))
        this.fs.unlinkSync(temporary)
      this.fs.writeFileSync(temporary, JSON.stringify(this.coordinator.exportState()), { encoding: 'utf8', mode: 0o600 })
      this.fs.renameSync(temporary, this.file)
      this.coordinator.markStatePersisted()
      if (this.health.last_error)
        this.warn('[route-probe] storage recovered')
      this.health.status = 'healthy'
      this.health.last_error = null
      this.health.last_success_at = this.now()
      this.failures = 0
      this.nextAttemptAt = 0
    }
    catch (error) {
      try {
        this.fs.unlinkSync(temporary)
      }
      catch {}
      this.failure(error)
    }
  }

  checkpoint() {
    if (this.coordinator.hasTaskStateChanges() || this.health.status !== 'healthy'
      || this.health.last_success_at === null || this.now() - this.health.last_success_at >= 60000) {
      this.persist()
    }
  }

  snapshot() { return { ...this.health } }
}

module.exports = { StorageCheckpoint }
