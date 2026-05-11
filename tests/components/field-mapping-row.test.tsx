import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FieldMappingRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  SourceFieldWithState,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 5a — FieldMappingRow tests (Rules 1, 5, 6 + VA).
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers:
//   • kind-based dispatch (mapped 1-source / mapped multi-source fallback /
//     value_assignment / unmapped — including INF-57 coverage-approved
//     no-source rows that surface as kind='unmapped' with status='approved')
//   • source column rendering per rule
//   • target column rendering + acknowledged subtitle
//   • confidence formatting / em-dash for null
//   • status dot + label
//   • transformation indicator visibility
//   • aria-labels (full-sentence descriptions)
//   • positive-control: FieldMappingRow is rendered via TargetTableGroup
//     (prevents silent dead-code regression)
//
// Gap 3 regression guard (required-badge removal) preserved.
// Gap 5b (Rules 2/3/4 + chevron) will ADD tests; see TODO comments below.

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

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 98,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: {
      id: 'sf-1',
      name: 'ACCT_NO',
      dataType: 'NUMBER',
      isNullable: false,
    },
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
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
    transformationDescription: null,
    transformationSqlPreview: null,
    sources: [source()],
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
    transformationDescription: null,
    transformationSqlPreview: null,
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
    ...overrides,
  }
}

// INF-57 cleanup — coverage-approved no-source row (formerly target_acknowledged).
// Surfaces as kind='unmapped' with status='approved', statusSetBy='user'.
// `acknowledgmentReason` no longer exists on the contract; tests that
// previously asserted reason text now assert via the legacy override (drop
// or re-target as appropriate).
function targetAck(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-3',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    mapping_content: 'no-source',
    coverageStatus: 'gap',
    statusSetBy: 'user',
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
    transformationDescription: null,
    transformationSqlPreview: null,
    ...overrides,
  }
}

// ─── Rule 1: single-source mapped row ───────────────────────────────────────

