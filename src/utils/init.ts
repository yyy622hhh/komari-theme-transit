import { InitManager } from '@/utils/initManager'

export { calculatePollingInterval, shouldLogPollingFailure } from '@/utils/init.shared'
export type { InitConfig, InitManagerDependencies } from '@/utils/init.shared'
export { InitManager } from '@/utils/initManager'

let initManager: InitManager | null = null

export async function initApp(): Promise<void> {
  initManager ??= new InitManager()
  await initManager.init()
}

export async function retryInitApp(): Promise<boolean> {
  initManager ??= new InitManager()
  return initManager.retry()
}

export function getInitManager(): InitManager | null {
  return initManager
}

export function destroyInitManager(): void {
  if (!initManager)
    return
  initManager.destroy()
  initManager = null
}
