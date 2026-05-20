/**
 * Unit tests for `buildReasoning` (`lib/mappings/static-provider.ts`).
 *
 * `buildReasoning` produces the `ai_reasoning` text persisted from a
 * static-config entry. Refinement #5a: it must return ONLY the entry's
 * `explanation` — the `transformation_needed` verdict and the
 * `transformations` array belong on the Transform tab (they reach it via
 * the `needs_transformation` column and `transformation_intent`), NOT in
 * the WHY THIS MAPPING section.
 */

import { describe, it, expect } from 'vitest'
import { buildReasoning } from '@/lib/mappings/static-provider'

describe('buildReasoning', () => {
  it('returns only the explanation text', () => {
    const result = buildReasoning({
      explanation: 'Direct copy of the customer display name.',
    })
    expect(result).toBe('Direct copy of the customer display name.')
  })

  it('trims surrounding whitespace from the explanation', () => {
    expect(
      buildReasoning({ explanation: '  Padded explanation.  ' }),
    ).toBe('Padded explanation.')
  })

  it('does not emit a "Transformation needed:" prefix', () => {
    // The entry shape carries `transformation_needed` + `transformations`,
    // but `buildReasoning` reads neither — the result is explanation-only.
    const result = buildReasoning({
      explanation: 'Numeric amount mapped straight across.',
      transformation_needed: true,
      transformations: ['CAST(amount AS NUMERIC(12,2))'],
    } as Parameters<typeof buildReasoning>[0])
    expect(result).toBe('Numeric amount mapped straight across.')
    expect(result).not.toContain('Transformation needed:')
    expect(result).not.toContain('Transformations:')
    expect(result).not.toContain('CAST(amount')
  })

  it('does not emit a "Transformations:" prefix even when transformations exist', () => {
    const result = buildReasoning({
      explanation: 'Status enum normalized to the target vocabulary.',
      transformation_needed: false,
      transformations: ['map A->active', 'map I->inactive'],
    } as Parameters<typeof buildReasoning>[0])
    expect(result).toBe('Status enum normalized to the target vocabulary.')
    expect(result).not.toContain('Transformations:')
  })

  it('returns an empty string for a blank explanation', () => {
    expect(buildReasoning({ explanation: '   ' })).toBe('')
  })
})
