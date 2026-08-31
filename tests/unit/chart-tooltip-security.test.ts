import { describe, expect, test } from 'bun:test'
import { computed, ref, shallowRef } from 'vue'
import { useLoadActivityChartOptions } from '../../src/composables/useLoadActivityChartOptions'
import { usePingChartOptions } from '../../src/composables/usePingChartOptions'
import { escapeTooltipHtml, safeTooltipColor } from '../../src/utils/chartTooltip'
import { getLoadChartThemeColors, getLoadChartTooltipConfig } from '../../src/utils/loadChartTheme'
import { statusRecordsToChartRecords } from '../../src/utils/loadMetricRecords'

const attack = '<img src=x onerror="document.title=\'unsafe\'"> & <svg/onload=alert(1)>'
describe('ECharts dynamic HTML boundaries', () => {
  test('encodes markup, attributes and pre-encoded entities without discarding readable labels', () => {
    expect(escapeTooltipHtml('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#39;')
    expect(escapeTooltipHtml('GPU <0> & A100')).toBe('GPU &lt;0&gt; &amp; A100')
    expect(escapeTooltipHtml('&lt;img&gt;')).toBe('&amp;lt;img&amp;gt;')
    expect(escapeTooltipHtml(null)).toBe('')
  })
  test('only accepts palette colors, not HTML or additional CSS declarations', () => {
    for (const value of ['#12abef', '#123', '#1234', '#12345678', 'rgba(1, 2, 3, 0.5)'])
      expect(safeTooltipColor(value)).toBe(value)
    for (const value of ['red;position:fixed', 'url(https://example.invalid)', '\"><img src=x>', {}, null])
      expect(safeTooltipColor(value)).toBe('#94a3b8')
  })
  test('real status normalization and GPU formatter encode both device and series names', () => {
    const records = statusRecordsToChartRecords([{
      client: 'test-client',
      time: new Date().toISOString(),
      gpu: 20,
      gpu_detailed_info: [{ device_index: 0, device_name: attack, utilization: 20, temperature: 30 }],
    }] as any)
    const colors = getLoadChartThemeColors(false)
    const { gpuChartOption } = useLoadActivityChartOptions({
      appStore: {},
      baseTooltipConfig: computed(() => getLoadChartTooltipConfig(colors)),
      baseXAxisConfig: computed(() => ({})),
      baseYAxisConfig: computed(() => ({})),
      chartColors: {},
      chartData: computed(() => records),
      chartThemeColors: computed(() => colors),
      effectiveHistoryHours: computed(() => 1),
      gpuDeviceEntries: () => [],
      metricSeriesColors: ['#2288ff'],
    } as any)
    const html = gpuChartOption.value.tooltip.formatter([{ dataIndex: 0, seriesName: attack, value: 20, color: attack }])
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<svg')
    expect(html.split(escapeTooltipHtml(attack))).toHaveLength(3)
    expect(html).toContain('20.0%')
  })
  test('Ping formatter keeps untrusted task names as text', () => {
    const tasks = [{ id: 1, name: attack }]
    const { pingChartOption } = usePingChartOptions({
      colorVisionFriendly: computed(() => false),
      chartThemeColors: computed(() => getLoadChartThemeColors(false)),
      chartColors: ['#2288ff'],
      selectedTasks: computed(() => tasks),
      chartData: computed(() => [{ time: new Date().toISOString(), 1: 20 }]),
      selectedHours: computed(() => 1),
      tasks: shallowRef(tasks),
      cutPeak: ref(false),
      showDateInAxis: computed(() => false),
      getTaskColor: () => '#2288ff',
    } as any)
    const html = pingChartOption.value.tooltip.formatter([{ dataIndex: 0, seriesName: attack, value: 20 }])
    expect(html).not.toContain('<img')
    expect(html).toContain(escapeTooltipHtml(attack))
    expect(html).toContain('20 ms')
  })
})
