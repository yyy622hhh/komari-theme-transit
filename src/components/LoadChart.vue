<script setup lang="ts">
import type { RecordFormat } from '@/utils/recordHelper'
import { Icon } from '@iconify/vue/offline'
import dayjs from 'dayjs'
import { computed, reactive, watch, watchEffect } from 'vue'
import VChart from 'vue-echarts'
import AsyncDataState from '@/components/AsyncDataState.vue'
import MetricChartHeader from '@/components/MetricChartHeader.vue'
import MetricSeriesChartCard from '@/components/MetricSeriesChartCard.vue'
import { Button } from '@/components/ui/button'
import { CardX } from '@/components/ui/card-x'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLoadActivityChartOptions } from '@/composables/useLoadActivityChartOptions'
import { useLoadCapacityChartOptions } from '@/composables/useLoadCapacityChartOptions'
import { useLoadChartAxes } from '@/composables/useLoadChartAxes'
import { useLoadChartData } from '@/composables/useLoadChartData'
import { useMetricRangeSelection } from '@/composables/useMetricRangeSelection'
import { useNodeLoadStats } from '@/composables/useNodeLoadStats'
import { useAppStore } from '@/stores/app'
import { useNodesStore } from '@/stores/nodes'
import { getChartSeriesPalette, getLoadChartPalette } from '@/utils/chartPalette'
import { formatBytesSplit } from '@/utils/helper'
import { getLoadChartThemeColors, getLoadChartTooltipConfig, LOAD_CHART_PRESET_VIEWS } from '@/utils/loadChartTheme'
import { getGpuDeviceNames as formatGpuDeviceNames, metricValue, statusRecordsToChartRecords } from '@/utils/loadMetricRecords'
import { comparePingTaskOrder, createPingTaskOrderMap, metricTags } from '@/utils/metricSeries'
import { fillMissingTimePoints } from '@/utils/recordHelper'
import '@/utils/echarts' // 共享 ECharts 配置

const props = defineProps<{
  uuid: string
}>()

const appStore = useAppStore()
const nodesStore = useNodesStore()

const maxRecordPreserveTime = computed(() => appStore.publicSettings?.record_preserve_time || 720)

const dataUpdateInterval = computed(() => appStore.dataUpdateInterval * 1000)
const detailLoadStatsHours = computed(() => appStore.publicSettings?.record_preserve_time || 720)

const isDark = computed(() => appStore.isDark)

const chartColors = reactive(getLoadChartPalette(appStore.colorVisionFriendly))

watchEffect(() => {
  Object.assign(chartColors, getLoadChartPalette(appStore.colorVisionFriendly))
})

interface MetricChartSeriesData {
  name: string
  color: string
  kind: 'bytes' | 'bytesPerSecond' | 'count' | 'milliseconds' | 'percent' | 'temperature'
  data: Array<[string, number | null]>
  dashed?: boolean
}

const chartThemeColors = computed(() => getLoadChartThemeColors(isDark.value))
const baseTooltipConfig = computed(() => getLoadChartTooltipConfig(chartThemeColors.value))
const presetViews = LOAD_CHART_PRESET_VIEWS

const {
  availableViews,
  selectedView,
  customStartInput,
  customEndInput,
  isCustomRange,
  customRange,
  customRangeError,
} = useMetricRangeSelection(maxRecordPreserveTime, presetViews, { includeRealtime: true, defaultView: '实时' })
const selectedHours = computed(() => {
  const view = availableViews.value.find(v => v.label === selectedView.value)
  return view?.hours
})
const isRealtime = computed(() => selectedView.value === '实时')
const effectiveHistoryHours = computed(() => isCustomRange.value ? customRange.value?.hours ?? 4 : selectedHours.value ?? 4)

// 节点信息
const nodeInfo = computed(() => nodesStore.nodesByUuid.get(props.uuid))
const { diskPrediction, diskPredictionState } = useNodeLoadStats(
  () => props.uuid,
  {
    hours: () => detailLoadStatsHours.value,
    enabled: () => appStore.diskPredictionEnabled && appStore.privateFeaturesAllowed,
    diskTotal: () => nodeInfo.value?.disk_total ?? 0,
    online: () => nodeInfo.value?.online ?? false,
    permission: 'diskPrediction',
  },
)
const diskPredictionSummary = computed(() => {
  if (!appStore.diskPredictionEnabled || !appStore.privateFeaturesAllowed)
    return ''

  const prediction = diskPrediction.value
  if (prediction) {
    const days = Math.max(0, Math.ceil(prediction.daysUntilFull))
    return days <= 0
      ? '预计已满'
      : `预计 ${days} 天后满`
  }

  const state = diskPredictionState.value
  if (state.reason === 'no_samples')
    return '暂无趋势'
  if (state.reason === 'insufficient_samples')
    return '样本不足'
  if (state.reason === 'insufficient_duration')
    return '趋势积累中'
  return ''
})

