import type { MaybeRefOrGetter } from 'vue'
import type { CarrierOperationRecord } from '@/services/carrier-probe-operation.service'
import type { CarrierProbeCandidate, CarrierProbeHealth, CarrierProbeMigrationResult } from '@/services/carrier-probe.service'
import type { NodeData } from '@/stores/nodes'
import { storeToRefs } from 'pinia'
import { computed, toValue } from 'vue'
import { cleanupCarrierRecovery } from '@/services/carrier-probe-migration.service'
import { readCarrierOperations, reconcileCarrierOperation, saveCarrierOperation, supportsCarrierMutationLock } from '@/services/carrier-probe-operation.service'
import { buildCarrierProbeCandidate, cleanupStaleTransitCanaries, currentCarrierProbeCandidate, defaultCarrierProbeOperations, loadCarrierProbeHealth, migrateCarrierProbeTask, validateCarrierProbeCandidate } from '@/services/carrier-probe.service'
import { loadAdminPingTasks } from '@/services/ping-task.service'
import { useCarrierProbeStore } from '@/stores/carrierProbe'

export function useCarrierProbeHealthCenter(nodes: MaybeRefOrGetter<NodeData[]>) {
  const state = storeToRefs(useCarrierProbeStore())
  const { health, loading, error, activeKey, results, migration, operation, recovery } = state
  const onlineNodeIds = computed(() => toValue(nodes).filter(node => node.online).map(node => node.uuid))
  const nodeNames = computed(() => new Map(toValue(nodes).map(node => [node.uuid, node.name || node.uuid])))
  const mutationSupported = supportsCarrierMutationLock()

  async function refresh(cleanup = false, preserveError = false): Promise<void> {
    if (loading.value)
      return
    loading.value = true
    if (!preserveError)
      error.value = ''
    try {
      // Recovery is read-only, including on reload. Do not run the stale cleanup over its resources.
      const journals = readCarrierOperations().filter(record => record.id !== operation.value?.id
        && (record.phase !== 'done' || (record.kind === 'verify' && Date.now() - record.startedAt <= 30 * 60_000)))
      if (journals.length) {
        const tasks = await loadAdminPingTasks({ fresh: true })
        recovery.value = journals.filter(record => record.created.some(created => tasks.some(task => task.id === created.id)) || record.phase === 'creating' || record.uncertainCreation).map(record => reconcileCarrierOperation(record, tasks))
      }
      else {
        recovery.value = []
      }
      if (cleanup && !activeKey.value && !recovery.value.length) {
        await cleanupStaleTransitCanaries()
      }
      health.value = await loadCarrierProbeHealth(toValue(nodes).map(node => ({ uuid: node.uuid, name: node.name || node.uuid, online: node.online })))
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '读取监测目标健康失败' }
    finally { loading.value = false }
  }

  async function run(item: CarrierProbeHealth, kind: CarrierOperationRecord['kind'], work: (ops: typeof defaultCarrierProbeOperations) => Promise<void>): Promise<void> {
    if (!item.task || activeKey.value)
      return
    if (!currentCarrierProbeCandidate(item.task)) {
      error.value = '原任务必须使用有效的 ICMP/TCP IPv4 或主机名目标；不记录带凭据或不支持的目标。'
      return
    }
    activeKey.value = item.key
    error.value = ''
    migration.value = null
    const now = Date.now()
    const record: CarrierOperationRecord = { id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`, key: item.key, kind, original: { ...item.task, clients: [...item.task.clients] }, created: [], phase: 'checking', startedAt: now, updatedAt: now, message: '正在检查…' }
    const persist = () => {
      operation.value = { ...record, created: [...record.created] }
      saveCarrierOperation(record)
    }
    try {
      persist()
      await work({ ...defaultCarrierProbeOperations, isOnline: client => onlineNodeIds.value.includes(client), progress: (phase, message, created) => {
        record.phase = phase
        record.message = message
        record.updatedAt = Date.now()
        if (phase === 'creating')
          record.uncertainCreation = true
        if (created)
          record.uncertainCreation = false
        if (created && !record.created.some(task => task.id === created.id))
          record.created.push(created)
        persist()
      } })
      const outcome = migration.value as CarrierProbeMigrationResult | null
      record.phase = outcome && !outcome.ok ? 'failed' : 'done'
      record.message = outcome?.message ?? results.value[item.key]?.reason ?? '操作完成'
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '操作失败，请回查任务状态'
      record.phase = 'failed'
      record.message = error.value
    }
    finally {
      record.updatedAt = Date.now()
      try {
        persist()
      }
      catch { error.value = `${error.value} 本地操作记录保存失败，请回查后端任务。`.trim() }
      activeKey.value = ''
    }
  }

  async function verify(item: CarrierProbeHealth, candidate: CarrierProbeCandidate): Promise<void> {
    await run(item, 'verify', async (ops) => {
      results.value = { ...results.value, [item.key]: await validateCarrierProbeCandidate(item.key, item.task!, candidate, onlineNodeIds.value, ops) }
    })
  }

  async function verifyCustom(item: CarrierProbeHealth, type: 'icmp' | 'tcp', host: string, port?: number): Promise<boolean> {
    const candidate = buildCarrierProbeCandidate(type, host, port, 'custom')
    if (!candidate) {
      error.value = '请输入有效的 IPv4/主机名和 TCP 端口（1–65535）；不验证 IPv6。'
      return false
    }
    await verify(item, candidate)
    return !error.value
  }

  async function migrate(item: CarrierProbeHealth): Promise<void> {
    const candidate = results.value[item.key]
    if (!candidate?.migratable)
      return
    await run(item, 'migrate', async (ops) => {
      migration.value = await migrateCarrierProbeTask(item.task!, candidate, ops)
      if (migration.value.ok) {
        const next = { ...results.value }
        delete next[item.key]
        results.value = next
      }
    })
    await refresh(false, true)
  }

  async function rebuild(item: CarrierProbeHealth): Promise<void> {
    if (!item.task)
      return
    const candidate = currentCarrierProbeCandidate(item.task)
    if (!candidate) {
      error.value = '当前任务不是受支持的 ICMP/TCP。'
      return
    }
    await run(item, 'rebuild', async (ops) => {
      migration.value = await migrateCarrierProbeTask(item.task!, candidate, ops)
    })
    await refresh(false, true)
  }

  async function recover(record: CarrierOperationRecord): Promise<void> {
    if (activeKey.value)
      return
    activeKey.value = record.key
    try {
      const message = await cleanupCarrierRecovery(record, defaultCarrierProbeOperations)
      record.phase = 'done'
      record.message = message
      saveCarrierOperation(record)
      recovery.value = recovery.value.filter(item => item.id !== record.id)
      error.value = ''
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '清理未完成' }
    finally { activeKey.value = '' }
    await refresh(false, true)
  }

  // Opening a dialog must never reset an in-flight operation or its validated candidate.
  function reset(): void {
    if (!activeKey.value)
      error.value = ''
  }
  return { ...state, nodeNames, mutationSupported, refresh, verify, verifyCustom, migrate, rebuild, recover, reset }
}
