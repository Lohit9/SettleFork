import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
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
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
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
    targetField: targetField({ id: 'tf-va', name: 'created_at' }),
    confidence: 95,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    combinationType: 'custom_sql',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

// INF-57 cleanup — coverage-approved no-source row (formerly target_acknowledged).
function targetAck(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-ack',
    targetField: targetField({ id: 'tf-ack', name: 'internal_flag' }),
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
    id: 'unmapped::tf-u',
    targetField: targetField({ id: 'tf-u', name: 'missing_field' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
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

  it('does NOT render the dataset name as a subtitle (Refinement A)', () => {
    // Phase 4-polish-1 final refinements (Refinement A, 2026-04-26):
    // the dataset-name subtitle ("Nymbus Core" / "Heritage Core" /
    // etc.) was dropped from the group header. Every group is in
    // the same target dataset and the page header already
    // identifies it; the subtitle was redundant noise. Pin its
    // absence so a future refactor cannot silently re-add it.
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(screen.queryByText('Heritage Core')).toBeNull()
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

  it('does not render the dataset name even when datasetName is non-empty (Refinement A)', () => {
    // Refinement A: the subtitle is unconditionally absent. This test
    // duplicates the "does NOT render the dataset name as a subtitle"
    // assertion above with a different prop shape (empty string vs.
    // populated) — both must hold.
    render(
      <TargetTableGroup
        targetTable={{ ...summary, datasetName: '' }}
        rows={[]}
      />,
    )
    expect(screen.queryByText('Heritage Core')).toBeNull()
  })

  // ─── Gap 3 — filteredCount prop ──────────────────────────────────────────

  it('renders "X of Y fields" when filteredCount is provided and matching < total', () => {
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        filteredCount={{ total: 19, matching: 3 }}
      />,
    )
    expect(screen.getByTestId('target-table-field-count')).toHaveTextContent(
      '3 of 19 fields',
    )
  })

  it('falls back to "Y fields" when filteredCount.matching === filteredCount.total', () => {
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        filteredCount={{ total: 19, matching: 19 }}
      />,
    )
    expect(screen.getByTestId('target-table-field-count')).toHaveTextContent(
      '19 fields',
    )
    expect(screen.getByTestId('target-table-field-count')).not.toHaveTextContent(
      ' of ',
    )
  })

  it('renders filtered-empty state when filteredCount.matching === 0', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[]}
        filteredCount={{ total: 19, matching: 0 }}
      />,
    )
    expect(screen.getByTestId('target-table-filtered-empty')).toBeInTheDocument()
    expect(
      screen.getByTestId('target-table-filtered-empty'),
    ).toHaveTextContent(/no fields match/i)
    expect(screen.queryByText(/no fields to display for this table/i)).toBeNull()
  })

  it('shows unfiltered "Y fields" when filteredCount is omitted (Gap 4c backward compat)', () => {
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(screen.getByTestId('target-table-field-count')).toHaveTextContent(
      '3 fields',
    )
  })

  // ─── Kind-mix integration (Gap 5a) ───────────────────────────────────────
  // Ensures the group delegates every MappingRow kind to FieldMappingRow
  // correctly. FieldMappingRow.test.tsx covers the per-kind rendering
  // contract; this case is a shallow integration check that the group
  // component doesn't filter or swallow any kind.

  it('renders every row kind (mapped, VA, coverage-approved no-source, unmapped) in a mixed group', () => {
    const rows: MappingRow[] = [
      mapped({
        id: 'r-m',
        targetField: targetField({ id: 'f-m', name: 'account_id' }),
      }),
      valueAssignment({
        id: 'r-va',
        targetField: targetField({ id: 'f-va', name: 'created_at' }),
      }),
      // Coverage-approved no-source row (formerly target_acknowledged).
      // Post-INF-57 this surfaces as kind='unmapped' with status='approved'.
      targetAck({
        id: 'r-ack',
        targetField: targetField({ id: 'f-ack', name: 'internal_flag' }),
      }),
      unmapped({
        id: 'r-u',
        targetField: targetField({ id: 'f-u', name: 'missing_field' }),
      }),
    ]
    render(
      <TargetTableGroup
        targetTable={{ ...summary, fieldCount: rows.length }}
        rows={rows}
      />,
    )
    const rowEls = screen.getAllByTestId('field-mapping-row')
    expect(rowEls).toHaveLength(4)
    // Each kind appears via its data-row-kind attribute — stable hook that
    // also powers smoke tests and snapshots. The two 'unmapped' entries
    // reflect the post-INF-57 unification: coverage-approved no-source
    // rows share the discriminator with raw unmapped rows.
    const kinds = rowEls.map((el) => el.getAttribute('data-row-kind'))
    expect(kinds).toEqual([
      'mapped',
      'value_assignment',
      'unmapped',
      'unmapped',
    ])
    // Target field name for every kind renders (spot-check).
    expect(screen.getByText('account_id')).toBeInTheDocument()
    expect(screen.getByText('created_at')).toBeInTheDocument()
    expect(screen.getByText('internal_flag')).toBeInTheDocument()
    expect(screen.getByText('missing_field')).toBeInTheDocument()
  })
})

