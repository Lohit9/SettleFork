import type {
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import type { FlatRow } from '@/lib/utils/flatten-rows-for-list-view'
import { classifyRowConfidence } from '@/lib/utils/confidence-format'

/**
 * Sentinel value for the source / target table filters selecting rows
 * that have NO mapping on that axis:
 *   • source axis → unmapped-target rows (no source attribution)
 *   • target axis → unmapped-source rows (no target field)
 * Distinct from a real table id and from the `'all'` pass-through.
 */
export const UNMAPPED_FILTER_VALUE = 'unmapped'

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

/**
 * Status filter options exposed in the filter row dropdown.
 *
 * 'rejected' was retired with Reject = reset (PR #157/#158): rejecting a
 * row returns it to needs_review, so no row produced by the app carries
 * status='rejected' anymore. Legacy status='rejected' rows still exist at
 * the `FlatRowStatus` level (heritage data) and render normally — they are
 * just not separately filterable; they surface under 'all'.
 */
export type MappingStatusFilter =
  | 'all'
  | 'needs_review'
  | 'approved'

/**
 * Confidence filter bands. The 'medium' band maps to the internal
 * `'amber'` band returned by `classifyRowConfidence` — see
 * `rowMatchesConfidenceBand` for the bridge. The user-facing
 * label and URL param both use 'medium'.
 *
 * Threshold reference (sourced from `confidence-format.ts`, single
 * source of truth — the dropdown labels in `FilterRow.tsx` derive
 * from those constants too, never literals):
 *
 *   • 'high'   ↔ classifyRowConfidence === 'high'   (≥CONFIDENCE_THRESHOLD_ROW_HIGH)
 *   • 'medium' ↔ classifyRowConfidence === 'amber'  (≥CONFIDENCE_THRESHOLD_ROW_AMBER, <CONFIDENCE_THRESHOLD_ROW_HIGH)
 *   • 'low'    ↔ classifyRowConfidence === 'low'    (<CONFIDENCE_THRESHOLD_ROW_AMBER)
 *
 * Null-confidence rows (Rule 5/6, most VAs) are EXCLUDED whenever a
 * non-'all' band is selected — they have no number to bucket. Status
 * and search filters compose orthogonally per the AND-semantics
 * contract above.
 */
export type MappingConfidenceFilter = 'all' | 'high' | 'medium' | 'low'

/** Shape of the active filter state, mirrored to/from URL params. */
export interface MappingFilterState {
  /** Target table id or 'all'. */
  target: string
  /** Source table id or 'all'. */
  source: string
  /** Status filter value. 'all' is the pass-through (shows every row,
   *  including legacy status='rejected' heritage rows). */
  status: MappingStatusFilter
  /**
   * Confidence-band filter (Phase 4-polish-1 comprehensive pass).
   * Applies to TFM-level confidence via `classifyRowConfidence`.
   */
  confidence: MappingConfidenceFilter
  /** Free-text search. Case-insensitive substring match. */
  search: string
}

/** Zero-filter state — all rows pass. */
export const DEFAULT_FILTER_STATE: MappingFilterState = {
  target: 'all',
  source: 'all',
  status: 'all',
  confidence: 'all',
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
  const hasConfidenceFilter = filters.confidence !== 'all'

  if (
    !hasTargetFilter &&
    !hasSourceFilter &&
    !hasStatusFilter &&
    !hasConfidenceFilter &&
    !hasSearch
  ) {
    // Fast path: no filters active. Return a defensive copy so callers
    // never get a readonly alias they can accidentally mutate.
    return rows.slice()
  }

  const out: MappingRow[] = []
  for (const row of rows) {
    if (hasTargetFilter) {
      // The target axis's `'unmapped'` value selects source-side flat
      // rows, which this `MappingRow[]` pipeline never carries — every
      // MappingRow has a target field, so 'unmapped' excludes all of
      // them. Specific table ids match on `targetTable.id`.
      if (filters.target === UNMAPPED_FILTER_VALUE) continue
      if (row.targetField.targetTable.id !== filters.target) continue
    }
    if (hasSourceFilter && !rowReferencesSourceTable(row, filters.source)) {
      continue
    }
    if (hasStatusFilter && row.status !== filters.status) {
      continue
    }
    if (
      hasConfidenceFilter &&
      !rowMatchesConfidenceBand(row, filters.confidence)
    ) {
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
 * Row-level predicate for the Confidence filter (Phase 4-polish-1
 * comprehensive pass). Maps the user-facing band ('high'/'medium'/'low')
 * onto `classifyRowConfidence`'s internal classification ('high'/
 * 'amber'/'low'). 'medium' is the user-facing softening of the internal
 * 'amber' label.
 *
 * Null-confidence rows (Rule 5/6, most VAs) are EXCLUDED whenever a
 * non-'all' band is selected — they have no number to bucket, and
 * "show me low-confidence rows" should not surprise the user with rows
 * that have no confidence at all.
 */
function rowMatchesConfidenceBand(
  row: { confidence: number | null },
  band: MappingConfidenceFilter,
): boolean {
  if (band === 'all') return true
  if (row.confidence === null) return false
  const classified = classifyRowConfidence(row.confidence)
  if (band === 'high') return classified === 'high'
  if (band === 'medium') return classified === 'amber'
  return classified === 'low'
}

/**
 * Row-level predicate for the Source filter.
 *
 *   • `'unmapped'` → rows with no source attribution. In the
 *     `MappingRow[]` universe that is exactly the unmapped-target rows
 *     (`kind === 'unmapped'`); mapped + value_assignment are excluded.
 *   • a table id → only mapped rows can match (they carry sources);
 *     VA / unmapped rows have no sources and are excluded.
 */
function rowReferencesSourceTable(row: MappingRow, sourceTableId: string): boolean {
  if (sourceTableId === UNMAPPED_FILTER_VALUE) return row.kind === 'unmapped'
  if (row.kind !== 'mapped') return false
  for (const source of row.sources) {
    if (source.sourceTable.id === sourceTableId) return true
  }
  return false
}

// ─── Flat-row filter pipeline (feat/mapping-filter-bugs-ordering) ────────────
//
// ⚠️ ARCHITECTURAL RULE — operate on the flat projection, not the wire.
//
// `flattenRowsForListView` is the CANONICAL four-kind row projection
// (mapped / value-assignment / unmapped-target / unmapped-source). The
// `unmapped-source` rows exist ONLY in that projection — they are
// synthesised client-side from `sourceFields` / acks and never appear in
// the wire `MappingRow[]`. Therefore ANY row-aware operation — filtering,
// counting, status aggregation, etc. — MUST run against the flattened
// `FlatRow[]`, never the raw `MappingRow[]`, or it will silently skip the
// source-side rows.
//
// This is the SECOND instance of that gap: the first was the summary-
// strip counter bug (PR #151), this is the filter bug. `filterRows`
// (above) operates on `MappingRow[]` and is kept ONLY for the target-led
// view, which has no source-side rows. `filterFlatRows` is the correct
// surface for the flat list view. Reach for the flat projection first;
// don't let a third instance land.
//
// Per-axis coverage:
//   • target table id → mapped / value-assignment / unmapped-target
//     match on `targetField.targetTable.id`; unmapped-source excluded.
//   • target 'unmapped' → only unmapped-source rows (no target field).
//   • source table id → mapped matches on any `sources[].sourceTable.id`;
//     unmapped-source matches on `sourceField.sourceTable.id`; VA +
//     unmapped-target excluded.
//   • source 'unmapped' → only unmapped-target rows (no source).
//   • status / confidence / search → uniform across all four kinds.

function flatRowMatchesTarget(row: FlatRow, target: string): boolean {
  if (target === UNMAPPED_FILTER_VALUE) return row.kind === 'unmapped-source'
  if (row.kind === 'unmapped-source') return false
  return row.targetField.targetTable.id === target
}

function flatRowMatchesSource(row: FlatRow, source: string): boolean {
  if (source === UNMAPPED_FILTER_VALUE) return row.kind === 'unmapped-target'
  if (row.kind === 'mapped') {
    return row.sources.some((s) => s.sourceTable.id === source)
  }
  if (row.kind === 'unmapped-source') {
    return row.sourceField.sourceTable.id === source
  }
  return false
}

function flatRowMatchesSearch(row: FlatRow, needle: string): boolean {
  if (row.kind === 'unmapped-source') {
    return (
      row.sourceField.name.toLowerCase().includes(needle) ||
      row.sourceField.sourceTable.name.toLowerCase().includes(needle)
    )
  }
  if (row.targetField.name.toLowerCase().includes(needle)) return true
  if (row.targetField.targetTable.name.toLowerCase().includes(needle)) {
    return true
  }
  if (row.kind === 'mapped') {
    for (const source of row.sources) {
      if (source.sourceField.name.toLowerCase().includes(needle)) return true
      if (source.sourceTable.name.toLowerCase().includes(needle)) return true
    }
  }
  return false
}

/**
 * Apply all filters to a flat-row projection, preserving input order.
 * Mirrors `filterRows`'s AND-semantics + `'all'` pass-through contract.
 *
 * PR Ω.3.2.2 — accepts an optional `selectedPartitionIds` set so the
 * flat view can scope rows to the user's chosen partitions (mirrors
 * Target-led's `partitionFilteredRows` in MappingContent.tsx). Empty
 * set / omitted = no partition filter, same array reference returned
 * for heritage projects (memo identity preserved).
 */
export function filterFlatRows(
  rows: readonly FlatRow[],
  filters: MappingFilterState,
  selectedPartitionIds?: ReadonlySet<string>,
): FlatRow[] {
  const search = filters.search.trim().toLowerCase()
  const hasSearch = search.length > 0
  const hasTargetFilter = filters.target !== 'all'
  const hasSourceFilter = filters.source !== 'all'
  const hasStatusFilter = filters.status !== 'all'
  const hasConfidenceFilter = filters.confidence !== 'all'
  const hasPartitionFilter =
    selectedPartitionIds !== undefined && selectedPartitionIds.size > 0

  if (
    !hasTargetFilter &&
    !hasSourceFilter &&
    !hasStatusFilter &&
    !hasConfidenceFilter &&
    !hasSearch &&
    !hasPartitionFilter
  ) {
    return rows.slice()
  }

  const out: FlatRow[] = []
  for (const row of rows) {
    if (hasTargetFilter && !flatRowMatchesTarget(row, filters.target)) {
      continue
    }
    if (hasSourceFilter && !flatRowMatchesSource(row, filters.source)) {
      continue
    }
    if (hasStatusFilter && row.status !== filters.status) continue
    if (
      hasConfidenceFilter &&
      !rowMatchesConfidenceBand(row, filters.confidence)
    ) {
      continue
    }
    if (hasSearch && !flatRowMatchesSearch(row, search)) continue
    if (hasPartitionFilter && !flatRowMatchesPartition(row, selectedPartitionIds!)) {
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * PR Ω.3.2.2 — partition predicate for the flat view chip.
 *
 * Three pass-through cases:
 *   1. `unmapped-source` rows have no `parentRow` and no partition
 *      affiliation — their existence is project-scoped, not
 *      partition-scoped (a source field is unmapped or it isn't,
 *      regardless of which target_table partitions exist).
 *   2. Rows missing `tableMappingId` (pre-Ω.1 defensive — every prod
 *      row carries one today, but the type allows null).
 *   3. Caller responsibility — when `selected.size === 0`, skip
 *      calling this predicate entirely (handled by the outer
 *      `hasPartitionFilter` gate).
 */
export function flatRowMatchesPartition(
  row: FlatRow,
  selected: ReadonlySet<string>,
): boolean {
  if (row.kind === 'unmapped-source') return true
  const parentTmId = row.parentRow.tableMappingId ?? null
  if (parentTmId === null) return true
  return selected.has(parentTmId)
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
    confidence: normalizeConfidence(params.get('confidence')),
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
  if (state.confidence !== 'all') params.set('confidence', state.confidence)
  if (state.search.trim() !== '') params.set('q', state.search)
  return params.toString()
}

function normalizeStatus(raw: string | null): MappingStatusFilter {
  if (raw === 'needs_review' || raw === 'approved') {
    return raw
  }
  // Legacy '?status=rejected' bookmarks fall back to 'all' — the
  // Rejected filter option was retired with Reject = reset (PR #157/#158).
  return 'all'
}

function normalizeConfidence(raw: string | null): MappingConfidenceFilter {
  if (raw === 'high' || raw === 'medium' || raw === 'low') {
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
    state.confidence !== 'all' ||
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
    // Covers a real table id AND the `'unmapped'` sentinel — no target
    // group's id is ever `'unmapped'`, so that value hides every group.
    return true
  }
  if (state.source === UNMAPPED_FILTER_VALUE) {
    // Source `'unmapped'` selects unmapped-target rows; a group stays
    // visible only when it contains one.
    const hasUnmappedTarget = allRows.some(
      (row) =>
        row.kind === 'unmapped' &&
        row.targetField.targetTable.id === targetTableId,
    )
    if (!hasUnmappedTarget) return true
  } else if (state.source !== 'all') {
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
