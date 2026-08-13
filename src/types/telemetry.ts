export type TelemetrySampleTone = 'healthy' | 'notice' | 'warning' | 'critical' | 'muted'

export interface TelemetrySample {
  key: string
  tone: TelemetrySampleTone
  toneClass: string
  valueText: string
  secondaryText?: string
  timeText?: string
  title?: string
  ariaLabel: string
  height?: number
}