// ─── Phase 4-polish-1 comprehensive pass — column header strip ──────────────
//
// The legacy mapping page rendered three column labels ("Source Field",
// "Conf.", "Target Field") inside each table group's expanded body,
// between the group header and the first row. The redesign dropped them
// in Gap 4c; this comprehensive pass restored them. These tests pin the
// new behavior as a regression surface.

describe('TargetTableGroup — column header strip', () => {
  it('renders the column header strip when there are rows', () => {
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.getByTestId('target-table-column-headers')).toBeInTheDocument()
  })

  it('renders four split-cell labels (Source Table / Source Field / Target Field / Conf.)', () => {
    // Refinement E (Phase 4-polish-1 final, 2026-04-26): the prior
    // unified "Source Field" header (cols 2-3 spanning) was split
    // into two single-cell headers — "Source Table" (col 2) and
    // "Source Field" (col 3). Canary review found the unified label
    // read as describing only col 3; col 2 felt header-less.
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const header = screen.getByTestId('target-table-column-headers')
    expect(within(header).getByText('Source Table')).toBeInTheDocument()
    expect(within(header).getByText('Source Field')).toBeInTheDocument()
    expect(within(header).getByText('Target Field')).toBeInTheDocument()
    expect(within(header).getByText('Conf.')).toBeInTheDocument()
  })

  it('places each header in its own grid cell (no column-spanning) — Refinement E', () => {
    // Pin the absence of `col-start-2 col-end-4` (the prior unified-
    // label pattern) and confirm the four split cells each surface
    // their own data-testid hook.
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const header = screen.getByTestId('target-table-column-headers')
    expect(within(header).getByTestId('target-table-column-header-source-table'))
      .toBeInTheDocument()
    expect(within(header).getByTestId('target-table-column-header-source-field'))
      .toBeInTheDocument()
    expect(within(header).getByTestId('target-table-column-header-target-field'))
      .toBeInTheDocument()
    expect(within(header).getByTestId('target-table-column-header-confidence'))
      .toBeInTheDocument()
    // Belt and suspenders: no element inside the header carries the
    // legacy spanning class.
    expect(header.innerHTML).not.toContain('col-start-2')
    expect(header.innerHTML).not.toContain('col-end-4')
  })

  it('hides the column header strip when the group has no rows (Gap 4c empty branch)', () => {
    // Without rows the header would label content that does not exist —
    // a confusing surface. The empty/placeholder branch suppresses the
    // header per the Phase 4-polish-1 comprehensive pass contract.
    render(<TargetTableGroup targetTable={summary} rows={[]} />)
    expect(
      screen.queryByTestId('target-table-column-headers'),
    ).not.toBeInTheDocument()
  })

  it('hides the column header strip in the filtered-empty branch (matching === 0)', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[]}
        filteredCount={{ total: 19, matching: 0 }}
      />,
    )
    expect(
      screen.queryByTestId('target-table-column-headers'),
    ).not.toBeInTheDocument()
    // Sanity: the filtered-empty body renders instead.
    expect(screen.getByTestId('target-table-filtered-empty')).toBeInTheDocument()
  })

  it('marks the column header strip as aria-hidden (visual aid only)', () => {
    // The FieldMappingRow already carries a self-contained `aria-label`
    // covering target / source / status / confidence; the visual header
    // is purely a sighted-user navigation aid. Full ARIA grid semantics
    // would require restructuring `role="list"` everywhere, which is a
    // separate accessibility polish.
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const header = screen.getByTestId('target-table-column-headers')
    expect(header.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses the same 6-column grid template as FieldMappingRow (column-template invariant)', () => {
    // The header column widths MUST mirror the row's grid template
    // byte-for-byte — otherwise headers and row content drift apart on
    // the column grid. If a future refactor changes the row template
    // (in `FieldMappingRow.tsx`), this test fails alongside the row's
    // own column-template invariant test, forcing both to update in
    // lock-step.
    const rows: MappingRow[] = [
      mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const header = screen.getByTestId('target-table-column-headers')
    // Refinement G (Phase 4-polish-1 final, 2026-04-26): col 6 (chevron)
    // dropped. Template went from 6 cols → 5 cols.
    //
    // Phase 4-polish-3 (2026-04-27): a new 5rem actions column was
    // re-added at the row end (col 6) to host the inline ✓/✗/+/⊘
    // buttons. The header strip mirrors the row template byte-for-
    // byte and now ships a sixth (empty) header cell.
    expect(header.className).toContain(
      'grid-cols-[0.75rem_minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(12rem,2fr)_5rem_5rem]',
    )
  })

  it('TargetTableGroup.tsx contains the locked 6-column header grid template literal', () => {
    // Source-level invariant: pin the literal in the source file so a
    // refactor that changes only the rendered className (e.g. via a
    // dynamic helper) still trips a guard. Mirrors the
    // `FieldMappingRow.tsx` column-template invariant test.
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const file = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup.tsx',
      ),
      'utf-8',
    )
    // INF-50 (2026-05-09): see paired invariant in
    // `field-mapping-row.test.tsx` — the header strip must mirror the
    // body row template byte-for-byte, including the fr-based growth
    // for tracks 2/3/4.
    const expected =
      'grid-cols-[0.75rem_minmax(8rem,1fr)_minmax(10rem,1.5fr)_minmax(12rem,2fr)_5rem_5rem]'
    expect(file).toContain(expected)
    // Belt and suspenders: the prior 6-col template (with trailing
    // `_1rem` chevron column) must NOT appear in the source file —
    // a partial-revert that swaps in a chevron col would otherwise
    // hide behind the broader `toContain` check above.
    expect(file).not.toContain(
      'grid-cols-[0.75rem_minmax(6rem,8rem)_minmax(8rem,14rem)_1fr_5rem_1rem]',
    )
    // Belt and suspenders #2: the polish-1 5-col template (no
    // trailing actions column) must NOT appear either.
    expect(file).not.toMatch(
      /grid-cols-\[0\.75rem_minmax\(6rem,8rem\)_minmax\(8rem,14rem\)_1fr_5rem\](?!_)/,
    )
    // Belt and suspenders #3 (INF-50): the polish-3 fixed-rem cap
    // template must NOT reappear — header strip mirrors the body
    // row, so the same regression guard applies here.
    expect(file).not.toContain(
      'grid-cols-[0.75rem_minmax(6rem,8rem)_minmax(8rem,14rem)_1fr_5rem_5rem]',
    )
    // Belt and suspenders #4 (INF-50): tracks 2/3/4 must use fr-
    // based growth — guards against a future "tighten to fixed
    // maxes" revert.
    expect(file).toMatch(
      /grid-cols-\[0\.75rem(?:_minmax\([^,]+,[^)]*fr\)){3}_5rem_5rem\]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4-polish-2 — group collapsibility (URL-driven).
// ─────────────────────────────────────────────────────────────────────────────
//
// The header gains a chevron + click affordance that toggles whether the
// group's rows are visible. The state is OWNED by the parent
// (`MappingContent` via `useCollapsedGroups`); this component only
// surfaces the interaction. Tests here pin the JSX-level contract:
// chevron rotation, click → onToggle wiring, accessibility attrs,
// keyboard activation, and the legacy non-collapsible fallback.

describe('TargetTableGroup — collapsibility (Phase 4-polish-2)', () => {
  const rows: MappingRow[] = [
    mapped({ id: 'r1', targetField: targetField({ id: 'f1', name: 'field_one' }) }),
    mapped({ id: 'r2', targetField: targetField({ id: 'f2', name: 'field_two' }) }),
  ]

  it('does NOT render the chevron toggle when onToggleCollapse is omitted (legacy fallback)', () => {
    // Storybook / fixture callers that don't wire the hook keep the
    // prior static-header behaviour. Pin this so a future refactor
    // can't make the chevron unconditionally appear.
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.queryByTestId('target-table-group-toggle')).toBeNull()
    expect(screen.queryByTestId('target-table-group-chevron')).toBeNull()
  })

  it('renders the chevron toggle button when onToggleCollapse is wired', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(screen.getByTestId('target-table-group-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('target-table-group-chevron')).toBeInTheDocument()
  })

  it('chevron is rotated (data-expanded="true") when expanded', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={false}
      />,
    )
    const chevron = screen.getByTestId('target-table-group-chevron')
    expect(chevron.getAttribute('data-expanded')).toBe('true')
    // SVG elements expose `className` as an `SVGAnimatedString`, so we
    // read the raw `class` attribute string instead of `.className`.
    expect(chevron.getAttribute('class')).toContain('rotate-90')
  })

  it('chevron is NOT rotated (data-expanded="false") when collapsed', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={true}
      />,
    )
    const chevron = screen.getByTestId('target-table-group-chevron')
    expect(chevron.getAttribute('data-expanded')).toBe('false')
    expect(chevron.getAttribute('class') ?? '').not.toContain('rotate-90')
  })

  it('aria-expanded matches the boolean expanded state when expanded', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={false}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('aria-expanded matches the boolean expanded state when collapsed', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={true}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('aria-controls references the rows container id', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    const container = screen.getByTestId('target-table-rows-container')
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(container.getAttribute('id')).toBe(controls)
  })

  it('aria-label includes the table name (screen-reader announcement)', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Toggle accounts group')
  })

  it('clicking the header fires onToggleCollapse with the table NAME', () => {
    const onToggle = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={onToggle}
      />,
    )
    fireEvent.click(screen.getByTestId('target-table-group-toggle'))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('accounts')
  })

  it('Enter key on the toggle fires onToggleCollapse', () => {
    const onToggle = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={onToggle}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledWith('accounts')
  })

  it('Space key on the toggle fires onToggleCollapse', () => {
    const onToggle = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={onToggle}
      />,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(onToggle).toHaveBeenCalledWith('accounts')
  })

  it('clicking the kebab menu does NOT fire onToggleCollapse', () => {
    // The kebab is rendered as a sibling button outside the toggle
    // button, so its click never bubbles to the toggle. This is the
    // structural guarantee — no `stopPropagation` needed.
    const onToggle = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={onToggle}
        needsReviewCount={2}
        onApproveAllClick={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('target-table-kebab-trigger'))
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('renders rows inside a wrapped container when expanded', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={false}
      />,
    )
    const container = screen.getByTestId('target-table-rows-container')
    expect(within(container).getAllByTestId('field-mapping-row')).toHaveLength(2)
    // Always-mounted rows: even when collapsed the DOM remains, just
    // clipped via max-height. Pin that the rows are NOT removed when
    // collapsed in the assertion below.
    expect(container.className).toContain('max-h-[10000px]')
  })

  it('keeps rows mounted but clipped (max-h-0) when collapsed', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={true}
      />,
    )
    const container = screen.getByTestId('target-table-rows-container')
    expect(within(container).getAllByTestId('field-mapping-row')).toHaveLength(2)
    expect(container.className).toContain('max-h-0')
    expect(container.className).not.toContain('max-h-[10000px]')
    // aria-hidden flips so screen readers skip the clipped rows.
    expect(container.getAttribute('aria-hidden')).toBe('true')
  })

  it('isAutoExpanded forces expansion regardless of isCollapsed', () => {
    // Filter-driven auto-expand: even when the user has collapsed
    // this group via `?collapsed=`, an active filter (search /
    // status / etc.) overrides and shows the rows. The persisted
    // collapsed state is unchanged — see MappingContent integration
    // tests for the URL preservation contract.
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={true}
        isAutoExpanded={true}
      />,
    )
    const container = screen.getByTestId('target-table-rows-container')
    expect(container.className).toContain('max-h-[10000px]')
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const chevron = screen.getByTestId('target-table-group-chevron')
    expect(chevron.getAttribute('data-expanded')).toBe('true')
  })

  it('section data-collapsed attribute reflects state (selector hook)', () => {
    const { rerender } = render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={false}
      />,
    )
    expect(
      screen.getByTestId('target-table-group').getAttribute('data-collapsed'),
    ).toBe('false')
    rerender(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
        isCollapsed={true}
      />,
    )
    expect(
      screen.getByTestId('target-table-group').getAttribute('data-collapsed'),
    ).toBe('true')
  })

  it('honors prefers-reduced-motion via motion-reduce: classes', () => {
    // Pin the motion-reduce token on the height transition so a future
    // refactor cannot drop it. We can't easily simulate the OS-level
    // setting here, but the className presence is a stable
    // testable proxy.
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        onToggleCollapse={vi.fn()}
      />,
    )
    const container = screen.getByTestId('target-table-rows-container')
    expect(container.className).toContain('motion-reduce:transition-none')
  })

  it('does NOT wrap the rows container with the transition when onToggleCollapse is omitted', () => {
    // Legacy callers (storybook / fixtures) get the prior static
    // layout — no max-h class, no transition class. The rows-
    // container testid is still surfaced for selectors but its
    // class is bare.
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    const container = screen.getByTestId('target-table-rows-container')
    expect(container.className).not.toContain('max-h-')
    expect(container.className).not.toContain('transition-[max-height]')
  })

  it('does not render the rows container in the row-empty branch', () => {
    // Empty-rows path renders the polite placeholder, which is OUTSIDE
    // the transition wrapper — pin that the wrapper testid doesn't
    // appear so empty groups don't carry a 0-height clipped container.
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[]}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('target-table-rows-container')).toBeNull()
  })

  it('does not render the rows container in the filtered-empty branch', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[]}
        filteredCount={{ total: 19, matching: 0 }}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('target-table-rows-container')).toBeNull()
    expect(screen.getByTestId('target-table-filtered-empty')).toBeInTheDocument()
  })
})
