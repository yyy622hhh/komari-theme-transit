import type { MaybeRefOrGetter } from 'vue'
import type { MetricCustomRange, MetricRangeView } from '@/utils/metricRange'
import { computed, ref, toValue } from 'vue'
import { buildAvailableMetricViews, CUSTOM_METRIC_VIEW_LABEL, getMetricCustomRangeError, parseMetricCustomRange } from '@/utils/metricRange'

export interface MetricRangeSelectionOptions {
  /** 是否在可选视图列表开头加一个「实时」选项。 */
  includeRealtime?: boolean
  /** 初始选中的视图名；不给的话由调用方自己决定默认视图（例如挑第一个可用视图）。 */
  defaultView?: string
}

/**
 * LoadChart.vue 和 PingChart.vue 都各自维护一份「预设时间窗 + 自定义起止时间」
 * 选择状态，字段和校验逻辑完全一样，只是默认视图策略、是否支持「实时」选项、
 * 以及选中范围如何喂给数据请求这几点不同。这里只抽公共的选择状态本身；
 * `isRealtime`、`selectedHours`/`effectiveHistoryHours` 这类因组件而异的派生
 * 逻辑留在各自组件里计算。
 */
export function useMetricRangeSelection(
  maxHours: MaybeRefOrGetter<number>,
  presetViews: readonly Readonly<{ label: string, hours: number }>[],
  options: MetricRangeSelectionOptions = {},
) {
  const availableViews = computed<MetricRangeView[]>(() => buildAvailableMetricViews(
    toValue(maxHours),
    presetViews,
    { includeRealtime: options.includeRealtime },
  ))
  const selectedView = ref(options.defaultView ?? '')
  const customStartInput = ref('')
  const customEndInput = ref('')
  const isCustomRange = computed(() => selectedView.value === CUSTOM_METRIC_VIEW_LABEL)
  const customRange = computed<MetricCustomRange | null>(() => parseMetricCustomRange(customStartInput.value, customEndInput.value))
  const customRangeError = computed(() => getMetricCustomRangeError(
    isCustomRange.value,
    customStartInput.value,
    customEndInput.value,
    customRange.value,
  ))

  return {
    availableViews,
    selectedView,
    customStartInput,
    customEndInput,
    isCustomRange,
    customRange,
    customRangeError,
  }
}
