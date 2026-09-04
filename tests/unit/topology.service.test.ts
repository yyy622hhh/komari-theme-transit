import { afterEach, describe, expect, test } from 'bun:test'
import { buildTopologySettingsPatch } from '../../src/services/topology.service'
import { persistTopologyCreatedTaskIds, resetTopologyCreatedTaskIdsCache } from '../../src/utils/topologyCreatedTasks'

afterEach(() => {
  resetTopologyCreatedTaskIdsCache()
})

describe('topology service', () => {
  test('serializes clearing all routes as empty topology settings without hiding the manager entry', () => {
    persistTopologyCreatedTaskIds(new Set([12]))

    expect(buildTopologySettingsPatch([])).toEqual({
      topologyEnabled: true,
      // 清空后 JSON 里是空数组，而不是缺字段——否则读取时会回退到遗留字段，
      // 刚删掉的线路一刷新又会冒出来。
      topologyConfig: '{"version":1,"routes":[]}',
      topologyRoute: '',
      topologyMetrics: '',
      topologyOwnedPingTaskIds: '[12]',
    })
  })
})