const {
  remoteData,
  metricData,
  rawMetricSeries,
  pingTasks,
  loading,
  error,
  reload,
} = useLoadChartData({
  uuid: () => props.uuid,
  isRealtime: () => isRealtime.value,
  isCustomRange: () => isCustomRange.value,
  customRange: () => customRange.value,
  effectiveHistoryHours: () => effectiveHistoryHours.value,
  chartCards: () => appStore.chartDashboardTemplate.cards,
  customRangeError: () => customRangeError.value,
  maxRecordPreserveTime: () => maxRecordPreserveTime.value,
  pollIntervalMs: dataUpdateInterval,
})

function getGpuDeviceNames(record: RecordFormat | null): string {
  return formatGpuDeviceNames(record, nodeInfo.value?.gpu_name || '')
}

const chartData = computed(() => {
  const data = metricData.value ?? statusRecordsToChartRecords(remoteData.value)
  if (!data.length)
    return []

  if (isRealtime.value) {
    return data
  }

  const hours = effectiveHistoryHours.value
  const minute = 60
  const hour = minute * 60
  let intervalSec: number
  let maxGap: number

  if (hours <= 4) {
    intervalSec = minute
    maxGap = minute * 2
  }
  else if (hours > 120) {
    intervalSec = hour
    maxGap = hour * 2
  }
  else {
    intervalSec = minute * 15
    maxGap = minute * 30
  }

  const lastTs = dayjs(data.at(-1)?.time).valueOf()
  const range = customRange.value
  const customSeconds = isCustomRange.value && range && Number.isFinite(lastTs)
    ? (lastTs - range.start.valueOf()) / 1000
    : null
  const totalSeconds = customSeconds != null && customSeconds > 0
    ? Math.max(intervalSec, customSeconds)
    : hours * 3600
  return fillMissingTimePoints(data, intervalSec, totalSeconds, maxGap)
})

const latestStatus = computed(() => {
  const data = chartData.value
  if (!data.length)
    return null
  return data.at(-1) ?? null
})

const hasGpuData = computed(() => {
  if (nodeInfo.value?.gpu_name?.trim())
    return true
  return chartData.value.some((record) => {
    if (record.gpu_detailed)
      return true
    if (typeof record.gpu_usage === 'number' && record.gpu_usage > 0)
      return true
    if (typeof record.gpu_memory === 'number' && record.gpu_memory > 0)
      return true
    return typeof record.gpu === 'number' && record.gpu > 0
  })
})

const metricSeriesColors = reactive(getChartSeriesPalette(appStore.colorVisionFriendly))

watchEffect(() => {
  metricSeriesColors.splice(0, metricSeriesColors.length, ...getChartSeriesPalette(appStore.colorVisionFriendly))
})

const pingTaskMap = computed(() => new Map(pingTasks.value.map(task => [String(task.id), task])))
const pingTaskOrder = computed(() => createPingTaskOrderMap(pingTasks.value))

function seriesHasData(series: MetricChartSeriesData): boolean {
  return series.data.some(([, value]) => value !== null && Number.isFinite(value))
}

function recordMetricSeries(
  name: string,
  color: string,
  kind: MetricChartSeriesData['kind'],
  getter: (record: RecordFormat) => number | null | undefined,
  dashed = false,
): MetricChartSeriesData {
  return {
    name,
    color,
    kind,
    dashed,
    data: chartData.value.map(record => [record.time, metricValue(getter(record))]),
  }
}

function gpuDeviceEntries(): Array<{ index: number, name: string }> {
  const devices = new Map<number, string>()
  for (const record of chartData.value) {
    for (const [rawIndex, detail] of Object.entries(record.gpu_detailed ?? {})) {
      const index = detail.device_index ?? Number(rawIndex)
      devices.set(index, detail.device_name || `GPU ${index + 1}`)
    }
  }
  return [...devices.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, name]) => ({ index, name }))
}

