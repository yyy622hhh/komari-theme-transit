import type { MaybeRefOrGetter } from 'vue'
import type { NodeData } from '@/stores/nodes'
import { ref, toValue } from 'vue'
import { loadAdminPingTaskNamesForNode } from '@/services/ping-task.service'
import { resolveTopologyNode } from '@/utils/topologyHelper'

export interface TopologyTaskLoadResult {
  tasks: string[]
  error: string
}

/**
 * 按线路机名字缓存「这台机器上有哪些可用 Ping 任务」，供入口任务匹配和第 2
 * 段规划共用。生命周期跟拓扑管理对话框走：每次重开都要 `reset()`。
 */
export function useTopologyTaskCatalog(
  nodes: MaybeRefOrGetter<NodeData[]>,
  isAmbiguousNodeName: (name: string) => boolean,
  onRequestSettled?: () => void,
) {
  const taskOptions = ref<Record<string, string[]>>({})
  const taskErrors = ref<Record<string, string>>({})
  const taskLoaded = ref<Record<string, boolean>>({})
  const taskRequests = new Map<string, Promise<TopologyTaskLoadResult>>()
  let generation = 0
  let refreshedGeneration = -1

  function reset(): void {
    generation += 1
    taskOptions.value = {}
    taskErrors.value = {}
    taskLoaded.value = {}
    taskRequests.clear()
    refreshedGeneration = -1
  }

  async function loadTasks(nodeName: string, nodeUuid = ''): Promise<TopologyTaskLoadResult> {
    const node = resolveTopologyNode(toValue(nodes), nodeName, nodeUuid)
    if (!node && isAmbiguousNodeName(nodeName))
      return { tasks: [], error: '节点名称重复，无法唯一读取 Ping 任务。' }
    if (!node)
      return { tasks: [], error: '' }
    const pending = taskRequests.get(node.uuid)
    if (pending)
      return pending
    if (!taskOptions.value[node.uuid])
      taskLoaded.value = { ...taskLoaded.value, [node.uuid]: false }
    taskErrors.value = { ...taskErrors.value, [node.uuid]: '' }
    const requestGeneration = generation
    const needsRefresh = refreshedGeneration !== requestGeneration

    const request = Promise.resolve().then(async () => {
      try {
        const tasks = await loadAdminPingTaskNamesForNode(node.uuid, needsRefresh
          ? { fresh: true, requestKey: `admin:ping:list:catalog:${requestGeneration}` }
          : {})
        if (requestGeneration !== generation)
          return { tasks: [], error: '' }
        if (needsRefresh)
          refreshedGeneration = requestGeneration
        taskOptions.value = { ...taskOptions.value, [node.uuid]: tasks }
        taskLoaded.value = { ...taskLoaded.value, [node.uuid]: true }
        return { tasks, error: '' }
      }
      catch (error) {
        if (requestGeneration !== generation)
          return { tasks: [], error: '' }
        const detail = error instanceof Error ? error.message : ''
        const message = detail.includes('登录状态已过期')
          ? detail
          : '无法读取 Ping 任务，请稍后重试。'
        taskErrors.value = {
          ...taskErrors.value,
          [node.uuid]: message,
        }
        return { tasks: [], error: message }
      }
      finally {
        if (taskRequests.get(node.uuid) === request)
          taskRequests.delete(node.uuid)
        if (requestGeneration === generation)
          onRequestSettled?.()
      }
    })
    taskRequests.set(node.uuid, request)
    return request
  }

  function rememberTask(sourceUuid: string, taskName: string): void {
    if (!sourceUuid || !taskName)
      return
    taskOptions.value = {
      ...taskOptions.value,
      [sourceUuid]: [...new Set([...(taskOptions.value[sourceUuid] ?? []), taskName])],
    }
    taskLoaded.value = { ...taskLoaded.value, [sourceUuid]: true }
  }

  return {
    taskOptions,
    taskErrors,
    taskLoaded,
    reset,
    loadTasks,
    rememberTask,
  }
}
