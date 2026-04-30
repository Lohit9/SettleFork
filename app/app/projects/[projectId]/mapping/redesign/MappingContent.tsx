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
import { MappingSummaryStrip } from './components/MappingSummaryStrip'
import { SourceSchemaSidebar } from './components/SourceSchemaSidebar'
import { RejectConfirmPopover } from './components/RejectConfirmPopover'
import {
  EmptyMappingState,
  selectEmptyMappingCase,
} from './components/EmptyMappingState'
import type { FieldMappingRowOptimisticState } from './components/FieldMappingRow'
import {
  useSidebarState,
  type SidebarFilter,
  type SidebarState,
} from './components/useSidebarState'
import type { CreateMappingFormSnapshot } from './components/CreateMappingForm'
import {
  BulkConfirmDialog,
  type BulkPreviewRow,
} from './components/BulkConfirmDialog'
import {
  approveFieldMapping,
  bulkApproveFieldMappingsForTargetTable,
  approveHighConfidenceMappings,
  createFieldMapping,
  editMappingSources,
  previewBulkApprove,
  bulkRejectFieldMappingsForTargetTable,
  previewBulkReject,
  rejectFieldMapping,
  type CreateFieldMappingCombinationType,
} from '@/lib/actions/mappings-for-redesign'
import { acknowledgeField } from '@/lib/actions/field-acknowledgments'
import { ToastProvider, useToast } from '@/lib/contexts/ToastContext'
import { CONFIDENCE_THRESHOLD_ROW_HIGH } from '@/lib/utils/confidence-format'
import { useCollapsedGroups } from '@/lib/hooks/useCollapsedGroups'

// Phase 4c-1 — high-confidence threshold (mirrors legacy default).
// Lives here so the FilterRow contextual link copy, the new Confidence
// filter dropdown's "High (≥85)" label, and the wrapper's threshold
// argument never drift (the wrapper accepts `threshold` and defaults
// to 85; this constant is the canonical client-side reflection).
//
// Phase 4-polish-1 comprehensive pass: this re-exports
// `CONFIDENCE_THRESHOLD_ROW_HIGH` from `confidence-format.ts` so the
// row-display band classifier and the bulk-approve gate use the same
// numeric value. Previously a private 85 lived here in parallel.
const HIGH_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD_ROW_HIGH

const SEARCH_DEBOUNCE_MS = 200

interface Props {
  projectId: string
  projectName: string
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
  //     necessary. See `MappingContentLoaded.handleDrawerActionComplete`.
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