const trafficChartSeries = computed<MetricChartSeriesData[]>(() => [
  recordMetricSeries('累计下载', chartColors.quinary, 'bytes', record => record.net_total_down),
  recordMetricSeries('累计上传', chartColors.quaternary, 'bytes', record => record.net_total_up),
  recordMetricSeries('周期下载', chartColors.tertiary, 'bytes', record => record.traffic_down, true),
  recordMetricSeries('周期上传', chartColors.secondary, 'bytes', record => record.traffic_up, true),
].filter(seriesHasData))

const gpuMemoryChartSeries = computed<MetricChartSeriesData[]>(() => gpuDeviceEntries().flatMap((device, index) => {
  const used = recordMetricSeries(
    `${device.name} 已用`,
    metricSeriesColors[index * 2 % metricSeriesColors.length]!,
    'bytes',
    record => record.gpu_detailed?.[device.index]?.mem_used,
  )
  const total = recordMetricSeries(
    `${device.name} 总量`,
    metricSeriesColors[(index * 2 + 1) % metricSeriesColors.length]!,
    'bytes',
    record => record.gpu_detailed?.[device.index]?.mem_total,
    true,
  )
  return [used, total].filter(seriesHasData)
}))

const temperatureChartSeries = computed<MetricChartSeriesData[]>(() => {
  const series = [recordMetricSeries('系统温度', chartColors.secondary, 'temperature', record => record.temp)]
  if (appStore.gpuChartEnabled) {
    series.push(...gpuDeviceEntries().map((device, index) => recordMetricSeries(
      `${device.name} 温度`,
      metricSeriesColors[index % metricSeriesColors.length]!,
      'temperature',
      record => record.gpu_detailed?.[device.index]?.temperature,
    )))
  }
  return series.filter(seriesHasData)
})

function pingSeries(metricKey: 'ping.latency_ms' | 'ping.loss'): MetricChartSeriesData[] {
  return rawMetricSeries.value
    .filter(series => series.metric_key === metricKey)
    .sort((left, right) => comparePingTaskOrder(metricTags(left), metricTags(right), pingTaskOrder.value))
    .map<MetricChartSeriesData>((series, index) => {
      const tags = metricTags(series)
      const taskId = String(tags.task_id ?? tags.task ?? '')
      const taskName = pingTaskMap.value.get(taskId)?.name || (taskId ? `任务 ${taskId}` : `Ping ${index + 1}`)
      return {
        name: taskName,
        color: metricSeriesColors[index % metricSeriesColors.length]!,
        kind: metricKey === 'ping.loss' ? 'percent' : 'milliseconds',
        dashed: appStore.colorVisionFriendly && index % 2 === 1,
        data: series.points.map(point => [
          point.time,
          point.value === null || !Number.isFinite(point.value)
            ? null
            : metricKey === 'ping.loss' ? point.value * 100 : point.value,
        ] as [string, number | null]),
      }
    })
    .filter(seriesHasData)
}

const pingChartSeries = computed<MetricChartSeriesData[]>(() => pingSeries('ping.latency_ms'))
const pingLossChartSeries = computed<MetricChartSeriesData[]>(() => pingSeries('ping.loss'))

const hasTrafficData = computed(() => trafficChartSeries.value.length > 0)
const hasGpuMemoryData = computed(() => gpuMemoryChartSeries.value.length > 0)
const hasTemperatureData = computed(() => temperatureChartSeries.value.length > 0)
const hasPingData = computed(() => pingChartSeries.value.length > 0)
const hasPingLossData = computed(() => pingLossChartSeries.value.length > 0)

const { baseXAxisConfig, baseYAxisConfig } = useLoadChartAxes({
  chartData,
  chartThemeColors,
  effectiveHistoryHours,
})
const { cpuChartOption, memoryChartOption, diskChartOption } = useLoadCapacityChartOptions({
  baseTooltipConfig,
  baseXAxisConfig,
  baseYAxisConfig,
  chartColors,
  chartData,
  chartThemeColors,
  effectiveHistoryHours,
  nodeInfo,
})
const {
  networkChartOption,
  gpuChartOption,
  connectionsChartOption,
  processChartOption,
  isChartCardEnabled,
  getChartCardOrder,
  getChartCardStyle,
} = useLoadActivityChartOptions({
  appStore,
  baseTooltipConfig,
  baseXAxisConfig,
  baseYAxisConfig,
  chartColors,
  chartData,
  chartThemeColors,
  effectiveHistoryHours,
  gpuDeviceEntries,
  hasGpuData,
  hasGpuMemoryData,
  hasPingData,
  hasPingLossData,
  hasTemperatureData,
  hasTrafficData,
  metricSeriesColors,
})

