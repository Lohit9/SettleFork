import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
const { createFieldMappingMock, suggestMappingForTargetMock } = vi.hoisted(
  () => ({
    createFieldMappingMock: vi.fn(),
    suggestMappingForTargetMock: vi.fn(),
  }),
)
vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: vi.fn().mockResolvedValue({ success: true }),
  rejectFieldMapping: vi.fn().mockResolvedValue({ success: true }),
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
  suggestMappingForTarget: (...args: unknown[]) =>
    suggestMappingForTargetMock(...args),
  // Phase 4-polish-3 — `MappingContent` imports a wider surface of
  // server actions to back the inline action handlers (✓ approve,
  // ✗ reject, + map, ⊘ acknowledge) and the multi-select source
  // picker commit. Stub them all to no-ops so the import chain stays
  // side-effect-free; the integration tests in this suite don't
  // exercise the wrapper round-trip.
  editMappingSources: vi.fn().mockResolvedValue({ success: true }),
  bulkApproveFieldMappingsForTargetTable: vi
    .fn()
    .mockResolvedValue({ success: true, approvedCount: 0 }),
  approveHighConfidenceMappings: vi
    .fn()
    .mockResolvedValue({ success: true, approvedCount: 0 }),
  previewBulkApprove: vi
    .fn()
    .mockResolvedValue({ success: true, rows: [], totalCount: 0 }),
  bulkRejectFieldMappingsForTargetTable: vi
    .fn()
    .mockResolvedValue({ success: true, rejectedCount: 0 }),
  previewBulkReject: vi
    .fn()
    .mockResolvedValue({ success: true, rows: [], totalCount: 0 }),
  // Phase 4 empty-state — `GenerateMappingsPanel` (mounted only when
  // the project is in the case-4 empty state) imports `generateMappings`
  // from this same surface via the re-export added to the action layer.
  // Stub to a no-op success; the empty-state suite below exercises
  // the routing/panel render only — submit-flow assertions live in
  // `tests/components/generate-mappings-panel.test.tsx`.
  generateMappings: vi
    .fn()
    .mockResolvedValue({ success: true, generated: 0, skipped: 0 }),
}))

// Phase 4-polish-3 — `MappingContent` calls `acknowledgeField`
// directly from `@/lib/actions/field-acknowledgments` for the inline
// ⊘ button on unmapped rows. That module imports `server-only` (and
// the supabase admin client) at module load, both of which throw in
// jsdom. Stub the surface to a no-op success.
vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: vi.fn().mockResolvedValue({ success: true }),
}))

