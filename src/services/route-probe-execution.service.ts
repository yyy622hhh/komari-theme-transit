import type { CompanionProbeJob } from '@/services/route-probe-companion.service'

interface CompanionFailureOutcome {
  status: 'helper-offline' | 'no-traceroute' | 'failed'
  detail: string
}

/** Keep plugin-side failures distinct from a helper that never accepted the job. */
export function classifyCompanionJobFailure(
  job: Pick<CompanionProbeJob, 'attempts' | 'error'>,
): CompanionFailureOutcome {
  if (job.error === 'no-traceroute')
    return { status: 'no-traceroute', detail: '节点助手未找到 traceroute' }
  if (job.error === 'invalid-city')
    return { status: 'failed', detail: '伴生插件不识别本次探测城市，请检查插件版本是否与主题匹配' }
  if (job.error === 'internal-error')
    return { status: 'failed', detail: '伴生插件处理任务时出现内部错误，请查看其日志' }
  if (job.attempts === 0)
    return { status: 'helper-offline', detail: '等待期间节点助手未领取任务，请检查安装或服务连接' }
  return { status: 'failed', detail: '节点助手未取得可用结果' }
}

export function waitForRouteProbe(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout>
    const abort = () => {
      clearTimeout(timeoutId)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