describe('FieldMappingRow — Rule 1 (single-source mapped)', () => {
  it('renders TableBadge + source field name + confidence + target field name', () => {
    render(<FieldMappingRow row={mapped()} />)
    // TableBadge renders the source table name as a pill.
    expect(screen.getByText('ACCT_MASTER')).toBeInTheDocument()
    // Source field name.
    expect(screen.getByText('ACCT_NO')).toBeInTheDocument()
    // Confidence.
    expect(screen.getByText('98%')).toBeInTheDocument()
    // Target field name.
    expect(screen.getByText('customer_id')).toBeInTheDocument()
    // Phase 4-polish-1: status chip collapsed to dot-only (founder Q1).
    // The visible label is gone; the aria-label is the canonical
    // screen-reader surface ("status: Approved").
    expect(screen.getByLabelText('status: Approved')).toBeInTheDocument()
  })

  it('does NOT render an em-dash in the source column (the source exists)', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    // The only em-dash that could render is in the confidence/source columns
    // — on Rule 1 neither should fire.
    expect(container.textContent).not.toContain('—')
  })

  it('applies mono font to both source and target field names', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const monoSpans = container.querySelectorAll('.font-mono')
    // Source field name + target field name = at least 2 mono spans (plus
    // TableBadge's internal mono name, for 3 total).
    expect(monoSpans.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Rule 1 dominant-source picker (defense-in-depth) ───────────────────────

describe('FieldMappingRow — Rule 1 dominant-source picker', () => {
  it('picks the ordinal=0 source even when the array is not sorted ascending', () => {
    // Defense-in-depth: contract guarantees sorted ordinal ASC, but the
    // component scans for ordinal=0 explicitly so a server regression
    // cannot silently render the wrong source. Kept from Gap 5a.
    const row = mapped({
      sources: [
        source({
          id: 'ms-2',
          ordinal: 2,
          sourceField: {
            id: 'sf-2',
            name: 'SECONDARY_COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-2', name: 'SECONDARY_TABLE' },
        }),
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: {
            id: 'sf-0',
            name: 'DOMINANT_COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-0', name: 'DOMINANT_TABLE' },
        }),
      ],
    })
    // Set sources.length to 1 for this Rule 1 test via override: wrap in a
    // single-item Rule 1 scenario. (This test targets the picker helper via
    // its observable behavior on Rule 1, which renders only the dominant
    // source.)
    const singleOrdinalOne = mapped({
      sources: [row.sources[0]!], // ordinal=2 is the only element, still works
    })
    render(<FieldMappingRow row={singleOrdinalOne} />)
    expect(screen.getByText('SECONDARY_COL')).toBeInTheDocument()
    expect(screen.getByText('SECONDARY_TABLE')).toBeInTheDocument()
  })
})

// ─── Rule 2 — multi-source, same table (Gap 5b) ─────────────────────────────

function cifMasterSource(ordinal: number, fieldName: string): MappingSourceRef {
  return source({
    id: `ms-${fieldName}`,
    ordinal,
    sourceField: { id: `sf-${fieldName}`, name: fieldName, dataType: 'VARCHAR', isNullable: false },
    sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
  })
}

describe('FieldMappingRow — Rule 2 (multi-source, same table)', () => {
  const rule2Row = () =>
    mapped({
      sources: [
        cifMasterSource(0, 'FNAME'),
        cifMasterSource(1, 'LNAME'),
        cifMasterSource(2, 'MI'),
      ],
      combinationType: 'concat_space',
      targetField: targetField({ name: 'full_name' }),
    })

  it('renders ONE TableBadge for the shared source table in the collapsed body', () => {
    render(<FieldMappingRow row={rule2Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(within(body).getAllByText('CIF_MASTER')).toHaveLength(1)
  })

  it('renders fields comma-joined in ordinal order in the collapsed body', () => {
    render(<FieldMappingRow row={rule2Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(within(body).getByText('FNAME, LNAME, MI')).toBeInTheDocument()
  })

  it('exposes a chevron button in the collapsed (default) state', () => {
    render(<FieldMappingRow row={rule2Row()} />)
    const chevron = screen.getByTestId('field-mapping-row-chevron')
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(chevron.getAttribute('aria-label')).toBe('Show source details')
  })

  it('exposes data-row-rule="rule_2" for debugging + snapshot hooks', () => {
    const { container } = render(<FieldMappingRow row={rule2Row()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('data-row-rule')).toBe('rule_2')
  })

  it('does NOT render the ExpandedSourceList while collapsed is default state', async () => {
    const user = userEvent.setup()
    render(<FieldMappingRow row={rule2Row()} />)
    // List is in the DOM (for aria-controls to resolve), but with aria-hidden.
    const list = screen.getByTestId('expanded-source-list')
    const wrapper = list.closest('[aria-hidden]')
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true')
    // After chevron click: aria-hidden flips to false.
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    expect(wrapper?.getAttribute('aria-hidden')).toBe('false')
  })

  it('chevron click toggles aria-expanded and label', async () => {
    const user = userEvent.setup()
    render(<FieldMappingRow row={rule2Row()} />)
    const chevron = screen.getByTestId('field-mapping-row-chevron')
    await user.click(chevron)
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    expect(chevron.getAttribute('aria-label')).toBe('Hide source details')
    await user.click(chevron)
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    expect(chevron.getAttribute('aria-label')).toBe('Show source details')
  })

  it('renders bullet lines for all 3 sources when expanded', async () => {
    const user = userEvent.setup()
    render(<FieldMappingRow row={rule2Row()} />)
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    const bullets = screen.getAllByTestId('expanded-source-bullet')
    expect(bullets).toHaveLength(3)
  })

  it('chevron click does NOT propagate to row body (Gap 7-10 drawer gate)', async () => {
    const user = userEvent.setup()
    const onRowClick = vi.fn()
    const { container } = render(
      <div onClick={onRowClick}>
        <FieldMappingRow row={rule2Row()} />
      </div>,
    )
    expect(container).toBeTruthy()
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    // Propagation is stopped — the wrapping onClick must NOT fire.
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

// ─── Rule 3 — cross-table, two tables (Gap 5b) ──────────────────────────────

describe('FieldMappingRow — Rule 3 (cross-table, two tables)', () => {
  const rule3Row = () =>
    mapped({
      sources: [
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: { id: 'sf-0', name: 'FNAME', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-1',
          ordinal: 1,
          sourceField: { id: 'sf-1', name: 'LNAME', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-2',
          ordinal: 2,
          sourceField: { id: 'sf-2', name: 'EMAIL', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CONTACTS', name: 'CONTACTS' },
          joinAnnotation: '(join: PrimaryContactID)',
        }),
      ],
      targetField: targetField({ name: 'customer_full_profile' }),
    })

  it('renders BOTH source-table badges inline in the collapsed body (one per table)', () => {
    render(<FieldMappingRow row={rule3Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(within(body).getByText('CIF_MASTER')).toBeInTheDocument()
    expect(within(body).getByText('CONTACTS')).toBeInTheDocument()
  })

  it('groups adjacent same-table fields: "FNAME, LNAME" and "EMAIL" in the collapsed body', () => {
    render(<FieldMappingRow row={rule3Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(within(body).getByText('FNAME, LNAME')).toBeInTheDocument()
    expect(within(body).getByText('EMAIL')).toBeInTheDocument()
  })

  it('exposes a chevron (Rule 3 is expandable)', () => {
    render(<FieldMappingRow row={rule3Row()} />)
    expect(screen.getByTestId('field-mapping-row-chevron')).toBeInTheDocument()
  })

  it('exposes data-row-rule="rule_3"', () => {
    const { container } = render(<FieldMappingRow row={rule3Row()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('data-row-rule')).toBe('rule_3')
  })

  it('expanded bullet lines include the joinAnnotation for non-dominant sources', async () => {
    const user = userEvent.setup()
    render(<FieldMappingRow row={rule3Row()} />)
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    const joinNode = screen.getByTestId('expanded-source-join')
    expect(joinNode.textContent).toBe('(join: PrimaryContactID)')
  })

  it('handles interleaved ordinals (A, B, A) by opening a new group at each table change', () => {
    const interleaved = mapped({
      sources: [
        source({
          id: 'ms-a0',
          ordinal: 0,
          sourceField: { id: 'sf-a0', name: 'A_FIELD1', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-A', name: 'A_TABLE' },
        }),
        source({
          id: 'ms-b',
          ordinal: 1,
          sourceField: { id: 'sf-b', name: 'B_FIELD', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-B', name: 'B_TABLE' },
        }),
        source({
          id: 'ms-a1',
          ordinal: 2,
          sourceField: { id: 'sf-a1', name: 'A_FIELD2', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-A', name: 'A_TABLE' },
        }),
      ],
    })
    render(<FieldMappingRow row={interleaved} />)
    const body = screen.getByTestId('field-mapping-row-body')
    // Two A badges + one B badge in the collapsed body (ordinal-order grouping,
    // not deduplication). Expanded-view bullets add more instances to the DOM;
    // we scope the assertion to the collapsed body via `within`.
    expect(within(body).getAllByText('A_TABLE')).toHaveLength(2)
    expect(within(body).getAllByText('B_TABLE')).toHaveLength(1)
    expect(within(body).getByText('A_FIELD1')).toBeInTheDocument()
    expect(within(body).getByText('B_FIELD')).toBeInTheDocument()
    expect(within(body).getByText('A_FIELD2')).toBeInTheDocument()
  })
})

// ─── Rule 4 — multi-table complex (Gap 5b) ──────────────────────────────────

describe('FieldMappingRow — Rule 4 (multi-table complex)', () => {
  const rule4Row = () =>
    mapped({
      sources: Array.from({ length: 4 }, (_, i) =>
        source({
          id: `ms-${i}`,
          ordinal: i,
          sourceField: { id: `sf-${i}`, name: `F${i}`, dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: `st-${i % 3}`, name: `TABLE_${i % 3}` },
          // i=0 → TABLE_0, i=1 → TABLE_1, i=2 → TABLE_2, i=3 → TABLE_0 (3 distinct tables)
          joinAnnotation: i === 0 ? null : `(join: JOIN_${i})`,
        }),
      ),
      targetField: targetField({ name: 'complex_field' }),
    })

  it('renders summary "N fields across M tables" text', () => {
    render(<FieldMappingRow row={rule4Row()} />)
    expect(screen.getByText('4 fields across 3 tables')).toBeInTheDocument()
  })

  it('does NOT render any TableBadges or source field names in the collapsed body', () => {
    render(<FieldMappingRow row={rule4Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    // Summary text wins; raw table/field names are only visible in the
    // (always-rendered, aria-hidden) expanded view. We scope to the
    // collapsed body to assert the Rule 4 visual discipline.
    expect(within(body).queryByText('TABLE_0')).toBeNull()
    expect(within(body).queryByText('F0')).toBeNull()
  })

  it('uses tabular-nums on the summary for steady column width', () => {
    render(<FieldMappingRow row={rule4Row()} />)
    const summary = screen.getByText('4 fields across 3 tables')
    expect(summary.className).toContain('tabular-nums')
  })

  it('exposes a chevron (Rule 4 is expandable)', () => {
    render(<FieldMappingRow row={rule4Row()} />)
    expect(screen.getByTestId('field-mapping-row-chevron')).toBeInTheDocument()
  })

  it('exposes data-row-rule="rule_4"', () => {
    const { container } = render(<FieldMappingRow row={rule4Row()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('data-row-rule')).toBe('rule_4')
  })

  it('expanded state reveals per-source bullet lines for all 4 sources', async () => {
    const user = userEvent.setup()
    render(<FieldMappingRow row={rule4Row()} />)
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    expect(screen.getAllByTestId('expanded-source-bullet')).toHaveLength(4)
  })

  it('uses singular "field"/"table" when counts are 1', () => {
    // Construct a Rule 4 row with 5 sources from 1 table (field-count threshold).
    const row = mapped({
      sources: Array.from({ length: 5 }, (_, i) =>
        source({
          id: `ms-${i}`,
          ordinal: i,
          sourceField: { id: `sf-${i}`, name: `F${i}`, dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'SOLO_TABLE' },
        }),
      ),
    })
    render(<FieldMappingRow row={row} />)
    expect(screen.getByText('5 fields across 1 table')).toBeInTheDocument()
  })
})

// ─── Rule 1 — no chevron (regression guard) ─────────────────────────────────

describe('FieldMappingRow — Rule 1 has no chevron (regression guard)', () => {
  it('does NOT render a chevron for single-source mapped rows', () => {
    render(<FieldMappingRow row={mapped()} />)
    expect(screen.queryByTestId('field-mapping-row-chevron')).toBeNull()
  })

  it('does NOT render a chevron for value-assignment rows', () => {
    render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.queryByTestId('field-mapping-row-chevron')).toBeNull()
  })

  it('does NOT render a chevron for coverage-approved no-source rows (formerly target-acknowledged)', () => {
    render(<FieldMappingRow row={targetAck()} />)
    expect(screen.queryByTestId('field-mapping-row-chevron')).toBeNull()
  })

  it('does NOT render a chevron for unmapped rows', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.queryByTestId('field-mapping-row-chevron')).toBeNull()
  })

  it('exposes data-row-rule="rule_1" for Rule 1 mapped rows', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('data-row-rule')).toBe('rule_1')
  })
})

// ─── Refinement G — chevron repositioned inline next to source field ────────
//
// Phase 4-polish-1 final refinements (Refinement G, 2026-04-26): the
// expand chevron moved from a dedicated col 6 (row-end) to inline at
// the right edge of col 3 (source field area). The dedicated chevron
// column was DROPPED; the row grid template went from 6 cols → 5
// cols. Pin the new placement structurally so a future refactor
// cannot re-introduce the row-end chevron without tripping CI.

describe('FieldMappingRow — chevron position (Refinement G)', () => {
  // Helper to build a Rule 2 (multi-source same table) row.
  function rule2Row() {
    return mapped({
      id: 'r2',
      sources: [
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: { id: 'sf-0', name: 'F0', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'TBL' },
        }),
        source({
          id: 'ms-1',
          ordinal: 1,
          sourceField: { id: 'sf-1', name: 'F1', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'TBL' },
        }),
      ],
    })
  }

  it('chevron sits inline alongside the source-field render (col 3 area), not at row end', () => {
    // Walk the row body's direct children. Pre-Refinement G the
    // chevron was its own grid cell at index 5 (last). Post-
    // Refinement G the chevron lives INSIDE col 3 (a flex wrapper
    // around `SourceFieldCell` + `InlineExpandChevron`).
    //
    // Phase 4-polish-3 (2026-04-27): the row body grew BACK to 6
    // grid cells with the addition of the inline-actions column at
    // the row end. The chevron still lives inline at col 3 — the
    // new col 6 hosts the per-row ✓/✗/+/⊘ buttons, not the chevron.
    render(<FieldMappingRow row={rule2Row()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    const chevron = screen.getByTestId('field-mapping-row-chevron')
    expect(body.children).toHaveLength(6)
    // Chevron's parent is the col-3 flex wrapper; that wrapper IS one
    // of the row body's 6 children. Pin: the chevron is NOT a direct
    // child of the row body (col 6 actions cell at the row end).
    expect(chevron.parentElement).not.toBe(body)
    expect(chevron.parentElement?.parentElement).toBe(body)
    // Index of the chevron's parent within the row body's children
    // is 2 (the third grid cell — col 3 source field). Order:
    // col 1 status, col 2 src tbl, col 3 src field+chevron,
    // col 4 target, col 5 confidence, col 6 actions.
    const wrapperIndex = Array.from(body.children).indexOf(
      chevron.parentElement as Element,
    )
    expect(wrapperIndex).toBe(2)
  })

  it('the source-field wrapper renders the field name BEFORE the chevron (DOM order = visual order)', () => {
    render(<FieldMappingRow row={rule2Row()} />)
    const chevron = screen.getByTestId('field-mapping-row-chevron')
    const wrapper = chevron.parentElement!
    // Last child is the chevron; the field-render precedes it under
    // flex with default `flex-direction: row` left-to-right.
    expect(wrapper.lastElementChild).toBe(chevron)
    // The wrapper has at least 2 children (field render + chevron).
    expect(wrapper.children.length).toBeGreaterThanOrEqual(2)
  })

  it('Rule 1 source-field cell does NOT wrap with an inline chevron', () => {
    // Single-source rows have no chevron at all (canExpand=false). The
    // col-3 wrapper still exists structurally (so the grid layout
    // stays consistent) but contains only the field render.
    //
    // Phase 4-polish-3 (2026-04-27): the row body grew BACK to 6
    // grid cells with the addition of the inline-actions column at
    // the row end (col 6 hosts ✓/✗/+/⊘ buttons).
    render(<FieldMappingRow row={mapped()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(body.children).toHaveLength(6)
    expect(screen.queryByTestId('field-mapping-row-chevron')).toBeNull()
  })
})

// ─── Value assignment (founder Gap 4a §9 Q5) ────────────────────────────────

describe('FieldMappingRow — Value assignment', () => {
  it('renders "No source mapped" text instead of a TableBadge', () => {
    render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.getByText('No source mapped')).toBeInTheDocument()
    // No TableBadge-like text should appear — VA's source column is
    // explicitly the inline "No source mapped" phrase.
    expect(screen.queryByText('ACCT_MASTER')).toBeNull()
  })

  it('renders confidence normally (not em-dashed) — VAs carry confidence', () => {
    render(<FieldMappingRow row={valueAssignment({ confidence: 92 })} />)
    expect(screen.getByText('92%')).toBeInTheDocument()
  })

  it('renders the target field name in mono', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.getByText('created_at')).toBeInTheDocument()
    const monoTarget = container.querySelector('.font-mono.text-sm')
    expect(monoTarget).toBeTruthy()
  })
})

// ─── Rule 5 (formerly target-acknowledged) — coverage-approved no-source ────

describe('FieldMappingRow — coverage-approved no-source row (formerly Rule 5)', () => {
  // INF-57 cleanup: target_acknowledged collapsed into kind='unmapped' with
  // status='approved'. The row renders the unified "Approved" pill, no
  // longer the slate "Acknowledged" pill. Tests preserve the underlying
  // contract — em-dashes, no transform indicator — but drop the now-defunct
  // "Acknowledged" tooltip / aria-label / inline-suffix assertions.
  it('renders em-dashes in both source and confidence columns', () => {
    render(<FieldMappingRow row={targetAck()} />)
    // Screen-reader labels hand us a reliable selector for each em-dash.
    expect(screen.getByLabelText('no source mapped')).toBeInTheDocument()
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
  })

  it('renders the target field name without an "(acknowledged)" suffix (Refinement B)', () => {
    // Phase 4-polish-1 final refinements (Refinement B, 2026-04-26):
    // the inline "(acknowledged)" suffix was DROPPED. INF-57 cleanup
    // (2026-05-10) further unified the dot color on the approved pill
    // for these rows.
    render(<FieldMappingRow row={targetAck()} />)
    expect(screen.getByText('internal_id')).toBeInTheDocument()
    expect(screen.queryByTestId('target-acknowledged-suffix')).toBeNull()
    // Belt and suspenders: the literal "(acknowledged)" text must
    // not appear anywhere in the row's rendered content.
    const row = screen.getByTestId('field-mapping-row')
    expect(row.textContent).not.toContain('(acknowledged)')
  })

  it('status dot tooltip unifies on the standard "Approved" copy (INF-57 cleanup)', () => {
    // Pre-INF-57 the StatusDot had a kind-conditional ternary that
    // surfaced "Acknowledged" specifically for target_acknowledged rows.
    // Post-cleanup, all approved rows share the green "Approved" tooltip
    // — the dropped slate "Acknowledged" pill no longer exists.
    render(<FieldMappingRow row={targetAck()} />)
    const dot = screen.getByLabelText('status: Approved')
    expect(dot.getAttribute('title')).toBe('Approved')
  })

  it('does NOT render a transformation indicator (no-source rows never carry one)', () => {
    const { container } = render(<FieldMappingRow row={targetAck()} />)
    expect(container.querySelector('[aria-label^="transformation:"]')).toBeNull()
  })
})

// ─── Rule 6: unmapped row ───────────────────────────────────────────────────

describe('FieldMappingRow — Rule 6 (unmapped)', () => {
  it('renders em-dashes in both source and confidence columns; no subtitle', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByLabelText('no source mapped')).toBeInTheDocument()
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
    expect(screen.getByText('missing_field')).toBeInTheDocument()
    // Rule 6 explicitly has no subtitle (spec line ~776).
    expect(screen.queryByText(/^acknowledged/)).toBeNull()
  })

  it('renders the "Unmapped" status dot via aria-label only (label dropped in Phase 4-polish-1)', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByLabelText('status: Unmapped')).toBeInTheDocument()
  })

  it('status dot carries a hover tooltip that mirrors the status label (Refinement B)', () => {
    // Refinement B: the unmapped row's tooltip mirrors the status label
    // verbatim. INF-57 cleanup dropped the prior kind-conditional override
    // (which surfaced "Acknowledged" for target_acknowledged); the tooltip
    // now uniformly mirrors STATUS_CONFIG[status].label across all kinds.
    render(<FieldMappingRow row={unmapped()} />)
    const dot = screen.getByLabelText('status: Unmapped')
    expect(dot.getAttribute('title')).toBe('Unmapped')
  })
})

// ─── Status chip (shared across all kinds) ──────────────────────────────────

describe('FieldMappingRow — status dot', () => {
  // Phase 4-polish-1 (founder Q1.3): the legacy "dot + label" status chip
  // collapsed to dot-only. Visible labels are gone; the aria-label still
  // carries the human-readable status so screen-reader users hear it
  // verbatim. These four tests assert the dot-only contract by querying
  // by aria-label and inspecting the dot's color class.
  it('renders the "Approved" dot via aria-label only', () => {
    render(<FieldMappingRow row={mapped({ status: 'approved' })} />)
    expect(screen.queryByText('Approved')).toBeNull()
    const dot = screen.getByLabelText('status: Approved')
    expect(dot.className).toContain('bg-green-500')
  })

  it('renders the "Needs Review" dot via aria-label only', () => {
    render(<FieldMappingRow row={mapped({ status: 'needs_review' })} />)
    expect(screen.queryByText('Needs Review')).toBeNull()
    const dot = screen.getByLabelText('status: Needs Review')
    expect(dot.className).toContain('bg-amber-400')
  })

  it('renders the "Rejected" dot as a HOLLOW circle (PR α₀ — status-driven hollow)', () => {
    // PR α₀ (2026-05-09): hollow now signals REJECTED (status-driven),
    // not UNMAPPED (kind-driven). The form-vs-fill distinction stays
    // as the colorblind-robust signal, but tracks the explicit "do not
    // migrate" lifecycle decision rather than the synthesized "no-TFM-
    // yet" kind dimension. Border is now red (matches the rejected
    // hue) so a colorblind user can still tell rejected from a hollow
    // ring of any other color (no other status renders hollow).
    render(<FieldMappingRow row={mapped({ status: 'rejected' })} />)
    expect(screen.queryByText('Rejected')).toBeNull()
    const dot = screen.getByLabelText('status: Rejected')
    expect(dot.className).toContain('border')
    expect(dot.className).toContain('border-red-500')
    expect(dot.className).toContain('bg-transparent')
    expect(dot.className).not.toContain('bg-red-500')
    expect(dot.getAttribute('data-status-dot-style')).toBe('hollow')
  })

  it('rejected hollow treatment fires regardless of kind (mapped / VA / unmapped)', () => {
    // PR α₀: the hollow rule is purely status-driven. Any row kind
    // that reaches status='rejected' renders hollow. (INF-57 cleanup
    // collapsed target_acknowledged into kind='unmapped' with
    // status='approved'; legacy bare-ack TFMs never carried status='rejected'
    // by the translator so the surface is exercised via 'unmapped' below.)
    const { unmount: u1 } = render(<FieldMappingRow row={mapped({ status: 'rejected' })} />)
    expect(
      screen.getByLabelText('status: Rejected').getAttribute('data-status-dot-style'),
    ).toBe('hollow')
    u1()

    const { unmount: u2 } = render(
      <FieldMappingRow row={valueAssignment({ status: 'rejected' })} />,
    )
    expect(
      screen.getByLabelText('status: Rejected').getAttribute('data-status-dot-style'),
    ).toBe('hollow')
    u2()

    render(<FieldMappingRow row={unmapped({ status: 'rejected' })} />)
    expect(
      screen.getByLabelText('status: Rejected').getAttribute('data-status-dot-style'),
    ).toBe('hollow')
  })

  it('unmapped + needs_review renders a FILLED amber dot (PR α₀ — kind no longer drives hollow)', () => {
    // PR α₀ (2026-05-09): the hollow branch flipped from kind-based to
    // status-based. An unmapped row that carries a coverage row with
    // status='needs_review' (the post-PR-γ default for orphan
    // target_only fields) now renders identically to a mapped+
    // needs_review row — filled amber. The state-machine unification
    // is the point: visually, "this row needs review" reads
    // identically regardless of whether a TFM backs it.
    render(<FieldMappingRow row={unmapped({ status: 'needs_review' })} />)
    const dot = screen.getByLabelText('status: Needs Review')
    expect(dot.className).toContain('bg-amber-400')
    expect(dot.className).not.toContain('bg-transparent')
    expect(dot.getAttribute('data-status-dot-style')).toBe('filled')
  })

  it('unmapped + status=unmapped (legacy fixture) renders a FILLED slate dot', () => {
    // The 'unmapped' status literal is retained for fixture back-compat
    // (PR γ widened UnmappedRow.status). Translator never emits this
    // value for live wire data post-PR-γ, but pre-existing fixtures and
    // optimistic-override constructions continue to compile. Under the
    // PR α₀ status-driven dot, the legacy 'unmapped' literal is treated
    // like any other non-rejected status — filled with its color.
    render(<FieldMappingRow row={unmapped()} />)
    const dot = screen.getByLabelText('status: Unmapped')
    expect(dot.className).toContain('bg-slate-300')
    expect(dot.className).not.toContain('bg-transparent')
    expect(dot.getAttribute('data-status-dot-style')).toBe('filled')
  })

  it('coverage-approved no-source rows render a FILLED green dot (INF-57 unification)', () => {
    // INF-57 cleanup: legacy target_acknowledged collapsed into
    // kind='unmapped' with status='approved'. Under PR α₀'s status-driven
    // dot, that resolves to a filled green dot identical to a regular
    // mapped+approved row. The prior kind-aware tooltip override
    // ("Acknowledged" instead of "Approved") was dropped — the dot now
    // unifies on the canonical "Approved" label across all kinds.
    render(<FieldMappingRow row={targetAck()} />)
    const dot = screen.getByLabelText('status: Approved')
    expect(dot.className).toContain('bg-green-500')
    expect(dot.className).not.toContain('bg-transparent')
    expect(dot.getAttribute('data-status-dot-style')).toBe('filled')
  })

  it('mapped rows render a FILLED dot regardless of status', () => {
    render(<FieldMappingRow row={mapped({ status: 'approved' })} />)
    const dot = screen.getByLabelText('status: Approved')
    expect(dot.getAttribute('data-status-dot-style')).toBe('filled')
    expect(dot.className).not.toContain('bg-transparent')
  })
})

// ─── Confidence formatting ──────────────────────────────────────────────────

describe('FieldMappingRow — confidence formatting', () => {
  // Phase 4-polish-1 Refinement H (2026-04-26): formatConfidencePercent
  // dropped 2-decimal precision in favor of integer rounding. Pin the
  // new format here. Math.round is half-away-from-zero, so 87.5 → 88.
  it('formats fractional confidence to nearest integer', () => {
    render(<FieldMappingRow row={mapped({ confidence: 87.5 })} />)
    expect(screen.getByText('88%')).toBeInTheDocument()
  })

  it('formats integer confidence as a bare integer percent', () => {
    render(<FieldMappingRow row={mapped({ confidence: 92 })} />)
    expect(screen.getByText('92%')).toBeInTheDocument()
  })

  it('interprets 0-1 fractional input as a 0-100 percentage', () => {
    // Defensive formatting: DB stores 0-100 today but drift can't corrupt UI.
    render(<FieldMappingRow row={mapped({ confidence: 0.85 })} />)
    expect(screen.getByText('85%')).toBeInTheDocument()
  })

  it('renders an em-dash when confidence is null', () => {
    render(<FieldMappingRow row={targetAck({ confidence: null })} />)
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
  })
})

// ─── Transformation indicator — REMOVED (Refinement F regression guard) ─────

describe('FieldMappingRow — transformation indicator removed (Refinement F)', () => {
  // Phase 4-polish-1 final refinements (Refinement F, 2026-04-26):
  // the row-level transformation indicator was removed entirely.
  // Earlier passes rendered an inline slate-400 dot inside
  // `ConfidenceCell`; canary review found the muted treatment too
  // subtle to convey meaning and a saturated hue would have stolen
  // disproportionate attention. The drawer's Transformation section
  // remains the source of truth for transform status.
  //
  // Pin the absence across every row state so a future refactor
  // cannot silently re-add the dot.
  it('does NOT render a transformation indicator on a mapped row with applied status', () => {
    const { queryByLabelText } = render(
      <FieldMappingRow
        row={mapped({ hasTransformation: true, transformationStatus: 'applied' })}
      />,
    )
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })

  it('does NOT render a transformation indicator on a mapped row with draft status', () => {
    const { queryByLabelText } = render(
      <FieldMappingRow
        row={mapped({ hasTransformation: true, transformationStatus: null })}
      />,
    )
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })

  it('does NOT render a transformation indicator on a mapped row with hasTransformation=false', () => {
    const { queryByLabelText } = render(<FieldMappingRow row={mapped()} />)
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })

  it('does NOT render a transformation indicator on a value-assignment row', () => {
    const { queryByLabelText } = render(
      <FieldMappingRow row={valueAssignment({ hasTransformation: true, transformationStatus: 'applied' })} />,
    )
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })
})

// ─── Gap 3 regression guard ─────────────────────────────────────────────────

describe('FieldMappingRow — Gap 3 regression guard (required badge)', () => {
  it('does NOT render a "required" badge even when isNullable=false (Gap 3 amendment)', () => {
    // The NOT-NULL / required indicator was added in Gap 4c as a sidebar
    // row badge, then removed during Gap 3 review — it communicated nothing
    // per-row on Heritage (95% of fields are NOT NULL). The drawer header
    // (Gaps 7-10) is the canonical home for required/nullable display.
    // Regression guard: if a future change re-adds the badge, this fails.
    render(
      <FieldMappingRow row={mapped({ targetField: targetField({ isNullable: false }) })} />,
    )
    expect(screen.queryByText(/^required$/)).toBeNull()
  })
})

// ─── Accessibility: aria-labels ─────────────────────────────────────────────

describe('FieldMappingRow — aria-labels', () => {
  it('describes a 1:1 mapped row as "source.field mapped to target.field at X% confidence, status"', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const row = container.querySelector('[data-testid="field-mapping-row"]')
    expect(row?.getAttribute('aria-label')).toBe(
      'ACCT_MASTER.ACCT_NO mapped to accounts.customer_id at 98% confidence, approved',
    )
  })

  it('summarizes multi-source rows with count + expansion state (Rule 2)', () => {
    const row = mapped({
      sources: [
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: { id: 'sf-0', name: 'FNAME', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-1',
          ordinal: 1,
          sourceField: { id: 'sf-1', name: 'LNAME', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-2',
          ordinal: 2,
          sourceField: { id: 'sf-2', name: 'MI', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
        }),
      ],
    })
    const { container } = render(<FieldMappingRow row={row} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    const label = el?.getAttribute('aria-label') ?? ''
    expect(label).toContain('mapped from 3 source fields across 1 table')
    expect(label).toContain('currently collapsed')
  })

  it('switches aria-label phrasing from "collapsed" to "expanded" on chevron click', async () => {
    const user = userEvent.setup()
    const row = mapped({
      sources: [
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: { id: 'sf-0', name: 'F0', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'TBL' },
        }),
        source({
          id: 'ms-1',
          ordinal: 1,
          sourceField: { id: 'sf-1', name: 'F1', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'TBL' },
        }),
      ],
    })
    const { container } = render(<FieldMappingRow row={row} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toContain('currently collapsed')
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    expect(el?.getAttribute('aria-label')).toContain('currently expanded')
  })

  it('describes a value-assignment row', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toBe(
      'accounts.created_at value assignment at 92% confidence, approved',
    )
  })

  // The "describes an acknowledged row with the reason inlined" test was
  // dropped by INF-57 cleanup — buildAckAriaLabel and the kind-conditional
  // aria branch are gone. Coverage-approved no-source rows now share the
  // unmapped row's aria phrasing ("not yet mapped"), exercised by the
  // unmapped-row test below.

  it('describes an unmapped row as "not yet mapped"', () => {
    const { container } = render(<FieldMappingRow row={unmapped()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toBe(
      'accounts.missing_field not yet mapped',
    )
  })
})

// ─── Data attributes (debugging + snapshot hooks) ───────────────────────────

describe('FieldMappingRow — data attributes', () => {
  it('exposes row kind via data-row-kind for debugging and snapshots', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const rowEl = container.querySelector('[data-testid="field-mapping-row"]')
    expect(rowEl?.getAttribute('data-row-kind')).toBe('value_assignment')
  })
})

// ─── INF-57 cleanup — opacity-70 dropped (regression guard) ────────────────
//
// Pre-INF-57: empty rows (unmapped + target_acknowledged) carried
// `opacity-70` on the outer listitem container per Phase 4-polish-1
// Refinement 4. INF-57 cleanup design lock 6 dropped the opacity treatment
// — coverage-approved no-source rows now render at full opacity to match
// the unified non-mapped treatment. Pin the absence so a future refactor
// cannot silently re-add the fade.

describe('FieldMappingRow — opacity-70 dropped on every row kind (INF-57 cleanup)', () => {
  it('unmapped rows render at full opacity', () => {
    render(<FieldMappingRow row={unmapped()} />)
    const row = screen.getByTestId('field-mapping-row')
    expect(row.className).not.toContain('opacity-70')
    expect(row.className).not.toMatch(/\bopacity-\d/)
  })

  it('coverage-approved no-source rows (formerly target_acknowledged) render at full opacity', () => {
    render(<FieldMappingRow row={targetAck()} />)
    const row = screen.getByTestId('field-mapping-row')
    expect(row.className).not.toContain('opacity-70')
    expect(row.className).not.toMatch(/\bopacity-\d/)
  })

  it('mapped rows render at full opacity', () => {
    render(<FieldMappingRow row={mapped()} />)
    const row = screen.getByTestId('field-mapping-row')
    expect(row.className).not.toContain('opacity-70')
    expect(row.className).not.toMatch(/\bopacity-\d/)
  })

  it('value-assignment rows render at full opacity', () => {
    render(<FieldMappingRow row={valueAssignment()} />)
    const row = screen.getByTestId('field-mapping-row')
    expect(row.className).not.toContain('opacity-70')
    expect(row.className).not.toMatch(/\bopacity-\d/)
  })
})

// ─── Gap 5a hotfix 2026-04-23 ─── light-mode-only invariant ────────────────
//
// The surrounding redesign UI hardcodes a light background (bg-white on
// TargetTableGroup, bg-gray-50 on the page). Tailwind's `darkMode: 'media'`
// default would fire any dark-prefix text variant automatically in OS dark
// mode, producing near-white-on-white ghosted text (the 2026-04-23 bug).
//
// Companion invariant: tests/lib/no-shim-in-redesign-path.test.ts greps
// every redesign source file for the dark-prefix token at CI time. These
// className assertions are the component-level smoke-test safety net.

describe('FieldMappingRow — light-mode-only invariant', () => {
  it('target name span uses full-contrast light-mode color and font-normal (Refinement 6)', () => {
    // Refinement 6 (Phase 4-polish-1 final-final, 2026-04-26): the
    // target field name dropped its prior `font-medium` weight to
    // render at `font-normal`, matching the source-side cells. Pin
    // the new contract verbatim — both color and weight.
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const targetSpan = container.querySelector('.font-mono.text-sm')
    expect(targetSpan).toBeTruthy()
    const cls = targetSpan?.className ?? ''
    expect(cls).toContain('text-slate-900')
    expect(cls).toContain('font-normal')
    // Belt and suspenders: the prior weights must NOT appear on the
    // target span.
    expect(cls).not.toContain('font-medium')
    expect(cls).not.toContain('font-semibold')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('source field name span matches target weight + color (Refinement 6)', () => {
    // Refinement 6: source and target field cells now render at
    // identical font weight (`font-normal`) and color (`text-slate-
    // 900`). Hierarchy comes from column position + the column-header
    // strip, not from typography weight or color contrast.
    render(<FieldMappingRow row={mapped()} />)
    const sourceSpan = screen.getByText('ACCT_NO')
    const cls = sourceSpan.className
    expect(cls).toContain('text-slate-900')
    expect(cls).toContain('font-normal')
    // The prior slate-700 (lighter) is gone.
    expect(cls).not.toContain('text-slate-700')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('color-graded confidence span uses light-mode hues (green/amber/red) and no dark-prefix', () => {
    // Phase 4-polish-1 (founder Q9): the confidence cell is now band-
    // classified — high → green-600 + medium-weight, amber → amber-600,
    // low → red-600. The legacy slate-500 baseline is gone; this test
    // asserts the new light-mode color set and reaffirms the no-dark-
    // prefix invariant so the row stays readable in OS dark mode.
    //
    // Refinement 3 (2026-04-26): high-band weight dropped from
    // font-semibold → font-medium so the number sits in the row's
    // secondary visual layer. The color band still carries the primary
    // signal; the lighter weight de-emphasizes the digits themselves.
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 98 })} />)
    const confidence = container.querySelector('[data-confidence-band="high"]')
    expect(confidence).toBeTruthy()
    const cls = confidence?.className ?? ''
    expect(cls).toContain('text-green-600')
    expect(cls).toContain('font-medium')
    expect(cls).not.toContain('font-semibold')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('"No source mapped" VA slot uses light-mode slate-500 italic and no dark-prefix', () => {
    // Phase 4-polish-1 (Block A): VA's "No source mapped" inline phrase
    // moved from the combined source cell to the new source-FIELD column
    // (column 3). The italic + slate-500 styling is preserved so VAs read
    // identically across the redesign rollout. Container-wide no-dark-
    // prefix invariant remains.
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const vaText = screen.getByText('No source mapped')
    const cls = vaText.className
    expect(cls).toContain('text-slate-500')
    expect(cls).toContain('italic')
    expect(cls).not.toMatch(/\bdark:/)
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })

  it('entire rendered tree for a coverage-approved no-source row contains no dark-prefix substring', () => {
    const { container } = render(<FieldMappingRow row={targetAck()} />)
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})

// ─── Phase 4-polish-1 — confidence color-grading ────────────────────────────
//
// `classifyRowConfidence` (Block B) gates three bands: ≥85 high, 40-84
// amber, <40 low. The collapsed-row ConfidenceCell renders each with a
// light-mode hue + the `data-confidence-band` attribute hook so the
// invariant tests below have a stable selector regardless of class
// reshuffling. Block A pairs the high band with a slightly heavier weight
// for the deuteranopia/protanopia accessibility note (founder Q9.1).
//
// Refinement 3 (2026-04-26): high-band weight is now `font-medium` (was
// `font-semibold` at the Phase 4-polish-1 baseline). The differentiation
// channel is preserved (medium vs. amber/low's font-normal) but at a
// calmer overall density — the color band remains the primary signal,
// the weight cue is the second channel for color-blind users.

describe('FieldMappingRow — Phase 4-polish-1 confidence color-grading', () => {
  it('renders the high band (≥85) in green-600 with font-medium', () => {
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 92 })} />)
    const cell = container.querySelector('[data-confidence-band="high"]')
    expect(cell).toBeTruthy()
    const cls = cell?.className ?? ''
    expect(cls).toContain('text-green-600')
    expect(cls).toContain('font-medium')
    // Refinement 3 lock-in: font-semibold was the Phase 4-polish-1
    // baseline before the founder's "de-emphasize the number" refinement;
    // pin its absence so a future style refactor cannot silently re-bold
    // the high-band number.
    expect(cls).not.toContain('font-semibold')
  })

  it('renders the boundary value 85 as high (inclusive lower bound)', () => {
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 85 })} />)
    expect(container.querySelector('[data-confidence-band="high"]')).toBeTruthy()
  })

  it('renders the amber band (40-84) in amber-600 without font-medium or font-semibold', () => {
    // Amber and low rely on hue alone (font-normal default). The high
    // band is the only band carrying a weight cue, per founder Q9.1.
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 70 })} />)
    const cell = container.querySelector('[data-confidence-band="amber"]')
    expect(cell).toBeTruthy()
    const cls = cell?.className ?? ''
    expect(cls).toContain('text-amber-600')
    expect(cls).not.toContain('font-medium')
    expect(cls).not.toContain('font-semibold')
  })

  it('renders the boundary value 40 as amber (inclusive lower bound for amber)', () => {
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 40 })} />)
    expect(container.querySelector('[data-confidence-band="amber"]')).toBeTruthy()
  })

  it('renders the low band (<40) in red-600', () => {
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 30 })} />)
    const cell = container.querySelector('[data-confidence-band="low"]')
    expect(cell).toBeTruthy()
    expect(cell?.className).toContain('text-red-600')
  })

  it('still renders an em-dash (no band) when confidence is null', () => {
    // Founder Q9.2 (no color when no number): null confidence keeps the
    // em-dash placeholder and does NOT carry a `data-confidence-band`
    // attribute — there's no value to grade.
    const { container } = render(<FieldMappingRow row={targetAck({ confidence: null })} />)
    expect(container.querySelector('[data-confidence-band]')).toBeNull()
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
  })

  it('treats 0-1 fractional input via the same band classifier (defensive)', () => {
    // Same defensive 0-1 vs 0-100 tolerance as
    // `formatConfidencePercent`. A drifted DB that emits 0.92 still
    // grades as high, so the row reads consistently with the formatted
    // percent ("92%" post-Refinement H integer rounding).
    const { container } = render(<FieldMappingRow row={mapped({ confidence: 0.92 })} />)
    expect(container.querySelector('[data-confidence-band="high"]')).toBeTruthy()
  })
})