// Phase E PR α — `MappingContent` fires `getPathDOutputsForProject` on
// mount to populate the drawer's enrichment sidecar. The action calls
// `cookies()` from next/headers which throws "called outside a request
// scope" in jsdom. Stub to a resolved-empty-output stub so the effect
// completes cleanly; tests in this file don't assert against drawer
// enrichment (covered separately in mapping-drawer-path-d.test.tsx).
vi.mock('@/lib/actions/path-d-outputs', () => ({
  getPathDOutputsForProject: vi.fn().mockResolvedValue({
    coverageByTargetFieldId: new Map(),
    decisionsByTfmId: new Map(),
    decisionsByCoverageId: new Map(),
    dqIssuesBySourceFieldId: new Map(),
  }),
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
    transformationDescription: null,
    transformationSqlPreview: null,
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
  // PR-6: thread a populated projectStats so the consolidated
  // `MappingSummaryStrip` renders its chip row (rather than the
  // state-aware empty label). State-aware empty has its own dedicated
  // tests in mapping-summary-strip.test.tsx; tests in this file
  // exercise the populated-state code paths and don't need to vary
  // the project-level state machine.
  const populatedProjectStats: import('@/lib/quality/project-stats').ProjectStats = {
    state: 'mappings_generated',
    // PR-7: needsReview = total − approved (formula invariant).
    // approved (6) + needsReview (4) = 10 = total. unmapped (1) is a
    // sub-component of needsReview.
    target: { approved: 6, total: 10, unmapped: 1, needsReview: 4 },
    source: { decided: 5, total: 8 },
    transforms: { complete: 1, total: 4 },
    blocking: 0,
  }
  return render(
    <MappingRedesignContent
      projectId="p1"
      projectName="Heritage Core"
      initialRedesignData={data}
      projectStats={populatedProjectStats}
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
  suggestMappingForTargetMock.mockReset()
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
// PR-7: conditional Rejected / Unmapped chips RETIRED from the strip.
// ─────────────────────────────────────────────────────────────────────────────
//
// The original Gap 13 Unmapped + §9 Q6 Rejected chip-gating tests pinned
// chip rendering against `data.counts.{rejected,unmapped} > 0`. PR-7
// (feat/mapping-approvals) retired both chips entirely — the redefined
// `target.needsReview = total − approved` engulfs both rejected primary
// TFMs and unacknowledged unmapped target fields, so a single Needs Review
// chip carries the signal that two chips used to. The strip now reads
// from `projectStats.target.{approved,needsReview}` exclusively (the
// `counts` prop was dropped).
//
// Per-component coverage of the post-PR-7 chip behaviour lives in
// `tests/components/mapping-summary-strip.test.tsx`. This block now
// asserts the negative invariant: neither chip ever renders, regardless
// of what the underlying mapping data looks like.

describe('MappingRedesignContent — PR-7 retired chips (Rejected / Unmapped)', () => {
  it('does NOT render the Rejected chip even when grid-level rejected count > 0', () => {
    renderRedesign('', { counts: { total: 8, approved: 4, needsReview: 1, rejected: 1, unmapped: 2 } })
    expect(screen.queryByTestId('mapping-summary-chip-rejected')).toBeNull()
  })

  it('does NOT render the Unmapped chip even when grid-level unmapped count > 0', () => {
    renderRedesign('', { counts: { total: 6, approved: 4, needsReview: 1, rejected: 0, unmapped: 3 } })
    expect(screen.queryByTestId('mapping-summary-chip-unmapped')).toBeNull()
  })

  it('Approved + Needs Review chips remain always-on regardless of grid-level status counts', () => {
    renderRedesign('', { counts: { total: 5, approved: 5, needsReview: 0, rejected: 0, unmapped: 0 } })
    const strip = screen.getByTestId('mapping-summary-strip')
    expect(strip.textContent).toContain('Approved')
    expect(strip.textContent).toContain('Needs Review')
    // Negative regression guards: chip retirements stay retired.
    expect(strip.textContent).not.toContain('Rejected')
    expect(strip.textContent).not.toContain('Unmapped')
  })

  it('legacy `mapping-redesign-counters` testid is removed (regression guard)', () => {
    renderRedesign('', { counts: { total: 5, approved: 5, needsReview: 0, rejected: 0, unmapped: 0 } })
    expect(screen.queryByTestId('mapping-redesign-counters')).toBeNull()
  })

  it('experimental WipBanner placeholder is removed (founder Q2.1 lock)', () => {
    // Phase 4-polish-1 (Q2.1) drops the experimental amber banner
    // entirely. Same regression-guard pattern as the counters testid
    // above — pin the retirement so it cannot silently come back.
    renderRedesign('', { counts: { total: 5, approved: 5, needsReview: 0, rejected: 0, unmapped: 0 } })
    expect(screen.queryByTestId('mapping-redesign-placeholder')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4-polish-1 sidebar architecture refactor — zero-gap regression guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Original Refinement 2 (Phase 4-polish-1) closed a 24px gap between
// the bottom of `MappingSummaryStrip` and the top of `FilterRow`.
// Root cause at the time was the centered `max-w-5xl py-6` column
// that wrapped `FilterRow` (the strip mounted outside it). The fix
// was `py-6` → `pb-6` on that column.
//
// Phase 4-polish-1 sidebar architecture refactor (2026-04-26)
// promoted both the strip and `FilterRow` to PAGE LEVEL — they are
// now direct siblings of `<PageHeader>` under the outer flex column,
// sitting ABOVE the sidebar+body flex row. The centered `max-w-5xl`
// column no longer wraps either of them; it now only wraps the body
// content (group cards / empty states).
//
// With the structural lift, the zero-gap contract becomes a direct
// sibling assertion: `MappingSummaryStrip.nextElementSibling` is the
// `FilterRow`. No DOM walk is needed; if a future refactor inserts
// any element between them, this guard fires.

describe('MappingRedesignContent — zero-gap between strip and FilterRow (post sidebar architecture refactor)', () => {
  it('strip and FilterRow are direct siblings under the page-level flex column', () => {
    renderRedesign()
    const strip = screen.getByTestId('mapping-summary-strip')
    const filterRow = screen.getByTestId('mapping-redesign-filter-row')
    expect(strip).toBeInTheDocument()
    expect(filterRow).toBeInTheDocument()

    // The structural invariant: FilterRow is the strip's immediate
    // next element sibling. No wrapper, no margin-introducing div,
    // nothing between them. If anything reappears here, this guard
    // fires before the visual gap is shipped.
    expect(strip.nextElementSibling).toBe(filterRow)

    // Both elements share the same parent (the outer flex column
    // rendered by `MappingRedesignContent`). Pin the relationship
    // explicitly so a future refactor that nests one of them inside
    // a new wrapper surfaces here.
    expect(strip.parentElement).toBe(filterRow.parentElement)
  })

  it('strip carries no bottom margin and FilterRow carries no top margin/padding', () => {
    renderRedesign()
    const strip = screen.getByTestId('mapping-summary-strip')
    const filterRow = screen.getByTestId('mapping-redesign-filter-row')

    // Strip's bottom edge: no `mb-N`. We allow `py-N` (which expands
    // to `pt-N pb-N`) because that's the strip's own intrinsic
    // breathing room, not external spacing.
    expect(strip.className).not.toMatch(/\bmb-\d/)

    // FilterRow's top edge: no `mt-N`. The post-refactor className
    // also drops `pt-N` from the original `py-2.5` is fine — we
    // explicitly allow `py-N` for the toolbar's own padding.
    expect(filterRow.className).not.toMatch(/\bmt-\d/)
  })

  it('FilterRow is no longer sticky (lift-out removes sticky positioning)', () => {
    renderRedesign()
    const filterRow = screen.getByTestId('mapping-redesign-filter-row')

    // Pre-refactor the FilterRow carried `sticky top-0 z-10 -mx-6
    // mb-4` to behave correctly inside the body's scroll container.
    // After the lift-out, all four are gone: structural DOM order
    // alone keeps the toolbar visible at the top of the page (it is
    // not inside any scroll container), and there is no centered
    // column to compensate for.
    expect(filterRow.className).not.toMatch(/\bsticky\b/)
    expect(filterRow.className).not.toMatch(/\btop-0\b/)
    expect(filterRow.className).not.toMatch(/\bz-10\b/)
    expect(filterRow.className).not.toMatch(/-mx-\d/)
    expect(filterRow.className).not.toMatch(/\bmb-\d/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4-polish-1 sidebar architecture refactor — structural invariant guard.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the post-refactor DOM tree shape: `<PageHeader>`, the summary
// strip, the FilterRow, and the sidebar+body flex row are all DIRECT
// CHILDREN of the same `<div className="flex h-full flex-col bg-gray-50">`
// page-level flex column. If a future refactor reintroduces a wrapper
// around any of these (e.g. nesting strip+filter back inside the body
// scroller, or wrapping them in a new "toolbar" div), this guard
// fires.
//
// The position-fixed `<MappingDrawer>` and `<BulkConfirmDialog>`
// trailing children are intentionally not asserted — they render
// `null` when closed and don't influence layout when open. The guard
// asserts only the toolbar+body siblings.

describe('MappingRedesignContent — structural invariant (post sidebar architecture refactor)', () => {
  it('PageHeader, Strip, FilterRow, and sidebar+body row are direct children of the page flex column', () => {
    renderRedesign()
    const pageHeader = screen.getByTestId('page-header')
    const strip = screen.getByTestId('mapping-summary-strip')
    const filterRow = screen.getByTestId('mapping-redesign-filter-row')
    const sidebar = screen.getByTestId('source-schema-sidebar')

    // Walk up from PageHeader to find the outer flex column. The
    // testid mock for PageHeader returns `<div data-testid="page-header">`
    // so its parentElement IS the page flex column.
    const pageColumn = pageHeader.parentElement
    expect(pageColumn).not.toBeNull()
    if (!pageColumn) return

    // Pin the page column's class shape (the outer wrapper rendered
    // by MappingRedesignContent).
    expect(pageColumn.className).toMatch(/\bflex\b/)
    expect(pageColumn.className).toMatch(/\bflex-col\b/)
    expect(pageColumn.className).toMatch(/\bh-full\b/)
    expect(pageColumn.className).toMatch(/\bbg-gray-50\b/)

    // Each of the four elements must have `pageColumn` as its
    // immediate parent.
    expect(strip.parentElement).toBe(pageColumn)
    expect(filterRow.parentElement).toBe(pageColumn)
    // The sidebar lives inside the sidebar+body flex row; that ROW
    // is the direct child of pageColumn. Walk one step up from the
    // sidebar to find the row, then assert.
    const sidebarBodyRow = sidebar.parentElement
    expect(sidebarBodyRow).not.toBeNull()
    if (!sidebarBodyRow) return
    expect(sidebarBodyRow.parentElement).toBe(pageColumn)

    // Pin the sibling order: PageHeader → Strip → FilterRow → sidebar+
    // body row. Children after that (drawer, dialog) are position-fixed
    // and not asserted by this invariant.
    //
    // PR-6 (feat/ui-consolidation): the previously-separate
    // `MappingProjectStatsRow` was retired and folded into
    // `MappingSummaryStrip`. The chain shortens by one — strip now
    // directly follows PageHeader.
    const children = Array.from(pageColumn.children) as HTMLElement[]
    const pageHeaderIdx = children.indexOf(pageHeader)
    const stripIdx = children.indexOf(strip)
    const filterRowIdx = children.indexOf(filterRow)
    const rowIdx = children.indexOf(sidebarBodyRow)
    expect(pageHeaderIdx).toBeGreaterThanOrEqual(0)
    expect(stripIdx).toBe(pageHeaderIdx + 1)
    expect(filterRowIdx).toBe(stripIdx + 1)
    expect(rowIdx).toBe(filterRowIdx + 1)
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
    transformationDescription: null,
    transformationSqlPreview: null,
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
    // the mapped row's body. Drawer redesign — TARGET-led identity:
    // the header is target-only (no SOURCE row). Verify the freshly-
    // mapped row's body now contains the SOURCE section with a
    // populated source card (the unmapped empty-state body is gone).
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(
      screen.getByTestId('drawer-section-source'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('drawer-source-card')).toBeInTheDocument()
    expect(
      screen.queryByTestId('drawer-unmapped-empty-state'),
    ).toBeNull()
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
    transformationDescription: null,
    transformationSqlPreview: null,
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
    transformationDescription: null,
    transformationSqlPreview: null,
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4b — AI Suggest end-to-end via the page surface.
// ─────────────────────────────────────────────────────────────────────────────
//
// These tests pin the page-level wiring of the new [Suggest with AI]
// footer button + auto-trigger plumbing through the drawer down to
// the `CreateMappingForm`'s `invokeSuggest`. They do NOT re-pin the
// per-component pill / Why? / replace-warning behavior — that lives
// in `tests/components/create-mapping-form.test.tsx`. Scope here is
// strictly the surface that integrates the three layers
// (page → drawer → form).

describe('MappingRedesignContent Phase 4a-4b — Suggest with AI surfaces from URL-opened unmapped drawer', () => {
  it('renders [Suggest with AI] alongside [Create mapping] for an unmapped row', () => {
    currentSearch = 'drawer=unmapped::tf-unmapped'
    render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={buildDataWithUnmapped()}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
  })

  it('clicking [Suggest with AI] auto-triggers the wrapper exactly once and pre-fills on success', async () => {
    suggestMappingForTargetMock.mockResolvedValue({
      success: true,
      suggestion: {
        sourceFieldIds: ['sf-acct-col'],
        combinationType: 'single',
        confidence: 75,
        rationale: 'page-surface rationale',
      },
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
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(suggestMappingForTargetMock).toHaveBeenCalledTimes(1)
    expect(
      screen.getByTestId('create-mapping-form-suggest-loaded'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('create-mapping-form-confidence-pill'),
    ).toBeInTheDocument()
  })

  it('saving an AI-suggested mapping passes ai_suggested=true through createFieldMapping', async () => {
    suggestMappingForTargetMock.mockResolvedValue({
      success: true,
      suggestion: {
        sourceFieldIds: ['sf-acct-col'],
        combinationType: 'single',
        confidence: 88,
        rationale: 'persisted rationale',
      },
    })
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-ai-saved',
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
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    fireEvent.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(createFieldMappingMock).toHaveBeenCalledTimes(1)
    const args = createFieldMappingMock.mock.calls[0][0] as {
      aiSuggested?: boolean
      confidence?: number
      aiReasoning?: string
    }
    expect(args.aiSuggested).toBe(true)
    expect(args.confidence).toBe(88)
    expect(args.aiReasoning).toBe('persisted rationale')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4-polish-2 — group collapsibility integration.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the URL ↔ render contract for `?collapsed=`:
//   • default state: every group is expanded
//   • `?collapsed=foo,bar` collapses only foo + bar; others stay expanded
//   • clicking a group header writes the table NAME into `?collapsed=`
//   • any active filter forces auto-expand on every visible group
//     (the persisted `?collapsed=` is preserved, not modified)
//   • clearing filters restores the user's collapsed state from URL
//
// The hook unit tests cover the parser/serializer details; this suite
// covers the JSX integration via the live MappingRedesignContent body.

describe('MappingRedesignContent — group collapsibility (Phase 4-polish-2)', () => {
  it('renders all groups expanded by default with no ?collapsed= in URL', () => {
    renderRedesign()
    const sections = screen.getAllByTestId('target-table-group')
    expect(sections).toHaveLength(3)
    // data-collapsed reflects the disclosure state — false on every
    // group when `?collapsed=` is absent.
    for (const s of sections) {
      expect(s.getAttribute('data-collapsed')).toBe('false')
    }
    // Every group's chevron toggle button shows aria-expanded=true.
    const toggles = screen.getAllByTestId('target-table-group-toggle')
    expect(toggles).toHaveLength(3)
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('renders collapsed groups when ?collapsed= names them', () => {
    renderRedesign('collapsed=accounts,loans')
    const sections = screen.getAllByTestId('target-table-group')
    const byId = new Map(
      sections.map((s) => [s.getAttribute('data-target-table-id'), s]),
    )
    expect(byId.get(accountsTable.id)?.getAttribute('data-collapsed')).toBe('true')
    expect(byId.get(loansTable.id)?.getAttribute('data-collapsed')).toBe('true')
    // customers stays expanded because it's not in the collapsed list.
    expect(byId.get(customersTable.id)?.getAttribute('data-collapsed')).toBe(
      'false',
    )
  })

  it('clicking a group header writes the table NAME into ?collapsed=', () => {
    renderRedesign()
    replaceMock.mockClear()
    // Pick the customers group header. Each toggle has the table name
    // baked into its aria-label, so we can identify it precisely.
    const customersToggle = screen.getByLabelText('Toggle customers group')
    fireEvent.click(customersToggle)
    expect(replaceMock).toHaveBeenCalled()
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain('collapsed=customers')
  })

  it('toggling an already-collapsed group removes it from ?collapsed=', () => {
    renderRedesign('collapsed=accounts,customers')
    replaceMock.mockClear()
    const accountsToggle = screen.getByLabelText('Toggle accounts group')
    fireEvent.click(accountsToggle)
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    // Only `customers` should remain in `?collapsed=`.
    expect(lastUrl).toContain('collapsed=customers')
    expect(lastUrl).not.toContain('accounts')
  })

  it('toggling the only collapsed group drops the ?collapsed= param entirely', () => {
    renderRedesign('collapsed=accounts')
    replaceMock.mockClear()
    fireEvent.click(screen.getByLabelText('Toggle accounts group'))
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).not.toContain('collapsed=')
  })

  it('toggling preserves co-existing filter URL params', () => {
    // Use a search term that matches a row so the accounts group
    // remains in the DOM (`q=test` hides all groups via the Search
    // identity rule, leaving no toggle button to click).
    renderRedesign('q=account')
    replaceMock.mockClear()
    fireEvent.click(screen.getByLabelText('Toggle accounts group'))
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain('q=account')
    expect(lastUrl).toContain('collapsed=accounts')
  })

  it('auto-expand: ?q=test forces every group expanded regardless of ?collapsed=', () => {
    // 'balance' matches a row in accounts. Both `accounts` and
    // `customers` are in `?collapsed=` but the active search forces
    // them open so the matching results aren't hidden.
    renderRedesign('q=balance&collapsed=accounts,customers')
    const toggles = screen.getAllByTestId('target-table-group-toggle')
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('auto-expand: ?status=needs_review forces every visible group expanded', () => {
    renderRedesign('status=needs_review&collapsed=accounts,customers,loans')
    // Status filter keeps all groups visible (Amendment 1 / Gap 3
    // status-keeps-empty contract). Auto-expand forces every one of
    // them open.
    const toggles = screen.getAllByTestId('target-table-group-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('auto-expand: ?confidence=high forces every visible group expanded', () => {
    renderRedesign('confidence=high&collapsed=accounts,customers,loans')
    const toggles = screen.getAllByTestId('target-table-group-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('true')
    }
  })

  it('auto-expand: ?target=<id> narrows visibility AND forces survivor expanded', () => {
    renderRedesign(`target=${accountsTable.id}&collapsed=accounts`)
    // Only the accounts group should be visible (others hidden by the
    // target filter), AND it should be expanded despite the persisted
    // `?collapsed=accounts` — the filter pressure overrides.
    const sections = screen.getAllByTestId('target-table-group')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.getAttribute('data-target-table-id')).toBe(
      accountsTable.id,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('auto-expand: ?source=<id> narrows visibility AND forces survivor expanded', () => {
    renderRedesign(`source=${sourceTableY.id}&collapsed=customers`)
    // sourceTableY is referenced only by the customers table.
    const sections = screen.getAllByTestId('target-table-group')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.getAttribute('data-target-table-id')).toBe(
      customersTable.id,
    )
    const toggle = screen.getByTestId('target-table-group-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('?collapsed= is preserved while filters are active (auto-expand does NOT clear it)', () => {
    // The user collapsed accounts + customers, then ran a search. The
    // groups auto-expand visually, but the URL keeps `?collapsed=` so
    // clearing the filter restores the prior collapsed state. We
    // verify the URL was NOT mutated by the act of mounting with
    // both params present.
    renderRedesign('q=test&collapsed=accounts,customers')
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('clearing filters restores the user collapsed state from ?collapsed=', () => {
    // Simulate the post-clear state by mounting with `?collapsed=` only —
    // i.e. what the URL looks like after the user clears their filter.
    // Auto-expand should NO LONGER apply, so the named groups render
    // collapsed again.
    renderRedesign('collapsed=accounts')
    const sections = screen.getAllByTestId('target-table-group')
    const byId = new Map(
      sections.map((s) => [s.getAttribute('data-target-table-id'), s]),
    )
    expect(byId.get(accountsTable.id)?.getAttribute('data-collapsed')).toBe('true')
    expect(byId.get(customersTable.id)?.getAttribute('data-collapsed')).toBe(
      'false',
    )
    expect(byId.get(loansTable.id)?.getAttribute('data-collapsed')).toBe('false')
  })

  it('rows stay mounted when collapsed (clipped only) so screen-reader graph stays stable', () => {
    renderRedesign('collapsed=accounts')
    const accountsSection = screen
      .getAllByTestId('target-table-group')
      .find((s) => s.getAttribute('data-target-table-id') === accountsTable.id)!
    // The rows-container DOM is rendered with max-h-0 — pin that the
    // FieldMappingRow children are still in the tree (just clipped).
    const container = within(accountsSection).getByTestId(
      'target-table-rows-container',
    )
    expect(within(container).getAllByTestId('field-mapping-row').length).toBeGreaterThan(
      0,
    )
    expect(container.className).toContain('max-h-0')
  })

  it('toggling a group does NOT mutate filter params in the URL', () => {
    renderRedesign(`target=${accountsTable.id}&q=balance`)
    replaceMock.mockClear()
    // Note: with `?target=` set, only one group renders (accounts).
    // Toggling does not strip the filter — the URL afterwards must
    // preserve both params verbatim.
    const accountsToggle = screen.getByLabelText('Toggle accounts group')
    fireEvent.click(accountsToggle)
    const lastUrl = replaceMock.mock.calls.at(-1)?.[0] as string
    expect(lastUrl).toContain(`target=${accountsTable.id}`)
    expect(lastUrl).toContain('q=balance')
    expect(lastUrl).toContain('collapsed=accounts')
  })

  it('clicking the kebab menu does NOT toggle the group (sibling buttons)', () => {
    renderRedesign()
    replaceMock.mockClear()
    // The kebab is wired with needsReviewCount > 0 because the fixture
    // includes a needs_review row in the accounts table. Find that
    // group's kebab.
    const accountsSection = screen
      .getAllByTestId('target-table-group')
      .find((s) => s.getAttribute('data-target-table-id') === accountsTable.id)!
    const kebabTrigger = within(accountsSection).getByTestId(
      'target-table-kebab-trigger',
    )
    fireEvent.click(kebabTrigger)
    // No URL write should have occurred — only the kebab menu should
    // have opened (its own state). Assert that the menu opened AND the
    // collapsed state was not touched.
    expect(
      within(accountsSection).getByTestId('target-table-kebab-menu'),
    ).toBeInTheDocument()
    const collapseUrls = replaceMock.mock.calls
      .map((c) => c[0] as string)
      .filter((u) => u.includes('collapsed='))
    expect(collapseUrls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 empty-state — four-case discriminator + toolbar visibility.
// ─────────────────────────────────────────────────────────────────────────────
//
// The redesigned page now mounts `<EmptyMappingState>` in place of the
// TargetTableGroup list whenever the project is in one of four empty
// shapes (no schemas, target-only, source-only, both-but-zero-TFMs).
// The summary strip + filter row are hidden in those cases because
// there is nothing to filter. The populated case (`counts.total >
// counts.unmapped`) is unchanged — toolbar and group list both render.
//
// These tests pin the routing + toolbar visibility through the page-
// level component so the integration contract is guarded end-to-end.
// The discriminator math itself is unit-tested in
// `tests/components/empty-mapping-state.test.tsx`; the
// `<GenerateMappingsPanel>` submit flow is unit-tested in
// `tests/components/generate-mappings-panel.test.tsx`.

describe('MappingRedesignContent — Phase 4 empty-state cases', () => {
  function buildEmptyData(
    overrides: Partial<MappingsForRedesignResult>,
  ): MappingsForRedesignResult {
    return {
      projectId: 'p1',
      rows: [],
      targetTables: [],
      sourceTables: [],
      sourceFieldAcknowledgments: [],
      sourceFields: [],
      counts: {
        total: 0,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 0,
      },
      targetSchemaEmpty: true,
      ...overrides,
    }
  }

  function renderEmpty(data: MappingsForRedesignResult) {
    currentSearch = ''
    return render(
      <MappingRedesignContent
        projectId="p1"
        projectName="Heritage Core"
        initialRedesignData={data}
      />,
    )
  }

  it('case 1 (no schemas): renders the no-schemas card and hides the toolbar', () => {
    renderEmpty(
      buildEmptyData({
        targetSchemaEmpty: true,
        sourceTables: [],
        sourceFields: [],
      }),
    )
    expect(
      screen.getByTestId('mapping-redesign-empty-no-schemas'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-summary-strip')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-filter-row')).toBeNull()
    expect(
      screen.getByTestId('mapping-redesign-empty-cta').getAttribute('href'),
    ).toBe('/app/projects/p1/data-overview?tab=schema-overview')
  })

  it('case 2 (target schema missing): renders the no-target card and hides the toolbar', () => {
    renderEmpty(
      buildEmptyData({
        targetSchemaEmpty: true,
        sourceTables: [sourceTableX],
        sourceFields: [
          {
            id: 'sf-1',
            name: 'COL_A',
            dataType: 'VARCHAR(50)',
            ordinalPosition: 1,
            sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
            mappingStatus: 'unmapped',
            sampleValues: [],
            isAcknowledged: false,
          } satisfies SourceFieldWithState,
        ],
      }),
    )
    expect(
      screen.getByTestId('mapping-redesign-empty-no-target'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-summary-strip')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-filter-row')).toBeNull()
  })

  it('case 3 (source schema missing): renders the no-source card and hides the toolbar', () => {
    renderEmpty(
      buildEmptyData({
        targetSchemaEmpty: false,
        sourceTables: [],
        sourceFields: [],
        targetTables: [accountsTable],
        counts: {
          total: 5,
          approved: 0,
          needsReview: 0,
          rejected: 0,
          unmapped: 5,
        },
      }),
    )
    expect(
      screen.getByTestId('mapping-redesign-empty-no-source'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-summary-strip')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-filter-row')).toBeNull()
    // The all-Unmapped row list must NOT render in case 3 — the user
    // has no path forward without source schemas.
    expect(screen.queryAllByTestId('target-table-group')).toHaveLength(0)
  })

  it('case 4 (both schemas, all unmapped): renders the GenerateMappingsPanel and hides the toolbar', () => {
    renderEmpty(
      buildEmptyData({
        targetSchemaEmpty: false,
        sourceTables: [sourceTableX, sourceTableY],
        sourceFields: [
          {
            id: 'sf-1',
            name: 'COL_A',
            dataType: 'VARCHAR(50)',
            ordinalPosition: 1,
            sourceTable: { id: sourceTableX.id, name: sourceTableX.name },
            mappingStatus: 'unmapped',
            sampleValues: [],
            isAcknowledged: false,
          } satisfies SourceFieldWithState,
        ],
        targetTables: [accountsTable, customersTable],
        counts: {
          total: 4,
          approved: 0,
          needsReview: 0,
          rejected: 0,
          unmapped: 4,
        },
      }),
    )
    expect(
      screen.getByTestId('mapping-redesign-empty-generate'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('generate-mappings-panel')).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-source-panel'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-target-panel'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-summary-strip')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-filter-row')).toBeNull()
    // The all-Unmapped row list must NOT render in case 4 either —
    // the panel takes over.
    expect(screen.queryAllByTestId('target-table-group')).toHaveLength(0)
  })

  it('populated case: toolbar (Strip + FilterRow) renders and the empty card is absent', () => {
    // Use the existing populated fixture path so we re-exercise the
    // structural-invariant guarantee: when there is at least one
    // non-unmapped row, both Strip and FilterRow render in their
    // canonical positions and the EmptyMappingState card stays out.
    renderRedesign()
    expect(screen.getByTestId('mapping-summary-strip')).toBeInTheDocument()
    expect(screen.getByTestId('mapping-redesign-filter-row')).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-redesign-empty-no-schemas')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-target')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-source')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-generate')).toBeNull()
  })

  it('source schema sidebar persists across the empty-state render', () => {
    // The sidebar is part of the empty-state shell (Phase 4 prompt
    // §"Wire-up in redesign MappingContent"): the sidebar+body flex
    // row keeps mounting in every empty case. This pins it.
    renderEmpty(
      buildEmptyData({
        targetSchemaEmpty: true,
        sourceTables: [],
        sourceFields: [],
      }),
    )
    expect(screen.getByTestId('source-schema-sidebar')).toBeInTheDocument()
  })
})
