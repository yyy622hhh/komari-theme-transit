import type { AdminPingTask } from '@/services/ping-task.model'
import { deleteTopologyPingTasks, loadAdminPingTasks } from '@/services/ping-task.service'
import { forgetCreatedTopologyTask, matchesCreatedTopologyTask } from '@/utils/topologyTaskSnapshot'
import { recordTopologyWrite } from '@/utils/topologyWriteLog'

interface CleanupOperations {
  loadTasks: () => Promise<AdminPingTask[]>
  deleteTasks: (ids: readonly number[]) => Promise<boolean>
}

/** All topology retirement AND compensation use this boundary. Carrier migration has its own snapshots. */
export async function deleteOwnedTopologyPingTasks(
  taskIds: readonly number[],
  ops: CleanupOperations = {
    // A fresh load revalidates administrator permission before inspecting private tasks.
    loadTasks: () => loadAdminPingTasks({ fresh: true }),
    deleteTasks: ids => deleteTopologyPingTasks(ids),
  },
  trigger: 'manual' | 'auto' = 'manual',
): Promise<boolean> {
  const ids = [...new Set(taskIds.filter(id => Number.isInteger(id) && id > 0))]
  if (!ids.length)
    return true
  try {
    const live = await ops.loadTasks()
    const existing = live.filter(task => ids.includes(task.id!))
    const protectedIds = existing.filter(task => !matchesCreatedTopologyTask(task)).map(task => task.id!)
    if (protectedIds.length) {
      recordTopologyWrite({ trigger, action: '保护无法确认所有权的探测任务', outcome: 'failed', detail: `任务 ${protectedIds.join('、')} 已改变或缺少创建快照；本批未删除，请到 Komari 后台人工核对。` })
      return false
    }
    if (existing.length && !await ops.deleteTasks(existing.map(task => task.id!))) {
      // A lost delete response is not proof of failure or success.
      if ((await ops.loadTasks()).some(task => ids.includes(task.id!)))
        return false
    }
    for (const id of ids)
      forgetCreatedTopologyTask(id)
    return true
  }
  catch {
    return false
  }
}
