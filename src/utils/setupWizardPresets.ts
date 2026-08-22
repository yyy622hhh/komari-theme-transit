import type { ChartDashboardPreset, DetailMetricCardPreset, GeneralCardPreset, HomeQuickControlPreset } from '@/stores/app.settings.constants'
import type { NodeCardSize } from '@/stores/app.types'

export type SetupWizardPresetId = 'minimal' | 'daily' | 'pro'

export interface SetupWizardPresetFields {
  nodeCardSize: NodeCardSize
  generalCardPreset: GeneralCardPreset
  homeQuickControlPreset: HomeQuickControlPreset
  detailMetricCardPreset: DetailMetricCardPreset
  chartDashboardPreset: ChartDashboardPreset
  topologyEnabled: boolean
  diskPredictionEnabled: boolean
  gpuChartEnabled: boolean
  opsDashboardEnabled: boolean
  nodeListMetadataEnabled: boolean
  disablePageAnimation: boolean
  hideAdminEntryWhenLoggedOut: boolean
  hidePriceWhenLoggedOut: boolean
}

export interface SetupWizardPreset {
  id: SetupWizardPresetId
  label: string
  description: string
  icon: string
  fields: SetupWizardPresetFields
}

/**
 * 三档预设只覆盖“会随使用场景明显变化”的一小撮字段——卡片密度、信息量、图表
 * 深度、几个默认关闭的重功能。背景、公告、配色、阈值这些个性化设置留给用户自己
 * 调，预设不动它们，避免“选了个预设，之前调好的东西全没了”。
 *
 * 三档都不碰 routeProbeEnabled：这项会对其他节点发起探测，代码里一直坚持要
 * 操作者显式确认才能打开（见 app.topologySettings.ts 的注释），不该被预设静默
 * 带上，向导的自动检测步骤会单独给一个明确的开关。
 */
export const SETUP_WIZARD_PRESETS: SetupWizardPreset[] = [
  {
    id: 'minimal',
    label: '简洁展示',
    description: '面向访客的公开状态页：卡片紧凑、信息精简、隐藏进阶功能。',
    icon: 'tabler:layout-grid',
    fields: {
      nodeCardSize: 'compact',
      generalCardPreset: 'basic',
      homeQuickControlPreset: 'basic',
      detailMetricCardPreset: 'status',
      chartDashboardPreset: 'compact',
      topologyEnabled: false,
      diskPredictionEnabled: false,
      gpuChartEnabled: false,
      opsDashboardEnabled: false,
      nodeListMetadataEnabled: false,
      disablePageAnimation: false,
      hideAdminEntryWhenLoggedOut: true,
      hidePriceWhenLoggedOut: true,
    },
  },
  {
    id: 'daily',
    label: '日常监控',
    description: '推荐默认：兼顾信息量与整洁度，适合大多数管理员日常查看。',
    icon: 'tabler:activity',
    fields: {
      nodeCardSize: 'comfortable',
      generalCardPreset: 'ops',
      homeQuickControlPreset: 'ops',
      detailMetricCardPreset: 'resource',
      chartDashboardPreset: 'resource',
      topologyEnabled: true,
      diskPredictionEnabled: true,
      gpuChartEnabled: false,
      opsDashboardEnabled: true,
      nodeListMetadataEnabled: true,
      disablePageAnimation: false,
      hideAdminEntryWhenLoggedOut: false,
      hidePriceWhenLoggedOut: false,
    },
  },
  {
    id: 'pro',
    label: '专业运维',
    description: '尽可能多的信息密度：大卡片、全量指标、进阶图表面板。',
    icon: 'tabler:server-cog',
    fields: {
      nodeCardSize: 'large',
      generalCardPreset: 'full',
      homeQuickControlPreset: 'full',
      detailMetricCardPreset: 'full',
      chartDashboardPreset: 'full',
      topologyEnabled: true,
      diskPredictionEnabled: true,
      gpuChartEnabled: true,
      opsDashboardEnabled: true,
      nodeListMetadataEnabled: true,
      disablePageAnimation: false,
      hideAdminEntryWhenLoggedOut: false,
      hidePriceWhenLoggedOut: false,
    },
  },
]

/** "一键恢复推荐设置" 用的那一档——多数站点介于极简和专业之间，日常监控最不容易踩坑。 */
export const RECOMMENDED_SETUP_WIZARD_PRESET: SetupWizardPresetId = 'daily'

export function getSetupWizardPreset(id: SetupWizardPresetId): SetupWizardPreset {
  return SETUP_WIZARD_PRESETS.find(preset => preset.id === id) ?? SETUP_WIZARD_PRESETS[1]!
}
