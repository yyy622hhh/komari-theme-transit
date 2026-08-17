export interface LoadChartThemeColors {
  text: string
  textSecondary: string
  textTertiary: string
  borderColor: string
  splitLineColor: string
  tooltipBg: string
  tooltipShadow: string
  crosshairColor: string
}

export const LOAD_CHART_MARGIN = { top: 30, right: 24, bottom: 32, left: 56 }
export const LOAD_CHART_MARGIN_WITH_LEGEND = { top: 30, right: 24, bottom: 52, left: 56 }

export const LOAD_CHART_PRESET_VIEWS = [
  { label: '4 小时', hours: 4 },
  { label: '1 天', hours: 24 },
  { label: '7 天', hours: 168 },
  { label: '30 天', hours: 720 },
] as const

export function getLoadChartThemeColors(isDark: boolean): LoadChartThemeColors {
  return {
    text: isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.85)',
    textSecondary: isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.55)',
    textTertiary: isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(0, 0, 0, 0.35)',
    borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)',
    splitLineColor: isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.06)',
    tooltipBg: isDark ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.8)',
    tooltipShadow: isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.06)',
    crosshairColor: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)',
  }
}

export function getLoadChartTooltipConfig(colors: LoadChartThemeColors) {
  return {
    trigger: 'axis' as const,
    confine: false,
    backgroundColor: colors.tooltipBg,
    borderColor: 'transparent',
    borderWidth: 0,
    borderRadius: 6,
    textStyle: {
      color: colors.text,
      fontSize: 12,
      lineHeight: 20,
    },
    extraCssText: `backdrop-filter: blur(5px);z-index:9;box-shadow:0 0 0 1px ${colors.tooltipShadow}, 0 0 16px ${colors.tooltipShadow}`,
    axisPointer: {
      type: 'cross' as const,
      crossStyle: {
        color: colors.textTertiary,
      },
      lineStyle: {
        color: colors.crosshairColor,
        width: 1,
        type: 'dashed' as const,
      },
      shadowStyle: {
        color: colors.crosshairColor,
      },
    },
  }
}
