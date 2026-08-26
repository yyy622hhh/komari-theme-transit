import type { MaybeRefOrGetter } from 'vue'
import type { CarrierProbeCandidate, CarrierProbeHealth, CarrierProbeMigrationResult } from '@/services/carrier-probe.service'
import type { NodeData } from '@/stores/nodes'
import { computed, ref, toValue } from 'vue'
import {
  buildCarrierProbeCandidate,
  cleanupStaleTransitCanaries,
  currentCarrierProbeCandidate,
  loadCarrierProbeHealth,
  migrateCarrierProbeTask,
  validateCarrierProbeCandidate,
} from '@/services/carrier-probe.service'

export function useCarrierProbeHealthCenter(nodes: MaybeRefOrGetter<NodeData[]>) {
  const health = ref<CarrierProbeHealth[]>([])
  const loading = ref(false)
  const error = ref('')
  const activeKey = ref('')
  const results = ref<Record<string, CarrierProbeCandidate>>({})
  const migration = ref<CarrierProbeMigrationResult | null>(null)

  const onlineNodeIds = computed(() => toValue(nodes).filter(node => node.online).map(node => node.uuid))
  const nodeNames = computed(() => new Map(toValue(nodes).map(node => [node.uuid, node.name || node.uuid])))

  async function refresh(cleanup = false): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      if (cleanup)
        await cleanupStaleTransitCanaries()
      health.value = await loadCarrierProbeHealth(toValue(nodes).map(node => ({ uuid: node.uuid, name: node.name || node.uuid, online: node.online })))
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '读取监测目标健康失败'
    }
    finally {
      loading.value = false
    }
  }

  async function verify(item: CarrierProbeHealth, candidate: CarrierProbeCandidate): Promise<void> {
    if (!item.task)
      return
    activeKey.value = item.key
    error.value = ''
    migration.value = null
    try {
      const result = await validateCarrierProbeCandidate(item.key, item.task, candidate, onlineNodeIds.value)
      results.value = { ...results.value, [item.key]: result }
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : '验证候选目标失败'
    }
    finally {
      activeKey.value = ''
    }
  }

  async function verifyCustom(item: CarrierProbeHealth, type: 'icmp' | 'tcp', host: string, port?: number): Promise<boolean> {
    const candidate = buildCarrierProbeCandidate(type, host, port, 'custom')
    if (!candidate) {
      error.value = type === 'tcp' ? '请输入有效的 IPv4/主机名和 1–65535 端口。' : '请输入有效的 IPv4 或主机名；此版本不验证 IPv6。'
      return false
    }
    await verify(item, candidate)
    return true
  }

  async function migrate(item: CarrierProbeHealth): Promise<void> {
    const candidate = results.value[item.key]
    if (!item.task || !candidate?.migratable)
      return
    activeKey.value = item.key
    error.value = ''
    migration.value = await migrateCarrierProbeTask(item.task, candidate)
    if (migration.value.ok) {
      const next = { ...results.value }
      delete next[item.key]
      results.value = next
      await refresh()
    }
    activeKey.value = ''
  }

  async function rebuild(item: CarrierProbeHealth): Promise<void> {
    if (!item.task)
      return
    const candidate = currentCarrierProbeCandidate(item.task)
    if (!candidate) {
      error.value = '当前任务类型不是受支持的 ICMP/TCP。'
      return
    }
    activeKey.value = item.key
    error.value = ''
    migration.value = await migrateCarrierProbeTask(item.task, candidate)
    if (migration.value.ok)
      await refresh()
    activeKey.value = ''
  }

  function reset(): void {
    health.value = []
    error.value = ''
    activeKey.value = ''
    results.value = {}
    migration.value = null
  }

  return {
    health,
    loading,
    error,
    activeKey,
    results,
    migration,
    nodeNames,
    refresh,
    verify,
    verifyCustom,
    migrate,
    rebuild,
    reset,
  }
}
