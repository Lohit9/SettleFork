'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3 canonical home.
// ─────────────────────────────────────────────────────────────────────────────
//
// This directory is the single, canonical location for Phase 3 UI work on the
// Mapping page. All new components, hooks, and styles for the redesigned UI
// live here (or in colocated subfolders). The legacy UI at
// `../MappingContent.tsx` remains frozen except for the feature-flag dispatch
// gate at the top of its default export — see Gap 1 in
// `docs/features/mapping-redesign.md`.
//
// URL FILTER PARAM SCHEME (Phase 3, Gap 3)
//
//   The redesign uses a fresh, minimal filter param vocabulary:
//
//     ?target=<table-id>       — scope to a single target table
//     ?source=<table-id>       — scope to a single source table
//     ?status=<value>          — status filter (needs_review | approved | rejected;
//                                "all" is the default and is OMITTED from the URL)
//     ?q=<search>              — free-text field-name search
//
//   Back-compat note (founder decision, out-of-band, 2026-04-21): the legacy
//   params `?fields=<ids>` and `?type=<mapping-type>` are NOT translated into
//   the new scheme. The redesign hard-resets filter state on first load; no
//   shim, no migration layer. Users who bookmarked legacy URLs will land on
//   the default (unfiltered) view. This keeps the new state machine clean and
//   avoids permanent coupling to the legacy filter vocabulary.
//
// CURRENT STATE (Gap 3)
//
//   Filter row (3 dropdowns + search), URL sync, filter pipeline over the
//   canonical rows array, per-group "X of Y match" indicators. Filter
//   application is instant; the URL write for the search param is debounced
//   by 200ms to avoid navigation storms. Other filter changes (dropdowns,
//   clear-all) write the URL immediately.
//
//   NOT YET SHIPPED: row content (Rules 1-6, Gap 5), row chevron/expansion
//   (Gap 5+6), drawer (Gaps 7-10). Rows remain the Gap 4c minimal render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { cn } from '@/components/ui/utils'
import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type {
  MappingRow,
  MappingsForRedesignResult,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import {
  countFilteredPerTargetTable,
  DEFAULT_FILTER_STATE,
  filterRows,
  isGroupHiddenByIdentityFilters,
  isGroupHiddenBySearch,
  type MappingFilterState,
  parseFilterStateFromParams,
  serializeFilterStateToQuery,
  shouldHideEmptyGroups,
} from '@/lib/utils/mapping-filters'
import { FilterRow } from './components/FilterRow'
import { TargetTableGroup } from './components/TargetTableGroup'
import { MappingDrawer } from './components/MappingDrawer'

const SEARCH_DEBOUNCE_MS = 200

interface Props {
  projectId: string
  projectName: string
  projectInfo?: ProjectInfo
  /**
   * Data feed for the redesigned Mapping page. Null only when
   * `page.tsx` was unable to fetch (unauth or project missing), in
   * which case the UI renders an inline error state. Populated on
   * all happy-path renders under the `use_mapping_redesign` flag.
   */
  initialRedesignData: MappingsForRedesignResult | null
}

export default function MappingRedesignContent({
  projectId,
  projectName,
  projectInfo,
  initialRedesignData,
}: Props) {
  // Phase 3 Gap 7 — derive drawer-open status from the URL so the layout
  // wrapper can shift right-padding without lifting drawer state out of
  // `MappingBody`. `useSearchParams` is reactive in the app router; the
  // value re-flows here on every `router.replace` from the body.
  const searchParams = useSearchParams()
  const isDrawerOpen = !!(searchParams?.get('drawer') ?? '')

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <PageHeader
        projectName={projectName}
        title="Mapping"
        projectInfo={projectInfo}
      />
      <div
        className={cn(
          'flex-1 overflow-auto transition-[padding] duration-150 ease-out motion-reduce:transition-none',
          // Reserve drawer width on viewports wide enough that doing so
          // does not collapse the content area to a too-narrow column.
          // Below that threshold the drawer sits over content (still
          // legible because the drawer is opaque white with shadow).
          isDrawerOpen && 'xl:pr-[520px]',
        )}
      >
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <WipBanner projectId={projectId} />
          {initialRedesignData === null ? (
            <NoDataState />
          ) : (
            <MappingBody projectId={projectId} data={initialRedesignData} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── WIP banner ──────────────────────────────────────────────────────────────

function WipBanner({ projectId }: { projectId: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mapping-redesign-placeholder"
      className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
    >
      <span className="font-semibold">Mapping redesign — Phase 3 in progress.</span>{' '}
      You are viewing the experimental redesigned Mapping UI behind the{' '}
      <code className="rounded bg-amber-100 px-1 py-0.5">use_mapping_redesign</code>{' '}
      feature flag. Project <span className="font-mono">{projectId}</span>.
    </div>
  )
}

// ─── Body ────────────────────────────────────────────────────────────────────

function MappingBody({
  projectId,
  data,
}: {
  projectId: string
  data: MappingsForRedesignResult
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Seed filter state ONCE from the URL. Subsequent URL changes come from
  // user input via our own writers; we don't round-trip through router →
  // searchParams → state (which would cause focus/selection loss inside
  // the search input on every keystroke).
  const [filters, setFilters] = useState<MappingFilterState>(() =>
    parseFilterStateFromParams(
      searchParams ?? new URLSearchParams(),
    ),
  )

  // Phase 3 Gap 7 — drawer state. Seeded from `?drawer=<rowId>` on
  // mount; mutated by row clicks + close button + filter-out auto-close.
  // The row id can be a bare TFM UUID OR the `unmapped::<uuid>` sentinel
  // (founder Q4 — verbatim row.id in URL). The current row is looked up
  // by linear scan; row counts are bounded (<300 in practice), so the
  // ergonomic clarity of one source of truth (`drawerRowId`) outweighs a
  // memoised id→row map.
  const [drawerRowId, setDrawerRowId] = useState<string | null>(() => {
    const initial = (searchParams ?? new URLSearchParams()).get('drawer')
    return initial && initial.length > 0 ? initial : null
  })

  // Debounce only the search-param URL write. Other filters write
  // immediately because they cause a single state change per interaction.
  const pendingSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const writeUrl = useCallback(
    (next: MappingFilterState, nextDrawerRowId: string | null) => {
      // Pattern U1 (single source of truth): one writer composes the
      // filter query string and the drawer param together. This keeps
      // filter writes from clobbering the drawer param and vice versa.
      const filterQs = serializeFilterStateToQuery(next)
      const params = new URLSearchParams(filterQs)
      if (nextDrawerRowId !== null) {
        params.set('drawer', nextDrawerRowId)
      }
      const qs = params.toString()
      router.replace(
        `/app/projects/${projectId}/mapping${qs ? `?${qs}` : ''}`,
        { scroll: false },
      )
    },
    [router, projectId],
  )

  const handleFiltersChange = useCallback(
    (next: MappingFilterState) => {
      setFilters((prev) => {
        if (pendingSearchTimer.current) {
          clearTimeout(pendingSearchTimer.current)
          pendingSearchTimer.current = null
        }
        // Only the search string uses debounced URL writes — typing
        // causes many updates per second. Dropdown changes (and clear-
        // all) should feel instant in the URL bar.
        if (
          next.target === prev.target &&
          next.source === prev.source &&
          next.status === prev.status &&
          next.search !== prev.search
        ) {
          pendingSearchTimer.current = setTimeout(() => {
            pendingSearchTimer.current = null
            writeUrl(next, drawerRowId)
          }, SEARCH_DEBOUNCE_MS)
        } else {
          writeUrl(next, drawerRowId)
        }
        return next
      })
    },
    [writeUrl, drawerRowId],
  )

  const handleRowClick = useCallback(
    (rowId: string) => {
      setDrawerRowId(rowId)
      writeUrl(filters, rowId)
    },
    [writeUrl, filters],
  )

  const handleDrawerClose = useCallback(() => {
    setDrawerRowId(null)
    writeUrl(filters, null)
  }, [writeUrl, filters])

  useEffect(() => {
    return () => {
      if (pendingSearchTimer.current) {
        clearTimeout(pendingSearchTimer.current)
        pendingSearchTimer.current = null
      }
    }
  }, [])

  // Filter pipeline is instantaneous — the server already loaded every
  // row, so filtering is a pure in-memory pass. No debounce here even
  // when the user is typing.
  const filteredRows = useMemo(
    () => filterRows(data.rows, filters),
    [data.rows, filters],
  )

  // Phase 3 Gap 7 — derive the open drawer row from `drawerRowId`. We
  // require the row to be present in `filteredRows` (not just `data.rows`)
  // so the founder rule "filter that hides the open row closes the drawer"
  // is enforced as a single derivation rather than a side-effecting
  // `useEffect`. `useMemo` keeps the lookup cheap; an actual auto-close
  // (URL clean-up + state reset) fires from a sibling `useEffect` below.
  const drawerRow = useMemo<MappingRow | null>(() => {
    if (drawerRowId === null) return null
    return filteredRows.find((r) => r.id === drawerRowId) ?? null
  }, [drawerRowId, filteredRows])

  // Phase 3 Gap 7 — auto-close + URL clean-up when the open drawer row
  // is no longer reachable. Two trigger paths:
  //   1. Filter change hides the row (e.g. Search "xyz_never_matches")
  //   2. Stale URL on mount (`?drawer=<id>` for an id absent from data)
  // Both flow through this effect so the URL stays consistent with
  // visible state at all times.
  useEffect(() => {
    if (drawerRowId !== null && drawerRow === null) {
      setDrawerRowId(null)
      writeUrl(filters, null)
    }
  }, [drawerRowId, drawerRow, filters, writeUrl])

  /**
   * Group filtered rows by target-table id WHILE preserving server order.
   * We rely on Map insertion order (the server emits rows sorted by
   * targetTable.name ASC + ordinalPosition ASC), so the Map's native
   * iteration yields groups in canonical order too.
   *
   * CONTRACT: NO client-side sort anywhere in this module. The no-client-
   * sort guard test (tests/lib/no-shim-in-redesign-path.test.ts) will
   * fail if anyone adds `.sort(` to this path.
   */
  const groupedRows = useMemo(
    () => groupRowsByTargetTable(filteredRows),
    [filteredRows],
  )

  const tablesById = useMemo(() => {
    const m = new Map<string, TargetTableSummary>()
    for (const t of data.targetTables) m.set(t.id, t)
    return m
  }, [data.targetTables])

  const perGroupCounts = useMemo(
    () => countFilteredPerTargetTable(filteredRows, data.targetTables),
    [filteredRows, data.targetTables],
  )

  const isDefaultState = isDefaultFilterState(filters)
  /**
   * Group-visibility decision (Gap 3 amendment + Amendment 3,
   * 2026-04-21). Two hide vectors, combined with OR:
   *
   *   1. IDENTITY hide (`isGroupHiddenByIdentityFilters`) —
   *      Target/Source filter is active and this group does not match
   *      the selected table identity. Identity membership is computed
   *      against the UNFILTERED rows array so a Target/Source-matching
   *      group STAYS VISIBLE even when Status or Search subsequently
   *      narrows its rows to zero (the group then renders its own
   *      filtered-empty state inside the header). This preserves the
   *      identity-confirmed context the user explicitly asked for.
   *
   *   2. SEARCH hide (`isGroupHiddenBySearch`) — Search is active AND
   *      no row in this group matches the query. Applies ONLY when
   *      neither Target nor Source identity is active (the predicate
   *      itself enforces that precedence). Search is free-text /
   *      infinite-cardinality; rendering N empty-state headers per
   *      keystroke is noise on an interaction meant to feel fast.
   *
   * Status alone never hides groups — it's a 3-4-value axis where an
   * empty group is informative ("this project has zero needs-review
   * fields here") rather than noise.
   */
  const hideEmpty = shouldHideEmptyGroups(filters)

  const visibleTargetTables = useMemo(() => {
    if (!hideEmpty) return data.targetTables
    return data.targetTables.filter(
      (summary) =>
        !isGroupHiddenByIdentityFilters(summary.id, filters, data.rows) &&
        !isGroupHiddenBySearch(summary.id, filters, data.rows),
    )
  }, [hideEmpty, data.targetTables, data.rows, filters])

  return (
    <>
      <CountersRow counts={data.counts} />

      <FilterRow
        filters={filters}
        onFiltersChange={handleFiltersChange}
        targetTables={data.targetTables}
        sourceTables={data.sourceTables}
        tableCount={data.targetTables.length}
      />

      {data.targetSchemaEmpty ? (
        <EmptySchemaState />
      ) : data.targetTables.length === 0 ? (
        <EmptyFieldsState />
      ) : visibleTargetTables.length === 0 ? (
        <NoGroupsMatchState />
      ) : (
        <div className="flex flex-col gap-4">
          {visibleTargetTables.map((summary) => {
            const rowsInGroup = groupedRows.get(summary.id) ?? []
            const perGroup = perGroupCounts.get(summary.id)
            return (
              <TargetTableGroup
                key={summary.id}
                targetTable={summary}
                rows={rowsInGroup}
                filteredCount={isDefaultState ? undefined : perGroup}
                onRowClick={handleRowClick}
                openRowId={drawerRowId}
              />
            )
          })}
        </div>
      )}

      {/*
        Phase 3 Gap 7 — drawer host. Position-fixed; no backdrop. The
        click-outside-closes contract is implemented in the parent
        scroll-container wrapper (see `MappingRedesignContent`) so this
        component does not have to know about its DOM neighbourhood.
      */}
      <MappingDrawer
        row={drawerRow}
        isOpen={drawerRow !== null}
        onClose={handleDrawerClose}
      />
    </>
  )
}

// ─── Counters row ────────────────────────────────────────────────────────────
// Inline pipe-separated stats, matching the spec mockup (line 646) and the
// existing pattern in components/app/ProjectsList.tsx. Values are always
// unfiltered project totals (per design §5.3); filter-aware "X of Y" lives
// at the per-group header via TargetTableGroup's `filteredCount` prop.

function CountersRow({
  counts,
}: {
  counts: MappingsForRedesignResult['counts']
}) {
  const chips: { label: string; value: number }[] = [
    { label: 'Total', value: counts.total },
    { label: 'Approved', value: counts.approved },
    { label: 'Needs Review', value: counts.needsReview },
  ]
  // §9 Q6 (2026-04-22): show the Rejected chip only when the count is non-zero.
  if (counts.rejected > 0) {
    chips.push({ label: 'Rejected', value: counts.rejected })
  }

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500"
      data-testid="mapping-redesign-counters"
    >
      {chips.map((chip, i) => (
        <span key={chip.label} className="flex items-center gap-3">
          {i > 0 ? <span aria-hidden="true" className="text-gray-300">·</span> : null}
          <span>
            <span className="font-medium text-gray-700">{chip.label}</span>{' '}
            <span className="tabular-nums">{chip.value}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

// ─── Empty / error states ────────────────────────────────────────────────────

function NoDataState() {
  return (
    <div
      data-testid="mapping-redesign-no-data"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      Unable to load mapping data. The project may be unavailable or you may
      not have access — try refreshing or returning to the project list.
    </div>
  )
}

function EmptySchemaState() {
  return (
    <div
      data-testid="mapping-redesign-empty-schema"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      No target schema has been defined yet for this project. Once target
      tables are added, their fields will appear here for mapping.
    </div>
  )
}

function EmptyFieldsState() {
  return (
    <div
      data-testid="mapping-redesign-empty-fields"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      No fields to display.
    </div>
  )
}

/**
 * Shown when every group is emptied by the active filter — either no
 * target table contains any row matching the selected Target/Source
 * identity, or Search finds zero matches across every group (Amendment
 * 3). Without this state, the user would see a blank canvas with no
 * context.
 */
function NoGroupsMatchState() {
  return (
    <div
      data-testid="mapping-redesign-no-groups-match"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      No tables match the current filters. Try broadening your search,
      widening the Target or Source dropdown, or clearing the filters.
    </div>
  )
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Group server-sorted rows by target-table id. Returns a Map so iteration
 * order matches the rows' arrival order (canonical server order).
 */
function groupRowsByTargetTable(rows: MappingRow[]): Map<string, MappingRow[]> {
  const out = new Map<string, MappingRow[]>()
  for (const row of rows) {
    const tableId = row.targetField.targetTable.id
    const existing = out.get(tableId)
    if (existing) existing.push(row)
    else out.set(tableId, [row])
  }
  return out
}

function isDefaultFilterState(state: MappingFilterState): boolean {
  return (
    state.target === DEFAULT_FILTER_STATE.target &&
    state.source === DEFAULT_FILTER_STATE.source &&
    state.status === DEFAULT_FILTER_STATE.status &&
    state.search === DEFAULT_FILTER_STATE.search
  )
}
