import type {
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 3 — pure filter pipeline for the redesigned Mapping page.
// ─────────────────────────────────────────────────────────────────────────────
//
// Client-side filtering over `MappingsForRedesignResult.rows` per design §5
// (docs/features/phase-3-gap-4a-design.md). The server-computed MappingCounts
// are UNFILTERED project totals; any filter-aware "X of Y match" UI is
// derived from a pure transform of the canonical rows array — no server
// round-trip.
//
// Invariants:
//   • Input row order is preserved verbatim. No .sort(). The server owns
//     row ordering (design §4) and consumers MUST NOT re-sort.
//   • Filters combine with AND semantics.
//   • "all" is the pass-through sentinel for target / source / status.
//   • Search is case-insensitive substring (String.prototype.includes).
//     Leading/trailing whitespace is trimmed; whitespace-only input is
//     treated as empty.
//   • A specific Source filter keeps ONLY mapped rows that have at least
//     one mapping_source in the chosen source table. VA, target-ack, and
//     unmapped rows are excluded because they have no sources. (See the
//     Gap 3 test cases for regression coverage.)

/** Status filter options exposed in the filter row dropdown. */
export type MappingStatusFilter =
  | 'all'
  | 'needs_review'
  | 'approved'
  | 'rejected'

/** Shape of the active filter state, mirrored to/from URL params. */
export interface MappingFilterState {
  /** Target table id or 'all'. */
  target: string
  /** Source table id or 'all'. */
  source: string
  /** Status filter value; 'all' includes rejected (§9 Q6 resolution). */
  status: MappingStatusFilter
  /** Free-text search. Case-insensitive substring match. */
  search: string
}

/** Zero-filter state — all rows pass. */
export const DEFAULT_FILTER_STATE: MappingFilterState = {
  target: 'all',
  source: 'all',
  status: 'all',
  search: '',
}

/**
 * Apply all four filters to `rows`, preserving input order.
 *
 * O(n·k) where n = row count, k = average source count per row. For
 * Heritage-scale inputs (113 rows, 1-3 sources each), the pipeline runs
 * in well under 1ms — no memoization needed at the utility layer.
 */
export function filterRows(
  rows: readonly MappingRow[],
  filters: MappingFilterState,
): MappingRow[] {
  const search = filters.search.trim().toLowerCase()
  const hasSearch = search.length > 0
  const hasTargetFilter = filters.target !== 'all'
  const hasSourceFilter = filters.source !== 'all'
  const hasStatusFilter = filters.status !== 'all'

  if (!hasTargetFilter && !hasSourceFilter && !hasStatusFilter && !hasSearch) {
    // Fast path: no filters active. Return a defensive copy so callers
    // never get a readonly alias they can accidentally mutate.
    return rows.slice()
  }

  const out: MappingRow[] = []
  for (const row of rows) {
    if (hasTargetFilter && row.targetField.targetTable.id !== filters.target) {
      continue
    }
    if (hasSourceFilter && !rowReferencesSourceTable(row, filters.source)) {
      continue
    }
    if (hasStatusFilter && row.status !== filters.status) {
      continue
    }
    if (hasSearch && !rowMatchesSearch(row, search)) {
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * Row-level predicate for the Source filter. Only mapped rows can
 * match; VA / target_acknowledged / unmapped rows have no sources
 * and therefore are excluded whenever a specific source table is
 * selected.
 */
function rowReferencesSourceTable(row: MappingRow, sourceTableId: string): boolean {
  if (row.kind !== 'mapped') return false
  for (const source of row.sources) {
    if (source.sourceTable.id === sourceTableId) return true
  }
  return false
}

/**
 * Row-level predicate for the search filter. Matches against:
 *   • target field name
 *   • target table name
 *   • every mapping source's source field name (mapped rows only)
 *   • every mapping source's source table name (mapped rows only)
 *
 * `needle` is pre-trimmed and pre-lowercased by the caller. All
 * haystack values are lowercased at compare time.
 *
 * Exported so the group-visibility helper `isGroupHiddenBySearch`
 * (Amendment 3) can reuse the exact same matching surface — prevents
 * the filter pipeline and the group-visibility decision from drifting
 * out of sync on what counts as a "match."
 */
export function rowMatchesSearch(row: MappingRow, needle: string): boolean {
  if (row.targetField.name.toLowerCase().includes(needle)) return true
  if (row.targetField.targetTable.name.toLowerCase().includes(needle)) return true
  if (row.kind === 'mapped') {
    for (const source of row.sources) {
      if (source.sourceField.name.toLowerCase().includes(needle)) return true
      if (source.sourceTable.name.toLowerCase().includes(needle)) return true
    }
  }
  return false
}

// ─── Per-group count rollup ──────────────────────────────────────────────────

/**
 * Per-target-table counts for group-header "X of Y fields" indicators.
 *
 * The `total` is taken from `TargetTableSummary.fieldCount` — the
 * authoritative count of fields in the target table, regardless of
 * filter state. `matching` counts `filteredRows` grouped by target
 * table id. Tables absent from `filteredRows` still appear with
 * `matching: 0`.
 *
 * Callers can use the return value to choose between:
 *   • "19 fields"     when matching === total  (no filter narrowing)
 *   • "3 of 19 fields" when matching  <  total  (filters active)
 *   • "no fields match" when matching === 0    (group fully filtered)
 */
export function countFilteredPerTargetTable(
  filteredRows: readonly MappingRow[],
  targetTables: readonly TargetTableSummary[],
): Map<string, { total: number; matching: number }> {
  const matchingByTableId = new Map<string, number>()
  for (const row of filteredRows) {
    const tableId = row.targetField.targetTable.id
    matchingByTableId.set(tableId, (matchingByTableId.get(tableId) ?? 0) + 1)
  }

  const out = new Map<string, { total: number; matching: number }>()
  for (const table of targetTables) {
    out.set(table.id, {
      total: table.fieldCount,
      matching: matchingByTableId.get(table.id) ?? 0,
    })
  }
  return out
}

// ─── URL param parser ────────────────────────────────────────────────────────

/**
 * Parse a URL search-params bag into a filter state, defaulting any
 * missing/invalid values to `DEFAULT_FILTER_STATE`. Legacy params
 * (`fields`, `type`) are IGNORED — per founder decision (Gap 1,
 * 2026-04-21) the redesign hard-resets filter state on first load.
 *
 * Accepts both `URLSearchParams` and Next's `ReadonlyURLSearchParams`
 * via the minimal structural interface `{ get(key): string | null }`.
 */
export function parseFilterStateFromParams(params: {
  get(key: string): string | null
}): MappingFilterState {
  return {
    target: params.get('target') ?? 'all',
    source: params.get('source') ?? 'all',
    status: normalizeStatus(params.get('status')),
    search: params.get('q') ?? '',
  }
}

/**
 * Serialize a filter state into URL query-string form. Default values
 * are OMITTED so the URL stays clean (no `?target=all&source=all`
 * noise). Returns the bare query string WITHOUT a leading '?'.
 *
 * Empty result means "default state" — callers can emit a URL with
 * no query string at all.
 */
export function serializeFilterStateToQuery(state: MappingFilterState): string {
  const params = new URLSearchParams()
  if (state.target !== 'all') params.set('target', state.target)
  if (state.source !== 'all') params.set('source', state.source)
  if (state.status !== 'all') params.set('status', state.status)
  if (state.search.trim() !== '') params.set('q', state.search)
  return params.toString()
}

function normalizeStatus(raw: string | null): MappingStatusFilter {
  if (raw === 'needs_review' || raw === 'approved' || raw === 'rejected') {
    return raw
  }
  return 'all'
}

/** Convenience: is any filter non-default? */
export function hasActiveFilters(state: MappingFilterState): boolean {
  return (
    state.target !== 'all' ||
    state.source !== 'all' ||
    state.status !== 'all' ||
    state.search.trim() !== ''
  )
}

/**
 * Returns true when empty target-table groups should be HIDDEN rather
 * than rendered as empty-state headers, for the current filter state.
 *
 * Hide triggers (Gap 3 amendment + Amendment 3, 2026-04-21):
 *   • Target filter active (identity hide — non-matching groups)
 *   • Source filter active (identity hide — non-matching groups)
 *   • Search filter active (content hide — groups with zero matches)
 *
 * Status is deliberately EXCLUDED — it's a discrete 3-4-value axis, so
 * an empty group under Status is informative ("this project has no
 * needs-review fields in this group"). Status alone never hides groups.
 *
 * Search is INCLUDED (Amendment 3 change vs. original Amendment 1):
 * Search is free-text / infinite-cardinality, refined keystroke by
 * keystroke. Rendering 7 empty-state headers per keystroke is visual
 * noise on an interaction meant to feel fast.
 *
 * Callers combine this with the per-group predicates
 * `isGroupHiddenByIdentityFilters` and `isGroupHiddenBySearch` to
 * decide which groups to hide. Identity takes precedence over Search —
 * see `isGroupHiddenBySearch` JSDoc.
 *
 * This is a RENDERING decision only. The filter pipeline and
 * `countFilteredPerTargetTable` continue to emit counts for every
 * target table regardless.
 */
export function shouldHideEmptyGroups(state: MappingFilterState): boolean {
  return (
    state.target !== 'all' ||
    state.source !== 'all' ||
    state.search.trim() !== ''
  )
}

/**
 * Table-identity predicate used by the group-visibility decision.
 *
 * Returns true when the target-table group should be hidden from
 * rendering because it does NOT match the active Target/Source
 * identity. Important: this checks identity against the FULL rows
 * array (pre-status/pre-search), so a matching target group stays
 * visible even when Status or Search subsequently narrows its rows
 * to zero — in which case the group renders the filtered-empty state
 * within its own header.
 *
 * Identity rules:
 *   • Target filter active → hide any group whose id ≠ `state.target`.
 *   • Source filter active → hide any group whose target table has
 *     no row with a mapping_source from `state.source`. A target
 *     table's membership in the "source universe" is computed over
 *     the unfiltered rows array.
 *   • If both Target AND Source are active, BOTH conditions must
 *     pass for the group to be visible.
 *
 * Caller is responsible for gating by `shouldHideEmptyGroups`; this
 * function always runs the identity logic.
 */
export function isGroupHiddenByIdentityFilters(
  targetTableId: string,
  state: MappingFilterState,
  allRows: readonly MappingRow[],
): boolean {
  if (state.target !== 'all' && targetTableId !== state.target) {
    return true
  }
  if (state.source !== 'all') {
    const hasSourceMatch = allRows.some(
      (row) =>
        row.kind === 'mapped' &&
        row.targetField.targetTable.id === targetTableId &&
        row.sources.some((s) => s.sourceTable.id === state.source),
    )
    if (!hasSourceMatch) return true
  }
  return false
}

/**
 * Content-based predicate complementing `isGroupHiddenByIdentityFilters`
 * (Amendment 3, 2026-04-21). Returns true when the group should be
 * hidden because the active free-text Search finds zero matches in any
 * of its rows.
 *
 * Precedence rule: Target/Source identity filters OUTRANK search
 * hiding. When Target or Source is active, this predicate SHORT-
 * CIRCUITS to `false` — the caller's identity predicate has already
 * either (a) hidden non-matching groups, or (b) confirmed a group
 * matches identity, in which case the group must stay visible (showing
 * its own filtered-empty state inside) so the user keeps context.
 *
 *   Regression invariant: Target=X + Search="xyz_never_matches" keeps
 *   group X visible with filtered-empty state inside. Mirrors the
 *   Amendment 1 regression guard for Status.
 *
 * Matching uses the SAME `rowMatchesSearch` predicate as `filterRows`,
 * so the filter pipeline and visibility decision can never disagree on
 * what counts as a match.
 *
 * Callers SHOULD gate on `shouldHideEmptyGroups` first; this function
 * is cheap but wasteful to call when no hide-triggering filter is
 * active.
 */
export function isGroupHiddenBySearch(
  targetTableId: string,
  state: MappingFilterState,
  allRows: readonly MappingRow[],
): boolean {
  const needle = state.search.trim().toLowerCase()
  if (needle.length === 0) return false
  // Identity filters always win over Search hiding. See JSDoc.
  if (state.target !== 'all' || state.source !== 'all') return false
  for (const row of allRows) {
    if (row.targetField.targetTable.id !== targetTableId) continue
    if (rowMatchesSearch(row, needle)) return false
  }
  return true
}
