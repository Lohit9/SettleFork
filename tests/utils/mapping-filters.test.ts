import { describe, it, expect } from 'vitest'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  SourceTableSummary,
  TargetAcknowledgedRow,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import {
  countFilteredPerTargetTable,
  DEFAULT_FILTER_STATE,
  filterRows,
  hasActiveFilters,
  isGroupHiddenByIdentityFilters,
  isGroupHiddenBySearch,
  parseFilterStateFromParams,
  serializeFilterStateToQuery,
  shouldHideEmptyGroups,
  type MappingFilterState,
} from '@/lib/utils/mapping-filters'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 3 — filter pipeline unit tests.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fixtures ────────────────────────────────────────────────────────────────

const tableA: TargetTableSummary = {
  id: 'tt-a',
  name: 'accounts',
  datasetName: 'heritage',
  fieldCount: 4,
}
const tableB: TargetTableSummary = {
  id: 'tt-b',
  name: 'customers',
  datasetName: 'heritage',
  fieldCount: 2,
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
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR',
    isNullable: false,
    defaultValue: null,
    targetTable: { id: tableA.id, name: tableA.name },
    ordinalPosition: 1,
    ...overrides,
  }
}

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 90,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: { id: 'sf-1', name: 'ACCT_NO', dataType: 'NUMBER', isNullable: false },
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
    id: 'm-1',
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

function valueAssignment(
  overrides: Partial<ValueAssignmentRow> = {},
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: 'va-1',
    targetField: targetField({ id: 'tf-va', name: 'created_at' }),
    confidence: 95,
    status: 'approved',
    hasTransformation: true,
    transformationStatus: 'applied',
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
    ...overrides,
  }
}

function ack(overrides: Partial<TargetAcknowledgedRow> = {}): TargetAcknowledgedRow {
  return {
    kind: 'target_acknowledged',
    id: 'ack-1',
    targetField: targetField({ id: 'tf-ack', name: 'internal_flag' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    acknowledgmentReason: null,
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
    ...overrides,
  }
}

/** Build the canonical fixture — one of each row kind, diverse tables. */
function buildRows(): MappingRow[] {
  return [
    mapped({
      id: 'm-accounts-1',
      targetField: targetField({ id: 'tf-1', name: 'customer_id' }),
      status: 'approved',
    }),
    mapped({
      id: 'm-accounts-2',
      targetField: targetField({ id: 'tf-2', name: 'balance_amount' }),
      status: 'needs_review',
      sources: [
        source({
          id: 'ms-2',
          sourceField: { id: 'sf-2', name: 'BALANCE', dataType: 'DECIMAL', isNullable: true },
          sourceTable: { id: sourceTableY.id, name: sourceTableY.name },
        }),
      ],
    }),
    mapped({
      id: 'm-customers-1',
      targetField: targetField({
        id: 'tf-3',
        name: 'email',
        targetTable: { id: tableB.id, name: tableB.name },
      }),
      status: 'rejected',
    }),
    valueAssignment({
      id: 'va-accounts-1',
      targetField: targetField({
        id: 'tf-va',
        name: 'created_at',
        targetTable: { id: tableA.id, name: tableA.name },
      }),
    }),
    ack({
      id: 'ack-customers-1',
      targetField: targetField({
        id: 'tf-ack',
        name: 'legacy_flag',
        targetTable: { id: tableB.id, name: tableB.name },
      }),
    }),
    unmapped({
      id: 'unmapped::tf-u',
      targetField: targetField({
        id: 'tf-u',
        name: 'uncovered_field',
        targetTable: { id: tableA.id, name: tableA.name },
      }),
    }),
  ]
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('filterRows — default state', () => {
  it('returns all rows when no filters are active', () => {
    const rows = buildRows()
    const out = filterRows(rows, DEFAULT_FILTER_STATE)
    expect(out).toHaveLength(rows.length)
    expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id))
  })

  it('returns a defensive copy (fast path) that is not the input reference', () => {
    const rows = buildRows()
    const out = filterRows(rows, DEFAULT_FILTER_STATE)
    expect(out).not.toBe(rows)
    // Mutating the output should not affect the input.
    out.pop()
    expect(rows).toHaveLength(6)
  })
})

describe('filterRows — target filter', () => {
  it('narrows to rows whose targetField.targetTable.id matches', () => {
    const rows = buildRows()
    const out = filterRows(rows, { ...DEFAULT_FILTER_STATE, target: tableA.id })
    expect(out).toHaveLength(4) // 2 mapped + 1 VA + 1 unmapped in table A
    expect(out.every((r) => r.targetField.targetTable.id === tableA.id)).toBe(true)
  })

  it('returns empty when no rows match the target', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      target: 'tt-missing',
    })
    expect(out).toEqual([])
  })
})

