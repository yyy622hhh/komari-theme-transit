import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'

export interface MetricRangeView {
  label: string
  hours?: number
}

export interface MetricCustomRange {
  start: Dayjs
  end: Dayjs
  hours: number
}

export const CUSTOM_METRIC_VIEW_LABEL = '自定义'

export function buildAvailableMetricViews(
  maxHours: number,
  presets: readonly Readonly<{ label: string, hours: number }>[],
  options: { includeRealtime?: boolean } = {},
): MetricRangeView[] {
  const views: MetricRangeView[] = options.includeRealtime ? [{ label: '实时' }] : []

  for (const preset of presets) {
    if (maxHours >= preset.hours)
      views.push({ ...preset })
  }

  const firstPreset = presets[0]
  const maxPreset = presets.at(-1)
  const needsPreserveTimeView = (maxPreset && maxHours > maxPreset.hours)
    || (firstPreset && maxHours > firstPreset.hours && !presets.some(preset => preset.hours === maxHours))

  if (needsPreserveTimeView) {
    views.push({
      label: maxHours % 24 === 0 ? `${Math.floor(maxHours / 24)} 天` : `${maxHours} 小时`,
      hours: maxHours,
    })
  }

  views.push({ label: CUSTOM_METRIC_VIEW_LABEL })
  return views
}

export function parseMetricCustomRange(startInput: string, endInput: string): MetricCustomRange | null {
  if (!startInput || !endInput)
    return null

  const start = dayjs(startInput)
  const end = dayjs(endInput)
  if (!start.isValid() || !end.isValid() || !end.isAfter(start))
    return null

  return {
    start,
    end,
    hours: Math.max(1, Math.ceil(end.diff(start, 'hour', true))),
  }
}

export function getMetricCustomRangeError(
  active: boolean,
  startInput: string,
  endInput: string,
  range: MetricCustomRange | null,
): string {
  if (!active || (!startInput && !endInput))
    return ''
  if (!startInput || !endInput)
    return '请选择开始和结束时间'
  return range ? '' : '结束时间必须晚于开始时间'
}

export function formatMetricAxisTime(time: string, showDate: boolean): string {
  return dayjs(time).format(showDate ? 'M/D HH:mm' : 'HH:mm')
}

export function formatMetricTooltipTime(time: string, hours: number): string {
  return dayjs(time).format(hours < 24 ? 'HH:mm:ss' : 'MM/DD HH:mm')
}