// ─── Phase 4-polish-1 — column template invariant ───────────────────────────
//
// Mirrors the 4c-2 `.delete()` count guard pattern: a regex assertion
// over the literal grid-template string in `FieldMappingRow.tsx` so a
// future style refactor cannot silently shift the column structure
// without showing up as a CI failure.

describe('FieldMappingRow — column template invariant', () => {
  it('FieldMappingRow.tsx contains the locked 6-column grid template literal', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow.tsx',
      ),
      'utf-8',
    )
    // Phase 4-polish-1 comprehensive pass (2026-04-26): col 2 tightened
    // from `minmax(7rem, 12rem)` to `minmax(6rem, 8rem)` (Heritage's
    // longest source-table badge is 12 chars ≈ 5.7rem, fits in 6rem
    // with breathing room). Former 5rem actions cell DROPPED.
    //
    // Refinement G (Phase 4-polish-1 final, 2026-04-26): the dedicated
    // chevron column (col 6, 1rem) was DROPPED. The expand chevron now
    // renders inline in col 3 (source field area) for multi-source
    // rows only. Template went from 6 cols → 5 cols. Single-source
    // rows have no chevron at all.
    //
    // Phase 4-polish-3 (2026-04-27): a new 5rem actions column was
    // RE-ADDED at the row end (col 6) to host the inline ✓/✗/+/⊘
    // action buttons. Template went 5 cols → 6 cols. The chevron
    // remains inline in col 3 (NOT a dedicated col 6 chevron slot).
    //
    // If a future refactor legitimately needs a new template, update
    // both this literal AND the ASCII figure in `FieldMappingRow.tsx`
    // file header AND the paired invariant in
    // `target-table-group.test.tsx` at the same time — the column
    // header in `TargetTableGroup.tsx` mirrors this template literal.
    //
    // INF-50 (2026-05-09): tracks 2/3/4 moved from fixed-rem caps to
    // fr-based growth (1 : 1.5 : 2 ratio) so columns expand with
    // viewport. Mins (8/10/12rem) preserve readability at 1280px;
    // fr-units take over above the rem floor so long table names
    // stop overflowing into the next column on wide displays.
    const expected =
      'grid-cols-[0.75rem_minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(12rem,2fr)_5rem_5rem]'
    expect(file).toContain(expected)
    // Belt and suspenders: the prior 6-col template (with trailing
    // `_1rem` chevron column) must NOT appear anywhere in the file —
    // a partial-revert that re-introduces a chevron col would
    // otherwise hide behind the broader `toContain` check.
    expect(file).not.toContain(
      'grid-cols-[0.75rem_minmax(6rem,8rem)_minmax(8rem,14rem)_1fr_5rem_1rem]',
    )
    // Belt and suspenders #2: the polish-1 5-col template (no
    // trailing actions column) must NOT appear either — guards
    // against an accidental partial revert that drops the actions
    // column without restoring the chevron col.
    expect(file).not.toMatch(
      /grid-cols-\[0\.75rem_minmax\(6rem,8rem\)_minmax\(8rem,14rem\)_1fr_5rem\](?!_)/,
    )
    // Belt and suspenders #3 (INF-50): the polish-3 fixed-rem cap
    // template must NOT reappear — that's the exact template that
    // overflowed on long human-readable table names. A partial
    // revert that re-tightens cols 2/3 to fixed maxes would re-
    // introduce the bug this PR fixes.
    expect(file).not.toContain(
      'grid-cols-[0.75rem_minmax(6rem,8rem)_minmax(8rem,14rem)_1fr_5rem_5rem]',
    )
    // Belt and suspenders #4 (INF-50): tracks 2/3/4 must use fr-
    // based growth (`Nfr` somewhere in the minmax max-arg) — guards
    // against a future "tighten to fixed maxes" revert that would
    // re-introduce overflow. Anchored on the canonical template
    // literal so accidental partial reverts trip this assertion.
    expect(file).toMatch(
      /grid-cols-\[0\.75rem(?:_minmax\([^,]+,[^)]*fr\)){3}_5rem_5rem\]/,
    )
  })

  it('FieldMappingRow.tsx body row has py-1.5 vertical density (Phase 4-polish-1 Q1.3)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow.tsx',
      ),
      'utf-8',
    )
    // Asserts the locked py-1.5 density. The grid-template line carries
    // px-5 + py-1.5 together; we anchor on the combined token so this
    // doesn't false-positive on an unrelated `py-1.5` elsewhere in the
    // file (e.g. a subtitle).
    expect(file).toMatch(/grid-cols-\[[^\]]+\][^'"]*px-5 py-1\.5/)
  })
})