describe('filterRows — source filter', () => {
  it('keeps only mapped rows whose mapping_source matches the selected source table', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableX.id,
    })
    expect(out).toHaveLength(2) // two mapped rows have ACCT_MASTER sources
    expect(out.every((r) => r.kind === 'mapped')).toBe(true)
  })

  it('EXCLUDES VAs, target-acknowledged, and unmapped when a specific source is selected', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableY.id,
    })
    expect(out.map((r) => r.kind)).toEqual(['mapped'])
    // Explicit regression guard — none of the non-mapped kinds should leak.
    expect(out.some((r) => r.kind === 'value_assignment')).toBe(false)
    expect(out.some((r) => r.kind === 'target_acknowledged')).toBe(false)
    expect(out.some((r) => r.kind === 'unmapped')).toBe(false)
  })

  it('matches rows that have ANY mapping_source in the selected source table (not just dominant)', () => {
    const rowWithMultiSources = mapped({
      id: 'multi',
      sources: [
        source({ id: 'ms-a', sourceTable: { id: sourceTableX.id, name: sourceTableX.name } }),
        source({
          id: 'ms-b',
          ordinal: 1,
          sourceTable: { id: sourceTableY.id, name: sourceTableY.name },
        }),
      ],
    })
    const out = filterRows([rowWithMultiSources], {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableY.id,
    })
    expect(out).toHaveLength(1)
  })
})

describe('filterRows — status filter', () => {
  it('narrows to approved only', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      status: 'approved',
    })
    expect(out.every((r) => r.status === 'approved')).toBe(true)
  })

  it('narrows to needs_review only', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      status: 'needs_review',
    })
    expect(out.every((r) => r.status === 'needs_review')).toBe(true)
    expect(out).toHaveLength(1)
  })

  it('narrows to rejected only', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      status: 'rejected',
    })
    expect(out.every((r) => r.status === 'rejected')).toBe(true)
    expect(out).toHaveLength(1)
  })

  it('"all" INCLUDES rejected (per §9 Q6 resolution)', () => {
    const rows = buildRows()
    const out = filterRows(rows, DEFAULT_FILTER_STATE)
    expect(out.some((r) => r.status === 'rejected')).toBe(true)
    expect(out.length).toBe(rows.length)
  })
})

describe('filterRows — search filter', () => {
  it('matches target field name case-insensitively', () => {
    // "balance_amount" is unique to exactly one row (mapped, table A).
    // Use uppercase needle to exercise the case-insensitivity path.
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      search: 'BALANCE_AMOUNT',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.targetField.name).toBe('balance_amount')
  })

  it('matches target table name', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      search: 'customers',
    })
    // customers table contains mapped(email) + ack(legacy_flag)
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.targetField.targetTable.name === 'customers')).toBe(true)
  })

  it('matches mapping_sources.sourceField.name', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      search: 'BALANCE',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe('mapped')
  })

  it('matches mapping_sources.sourceTable.name', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      search: 'acct_master',
    })
    expect(out.every((r) => r.kind === 'mapped')).toBe(true)
    expect(out.length).toBeGreaterThan(0)
  })

  it('empty search returns all rows', () => {
    const rows = buildRows()
    const out = filterRows(rows, { ...DEFAULT_FILTER_STATE, search: '' })
    expect(out).toHaveLength(rows.length)
  })

  it('whitespace-only search returns all rows', () => {
    const rows = buildRows()
    const out = filterRows(rows, { ...DEFAULT_FILTER_STATE, search: '   \t  ' })
    expect(out).toHaveLength(rows.length)
  })

  it('non-matching search returns empty', () => {
    const out = filterRows(buildRows(), {
      ...DEFAULT_FILTER_STATE,
      search: 'nonexistent-xyz',
    })
    expect(out).toEqual([])
  })
})

