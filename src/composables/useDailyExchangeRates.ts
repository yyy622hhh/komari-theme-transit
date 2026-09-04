import type { MaybeRefOrGetter } from 'vue'
import type { ExchangeRateSource } from '@/utils/financeCore'
import { ref, toValue, watch } from 'vue'
import { DEFAULT_EXCHANGE_RATES } from '@/utils/financeCore'

export function useDailyExchangeRates(
  enabled: MaybeRefOrGetter<boolean>,
  options: { applyOverrides?: boolean } = {},
) {
  const rates = ref(DEFAULT_EXCHANGE_RATES)
  const dailyRates = ref(DEFAULT_EXCHANGE_RATES)
  const source = ref<ExchangeRateSource | 'loading'>('loading')
  const updatedAt = ref<number | null>(null)
  const loading = ref(false)
  const loaded = ref(false)

  watch(
    () => Boolean(toValue(enabled)),
    async (shouldLoad) => {
      if (!shouldLoad || loaded.value || loading.value)
        return

      loading.value = true

      try {
        const financeHelper = await import('@/utils/financeHelper')
        const result = await financeHelper.getDailyExchangeRates()
        if (!toValue(enabled))
          return
        dailyRates.value = result.rates
        rates.value = options.applyOverrides
          ? financeHelper.applyExchangeRateOverrides(result.rates)
          : result.rates
        source.value = result.source
        updatedAt.value = result.updatedAt
        loaded.value = true
      }
      finally {
        loading.value = false
      }
    },
    { immediate: true },
  )

  return { rates, dailyRates, source, updatedAt, loading, loaded }
}