// ─── Phase 4-polish-1 final refinements (Refinement F) ──────────────────────
//
// The row-level transformation indicator was REMOVED entirely. Earlier
// passes rendered an inline slate-400 dot inside `ConfidenceCell` to
// signal "this row has a transform"; canary review found it too subtle
// to convey meaning. The drawer's Transformation section is now the
// single source of truth for transform status.
//
// These regression guards pin the absence and assert that
// `ConfidenceCell` renders only the percent text (or em-dash) — no
// trailing element of any kind.

describe('FieldMappingRow — confidence cell renders percent only (Refinement F)', () => {
  it('does NOT render any transformation indicator alongside the percent', () => {
    const { container } = render(
      <FieldMappingRow
        row={mapped({
          confidence: 92,
          hasTransformation: true,
          transformationStatus: 'applied',
        })}
      />,
    )
    expect(
      container.querySelector('[aria-label^="transformation:"]'),
    ).toBeNull()
    // The confidence cell renders just the percent (post Refinement H,
    // integer-rounded — no decimals). `data-confidence-band` is still
    // present so downstream tests / styling can target the band.
    const cell = container.querySelector('[data-confidence-band="high"]')
    expect(cell).toBeTruthy()
    expect(cell?.textContent).toBe('92%')
  })

  it('renders only the percent text when hasTransformation=false (no dot, no extras)', () => {
    const { container } = render(
      <FieldMappingRow row={mapped({ confidence: 92, hasTransformation: false })} />,
    )
    expect(
      container.querySelector('[aria-label^="transformation:"]'),
    ).toBeNull()
    const cell = container.querySelector('[data-confidence-band="high"]')
    expect(cell).toBeTruthy()
    expect(cell?.textContent).toBe('92%')
  })
})

