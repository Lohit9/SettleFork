import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import type {
  MappedRow,
  MappingRow,
  TargetFieldRef,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 4c — TargetTableGroup tests.
// ─────────────────────────────────────────────────────────────────────────────

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

const summary: TargetTableSummary = {
  id: 'tt-1',
  name: 'accounts',
  datasetName: 'Heritage Core',
  fieldCount: 3,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TargetTableGroup', () => {
  it('renders the group header with table name and field count', () => {
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(screen.getByText('accounts')).toBeInTheDocument()
    expect(screen.getByTestId('target-table-field-count')).toHaveTextContent('3 fields')
  })

  it('uses the singular form "1 field" when fieldCount=1', () => {
    render(<TargetTableGroup targetTable={{ ...summary, fieldCount: 1 }} rows={[]} />)
    expect(screen.getByTestId('target-table-field-count')).toHaveTextContent('1 field')
  })

  it('renders the dataset subtitle under the table name', () => {
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(screen.getByText('Heritage Core')).toBeInTheDocument()
  })

  it('renders one FieldMappingRow per input row', () => {
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
      mapped({ id: 'r2', targetField: targetField({ id: 'f2', name: 'field_two' }) }),
      mapped({ id: 'r3', targetField: targetField({ id: 'f3', name: 'field_three' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.getAllByTestId('field-mapping-row')).toHaveLength(3)
    expect(screen.getByText('field_one')).toBeInTheDocument()
    expect(screen.getByText('field_two')).toBeInTheDocument()
    expect(screen.getByText('field_three')).toBeInTheDocument()
  })

  it('handles an empty rows array with a polite placeholder', () => {
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(screen.queryAllByTestId('field-mapping-row')).toHaveLength(0)
    expect(
      screen.getByText(/no fields to display for this table/i),
    ).toBeInTheDocument()
  })

  it('preserves input row order (no client-side sort)', () => {
    // Input is intentionally NOT alphabetic — the server guarantees order,
    // so the group MUST render exactly as given.
    const rows: MappingRow[] = [
      mapped({ id: 'z', targetField: targetField({ id: 'fz', name: 'zeta_field' }) }),
      mapped({ id: 'a', targetField: targetField({ id: 'fa', name: 'alpha_field' }) }),
      mapped({ id: 'm', targetField: targetField({ id: 'fm', name: 'mu_field' }) }),
    ]
    const { container } = render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const rowEls = within(container).getAllByTestId('field-mapping-row')
    expect(rowEls.map((el) => el.textContent)).toMatchObject([
      expect.stringContaining('zeta_field'),
      expect.stringContaining('alpha_field'),
      expect.stringContaining('mu_field'),
    ])
  })

  it('tags itself with the target-table id for downstream selectors', () => {
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    const group = screen.getByTestId('target-table-group')
    expect(group.getAttribute('data-target-table-id')).toBe('tt-1')
  })

  it('omits the dataset subtitle when datasetName is empty', () => {
    render(
      <TargetTableGroup
        targetTable={{ ...summary, datasetName: '' }}
        rows={[]}
      />,
    )
    expect(screen.queryByText('Heritage Core')).toBeNull()
  })
})
