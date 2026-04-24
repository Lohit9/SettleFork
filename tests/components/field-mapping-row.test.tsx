import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldMappingRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import type {
  MappedRow,
  MappingRow,
  TargetAcknowledgedRow,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 4c — FieldMappingRow tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers:
//   • each discriminator renders without crashing
//   • status dot + label per row.status
//   • 2-decimal confidence or em-dash when null
//   • transformation indicator only when hasTransformation=true
//   • positive-control: FieldMappingRow is actually rendered by the group
//     component (prevents silent dead-code regression).

// ─── Fixtures ────────────────────────────────────────────────────────────────

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'accounts' },
    ordinalPosition: 1,
    ...overrides,
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'tfm-1',
    targetField: targetField(),
    confidence: 98,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    sources: [],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

function valueAssignment(
  overrides: Partial<ValueAssignmentRow> = {},
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: 'tfm-va-1',
    targetField: targetField({ id: 'tf-2', name: 'created_at' }),
    confidence: 92,
    status: 'approved',
    hasTransformation: true,
    transformationStatus: 'applied',
    combinationType: 'custom_sql',
    combinationSql: "NOW()",
    aiReasoning: null,
    ...overrides,
  }
}

function targetAck(overrides: Partial<TargetAcknowledgedRow> = {}): TargetAcknowledgedRow {
  return {
    kind: 'target_acknowledged',
    id: 'tfm-ack-1',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    acknowledgmentReason: 'system default',
    ...overrides,
  }
}

function unmapped(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-4',
    targetField: targetField({ id: 'tf-4', name: 'missing_field' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FieldMappingRow', () => {
  it('renders a mapped row', () => {
    render(<FieldMappingRow row={mapped()} />)
    expect(screen.getByText('customer_id')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })

  it('renders a value_assignment row', () => {
    render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.getByText('created_at')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })

  it('renders a target_acknowledged row', () => {
    render(<FieldMappingRow row={targetAck()} />)
    expect(screen.getByText('internal_id')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })

  it('renders an unmapped row', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByText('missing_field')).toBeInTheDocument()
    expect(screen.getByText('Unmapped')).toBeInTheDocument()
  })

  it('renders the "Needs Review" status label for status=needs_review', () => {
    render(<FieldMappingRow row={mapped({ status: 'needs_review' })} />)
    expect(screen.getByText('Needs Review')).toBeInTheDocument()
  })

  it('renders the "Rejected" status label for status=rejected', () => {
    render(<FieldMappingRow row={mapped({ status: 'rejected' })} />)
    expect(screen.getByText('Rejected')).toBeInTheDocument()
  })

  it('formats confidence to 2 decimals', () => {
    render(<FieldMappingRow row={mapped({ confidence: 87.5 })} />)
    expect(screen.getByText('87.50%')).toBeInTheDocument()
  })

  it('formats integer confidence to 2 decimals', () => {
    render(<FieldMappingRow row={mapped({ confidence: 92 })} />)
    expect(screen.getByText('92.00%')).toBeInTheDocument()
  })

  it('renders an em-dash when confidence is null', () => {
    render(<FieldMappingRow row={targetAck()} />)
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders the transformation indicator when hasTransformation=true', () => {
    render(<FieldMappingRow row={mapped({ hasTransformation: true, transformationStatus: 'applied' })} />)
    expect(screen.getByLabelText('transformation: applied')).toBeInTheDocument()
  })

  it('does not render the transformation indicator when hasTransformation=false', () => {
    const { queryByLabelText } = render(<FieldMappingRow row={mapped()} />)
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })

  it('does NOT render a "required" badge even when isNullable=false (drawer concern; Gap 3 amendment, 2026-04-21)', () => {
    // The NOT-NULL / required indicator was added in Gap 4c as a sidebar
    // row badge, then removed during Gap 3 review — it communicated nothing
    // per-row on Heritage (95% of fields are NOT NULL). The drawer header
    // (Gaps 7-10) is the canonical home for required/nullable display.
    // This test prevents silent regression: if a future change adds the
    // badge back to the main row, this will fail.
    render(
      <FieldMappingRow row={mapped({ targetField: targetField({ isNullable: false }) })} />,
    )
    expect(screen.queryByText(/^required$/)).toBeNull()
  })

  it('exposes row kind via data attribute for debugging and snapshots', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const rowEl = container.querySelector('[data-testid="field-mapping-row"]')
    expect(rowEl?.getAttribute('data-row-kind')).toBe('value_assignment')
  })

  // ─── Positive control: group wires through to the row ──────────────────────

  it('is rendered by TargetTableGroup (positive control)', () => {
    const summary: TargetTableSummary = {
      id: 'tt-1',
      name: 'accounts',
      datasetName: 'Heritage Core',
      fieldCount: 1,
    }
    const rows: MappingRow[] = [mapped({ id: 'canary-row', targetField: targetField({ name: 'canary_field' }) })]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.getByText('canary_field')).toBeInTheDocument()
    expect(screen.getByTestId('field-mapping-row')).toBeInTheDocument()
  })
})