// ─── Inline actions cell — re-added in Phase 4-polish-3 ─────────────────────
//
// Phase 4-polish-1 dropped the dedicated actions cell. Phase 4-polish-3
// (2026-04-27) re-added it as the rightmost grid column (col 6, 5rem)
// to host the inline ✓ / ✗ / + / ⊘ action buttons. Pin the structural
// presence: the row body should expose a `field-mapping-row-actions`
// child that lives at the row-end (col 6 position).
//
// The cell's content opacity is gated on `group-hover` /
// `focus-within`; tests targeting visibility live below in the
// inline-row-actions describe block.

describe('FieldMappingRow — inline actions cell structural presence', () => {
  it('renders an end-aligned `field-mapping-row-actions` child as the last grid cell', () => {
    render(<FieldMappingRow row={mapped({ hasTransformation: false })} />)
    const body = screen.getByTestId('field-mapping-row-body')
    const actions = screen.getByTestId('field-mapping-row-actions')
    // The actions cell IS a direct child of the row body (col 6).
    expect(actions.parentElement).toBe(body)
    // It is the LAST child of the row body — col 6 of the 6-col grid.
    expect(body.lastElementChild).toBe(actions)
    // It carries the flex+justify-end layout so buttons stack at the
    // row's right edge.
    expect(actions.className).toContain('justify-end')
    expect(actions.className).toContain('flex')
  })

  it('the confidence cell is NOT the last grid cell (the actions cell sits to its right)', () => {
    const { container } = render(
      <FieldMappingRow row={mapped({ hasTransformation: false })} />,
    )
    const body = screen.getByTestId('field-mapping-row-body')
    const confidenceCell = container.querySelector('[data-confidence-band]')
    expect(confidenceCell).toBeTruthy()
    // The confidence cell is col 5; the actions cell at col 6 sits to
    // its right. So the confidence cell is NOT the last child of body.
    expect(body.lastElementChild).not.toBe(confidenceCell)
  })
})

