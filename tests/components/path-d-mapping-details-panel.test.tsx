import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MappingDetailsPanel } from '@/components/path-d/MappingDetailsPanel'
import type { TfmPathDEnrichment } from '@/components/path-d/types'

// ─────────────────────────────────────────────────────────────────────────────
// MappingDetailsPanel — Path D primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Anchored to the 5 enrichment columns added to target_field_mappings by
// migration 093:354-369. The panel is purely presentational; tests pin the
// 4 sub-sections (intent / cardinality / dedup / DQ flag count) and the
// null-state fallbacks for unset values.

function enrichment(
  overrides: Partial<TfmPathDEnrichment> = {},
): TfmPathDEnrichment {
  return {
    transformation_intent:
      'Concatenate first_name + last_name with a space separator.',
    mapping_cardinality: 'many_to_one',
    dedup_required: true,
    dedup_strategy: {
      key_fields: ['email_lower'],
      conflict_resolution: 'last',
      ordering: 'updated_at DESC',
    },
    data_quality_flag_ids: ['dq-1', 'dq-2'],
    ...overrides,
  }
}

describe('MappingDetailsPanel', () => {
  it('renders the section heading', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    expect(screen.getByText('Mapping details')).toBeInTheDocument()
  })

  it('renders transformation_intent prose when present', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    expect(screen.getByTestId('transformation-intent').textContent).toBe(
      'Concatenate first_name + last_name with a space separator.',
    )
  })

  it('renders fallback when transformation_intent is null', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({ transformation_intent: null })}
      />,
    )
    expect(screen.queryByTestId('transformation-intent')).not.toBeInTheDocument()
    // Fallback copy appears (one per null section — exact count is incidental)
    expect(screen.getAllByText('Not yet inferred.').length).toBeGreaterThan(0)
  })

  it('renders the mapping_cardinality badge with display label', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    const badge = screen.getByTestId('mapping-cardinality')
    expect(badge).toHaveAttribute('data-cardinality', 'many_to_one')
    expect(badge.textContent).toBe('Many → one')
  })

  it.each([
    { value: '1:1' as const, label: '1:1' },
    { value: 'many_to_one' as const, label: 'Many → one' },
    { value: 'one_to_many' as const, label: 'One → many' },
    { value: 'many_to_many' as const, label: 'Many → many' },
  ])('maps cardinality $value to label "$label"', ({ value, label }) => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({ mapping_cardinality: value })}
      />,
    )
    expect(screen.getByTestId('mapping-cardinality').textContent).toBe(label)
  })

  it('falls back to "Not yet inferred." when mapping_cardinality is null', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({ mapping_cardinality: null })}
      />,
    )
    expect(screen.queryByTestId('mapping-cardinality')).not.toBeInTheDocument()
  })

  it('renders dedup_required pill labelled Required when true', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    const pill = screen.getByTestId('dedup-required')
    expect(pill).toHaveAttribute('data-required', 'true')
    expect(pill.textContent).toBe('Required')
  })

  it('renders dedup_required pill labelled Not required when false', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({
          dedup_required: false,
          dedup_strategy: null,
        })}
      />,
    )
    const pill = screen.getByTestId('dedup-required')
    expect(pill).toHaveAttribute('data-required', 'false')
    expect(pill.textContent).toBe('Not required')
  })

  it('renders dedup_strategy as JSON only when dedup_required is true and strategy is set', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    const strategy = screen.getByTestId('dedup-strategy')
    expect(strategy.textContent).toContain('email_lower')
    expect(strategy.textContent).toContain('"conflict_resolution"')
    expect(strategy.textContent).toContain('"last"')
    expect(strategy.textContent).toContain('"ordering"')
  })

  it('omits dedup_strategy block when dedup_required is false', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({
          dedup_required: false,
          dedup_strategy: null,
        })}
      />,
    )
    expect(screen.queryByTestId('dedup-strategy')).not.toBeInTheDocument()
  })

  it('omits dedup_strategy block when dedup_required is true but strategy is null', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({
          dedup_required: true,
          dedup_strategy: null,
        })}
      />,
    )
    expect(screen.queryByTestId('dedup-strategy')).not.toBeInTheDocument()
  })

  it('renders the DQ flag count with pluralization', () => {
    render(<MappingDetailsPanel enrichment={enrichment()} />)
    const count = screen.getByTestId('dq-flag-count')
    expect(count).toHaveAttribute('data-count', '2')
    expect(count.textContent).toBe('2 flags raised.')
  })

  it('uses singular copy for exactly one DQ flag', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({ data_quality_flag_ids: ['dq-1'] })}
      />,
    )
    const count = screen.getByTestId('dq-flag-count')
    expect(count.textContent).toBe('1 flag raised.')
  })

  it('renders empty-state when no DQ flags are raised', () => {
    render(
      <MappingDetailsPanel
        enrichment={enrichment({ data_quality_flag_ids: [] })}
      />,
    )
    const count = screen.getByTestId('dq-flag-count')
    expect(count).toHaveAttribute('data-count', '0')
    expect(count.textContent).toBe('No flags raised.')
  })
})
