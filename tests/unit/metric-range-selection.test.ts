import { describe, expect, test } from 'bun:test'
import { ref } from 'vue'
import { useMetricRangeSelection } from '../../src/composables/useMetricRangeSelection'
import { CUSTOM_METRIC_VIEW_LABEL } from '../../src/utils/metricRange'

const presets = [
  { label: '1 小时', hours: 1 },
  { label: '6 小时', hours: 6 },
  { label: '1 天', hours: 24 },
] as const

describe('useMetricRangeSelection', () => {
  test('builds the available views from maxHours and the given presets', () => {
    const selection = useMetricRangeSelection(24, presets)
    expect(selection.availableViews.value.map(v => v.label)).toEqual(['1 小时', '6 小时', '1 天', CUSTOM_METRIC_VIEW_LABEL])
  })

  test('prepends a realtime option only when requested', () => {
    const withRealtime = useMetricRangeSelection(24, presets, { includeRealtime: true })
    expect(withRealtime.availableViews.value[0]).toEqual({ label: '实时' })

    const withoutRealtime = useMetricRangeSelection(24, presets)
    expect(withoutRealtime.availableViews.value[0]).not.toEqual({ label: '实时' })
  })

  test('starts on the given default view, or unselected when none is given', () => {
    const withDefault = useMetricRangeSelection(24, presets, { includeRealtime: true, defaultView: '实时' })
    expect(withDefault.selectedView.value).toBe('实时')

    const withoutDefault = useMetricRangeSelection(24, presets)
    expect(withoutDefault.selectedView.value).toBe('')
  })

  test('reacts to maxHours changing (e.g. once record_preserve_time loads)', () => {
    const maxHours = ref(1)
    const selection = useMetricRangeSelection(maxHours, presets)
    expect(selection.availableViews.value.map(v => v.label)).toEqual(['1 小时', CUSTOM_METRIC_VIEW_LABEL])
    maxHours.value = 24
    expect(selection.availableViews.value.map(v => v.label)).toEqual(['1 小时', '6 小时', '1 天', CUSTOM_METRIC_VIEW_LABEL])
  })

  test('flags custom-range mode only when the custom view is selected', () => {
    const selection = useMetricRangeSelection(24, presets)
    expect(selection.isCustomRange.value).toBe(false)
    selection.selectedView.value = CUSTOM_METRIC_VIEW_LABEL
    expect(selection.isCustomRange.value).toBe(true)
  })

  test('parses a valid custom range and reports no error', () => {
    const selection = useMetricRangeSelection(24, presets)
    selection.selectedView.value = CUSTOM_METRIC_VIEW_LABEL
    selection.customStartInput.value = '2026-08-15T08:00'
    selection.customEndInput.value = '2026-08-15T10:30'
    expect(selection.customRange.value?.hours).toBe(3)
    expect(selection.customRangeError.value).toBe('')
  })

  test('reports an error for an incomplete or invalid custom range', () => {
    const selection = useMetricRangeSelection(24, presets)
    selection.selectedView.value = CUSTOM_METRIC_VIEW_LABEL
    selection.customStartInput.value = '2026-08-15T08:00'
    expect(selection.customRange.value).toBeNull()
    expect(selection.customRangeError.value).toBe('请选择开始和结束时间')

    selection.customEndInput.value = '2026-08-15T06:00' // before start
    expect(selection.customRange.value).toBeNull()
    expect(selection.customRangeError.value).toBe('结束时间必须晚于开始时间')
  })

  test('does not report a custom-range error while a preset view is selected', () => {
    const selection = useMetricRangeSelection(24, presets)
    selection.customStartInput.value = '2026-08-15T08:00'
    // Stray custom-range input while on a preset view should not surface an error.
    expect(selection.customRangeError.value).toBe('')
  })
})