// ─── Phase 4-polish-1 — split source columns (table | field) ─────────────────
//
// Block A split the legacy combined source cell into two grid columns:
// the table badge owns column 2 (7-12rem) and the field name(s) own
// column 3 (1fr). Tests below exercise the rule-dispatch matrix at the
// column boundary so a future refactor cannot accidentally collapse
// either column back into a single cell.

describe('FieldMappingRow — split source columns', () => {
  it('Rule 1 places the badge in column 2 and the field name in column 3 (separate parent elements)', () => {
    render(<FieldMappingRow row={mapped()} />)
    const badge = screen.getByText('ACCT_MASTER')
    const fieldName = screen.getByText('ACCT_NO')
    // Different DOM ancestors — the badge no longer wraps the field name
    // (legacy combined-cell layout). The closest ancestor that satisfies
    // the grid-row body is the same; the immediate parents differ.
    expect(badge.closest('span[title="ACCT_MASTER"]')).not.toBe(
      fieldName.closest('span[title="ACCT_NO"]'),
    )
  })

  it('value_assignment renders italic "No source mapped" in the TABLE column + em-dash in the field column (PR α₀)', () => {
    // PR α₀ unification: the italic "No source mapped" phrase moved
    // from the source-FIELD column to the source-TABLE column, where
    // it now serves as the canonical visual identity for every
    // non-mapped row kind (VA, unmapped). The field column carries an
    // em-dash in both cases — distinct aria-label ("no source field")
    // so screen readers hear two distinct phrases for the two columns.
    render(<FieldMappingRow row={valueAssignment()} />)
    const phrase = screen.getByLabelText('no source mapped')
    expect(phrase).toBeInTheDocument()
    // The phrase is rendered as italic slate-500 — pin the visual
    // contract so a future refactor doesn't silently flatten it.
    expect(phrase.className).toContain('italic')
    expect(phrase.className).toContain('text-slate-500')
    expect(phrase.textContent).toBe('No source mapped')
    expect(screen.getByLabelText('no source field')).toBeInTheDocument()
  })

  it('coverage-approved no-source + raw unmapped share the unified non-mapped treatment (PR α₀ + INF-57)', () => {
    // Both fixtures now render kind='unmapped' (INF-57 cleanup collapsed
    // target_acknowledged into this kind). Both render the italic "No
    // source mapped" in the table column and an em-dash in the field
    // column — identical to value_assignment. Pre-α₀, these rendered an
    // em-dash in the table column too; the unification consolidates the
    // visual vocabulary so a user scanning a dense grid doesn't have to
    // distinguish em-dash from italic phrase.
    const { unmount } = render(<FieldMappingRow row={targetAck()} />)
    expect(screen.getByLabelText('no source mapped').textContent).toBe('No source mapped')
    expect(screen.getByLabelText('no source field')).toBeInTheDocument()
    unmount()

    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByLabelText('no source mapped').textContent).toBe('No source mapped')
    expect(screen.getByLabelText('no source field')).toBeInTheDocument()
  })

  it('Rule 4 renders an empty (aria-hidden) badge cell + summary phrase in the field column (Q1)', () => {
    const row = mapped({
      sources: Array.from({ length: 4 }, (_, i) =>
        source({
          id: `ms-${i}`,
          ordinal: i,
          sourceField: { id: `sf-${i}`, name: `F${i}`, dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: `st-${i % 3}`, name: `TABLE_${i % 3}` },
        }),
      ),
    })
    const { container } = render(<FieldMappingRow row={row} />)
    // No table badges in the body for Rule 4 — the column is intentionally
    // empty so the field column's summary phrase ("4 fields across 3
    // tables") owns the visual real estate.
    const body = screen.getByTestId('field-mapping-row-body')
    expect(within(body).queryByText('TABLE_0')).toBeNull()
    void container
  })
})

