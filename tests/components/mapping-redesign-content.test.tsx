import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MappingRedesignContent from '@/app/app/projects/[projectId]/mapping/redesign/MappingContent'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  MappingsForRedesignResult,
  SourceTableSummary,
  TargetFieldRef,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 3 amendment — group hiding with Target/Source filters active.
// ─────────────────────────────────────────────────────────────────────────────
//
// Founder UX decision (2026-04-21): when Target or Source filter is active,
// groups that don't match should disappear entirely — no empty-state header.
// Status and Search filters retain the empty-state group so the filter's
// reach is visible.
//
// This test file exercises that rendering decision end-to-end through
// MappingRedesignContent. The pure predicate (`shouldHideEmptyGroups`) is
// unit-tested in tests/utils/mapping-filters.test.ts; here we verify the
// integration.

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const replaceMock = vi.fn()
let currentSearch = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/app/projects/p1/mapping',
}))

// PageHeader pulls in client-side nav chrome; stub it out — we render
// the body content exclusively here.
vi.mock('@/components/app/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => (
    <div data-testid="page-header">{title}</div>
  ),
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

const accountsTable: TargetTableSummary = {
  id: 'tt-accounts',
  name: 'accounts',
  datasetName: 'heritage',
  fieldCount: 2,
}
const customersTable: TargetTableSummary = {
  id: 'tt-customers',
  name: 'customers',
  datasetName: 'heritage',
  fieldCount: 2,
}
const loansTable: TargetTableSummary = {
  id: 'tt-loans',
  name: 'loans',
  datasetName: 'heritage',
  fieldCount: 1,
}

const sourceTableX: SourceTableSummary = {
  id: 'st-x',
  name: 'ACCT_MASTER',
  datasetName: 'legacy',
  fieldCount: 12,
}
const sourceTableY: SourceTableSummary = {
  id: 'st-y',
  name: 'CIF_MASTER',
  datasetName: 'legacy',
  fieldCount: 8,
}

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf',
    name: 'field',
    dataType: 'VARCHAR',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: accountsTable.id, name: accountsTable.name },
    ordinalPosition: 1,
    ...overrides,
  }
}

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms',
    ordinal: 0,
    confidence: 90,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: { id: 'sf', name: 'COL', dataType: 'VARCHAR', isNullable: false },
    sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...overrides,
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'row',
    targetField: targetField(),
    confidence: 90,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    sources: [source()],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

function buildData(): MappingsForRedesignResult {
  const rows: MappingRow[] = [
    mapped({
      id: 'r-accounts-1',
      targetField: targetField({
        id: 'f-a1',
        name: 'account_id',
        targetTable: { id: accountsTable.id, name: accountsTable.name },
      }),
      status: 'approved',
      sources: [
        source({ sourceTable: { id: sourceTableX.id, name: sourceTableX.name } }),
      ],
    }),
    mapped({
      id: 'r-accounts-2',
      targetField: targetField({
        id: 'f-a2',
        name: 'balance',
        targetTable: { id: accountsTable.id, name: accountsTable.name },
      }),
      status: 'needs_review',
      sources: [
        source({ sourceTable: { id: sourceTableX.id, name: sourceTableX.name } }),
      ],
    }),
    mapped({
      id: 'r-customers-1',
      targetField: targetField({
        id: 'f-c1',
        name: 'customer_id',
        targetTable: { id: customersTable.id, name: customersTable.name },
      }),
      status: 'approved',
      sources: [
        source({ sourceTable: { id: sourceTableY.id, name: sourceTableY.name } }),
      ],
    }),
    mapped({
      id: 'r-customers-2',
      targetField: targetField({
        id: 'f-c2',
        name: 'email',
        targetTable: { id: customersTable.id, name: customersTable.name },
      }),
      status: 'approved',
      sources: [
        source({ sourceTable: { id: sourceTableY.id, name: sourceTableY.name } }),
      ],
    }),
    mapped({
      id: 'r-loans-1',
      targetField: targetField({
        id: 'f-l1',
        name: 'loan_amount',
        targetTable: { id: loansTable.id, name: loansTable.name },
      }),
      status: 'approved',
      sources: [
        source({ sourceTable: { id: sourceTableX.id, name: sourceTableX.name } }),
      ],
    }),
  ]

  return {
    projectId: 'p1',
    targetSchemaEmpty: false,
    rows,
    targetTables: [accountsTable, customersTable, loansTable],
    sourceTables: [sourceTableX, sourceTableY],
    sourceFieldAcknowledgments: [],
    counts: {
      total: rows.length,
      approved: 4,
      needsReview: 1,
      rejected: 0,
      unmapped: 0,
    },
  }
}

// ── Test setup ──────────────────────────────────────────────────────────────

function renderRedesign(searchString = '') {
  currentSearch = searchString
  return render(
    <MappingRedesignContent
      projectId="p1"
      projectName="Heritage Core"
      initialRedesignData={buildData()}
    />,
  )
}

