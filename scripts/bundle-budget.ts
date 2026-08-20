/**
 * 初始包体积预算的唯一定义。
 *
 * 两级语义：越过 target 立刻可见（警告），只有越过 hardLimit 才拦住发布。目标线
 * 是「该抽空瘦身了」的信号，硬限才是「这次不许合进去」。
 *
 * 之所以要抽出来：audit-bundle.ts 和 audit-performance.ts 曾经各自写着
 * `145 * 1024`，前者按两级处理、后者直接 throw，等于后者单方面把前者注释里
 * 声明的两级语义推翻了。实际后果是余量从「离硬限 22 KiB」变成「离 CI 红
 * 2.4 KiB」，而没有人知道，直到下一个特性把构建顶红。
 */
export const INITIAL_GZIP_TARGET = 145 * 1024
export const INITIAL_GZIP_HARD_LIMIT = 165 * 1024

/**
 * 入口 chunk 单独的上限。聚合值可以靠拆 chunk 摊薄，入口却是首屏必须同步下载
 * 的那一份，所以它只有一条硬线，没有目标线。
 */
export const INITIAL_ENTRY_GZIP_BUDGET = 86 * 1024

export function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

export function formatKiBRounded(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`
}

export type InitialBudgetVerdict = 'pass' | 'warn' | 'fail'

export function judgeInitialGzip(totalGzipBytes: number): InitialBudgetVerdict {
  if (totalGzipBytes > INITIAL_GZIP_HARD_LIMIT)
    return 'fail'
  return totalGzipBytes > INITIAL_GZIP_TARGET ? 'warn' : 'pass'
}