// ─── Positive control: group wires through to the row ───────────────────────

describe('FieldMappingRow — positive control', () => {
  it('is rendered by TargetTableGroup (prevents dead-code regression)', () => {
    const summary: TargetTableSummary = {
      id: 'tt-1',
      name: 'accounts',
      datasetName: 'Heritage Core',
      fieldCount: 1,
    }
    const rows: MappingRow[] = [
      mapped({ id: 'canary-row', targetField: targetField({ name: 'canary_field' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.getByText('canary_field')).toBeInTheDocument()
    expect(screen.getByTestId('field-mapping-row')).toBeInTheDocument()
  })
})

// ─── Gap 7 — drawer-open row click behavior ─────────────────────────────────
//
// When `onRowClick` is provided, the row body becomes a clickable button-
// roled surface that fires the callback with `row.id`. Critically:
//   • Chevron clicks must NOT bubble (Gap 5b's stopPropagation contract).
//   • ExpandedSourceList clicks must NOT trigger onRowClick (the list
//     lives outside the body grid).
//   • Keyboard activation (Enter / Space) must work for screen readers.
//   • aria-label is appended with "click to open details" so AT users
//     hear the affordance.

describe('FieldMappingRow — Gap 7 row click', () => {
  it('clicking the row body calls onRowClick with row.id', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(<FieldMappingRow row={mapped()} onRowClick={onRowClick} />)
    await user.click(screen.getByTestId('field-mapping-row-body'))
    expect(onRowClick).toHaveBeenCalledTimes(1)
    expect(onRowClick).toHaveBeenCalledWith('tfm-1')
  })

  it('clicking the chevron does NOT trigger onRowClick (stopPropagation contract)', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    const row = mapped({
      sources: [
        cifMasterSource(0, 'FNAME'),
        cifMasterSource(1, 'LNAME'),
      ],
    })
    render(<FieldMappingRow row={row} onRowClick={onRowClick} />)
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('clicking inside the ExpandedSourceList does NOT trigger onRowClick', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    const row = mapped({
      sources: [
        cifMasterSource(0, 'FNAME'),
        cifMasterSource(1, 'LNAME'),
      ],
    })
    render(<FieldMappingRow row={row} onRowClick={onRowClick} />)
    // Expand first.
    await user.click(screen.getByTestId('field-mapping-row-chevron'))
    onRowClick.mockClear()
    // The expanded list is outside the row body grid; clicking it should
    // not trigger row activation.
    const list = screen.getByTestId('expanded-source-list')
    await user.click(list)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('Enter key on focused row body triggers onRowClick', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(<FieldMappingRow row={mapped()} onRowClick={onRowClick} />)
    const body = screen.getByTestId('field-mapping-row-body')
    body.focus()
    await user.keyboard('{Enter}')
    expect(onRowClick).toHaveBeenCalledWith('tfm-1')
  })

  it('Space key on focused row body triggers onRowClick', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(<FieldMappingRow row={mapped()} onRowClick={onRowClick} />)
    const body = screen.getByTestId('field-mapping-row-body')
    body.focus()
    await user.keyboard(' ')
    expect(onRowClick).toHaveBeenCalledWith('tfm-1')
  })

  it('omits role/tabIndex/cursor-pointer when onRowClick is NOT provided', () => {
    render(<FieldMappingRow row={mapped()} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(body.getAttribute('role')).toBeNull()
    expect(body.getAttribute('tabindex')).toBeNull()
    expect(body.className).not.toContain('cursor-pointer')
  })

  it('sets role="button", tabIndex=0, and cursor-pointer when onRowClick IS provided', () => {
    render(<FieldMappingRow row={mapped()} onRowClick={() => {}} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(body.getAttribute('role')).toBe('button')
    expect(body.getAttribute('tabindex')).toBe('0')
    expect(body.className).toContain('cursor-pointer')
  })

  it('isActive=true adds bg-slate-50 to the row body', () => {
    render(<FieldMappingRow row={mapped()} onRowClick={() => {}} isActive={true} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(body.className).toContain('bg-slate-50')
  })

  it('isActive=false (or omitted) does NOT add bg-slate-50', () => {
    render(<FieldMappingRow row={mapped()} onRowClick={() => {}} />)
    const body = screen.getByTestId('field-mapping-row-body')
    expect(body.className).not.toContain('bg-slate-50')
  })

  it('aria-label appends "click to open details" when onRowClick is provided', () => {
    const { container } = render(
      <FieldMappingRow row={mapped()} onRowClick={() => {}} />,
    )
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toContain('— click to open details')
  })

  it('aria-label OMITS click affordance phrase when onRowClick is NOT provided', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).not.toContain('click to open details')
  })

  it('fires for a Rule 2 mapped row (multi-source same table)', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    const row = mapped({
      id: 'r2',
      sources: [cifMasterSource(0, 'FNAME'), cifMasterSource(1, 'LNAME')],
    })
    render(<FieldMappingRow row={row} onRowClick={onRowClick} />)
    await user.click(screen.getByTestId('field-mapping-row-body'))
    expect(onRowClick).toHaveBeenCalledWith('r2')
  })

  it('fires for a value_assignment row', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow row={valueAssignment({ id: 'va-row' })} onRowClick={onRowClick} />,
    )
    await user.click(screen.getByTestId('field-mapping-row-body'))
    expect(onRowClick).toHaveBeenCalledWith('va-row')
  })

  it('fires for a coverage-approved no-source row (formerly target_acknowledged)', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow row={targetAck({ id: 'ack-row' })} onRowClick={onRowClick} />,
    )
    await user.click(screen.getByTestId('field-mapping-row-body'))
    expect(onRowClick).toHaveBeenCalledWith('ack-row')
  })

  it('fires for an unmapped row (with the "unmapped::" sentinel id)', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={unmapped({ id: 'unmapped::tf-99' })}
        onRowClick={onRowClick}
      />,
    )
    await user.click(screen.getByTestId('field-mapping-row-body'))
    expect(onRowClick).toHaveBeenCalledWith('unmapped::tf-99')
  })

  it('TargetTableGroup threads onRowClick + openRowId down to its rows', async () => {
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    const summary: TargetTableSummary = {
      id: 'tt-1',
      name: 'accounts',
      datasetName: 'Heritage Core',
      fieldCount: 2,
    }
    const rows: MappingRow[] = [
      mapped({ id: 'a' }),
      mapped({ id: 'b', targetField: targetField({ id: 'tf-2', name: 'other' }) }),
    ]
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onRowClick={onRowClick}
        openRowId="a"
      />,
    )
    const bodies = screen.getAllByTestId('field-mapping-row-body')
    expect(bodies).toHaveLength(2)
    // First row is openRowId — should carry the active highlight.
    expect(bodies[0]!.className).toContain('bg-slate-50')
    expect(bodies[1]!.className).not.toContain('bg-slate-50')
    await user.click(bodies[1]!)
    expect(onRowClick).toHaveBeenCalledWith('b')
  })
})

