import { ref } from 'vue'

type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface MessageApi {
  success: (msg: string) => void
  error: (msg: string) => void
  warning: (msg: string) => void
  info: (msg: string) => void
}

/**
 * Toaster 容器是否已经有理由挂载。
 *
 * vue-sonner 在首屏包里值 10.7 KiB gzip，而绝大多数访问从进站到离开不会弹一条
 * 提示。这个标记在第一次真正要提示时才置位，`App.vue` 据此才去加载容器。
 */
export const toastContainerRequested = ref(false)

type ToastApi = Record<ToastKind, (message: string) => unknown>

let toastApi: ToastApi | null = null
let containerMounted = false
let loadStarted = false
const queue: Array<[ToastKind, string]> = []

/**
 * 只有「模块已加载」且「容器已挂载」两个条件同时满足才真正投递。
 *
 * 在容器挂载前调用 vue-sonner 的 toast() 会把提示写进一个还没有人渲染的队列，
 * 首条提示会静默丢失——而首条提示恰恰常常是保存失败这类必须让人看见的消息。
 */
function drain(): void {
  if (!toastApi || !containerMounted)
    return
  for (const [kind, msg] of queue.splice(0))
    toastApi[kind](msg)
}

/** 由 `App.vue` 在 Toaster 挂载完成后调用。 */
export function markToastContainerMounted(): void {
  containerMounted = true
  drain()
}

function show(kind: ToastKind, msg: string): void {
  queue.push([kind, msg])
  toastContainerRequested.value = true

  if (toastApi) {
    drain()
    return
  }
  if (loadStarted)
    return

  loadStarted = true
  void import('vue-sonner')
    .then((module) => {
      toastApi = module.toast as unknown as ToastApi
      drain()
    })
    .catch(() => {
      // 提示是尽力而为的附加信息，加载失败不能反过来影响主流程；清空积压
      // 避免它们无限期占着内存，并允许下一次提示重新尝试加载。
      queue.length = 0
      loadStarted = false
    })
}

export const message: MessageApi = {
  success: (msg: string) => show('success', msg),
  error: (msg: string) => show('error', msg),
  warning: (msg: string) => show('warning', msg),
  info: (msg: string) => show('info', msg),
}