  // Phase 4-polish-1 sidebar architecture refactor (2026-04-26):
  // `<MappingSummaryStrip>` and `<FilterRow>` are now PAGE-LEVEL
  // siblings of `<PageHeader>`, sitting ABOVE the sidebar+body flex
  // row. Previously they lived inside the body's scroll container,
  // which caused horizontal squish whenever the sidebar expanded
  // from 28px to 200px (the toolbar shared the same horizontal
  // space as the group cards). The structural fix elevates them
  // to the page-level toolbar so they read as semantically
  // equivalent to the page header — full-width, never covered by
  // the sidebar, never scrolled.
  //
  // `<ToastProvider>` wraps the entire flex column so any descendant
  // (including the page-level FilterRow's bulk-approve handler) can
  // call `useToast`. `<ToastContainer>` (a sibling of the flex
  // column inside the provider) is `position: fixed` and does not
  // affect flex layout.
  return (
    <ToastProvider>
      <div className="flex h-full flex-col bg-gray-50">
        <PageHeader
          projectName={projectName}
          title="Mapping"
          projectId={projectId}
        />
        {initialRedesignData === null ? (
          // Empty / error path — sidebar is rendered but inert; the
          // body shows a single inline error card.
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <SourceSchemaSidebar
              state={effectiveSidebarState}
              filter={sidebarFilter}
              onStateChange={handleSidebarStateChange}
              onFilterChange={setSidebarFilter}
              sourceFields={[]}
              highlightedSourceFieldId={highlightedSourceFieldId}
              onFieldClick={handleSidebarFieldClick}
            />
            <div className="flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-5xl px-6 py-6">
                <NoDataState />
              </div>
            </div>
          </div>
        ) : (
          // Loaded path — `MappingContentLoaded` returns a Fragment
          // whose children flow as direct siblings of `<PageHeader>`
          // under the outer flex column. The first three Fragment
          // children are the page-level toolbar (Strip + FilterRow)
          // followed by the sidebar+body flex row; trailing
          // children are the position-fixed drawer + bulk dialog
          // (no flex impact).
          <MappingContentLoaded
            projectId={projectId}
            data={initialRedesignData}
            sidebarState={effectiveSidebarState}
            sidebarFilter={sidebarFilter}
            onSidebarStateChange={handleSidebarStateChange}
            onSidebarFilterChange={setSidebarFilter}
            highlightedSourceFieldId={highlightedSourceFieldId}
            onSidebarFieldClick={handleSidebarFieldClick}
            highlightedRowIds={highlightedRowIds}
            onClearHighlight={clearHighlight}
          />
        )}
      </div>
    </ToastProvider>
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

// ─── Body ────────────────────────────────────────────────────────────────────
// (Phase 4-polish-1 founder Q2.1: WipBanner dropped entirely. The
// experimental "Mapping redesign — Phase 3 in progress" amber banner
// lived here from Phase 3 forward; with Phase 4c shipped on Heritage the
// banner has nothing useful to communicate. Removed without replacement.)
//

function MappingContentLoaded({
  projectId,
  data,
  sidebarState,
  sidebarFilter,
  onSidebarStateChange,
  onSidebarFilterChange,
  highlightedSourceFieldId,
  onSidebarFieldClick,
  highlightedRowIds,
  onClearHighlight,
}: {
  projectId: string
  data: MappingsForRedesignResult
  /**
   * Sidebar shell props — owned by `MappingRedesignContent` (the
   * outer entry component) so the sidebar persists its state across
   * loaded/empty data transitions. We accept them as a flat prop
   * surface here rather than a nested object so React's static
   * memoisation reads them as stable references when the parent
   * memoises individually.
   */
  sidebarState: SidebarState
  sidebarFilter: SidebarFilter
  onSidebarStateChange: (next: SidebarState) => void
  onSidebarFilterChange: (next: SidebarFilter) => void
  highlightedSourceFieldId: string | null
  onSidebarFieldClick: (fieldId: string) => void
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
  const { pushToast } = useToast()

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

  // ── Phase 4-polish-3 — `?focus=unack` deep-link param ─────────────
  //
  // When the inline ✗ on a `target_acknowledged` row fires, the row
  // handler writes `?drawer=<rowId>&focus=unack` so the drawer opens
  // and lands the user on the destructive Un-acknowledge button. The
  // drawer reads the param via the `focus` prop and pulses the
  // button, then fires `onFocusConsumed` so we can strip the param
  // from the URL — leaving it would re-fire the focus on every
  // unrelated drawer-affecting re-render.
  //
  // Initialised from the URL on mount; cleared by
  // `handleFocusConsumed` after the drawer reports consumption.
  const [drawerFocus, setDrawerFocus] = useState<'unack' | null>(() => {
    const initial = (searchParams ?? new URLSearchParams()).get('focus')
    return initial === 'unack' ? 'unack' : null
  })

  // ── Phase 4a-2 — pendingDrawerRowId sentinel ──────────────────────
  //
  // After a successful `createFieldMapping`, we swap the drawer URL
  // param from `unmapped::<targetFieldId>` to the bare new TFM uuid.
  // The new id is NOT yet present in `data.rows` until
  // `router.refresh()` rehydrates the server component below us.
  // Without a sentinel, the stale-id auto-close effect (line 556-560
  // pre-Phase-4a-2) would briefly fire `setDrawerRowId(null)` between
  // the URL swap and the data refresh, causing the drawer to flicker
  // closed/open on every save.
  //
  // `pendingDrawerRowId` is the new TFM id. Two effects co-operate:
  //   1. Auto-close effect skips when `drawerRowId === pendingDrawerRowId`
  //      (the sentinel signals "data not yet here, hold the drawer
  //      open").
  //   2. A clear effect releases the sentinel as soon as the new row
  //      appears in `filteredRows` (the natural next render once
  //      `router.refresh()` rehydrates the server component).
  //
  // Founder decision §9-OQ-1 — flicker on every save is unacceptable.
  // The sentinel ships in 4a-2, not deferred to 4a-5 polish.
  const [pendingDrawerRowId, setPendingDrawerRowId] = useState<
    string | null
  >(null)

  // ── Phase 4a-4a — row-switch-while-dirty toast wiring ─────────────
  //
  // `lastDirtyFormSnapshot` mirrors the unmapped-row form's dirty
  // state. The drawer publishes via `onFormDirtyChange`; we cache the
  // latest snapshot so a row-switch can offer Undo without forcing
  // the form to remount around a deferred discard.
  //
  // `restoreRequest` is the one-shot payload threaded back into the
  // drawer when the user clicks Undo. The drawer's
  // `restoreFormState` prop reads from this state; the form's
  // mount-time hydration effect calls `onRestoreConsumed` once it has
  // applied the snapshot, at which point we clear the request.
  //
  // Founder decisions:
  //   • §11-OQ-1 — snapshot scope = fields only (no errors/dialog
  //     state). Defined in `CreateMappingForm` as
  //     `CreateMappingFormSnapshot`.
  //   • §11-OQ-2 — single rolling latest for rapid discards. The
  //     toast's `id: 'row-switch-discard'` invokes the toast
  //     primitive's replace-by-id semantics so the queue never
  //     stacks more than one of these at once.
  //   • §11-OQ-3 — toast does NOT fire on click-outside-drawer
  //     (uses 4a-2's `DiscardChangesDialog`). Toast only fires on
  //     row-switch. The dialog path lives inside `MappingDrawer`
  //     and never reaches `handleRowClick`.
  const [lastDirtyFormSnapshot, setLastDirtyFormSnapshot] =
    useState<CreateMappingFormSnapshot | null>(null)
  const [restoreRequest, setRestoreRequest] = useState<{
    rowId: string
    snapshot: CreateMappingFormSnapshot
  } | null>(null)

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
          next.confidence === prev.confidence &&
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
      // Phase 4a-4a — row-switch-while-dirty: capture the snapshot +
      // original row id, push a toast with an Undo affordance, then
      // proceed with the navigation. The form unmounts as the drawer
      // re-keys to the new row; the snapshot is the only handle on
      // the discarded draft.
      //
      // Ignore the no-op self-click (clicking the already-open row
      // body should not fire a "draft discarded" toast — nothing was
      // discarded).
      const originalRowId = drawerRowId
      const originalSnapshot = lastDirtyFormSnapshot
      if (
        originalSnapshot !== null &&
        originalRowId !== null &&
        originalRowId !== rowId
      ) {
        pushToast({
          id: 'row-switch-discard',
          variant: 'info',
          message: 'Mapping draft discarded.',
          actionLabel: 'Undo',
          onAction: () => {
            // Restore: navigate back to the original row, thread the
            // snapshot down so the drawer can auto-activate the form
            // and the form can re-hydrate its fields.
            setRestoreRequest({
              rowId: originalRowId,
              snapshot: originalSnapshot,
            })
            setDrawerRowId(originalRowId)
            writeUrl(filters, originalRowId)
          },
        })
      }
      // Clear the cached snapshot — the form is about to unmount and
      // the discard has been recorded (either in a toast queue or
      // silently if the row id is the same).
      setLastDirtyFormSnapshot(null)
      setDrawerRowId(rowId)
      writeUrl(filters, rowId)
    },
    [writeUrl, filters, drawerRowId, lastDirtyFormSnapshot, pushToast],
  )

  const handleDrawerClose = useCallback(() => {
    setDrawerRowId(null)
    writeUrl(filters, null)
  }, [writeUrl, filters])

  // Phase 4a-4a — drawer publishes its form's snapshot here whenever
  // the dirty flag flips. Null = clean / form absent. We mirror it
  // into `lastDirtyFormSnapshot` so `handleRowClick` has a single
  // synchronous read for the toast trigger.
  const handleFormDirtyChange = useCallback(
    (snapshot: CreateMappingFormSnapshot | null) => {
      setLastDirtyFormSnapshot(snapshot)
    },
    [],
  )

  // Phase 4a-4a — fired by the form once it has applied a restore
  // snapshot. Clears the request so subsequent renders don't re-apply.
  const handleRestoreConsumed = useCallback(() => {
    setRestoreRequest(null)
  }, [])

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
  // Phase 4a-2 — successful manual mapping creation.
  //
  // The drawer's `CreateMappingForm` invokes this with the new TFM
  // uuid once `createFieldMapping` resolves. Three things happen in
  // sequence:
  //   1. Arm the `pendingDrawerRowId` sentinel so the auto-close
  //      effect skips the cleanup pass during the URL→refresh window.
  //   2. Swap `drawerRowId` (and the `?drawer=` URL param) from the
  //      `unmapped::<targetFieldId>` sentinel to the bare new TFM
  //      uuid. The drawer body re-mounts naturally on the row.kind
  //      flip from 'unmapped' to 'mapped' — no explicit choreography
  //      needed (founder decision §9-OQ-2).
  //   3. `router.refresh()` rehydrates the server component so the
  //      new row appears in `data.rows`. The clear-sentinel effect
  //      then releases the sentinel and the steady-state contract
  //      resumes.
  // Phase 4b-1 — extended to handle the edit-mode meta payload. When
  // `meta.mode === 'edit'` we DO NOT change `drawerRowId` (the TFM uuid
  // is unchanged on edit). We DO refresh the server component so the
  // mapped-row body re-renders with the new sources / combination, and
  // we surface a post-save toast. When the wrapper reset a transform
  // (`meta.transformReset === true`), the toast carries a
  // [Re-author transform] action that deep-links to the Transform tab
  // with `?targetFieldMappingId=<tfmId>` so the user lands on the
  // freshly-blank transform editor for this exact field.
  const handleDrawerSaveSuccess = useCallback(
    (tfmId: string, meta?: { mode: 'edit'; transformReset: boolean; stagedRowsReverted: number; nextStatus: 'needs_review' }) => {
      if (meta?.mode === 'edit') {
        router.refresh()
        if (meta.transformReset) {
          const reauthorHref = `/app/projects/${projectId}/transform?targetFieldMappingId=${tfmId}`
          // Founder §2.1 — exact row count when ≤100, qualitative
          // otherwise. We don't know `capped` here (the wrapper returns
          // an exact count, not the preview cap), so the threshold is
          // applied client-side as a parallel rule. The
          // PREVIEW_INVALIDATION_COUNT_CAP (101) is the source of
          // truth for the dialog; here we mirror the same threshold
          // so the dialog and toast read consistently.
          const reverted = meta.stagedRowsReverted
          const countPhrase =
            reverted > 100
              ? 'Staged data invalidated.'
              : reverted === 1
                ? '1 staged row invalidated.'
                : `${reverted} staged rows invalidated.`
          pushToast({
            id: `mapping-edit-${tfmId}`,
            variant: 'success',
            message: `Mapping updated. ${countPhrase}`,
            actionLabel: 'Re-author transform',
            onAction: () => {
              router.push(reauthorHref)
            },
          })
        } else {
          pushToast({
            id: `mapping-edit-${tfmId}`,
            variant: 'success',
            message: 'Mapping updated.',
          })
        }
        return
      }
      // Create-mode path (legacy 4a-2 contract).
      setPendingDrawerRowId(tfmId)
      setDrawerRowId(tfmId)
      writeUrl(filters, tfmId)
      router.refresh()
    },
    [router, filters, writeUrl, pushToast, projectId],
  )

  // ── Phase 4c-1 — bulk-action state machine ─────────────────────────
  //
  // One source-of-truth slot for the bulk dialog. `bulkAction` carries
  // the active scope (`'approve_table' | 'approve_high_confidence'`)
  // plus enough metadata to label the dialog. `null` keeps the dialog
  // closed.
  //
  // Preview data (`bulkPreviewCount`, `bulkPreview`) is fetched
  // server-side once the dialog opens, so the count + preview list
  // reflect the canonical scope and dodge the TOCTOU class where a
  // client-side derivation would be a snapshot of the user's stale
  // filter state. `bulkPreviewCount === null` is the loading
  // indicator; the dialog renders "Loading preview…" until it lands.
  //
  // `isBulkSubmitting` and `bulkErrorMessage` round out the dialog's
  // local lifecycle. The wrapper's `tfmIds` array is not retained
  // here — the toast announces the count and the activity log keeps
  // the audit trail.
  const [bulkAction, setBulkAction] = useState<
    | { kind: 'approve_table'; targetTableId: string; targetTableName: string }
    | { kind: 'approve_high_confidence' }
    | { kind: 'reject_table'; targetTableId: string; targetTableName: string }
    | null
  >(null)
  const [bulkPreviewCount, setBulkPreviewCount] = useState<number | null>(null)
  const [bulkPreview, setBulkPreview] = useState<BulkPreviewRow[]>([])
  const [isBulkSubmitting, setIsBulkSubmitting] = useState(false)
  const [bulkErrorMessage, setBulkErrorMessage] = useState<string | null>(null)

  // Open helpers — separated from the wrapper-call helper so the
  // dialog can render a loading state for the preview before the
  // server returns.
  const handleApproveAllForTableClick = useCallback(
    (targetTableId: string) => {
      const tableName =
        data.targetTables.find((t) => t.id === targetTableId)?.name ?? '?'
      setBulkAction({
        kind: 'approve_table',
        targetTableId,
        targetTableName: tableName,
      })
      setBulkPreviewCount(null)
      setBulkPreview([])
      setBulkErrorMessage(null)
      // Fire the preview load in the background. The dialog renders
      // "Loading preview…" until this resolves.
      void (async () => {
        const result = await previewBulkApprove({ projectId, targetTableId })
        // Guard against stale resolves: only commit the preview when
        // the dialog is still showing the same scope.
        setBulkAction((current) => {
          if (
            current?.kind === 'approve_table' &&
            current.targetTableId === targetTableId
          ) {
            setBulkPreviewCount(result.count)
            setBulkPreview(result.preview)
          }
          return current
        })
      })()
    },
    [data.targetTables, projectId],
  )

  // Phase 4c-2 — reject-all-for-table click. Same shape as the approve
  // path: open the dialog in `reject_table` scope, fire the preview load
  // in the background, and let the dialog render "Loading preview…"
  // until it lands. The preview helper returns `hasTransform` per row;
  // BulkConfirmDialog surfaces it as a transform-reset indicator.
  const handleRejectAllForTableClick = useCallback(
    (targetTableId: string) => {
      const tableName =
        data.targetTables.find((t) => t.id === targetTableId)?.name ?? '?'
      setBulkAction({
        kind: 'reject_table',
        targetTableId,
        targetTableName: tableName,
      })
      setBulkPreviewCount(null)
      setBulkPreview([])
      setBulkErrorMessage(null)
      void (async () => {
        const result = await previewBulkReject({ projectId, targetTableId })
        setBulkAction((current) => {
          if (
            current?.kind === 'reject_table' &&
            current.targetTableId === targetTableId
          ) {
            setBulkPreviewCount(result.count)
            setBulkPreview(result.preview)
          }
          return current
        })
      })()
    },
    [data.targetTables, projectId],
  )

  // Project-wide high-confidence preview: client-side derivation for
  // the count is enough (we already have every row + its confidence
  // in `data.rows`); we still want a preview LIST for the dialog,
  // which the bulkApprove preview helper does NOT cover (it scopes
  // by target_table_id). For 4c-1, derive both from `data.rows` —
  // §4.3's server preview helper covers the per-table path; the
  // high-confidence path uses what the client already has loaded.
  // This preserves single-fetch performance and avoids a new
  // server-side preview RPC for a contract that's identical in shape
  // to the per-table case.
  const handleApproveHighConfidenceClick = useCallback(() => {
    setBulkAction({ kind: 'approve_high_confidence' })
    setBulkErrorMessage(null)
    const inScope = data.rows.filter(
      (r) =>
        (r.kind === 'mapped' || r.kind === 'value_assignment') &&
        r.status === 'needs_review' &&
        (r.confidence ?? 0) >= HIGH_CONFIDENCE_THRESHOLD,
    )
    setBulkPreviewCount(inScope.length)
    const preview: BulkPreviewRow[] = inScope.slice(0, 5).map((r) => {
      const primary =
        r.kind === 'mapped' && r.sources.length > 0
          ? (r.sources[0]?.sourceField.name ?? null)
          : null
      return {
        tfmId: r.id,
        targetField: r.targetField.name,
        primarySource: primary,
      }
    })
    setBulkPreview(preview)
  }, [data.rows])

  const handleBulkCancel = useCallback(() => {
    if (isBulkSubmitting) return
    setBulkAction(null)
    setBulkPreview([])
    setBulkPreviewCount(null)
    setBulkErrorMessage(null)
  }, [isBulkSubmitting])

  const handleBulkConfirm = useCallback(async () => {
    if (bulkAction === null) return
    setIsBulkSubmitting(true)
    setBulkErrorMessage(null)
    try {
      if (bulkAction.kind === 'reject_table') {
        // Phase 4c-2 — bulk reject path. Toast copy distinguishes
        // full success from partial success so users see when the
        // wrapper had to skip TFMs whose transform reset failed.
        // Originally-requested count is the dialog's preview count
        // (stable across the lifecycle of a single click); the
        // wrapper returns `rowsAffected` (rejectable, deleted) and
        // optional `failedTfmIds` (the difference).
        const requested = bulkPreviewCount ?? 0
        const result = await bulkRejectFieldMappingsForTargetTable({
          projectId,
          targetTableId: bulkAction.targetTableId,
        })
        if (!result.success) {
          setBulkErrorMessage(result.error)
          return
        }
        const n = result.rowsAffected
        const failedCount = result.failedTfmIds?.length ?? 0
        const transformsReset = result.transformsReset
        let message: string
        if (failedCount > 0) {
          // Partial-success copy (§3.4 surface).
          message = `Rejected ${n} of ${requested || n + failedCount} mapping${
            n + failedCount === 1 ? '' : 's'
          } on ${bulkAction.targetTableName}; ${failedCount} could not be rejected (transform reset failed)`
        } else {
          message = `Rejected ${n} mapping${n === 1 ? '' : 's'} on ${bulkAction.targetTableName}.`
          if (transformsReset > 0) {
            message += ` ${transformsReset} transform${transformsReset === 1 ? '' : 's'} reset.`
          }
        }
        pushToast({
          id: `bulk-reject-${bulkAction.kind}-${Date.now()}`,
          // Partial success → 'info' (neutral, factual). The toast
          // codebase has no 'warning' variant; 'error' is reserved
          // for outright failures (handled by `setBulkErrorMessage`
          // above which keeps the dialog open with a red banner).
          variant: failedCount > 0 ? 'info' : 'success',
          message,
        })
        setBulkAction(null)
        setBulkPreview([])
        setBulkPreviewCount(null)
        router.refresh()
        return
      }

      // Approve paths — unchanged from 4c-1.
      const result =
        bulkAction.kind === 'approve_table'
          ? await bulkApproveFieldMappingsForTargetTable({
              projectId,
              targetTableId: bulkAction.targetTableId,
            })
          : await approveHighConfidenceMappings({
              projectId,
              threshold: HIGH_CONFIDENCE_THRESHOLD,
            })
      if (!result.success) {
        setBulkErrorMessage(result.error)
        return
      }
      const n = result.rowsAffected
      const message =
        bulkAction.kind === 'approve_table'
          ? `Approved ${n} mapping${n === 1 ? '' : 's'} on ${bulkAction.targetTableName}.`
          : `Approved ${n} high-confidence mapping${n === 1 ? '' : 's'}.`
      pushToast({
        id: `bulk-approve-${bulkAction.kind}-${Date.now()}`,
        variant: 'success',
        message,
      })
      setBulkAction(null)
      setBulkPreview([])
      setBulkPreviewCount(null)
      router.refresh()
    } catch (err) {
      setBulkErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setIsBulkSubmitting(false)
    }
  }, [bulkAction, bulkPreviewCount, projectId, pushToast, router])

  // ── Phase 4-polish-3 — inline row action state ────────────────────
  //
  // Three slots co-operate to deliver the inline action UX defined in
  // `docs/features/phase-4-plan.md` §polish-3:
  //
  //   1. `optimisticStates` — row-id-keyed map of in-flight animation
  //      states. The row component reads this map via prop and renders
  //      the matching CSS overlay (green flash, slate flash, blue
  //      flash, slide-fade-out).
  //   2. `rejectAnchor` — single slot for the active reject popover.
  //      Set when the user clicks the row's ✗ button; cleared on
  //      cancel, on successful confirm (after the wrapper resolves),
  //      and on unmount. The popover anchors to the captured DOM node.
  //   3. `lastInlineActionTfmId` — purely informational; tracks the
  //      most recent rowId that fired an inline action so future
  //      polish (e.g. inline error toasts that restate the row label)
  //      can read it without prop drilling. Currently unused but kept
  //      as a sentinel for the next polish iteration. (Removed in
  //      this implementation pass; will be re-added if needed.)
  //
  // Lifecycle: each handler sets the optimistic state synchronously
  // BEFORE awaiting the wrapper, so the user sees the highlight on
  // the next paint. After the wrapper resolves, we delay the clear by
  // a small timeout so the highlight has a moment to be visible
  // before either (a) the row re-renders with its post-action data
  // (approve / edit-sources path) or (b) the row unmounts naturally
  // post `router.refresh()` (reject / acknowledge / unmapped→mapped).
  const [optimisticStates, setOptimisticStates] = useState<
    Map<string, FieldMappingRowOptimisticState>
  >(() => new Map())
  const [rejectAnchor, setRejectAnchor] = useState<{
    rowId: string
    anchorEl: HTMLElement
  } | null>(null)

  const setOptimistic = useCallback(
    (rowId: string, state: FieldMappingRowOptimisticState) => {
      setOptimisticStates((prev) => {
        const next = new Map(prev)
        next.set(rowId, state)
        return next
      })
    },
    [],
  )
  const clearOptimistic = useCallback((rowId: string) => {
    setOptimisticStates((prev) => {
      if (!prev.has(rowId)) return prev
      const next = new Map(prev)
      next.delete(rowId)
      return next
    })
  }, [])

  const handleInlineApprove = useCallback(
    async (rowId: string) => {
      setOptimistic(rowId, 'approving')
      try {
        const result = await approveFieldMapping(rowId)
        if (!result.success) {
          pushToast({
            id: `inline-approve-${rowId}-${Date.now()}`,
            variant: 'error',
            message: result.error ?? 'Could not approve mapping.',
          })
          clearOptimistic(rowId)
          return
        }
        pushToast({
          id: `inline-approve-${rowId}-${Date.now()}`,
          variant: 'success',
          message: 'Mapping approved.',
        })
        router.refresh()
      } catch (err) {
        pushToast({
          id: `inline-approve-${rowId}-${Date.now()}`,
          variant: 'error',
          message: err instanceof Error ? err.message : 'Could not approve mapping.',
        })
        clearOptimistic(rowId)
        return
      }
      // Hold the highlight for ~150ms so the user catches the green
      // flash before the row settles into its post-approve state.
      setTimeout(() => clearOptimistic(rowId), 150)
    },
    [setOptimistic, clearOptimistic, pushToast, router],
  )

  const handleInlineRejectClick = useCallback(
    (rowId: string, anchorEl: HTMLElement) => {
      setRejectAnchor({ rowId, anchorEl })
    },
    [],
  )

  const handleRejectCancel = useCallback(() => {
    setRejectAnchor(null)
  }, [])

  const handleRejectConfirm = useCallback(async () => {
    if (rejectAnchor === null) return
    const { rowId } = rejectAnchor
    setRejectAnchor(null)
    setOptimistic(rowId, 'rejecting')
    try {
      const result = await rejectFieldMapping(rowId)
      if (!result.success) {
        pushToast({
          id: `inline-reject-${rowId}-${Date.now()}`,
          variant: 'error',
          message: result.error ?? 'Could not reject mapping.',
        })
        clearOptimistic(rowId)
        return
      }
      pushToast({
        id: `inline-reject-${rowId}-${Date.now()}`,
        variant: 'success',
        message: 'Mapping rejected.',
      })
      // Wait for the 200ms slide-fade-out to complete before firing
      // `router.refresh()` so the user sees the row leave gracefully
      // rather than blink out instantly when the data swap arrives.
      setTimeout(() => router.refresh(), 200)
    } catch (err) {
      pushToast({
        id: `inline-reject-${rowId}-${Date.now()}`,
        variant: 'error',
        message: err instanceof Error ? err.message : 'Could not reject mapping.',
      })
      clearOptimistic(rowId)
    }
  }, [rejectAnchor, setOptimistic, clearOptimistic, pushToast, router])

  const handleInlineAcknowledge = useCallback(
    async (rowId: string) => {
      const row = data.rows.find((r) => r.id === rowId)
      if (row === undefined) return
      const targetFieldId = row.targetField.id
      setOptimistic(rowId, 'acknowledging')
      try {
        // `acknowledgeField` throws on failure (back-compat semantic
        // from the legacy MappingContent, kept by `field-
        // acknowledgments.ts`). Inline path uses the bare reason
        // `'acknowledged'` — same default the legacy sidebar action
        // surface used. For richer reasons users still go through
        // the drawer's W1 form.
        await acknowledgeField(projectId, targetFieldId, 'target', 'acknowledged')
        pushToast({
          id: `inline-acknowledge-${rowId}-${Date.now()}`,
          variant: 'success',
          message: 'Field acknowledged.',
        })
        setTimeout(() => router.refresh(), 150)
      } catch (err) {
        pushToast({
          id: `inline-acknowledge-${rowId}-${Date.now()}`,
          variant: 'error',
          message:
            err instanceof Error ? err.message : 'Could not acknowledge field.',
        })
        clearOptimistic(rowId)
        return
      }
      setTimeout(() => clearOptimistic(rowId), 250)
    },
    [data.rows, projectId, setOptimistic, clearOptimistic, pushToast, router],
  )

  // The inline ✗ on `target_acknowledged` rows opens the drawer with
  // the `?focus=unack` deep-link rather than firing the un-acknowledge
  // wrapper directly. Founder lock — un-acknowledge is a destructive
  // identity-dissolving action and deserves a confirmation surface;
  // the drawer's existing UnacknowledgeConfirmDialog is that surface.
  // Block F (this same phase) wires the focus param into a scroll +
  // brief-highlight pulse on the drawer's existing un-ack button.
  const handleInlineUnacknowledge = useCallback(
    (rowId: string) => {
      setDrawerRowId(rowId)
      setDrawerFocus('unack')
      const filterQs = serializeFilterStateToQuery(filters)
      const params = new URLSearchParams(filterQs)
      params.set('drawer', rowId)
      params.set('focus', 'unack')
      const qs = params.toString()
      router.replace(
        `/app/projects/${projectId}/mapping${qs ? `?${qs}` : ''}`,
        { scroll: false },
      )
    },
    [router, projectId, filters],
  )

  // ── Phase 4-polish-3 — focus consumption + URL strip ──────────────
  //
  // Fired by the drawer once it has scrolled the un-acknowledge
  // button into view and started its highlight pulse. We clear the
  // local `drawerFocus` state and rewrite the URL without the
  // `?focus=unack` param so the focus does not re-trigger on
  // unrelated re-renders (e.g., subsequent filter changes that
  // re-emit `writeUrl`).
  const handleFocusConsumed = useCallback(() => {
    setDrawerFocus(null)
    const filterQs = serializeFilterStateToQuery(filters)
    const params = new URLSearchParams(filterQs)
    if (drawerRowId !== null) params.set('drawer', drawerRowId)
    const qs = params.toString()
    router.replace(
      `/app/projects/${projectId}/mapping${qs ? `?${qs}` : ''}`,
      { scroll: false },
    )
  }, [router, projectId, filters, drawerRowId])

  const handleInlineSourceCommit = useCallback(
    async (
      rowId: string,
      finalIds: string[],
    ): Promise<{ success: boolean }> => {
      const row = data.rows.find((r) => r.id === rowId)
      if (row === undefined) return { success: false }
      // Picker's Save-disabled-when-empty guard normally prevents this,
      // but defense-in-depth: an empty selection cannot be persisted.
      if (finalIds.length === 0) return { success: false }

      setOptimistic(rowId, 'mapping')

      const isMulti = finalIds.length > 1
      const wasMulti = row.kind === 'mapped' && row.sources.length > 1

      // Combination-type resolution per polish-3 spec:
      //   • finalIds.length === 1 → 'single'
      //   • multi & was multi (mapped) → preserve existing unless
      //     'custom_sql' (which is filtered out of inline-edit
      //     eligibility upstream).
      //   • multi & was single | unmapped → default 'concat_space'
      //     to match `CreateMappingForm`'s pre-selection.
      let combinationType: CreateFieldMappingCombinationType
      if (!isMulti) {
        combinationType = 'single'
      } else if (
        row.kind === 'mapped' &&
        wasMulti &&
        (row.combinationType === 'concat_space' ||
          row.combinationType === 'concat_comma')
      ) {
        combinationType = row.combinationType
      } else {
        combinationType = 'concat_space'
      }

      try {
        if (row.kind === 'unmapped') {
          const result = await createFieldMapping({
            projectId,
            targetFieldId: row.targetField.id,
            sourceFieldIds: finalIds,
            combinationType,
          })
          if (!result.success) {
            pushToast({
              id: `inline-map-${rowId}-${Date.now()}`,
              variant: 'error',
              message: result.error ?? 'Could not create mapping.',
            })
            clearOptimistic(rowId)
            return { success: false }
          }
          pushToast({
            id: `inline-map-${rowId}-${Date.now()}`,
            variant: 'success',
            message: isMulti
              ? 'Mapping created. Now multi-source — define combination logic in the Transform tab.'
              : 'Mapping created.',
          })
        } else if (row.kind === 'mapped') {
          const result = await editMappingSources({
            tfmId: rowId,
            sourceFieldIds: finalIds,
            combinationType,
          })
          if (!result.success) {
            pushToast({
              id: `inline-map-${rowId}-${Date.now()}`,
              variant: 'error',
              message: result.error ?? 'Could not update mapping sources.',
            })
            clearOptimistic(rowId)
            return { success: false }
          }
          const message =
            !wasMulti && isMulti
              ? 'Now multi-source. Define combination logic in the Transform tab.'
              : 'Source updated.'
          pushToast({
            id: `inline-map-${rowId}-${Date.now()}`,
            variant: 'success',
            message,
          })
        } else {
          // Other row.kind values are filtered out by FieldMappingRow's
          // `isInlineSourceEditable` guard before reaching this handler.
          clearOptimistic(rowId)
          return { success: false }
        }
        router.refresh()
      } catch (err) {
        pushToast({
          id: `inline-map-${rowId}-${Date.now()}`,
          variant: 'error',
          message: err instanceof Error ? err.message : 'Could not save mapping.',
        })
        clearOptimistic(rowId)
        return { success: false }
      }
      setTimeout(() => clearOptimistic(rowId), 200)
      return { success: true }
    },
    [data.rows, projectId, setOptimistic, clearOptimistic, pushToast, router],
  )

  const handleDrawerActionComplete = useCallback(
    (action: 'approve' | 'reject' | 'unacknowledge', _rowId: string) => {
      // Phase 3 Gap 11b — clear the sidebar highlight after any
      // drawer action. Reject deletes the TFM (the highlighted row
      // identity dissolves on the server), so a stale highlight
      // would point at a row id that no longer exists. Approve
      // preserves identity but also clears the highlight — mild
      // over-clearing is acceptable per the founder's "additional
      // concern" decision in the Gap 11b alignment.
      //
      // Phase 4b-2 — un-acknowledge mirrors reject: the bare-ack
      // TFM row is deleted, so the row id stops resolving. Close
      // the drawer + clear the URL identically.
      onClearHighlight()
      router.refresh()
      if (action === 'reject' || action === 'unacknowledge') {
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

  // ── Phase 4a-2 — last-valid row retention during save→refresh ────
  //
  // After a successful manual mapping save we swap the URL from
  // `?drawer=unmapped::tf-X` to `?drawer=<newTfmId>`. The new TFM is
  // not yet in `data.rows` until `router.refresh()` rehydrates the
  // server component (a separate React commit). Without retention,
  // `drawerRow` becomes null in that intermediate window and
  // `<MappingDrawer>` unmounts, causing a visible flicker.
  //
  // `lastValidDrawerRowRef` remembers the most recently rendered row
  // identity so we can keep the drawer mounted with its content until
  // the new mapped row materializes. The body re-mounts naturally on
  // the row.kind 'unmapped' → 'mapped' flip (founder decision §9-OQ-2).
  const lastValidDrawerRowRef = useRef<MappingRow | null>(null)
  useEffect(() => {
    if (drawerRow !== null) {
      lastValidDrawerRowRef.current = drawerRow
    }
  }, [drawerRow])

  // Effective row passed to `<MappingDrawer>`. Falls back to the last
  // valid row only inside the pending sentinel window — never used as
  // a generic fallback (which would mask filter-hide and stale-URL
  // bugs).
  const effectiveDrawerRow = useMemo<MappingRow | null>(() => {
    if (drawerRow !== null) return drawerRow
    if (
      pendingDrawerRowId !== null &&
      drawerRowId === pendingDrawerRowId &&
      lastValidDrawerRowRef.current !== null
    ) {
      return lastValidDrawerRowRef.current
    }
    return null
  }, [drawerRow, drawerRowId, pendingDrawerRowId])

  // Phase 3 Gap 7 — auto-close + URL clean-up when the open drawer row
  // is no longer reachable. Two trigger paths:
  //   1. Filter change hides the row (e.g. Search "xyz_never_matches")
  //   2. Stale URL on mount (`?drawer=<id>` for an id absent from data)
  // Both flow through this effect so the URL stays consistent with
  // visible state at all times.
  //
  // Phase 4a-2 amendment: skip auto-close while the
  // `pendingDrawerRowId` sentinel matches the current `drawerRowId`.
  // The sentinel signals "we just swapped the URL to a new TFM id;
  // data refresh is in flight". Letting the auto-close fire here
  // would close the drawer between URL swap and data rehydrate,
  // producing a visible flicker on every save.
  useEffect(() => {
    if (drawerRowId === null) return
    if (drawerRow !== null) return
    if (
      pendingDrawerRowId !== null &&
      drawerRowId === pendingDrawerRowId
    ) {
      return
    }
    setDrawerRowId(null)
    writeUrl(filters, null)
  }, [drawerRowId, drawerRow, filters, writeUrl, pendingDrawerRowId])

  // Phase 4a-2 — clear the sentinel as soon as the awaited row
  // materializes in `filteredRows`. This is the natural completion
  // signal: `router.refresh()` rehydrates the server component, the
  // new TFM lands in `data.rows`, `drawerRow` becomes non-null, and
  // we release the sentinel so subsequent navigation honors the
  // standard auto-close contract again.
  useEffect(() => {
    if (pendingDrawerRowId === null) return
    if (drawerRow !== null && drawerRow.id === pendingDrawerRowId) {
      setPendingDrawerRowId(null)
    }
  }, [drawerRow, pendingDrawerRowId])

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

  // Phase 4-polish-2 — group collapsibility (URL-driven). The hook
  // owns parsing/serialising the `?collapsed=` URL param and exposing
  // O(1) membership / toggle / expand-all helpers. We thread its
  // outputs into each TargetTableGroup below.
  //
  // `isAutoExpanded` is computed once per render from `isDefaultState`
  // (already memoised above): when ANY filter is non-default, the
  // user's persisted collapsed state is overridden so they can never
  // see "0 results" because the matching rows live inside a
  // collapsed group. Clearing the filter restores the user's
  // disclosure state from the unchanged `?collapsed=` URL param.
  const { isCollapsed, toggleCollapsed } = useCollapsedGroups()
  const isAutoExpanded = !isDefaultState
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

  // Phase 4c-1 — per-target-table needs-review counts. Drives the
  // kebab item's enabled/disabled state and subtitle. Iterated once
  // over `data.rows` rather than per-group inside the render loop
  // (avoids O(n×m) work on every interaction). Bulk wrapper scope is
  // hard-coded `status='needs_review' AND is_acknowledged=false`; the
  // ack-only rows enter the kind discriminator as
  // `target_acknowledged`, so filtering by `kind === 'mapped' ||
  // 'value_assignment'` AND `status === 'needs_review'` matches the
  // server's WHERE clause exactly.
  const needsReviewCountByTable = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of data.rows) {
      if (row.kind !== 'mapped' && row.kind !== 'value_assignment') continue
      if (row.status !== 'needs_review') continue
      const tableId = row.targetField.targetTable.id
      m.set(tableId, (m.get(tableId) ?? 0) + 1)
    }
    return m
  }, [data.rows])

  // Phase 4 empty-state — discriminate the four cases that warrant
  // an empty-state CTA in the body and the Strip+FilterRow hide-out
  // in the toolbar. `selectEmptyMappingCase` returns 1-4 for the
  // empty cases (see `EmptyMappingState.tsx` for the matrix) or
  // `null` when the project has at least one populated TFM and the
  // existing TargetTableGroup list should render. The toolbar
  // (Strip + FilterRow) is informationally useless in any of the
  // empty cases — there's nothing to filter — so we hide it whenever
  // we're rendering an empty-state card.
  const emptyMappingCase = useMemo(
    () => selectEmptyMappingCase(data),
    [data],
  )
  const isEmptyMappingState = emptyMappingCase !== null

  // Phase 4c-1 — project-wide high-confidence count. Same derivation
  // contract as the server preview's WHERE clause but the client
  // already has confidence on every row, so this is a single pass.
  const highConfidenceCount = useMemo(() => {
    let n = 0
    for (const row of data.rows) {
      if (row.kind !== 'mapped' && row.kind !== 'value_assignment') continue
      if (row.status !== 'needs_review') continue
      if ((row.confidence ?? 0) < HIGH_CONFIDENCE_THRESHOLD) continue
      n++
    }
    return n
  }, [data.rows])

  // Phase 4-polish-1 sidebar architecture refactor (2026-04-26): the
  // returned Fragment expands as direct children of the outer flex
  // column rendered by `MappingRedesignContent`. The sibling order
  // is intentional and pinned by a structural invariant test in
  // `tests/components/mapping-redesign-content.test.tsx`:
  //
  //   1. <MappingSummaryStrip>  — page-level toolbar row 1 (chips)
  //   2. <FilterRow>            — page-level toolbar row 2
  //   3. <div ...flex row>      — sidebar + body scroll container
  //   4. <MappingDrawer>        — position-fixed; no flex impact
  //   5. <BulkConfirmDialog>    — position-fixed; no flex impact
  //
  // Strip and FilterRow used to live INSIDE the body's
  // `flex-1 overflow-auto` scroll container, which caused horizontal
  // squish whenever the sidebar expanded. Lifting them out makes
  // them semantically equivalent to the page header — they span the
  // viewport's full width regardless of sidebar state.
  return (
    <>
      {/* Phase 4 empty-state — Strip + FilterRow surface only when the
          project has at least one populated TFM. In any of the four
          empty cases (no source/target schema, both schemas with zero
          TFMs) the toolbar is hidden because there is nothing to
          filter. The structural-invariant test in
          `tests/components/mapping-redesign-content.test.tsx`
          continues to pass for populated fixtures because Strip and
          FilterRow render in their original sibling positions when
          present. */}
      {!isEmptyMappingState && (
        <>
          <MappingSummaryStrip counts={data.counts} />
          <FilterRow
            filters={filters}
            onFiltersChange={handleFiltersChange}
            targetTables={data.targetTables}
            sourceTables={data.sourceTables}
            rejectedCount={data.counts.rejected}
            highConfidenceCount={highConfidenceCount}
            onApproveHighConfidenceClick={handleApproveHighConfidenceClick}
          />
        </>
      )}

      {/* Sidebar + body scroll container. The sidebar persists across
          loaded/empty data states (its own state lives in
          `MappingRedesignContent`); the body renders the group-card
          list, per-group empty states, or filter-empty states inside
          a centered max-w-5xl reading column. `min-h-0` is necessary —
          without it, flex children stretch indefinitely instead of
          letting the scroll container handle overflow. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SourceSchemaSidebar
          state={sidebarState}
          filter={sidebarFilter}
          onStateChange={onSidebarStateChange}
          onFilterChange={onSidebarFilterChange}
          sourceFields={data.sourceFields}
          highlightedSourceFieldId={highlightedSourceFieldId}
          onFieldClick={onSidebarFieldClick}
        />
        <div className="flex-1 overflow-auto">
          {/*
            Body reading column. `py-6` provides 24px top + 24px bottom
            breathing room around the group cards. The toolbar above
            (Strip + FilterRow), when shown, is full-width and outside
            this column; the column only governs the body content's
            reading width.
          */}
          <div className="mx-auto w-full max-w-5xl px-6 py-6">
            {isEmptyMappingState ? (
              <EmptyMappingState projectId={projectId} data={data} />
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
                      needsReviewCount={needsReviewCountByTable.get(summary.id) ?? 0}
                      onApproveAllClick={handleApproveAllForTableClick}
                      onRejectAllClick={handleRejectAllForTableClick}
                      isCollapsed={isCollapsed(summary.name)}
                      isAutoExpanded={isAutoExpanded}
                      onToggleCollapse={toggleCollapsed}
                      availableSourceFields={data.sourceFields}
                      optimisticStates={optimisticStates}
                      onInlineApprove={handleInlineApprove}
                      onInlineReject={handleInlineRejectClick}
                      onInlineAcknowledge={handleInlineAcknowledge}
                      onInlineUnacknowledge={handleInlineUnacknowledge}
                      onInlineSourceCommit={handleInlineSourceCommit}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/*
        Phase 3 Gap 7 — drawer host. Position-fixed; no backdrop. The
        click-outside-closes contract is implemented in the parent
        scroll-container wrapper (see `MappingRedesignContent`) so this
        component does not have to know about its DOM neighbourhood.
      */}
      <MappingDrawer
        row={effectiveDrawerRow}
        isOpen={effectiveDrawerRow !== null}
        onClose={handleDrawerClose}
        onActionComplete={handleDrawerActionComplete}
        projectId={projectId}
        availableSourceFields={data.sourceFields}
        onSaveSuccess={handleDrawerSaveSuccess}
        onFormDirtyChange={handleFormDirtyChange}
        restoreFormState={
          // Only thread the snapshot when it matches the currently
          // open drawer row. Defense-in-depth — the drawer also
          // checks `targetFieldId` before activating, but gating
          // here keeps the drawer's prop surface stable across
          // unrelated row navigations.
          restoreRequest !== null &&
          effectiveDrawerRow !== null &&
          restoreRequest.rowId === effectiveDrawerRow.id
            ? restoreRequest.snapshot
            : null
        }
        onRestoreConsumed={handleRestoreConsumed}
        focus={drawerFocus}
        onFocusConsumed={handleFocusConsumed}
      />

      {/*
        Phase 4-polish-3 — reject confirmation popover. Anchored to
        the row's ✗ button. Single global instance keyed by
        `rejectAnchor` so concurrent reject popovers can't stack;
        opening a second one auto-closes the first via the
        `setRejectAnchor` setter.
      */}
      {rejectAnchor !== null ? (
        <RejectConfirmPopover
          // The popover expects a `RefObject` shape — wrap the
          // captured DOM node in a frozen ref-shaped object so the
          // popover's positioning effect can read `.current`.
          anchorRef={{ current: rejectAnchor.anchorEl }}
          onConfirm={handleRejectConfirm}
          onCancel={handleRejectCancel}
        />
      ) : null}

      {/*
        Phase 4c-1 — bulk confirm dialog. Single global instance,
        scoped by `bulkAction`. Closed when `bulkAction === null`.
      */}
      <BulkConfirmDialog
        open={bulkAction !== null}
        mode={bulkAction?.kind === 'reject_table' ? 'reject' : 'approve'}
        scope={
          bulkAction?.kind === 'approve_high_confidence'
            ? 'high_confidence'
            : 'table'
        }
        targetTableName={
          bulkAction?.kind === 'approve_table' ||
          bulkAction?.kind === 'reject_table'
            ? bulkAction.targetTableName
            : undefined
        }
        threshold={
          bulkAction?.kind === 'approve_high_confidence'
            ? HIGH_CONFIDENCE_THRESHOLD
            : undefined
        }
        count={bulkPreviewCount}
        preview={bulkPreview}
        isSubmitting={isBulkSubmitting}
        errorMessage={bulkErrorMessage}
        onCancel={handleBulkCancel}
        onConfirm={handleBulkConfirm}
      />
    </>
  )
}

// ─── Empty / error states ────────────────────────────────────────────────────
// (Phase 4-polish-1 founder Q2: CountersRow retired. Project-level chip
// rendering moved to `MappingSummaryStrip` at the page-header layer with
// restored legacy density. The §9 Q6 Rejected gating and the Phase 3
// Gap 13 Unmapped gating are preserved verbatim there.)
//

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

/**
 * Phase 4 — `EmptySchemaState` and `EmptyFieldsState` (former inline
 * components rendered for the `targetSchemaEmpty` and
 * `targetTables.length === 0` cases) have been subsumed by
 * `<EmptyMappingState>` in `./components/EmptyMappingState.tsx`,
 * which discriminates four empty cases (no schemas, target-only,
 * source-only, both-but-zero-TFMs) and surfaces the
 * `[Go to Data Overview]` CTA for the first three plus the
 * `<GenerateMappingsPanel>` for the fourth. The two `data-testid`
 * tokens previously emitted here (`mapping-redesign-empty-schema`,
 * `mapping-redesign-empty-fields`) are no longer in the DOM; the new
 * variants emit `mapping-redesign-empty-no-schemas`,
 * `mapping-redesign-empty-no-target`,
 * `mapping-redesign-empty-no-source`, and
 * `mapping-redesign-empty-generate` respectively.
 */

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
    state.confidence === DEFAULT_FILTER_STATE.confidence &&
    state.search === DEFAULT_FILTER_STATE.search
  )
}
