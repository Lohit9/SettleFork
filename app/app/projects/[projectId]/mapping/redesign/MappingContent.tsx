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
import { SourceSchemaSidebar } from './components/SourceSchemaSidebar'
import { useSidebarState, type SidebarState } from './components/useSidebarState'

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
  // Derive drawer-open status from the URL. `useSearchParams` is
  // reactive in the app router; the value re-flows here on every
  // `router.replace` from the body. Used by the auto-collapse effect
  // below (Gap 11a, founder decision 4 — at narrow viewport, sidebar
  // auto-collapses when the drawer opens).
  //
  // Phase 3 Gap 11a (2026-04-25): the drawer is now ALWAYS-overlay; we
  // no longer reflow the main content area when it opens. The
  // `isDrawerOpen` flag survives because the sidebar's auto-collapse
  // logic still depends on it.
  const searchParams = useSearchParams()
  const isDrawerOpen = !!(searchParams?.get('drawer') ?? '')

  // Source schema sidebar — Gap 11a. Persistence (collapsed/expanded
  // + filter selection) lives in `useSidebarState`; auto-collapse on
  // narrow viewports is overlaid below as ephemeral, non-persisted
  // state. Keep these two concerns separate so the persistence layer
  // never sees the temporary override.
  const {
    state: persistedSidebarState,
    filter: sidebarFilter,
    setSidebarState,
    setSidebarFilter,
  } = useSidebarState()

  // Track viewport width via matchMedia. Default to wide (true) before
  // the post-mount effect runs so the first paint matches the SSR
  // assumption (no layout flash). jsdom does not polyfill matchMedia;
  // tests inject a stub via `window.matchMedia = vi.fn(...)`.
  const [isWideViewport, setIsWideViewport] = useState(true)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia('(min-width: 1025px)')
    setIsWideViewport(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsWideViewport(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    // Legacy fallback (older Safari) — addListener/removeListener.
    // Wrap to satisfy the older signature.
    const legacyHandler = () => setIsWideViewport(mql.matches)
    mql.addListener(legacyHandler)
    return () => mql.removeListener(legacyHandler)
  }, [])

  // Ephemeral auto-collapse override. NOT persisted — only in memory
  // for the session. We track it as a derived "the drawer is open at
  // a narrow viewport, so override an expanded preference for now."
  // Read the persisted state through a ref inside the trigger effect
  // so we can fire the auto-collapse on (drawer-open, viewport-narrow)
  // transitions only — without re-firing every time the user manually
  // expands the sidebar during the same session.
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const persistedSidebarStateRef = useRef<SidebarState>(persistedSidebarState)
  useEffect(() => {
    persistedSidebarStateRef.current = persistedSidebarState
  }, [persistedSidebarState])

  // Trigger: drawer transitions to open OR viewport narrows. If the
  // user's persisted preference is 'expanded' AND the viewport is
  // narrow AND the drawer is open, auto-collapse the sidebar so the
  // drawer can claim primary focus. Founder decision 4.
  useEffect(() => {
    if (
      isDrawerOpen &&
      !isWideViewport &&
      persistedSidebarStateRef.current === 'expanded'
    ) {
      setAutoCollapsed(true)
    }
  }, [isDrawerOpen, isWideViewport])

  // Restore: drawer closes → clear the override. The sidebar snaps
  // back to the user's persisted state.
  useEffect(() => {
    if (!isDrawerOpen) setAutoCollapsed(false)
  }, [isDrawerOpen])

  // Restore: viewport widens above 1024px while drawer is still open
  // → clear the override. Founder decision 4 — "when viewport widens
  // back above 1024px with drawer open, sidebar respects persisted
  // state."
  useEffect(() => {
    if (isWideViewport) setAutoCollapsed(false)
  }, [isWideViewport])

  // Effective state shown in the UI = persisted state unless the
  // ephemeral override is active.
  const effectiveSidebarState: SidebarState = autoCollapsed
    ? 'collapsed'
    : persistedSidebarState

  // Wrap the persisted setter so a deliberate user click during an
  // auto-collapsed period clears the override (their action wins,
  // until the next narrow-viewport re-trigger).
  const handleSidebarStateChange = useCallback(
    (next: SidebarState) => {
      setAutoCollapsed(false)
      setSidebarState(next)
    },
    [setSidebarState],
  )

  // ── Phase 3 Gap 11b — sidebar click-to-highlight ──────────────────
  //
  // When the user clicks a source field row in the sidebar, every
  // main-view row that consumes that source gets a visual highlight.
  // Single-select: one source field at a time. Founder-locked
  // decisions (Gap 11b discussion 4-6 + additional concern):
  //   • State lives at the outer component because both the sidebar
  //     (active-row indicator) and the main view (row highlight)
  //     consume it.
  //   • The sourceField → consuming-rowIds map is derived client-side
  //     via `useMemo` over `data.rows` (decision 6) — no contract
  //     surface for `contributingTfmIds`.
  //   • A SIBLING click-outside listener (decision 4) clears the
  //     highlight when the user clicks anywhere outside the sidebar
  //     and outside a highlighted row. Separate from the drawer's
  //     existing click-outside listener so each can be tested in
  //     isolation.
  //   • Esc key clears the highlight (matches the drawer's Esc
  //     behavior — same key clears whichever ephemeral surface is
  //     active).
  //   • Drawer action complete (Approve/Reject) clears the highlight
  //     to prevent stale rowId references after a Reject deletes a
  //     TFM. Approve case is mild over-clearing; Reject case is
  //     necessary. See `MappingBody.handleDrawerActionComplete`.
  const [highlightedSourceFieldId, setHighlightedSourceFieldId] = useState<
    string | null
  >(null)

  const sourceFieldToRowIds = useMemo(
    () => buildSourceFieldToRowIds(initialRedesignData?.rows ?? []),
    [initialRedesignData?.rows],
  )

  const highlightedRowIds: Set<string> | null = useMemo(() => {
    if (highlightedSourceFieldId === null) return null
    return sourceFieldToRowIds.get(highlightedSourceFieldId) ?? new Set()
  }, [highlightedSourceFieldId, sourceFieldToRowIds])

  const clearHighlight = useCallback(() => {
    setHighlightedSourceFieldId(null)
  }, [])

  const handleSidebarFieldClick = useCallback(
    (fieldId: string) => {
      // Single-select toggle: clicking the active field clears it,
      // clicking a different field replaces.
      setHighlightedSourceFieldId((prev) => (prev === fieldId ? null : fieldId))
    },
    [],
  )

  // Sibling click-outside listener — clears the highlight when the
  // user mousedowns anywhere outside the sidebar and outside a
  // highlighted row. This is intentionally separate from the
  // drawer's own click-outside-to-close listener inside
  // `MappingDrawer`. Each listener has a single responsibility and a
  // single test surface.
  useEffect(() => {
    if (highlightedSourceFieldId === null) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target === null || !(target instanceof Element)) {
        clearHighlight()
        return
      }
      const insideSidebar = target.closest(
        '[data-testid="source-schema-sidebar"]',
      )
      if (insideSidebar) return
      const insideHighlightedRow = target.closest(
        '[data-highlighted-row="true"]',
      )
      if (insideHighlightedRow) return
      clearHighlight()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearHighlight()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [highlightedSourceFieldId, clearHighlight])

  return (
    <div className="flex h-full flex-col bg-gray-50">
      <PageHeader
        projectName={projectName}
        title="Mapping"
        projectInfo={projectInfo}
      />
      {/* Horizontal layout: source-schema sidebar (left) + main scroll
          container (right). The drawer mounts inside `MappingBody` and
          is `position: fixed` (anchored to the viewport, not its DOM
          parent), so it overlays the right portion regardless of where
          it lives in the tree. `min-h-0` is necessary — without it,
          flex children stretch indefinitely instead of letting the
          inner scroll container handle overflow. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SourceSchemaSidebar
          state={effectiveSidebarState}
          filter={sidebarFilter}
          onStateChange={handleSidebarStateChange}
          onFilterChange={setSidebarFilter}
          sourceFields={initialRedesignData?.sourceFields ?? []}
          highlightedSourceFieldId={highlightedSourceFieldId}
          onFieldClick={handleSidebarFieldClick}
        />
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-6">
            <WipBanner projectId={projectId} />
            {initialRedesignData === null ? (
              <NoDataState />
            ) : (
              <MappingBody
                projectId={projectId}
                data={initialRedesignData}
                highlightedRowIds={highlightedRowIds}
                onClearHighlight={clearHighlight}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Build a `Map<sourceFieldId, Set<rowId>>` over the canonical rows
 * array. Used by the sidebar click-to-highlight interaction (Gap 11b)
 * to find every main-view row that consumes a given source field.
 *
 * Only `MappedRow` rows contribute (other row kinds have no sources).
 * `value_assignment`, `target_acknowledged`, and `unmapped` rows are
 * silently skipped.
 *
 * Empty input → empty map (not null) so callers can treat the lookup
 * uniformly.
 */
function buildSourceFieldToRowIds(
  rows: MappingRow[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.kind !== 'mapped') continue
    for (const src of row.sources) {
      const sfId = src.sourceField.id
      const existing = out.get(sfId)
      if (existing) existing.add(row.id)
      else out.set(sfId, new Set([row.id]))
    }
  }
  return out
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
  highlightedRowIds,
  onClearHighlight,
}: {
  projectId: string
  data: MappingsForRedesignResult
  /**
   * Phase 3 Gap 11b — set of row ids the sidebar's click-to-highlight
   * interaction is currently illuminating. `null` means no highlight
   * is active. The set itself is never written to; callers re-derive
   * via `useMemo` whenever the source field selection changes.
   */
  highlightedRowIds: Set<string> | null
  /**
   * Clears the sidebar highlight. Invoked from
   * `handleDrawerActionComplete` so that an Approve/Reject does not
   * leave a stale rowId reference behind (Reject deletes the TFM
   * entirely, so the highlighted row identity dissolves).
   */
  onClearHighlight: () => void
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

  // Phase 3 Gap 9 — drawer action completion. Approve and Reject have
  // different post-action UX:
  //
  //   Approve: drawer STAYS OPEN with the new status. We just refresh
  //            server data so the parent re-renders with the canonical
  //            row.status. The drawer's local optimistic overlay
  //            self-clears once the fresh prop arrives.
  //   Reject:  drawer CLOSES and the URL clears `?drawer=`. The TFM is
  //            deleted on the server, so the row identity dissolves —
  //            keeping the drawer open would leave the user staring at
  //            stale data (or, worse, a Rule 6 unmapped pseudo-row
  //            synthesized client-side, which would diverge from the
  //            server's canonical assembly). Founder decisions 1 + 2
  //            in the Gap 9 alignment.
  //
  // `router.refresh()` re-fetches the server component's data without
  // navigating, so the page rerenders with fresh `MappingsForRedesignResult`.
  const handleDrawerActionComplete = useCallback(
    (action: 'approve' | 'reject', _rowId: string) => {
      // Phase 3 Gap 11b — clear the sidebar highlight after any
      // drawer action. Reject deletes the TFM (the highlighted row
      // identity dissolves on the server), so a stale highlight
      // would point at a row id that no longer exists. Approve
      // preserves identity but also clears the highlight — mild
      // over-clearing is acceptable per the founder's "additional
      // concern" decision in the Gap 11b alignment.
      onClearHighlight()
      router.refresh()
      if (action === 'reject') {
        setDrawerRowId(null)
        writeUrl(filters, null)
      }
    },
    [router, filters, writeUrl, onClearHighlight],
  )

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
        rejectedCount={data.counts.rejected}
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
                highlightedRowIds={highlightedRowIds}
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
        onActionComplete={handleDrawerActionComplete}
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
  // Phase 3 Gap 13 (2026-04-25): show the Unmapped chip only when the
  // count is non-zero — same gating convention as Rejected. Surfaces the
  // project-level aggregate count of target fields that have no TFM at
  // all, which was previously invisible despite being on the contract
  // (`counts.unmapped`). Per-row Rule 6 already shows each unmapped
  // field inline; this chip is the project-level scanning surface.
  if (counts.unmapped > 0) {
    chips.push({ label: 'Unmapped', value: counts.unmapped })
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