describe('filterRows — combined filters (AND semantics)', () => {
  it('target AND status both apply', () => {
    const out = filterRows(buildRows(), {
      target: tableA.id,
      source: 'all',
      status: 'approved',
      search: '',
    })
    expect(
      out.every(
        (r) => r.targetField.targetTable.id === tableA.id && r.status === 'approved',
      ),
    ).toBe(true)
  })

  it('all four filters apply simultaneously', () => {
    const out = filterRows(buildRows(), {
      target: tableA.id,
      source: sourceTableX.id,
      status: 'approved',
      search: 'customer',
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.targetField.name).toBe('customer_id')
  })
})

describe('filterRows — order preservation', () => {
  it('preserves server-guaranteed row order after filtering', () => {
    const rows = buildRows()
    const out = filterRows(rows, { ...DEFAULT_FILTER_STATE, status: 'approved' })
    const sourceIndexOf = (id: string) => rows.findIndex((r) => r.id === id)
    const outIds = out.map((r) => r.id)
    // Each consecutive pair in the output must be non-descending in
    // their source position — i.e., server order is preserved.
    for (let i = 1; i < outIds.length; i++) {
      const a = outIds[i - 1]
      const b = outIds[i]
      if (!a || !b) continue
      expect(sourceIndexOf(a)).toBeLessThan(sourceIndexOf(b))
    }
  })
})

describe('countFilteredPerTargetTable', () => {
  it('returns a Map keyed by target-table id with total + matching counts', () => {
    const rows = buildRows()
    const filtered = filterRows(rows, { ...DEFAULT_FILTER_STATE, status: 'approved' })
    const counts = countFilteredPerTargetTable(filtered, [tableA, tableB])
    expect(counts.get(tableA.id)).toEqual({ total: 4, matching: 2 })
    expect(counts.get(tableB.id)).toEqual({ total: 2, matching: 1 })
  })

  it('includes tables with zero matching rows', () => {
    const counts = countFilteredPerTargetTable([], [tableA, tableB])
    expect(counts.get(tableA.id)).toEqual({ total: 4, matching: 0 })
    expect(counts.get(tableB.id)).toEqual({ total: 2, matching: 0 })
  })
})

describe('parseFilterStateFromParams', () => {
  it('parses all four params', () => {
    const params = new URLSearchParams('target=t1&source=s1&status=approved&q=hello')
    const state = parseFilterStateFromParams(params)
    expect(state).toEqual({
      target: 't1',
      source: 's1',
      status: 'approved',
      search: 'hello',
    })
  })

  it('defaults missing params to "all" / empty', () => {
    const state = parseFilterStateFromParams(new URLSearchParams(''))
    expect(state).toEqual(DEFAULT_FILTER_STATE)
  })

  it('invalid status falls back to "all"', () => {
    const state = parseFilterStateFromParams(
      new URLSearchParams('status=bogus_value'),
    )
    expect(state.status).toBe('all')
  })

  it('IGNORES legacy params (fields, type) — hard reset per founder decision', () => {
    const state = parseFilterStateFromParams(
      new URLSearchParams('fields=tfm1,tfm2&type=one_to_one'),
    )
    expect(state).toEqual(DEFAULT_FILTER_STATE)
  })
})

describe('serializeFilterStateToQuery', () => {
  it('omits default values', () => {
    expect(serializeFilterStateToQuery(DEFAULT_FILTER_STATE)).toBe('')
  })

  it('emits all four params when all are non-default', () => {
    const qs = serializeFilterStateToQuery({
      target: 't1',
      source: 's1',
      status: 'approved',
      search: 'hello',
    })
    const params = new URLSearchParams(qs)
    expect(params.get('target')).toBe('t1')
    expect(params.get('source')).toBe('s1')
    expect(params.get('status')).toBe('approved')
    expect(params.get('q')).toBe('hello')
  })

  it('trims whitespace-only search to empty', () => {
    const qs = serializeFilterStateToQuery({
      ...DEFAULT_FILTER_STATE,
      search: '   ',
    })
    expect(qs).toBe('')
  })
})

describe('hasActiveFilters', () => {
  it('returns false for default state', () => {
    expect(hasActiveFilters(DEFAULT_FILTER_STATE)).toBe(false)
  })

  it('returns true when any filter is non-default', () => {
    const cases: MappingFilterState[] = [
      { ...DEFAULT_FILTER_STATE, target: 't1' },
      { ...DEFAULT_FILTER_STATE, source: 's1' },
      { ...DEFAULT_FILTER_STATE, status: 'approved' },
      { ...DEFAULT_FILTER_STATE, search: 'x' },
    ]
    for (const c of cases) expect(hasActiveFilters(c)).toBe(true)
  })

  it('returns false for whitespace-only search', () => {
    expect(hasActiveFilters({ ...DEFAULT_FILTER_STATE, search: '  ' })).toBe(false)
  })
})

describe('shouldHideEmptyGroups', () => {
  it('returns false for the default filter state', () => {
    expect(shouldHideEmptyGroups(DEFAULT_FILTER_STATE)).toBe(false)
  })

  it('returns true when Target filter is active', () => {
    expect(shouldHideEmptyGroups({ ...DEFAULT_FILTER_STATE, target: 'tt-a' })).toBe(
      true,
    )
  })

  it('returns true when Source filter is active', () => {
    expect(shouldHideEmptyGroups({ ...DEFAULT_FILTER_STATE, source: 'st-x' })).toBe(
      true,
    )
  })

  it('returns true when both Target and Source filters are active', () => {
    expect(
      shouldHideEmptyGroups({
        ...DEFAULT_FILTER_STATE,
        target: 'tt-a',
        source: 'st-x',
      }),
    ).toBe(true)
  })

  it('returns FALSE when only Status filter is active (status keeps empty groups visible)', () => {
    // Status remains the sole exception — discrete 3-4-value axis where
    // an empty group ("0 needs-review fields here") is informative rather
    // than noise. See shouldHideEmptyGroups JSDoc.
    expect(
      shouldHideEmptyGroups({ ...DEFAULT_FILTER_STATE, status: 'approved' }),
    ).toBe(false)
  })

  it('returns TRUE when only Search filter is active (Amendment 3, 2026-04-21)', () => {
    // Before Amendment 3, Search kept empty groups visible. Founder review
    // flipped this: Search is free-text / infinite-cardinality so 7 empty
    // headers per keystroke is noise on a fast interaction.
    expect(
      shouldHideEmptyGroups({ ...DEFAULT_FILTER_STATE, search: 'loan' }),
    ).toBe(true)
  })

  it('returns TRUE for whitespace-only search treated as empty — opposite direction', () => {
    // Whitespace-only search is semantically "no search" (trim()===""),
    // so it should NOT trigger hiding. Guards against accidentally firing
    // hide when the user types a space then backspaces it.
    expect(
      shouldHideEmptyGroups({ ...DEFAULT_FILTER_STATE, search: '   ' }),
    ).toBe(false)
  })

  it('returns TRUE when Status and Search are active (Search drives hiding)', () => {
    expect(
      shouldHideEmptyGroups({
        ...DEFAULT_FILTER_STATE,
        status: 'approved',
        search: 'loan',
      }),
    ).toBe(true)
  })

  it('returns TRUE when Target + Status combined — Target dominates', () => {
    expect(
      shouldHideEmptyGroups({
        ...DEFAULT_FILTER_STATE,
        target: 'tt-a',
        status: 'approved',
      }),
    ).toBe(true)
  })

  it('returns TRUE when Target + Search combined', () => {
    expect(
      shouldHideEmptyGroups({
        ...DEFAULT_FILTER_STATE,
        target: 'tt-a',
        search: 'loan',
      }),
    ).toBe(true)
  })
})

describe('isGroupHiddenByIdentityFilters', () => {
  const rows = buildRows()

  it('keeps every group visible when Target and Source are both "all"', () => {
    for (const table of [tableA, tableB]) {
      expect(
        isGroupHiddenByIdentityFilters(table.id, DEFAULT_FILTER_STATE, rows),
      ).toBe(false)
    }
  })

  it('hides non-matching target groups when Target is set', () => {
    const state: MappingFilterState = { ...DEFAULT_FILTER_STATE, target: tableA.id }
    expect(isGroupHiddenByIdentityFilters(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenByIdentityFilters(tableB.id, state, rows)).toBe(true)
  })

  it('hides groups with no mapping_source in the selected source table', () => {
    // fixture: sourceTableY is referenced only by a row in tableA.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableY.id,
    }
    expect(isGroupHiddenByIdentityFilters(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenByIdentityFilters(tableB.id, state, rows)).toBe(true)
  })

  it('Target + Source combined: both must match', () => {
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      target: tableA.id,
      source: sourceTableY.id,
    }
    expect(isGroupHiddenByIdentityFilters(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenByIdentityFilters(tableB.id, state, rows)).toBe(true)
  })

  it('Target-matching group stays visible even when Status narrows its rows to zero (identity-only)', () => {
    // Status isn't part of the identity decision. A matching Target stays
    // visible regardless of status; the post-status empty-state is rendered
    // inside the group header by the caller.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      target: tableA.id,
      status: 'rejected', // fixture has 0 rejected rows in tableA
    }
    expect(isGroupHiddenByIdentityFilters(tableA.id, state, rows)).toBe(false)
  })

  it('ignores non-mapped rows when evaluating Source membership', () => {
    // A group containing only VAs / target_ack / unmapped rows should be
    // hidden when a specific Source is selected, because those kinds
    // have no mapping_sources.
    const vaOnlyRow: MappingRow = valueAssignment({
      id: 'va-only',
      targetField: targetField({
        id: 'tf-va-only',
        name: 'va_field',
        targetTable: { id: 'tt-va-only', name: 'va_only_table' },
      }),
    })
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableX.id,
    }
    expect(isGroupHiddenByIdentityFilters('tt-va-only', state, [vaOnlyRow])).toBe(
      true,
    )
  })
})