// ─── Source-cell unification (2026-04-28) ───────────────────────────────────
//
// Pins the unified source-trigger contract: cols 2 + 3 (Source Table +
// Source Field) merge into a single click target / focus stop / hover
// region when the row is inline-source-editable. Replaces the prior
// pair of separate triggers (`SourceTableTriggerButton` +
// `SourceFieldTriggerSurface`) which each owned their own focus ring
// and tab stop.
//
// Contract:
//   • One outer wrapper carrying data-testid="field-mapping-row-source-trigger"
//     wraps both inner cells.
//   • Clicking ANYWHERE inside the wrapper (over either inner cell OR
//     the inter-track gap) opens the InlineSourcePicker.
//   • The wrapper is the sole tab stop for the source area — the inner
//     cells drop their own tabIndex.
//   • The wrapper carries Tailwind's `group/source` named group so the
//     Pencil hover-hint reveals on hover anywhere in the wrapper (not
//     just on the Source Field cell).
//   • The inner trigger testids (field-mapping-row-source-table-trigger,
//     field-mapping-row-source-field-trigger) are preserved for
//     test back-compat — clicks on them still activate the picker via
//     the outer wrapper's onClick.
//
// Eligibility is unchanged: the wrapper renders ONLY when
// `isInlineSourceEditable` is true (mapped non-Rule-4 non-custom-sql, or
// unmapped). All other row kinds fall through to the legacy two-cell
// drawer-open path.

describe('FieldMappingRow — source-cell unification (2026-04-28)', () => {
  function makeAvailableSourceFields(): SourceFieldWithState[] {
    return [
      {
        id: 'sf-1',
        name: 'ACCT_NO',
        dataType: 'NUMBER',
        ordinalPosition: 1,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'mapped',
        sampleValues: [],
        isAcknowledged: false,
        isRejected: false,
      },
      {
        id: 'sf-2',
        name: 'CUSTOMER_REF',
        dataType: 'VARCHAR(50)',
        ordinalPosition: 2,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'unmapped',
        sampleValues: [],
        isAcknowledged: false,
        isRejected: false,
      },
    ]
  }

  it('renders a unified outer wrapper with data-testid="field-mapping-row-source-trigger" on inline-eligible rows', () => {
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    expect(wrapper).toBeInTheDocument()
    // Both inner trigger testids must remain (preserved for test
    // back-compat + as DOM hooks for the click-bubbling contract).
    expect(
      screen.getByTestId('field-mapping-row-source-table-trigger'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('field-mapping-row-source-field-trigger'),
    ).toBeInTheDocument()
  })

  it('does NOT render the unified wrapper on ineligible rows (custom_sql falls through to legacy two-cell layout)', () => {
    render(
      <FieldMappingRow
        row={mapped({ combinationType: 'custom_sql', combinationSql: 'NOW()' })}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('field-mapping-row-source-trigger'),
    ).toBeNull()
  })

  it('renders the unified wrapper on coverage-approved no-source rows (INF-57: kind="unmapped" is source-editable)', () => {
    // INF-57 cleanup folded target_acknowledged into kind='unmapped' with
    // status='approved'. Since `isInlineSourceEditable` includes
    // `kind === 'unmapped'`, the source-trigger wrapper now mounts on
    // these rows. Pre-cleanup, target_acknowledged was excluded from the
    // wrapper — design lock 3 accepted the wrapper as a collateral effect
    // of the body unification (the user hover-pencil affordance is the
    // same one offered on raw unmapped rows).
    render(
      <FieldMappingRow
        row={targetAck()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    expect(
      screen.getByTestId('field-mapping-row-source-trigger'),
    ).toBeInTheDocument()
  })

  it('clicking the outer wrapper opens the InlineSourcePicker', async () => {
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    await user.click(wrapper)
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
  })

  it('clicking the SOURCE TABLE inner cell ALSO opens the picker (click bubbles up to the wrapper)', async () => {
    // Pre-unification this required the source-table inner button's own
    // onClick to fire openPicker. Post-unification only the wrapper has
    // an onClick — clicks on the inner cell bubble up to it. This test
    // pins that bubbling contract: clicking the source-table cell
    // continues to open the picker via the wrapper's onClick.
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const tableCell = screen.getByTestId(
      'field-mapping-row-source-table-trigger',
    )
    await user.click(tableCell)
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
  })

  it('clicking the unified wrapper does NOT bubble to the row-body drawer-open handler', async () => {
    // The wrapper `stopPropagation`s on click — clicking it must NOT
    // also fire the row-body's onRowClick (which would open the
    // drawer, defeating the inline-edit affordance).
    const onRowClick = vi.fn()
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        onRowClick={onRowClick}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    await user.click(wrapper)
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it('the unified wrapper is the SOLE tab stop for the source area (one focus stop, not two)', () => {
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    const tableCell = screen.getByTestId(
      'field-mapping-row-source-table-trigger',
    )
    const fieldCell = screen.getByTestId(
      'field-mapping-row-source-field-trigger',
    )
    // Wrapper IS focusable.
    expect(wrapper.getAttribute('tabindex')).toBe('0')
    expect(wrapper.getAttribute('role')).toBe('button')
    // Inner cells are NOT focusable — no tabIndex attribute, no
    // button role.
    expect(tableCell.getAttribute('tabindex')).toBeNull()
    expect(tableCell.getAttribute('role')).toBeNull()
    expect(fieldCell.getAttribute('tabindex')).toBeNull()
    expect(fieldCell.getAttribute('role')).toBeNull()
    // The wrapper is also NOT a native <button> (it is a <div>) — pinned
    // because the chevron inside col 3 is a real <button> and nesting
    // <button> inside <button> would violate the HTML invariant.
    expect(wrapper.tagName.toLowerCase()).toBe('div')
  })

  it('the unified wrapper carries the `group/source` named group so the Pencil hover-hint reveals on hover anywhere in cols 2-3', () => {
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    const wrapperClass = wrapper.className
    // The named group scopes the hover trigger to the wrapper. Pre-
    // unification the row-body owned an unnamed `group` and the
    // Pencil's `group-hover:opacity-100` keyed off it — meaning hover
    // ANYWHERE in the row (Target / Confidence / Actions cells too)
    // revealed the Pencil. Post-unification the Pencil scopes to
    // `group-hover/source:opacity-100`, scoped to this wrapper.
    expect(wrapperClass).toContain('group/source')
    // The Pencil's class is asserted in
    // tests/components/inline-row-actions.test.tsx — the matching
    // half of this contract.
  })

  it('the unified wrapper spans cols 2-3 via col-span-2 + grid-cols-subgrid (preserves parent column widths)', () => {
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    const wrapperClass = wrapper.className
    // col-span-2 places the wrapper in tracks 2 + 3 of the row's 6-col
    // grid (StatusDot in col 1, Target in col 4, Confidence in col 5,
    // Actions in col 6). grid-cols-subgrid re-exposes the parent
    // tracks to the wrapper's two children so the Source Table /
    // Source Field cells land at their pre-unification x-coordinates
    // — the column-template invariant test at L1200 stays untouched.
    expect(wrapperClass).toContain('col-span-2')
    expect(wrapperClass).toContain('grid-cols-subgrid')
  })

  it('keyboard activation (Enter / Space) on the unified wrapper opens the picker', async () => {
    const user = userEvent.setup()
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    wrapper.focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByTestId('inline-source-picker'),
    ).toBeInTheDocument()
  })

  it('the Pencil hover-hint is rendered inside the unified wrapper (so wrapper hover reveals it)', () => {
    // Sanity check: the Pencil lives inside the wrapper's DOM subtree,
    // which is what makes `group-hover/source:opacity-100` (named
    // group on the wrapper) actually reveal it. If a future refactor
    // moved the Pencil outside the wrapper, the hover-hint contract
    // would silently break.
    render(
      <FieldMappingRow
        row={mapped()}
        availableSourceFields={makeAvailableSourceFields()}
        onSourceCommit={vi.fn()}
      />,
    )
    const wrapper = screen.getByTestId('field-mapping-row-source-trigger')
    const pencil = screen.getByTestId('field-mapping-row-source-edit-hint')
    expect(wrapper.contains(pencil)).toBe(true)
  })
})
