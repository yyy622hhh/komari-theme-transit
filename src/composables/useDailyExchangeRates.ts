import type { MaybeRefOrGetter } from 'vue'
import type { ExchangeRateSource } from '@/utils/financeHelper'
import { ref, toValue, watch } from 'vue'
import * as financeHelper from '@/utils/financeHelper'

export function useDailyExchangeRates(
  enabled: MaybeRefOrGetter<boolean>,
  options: { applyOverrides?: boolean } = {},
) {
  const rates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
  const dailyRates = ref(financeHelper.DEFAULT_EXCHANGE_RATES)
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
