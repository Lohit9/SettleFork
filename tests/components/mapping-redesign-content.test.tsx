import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MappingRedesignContent from '@/app/app/projects/[projectId]/mapping/redesign/MappingContent'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  MappingsForRedesignResult,
  SourceFieldWithState,
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
const refreshMock = vi.fn()
let currentSearch = ''

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: refreshMock,
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

// Phase 3 Gap 9 — `MappingDrawer` now imports `approveFieldMapping` /
// `rejectFieldMapping` from `@/lib/actions/mappings-for-redesign`,
// which transitively imports `lib/actions/mappings.ts` →
// `lib/ai/claude.ts`. The latter constructs an Anthropic client at
// module load time, which throws in jsdom under recent SDK versions.
// We don't exercise the action surface here (this suite is about
// filter/group rendering); stub them to no-ops to keep the import
// chain cheap and side-effect-free.
// Phase 4a-2 amendment: `CreateMappingForm` (reachable via the
// drawer's unmapped body) imports `createFieldMapping` from the
// same module — extend the mock so the import chain stays
// side-effect-free even when these tests render an unmapped row.
const { createFieldMappingMock } = vi.hoisted(() => ({
  createFieldMappingMock: vi.fn(),
}))
vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: vi.fn().mockResolvedValue({ success: true }),
  rejectFieldMapping: vi.fn().mockResolvedValue({ success: true }),
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
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
        source({
          sourceField: {
            id: 'sf-acct-col',
            name: 'COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
        }),
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
        source({
          sourceField: {
            id: 'sf-acct-col',
            name: 'COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
        }),
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
        source({
          sourceField: {
            id: 'sf-cif-col',
            name: 'COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: sourceTableY.id, name: sourceTableY.name },
        }),
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
        source({
          sourceField: {
            id: 'sf-cif-col',
            name: 'COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: sourceTableY.id, name: sourceTableY.name },
        }),
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
        source({
          sourceField: {
            id: 'sf-acct-col',
            name: 'COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
        }),
      ],
    }),
  ]

  // Phase 3 Gap 11b — three source fields, two of which are referenced
  // by the rows above. The third (`UNUSED_COL` in ACCT_MASTER) lets us
  // exercise Mapped vs Unmapped membership in the sidebar tests.
  const sourceFields: SourceFieldWithState[] = [
    {
      id: 'sf-acct-col',
      name: 'COL',
      dataType: 'VARCHAR',
      ordinalPosition: 0,
      sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
      mappingStatus: 'mapped',
      sampleValues: ['A', 'B'],
      isAcknowledged: false,
    },
    {
      id: 'sf-acct-unused',
      name: 'UNUSED_COL',
      dataType: 'VARCHAR',
      ordinalPosition: 1,
      sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
      mappingStatus: 'unmapped',
      sampleValues: [],
      isAcknowledged: false,
    },
    {
      id: 'sf-cif-col',
      name: 'COL',
      dataType: 'VARCHAR',
      ordinalPosition: 0,
      sourceTable: { id: sourceTableY.id, name: sourceTableY.name },
      mappingStatus: 'mapped',
      sampleValues: ['Cust1', 'Cust2'],
      isAcknowledged: false,
    },
  ]

  return {
    projectId: 'p1',
    targetSchemaEmpty: false,
    rows,
    targetTables: [accountsTable, customersTable, loansTable],
    sourceTables: [sourceTableX, sourceTableY],
    sourceFieldAcknowledgments: [],
    sourceFields,
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

function renderRedesign(
  searchString = '',
  dataOverrides?: Partial<MappingsForRedesignResult>,
) {
  currentSearch = searchString
  const baseData = buildData()
  const data: MappingsForRedesignResult = {
    ...baseData,
    ...dataOverrides,
    counts: { ...baseData.counts, ...(dataOverrides?.counts ?? {}) },
  }
  return render(
    <MappingRedesignContent
      projectId="p1"
      projectName="Heritage Core"
      initialRedesignData={data}
    />,
  )
}

beforeEach(() => {
  replaceMock.mockClear()
  refreshMock.mockClear()
  createFieldMappingMock.mockReset()
  createFieldMappingMock.mockResolvedValue({
    success: true,
    tfmId: 'tfm-new',
  })
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

// ─── Phase 3 Gap 7 — drawer state + URL sync ────────────────────────────────
//
// Verifies the drawer ↔ URL ↔ filter integration:
//   • `?drawer=<rowId>` on mount opens the drawer to that row.
//   • Clicking a row body writes `?drawer=<rowId>` to the URL.
//   • Clicking the drawer's X button strips `?drawer` from the URL.
//   • A filter that hides the open drawer row auto-closes the drawer
//     and cleans up the URL param.
//   • A stale `?drawer=<id>` for a non-existent row silently closes
//     on mount (prevents a sticky empty drawer when row IDs change
//     server-side).
//   • Drawer + filter params co-exist in a single writeUrl call.

describe('MappingRedesignContent — Gap 7 drawer URL sync', () => {
  it('opens the drawer on mount when ?drawer=<rowId> is in the URL', () => {
    renderRedesign('drawer=r-accounts-1')
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.textContent).toBe('account_id')
  })

  it('does NOT render the drawer when ?drawer is absent from the URL', () => {
    renderRedesign()
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
  })

  it('clicking a row body writes ?drawer=<rowId> to the URL and opens the drawer', () => {
    renderRedesign()
    // The drawer is closed at this point so `account_id` appears once
    // (in the row). Click that row body to open the drawer.
    const accountIdRow = screen
      .getByText('account_id')
      .closest('[data-testid="field-mapping-row"]')!
      .querySelector('[data-testid="field-mapping-row-body"]') as HTMLElement
    fireEvent.click(accountIdRow)
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping?drawer=r-accounts-1',
      { scroll: false },
    )
  })

  it('clicking the X button removes ?drawer from the URL and closes the drawer', () => {
    renderRedesign('drawer=r-accounts-1')
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mapping-drawer-close'))
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
    // URL should be stripped (bare mapping path).
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping',
      { scroll: false },
    )
  })

  it('Esc key closes the drawer and strips the URL param', () => {
    renderRedesign('drawer=r-accounts-1')
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping',
      { scroll: false },
    )
  })

  it('silently closes when ?drawer points at a non-existent row id (stale URL)', () => {
    renderRedesign('drawer=row-that-does-not-exist')
    // Drawer never renders.
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
    // URL is normalised to remove the stale param.
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping',
      { scroll: false },
    )
  })

  it('auto-closes when a filter hides the currently-open row', () => {
    // Open row in accounts group, then narrow Target filter to customers
    // (which has no row with id `r-accounts-1`).
    renderRedesign(`drawer=r-accounts-1`)
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    // Apply a Target filter via the URL-mounted state — easiest path is
    // to flip via the dropdown trigger, but we already have replaceMock
    // wiring; click clear-all first to reset, then dispatch a Target
    // change. Simpler: re-render with a filter that hides accounts.
    // We can mutate currentSearch and re-render to simulate.

    // Apply target=customers via the actual Target filter dropdown so
    // the local handler runs. Clear assertions after mount.
    replaceMock.mockClear()
    fireEvent.click(screen.getByTestId('filter-target'))
    // 'customers' appears in BOTH the dropdown options list AND in the
    // group header. Target the dropdown option specifically by role.
    fireEvent.click(screen.getByRole('option', { name: /customers/i }))
    // Drawer should disappear; replaceMock should have been called with
    // a URL that does NOT include drawer= and DOES include target=.
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
    const calls = replaceMock.mock.calls.map((c) => c[0] as string)
    const finalUrl = calls[calls.length - 1] ?? ''
    expect(finalUrl).toContain(`target=${customersTable.id}`)
    expect(finalUrl).not.toContain('drawer=')
  })

  it('drawer state is independent of filter state — both can be active simultaneously', () => {
    // Mount with a target filter active AND a drawer pointing at a row
    // that survives the filter. Both the filter chrome AND the drawer
    // should render.
    renderRedesign(`target=${accountsTable.id}&drawer=r-accounts-1`)
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    // Only one group (accounts) renders; the drawer is anchored to a
    // row inside it.
    expect(screen.getAllByTestId('target-table-group')).toHaveLength(1)
  })

  it('writeUrl composes filters + drawerRowId together in one URL', () => {
    // Mount with a filter, then click a row to open the drawer. The
    // combined URL must carry BOTH params.
    renderRedesign(`target=${accountsTable.id}`)
    replaceMock.mockClear()
    // Drawer is closed so 'account_id' appears once (the row). Click it.
    const rowBody = screen
      .getByText('account_id')
      .closest('[data-testid="field-mapping-row"]')!
      .querySelector('[data-testid="field-mapping-row-body"]') as HTMLElement
    fireEvent.click(rowBody)
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain(`target=${accountsTable.id}`)
    expect(lastUrl).toContain('drawer=r-accounts-1')
  })

  it('changing a filter while drawer is open preserves drawerRowId in the URL when the row survives', () => {
    renderRedesign(`drawer=r-accounts-1`)
    replaceMock.mockClear()
    // Apply target=accounts (the row's own group) — row survives.
    fireEvent.click(screen.getByTestId('filter-target'))
    fireEvent.click(screen.getByRole('option', { name: /accounts/i }))
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain('drawer=r-accounts-1')
    expect(lastUrl).toContain(`target=${accountsTable.id}`)
    // And the drawer is still rendered.
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('row body in the rendered tree carries role="button" and tabIndex=0 when drawer is wired up', () => {
    renderRedesign()
    const bodies = screen.getAllByTestId('field-mapping-row-body')
    expect(bodies.length).toBeGreaterThan(0)
    for (const b of bodies) {
      expect(b.getAttribute('role')).toBe('button')
      expect(b.getAttribute('tabindex')).toBe('0')
    }
  })

  it('opening the drawer adds bg-slate-50 to the active row body', () => {
    renderRedesign('drawer=r-accounts-1')
    // 'account_id' renders BOTH in the row AND inside the drawer header,
    // so we cannot use getByText. Locate the active row by its parent
    // FieldMappingRow data-testid + the unique row body within.
    const activeRowContainer = document.querySelector(
      '[data-testid="field-mapping-row"][data-row-kind="mapped"]',
    )
    const activeRow = activeRowContainer!.querySelector(
      '[data-testid="field-mapping-row-body"]',
    ) as HTMLElement
    expect(activeRow.className).toContain('bg-slate-50')
    // The 'balance' row is unique (drawer header doesn't show 'balance').
    const otherRow = screen
      .getByText('balance')
      .closest('[data-testid="field-mapping-row"]')!
      .querySelector('[data-testid="field-mapping-row-body"]') as HTMLElement
    expect(otherRow.className).not.toContain('bg-slate-50')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 11a — Source schema sidebar integration.
// ─────────────────────────────────────────────────────────────────────────────
//
// The sidebar is owned by `MappingRedesignContent`. Two integration
// behaviors are exercised here:
//   1. Coexistence with the drawer above 1024px viewport (no auto-collapse).
//   2. Auto-collapse when the drawer opens at <= 1024px viewport.
//   3. Restoration when the drawer closes (or when the viewport widens).
//   4. Reflow regression: scroll container does NOT carry `xl:pr-[…]`.
//   5. localStorage persistence honored across mounts.

interface MockMediaQueryList extends MediaQueryList {
  __setMatches: (m: boolean) => void
}

/**
 * Install a controllable `window.matchMedia` mock. Returns a setter
 * that flips the `matches` value AND fires the change listener so
 * subscribed components react. The default state is wide (true)
 * unless overridden via the second arg.
 */
function installMatchMediaMock(initialWide: boolean): MockMediaQueryList {
  let matches = initialWide
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql: MockMediaQueryList = {
    media: '(min-width: 1025px)',
    matches,
    onchange: null,
    addListener: (l: ((e: MediaQueryListEvent) => void) | null) => {
      if (l) listeners.add(l)
    },
    removeListener: (l: ((e: MediaQueryListEvent) => void) | null) => {
      if (l) listeners.delete(l)
    },
    addEventListener: (_t: string, l: EventListener | EventListenerObject | null) => {
      if (typeof l === 'function') {
        listeners.add(l as (e: MediaQueryListEvent) => void)
      }
    },
    removeEventListener: (_t: string, l: EventListener | EventListenerObject | null) => {
      if (typeof l === 'function') {
        listeners.delete(l as (e: MediaQueryListEvent) => void)
      }
    },
    dispatchEvent: () => true,
    __setMatches: (m: boolean) => {
      matches = m
      const event = { matches: m, media: mql.media } as MediaQueryListEvent
      for (const l of listeners) l(event)
    },
  } as MockMediaQueryList
  // `matches` is declared readonly on the interface. Use a getter so
  // reads always return the current closure value; tests mutate via
  // `__setMatches`.
  Object.defineProperty(mql, 'matches', {
    get: () => matches,
    configurable: true,
  })
  window.matchMedia = vi.fn().mockReturnValue(mql) as typeof window.matchMedia
  return mql
}

describe('MappingRedesignContent — Gap 11a sidebar integration', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    // matchMedia was overwritten per-test; reset to the previous value
    // (jsdom default is `undefined`). The next test that needs it
    // installs its own mock.
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  it('renders the source schema sidebar shell at the default collapsed state', () => {
    installMatchMediaMock(true)
    renderRedesign()
    const sidebar = screen.getByTestId('source-schema-sidebar')
    expect(sidebar).toBeInTheDocument()
    expect(sidebar.getAttribute('data-state')).toBe('collapsed')
    expect(sidebar.style.width).toBe('28px')
  })

  it('honors a persisted "expanded" state from localStorage on mount', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    installMatchMediaMock(true)
    renderRedesign()
    const sidebar = screen.getByTestId('source-schema-sidebar')
    expect(sidebar.getAttribute('data-state')).toBe('expanded')
    expect(sidebar.style.width).toBe('200px')
  })

  it('writes "expanded" to localStorage when the user clicks the rail', () => {
    installMatchMediaMock(true)
    renderRedesign()
    fireEvent.click(screen.getByTestId('source-schema-sidebar-rail'))
    expect(window.localStorage.getItem('mapping-sidebar-state')).toBe(
      'expanded',
    )
  })

  it('coexists with the drawer above 1024px viewport (no auto-collapse)', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    installMatchMediaMock(true) // wide
    renderRedesign('drawer=r-accounts-1')
    const sidebar = screen.getByTestId('source-schema-sidebar')
    // Drawer is open AND viewport is wide → sidebar respects persisted
    // 'expanded' state. No auto-collapse override.
    expect(sidebar.getAttribute('data-state')).toBe('expanded')
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('auto-collapses the sidebar when the drawer opens at <= 1024px viewport', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    installMatchMediaMock(false) // narrow
    renderRedesign('drawer=r-accounts-1')
    const sidebar = screen.getByTestId('source-schema-sidebar')
    // Persisted state stays 'expanded', but the effective state is
    // 'collapsed' for this drawer-open + narrow-viewport session.
    expect(sidebar.getAttribute('data-state')).toBe('collapsed')
    // Auto-collapse must NOT write to localStorage — it's ephemeral.
    expect(window.localStorage.getItem('mapping-sidebar-state')).toBe(
      'expanded',
    )
  })

  it('restores the sidebar when the drawer closes at narrow viewport', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    installMatchMediaMock(false)
    const { rerender } = render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildData()}
      />,
    )
    currentSearch = 'drawer=r-accounts-1'
    rerender(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildData()}
      />,
    )
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('collapsed')
    // Now drawer closes — sidebar should restore.
    currentSearch = ''
    rerender(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildData()}
      />,
    )
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('expanded')
  })

  it('restores the sidebar when the viewport widens above 1024px while drawer is open', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    const mql = installMatchMediaMock(false)
    renderRedesign('drawer=r-accounts-1')
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('collapsed')
    // Widen the viewport — listener fires, auto-collapse clears.
    act(() => {
      mql.__setMatches(true)
    })
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('expanded')
  })

  it('re-collapses if the viewport narrows again with the drawer still open', () => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    const mql = installMatchMediaMock(true)
    renderRedesign('drawer=r-accounts-1')
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('expanded')
    // Narrow the viewport while drawer is open — auto-collapse fires.
    act(() => {
      mql.__setMatches(false)
    })
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('collapsed')
  })

  it('drawer overlay refactor: the scroll container does NOT carry xl:pr-[520px] or xl:pr-[480px]', () => {
    installMatchMediaMock(true)
    const { container } = render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildData()}
      />,
    )
    // The post-Gap-11a layout has NO reflow class anywhere on any
    // scroll container — the drawer is now ALWAYS-overlay. Search the
    // entire rendered tree to be defensive against refactors.
    expect(container.innerHTML).not.toContain('xl:pr-[520px]')
    expect(container.innerHTML).not.toContain('xl:pr-[480px]')
  })

  it('persists the sidebar filter selection across re-mounts via localStorage', () => {
    installMatchMediaMock(true)
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    const { unmount } = renderRedesign()
    fireEvent.click(screen.getByTestId('source-schema-sidebar-filter-mapped'))
    expect(window.localStorage.getItem('mapping-sidebar-filter')).toBe(
      'mapped',
    )
    unmount()
    // Re-mount — the persisted filter survives.
    renderRedesign()
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-mapped')
        .getAttribute('aria-pressed'),
    ).toBe('true')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 11b — sidebar content + click-to-highlight integration.
// ─────────────────────────────────────────────────────────────────────────────
//
// Exercises the parent-owned highlight state machine end-to-end:
//   1. Sidebar field click highlights every consuming row.
//   2. Re-clicking the same field clears the highlight (toggle).
//   3. Clicking a different field replaces (single-select).
//   4. Esc clears the highlight.
//   5. Mousedown outside the sidebar AND outside a highlighted row clears.
//   6. Mousedown inside a highlighted row preserves the highlight (so the
//      drawer can open from there without losing context on its way in).
//   7. Drawer Approve/Reject completion clears the highlight (founder-locked
//      "additional concern" — protects against stale rowId references after
//      a Reject deletes a TFM).

describe('MappingRedesignContent — Gap 11b sidebar click-to-highlight', () => {
  beforeEach(() => {
    window.localStorage.setItem('mapping-sidebar-state', 'expanded')
    // Default sidebar filter is 'unmapped'; flip to 'all' so both the
    // mapped (sf-acct-col, sf-cif-col) and unmapped (sf-acct-unused)
    // fixture fields render in the sidebar.
    window.localStorage.setItem('mapping-sidebar-filter', 'all')
    installMatchMediaMock(true)
  })

  afterEach(() => {
    window.localStorage.clear()
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  function findFieldButton(sourceFieldId: string): HTMLElement {
    const fields = screen.getAllByTestId('source-schema-sidebar-field')
    const match = fields.find(
      (f) => f.getAttribute('data-source-field-id') === sourceFieldId,
    )
    if (!match) {
      throw new Error(
        `No sidebar field button found for sourceFieldId=${sourceFieldId}`,
      )
    }
    return match
  }

  function getRowBody(rowId: string): HTMLElement {
    const row = document.querySelector(
      `[data-testid="field-mapping-row"][data-row-id="${rowId}"]`,
    )
    if (!row) throw new Error(`Row not found: ${rowId}`)
    const body = row.querySelector(
      '[data-testid="field-mapping-row-body"]',
    ) as HTMLElement | null
    if (!body) throw new Error(`Row body not found: ${rowId}`)
    return body
  }

  function isRowHighlighted(rowId: string): boolean {
    return getRowBody(rowId).getAttribute('data-highlighted-row') === 'true'
  }

  it('clicking a sidebar field highlights every main-view row that consumes it', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    // sf-acct-col is consumed by accounts-1, accounts-2, and loans-1.
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    expect(isRowHighlighted('r-accounts-2')).toBe(true)
    expect(isRowHighlighted('r-loans-1')).toBe(true)
    // customers rows source from sf-cif-col — should remain unhighlighted.
    expect(isRowHighlighted('r-customers-1')).toBe(false)
    expect(isRowHighlighted('r-customers-2')).toBe(false)
  })

  it('clicking the same field a second time clears the highlight (toggle)', () => {
    renderRedesign()
    const btn = findFieldButton('sf-acct-col')
    fireEvent.click(btn)
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    fireEvent.click(btn)
    expect(isRowHighlighted('r-accounts-1')).toBe(false)
  })

  it('clicking a different sidebar field replaces the highlight (single-select)', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    fireEvent.click(findFieldButton('sf-cif-col'))
    // accounts/loans rows clear, customers rows light up.
    expect(isRowHighlighted('r-accounts-1')).toBe(false)
    expect(isRowHighlighted('r-loans-1')).toBe(false)
    expect(isRowHighlighted('r-customers-1')).toBe(true)
    expect(isRowHighlighted('r-customers-2')).toBe(true)
  })

  it('Esc clears the highlight', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(isRowHighlighted('r-accounts-1')).toBe(false)
  })

  it('mousedown outside the sidebar AND outside a highlighted row clears the highlight', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    // r-customers-1 is NOT highlighted by sf-acct-col, so mousedown there
    // should fall through to the click-outside listener and clear.
    fireEvent.mouseDown(getRowBody('r-customers-1'))
    expect(isRowHighlighted('r-accounts-1')).toBe(false)
  })

  it('mousedown inside a highlighted row PRESERVES the highlight', () => {
    // The user should be able to click a highlighted row to open its drawer
    // without the act of clicking blowing away the highlight on its way in.
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    fireEvent.mouseDown(getRowBody('r-accounts-1'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
  })

  it('mousedown inside the sidebar PRESERVES the highlight', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    // Mousedown on the sidebar's filter row, list area, or header should
    // not clear — the user might be aiming for another field row.
    const sidebar = screen.getByTestId('source-schema-sidebar')
    fireEvent.mouseDown(sidebar)
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
  })

  it('opening the drawer leaves the highlight intact (drawer + highlight coexist)', () => {
    renderRedesign()
    fireEvent.click(findFieldButton('sf-acct-col'))
    fireEvent.click(getRowBody('r-accounts-1'))
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
  })

  it('drawer Approve completion clears the highlight (mild over-clear is intentional)', async () => {
    // Founder-locked "additional concern" decision: the existing Gap 9
    // post-action callback also clears the sidebar highlight so a stale
    // rowId reference cannot survive a Reject. Approve clears too —
    // mild over-clearing accepted in exchange for the simpler one-line
    // fix in `handleDrawerActionComplete`.
    //
    // Use r-accounts-2 (status='needs_review') so the Approve button
    // is enabled. r-accounts-1 is already 'approved' → button disabled.
    renderRedesign('drawer=r-accounts-2')
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-2')).toBe(true)
    const approveBtn = screen.getByTestId('mapping-drawer-approve-button')
    fireEvent.click(approveBtn)
    // Approve runs inside a React transition; the post-action
    // callback (which clears the highlight) fires after the mocked
    // server resolves. Wait until the DOM reflects that.
    await waitFor(() => {
      expect(isRowHighlighted('r-accounts-2')).toBe(false)
    })
  })

  it('drawer Reject completion clears the highlight (necessary — TFM is gone)', async () => {
    renderRedesign('drawer=r-accounts-1')
    fireEvent.click(findFieldButton('sf-acct-col'))
    expect(isRowHighlighted('r-accounts-1')).toBe(true)
    fireEvent.click(screen.getByTestId('mapping-drawer-reject-button'))
    const confirmBtn = await screen.findByTestId('mapping-drawer-reject-confirm')
    fireEvent.click(confirmBtn)
    // Drawer closes on Reject and the parent's `handleDrawerActionComplete`
    // clears the highlight in the same callback. The row stays in the
    // DOM (only the TFM identity dissolves on the server; the in-memory
    // fixture is unchanged), so we can assert the data attribute
    // directly once the post-action callback has flushed.
    await waitFor(() => {
      expect(isRowHighlighted('r-accounts-1')).toBe(false)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 13 — Unmapped counter chip.
// ─────────────────────────────────────────────────────────────────────────────
//
// The counter pills row (`mapping-redesign-counters`) renders a chip per
// non-zero status counter, mirroring the existing Rejected gating pattern.
// `Unmapped` is the project-level aggregate count of target fields with no
// TFM at all — previously invisible despite being on the contract.

describe('MappingRedesignContent — Gap 13 Unmapped counter chip', () => {
  it('renders the Unmapped chip when counts.unmapped > 0', () => {
    renderRedesign('', { counts: { total: 6, approved: 4, needsReview: 1, rejected: 0, unmapped: 3 } })
    const counters = screen.getByTestId('mapping-redesign-counters')
    expect(counters.textContent).toContain('Unmapped')
    expect(counters.textContent).toContain('3')
  })

  it('hides the Unmapped chip when counts.unmapped === 0', () => {
    renderRedesign('', { counts: { total: 6, approved: 5, needsReview: 1, rejected: 0, unmapped: 0 } })
    const counters = screen.getByTestId('mapping-redesign-counters')
    expect(counters.textContent).not.toContain('Unmapped')
  })

  it('renders Unmapped alongside Rejected when both are non-zero', () => {
    renderRedesign('', { counts: { total: 8, approved: 4, needsReview: 1, rejected: 1, unmapped: 2 } })
    const counters = screen.getByTestId('mapping-redesign-counters')
    expect(counters.textContent).toContain('Rejected')
    expect(counters.textContent).toContain('Unmapped')
  })

  it('Total/Approved/Needs Review chips always render regardless of Unmapped value', () => {
    renderRedesign('', { counts: { total: 5, approved: 5, needsReview: 0, rejected: 0, unmapped: 0 } })
    const counters = screen.getByTestId('mapping-redesign-counters')
    expect(counters.textContent).toContain('Total')
    expect(counters.textContent).toContain('Approved')
    expect(counters.textContent).toContain('Needs Review')
    expect(counters.textContent).not.toContain('Unmapped')
    expect(counters.textContent).not.toContain('Rejected')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — manual mapping creation save flow + pendingDrawerRowId sentinel.
// ─────────────────────────────────────────────────────────────────────────────
//
// Verifies the page-level wiring introduced in Block E:
//   • `?drawer=unmapped::<targetFieldId>` opens an unmapped drawer
//     and the new [Create mapping] footer button is visible.
//   • Successful save fires `createFieldMapping`, swaps the URL from
//     `?drawer=unmapped::tf-X` → `?drawer=tfm-new`, and calls
//     `router.refresh()`. The drawer body remains mounted in the
//     intermediate window.
//   • The `pendingDrawerRowId` sentinel keeps the drawer mounted
//     even when the new TFM uuid is not yet present in `data.rows`
//     (the auto-close-on-stale-id effect must NOT fire).
//   • Once the parent re-renders with new data containing the TFM,
//     the sentinel releases and the drawer body now shows the
//     Rule 1 mapped view.

function buildDataWithUnmapped(): MappingsForRedesignResult {
  const base = buildData()
  const unmappedRow: MappingRow = {
    kind: 'unmapped',
    id: 'unmapped::tf-unmapped',
    targetField: targetField({
      id: 'tf-unmapped',
      name: 'phone_number',
      targetTable: { id: accountsTable.id, name: accountsTable.name },
      ordinalPosition: 99,
    }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
  }
  return {
    ...base,
    rows: [...base.rows, unmappedRow],
    counts: { ...base.counts, unmapped: 1 },
  }
}

describe('MappingRedesignContent Phase 4a-2 — unmapped drawer surfaces [Create mapping]', () => {
  it('renders the [Create mapping] button when an unmapped row is open via URL', () => {
    currentSearch = 'drawer=unmapped::tf-unmapped'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithUnmapped()}
      />,
    )
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
  })
})

describe('MappingRedesignContent Phase 4a-2 — save flow swaps URL + refreshes', () => {
  it('successful createFieldMapping replaces URL with the new TFM id and calls router.refresh', async () => {
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-brand-new',
    })
    currentSearch = 'drawer=unmapped::tf-unmapped'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    const fieldButtons = screen.getAllByTestId('source-field-picker-field')
    fireEvent.click(fieldButtons[0])
    fireEvent.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(createFieldMappingMock).toHaveBeenCalledTimes(1)
    // URL was updated with the new TFM uuid (the bare uuid, not the
    // `unmapped::` sentinel).
    const calls = replaceMock.mock.calls.map((c) => c[0] as string)
    expect(calls.some((u) => u.includes('drawer=tfm-brand-new'))).toBe(true)
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the drawer mounted while the new TFM id is not yet in data.rows (sentinel guard)', async () => {
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-pending',
    })
    currentSearch = 'drawer=unmapped::tf-unmapped'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    fireEvent.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Founder decision §9-OQ-1: the drawer must NOT flicker closed in
    // the URL→refresh window. The TFM uuid is now in the URL but the
    // server data has not been re-fetched (refreshMock was a no-op),
    // so `drawerRow` is null. Without the sentinel, the auto-close
    // effect would unmount the drawer here. With the sentinel, the
    // drawer stays open.
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('releases the sentinel and shows the new mapped row once data refresh lands', async () => {
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-after-refresh',
    })
    currentSearch = 'drawer=unmapped::tf-unmapped'
    const initialData = buildDataWithUnmapped()
    const { rerender } = render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={initialData}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    fireEvent.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Simulate `router.refresh()` rehydration: the parent receives
    // new data where the unmapped row has been replaced by a mapped
    // row with the new TFM uuid.
    const refreshedRows: MappingRow[] = initialData.rows
      .filter((r) => r.id !== 'unmapped::tf-unmapped')
      .concat([
        mapped({
          id: 'tfm-after-refresh',
          targetField: targetField({
            id: 'tf-unmapped',
            name: 'phone_number',
            targetTable: { id: accountsTable.id, name: accountsTable.name },
            ordinalPosition: 99,
          }),
          status: 'needs_review',
        }),
      ])
    rerender(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={{
          ...initialData,
          rows: refreshedRows,
          counts: { ...initialData.counts, unmapped: 0, needsReview: initialData.counts.needsReview + 1 },
        }}
      />,
    )
    // Drawer is still open (didn't flicker shut), and now displays
    // the mapped row's body — Rule 1 (single source) subheader.
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-subheader-rule_1'),
    ).toBeInTheDocument()
    // Footer is back to Approve / Reject (no Create mapping).
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4a — row-switch-while-dirty toast wiring (Block B).
// ─────────────────────────────────────────────────────────────────────────────
//
// Verifies the page-level glue:
//   • Switching rows while the unmapped drawer's form is dirty fires
//     an info toast with "Mapping draft discarded." + Undo affordance.
//   • Clicking Undo within the toast lifetime navigates back to the
//     original row, re-mounts the form, and re-hydrates the user's
//     prior selections (selectedIds + combinationType).
//   • Multiple rapid row-switches collapse to a single toast (rolling
//     latest via replace-by-id 'row-switch-discard').
//   • Clicking the same row a second time (no actual switch) does NOT
//     fire a toast.
//   • The toast auto-dismisses after `TOAST_AUTO_DISMISS_MS` (5000ms).
//   • Click-outside-drawer with a dirty form does NOT fire a toast —
//     that path is owned by `DiscardChangesDialog` (founder §11-OQ-3).

function buildDataWithTwoUnmapped(): MappingsForRedesignResult {
  const base = buildData()
  const unmapped1: MappingRow = {
    kind: 'unmapped',
    id: 'unmapped::tf-u1',
    targetField: targetField({
      id: 'tf-u1',
      name: 'phone_number',
      targetTable: { id: accountsTable.id, name: accountsTable.name },
      ordinalPosition: 98,
    }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
  }
  const unmapped2: MappingRow = {
    kind: 'unmapped',
    id: 'unmapped::tf-u2',
    targetField: targetField({
      id: 'tf-u2',
      name: 'fax_number',
      targetTable: { id: accountsTable.id, name: accountsTable.name },
      ordinalPosition: 99,
    }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
  }
  return {
    ...base,
    rows: [...base.rows, unmapped1, unmapped2],
    counts: { ...base.counts, unmapped: 2 },
  }
}

describe('MappingRedesignContent Phase 4a-4a — row-switch-while-dirty toast', () => {
  it('shows an info toast with Undo when switching rows while form is dirty', async () => {
    currentSearch = 'drawer=unmapped::tf-u1'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithTwoUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    // Click the second unmapped row to switch. Click handler lives on
    // `field-mapping-row-body` (the inner clickable surface), not on
    // the outer `field-mapping-row` container.
    const findUnmappedRowBodyById = (id: string) => {
      const row = screen
        .getAllByTestId('field-mapping-row')
        .find((el) => el.getAttribute('data-row-id') === id)!
      return row.querySelector(
        '[data-testid="field-mapping-row-body"]',
      ) as HTMLElement
    }
    fireEvent.click(findUnmappedRowBodyById('unmapped::tf-u2'))
    const toast = await screen.findByTestId('toast')
    expect(toast).toBeInTheDocument()
    expect(toast.getAttribute('data-toast-variant')).toBe('info')
    expect(toast.textContent).toContain('Mapping draft discarded')
    expect(screen.getByTestId('toast-action')).toHaveTextContent('Undo')
  })

  it('Undo restores the form on the original row with the prior selections', async () => {
    currentSearch = 'drawer=unmapped::tf-u1'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithTwoUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    const firstField = screen.getAllByTestId('source-field-picker-field')[0]
    const firstFieldId = firstField.getAttribute('data-source-field-id')!
    fireEvent.click(firstField)
    const findUnmappedRowBodyById = (id: string) => {
      const row = screen
        .getAllByTestId('field-mapping-row')
        .find((el) => el.getAttribute('data-row-id') === id)!
      return row.querySelector(
        '[data-testid="field-mapping-row-body"]',
      ) as HTMLElement
    }
    fireEvent.click(findUnmappedRowBodyById('unmapped::tf-u2'))
    const undoBtn = await screen.findByTestId('toast-action')
    fireEvent.click(undoBtn)
    // Form is mounted again on the original row with the prior chip
    // selection retained.
    await waitFor(() => {
      expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    })
    const chips = screen.getAllByTestId('source-field-picker-chip')
    expect(
      chips.some(
        (c) => c.getAttribute('data-source-field-id') === firstFieldId,
      ),
    ).toBe(true)
  })

  it('rapid successive row switches collapse to a single toast (rolling latest)', async () => {
    currentSearch = 'drawer=unmapped::tf-u1'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithTwoUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    const findUnmappedRowBodyById = (id: string) => {
      const row = screen
        .getAllByTestId('field-mapping-row')
        .find((el) => el.getAttribute('data-row-id') === id)!
      return row.querySelector(
        '[data-testid="field-mapping-row-body"]',
      ) as HTMLElement
    }
    fireEvent.click(findUnmappedRowBodyById('unmapped::tf-u2'))
    // After the first switch, dirty the form again on tf-u2 then
    // switch back. Each switch should replace the same toast id.
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    fireEvent.click(findUnmappedRowBodyById('unmapped::tf-u1'))
    await waitFor(() => {
      expect(screen.getAllByTestId('toast')).toHaveLength(1)
    })
  })

  it('does not show the toast on no-op self-click of the open row', () => {
    currentSearch = 'drawer=unmapped::tf-u1'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithTwoUnmapped()}
      />,
    )
    fireEvent.click(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    )
    fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
    const sameRow = screen
      .getAllByTestId('field-mapping-row')
      .find((el) => el.getAttribute('data-row-id') === 'unmapped::tf-u1')!
      .querySelector(
        '[data-testid="field-mapping-row-body"]',
      ) as HTMLElement
    fireEvent.click(sameRow)
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('toast auto-dismisses after TOAST_AUTO_DISMISS_MS', async () => {
    vi.useFakeTimers()
    try {
      currentSearch = 'drawer=unmapped::tf-u1'
      render(
        <MappingRedesignContent
          projectId="p1"
          projectName="Heritage Core"
          initialRedesignData={buildDataWithTwoUnmapped()}
        />,
      )
      fireEvent.click(
        screen.getByTestId('mapping-drawer-create-mapping-button'),
      )
      fireEvent.click(screen.getAllByTestId('source-field-picker-field')[0])
      fireEvent.click(
        screen
          .getAllByTestId('field-mapping-row')
          .find(
            (el) => el.getAttribute('data-row-id') === 'unmapped::tf-u2',
          )!
          .querySelector(
            '[data-testid="field-mapping-row-body"]',
          ) as HTMLElement,
      )
      expect(screen.getByTestId('toast')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(5100)
      })
      expect(screen.queryByTestId('toast')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
