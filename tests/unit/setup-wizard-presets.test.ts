import { describe, expect, test } from 'bun:test'
import { getSetupWizardPreset, RECOMMENDED_SETUP_WIZARD_PRESET, SETUP_WIZARD_PRESETS } from '../../src/utils/setupWizardPresets'

describe('setup wizard presets', () => {
  test('defines exactly the three documented tiers', () => {
    expect(SETUP_WIZARD_PRESETS.map(preset => preset.id)).toEqual(['minimal', 'daily', 'pro'])
  })

  test('getSetupWizardPreset resolves each id to its own definition', () => {
    for (const preset of SETUP_WIZARD_PRESETS)
      expect(getSetupWizardPreset(preset.id)).toBe(preset)
  })

  test('the recommended preset for one-click restore is a real, defined tier', () => {
    expect(SETUP_WIZARD_PRESETS.some(preset => preset.id === RECOMMENDED_SETUP_WIZARD_PRESET)).toBe(true)
  })

  test('never sets routeProbeEnabled directly, since that requires explicit operator confirmation', () => {
    for (const preset of SETUP_WIZARD_PRESETS)
      expect(Object.keys(preset.fields)).not.toContain('routeProbeEnabled')
  })

  test('tiers are meaningfully different from each other, not copy-pasted defaults', () => {
    const [minimal, daily, pro] = SETUP_WIZARD_PRESETS
    expect(minimal!.fields.nodeCardSize).not.toBe(pro!.fields.nodeCardSize)
    expect(minimal!.fields.generalCardPreset).not.toBe(daily!.fields.generalCardPreset)
    expect(daily!.fields.generalCardPreset).not.toBe(pro!.fields.generalCardPreset)
  })
})