beforeEach(() => {
  replaceMock.mockClear()
  currentSearch = ''
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MappingRedesignContent — default state', () => {
  it('renders all three target-table groups', () => {
    renderRedesign()
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(3)
    expect(groups.map((el) => el.getAttribute('data-target-table-id'))).toEqual([
      accountsTable.id,
      customersTable.id,
      loansTable.id,
    ])
  })

  it('no group shows the filtered-empty state when no filters are active', () => {
    renderRedesign()
    expect(screen.queryByTestId('target-table-filtered-empty')).toBeNull()
  })
})

describe('MappingRedesignContent — Target filter HIDES non-matching groups', () => {
  it('only the matching target-table group renders', () => {
    renderRedesign(`target=${accountsTable.id}`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
    // Non-matching groups must NOT be in the DOM at all.
    expect(screen.queryByText('customers')).toBeNull()
    expect(screen.queryByText('loans')).toBeNull()
  })

  it('no filtered-empty state is rendered (non-matching groups are hidden entirely)', () => {
    renderRedesign(`target=${accountsTable.id}`)
    expect(screen.queryByTestId('target-table-filtered-empty')).toBeNull()
  })

  it('falls back to "no tables match" state when target id matches nothing', () => {
    renderRedesign('target=tt-nonexistent')
    expect(screen.queryAllByTestId('target-table-group')).toHaveLength(0)
    expect(screen.getByTestId('mapping-redesign-no-groups-match')).toBeInTheDocument()
  })
})

describe('MappingRedesignContent — Source filter HIDES non-matching groups', () => {
  it('only groups with rows from the selected source render', () => {
    // sourceTableX is referenced by accounts (2 rows) and loans (1 row).
    // customers (sourceTableY) should disappear.
    renderRedesign(`source=${sourceTableX.id}`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups.map((el) => el.getAttribute('data-target-table-id'))).toEqual([
      accountsTable.id,
      loansTable.id,
    ])
    expect(screen.queryByText('customers')).toBeNull()
  })

  it('a source present in only one table hides the other two', () => {
    // sourceTableY → customers only.
    renderRedesign(`source=${sourceTableY.id}`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(customersTable.id)
  })
})

describe('MappingRedesignContent — Status filter KEEPS empty-state headers', () => {
  it('all groups still render when status narrows to zero matches', () => {
    // Heritage status semantic: no rejected rows in fixture, so status=rejected → 0 everywhere.
    renderRedesign('status=rejected')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(3)
    // Every group renders the filtered-empty state because none have rejected rows.
    const empties = screen.getAllByTestId('target-table-filtered-empty')
    expect(empties).toHaveLength(3)
  })

  it('partial status match: matching group shows rows, non-matching groups show empty state', () => {
    // status=needs_review → only the accounts table has a needs_review row;
    // customers and loans both have no needs_review rows.
    renderRedesign('status=needs_review')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(3) // all three still render
    const empties = screen.getAllByTestId('target-table-filtered-empty')
    expect(empties).toHaveLength(2) // customers + loans empty; accounts has a row
  })
})

describe('MappingRedesignContent — Search filter HIDES non-matching groups (Amendment 3)', () => {
  // Amendment 3 (2026-04-21): Search now hides empty groups alongside
  // Target/Source. Before Amendment 3 this describe block asserted the
  // opposite (all groups rendered with empty-state headers). Founder
  // rationale: Search is free-text / infinite-cardinality so 7 empty
  // headers per keystroke is noise on a fast interaction.

  it('only the matching target-table group renders when search narrows to one group', () => {
    renderRedesign('q=account_id')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
    // No empty-state headers — customers + loans are hidden entirely.
    expect(screen.queryAllByTestId('target-table-filtered-empty')).toHaveLength(0)
  })

  it('falls back to "no tables match" state when search matches nothing anywhere', () => {
    renderRedesign('q=xyz_never_matches')
    expect(screen.queryAllByTestId('target-table-group')).toHaveLength(0)
    expect(screen.getByTestId('mapping-redesign-no-groups-match')).toBeInTheDocument()
  })

  it('matches source field names (narrows to tables whose rows source that field)', () => {
    // Fixture: rows from accounts + loans source from ACCT_MASTER (sourceX);
    // rows from customers source from CIF_MASTER (sourceY). Searching "cif"
    // should hide accounts + loans.
    renderRedesign('q=cif')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(customersTable.id)
  })

  it('is case-insensitive (matches behavior of filterRows)', () => {
    renderRedesign('q=ACCOUNT_ID')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
  })

  it('whitespace-only search is treated as empty — all groups render', () => {
    renderRedesign('q=%20%20%20')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(3)
    // And no filtered-empty indicators, because no filter is effectively
    // active (the whitespace-only search is trimmed to "").
    expect(screen.queryAllByTestId('target-table-filtered-empty')).toHaveLength(0)
  })
})

describe('MappingRedesignContent — Target + Status combined (Target dominates visibility)', () => {
  it('non-matching target groups are hidden; matching target group shows status-filtered rows', () => {
    // Target=accounts AND status=approved → accounts group visible with 1 approved row;
    // customers + loans hidden (Target filter dominates the hiding decision).
    renderRedesign(`target=${accountsTable.id}&status=approved`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
    // The ONE visible group must show ITS status-filtered rows — one approved row.
    expect(screen.getByText('account_id')).toBeInTheDocument()
    expect(screen.queryByText('balance')).toBeNull() // needs_review, filtered out
  })

  it('matching target group stays VISIBLE with empty-state when Status narrows to zero within it', () => {
    // Target=loans (1 row, approved) + status=needs_review → loans visible
    // (identity match); inside, the group shows the filtered-empty state
    // because the status filter narrowed this group's rows to zero.
    //
    // REGRESSION GUARD: an earlier implementation hid the group when its
    // matching row count was zero even under an active Target filter.
    // Founder feedback (Gap 3 amendment, 2026-04-21): "matching target
    // group shows rows filtered by status (or empty-state if status
    // narrows to zero in the matching target group)" — the matching
    // group MUST remain visible so the user retains context.
    renderRedesign(`target=${loansTable.id}&status=needs_review`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(loansTable.id)
    expect(screen.getByTestId('target-table-filtered-empty')).toBeInTheDocument()
    // "no tables match" fallback should NOT be rendered — Target identity
    // matched, so we're inside a real group, not the degenerate fallback.
    expect(screen.queryByTestId('mapping-redesign-no-groups-match')).toBeNull()
  })
})

describe('MappingRedesignContent — Target + Search combined', () => {
  it('non-matching target groups are hidden; matching target group shows search-filtered rows', () => {
    renderRedesign(`target=${accountsTable.id}&q=account_id`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
    expect(screen.getByText('account_id')).toBeInTheDocument()
    expect(screen.queryByText('balance')).toBeNull()
  })

  it('REGRESSION: Target identity wins over Search hiding — matching group stays VISIBLE with filtered-empty state when Search narrows to zero within it', () => {
    // Amendment 3 regression guard, mirrors the Amendment 1 Status guard
    // above. Target=accounts + q=xyz_never_matches:
    //   • accounts group MUST remain visible (user explicitly scoped to
    //     it by identity — removing it would destroy the context they
    //     asked for).
    //   • Inside the accounts group, rows are zero → filtered-empty
    //     state renders in the header.
    //   • customers + loans are hidden by the Target identity check,
    //     not by Search — neither should render.
    //   • The degenerate "no tables match" fallback must NOT fire,
    //     because one group (accounts) is visible.
    renderRedesign(`target=${accountsTable.id}&q=xyz_never_matches`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.getAttribute('data-target-table-id')).toBe(accountsTable.id)
    expect(screen.getByTestId('target-table-filtered-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-redesign-no-groups-match')).toBeNull()
  })

  it('REGRESSION: Source identity wins over Search hiding — same pattern as Target', () => {
    // Source=sourceTableX (ACCT_MASTER) is referenced by accounts + loans
    // rows (not customers). q=xyz_never_matches narrows everything to zero.
    //   • accounts + loans stay VISIBLE (Source identity match), each
    //     showing filtered-empty state.
    //   • customers is hidden by Source identity (no row references X).
    renderRedesign(`source=${sourceTableX.id}&q=xyz_never_matches`)
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(2)
    const ids = groups.map((g) => g.getAttribute('data-target-table-id'))
    expect(ids).toContain(accountsTable.id)
    expect(ids).toContain(loansTable.id)
    expect(ids).not.toContain(customersTable.id)
    expect(screen.getAllByTestId('target-table-filtered-empty')).toHaveLength(2)
    expect(screen.queryByTestId('mapping-redesign-no-groups-match')).toBeNull()
  })
})

describe('MappingRedesignContent — URL → filter seed', () => {
  it('seeds filter state from search params on mount', () => {
    renderRedesign(`target=${accountsTable.id}&q=balance`)
    // Target dropdown should reflect the seeded value
    const target = screen.getByTestId('filter-target')
    expect(target.textContent).toMatch(/accounts/i)
    // Search input should reflect the seeded value
    const search = screen.getByTestId('filter-search-input') as HTMLInputElement
    expect(search.value).toBe('balance')
  })

  it('ignores legacy params (fields, type) — hard reset per founder decision 2', () => {
    renderRedesign('fields=abc&type=one_to_one')
    const groups = screen.getAllByTestId('target-table-group')
    expect(groups).toHaveLength(3)
    expect(screen.queryByTestId('filter-clear-all')).toBeNull()
  })
})

describe('MappingRedesignContent — Clear filters', () => {
  it('restores all three groups after a Target filter is cleared', () => {
    renderRedesign(`target=${accountsTable.id}`)
    expect(screen.getAllByTestId('target-table-group')).toHaveLength(1)

    fireEvent.click(screen.getByTestId('filter-clear-all'))

    expect(screen.getAllByTestId('target-table-group')).toHaveLength(3)
    // URL writer should have been called with a bare mapping path (no query).
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping',
      { scroll: false },
    )
  })
})
