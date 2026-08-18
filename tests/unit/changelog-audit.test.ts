import { describe, expect, test } from 'bun:test'
import { hasChangelogVersionHeading } from '../../scripts/changelog'

describe('release changelog audit', () => {
  test('accepts an exact release heading with or without an ISO date', () => {
    expect(hasChangelogVersionHeading('## [1.2.3] - 2026-08-18', '1.2.3')).toBe(true)
    expect(hasChangelogVersionHeading('## [1.2.3]', '1.2.3')).toBe(true)
  })

  test('rejects partial headings and headings inside Markdown fences', () => {
    expect(hasChangelogVersionHeading('## [1.2.3] draft', '1.2.3')).toBe(false)
    expect(hasChangelogVersionHeading('```md\n## [1.2.3] - 2026-08-18\n```', '1.2.3')).toBe(false)
    expect(hasChangelogVersionHeading('   ~~~~md\n## [1.2.3]\n~~~~', '1.2.3')).toBe(false)
    expect(hasChangelogVersionHeading('```md\n```not-a-close\n## [1.2.3]\n```', '1.2.3')).toBe(false)
  })
})
