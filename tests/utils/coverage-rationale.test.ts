import { describe, expect, it } from 'vitest'
import { getCoverageRationale } from '@/lib/utils/coverage-rationale'
import type { TargetFieldCoverageRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — coverage-rationale formatter tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure-function coverage. Pins the 5 enum variants to their (label,
// suggestedAction) tuple plus the synthesized orphan case (null input).
// Reasoning passthrough is exercised separately so a future schema change
// to `ai_reasoning` cannot accidentally regress drawer rendering.

function coverageRow(
  partial: Partial<TargetFieldCoverageRow>,
): TargetFieldCoverageRow {
  return {
    id: 'cov-1',
    project_id: 'proj-1',
    target_field_id: 'tf-1',
    coverage_status: 'gap',
    ai_reasoning: null,
    default_value_recommendation: null,
    default_value_decided: null,
    default_decided_at: null,
    default_decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

describe('getCoverageRationale — labels per coverage_status', () => {
  it('covered → "Covered" + flagged-for-investigation suggested action', () => {
    const out = getCoverageRationale(coverageRow({ coverage_status: 'covered' }))
    expect(out.label).toBe('Covered')
    expect(out.suggestedAction).toBe('Mapping pending — flagged for investigation.')
  })

  it('partial → "Partial" + flagged-for-investigation suggested action', () => {
    const out = getCoverageRationale(coverageRow({ coverage_status: 'partial' }))
    expect(out.label).toBe('Partial')
    expect(out.suggestedAction).toBe('Partial coverage — flagged for investigation.')
  })

  it('gap → "Gap" + pick-a-source suggested action', () => {
    const out = getCoverageRationale(coverageRow({ coverage_status: 'gap' }))
    expect(out.label).toBe('Gap')
    expect(out.suggestedAction).toBe(
      'Pick a source via the pencil, or acknowledge as not migratable.',
    )
  })

  it('optional → "Optional" + null suggested action (informational)', () => {
    const out = getCoverageRationale(coverageRow({ coverage_status: 'optional' }))
    expect(out.label).toBe('Optional')
    expect(out.suggestedAction).toBeNull()
  })

  it('out_of_scope → "Out of scope" + null suggested action (informational)', () => {
    const out = getCoverageRationale(
      coverageRow({ coverage_status: 'out_of_scope' }),
    )
    expect(out.label).toBe('Out of scope')
    expect(out.suggestedAction).toBeNull()
  })
})

describe('getCoverageRationale — reasoning passthrough', () => {
  it('returns ai_reasoning verbatim when populated', () => {
    const out = getCoverageRationale(
      coverageRow({
        coverage_status: 'gap',
        ai_reasoning: 'No source field provides shipping_status equivalents.',
      }),
    )
    expect(out.reasoning).toBe(
      'No source field provides shipping_status equivalents.',
    )
  })

  it('returns null reasoning when ai_reasoning is null', () => {
    const out = getCoverageRationale(
      coverageRow({ coverage_status: 'optional', ai_reasoning: null }),
    )
    expect(out.reasoning).toBeNull()
  })
})

describe('getCoverageRationale — synthesized orphan (null coverage)', () => {
  it('returns "Manual entry required" label with the orphan reasoning string', () => {
    const out = getCoverageRationale(null)
    expect(out.label).toBe('Manual entry required')
    expect(out.reasoning).toBe(
      'No AI verdict yet — provide a source or acknowledge.',
    )
    expect(out.suggestedAction).toBeNull()
  })
})
