import type { CarrierOperationRecord } from '@/services/carrier-probe-operation.service'
import type { CarrierProbeCandidate, CarrierProbeHealth, CarrierProbeMigrationResult } from '@/services/carrier-probe.service'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useCarrierProbeStore = defineStore('carrierProbe', () => ({
  health: ref<CarrierProbeHealth[]>([]),
  loading: ref(false),
  error: ref(''),
  activeKey: ref(''),
  results: ref<Record<string, CarrierProbeCandidate>>({}),
  migration: ref<CarrierProbeMigrationResult | null>(null),
  operation: ref<CarrierOperationRecord | null>(null),
  recovery: ref<CarrierOperationRecord[]>([]),
}))
