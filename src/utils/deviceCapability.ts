export interface WebglSupport {
  webgl2: boolean
  webgl1: boolean
}

/** WebGL2/1 上下文是否可用。用完即丢一个离屏 canvas，不留任何全局状态。 */
export function detectWebglSupport(): WebglSupport {
  if (typeof document === 'undefined')
    return { webgl2: false, webgl1: false }
  try {
    const canvas = document.createElement('canvas')
    const gl2 = canvas.getContext('webgl2')
    gl2?.getExtension('WEBGL_lose_context')?.loseContext()
    if (gl2)
      return { webgl2: true, webgl1: true }
    const gl1 = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')
    return { webgl2: false, webgl1: Boolean(gl1) }
  }
  catch {
    return { webgl2: false, webgl1: false }
  }
}

/**
 * 粗略的低算力/移动设备判断，用于把默认的写实地球换成更轻的点阵地球。不追求
 * 100% 准确——猜错的代价只是「本可以用更好看的地球，用了轻量版」，不是功能损坏，
 * 所以宁可判断宽松一点（触屏设备也算），也不引入更复杂的基准测试。
 */
export function isLowPowerDevice(): boolean {
  if (typeof navigator === 'undefined')
    return false
  const cores = navigator.hardwareConcurrency ?? 8
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  return cores <= 4 || reducedMotion || coarsePointer
}