describe('isGroupHiddenBySearch (Amendment 3, 2026-04-21)', () => {
  const rows = buildRows()

  it('returns false when search is empty (pass-through)', () => {
    expect(
      isGroupHiddenBySearch(tableA.id, DEFAULT_FILTER_STATE, rows),
    ).toBe(false)
    expect(
      isGroupHiddenBySearch(tableB.id, DEFAULT_FILTER_STATE, rows),
    ).toBe(false)
  })

  it('returns false for whitespace-only search (trim() === "")', () => {
    const state: MappingFilterState = { ...DEFAULT_FILTER_STATE, search: '   ' }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(false)
  })

  it('hides groups with zero target-field-name matches', () => {
    // "customer_id" matches only tf-1 in tableA → tableB should hide.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'customer_id',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(true)
  })

  it('hides ALL groups when the search matches nothing anywhere', () => {
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'xyz_never_matches',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(true)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(true)
  })

  it('is case-insensitive and trims whitespace from the needle', () => {
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: '  CUSTOMER_ID  ',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(true)
  })

  it('matches against source field names (mapped rows only)', () => {
    // "balance" hits source field BALANCE on m-accounts-2 → tableA stays;
    // tableB has no row referencing "balance" → hidden.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'balance',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(true)
  })

  it('matches against source table names', () => {
    // "ACCT_MASTER" → source table X, referenced by one row in tableA and
    // one in tableB → both visible.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'acct_master',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(false)
  })

  it('matches against target table names', () => {
    // "customers" is tableB's own name → every row inherits it via its
    // targetTable — tableB visible, tableA hidden.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'customers',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(true)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(false)
  })

  it('REGRESSION: short-circuits to false when Target filter is active (identity wins)', () => {
    // Target=tableA + search that matches nothing → tableA MUST stay
    // visible with filtered-empty state inside. Search hiding must not
    // override the explicit identity request.
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      target: tableA.id,
      search: 'xyz_never_matches',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    // And tableB, which isn't picked up here, is also returned false —
    // because identity filtering happens upstream via
    // isGroupHiddenByIdentityFilters and this predicate's contract is
    // to stay silent when any identity filter is active.
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(false)
  })

  it('REGRESSION: short-circuits to false when Source filter is active (identity wins)', () => {
    const state: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      source: sourceTableX.id,
      search: 'xyz_never_matches',
    }
    expect(isGroupHiddenBySearch(tableA.id, state, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, state, rows)).toBe(false)
  })

  it('considers VA, target_ack, and unmapped rows for target-field / table matches', () => {
    // "created_at" is a VA target field in tableA; "legacy_flag" is an
    // ack target field in tableB; "uncovered_field" is an unmapped target
    // field in tableA. These kinds have no sources, but their target
    // field name MUST still participate in search matching (rowMatchesSearch
    // contract — verified by the filterRows tests above).
    const vaState: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'created_at',
    }
    expect(isGroupHiddenBySearch(tableA.id, vaState, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, vaState, rows)).toBe(true)

    const ackState: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'legacy_flag',
    }
    expect(isGroupHiddenBySearch(tableA.id, ackState, rows)).toBe(true)
    expect(isGroupHiddenBySearch(tableB.id, ackState, rows)).toBe(false)

    const unmappedState: MappingFilterState = {
      ...DEFAULT_FILTER_STATE,
      search: 'uncovered_field',
    }
    expect(isGroupHiddenBySearch(tableA.id, unmappedState, rows)).toBe(false)
    expect(isGroupHiddenBySearch(tableB.id, unmappedState, rows)).toBe(true)
  })
})
