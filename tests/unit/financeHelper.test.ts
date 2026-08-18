import type { NodeData } from '../../src/stores/nodes'
import type { ExchangeRates } from '../../src/utils/financeHelper'
import { describe, expect, test } from 'bun:test'
import {
  calculateMonthlyCostCNY,
  calculatePeriodCostCNY,
  calculateRemainingValueCNY,
  calculateTotalMonthlyCostCNY,
  calculateTotalRemainingValueCNY,
  calculateTotalValueCNY,
  DEFAULT_EXCHANGE_RATES,
  formatFinanceAmount,
  getPriceCNY,
  normalizeCurrency,
} from '../../src/utils/financeHelper'

const rates: ExchangeRates = DEFAULT_EXCHANGE_RATES

function node(overrides: Partial<NodeData> & Pick<NodeData, 'uuid' | 'name'>): NodeData {
  return {
    cpu_name: '',
    virtualization: '',
    arch: '',
    cpu_cores: 1,
    os: '',
    kernel_version: '',
    region: '',
    public_remark: '',
    mem_total: 0,
    swap_total: 0,
    disk_total: 0,
    weight: 0,
    price: 0,
    billing_cycle: 30,
    auto_renewal: false,
    currency: 'CNY',
    expired_at: null,
    group: '',
    groups: [],
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'sum',
    created_at: '',
    updated_at: '',
    online: true,
    time: '',
    cpu: 0,
    gpu: 0,
    ram: 0,
    swap: 0,
    load: 0,
    load5: 0,
    load15: 0,
    temp: 0,
    disk: 0,
    net_in: 0,
    net_out: 0,
    net_total_up: 0,
    net_total_down: 0,
    process: 0,
    connections: 0,
    connections_udp: 0,
    uptime: 0,
    ...overrides,
  }
}

describe('normalizeCurrency', () => {
  test('recognizes symbol and code aliases case-insensitively', () => {
    expect(normalizeCurrency('usd')).toBe('USD')
    expect(normalizeCurrency('$')).toBe('USD')
    expect(normalizeCurrency('CA$')).toBe('CAD')
    expect(normalizeCurrency(' hkd ')).toBe('HKD')
  })

  test('falls back to CNY for unknown or missing input', () => {
    expect(normalizeCurrency(null)).toBe('CNY')
    expect(normalizeCurrency(undefined)).toBe('CNY')
    expect(normalizeCurrency('bitcoin')).toBe('CNY')
  })
})

describe('getPriceCNY', () => {
  test('converts a foreign-currency price into CNY using the given rate', () => {
    // price is denominated in USD; DEFAULT_EXCHANGE_RATES.USD = 0.142536 CNY-per-USD-ish
    // getPriceCNY divides by the rate to go from foreign currency back to CNY.
    const price = getPriceCNY(node({ uuid: 'a', name: 'A', price: 10, currency: 'USD' }), rates)
    expect(price).toBeCloseTo(10 / rates.USD)
  })

  test('returns the raw price unconverted for CNY', () => {
    expect(getPriceCNY(node({ uuid: 'a', name: 'A', price: 99, currency: 'CNY' }), rates)).toBe(99)
  })

  test('treats non-positive or non-finite prices as zero', () => {
    expect(getPriceCNY(node({ uuid: 'a', name: 'A', price: 0 }), rates)).toBe(0)
    expect(getPriceCNY(node({ uuid: 'a', name: 'A', price: -5 }), rates)).toBe(0)
    expect(getPriceCNY(node({ uuid: 'a', name: 'A', price: Number.NaN }), rates)).toBe(0)
  })
})

describe('calculateMonthlyCostCNY', () => {
  test('prorates a non-30-day billing cycle to a monthly figure', () => {
    // 365-day (annual) billing cycle: 365 CNY / 365 days * 30 days = 30 CNY/month.
    const monthly = calculateMonthlyCostCNY(node({ uuid: 'a', name: 'A', price: 365, billing_cycle: 365 }), rates)
    expect(monthly).toBeCloseTo(30)
  })

  test('treats a zero or missing billing cycle as a one-time, non-recurring price', () => {
    const monthly = calculateMonthlyCostCNY(node({ uuid: 'a', name: 'A', price: 100, billing_cycle: 0 }), rates)
    expect(monthly).toBe(100)
  })

  test('is zero for a free (zero-price) node', () => {
    expect(calculateMonthlyCostCNY(node({ uuid: 'a', name: 'A', price: 0 }), rates)).toBe(0)
  })
})