watch(selectedView, reload)
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- 时间选择器 -->
    <div class="flex flex-col items-center gap-2">
      <Tabs v-model="selectedView" class="w-full items-center">
        <TabsList class="h-8 bg-background/50 backdrop-blur-xl pointer-events-auto rounded-md" data-load-chart-range>
          <TabsTrigger
            v-for="view in availableViews" :key="view.label" :value="view.label"
            class="h-6.5 text-xs border-none data-[state=active]:text-green-600 shadow-none rounded-sm"
          >
            {{ view.label }}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div v-if="isCustomRange" class="flex w-full flex-col items-center gap-2 sm:flex-row sm:justify-center">
        <div class="grid w-full gap-2 sm:w-auto sm:grid-cols-[minmax(0,13rem)_minmax(0,13rem)_auto]">
          <Input
            v-model="customStartInput"
            type="datetime-local"
            aria-label="负载图开始时间"
            class="h-8 bg-background/50 text-xs"
          />
          <Input
            v-model="customEndInput"
            type="datetime-local"
            aria-label="负载图结束时间"
            class="h-8 bg-background/50 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            :disabled="!customRange"
            class="h-8 text-xs"
            @click="reload"
          >
            应用
          </Button>
        </div>
        <div v-if="customRangeError" class="text-[11px] text-orange-500">
          {{ customRangeError }}
        </div>
      </div>
    </div>

    <!-- 内容区域 -->
    <Spinner :show="loading">
      <AsyncDataState :error="error" :empty="chartData.length === 0 && !loading" empty-description="暂无负载数据" @retry="reload" />

      <!-- 图表网格 -->
      <div v-if="!error && (chartData.length > 0 || loading)" class="gap-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <!-- CPU 卡片 -->
        <CardX v-if="isChartCardEnabled('cpu')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" data-load-chart-card="cpu" :style="getChartCardStyle('cpu')">
          <template #header>
            <MetricChartHeader title="CPU 与负载" icon="tabler:cpu" tone="rose">
              <div v-if="latestStatus?.cpu != null" class="text-xs flex gap-0.5 items-baseline">
                <span data-latest-cpu>{{ latestStatus.cpu.toFixed(1) }}</span>
                <span>%</span>
              </div>
              <span v-else>-</span>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="cpuChartOption" autoresize />
          </div>
        </CardX>

        <!-- 内存卡片 -->
        <CardX v-if="isChartCardEnabled('memory')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('memory')">
          <template #header>
            <MetricChartHeader title="内存与 Swap" icon="tabler:database" tone="violet">
              <div class="text-xs flex gap-1 items-baseline">
                <template v-if="latestStatus?.ram != null">
                  <span>{{ formatBytesSplit(latestStatus.ram).value }}</span>
                  <span>{{ formatBytesSplit(latestStatus.ram).unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="nodeInfo?.mem_total">
                  <span>{{
                    formatBytesSplit(nodeInfo.mem_total).value }}</span>
                  <span>{{ formatBytesSplit(nodeInfo.mem_total).unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="memoryChartOption" autoresize />
          </div>
        </CardX>

        <!-- 磁盘卡片 -->
        <CardX v-if="isChartCardEnabled('disk')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('disk')">
          <template #header>
            <MetricChartHeader title="磁盘" icon="tabler:device-floppy" tone="emerald" :subtitle="diskPredictionSummary">
              <div class="text-xs flex gap-1 items-baseline shrink-0">
                <template v-if="latestStatus?.disk != null">
                  <span>{{ formatBytesSplit(latestStatus.disk).value }}</span>
                  <span>{{ formatBytesSplit(latestStatus.disk).unit }}</span>
                </template>
                <span v-else>-</span>
                <span>·</span>
                <template v-if="nodeInfo?.disk_total">
                  <span>{{ formatBytesSplit(nodeInfo.disk_total).value }}</span>
                  <span>{{ formatBytesSplit(nodeInfo.disk_total).unit }}</span>
                </template>
                <span v-else>-</span>
              </div>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="diskChartOption" autoresize />
          </div>
        </CardX>

        <!-- 网络卡片 -->
        <CardX v-if="isChartCardEnabled('network')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('network')">
          <template #header>
            <MetricChartHeader title="实时网络" icon="tabler:network" tone="sky">
              <div class="text-xs flex gap-2 items-baseline">
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-up" width="12" height="12" />
                  <template v-if="latestStatus?.net_out != null">
                    {{ formatBytesSplit(latestStatus.net_out).value }}
                    {{ formatBytesSplit(latestStatus.net_out).unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
                <span class="flex flex-row items-center justify-center gap-0.5">
                  <Icon icon="tabler:chevron-down" width="12" height="12" />
                  <template v-if="latestStatus?.net_in != null">
                    {{ formatBytesSplit(latestStatus.net_in).value }}
                    {{ formatBytesSplit(latestStatus.net_in).unit }}/s
                  </template>
                  <template v-else>-</template>
                </span>
              </div>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="networkChartOption" autoresize />
          </div>
        </CardX>

        <MetricSeriesChartCard
          v-if="isChartCardEnabled('traffic')"
          title="累计与周期流量"
          icon="tabler:arrows-transfer-up-down"
          tone="sky"
          :series="trafficChartSeries"
          :order="getChartCardOrder('traffic')"
        />

        <!-- GPU 卡片 -->
        <CardX v-if="isChartCardEnabled('gpu')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('gpu')">
          <template #header>
            <MetricChartHeader title="GPU 利用率" icon="tabler:device-desktop-analytics" tone="cyan" :subtitle="getGpuDeviceNames(latestStatus)">
              <div class="text-xs flex gap-1 items-baseline shrink-0">
                <template v-if="latestStatus?.gpu_usage != null || latestStatus?.gpu != null">
                  <span>{{ (latestStatus.gpu_usage ?? latestStatus.gpu ?? 0).toFixed(1) }}</span>
                  <span>%</span>
                </template>
                <span v-else>-</span>
              </div>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="gpuChartOption" autoresize />
          </div>
        </CardX>

        <MetricSeriesChartCard
          v-if="isChartCardEnabled('gpuMemory')"
          title="GPU 显存"
          icon="tabler:stack-2"
          tone="violet"
          :series="gpuMemoryChartSeries"
          :order="getChartCardOrder('gpuMemory')"
        />

        <MetricSeriesChartCard
          v-if="isChartCardEnabled('temperature')"
          title="温度"
          icon="tabler:temperature"
          tone="orange"
          :series="temperatureChartSeries"
          :order="getChartCardOrder('temperature')"
        />

        <!-- 连接数卡片 -->
        <CardX v-if="isChartCardEnabled('connections')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('connections')">
          <template #header>
            <MetricChartHeader title="网络连接" icon="tabler:binary-tree" tone="amber">
              <div class="text-xs flex gap-1 items-baseline">
                <span>TCP: {{ latestStatus?.connections ?? '-' }}</span>
                <span>·</span>
                <span>UDP: {{ latestStatus?.connections_udp ?? '-' }}</span>
              </div>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="connectionsChartOption" autoresize />
          </div>
        </CardX>

        <!-- 进程卡片 -->
        <CardX v-if="isChartCardEnabled('process')" size="small" class="bg-background/50 border-none hover:bg-background transition-all rounded-md" :style="getChartCardStyle('process')">
          <template #header>
            <MetricChartHeader title="进程" icon="tabler:activity" tone="slate">
              <span class="text-xs">
                {{ latestStatus?.process ?? '-' }}
              </span>
            </MetricChartHeader>
          </template>
          <div class="h-48">
            <VChart :option="processChartOption" autoresize />
          </div>
        </CardX>

        <MetricSeriesChartCard
          v-if="isChartCardEnabled('ping')"
          title="Ping 延迟"
          icon="tabler:radar"
          tone="cyan"
          :series="pingChartSeries"
          :order="getChartCardOrder('ping')"
        />

        <MetricSeriesChartCard
          v-if="isChartCardEnabled('pingLoss')"
          title="Ping 丢包"
          icon="tabler:cloud-exclamation"
          tone="rose"
          :series="pingLossChartSeries"
          :order="getChartCardOrder('pingLoss')"
          percent-scale
        />
      </div>
    </Spinner>
  </div>
</template>
