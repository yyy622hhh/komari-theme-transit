import type { NodeData } from '@/stores/nodes'
import type { CreatePingTaskResponse } from '@/utils/rpc'
import { invalidatePublicPingTasks } from '@/services/metrics.service'
import { requestManager } from '@/services/request.service'
import { getSharedRpc } from '@/utils/rpc'

export interface TopologyTaskCreationResult extends CreatePingTaskResponse {
  name: string
}

export function topologyPingTaskName(source: Pick<NodeData, 'name'>, target: Pick<NodeData, 'name'>): string {
  return `Transit-${source.name.trim()}-to-${target.name.trim()}`
}

function targetAddress(target: NodeData): string {
  return target.ipv4?.trim() || target.ipv6?.trim() || ''
}

/**
 * Creates the only live hop required by the simple topology form.
 *
 * ICMP is used because the theme knows each node's public IP, but not a
 * reliable TCP service port. This makes the generated task usable without
 * another configuration screen.
 */
export async function createTopologyPingTask(source: NodeData, target: NodeData): Promise<TopologyTaskCreationResult> {
  const name = topologyPingTaskName(source, target)
  const targetIp = targetAddress(target)
  if (source.uuid === target.uuid)
    throw new Error('线路机和落地机不能是同一台节点。')
  if (!source.uuid.trim())
    throw new Error('线路机没有有效的 Komari 节点标识。')
  if (!targetIp)
    throw new Error(`落地机“${target.name}”没有公网 IP，无法自动创建任务。`)

  const task = await requestManager.run(
    `topology:ping-task:${source.uuid}:${target.uuid}:${name}`,
    signal => getSharedRpc().createPingTask({
      clients: [source.uuid],
      default_on: false,
      name,
      target: targetIp,
      type: 'icmp',
      interval: 30,
    }, signal),
    // Retrying a timed-out create could make duplicate Ping tasks.
    { retryAttempts: 0 },
  )

  invalidatePublicPingTasks()

  return { ...task, name }
}