describe('calculatePeriodCostCNY', () => {
  test('scales the monthly cost linearly by the requested period', () => {
    const node30 = node({ uuid: 'a', name: 'A', price: 30, billing_cycle: 30 })
    expect(calculatePeriodCostCNY(node30, rates, 30)).toBeCloseTo(30)
    expect(calculatePeriodCostCNY(node30, rates, 365)).toBeCloseTo(30 / 30 * 365)
  })

  test('is zero once the underlying monthly cost is zero', () => {
    expect(calculatePeriodCostCNY(node({ uuid: 'a', name: 'A', price: 0 }), rates, 30)).toBe(0)
  })
})

describe('calculateRemainingValueCNY', () => {
  const now = new Date('2026-08-18T00:00:00.000Z')

  test('is zero for a node with no expiry date', () => {
    expect(calculateRemainingValueCNY(node({ uuid: 'a', name: 'A', price: 100, expired_at: null }), rates, now)).toBe(0)
  })

  test('is zero once the node has already expired', () => {
    const expired = node({ uuid: 'a', name: 'A', price: 100, expired_at: '2020-01-01T00:00:00.000Z' })
    expect(calculateRemainingValueCNY(expired, rates, now)).toBe(0)
  })

  test('prorates remaining value by days left over the billing cycle', () => {
    // 30-day cycle, exactly 15 days remaining -> half the price left.
    const halfway = node({
      uuid: 'a',
      name: 'A',
      price: 30,
      billing_cycle: 30,
      expired_at: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(calculateRemainingValueCNY(halfway, rates, now)).toBeCloseTo(15, 0)
  })

  test('treats an expiry more than 100 years out as an effectively permanent node worth its full price', () => {
    const permanent = node({
      uuid: 'a',
      name: 'A',
      price: 500,
      billing_cycle: 30,
      expired_at: '2200-01-01T00:00:00.000Z',
    })
    expect(calculateRemainingValueCNY(permanent, rates, now)).toBe(500)
  })

  test('treats a zero billing cycle as the full remaining price, not a division by zero', () => {
    const noCycle = node({
      uuid: 'a',
      name: 'A',
      price: 200,
      billing_cycle: 0,
      expired_at: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    })
    expect(calculateRemainingValueCNY(noCycle, rates, now)).toBe(200)
  })
})

describe('total aggregation functions exclude free nodes by default', () => {
  const now = new Date('2026-08-18T00:00:00.000Z')
  const paid = node({
    uuid: 'paid',
    name: 'Paid',
    price: 30,
    billing_cycle: 30,
    expired_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const free = node({ uuid: 'free', name: 'Free', price: 0 })

  test('calculateTotalValueCNY sums only paid nodes when excludeFreeTags is true', () => {
    expect(calculateTotalValueCNY([paid, free], rates, true)).toBeCloseTo(30)
  })

  test('calculateTotalMonthlyCostCNY sums only paid nodes when excludeFreeTags is true', () => {
    expect(calculateTotalMonthlyCostCNY([paid, free], rates, true)).toBeCloseTo(30)
  })

  test('calculateTotalRemainingValueCNY sums only paid nodes when excludeFreeTags is true', () => {
    expect(calculateTotalRemainingValueCNY([paid, free], rates, true, now)).toBeCloseTo(30)
  })

  test('including free nodes does not change the total since their price is zero', () => {
    expect(calculateTotalValueCNY([paid, free], rates, false)).toBeCloseTo(30)
  })
})

describe('formatFinanceAmount', () => {
  test('shows two decimal places under the compact-notation threshold', () => {
    const formatted = formatFinanceAmount(1234.5, 'CNY')
    expect(formatted.symbol).toBe('¥')
    expect(formatted.value).toBe('1,234.50')
  })

  test('switches to compact notation at 100,000 and above', () => {
    const formatted = formatFinanceAmount(250_000, 'USD')
    expect(formatted.symbol).toBe('$')
    expect(formatted.value).not.toContain('250,000')
  })

  test('treats a non-finite amount as zero instead of throwing or printing NaN', () => {
    expect(formatFinanceAmount(Number.NaN, 'CNY').value).toBe('0.00')
  })
})
