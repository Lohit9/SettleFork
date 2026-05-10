import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LookupTableViewer } from '@/components/path-d/LookupTableViewer'
import type { ProjectLookupTableRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// LookupTableViewer — Path D primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Anchored to the project_lookup_tables row shape from migration 093:183-196.
// Tests cover: header (name, description, approval pill), the 2-column
// source→target table (sorted by source value), and inline DQ note chips
// keyed off data_quality_notes.

function lookup(
  overrides: Partial<ProjectLookupTableRow> = {},
): ProjectLookupTableRow {
  return {
    id: 'plt-1',
    project_id: 'proj-1',
    name: 'uom_normalization',
    description: 'Map heritage UOM strings to canonical codes.',
    applies_to_fields: [
      { source_field_id: 'sf-1', target_field_id: 'tf-1' },
    ],
    mappings: {
      Each: 'EA',
      Lbs: 'LB',
      Pounds: 'LB',
    },
    data_quality_notes: {
      Pounds: 'Duplicate of Lbs — collapse on import.',
    },
    customer_approved: false,
    created_at: '2026-05-06T10:00:00Z',
    updated_at: '2026-05-06T10:00:00Z',
    experiment_run_id: null,
    ...overrides,
  }
}

describe('LookupTableViewer', () => {
  it('renders the lookup name and description', () => {
    render(<LookupTableViewer lookup={lookup()} />)
    expect(screen.getByText('uom_normalization')).toBeInTheDocument()
    expect(
      screen.getByText('Map heritage UOM strings to canonical codes.'),
    ).toBeInTheDocument()
  })

  it('omits description when null', () => {
    render(<LookupTableViewer lookup={lookup({ description: null })} />)
    expect(
      screen.queryByText('Map heritage UOM strings to canonical codes.'),
    ).not.toBeInTheDocument()
  })

  it('renders all source → target mappings', () => {
    render(<LookupTableViewer lookup={lookup()} />)
    expect(screen.getByText('Each')).toBeInTheDocument()
    expect(screen.getByText('EA')).toBeInTheDocument()
    expect(screen.getByText('Lbs')).toBeInTheDocument()
    expect(screen.getAllByText('LB')).toHaveLength(2)
    expect(screen.getByText('Pounds')).toBeInTheDocument()
  })

  it('sorts entries by source value', () => {
    const { container } = render(<LookupTableViewer lookup={lookup()} />)
    const sourceCells = Array.from(container.querySelectorAll('tbody code'))
    const sourceValues = sourceCells.map((c) => c.textContent)
    // Ascending: Each, Lbs, Pounds
    expect(sourceValues).toEqual(['Each', 'Lbs', 'Pounds'])
  })

  it('renders a DQ note chip beneath the matching source value', () => {
    render(<LookupTableViewer lookup={lookup()} />)
    const note = screen.getByTestId('dq-note')
    expect(note).toHaveAttribute('data-source-value', 'Pounds')
    expect(note.textContent).toContain('Duplicate of Lbs')
  })

  it('renders a DQ note for each entry that has one', () => {
    const multi = lookup({
      data_quality_notes: {
        Pounds: 'note A',
        Each: 'note B',
      },
    })
    render(<LookupTableViewer lookup={multi} />)
    expect(screen.getAllByTestId('dq-note')).toHaveLength(2)
  })

  it('renders no DQ chips when data_quality_notes is null', () => {
    render(<LookupTableViewer lookup={lookup({ data_quality_notes: null })} />)
    expect(screen.queryAllByTestId('dq-note')).toHaveLength(0)
  })

  it('renders Pending review pill when customer_approved is false', () => {
    render(<LookupTableViewer lookup={lookup({ customer_approved: false })} />)
    expect(screen.getByTestId('approval-badge').textContent).toBe(
      'Pending review',
    )
  })

  it('renders Approved pill when customer_approved is true', () => {
    render(<LookupTableViewer lookup={lookup({ customer_approved: true })} />)
    expect(screen.getByTestId('approval-badge').textContent).toBe('Approved')
  })

  it('renders empty-state copy when mappings is empty', () => {
    render(<LookupTableViewer lookup={lookup({ mappings: {} })} />)
    expect(screen.getByText('No values mapped yet.')).toBeInTheDocument()
  })
})
