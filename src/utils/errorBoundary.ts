import type { App } from 'vue'
import { logAppError } from '@/utils/safeError'

const ERROR_NOTICE_COOLDOWN_MS = 5_000

export function installGlobalErrorHandler(app: App): () => void {
  let lastNoticeAt = 0
  app.config.errorHandler = (error, _instance, info) => {
    logAppError(`Vue error (${info})`, error)
    const now = Date.now()
    if (now - lastNoticeAt >= ERROR_NOTICE_COOLDOWN_MS) {
      lastNoticeAt = now
      window.$message?.error('页面发生异常，请刷新后重试。')
    }
  }

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    logAppError('Unhandled promise rejection', event.reason)
    event.preventDefault()
  }
  const handleWindowError = (event: ErrorEvent) => {
    logAppError('Unhandled window error', event.error ?? event.message)
    event.preventDefault()
  }

  window.addEventListener('unhandledrejection', handleUnhandledRejection)
  window.addEventListener('error', handleWindowError)
  return () => {
    window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    window.removeEventListener('error', handleWindowError)
  }
}
