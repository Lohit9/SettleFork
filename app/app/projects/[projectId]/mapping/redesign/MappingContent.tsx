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
import { ProjectMenu } from '@/components/app/ProjectMenu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { RefreshCw, ShieldCheck, ChevronDown, AlertTriangle, BookOpen, X, Search, ChevronRight as ChevronRightIcon } from 'lucide-react'
import type {
  MappingRow,
  MappingsForRedesignResult,
  PartitionInfo,
  TargetFieldRef,
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
import { PartitionDeleteConfirmDialog } from './components/PartitionDeleteConfirmDialog'
import { PartitionRulesModal } from './components/PartitionRulesModal'
import { TargetTableGroup } from './components/TargetTableGroup'
import { MappingDrawer, type DrawerRow, type SourceFieldDrawerRow } from './components/MappingDrawer'
// MappingSummaryStrip retired from this screen — the design status strip
// (StatusStrip, below) replaces it as the page-level toolbar row.
// SourceSchemaSidebar removed at the
// feat/mapping-list-toggle-and-columns refinement pass — the
// collapsed-state vertical label was retired (Linear-style polish);
// source-field counts live on the summary chip now.
import { RejectConfirmPopover } from './components/RejectConfirmPopover'
import { MergeTargetDialog } from './components/MergeTargetDialog'
import { SourceDisambiguationDialog } from './components/SourceDisambiguationDialog'
import { MappingListView } from './components/MappingListView'
import { MockDataPreview } from './components/MockDataPreview'
import {
  USE_REAL_SPEC_TABLE,
  USE_REAL_DATA_PREVIEW,
} from '@/lib/flags/mapping-surfaces'
import { useMappingListMutations } from './hooks/useMappingListMutations'
import {
  applyViewModeToParams,
  type MappingViewMode,
  parseViewModeFromParams,
} from '@/lib/utils/view-mode-url'
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
import {
  getPathDOutputsForProject,
  type PathDOutputs,
} from '@/lib/actions/path-d-outputs'
import { deletePartition } from '@/lib/actions/partitions'
import { ToastProvider, useToast } from '@/lib/contexts/ToastContext'
import { CONFIDENCE_THRESHOLD_ROW_HIGH } from '@/lib/utils/confidence-format'
import { useCollapsedGroups } from '@/lib/hooks/useCollapsedGroups'
import {
  flattenRowsForListView,
  countFlatRowStatuses,
} from '@/lib/utils/flatten-rows-for-list-view'
import type { ProjectStats } from '@/lib/quality/project-stats'

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
  /**
   * Canonical project-wide stats (PR-1's helper output). Threaded from
   * the page-level RSC; consumed by `MappingProjectStatsRow` rendered
   * above `MappingSummaryStrip`. Optional + defaults to null so existing
   * test fixtures that don't construct ProjectStats keep working —
   * the row falls back to `awaiting_data` styling when null (Q5).
   */
  projectStats?: ProjectStats | null
  /** Source/target system names for the header breadcrumb. */
  sourceSystemName?: string | null
  targetSystemName?: string | null
}

export default function MappingRedesignContent({
  projectId,
  projectName,
  initialRedesignData,
  projectStats = null,
  sourceSystemName = null,
  targetSystemName = null,
}: Props) {
  const headerBreadcrumb =
    sourceSystemName && targetSystemName
      ? `${projectName} — ${sourceSystemName} → ${targetSystemName}`
      : projectName
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
  const router = useRouter()

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
        <PageHeader projectName={headerBreadcrumb} title="Configure">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                title="Re-derive the data from the current mappings and transforms."
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#3B82F6] hover:bg-[#EFF6FF] hover:text-[#2563EB] transition-colors data-[state=open]:bg-[#EFF6FF] data-[state=open]:text-[#2563EB]"
              >
                <RefreshCw className="w-[13px] h-[13px]" />
                Regenerate
                <ChevronDown className="w-3 h-3 text-[#93C5FD]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent align="end" className="w-[200px]">
                <DropdownMenuItem
                  onClick={() => router.push(`/app/projects/${projectId}/generating`)}
                >
                  <RefreshCw className="w-[13px] h-[13px] mr-2 text-[#9CA3AF]" />
                  Regenerate all data
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenu>

          {/* Rescan is a visual stub — no rescan endpoint wired yet. */}
          <button
            type="button"
            title="Re-check the current data against your rules — doesn't change values. (Coming soon)"
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#3B82F6] hover:bg-[#EFF6FF] hover:text-[#2563EB] transition-colors"
          >
            <ShieldCheck className="w-[13px] h-[13px]" />
            Rescan
          </button>

          <ProjectMenu
            project={{
              id: projectId,
              name: projectName,
              source_label: '',
              target_label: '',
              status: 'active',
            }}
            onUpdate={() => router.refresh()}
          />
        </PageHeader>
        {initialRedesignData === null ? (
          // Empty / error path — the body shows a single inline
          // error card. The SourceSchemaSidebar was removed at the
          // feat/mapping-list-toggle-and-columns refinement pass;
          // the Source Fields summary chip carries the count
          // information that the sidebar's collapsed-state label
          // previously surfaced.
          <div className="flex min-h-0 flex-1 overflow-hidden">
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
            projectStats={projectStats}
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
 * `value_assignment` and `unmapped` rows are silently skipped.
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
  projectStats: ProjectStats | null
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

  // ── Phase E PR α — Path D outputs sidecar fetch ──────────────────
  //
  // Page-level batch fetch of coverage rows / decisions / DQ issues for
  // the drawer's per-row enrichment sections. Additive to the existing
  // `data` prop — the drawer renders gracefully when `pathDOutputs` is
  // null (loading) or carries empty maps (RLS-denied / unfetchable);
  // every dependent body section collapses (Linear pattern). One-shot
  // load on projectId change; no refetch wiring in PR α (drawer-side
  // mutations are out of scope).
  const [pathDOutputs, setPathDOutputs] = useState<PathDOutputs | null>(null)
  useEffect(() => {
    let cancelled = false
    void getPathDOutputsForProject(projectId).then((outputs) => {
      if (cancelled) return
      setPathDOutputs(outputs)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])

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

  // Mapping list view — view mode is URL-synced (?view=flat | ?view=target).
  // The prior `showUnmappedSourceFields` local state was retired at the
  // feat/mapping-list-toggle-and-columns refinement pass — the flat
  // view now always shows every source field; the filter row carries
  // no toggle.
  // `drawerHighlightedSourceFieldId` is local view state: tracks which
  // child source attribution the flat view clicked through to so the
  // drawer can scroll/highlight on mount. Distinct from the existing
  // body-row `highlightedSourceFieldId` (driven by the sidebar) — that
  // one highlights rows in the mapping body; this one highlights a
  // SourceCard inside the drawer. Reset when the drawer closes.
  // View mode (flat vs target-led) is read from the URL and drives the list
  // rendering below. The on-screen toggle was retired with the design reskin;
  // the value still flows from `?view=` params for deep links.
  const [viewMode] = useState<MappingViewMode>(() =>
    parseViewModeFromParams(searchParams ?? new URLSearchParams()),
  )

  // Design reskin: the "Mapping & Transformation Spec" section toggles between
  // the Map & Transform spec (default) and the Data Preview surface. Local-only
  // mock state — Data Preview is a self-contained mock (`<MockDataPreview>`) and
  // is only reachable when USE_REAL_DATA_PREVIEW is unset (mock).
  const [specTab, setSpecTab] = useState<'map' | 'data'>('map')
  const [drawerHighlightedSourceFieldId, setDrawerHighlightedSourceFieldId] =
    useState<string | null>(null)

  // PR Ω.3.2 — selected partition per target table.
  //
  // KEYED BY: target_table_id. VALUE: table_mappings.id (the partition's
  // canonical id). Only entries with a non-null selection are stored —
  // a missing entry means "no partition filter active for that table"
  // (the group renders ALL partitions' rows).
  //
  // URL FORM: `?partition=<tm-id>[,<tm-id>...]`. Each token is a
  // table_mappings.id. Because partition ids are globally unique and
  // each carries an implicit target_table via
  // `data.partitionsByTargetTable`, we don't need to encode the table
  // id in the URL — reverse-lookup happens on parse.
  //
  // Heritage projects: the URL is never written (no tab affordance ever
  // fires `onPartitionChange`), and the parser yields an empty map.
  // Byte-identical to pre-Ω.3.2.
  const [selectedPartitionByTable, setSelectedPartitionByTable] = useState<
    Map<string, string>
  >(() => {
    const raw = (searchParams ?? new URLSearchParams()).get('partition')
    if (!raw) return new Map()
    const out = new Map<string, string>()
    const ids = raw.split(',').filter((s) => s.length > 0)
    if (ids.length === 0) return out
    // Reverse-index: partition_id → target_table_id.
    const partitionIdToTableId = new Map<string, string>()
    for (const [tableId, partitions] of Object.entries(
      data.partitionsByTargetTable ?? {},
    )) {
      for (const p of partitions) partitionIdToTableId.set(p.id, tableId)
    }
    for (const id of ids) {
      const tableId = partitionIdToTableId.get(id)
      if (tableId) out.set(tableId, id)
    }
    return out
  })

  // PR Ω.3.2.2 — flat view partition chip selection.
  //
  // KEYED BY: nothing (it's a flat set). VALUE: table_mappings.id.
  // EMPTY SET = no filter active (show all rows in flat view —
  // heritage byte-identity preserved via filterFlatRows short-circuit).
  //
  // INDEPENDENT from selectedPartitionByTable (the Target-led tab
  // strip's state) — different mental models: Target-led picks ONE
  // partition per table; flat view picks ANY combination project-wide.
  // See PR Ω.3.2.2 design doc §4 for the rationale.
  //
  // URL FORM: `?flatpartitions=<tm-id>[,<tm-id>...]` — comma-separated,
  // sorted on serialize, omitted when empty. Parallel to `?partition=`
  // but a distinct key so the two views never collide.
  const [flatPartitionSelection, setFlatPartitionSelection] = useState<
    Set<string>
  >(() => {
    const raw = (searchParams ?? new URLSearchParams()).get('flatpartitions')
    if (!raw) return new Set()
    const ids = raw.split(',').filter((s) => s.length > 0)
    if (ids.length === 0) return new Set()
    // Trust the URL — partition IDs are server-generated UUIDs. Stale
    // ids (e.g. a partition was deleted between bookmark save and
    // load) naturally produce zero matches in filterFlatRows; the
    // chip will surface the stale id under its trigger label until
    // the user clears or re-selects. Acceptable for a chip filter
    // (no destructive side effect).
    return new Set(ids)
  })

  // Single page-level mount for the partition create/edit modal. Owned
  // here (not per-TargetTableGroup) so we can keep one focus trap and
  // one Esc handler. `null` means closed; the object describes which
  // target table the form binds to and whether we're editing an
  // existing partition.
  const [partitionModalState, setPartitionModalState] = useState<
    | { targetTableId: string; editing: PartitionInfo | null }
    | null
  >(null)

  // PR Ω.3.2.1 — destructive partition-delete dialog state.
  //
  // `null` means closed. The object describes which partition is
  // being deleted and the running result of the action call:
  //
  //   stagedRowsBlocking — null = first attempt (SAFE state);
  //                         >0   = server returned HAS_STAGED_ROWS
  //                                and the dialog needs the user's
  //                                explicit force-confirmation
  //                                checkbox before retrying
  //   errorMessage       — surfaced when deletePartition returned an
  //                         error OTHER than HAS_STAGED_ROWS
  //                         (PERMISSION_DENIED, INTERNAL, …)
  //   saving             — in-flight gate; disables both Cancel +
  //                         Confirm so a second click cannot race the
  //                         pending request
  //
  // savingRef mirrors `saving` synchronously for the canSubmit-style
  // double-fire guard (INF-79 pattern, mirrors PartitionRulesModal).
  const [partitionDeleteState, setPartitionDeleteState] = useState<
    | {
        partition: PartitionInfo
        targetTableId: string
        stagedRowsBlocking: number | null
        errorMessage: string | null
        saving: boolean
      }
    | null
  >(null)
  const partitionDeleteSavingRef = useRef(false)

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

  // PR 3b commit 3 — `lastDirtyFormSnapshot` / `restoreRequest`
  // state and the `CreateMappingFormSnapshot` type retired with
  // `CreateMappingForm`. The row-switch-while-dirty toast had no
  // dirty form to publish a snapshot from; the entire orchestration
  // (handleFormDirtyChange, handleRestoreConsumed, row-switch toast
  // with Undo) goes away.

  // Debounce only the search-param URL write. Other filters write
  // immediately because they cause a single state change per interaction.
  const pendingSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Body scroll container ref — threaded down to each `TargetTableGroup`
  // so its `VirtualizedRowList` can target the inner scrollable div as
  // the virtualizer's scroll element. The page's only scrollable
  // ancestor is the inner `flex-1 overflow-auto` div below; the window
  // itself does not scroll (the outer wrapper is `min-h-0 flex-1
  // overflow-hidden`). Without this ref, `@tanstack/react-virtual`
  // listens for scroll events on the wrong element and the visible
  // range never advances past the first viewport's worth of rows.
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const writeUrl = useCallback(
    (
      next: MappingFilterState,
      nextDrawerRowId: string | null,
      overrideViewMode?: MappingViewMode,
      overridePartitionSelection?: Map<string, string>,
      overrideFlatPartitionSelection?: ReadonlySet<string>,
    ) => {
      // Pattern U1 (single source of truth): one writer composes the
      // filter query string, the drawer param, the view-mode param,
      // the Target-led partition param, and the flat-view partition
      // param together. This keeps any single concern's write from
      // clobbering the others. The `override*` args are opt-in escape
      // hatches for handlers that don't have to await a re-render of
      // the underlying state before writing the new value (e.g.
      // `handleViewModeChange`, `handlePartitionChange`,
      // `handleFlatPartitionSelectionChange`).
      const filterQs = serializeFilterStateToQuery(next)
      const params = new URLSearchParams(filterQs)
      if (nextDrawerRowId !== null) {
        params.set('drawer', nextDrawerRowId)
      }
      applyViewModeToParams(params, overrideViewMode ?? viewMode)
      const partitionMap =
        overridePartitionSelection ?? selectedPartitionByTable
      if (partitionMap.size > 0) {
        // Sort partition ids for URL stability across re-renders so
        // bookmarks / history don't churn just because of insertion
        // order. Tab order itself is governed by server canonical sort.
        const ids = Array.from(partitionMap.values()).sort()
        params.set('partition', ids.join(','))
      }
      const flatPartitions =
        overrideFlatPartitionSelection ?? flatPartitionSelection
      if (flatPartitions.size > 0) {
        // Same sort-for-stability rationale as `?partition=`.
        const ids = Array.from(flatPartitions).sort()
        params.set('flatpartitions', ids.join(','))
      }
      const qs = params.toString()
      router.replace(
        `/app/projects/${projectId}/mapping${qs ? `?${qs}` : ''}`,
        { scroll: false },
      )
    },
    [
      router,
      projectId,
      viewMode,
      selectedPartitionByTable,
      flatPartitionSelection,
    ],
  )

  // PR Ω.3.x.1 — pre-build cross-table intercept lookups for the hook.
  // The hook runs the intercept inside its `promoteUnmappedSource` and
  // `editMappingSources` methods, so every entry point (flat-view target
  // picker, drawer "Add source", drawer "Pick a target") is protected
  // without the host having to wrap each call. Maps are memoised on
  // `data.rows` / `data.sourceFields` identity — they re-build only on
  // a fresh server-component refresh, never on local UI state changes.
  const mutationLookups = useMemo(() => {
    const rowsByTargetFieldId = new Map<string, (typeof data.rows)[number]>()
    const mappedRowsByTfmId = new Map<string, (typeof data.rows)[number]>()
    for (const row of data.rows) {
      rowsByTargetFieldId.set(row.targetField.id, row)
      if (row.kind === 'mapped') mappedRowsByTfmId.set(row.id, row)
    }
    const sourceFieldsById = new Map<
      string,
      (typeof data.sourceFields)[number]
    >()
    for (const sf of data.sourceFields) sourceFieldsById.set(sf.id, sf)
    return { rowsByTargetFieldId, mappedRowsByTfmId, sourceFieldsById }
  }, [data.rows, data.sourceFields])

  const mutations = useMappingListMutations({
    projectId,
    lookups: mutationLookups,
  })

  // Drawer redesign PR 1 — universe of target fields for the drawer
  // header's inline target-field picker. Mirrors `MappingListView`'s
  // derivation: every target field appears exactly once across rows
  // (data contract), so a one-pass dedup is sufficient. Memoised on
  // `data.rows` identity — the parent re-renders on every refresh so
  // we want the memo to cut work between unrelated state changes.
  const availableTargetFields = useMemo<TargetFieldRef[]>(() => {
    const seen = new Set<string>()
    const out: TargetFieldRef[] = []
    for (const row of data.rows) {
      if (seen.has(row.targetField.id)) continue
      seen.add(row.targetField.id)
      out.push(row.targetField)
    }
    return out
  }, [data.rows])

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
      // PR 3b commit 3 — the row-switch-while-dirty toast / Undo
      // flow retired with `CreateMappingForm`. No drawer form remains,
      // so there's no dirty snapshot to discard. Plain navigation.
      setDrawerRowId(rowId)
      writeUrl(filters, rowId)
    },
    [writeUrl, filters],
  )

  const handleDrawerClose = useCallback(() => {
    setDrawerRowId(null)
    setDrawerHighlightedSourceFieldId(null)
    writeUrl(filters, null)
  }, [writeUrl, filters])

  // ─── PR Ω.3.2 — partition tab handlers ────────────────────────────
  //
  // `handlePartitionChange` updates the per-table selection map and,
  // per design Q2, auto-closes the drawer when:
  //   1. A drawer is currently open,
  //   2. The open row belongs to the target table whose partition just
  //      changed, AND
  //   3. The open row's `tableMappingId` no longer matches the new
  //      selection (i.e. the partition switch would hide it from view).
  //
  // The lookup uses raw `data.rows` (not filteredRows or drawerRow,
  // which are computed downstream) so the handler can be defined
  // alongside the other URL writers without lexical-order ceremony.
  const handlePartitionChange = useCallback(
    (targetTableId: string, partitionId: string) => {
      const next = new Map(selectedPartitionByTable)
      next.set(targetTableId, partitionId)
      setSelectedPartitionByTable(next)

      let nextDrawerRowId: string | null = drawerRowId
      if (drawerRowId !== null) {
        const openRow = data.rows.find((r) => r.id === drawerRowId)
        if (openRow !== undefined && openRow.targetField.targetTable.id === targetTableId) {
          // PR Ω.3.8 — open row may span N partitions; keep the drawer
          // open if any of them matches the new selection. Pre-Ω.3.8
          // fixtures may omit `tableMappingIds`; fall back to the
          // canonical scalar so existing tests still pass.
          const openRowPartitionIds =
            openRow.tableMappingIds ??
            (openRow.tableMappingId != null ? [openRow.tableMappingId] : [])
          if (!openRowPartitionIds.includes(partitionId)) {
            nextDrawerRowId = null
            setDrawerRowId(null)
            setDrawerHighlightedSourceFieldId(null)
          }
        }
      }

      writeUrl(filters, nextDrawerRowId, undefined, next)
    },
    [selectedPartitionByTable, drawerRowId, data.rows, filters, writeUrl],
  )

  // PR Ω.3.2.2 — flat view partition chip handler. Receives the
  // FULL new selection set (the chip's local state holds the
  // checkbox truth); we just commit it to page state + URL via the
  // standard override hatch. No drawer reconciliation needed — flat
  // view's drawer-row addressing is unaffected by partition-axis
  // filtering (rows hide/show but ids don't churn).
  const handleFlatPartitionSelectionChange = useCallback(
    (next: ReadonlySet<string>) => {
      setFlatPartitionSelection(new Set(next))
      writeUrl(filters, drawerRowId, undefined, undefined, next)
    },
    [filters, drawerRowId, writeUrl],
  )

  const handleOpenPartitionModal = useCallback(
    (
      args:
        | { kind: 'create'; targetTableId: string }
        | { kind: 'edit'; targetTableId: string; partition: PartitionInfo },
    ) => {
      setPartitionModalState({
        targetTableId: args.targetTableId,
        editing: args.kind === 'edit' ? args.partition : null,
      })
    },
    [],
  )

  const handleClosePartitionModal = useCallback(() => {
    setPartitionModalState(null)
  }, [])

  const handlePartitionSaved = useCallback(() => {
    // Server-side state changed (new TM, label edit, filter edit, etc.)
    // — pull fresh data so partitionsByTargetTable + row tableMappingId
    // values reflect the write. The modal closes itself via
    // `onClose` regardless.
    router.refresh()
  }, [router])

  // ─── PR Ω.3.2.1 — partition-delete handlers ──────────────────────
  //
  // Flow:
  //   1. User clicks "Delete partition" in PartitionRulesModal edit
  //      mode → `handleOpenDeleteDialog` captures the editing
  //      partition + targetTableId and opens the dialog. Modal stays
  //      open behind the dialog (PRMD4 contract — preserves form
  //      state if the user cancels).
  //   2. User confirms → `handleConfirmDelete` calls deletePartition
  //      with the dialog's force flag.
  //      - SUCCESS: pre-emptively close drawer if it was showing a
  //        row from the deleted partition (mirrors handlePartitionChange's
  //        drawer auto-close); reconcile selectedPartitionByTable
  //        (pick siblings[0] or clear); writeUrl once with the new
  //        state; router.refresh(); close both dialog + modal.
  //      - HAS_STAGED_ROWS: surface the count, switch dialog to the
  //        force-checkbox state. Drawer / selection unchanged.
  //      - Other error: surface the message in the dialog's inline
  //        error banner. Dialog stays open; user can retry or cancel.
  //   3. User cancels → `handleCancelDelete` closes the dialog only;
  //      modal stays open.

  const handleOpenDeleteDialog = useCallback(() => {
    if (!partitionModalState || !partitionModalState.editing) return
    setPartitionDeleteState({
      partition: partitionModalState.editing,
      targetTableId: partitionModalState.targetTableId,
      stagedRowsBlocking: null,
      errorMessage: null,
      saving: false,
    })
  }, [partitionModalState])

  const handleCancelDelete = useCallback(() => {
    if (partitionDeleteSavingRef.current) return
    setPartitionDeleteState(null)
  }, [])

  const handleConfirmDelete = useCallback(
    async ({ force }: { force: boolean }) => {
      if (partitionDeleteSavingRef.current) return
      if (!partitionDeleteState) return
      partitionDeleteSavingRef.current = true
      const { partition, targetTableId } = partitionDeleteState
      setPartitionDeleteState((prev) =>
        prev ? { ...prev, saving: true, errorMessage: null } : null,
      )
      try {
        const result = await deletePartition({
          tableMappingId: partition.id,
          force,
        })
        if (result.success) {
          // ── Drawer reconciliation ──
          // Mirrors handlePartitionChange's pre-emptive close: if the
          // drawer is showing a row that belonged to the just-deleted
          // partition, close it before the data refresh would catch
          // the stale id via the auto-close effect.
          let nextDrawerRowId: string | null = drawerRowId
          if (drawerRowId !== null) {
            const openRow = data.rows.find((r) => r.id === drawerRowId)
            if (
              openRow !== undefined &&
              openRow.tableMappingId === partition.id
            ) {
              setDrawerRowId(null)
              setDrawerHighlightedSourceFieldId(null)
              nextDrawerRowId = null
            }
          }

          // ── Selection reconciliation ──
          // If the deleted partition was the selected one for its
          // table, switch to siblings[0] (server-canonical order means
          // lowest-ordinal sibling) or clear the entry entirely when
          // no siblings remain (tab strip auto-hides under heritage
          // rule). Untouched when the deleted partition wasn't
          // selected.
          let nextSelection = selectedPartitionByTable
          const currentSelected = selectedPartitionByTable.get(targetTableId)
          if (currentSelected === partition.id) {
            const next = new Map(selectedPartitionByTable)
            const siblings = (
              data.partitionsByTargetTable?.[targetTableId] ?? []
            ).filter((p) => p.id !== partition.id)
            if (siblings.length === 0) {
              next.delete(targetTableId)
            } else {
              next.set(targetTableId, siblings[0].id)
            }
            setSelectedPartitionByTable(next)
            nextSelection = next
          }

          writeUrl(filters, nextDrawerRowId, undefined, nextSelection)
          router.refresh()
          setPartitionDeleteState(null)
          setPartitionModalState(null)
        } else if (result.errorCode === 'HAS_STAGED_ROWS') {
          // Switch dialog to the force-confirmation state. Defensive
          // fallback to 1 if the server didn't echo the count (the
          // action contract always includes it, but the dialog renders
          // sensible copy either way).
          setPartitionDeleteState((prev) =>
            prev
              ? {
                  ...prev,
                  stagedRowsBlocking: result.stagedRowsBlocking ?? 1,
                  saving: false,
                }
              : null,
          )
        } else {
          setPartitionDeleteState((prev) =>
            prev
              ? {
                  ...prev,
                  errorMessage: result.error ?? 'Delete failed',
                  saving: false,
                }
              : null,
          )
        }
      } finally {
        partitionDeleteSavingRef.current = false
      }
    },
    [
      partitionDeleteState,
      drawerRowId,
      data.rows,
      data.partitionsByTargetTable,
      selectedPartitionByTable,
      filters,
      writeUrl,
      router,
    ],
  )

  // PR 3b commit 3 — `handleFormDirtyChange` / `handleRestoreConsumed`
  // and the `CreateMappingFormSnapshot` import retired with
  // `CreateMappingForm`. Drawer no longer publishes form state.

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
  // PR 3b commit 3 — `handleDrawerSaveSuccess` retired with
  // `CreateMappingForm`. The form's create-mode and edit-mode save
  // callbacks were the only consumers; the new header-level inline
  // pickers fire their commit handlers directly through `mutations`,
  // which manages the post-save router.refresh + toast.

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

  // Optimistic-data overrides for the row data shape. Used by the three
  // reject paths (inline + bulk + drawer) to pre-apply the unmapped
  // shape BEFORE `router.refresh()` lands. Without this override, the
  // row continues to render its OLD mapped data during the fade-out
  // animation, then React unmount/remounts when the post-refresh data
  // swaps the React key from `tfm-<id>` to `unmapped::<targetFieldId>`
  // — producing a 200-500ms blank flash on the inline path and a
  // sub-perceptual blip on bulk + drawer. Pre-applying the unmapped
  // shape masks the unmount/remount because the override row already
  // looks like the post-reject row. The cleanup useEffect below drops
  // overrides whose rowId is no longer in `data.rows` (post-refresh
  // settle).
  const [optimisticData, setOptimisticData] = useState<
    Map<string, MappingRow>
  >(() => new Map())

  const writeOptimisticData = useCallback(
    (rowId: string, override: MappingRow) => {
      setOptimisticData((prev) => {
        const next = new Map(prev)
        next.set(rowId, override)
        return next
      })
    },
    [],
  )

  const clearOptimisticData = useCallback((rowId: string) => {
    setOptimisticData((prev) => {
      if (!prev.has(rowId)) return prev
      const next = new Map(prev)
      next.delete(rowId)
      return next
    })
  }, [])

  // Build the post-reject UnmappedRow shape used as a brief optimistic
  // override. Its ONLY job is to mask the mapped / value-assignment →
  // unmapped *shape transition* during a reject round-trip: the row's
  // React key swaps from the TFM id to `unmapped::<targetFieldId>`,
  // producing an unmount/remount blip that the pre-applied unmapped
  // shape hides.
  //
  // NOT written for rows that are already kind='unmapped' — see the
  // early return below. Such a row has no shape transition to mask, and
  // its row id is stable across the reject, so an override would leak
  // (the cleanup useEffect's drop conditions never match) and mask every
  // later server read, including a subsequent approve.
  //
  // status='needs_review': post-PR-#157, reject is reject-as-reset —
  // `neutralizeCoverageForReject` lands the target on a neutral
  // `needs_review`, with no distinct persisted `rejected` state. The
  // override pre-applies that same end state so the optimistic row
  // matches what the next server read returns. (Pre-#157 this emitted
  // 'rejected', mirroring a `coverage.status='rejected'` wire shape the
  // server no longer produces.)
  //
  // mapping_content='no-source' and statusSetBy='user' match the
  // optimistic intent: the user explicitly clicked reject, so the row
  // surfaces as user-driven until the server roundtrip settles.
  // coverageStatus is preserved from the original row when the
  // translator already attached one; otherwise null (orphan / target_only
  // case — no coverage row existed yet).
  const buildUnmappedOverride = useCallback(
    (rowId: string): MappingRow | null => {
      const row = data.rows.find((r) => r.id === rowId)
      if (!row) return null

      // Already-unmapped rows: no shape transition to mask, and the
      // override would leak on the stable `unmapped::<id>` row id. Defer
      // to the server round-trip — fast enough without an override.
      if (row.kind === 'unmapped') return null

      // `row` is narrowed to mapped | value_assignment by the early
      // return above — both carry aiReasoning / transformationIntent.
      const confidence = row.confidence ?? null
      const aiReasoning = row.aiReasoning ?? null
      const transformationIntent = row.transformationIntent ?? null
      return {
        id: row.id,
        targetField: row.targetField,
        kind: 'unmapped',
        status: 'needs_review',
        confidence,
        aiReasoning,
        transformationIntent,
        hasTransformation: false,
        transformationStatus: null,
        transformationDescription: null,
        transformationSqlPreview: null,
        mapping_content: 'no-source',
        coverageStatus: row.coverageStatus ?? null,
        statusSetBy: 'user',
      }
    },
    [data.rows],
  )

  // Drawer redesign PR 2 TASK 1.6 — single-source ✕ "Remove mapping"
  // flow. Distinct from the footer Reject button: the user wants the
  // drawer to STAY OPEN and transition to the unmapped variant for
  // the same target field (so the banner explaining the just-unmapped
  // state has somewhere to render, and a follow-up FROM-click can
  // re-map the field without re-opening the drawer).
  //
  // Mechanics mirror `handleDrawerSaveSuccess`:
  //   1. Compute the new drawerRowId (`unmapped::<targetFieldId>`).
  //   2. Apply `buildUnmappedOverride(oldTfmId)` so the row currently
  //      rendered as mapped immediately morphs into the unmapped
  //      shape — no flicker between the TFM-gone state and the new
  //      unmapped row arriving.
  //   3. Arm the `pendingDrawerRowId` sentinel — the new id isn't in
  //      `data.rows` until `router.refresh()` rehydrates, but the
  //      stale-id auto-close effect (lines 556-578) skips when the
  //      sentinel matches.
  //   4. Swap URL + state to the new id.
  //   5. Call `mutations.rejectTfm` which dispatches
  //      `rejectFieldMapping` server-side AND fires `router.refresh()`
  //      on success.
  const handleUnmapMapping = useCallback(
    async (tfmId: string, targetFieldId: string) => {
      const newRowId = `unmapped::${targetFieldId}`
      const override = buildUnmappedOverride(tfmId)
      if (override) writeOptimisticData(tfmId, override)
      setPendingDrawerRowId(newRowId)
      setDrawerRowId(newRowId)
      writeUrl(filters, newRowId)
      return mutations.rejectTfm(tfmId)
    },
    [
      buildUnmappedOverride,
      filters,
      mutations,
      writeOptimisticData,
      writeUrl,
    ],
  )

  // feat/drawer-body-editing-surface — create a TFM from the drawer's
  // unmapped-target variant via the body's "Pick a source…" affordance.
  // `mutations.createFromUnmapped` clears any coverage rejection AND
  // auto-approves the new TFM.
  //
  // Promotion continuity: the unmapped-target row (`unmapped::<tf>`)
  // becomes a real TFM with a new id. We re-point `drawerRowId` at the
  // returned TFM id and arm the `pendingDrawerRowId` sentinel — the
  // SAME machinery `handleUnmapMapping` uses — so `effectiveDrawerRow`
  // holds the drawer open across the `router.refresh()` window and the
  // stale-id auto-close effect skips. The drawer follows the row
  // through its identity change rather than closing.
  const handleCreateMapping = useCallback(
    async (sourceFieldId: string, targetFieldId: string) => {
      const result = await mutations.createFromUnmapped({
        sourceFieldId,
        targetFieldId,
        pendingKey: `unmapped::${targetFieldId}`,
      })
      if (result.success && result.tfmId) {
        setPendingDrawerRowId(result.tfmId)
        setDrawerRowId(result.tfmId)
        writeUrl(filters, result.tfmId)
      }
      return result
    },
    [mutations, filters, writeUrl],
  )

  // feat/drawer-body-editing-surface — promote an unmapped-source row
  // (drawer source-field stub) to a mapped row via the stub's "Pick a
  // target…" affordance. `mutations.promoteUnmappedSource` creates a
  // new 1:1 TFM (target unmapped) or appends the source to the existing
  // TFM (target already mapped); either way it returns the resolved TFM
  // id. Drawer continuity is identical to `handleCreateMapping` — reuse
  // the `pendingDrawerRowId` sentinel, no parallel path.
  const handlePromoteSource = useCallback(
    async (sourceFieldId: string, targetFieldId: string) => {
      // PR Ω.3.x.1 — cross-table intercept now lives inside
      // `mutations.promoteUnmappedSource` so the flat view's target
      // picker (`MappingListView.handleTargetPickerCommit`) is covered
      // alongside this drawer entry point. On intercept the hook parks
      // the popup and returns `{ success: true }` with no `tfmId` —
      // we skip the drawer re-point in that branch (the disambiguation
      // dialog drives the next step).
      const result = await mutations.promoteUnmappedSource({
        sourceFieldId,
        targetFieldId,
        pendingKey: `unmapped-source::${sourceFieldId}`,
      })
      if (result.success && result.tfmId) {
        setPendingDrawerRowId(result.tfmId)
        setDrawerRowId(result.tfmId)
        writeUrl(filters, result.tfmId)
      }
      return result
    },
    [mutations, filters, writeUrl],
  )

  // Drawer redesign PR 2 TASK 2+3 — target ✏ on unmapped/rejected
  // variants does NOT swap a target on a TFM (there is no TFM to
  // swap). The user picks a different target field and the drawer
  // navigates to that target's row. Client-only — no server action.
  //
  // The new rowId depends on whether the picked target field already
  // has a TFM:
  //   • mapped / VA TFM exists → new rowId is the TFM uuid
  //   • no TFM (unmapped) → new rowId is `unmapped::<targetFieldId>`
  // Resolve via `data.rows` (one row per target field per the
  // server contract).
  const handleNavigateTarget = useCallback(
    async (newTargetFieldId: string) => {
      const newRow = data.rows.find(
        (r) => r.targetField.id === newTargetFieldId,
      )
      if (!newRow) return { success: false }
      setDrawerRowId(newRow.id)
      writeUrl(filters, newRow.id)
      return { success: true }
    },
    [data.rows, filters, writeUrl],
  )

  // Cleanup safety net — drop overrides under two conditions:
  //   (a) the rowId is no longer present in data.rows (post-refresh:
  //       TFM successfully rejected, key dissolved into
  //       `unmapped::<targetFieldId>`), OR
  //   (b) the rowId is present but its kind disagrees with the
  //       override's `unmapped` claim (server didn't reject the row —
  //       partial-bulk-failure, scope mismatch, or any future code
  //       path that wrote an override the server didn't follow
  //       through on). Defer to server data in this case.
  // Concurrent-reject race: an override for a row whose server action
  // hasn't completed by the next refresh stays in the map only if the
  // intervening refresh's data still shows the row at its original
  // kind — at which point (b) clears it. The next user-action refresh
  // re-applies if needed.
  useEffect(() => {
    setOptimisticData((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const rowId of Array.from(next.keys())) {
        const row = data.rows.find((r) => r.id === rowId)
        if (!row || row.kind !== 'unmapped') {
          next.delete(rowId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [data.rows])

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
        // Pre-apply unmapped overrides for every row about to be
        // rejected. Eliminates the brief unmount/remount blip when
        // router.refresh() lands and React swaps the keys from
        // `tfm-<id>` to `unmapped::<targetFieldId>` on each row.
        //
        // Scope MUST mirror the server's
        // `bulkRejectFieldMappingsForTargetTable` filter exactly:
        // status='needs_review', is_acknowledged=false, on the
        // target table. Wider client scope (e.g. omitting the
        // status filter) writes overrides on rows the server does
        // NOT reject — approved mappings would visually "go
        // unmapped" without the server actually deleting the TFM,
        // and the override would stick until a subsequent user
        // action triggered another data.rows update. The cleanup
        // useEffect's kind-mismatch branch (Fix 2) does drop these
        // stale overrides on the next refresh, but the correct
        // primary defense is to never write them in the first
        // place.
        //
        // Partial-failure rows (per-TFM transform reset failed —
        // server kept them mapped) are handled by the cleanup
        // useEffect on the post-refresh data.rows: the override
        // claims unmapped but the row's settled kind is still
        // 'mapped', so cleanup drops the override. Fix 2 makes
        // this self-healing without requiring a subsequent user
        // action.
        const targetTableId = bulkAction.targetTableId
        for (const r of data.rows) {
          if (
            (r.kind === 'mapped' || r.kind === 'value_assignment') &&
            r.status === 'needs_review' &&
            r.targetField.targetTable.id === targetTableId
          ) {
            const ovr = buildUnmappedOverride(r.id)
            if (ovr) writeOptimisticData(r.id, ovr)
          }
        }
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
  }, [bulkAction, bulkPreviewCount, projectId, pushToast, router, data.rows, buildUnmappedOverride, writeOptimisticData])

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

  // Lifted per-row UI state. Necessary because the mapping row list
  // is virtualized for large groups (TargetTableGroup wraps the row
  // list with @tanstack/react-virtual when row count >= threshold);
  // local useState inside FieldMappingRow would be lost when the row
  // unmounts during scroll. Lifting here mirrors the same Map<rowId,
  // value> pattern as `optimisticData` above.
  //
  //   * expandedRowIds: per-row chevron-expansion (multiple rows may
  //     be expanded at once).
  //   * pickerOpenRowId: at most one inline source picker open at a
  //     time, so a single rowId is sufficient.
  //
  // Both are reconciled against `data.rows` via the cleanup useEffects
  // below so stale entries don't accumulate after a router.refresh.
  const [expandedRowIds, setExpandedRowIds] = useState<
    Map<string, boolean>
  >(() => new Map())
  const [pickerOpenRowId, setPickerOpenRowId] = useState<string | null>(
    null,
  )

  const handleExpandedChange = useCallback(
    (rowId: string, next: boolean) => {
      setExpandedRowIds((prev) => {
        const m = new Map(prev)
        if (next) m.set(rowId, true)
        else m.delete(rowId)
        return m
      })
    },
    [],
  )

  // Cleanup: drop expandedRowIds entries whose rowId is no longer in
  // data.rows (post-refresh: the row was rejected, dissolved into an
  // unmapped::<targetFieldId> sentinel that has a different id; the
  // old expansion flag would otherwise leak forever).
  useEffect(() => {
    setExpandedRowIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      let changed = false
      for (const rowId of Array.from(next.keys())) {
        if (!data.rows.find((r) => r.id === rowId)) {
          next.delete(rowId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [data.rows])

  // Cleanup: close the inline source picker when its anchor row
  // dissolves from data.rows (Issue 2 fix for InlineSourcePicker —
  // its anchorRef points into row DOM that disappears on refresh).
  useEffect(() => {
    if (pickerOpenRowId === null) return
    if (!data.rows.find((r) => r.id === pickerOpenRowId)) {
      setPickerOpenRowId(null)
    }
  }, [data.rows, pickerOpenRowId])

  // Cleanup: close the reject confirmation popover when its anchor row
  // dissolves from data.rows (Issue 2 fix for RejectConfirmPopover —
  // same anchor-detachment concern as InlineSourcePicker, both
  // resolved with symmetric coverage so neither path lingers with a
  // stale DOM ref).
  useEffect(() => {
    if (rejectAnchor === null) return
    if (!data.rows.find((r) => r.id === rejectAnchor.rowId)) {
      setRejectAnchor(null)
    }
  }, [data.rows, rejectAnchor])

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

  // Approve optimism must persist until fresh server data confirms the
  // row is actually approved. Clearing on a fixed timer causes a brief
  // revert back to needs_review when router.refresh() takes longer than
  // the animation window.
  useEffect(() => {
    setOptimisticStates((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Map(prev)
      for (const [rowId, state] of prev.entries()) {
        if (state !== 'approving') continue
        const serverRow = data.rows.find((r) => r.id === rowId)
        if (serverRow?.status === 'approved') {
          next.delete(rowId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [data.rows])

  // Page-level derived row state used by filters, grouping, and summary
  // counts. Mirrors the same optimistic contract users see at the row
  // level:
  //   - `optimisticData` pre-applies structural row-shape changes
  //     (reject → unmapped, etc.)
  //   - `optimisticStates='approving'` should read as approved
  //     immediately in aggregate counts, not only after router.refresh()
  const effectiveRows = useMemo(() => {
    return data.rows.map((row) => {
      const optimisticRow = optimisticData.get(row.id) ?? row
      const optimisticState = optimisticStates.get(row.id)
      if (
        optimisticState === 'approving' &&
        optimisticRow.status !== 'approved'
      ) {
        return { ...optimisticRow, status: 'approved' as const }
      }
      return optimisticRow
    })
  }, [data.rows, optimisticData, optimisticStates])

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
    // Pre-apply the unmapped shape so the row visually settles to its
    // post-reject identity BEFORE the fade-out + key-swap. Eliminates
    // the 200-500ms blank flash users saw between the fade-out and the
    // post-refresh unmapped render.
    const override = buildUnmappedOverride(rowId)
    if (override) writeOptimisticData(rowId, override)
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
        clearOptimisticData(rowId)
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
      // The cleanup useEffect drops the optimisticData override once
      // data.rows no longer contains the rowId (post-refresh settle).
      //
      // `clearOptimistic` rides the same 200ms hook. Unlike 'approving'
      // — which the [data.rows] effect above drops once the row reads
      // back `status='approved'` — the 'rejecting' optimisticState has
      // no data-driven clear: reject does not always produce an
      // observable delta. A `needs_review` unmapped-target row rejected
      // under the post-#157 reject-as-reset semantic stays
      // `needs_review` at the same stable `unmapped::<targetFieldId>`
      // id, so no [data.rows] effect can detect the reject settled.
      // Clearing here (mirrors the 'mapping' state's own 200ms clear)
      // returns the row to its enabled, non-sliding state once the cue
      // has played; for mapped-row rejects it also drops the
      // previously-harmless stale entry keyed by the now-dead TFM id.
      setTimeout(() => {
        router.refresh()
        clearOptimistic(rowId)
      }, 200)
    } catch (err) {
      pushToast({
        id: `inline-reject-${rowId}-${Date.now()}`,
        variant: 'error',
        message: err instanceof Error ? err.message : 'Could not reject mapping.',
      })
      clearOptimistic(rowId)
      clearOptimisticData(rowId)
    }
  }, [
    rejectAnchor,
    setOptimistic,
    clearOptimistic,
    pushToast,
    router,
    buildUnmappedOverride,
    writeOptimisticData,
    clearOptimisticData,
  ])

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

      // ── PR Ω.3.x.1 — cross-table disambiguation intercept ───────────
      // Same-source-table additions short-circuit to the silent-combine
      // path below (`editMappingSources` with `concat_space`). Cross-
      // source-table additions park the disambiguation popup; the picker
      // closes (return success: true) so the dialog has a clean surface.
      //
      // Only mapped rows can reach the intercept — unmapped rows have no
      // existing mapping to disambiguate against, so the server-side
      // `allowCrossTable` guard handles cross-table commits at the
      // wrapper layer instead. Same-source-table commits and removal-
      // only edits flow unchanged.
      if (row.kind === 'mapped') {
        const existingSourceFieldIds = new Set(
          row.sources.map((s) => s.sourceField.id),
        )
        const existingTableIds = new Set(
          row.sources.map((s) => s.sourceTable.id),
        )
        const newSourceFieldIds = finalIds.filter(
          (id) => !existingSourceFieldIds.has(id),
        )
        const newCrossTableSource = newSourceFieldIds
          .map((id) => data.sourceFields.find((f) => f.id === id))
          .find(
            (sf) =>
              sf !== undefined && !existingTableIds.has(sf.sourceTable.id),
          )
        if (newCrossTableSource !== undefined) {
          mutations.openPendingDisambiguation({
            rowId,
            existingTfmId: row.id,
            targetFieldId: row.targetField.id,
            targetFieldName: row.targetField.name,
            existingSources: row.sources.map((s) => ({
              id: s.id,
              sourceFieldName: s.sourceField.name,
              sourceTableName: s.sourceTable.name,
            })),
            incomingSource: {
              sourceFieldId: newCrossTableSource.id,
              sourceFieldName: newCrossTableSource.name,
              sourceTableName: newCrossTableSource.sourceTable.name,
            },
          })
          return { success: true }
        }
      }

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
    [
      data.rows,
      data.sourceFields,
      mutations,
      projectId,
      setOptimistic,
      clearOptimistic,
      pushToast,
      router,
    ],
  )

  const handleDrawerActionComplete = useCallback(
    (action: 'approve' | 'reject' | 'reset', rowId: string) => {
      // Phase 3 Gap 11b — clear the sidebar highlight after any
      // drawer action. Reject deletes the TFM (the highlighted row
      // identity dissolves on the server), so a stale highlight
      // would point at a row id that no longer exists. Approve
      // preserves identity but also clears the highlight — mild
      // over-clearing is acceptable per the founder's "additional
      // concern" decision in the Gap 11b alignment.
      //
      // INF-57 cleanup — `reset` (un-approve via resetMappingStatus)
      // mirrors reject's drawer-close + URL-clear behavior: the row
      // visually transitions from approved → needs_review and the
      // user expects the drawer to close on confirm.
      onClearHighlight()
      // Drawer-reject path equivalent of the inline override — pre-
      // apply the unmapped shape on the underlying row so it doesn't
      // blip during the unmount/remount when router.refresh() lands.
      // Reset intentionally not covered (the row identity is preserved
      // and the next refresh resolves it from the coverage row).
      if (action === 'approve') {
        setOptimistic(rowId, 'approving')
      }
      if (action === 'reject') {
        const override = buildUnmappedOverride(rowId)
        if (override) writeOptimisticData(rowId, override)
      }
      router.refresh()
      if (action === 'reject' || action === 'reset') {
        setDrawerRowId(null)
        writeUrl(filters, null)
      }
    },
    [
      router,
      filters,
      writeUrl,
      onClearHighlight,
      buildUnmappedOverride,
      setOptimistic,
      writeOptimisticData,
    ],
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
    () => filterRows(effectiveRows, filters),
    [effectiveRows, filters],
  )

  // feat/mapping-filter-bugs-ordering — the flat list view consumes the
  // UNFILTERED effective result and applies `filterFlatRows` itself,
  // over the canonical `flattenRowsForListView` projection. This is the
  // fix for the source/target/status filters silently ignoring the
  // synthesised `unmapped-source` rows: those rows exist only after
  // flattening, so filtering must happen there — not on the wire
  // `MappingRow[]` via `filterRows` (which the target-led view still
  // uses). `effectiveRows` carries the optimistic overrides.
  const effectiveResult = useMemo<MappingsForRedesignResult>(
    () => ({ ...data, rows: effectiveRows }),
    [data, effectiveRows],
  )

  const handleFlatOpenDrawer = useCallback(
    (rowId: string, hsfId: string | null) => {
      setDrawerHighlightedSourceFieldId(hsfId)
      handleRowClick(rowId)
    },
    // handleRowClick captured separately; declared further down. Its
    // own dep array keeps this stable across renders that don't change
    // the row-click context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Phase 3 Gap 7 — derive the open drawer row from `drawerRowId`. We
  // require the row to be present in `filteredRows` (not just `data.rows`)
  // so the founder rule "filter that hides the open row closes the drawer"
  // is enforced as a single derivation rather than a side-effecting
  // `useEffect`. `useMemo` keeps the lookup cheap; an actual auto-close
  // (URL clean-up + state reset) fires from a sibling `useEffect` below.
  //
  // feat/mapping-row-uniformity — the lookup now ALSO recognizes
  // source-side flat-row ids (`unmapped-source::<sfId>` and
  // `ack::source::<ackId>`) and projects them into a
  // `SourceFieldDrawerRow` for the drawer's stub source-side mount.
  // The projection lives off `data.sourceFields` +
  // `data.sourceFieldAcknowledgments` — the same shapes
  // `flattenRowsForListView` consumes — so the drawer mirrors the
  // flat view's row identity without a wire-shape change.
  const drawerRow = useMemo<DrawerRow | null>(() => {
    if (drawerRowId === null) return null
    const sourceSide = resolveSourceSideDrawerRow(drawerRowId, data)
    if (sourceSide) return sourceSide
    return filteredRows.find((r) => r.id === drawerRowId) ?? null
  }, [drawerRowId, filteredRows, data])

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
  const lastValidDrawerRowRef = useRef<DrawerRow | null>(null)
  useEffect(() => {
    if (drawerRow !== null) {
      lastValidDrawerRowRef.current = drawerRow
    }
  }, [drawerRow])

  // Effective row passed to `<MappingDrawer>`. Falls back to the last
  // valid row only inside the pending sentinel window — never used as
  // a generic fallback (which would mask filter-hide and stale-URL
  // bugs).
  const effectiveDrawerRow = useMemo<DrawerRow | null>(() => {
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
   * PR Ω.3.2 — partition filter pipeline extension.
   *
   * Applied AFTER the search/status/target/source filter pass and
   * BEFORE per-table grouping, so a partition selection narrows the
   * visible rows in its target table without affecting any other
   * group. Heritage projects have an empty `selectedPartitionByTable`
   * and short-circuit to byte-identical behaviour (returns the same
   * array reference, so downstream memo identity is preserved).
   *
   * Only target-led rendering is affected. The flat (list) view
   * consumes `effectiveResult` directly and runs its own filter
   * machinery in `MappingListView`; partition filtering for flat view
   * is a deferred follow-up.
   */
  const partitionFilteredRows = useMemo(() => {
    if (selectedPartitionByTable.size === 0) return filteredRows
    return filteredRows.filter((r) => {
      const sel = selectedPartitionByTable.get(r.targetField.targetTable.id)
      if (sel === undefined) return true
      // PR Ω.3.8 — a row may span N partitions (`tableMappingIds[]`).
      // Match when the selected partition is in the row's set. Fall back
      // to the canonical scalar for pre-Ω.3.8 fixtures.
      const ids =
        r.tableMappingIds ??
        (r.tableMappingId != null ? [r.tableMappingId] : [])
      return ids.includes(sel)
    })
  }, [filteredRows, selectedPartitionByTable])

  /**
   * Group partition-filtered rows by target-table id WHILE preserving
   * server order. We rely on Map insertion order (the server emits rows
   * sorted by targetTable.name ASC + ordinalPosition ASC), so the Map's
   * native iteration yields groups in canonical order too.
   *
   * CONTRACT: NO client-side sort anywhere in this module. The no-client-
   * sort guard test (tests/lib/no-shim-in-redesign-path.test.ts) will
   * fail if anyone adds `.sort(` to this path.
   */
  const groupedRows = useMemo(
    () => groupRowsByTargetTable(partitionFilteredRows),
    [partitionFilteredRows],
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
        !isGroupHiddenByIdentityFilters(summary.id, filters, effectiveRows) &&
        !isGroupHiddenBySearch(summary.id, filters, effectiveRows),
    )
  }, [hideEmpty, data.targetTables, effectiveRows, filters])

  // Phase 4c-1 — per-target-table needs-review counts. Drives the
  // kebab item's enabled/disabled state and subtitle. Iterated once
  // over `data.rows` rather than per-group inside the render loop
  // (avoids O(n×m) work on every interaction). Bulk wrapper scope is
  // hard-coded `status='needs_review' AND is_acknowledged=false`;
  // legacy bare-ack TFMs surface as `kind: 'unmapped'` post-INF-57, so
  // filtering by `kind === 'mapped' || 'value_assignment'` AND
  // `status === 'needs_review'` matches the server's WHERE clause exactly.
  const needsReviewCountByTable = useMemo(() => {
    const m = new Map<string, number>()
    for (const row of effectiveRows) {
      if (row.kind !== 'mapped' && row.kind !== 'value_assignment') continue
      if (row.status !== 'needs_review') continue
      const tableId = row.targetField.targetTable.id
      m.set(tableId, (m.get(tableId) ?? 0) + 1)
    }
    return m
  }, [effectiveRows])

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
    for (const row of effectiveRows) {
      if (row.kind !== 'mapped' && row.kind !== 'value_assignment') continue
      if (row.status !== 'needs_review') continue
      if ((row.confidence ?? 0) < HIGH_CONFIDENCE_THRESHOLD) continue
      n++
    }
    return n
  }, [effectiveRows])

  // Strip Approved / Needs Review chips. Counted over the flat-row
  // projection — `flattenRowsForListView` folds in the source-side
  // rows (acks + pure unmapped source fields) that never appear in
  // `data.rows`. Iterating `data.rows`/`effectiveRows` directly omitted
  // every `unmapped-source` row, so the chips silently undercounted
  // (Rootstock POC: Needs Review showed 87 — the target-keyed rows
  // only — while the unmapped source fields went uncounted). Counting
  // over the flattened projection makes the chips reflect all four row
  // kinds: mapped, value_assignment, unmapped-target, unmapped-source.
  // `effectiveRows` is threaded in (not `data.rows`) so optimistic
  // approve/reject state still flows through for target-keyed rows.
  // Post-#157/#158/A2 'rejected' no longer carries a semantic distinct
  // from 'needs_review' (Reject = reset). The Needs Review chip folds in
  // `status === 'rejected'` rows so legacy SimpleLegal mapped+rejected
  // data is tallied alongside needs_review rather than dropping out of
  // both chips. Approved counts only `status === 'approved'`.
  const effectiveCounts = useMemo(() => {
    const flatRows = flattenRowsForListView({ ...data, rows: effectiveRows })
    return {
      total: flatRows.length,
      ...countFlatRowStatuses(flatRows),
    }
  }, [data, effectiveRows])

  // Opens the drawer on the first needs-review flat row — used by the
  // FilterRow's "Review fields →" / "Resume · N left →" CTA.
  const handleReviewFieldsClick = useCallback(() => {
    const flatRows = flattenRowsForListView({ ...data, rows: effectiveRows })
    const firstNeedsReview = flatRows.find((r) => r.status !== 'approved')
    if (firstNeedsReview) {
      setDrawerRowId(firstNeedsReview.id)
      writeUrl(filters, firstNeedsReview.id)
    }
  }, [data, effectiveRows, filters, writeUrl])

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
          {/* Design reskin: the page-level toolbar is now the design's status
              strip + the "Mapping & Transformation Spec" section header (with
              the Map & Transform / Data Preview toggle), matching the Settle
              MVP Configure screen. */}
          <StatusStrip />
          <SpecHeaderRow value={specTab} onChange={setSpecTab} />
          {/* Data Preview carries its own toolbar (`<MockDataPreview>`), so the
              Map & Transform filter row is suppressed on that tab. */}
          {specTab === 'map' && (
            <FilterRow
              filters={filters}
              onFiltersChange={handleFiltersChange}
              targetTables={data.targetTables}
              sourceTables={data.sourceTables}
              highConfidenceCount={highConfidenceCount}
              onApproveHighConfidenceClick={handleApproveHighConfidenceClick}
              partitionsByTargetTable={data.partitionsByTargetTable}
              partitionsEnabled={data.partitionsEnabled}
              selectedFlatPartitionIds={flatPartitionSelection}
              onFlatPartitionIdsChange={handleFlatPartitionSelectionChange}
              reviewedCount={USE_REAL_SPEC_TABLE ? effectiveCounts.approved : 0}
              totalReviewable={USE_REAL_SPEC_TABLE ? effectiveCounts.total : 50}
              onReviewFieldsClick={handleReviewFieldsClick}
            />
          )}
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
        {/* SourceSchemaSidebar removed at the
            feat/mapping-list-toggle-and-columns refinement pass per
            the Linear-style polish brief — the rotated "Source
            fields | N" collapsed-state label was redundant chrome
            and the count is already surfaced in the summary chip. */}
        <div
          ref={scrollContainerRef}
          className="relative flex-1 overflow-auto"
        >
          {/*
            Body reading column. `py-6` provides 24px top + 24px bottom
            breathing room around the group cards. The toolbar above
            (Strip + FilterRow), when shown, is full-width and outside
            this column; the column only governs the body content's
            reading width.
          */}
          {/* Both views share the same horizontal width
              (feat/mapping-list-toggle-and-columns refinement pass)
              — the prior `max-w-5xl mx-auto` on target-led made it
              read narrower than Mapping First and felt inconsistent
              across the toggle. */}
          <div className="w-full px-6 py-6">
            {isEmptyMappingState ? (
              <EmptyMappingState projectId={projectId} data={data} />
            ) : !USE_REAL_DATA_PREVIEW && specTab === 'data' ? (
              <MockDataPreview />
            ) : viewMode === 'flat' ? (
              <MappingListView
                filteredResult={effectiveResult}
                filters={filters}
                mutations={mutations}
                onOpenDrawer={handleFlatOpenDrawer}
                flatPartitionSelection={flatPartitionSelection}
              />
            ) : visibleTargetTables.length === 0 ? (
              <NoGroupsMatchState />
            ) : (
              <div className="flex flex-col gap-4">
                {visibleTargetTables.map((summary) => {
                  const rowsInGroup = groupedRows.get(summary.id) ?? []
                  const perGroup = perGroupCounts.get(summary.id)
                  const partitionsForTable =
                    data.partitionsByTargetTable?.[summary.id] ?? []
                  return (
                    <TargetTableGroup
                      key={summary.id}
                      targetTable={summary}
                      rows={rowsInGroup}
                      scrollContainerRef={scrollContainerRef}
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
                      optimisticData={optimisticData}
                      expandedRowIds={expandedRowIds}
                      onExpandedChange={handleExpandedChange}
                      pickerOpenRowId={pickerOpenRowId}
                      onPickerOpenChange={setPickerOpenRowId}
                      onInlineApprove={handleInlineApprove}
                      onInlineReject={handleInlineRejectClick}
                      onInlineSourceCommit={handleInlineSourceCommit}
                      partitions={partitionsForTable}
                      selectedPartitionId={
                        selectedPartitionByTable.get(summary.id) ?? null
                      }
                      onPartitionChange={(partitionId) =>
                        handlePartitionChange(summary.id, partitionId)
                      }
                      partitionsEnabled={data.partitionsEnabled ?? false}
                      onOpenPartitionModal={handleOpenPartitionModal}
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
        pathDOutputs={pathDOutputs}
        highlightedSourceFieldId={drawerHighlightedSourceFieldId}
        availableTargetFields={availableTargetFields}
        onSwapTarget={mutations.swapMappingTarget}
        onSwapSource={mutations.swapMappingSource}
        onEditSources={mutations.editMappingSources}
        onUnmapMapping={handleUnmapMapping}
        onCreateMapping={handleCreateMapping}
        onNavigateTarget={handleNavigateTarget}
        onPromoteSource={handlePromoteSource}
      />

      {/*
        Target-field-swap MERGE confirmation. A single global instance
        driven by `mutations.pendingMerge` — set when a swap onto an
        already-mapped target returns MERGE_REQUIRED. Hosted here so
        both swap entry points (the flat-view inline picker and the
        drawer pencil) share one dialog surface.
      */}
      <MergeTargetDialog
        pendingMerge={mutations.pendingMerge}
        isPending={mutations.isMergePending}
        onConfirm={mutations.confirmPendingMerge}
        onCancel={mutations.cancelPendingMerge}
      />

      {/*
        PR Ω.3.x.1 — cross-source-table disambiguation. Single global
        instance driven by `mutations.pendingDisambiguation`, parked by
        the cross-table intercepts in `handleInlineSourceCommit` (inline
        picker + drawer multi-source editor) and `handlePromoteSource`
        (drawer "Pick a target"). Same-source-table additions never
        reach this dialog — they short-circuit to silent combine via
        `editMappingSources`.
      */}
      <SourceDisambiguationDialog
        pending={mutations.pendingDisambiguation}
        isPending={mutations.isDisambiguationPending}
        onCreateSeparate={mutations.confirmDisambiguatedCreate}
        onReplace={mutations.confirmDisambiguatedReplace}
        onCancel={mutations.cancelPendingDisambiguation}
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

      {/*
        PR Ω.3.2 — single page-level mount for the partition
        create/edit modal. Renders nothing when no group has requested
        it (state is null). Identity-field options are derived per-table
        from `data.rows` so the modal only offers fields under the
        target table whose partition we're editing.
      */}
      {partitionModalState !== null
        ? (() => {
            const { targetTableId, editing } = partitionModalState
            const targetTableName =
              data.targetTables.find((t) => t.id === targetTableId)?.name ?? ''
            // Identity-field options: dedupe target fields in this
            // table off `data.rows` (each field appears once per
            // partition; one entry per field is enough).
            const seenFieldIds = new Set<string>()
            const identityFieldOptions: { id: string; name: string }[] = []
            for (const r of data.rows) {
              if (r.targetField.targetTable.id !== targetTableId) continue
              if (seenFieldIds.has(r.targetField.id)) continue
              seenFieldIds.add(r.targetField.id)
              identityFieldOptions.push({
                id: r.targetField.id,
                name: r.targetField.name,
              })
            }
            const siblings =
              data.partitionsByTargetTable?.[targetTableId] ?? []
            return (
              <PartitionRulesModal
                projectId={projectId}
                targetTableId={targetTableId}
                targetTableName={targetTableName}
                sourceTables={data.sourceTables.map((t) => ({
                  id: t.id,
                  name: t.name,
                  datasetName: t.datasetName,
                }))}
                identityFieldOptions={identityFieldOptions}
                siblings={siblings}
                editing={editing}
                open={true}
                onClose={handleClosePartitionModal}
                onSaved={handlePartitionSaved}
                onDelete={handleOpenDeleteDialog}
              />
            )
          })()
        : null}

      {/*
        PR Ω.3.2.1 — page-level partition-delete confirmation dialog.
        Renders on top of the PartitionRulesModal (which stays mounted
        behind it per PRMD4) so the user's form state is preserved if
        they cancel out of the deletion. State machine + action
        dispatch live in handleConfirmDelete above.
      */}
      {partitionDeleteState !== null ? (
        <PartitionDeleteConfirmDialog
          open={true}
          onOpenChange={(next) => {
            if (!next) handleCancelDelete()
          }}
          partition={partitionDeleteState.partition}
          stagedRowsBlocking={partitionDeleteState.stagedRowsBlocking}
          errorMessage={partitionDeleteState.errorMessage}
          saving={partitionDeleteState.saving}
          onCancel={handleCancelDelete}
          onConfirm={handleConfirmDelete}
        />
      ) : null}
    </>
  )
}

// ─── Empty / error states ────────────────────────────────────────────────────
// (Phase 4-polish-1 founder Q2: CountersRow retired. Project-level chip
// rendering moved to `MappingSummaryStrip` at the page-header layer with
// restored legacy density. The §9 Q6 Rejected gating and the Phase 3
// Gap 13 Unmapped gating are preserved verbatim there.)
//

// Design status strip (Settle MVP Configure screen). STUB: the metric values
// are placeholders pending real wiring (mapping completeness, review progress,
// issue/rule/glossary counts span several subsystems). Page-level toolbar row,
// aligned to FilterRow's `px-5` gutter; items are non-navigating for now.
interface GlossaryEntry {
  name: string
  side: 'target' | 'source'
  ctx: string
  def: string
  samples: string[]
}

interface GlossaryGroup {
  table: string
  entries: GlossaryEntry[]
}

const GLOSSARY: GlossaryGroup[] = [
  { table: 'Commodity Codes', entries: [
    { name: 'commodity_code', side: 'target', ctx: 'Commodity Codes', def: 'Primary key for a commodity in Rootstock; the natural commodity code.', samples: ['RCB-PRINT-SLEEVE', 'RCB-PRINT-CUP', 'RCB-CONSUMABLE-INK'] },
    { name: 'COMM_CD', side: 'source', ctx: 'COMMODITY_MASTER', def: 'Prosys commodity code; carried forward unchanged as commodity_code.', samples: ['RCB-PRINT-SLEEVE', 'RCB-PRINT-CUP', 'RCB-CONSUMABLE-INK'] },
    { name: 'description', side: 'target', ctx: 'Commodity Codes', def: 'Human-readable commodity description, trimmed of trailing whitespace.', samples: ['Printed Sleeves', 'Printed Cups', 'Inks & Consumables'] },
    { name: 'commodity_class', side: 'target', ctx: 'Commodity Codes', def: 'Full class name resolved from the legacy class code via lookup.', samples: ['Finished Goods', 'Raw Materials', 'Finished Goods'] },
    { name: 'default_gl_account', side: 'target', ctx: 'Commodity Codes', def: 'Default general-ledger account for the commodity, resolved via gl_map.', samples: ['4000-COGS', '5100-MAT', '4000-COGS'] },
    { name: 'is_active', side: 'target', ctx: 'Commodity Codes', def: 'Whether the commodity is active; cast from the Y/N source flag.', samples: ['true', 'true', 'false'] },
  ] },
  { table: 'Engineering Item Master', entries: [
    { name: 'item_number', side: 'target', ctx: 'Engineering Item Master', def: 'Primary key for an engineering item; from the assembly item or part number.', samples: ['P-DWS', 'P-WHC08', 'WHC08'] },
    { name: 'ASSY_ITEM', side: 'source', ctx: 'BOM_MASTERS', def: 'Assembly item number from Engineering BOM Masters (Partition A).', samples: ['P-DWS', 'P-WHC08', 'WHC08'] },
    { name: 'item_description', side: 'target', ctx: 'Engineering Item Master', def: 'Item description; COALESCE(ProductName, Assy Desc).', samples: ['Full Wrap Custom Printed White Sleeves', '8oz Custom Printed White Paper Hot Cups', 'Blank 8oz White Paper Hot Cups'] },
    { name: 'commodity_code', side: 'target', ctx: 'Engineering Item Master', def: 'Derived commodity classification; resolved against Commodity Codes.', samples: ['RCB-PRINT-SLEEVE', 'RCB-PRINT-CUP', 'RCB-BLANK-CUP'] },
    { name: 'inventory_source', side: 'target', ctx: 'Engineering Item Master', def: 'How the item is sourced — Manufactured or Purchased.', samples: ['Manufactured', 'Purchased', 'Manufactured'] },
    { name: 'item_type', side: 'target', ctx: 'Engineering Item Master', def: 'Rootstock item type; constant Direct Material for these partitions.', samples: ['Direct Material', 'Direct Material', 'Direct Material'] },
    { name: 'revision', side: 'target', ctx: 'Engineering Item Master', def: 'Engineering revision letter for the item.', samples: ['A', 'B', 'C'] },
  ] },
  { table: 'Product', entries: [
    { name: 'product_id', side: 'target', ctx: 'Product', def: 'Primary key for a finished-goods product.', samples: ['FG-1001', 'FG-1002', 'FG-1003'] },
    { name: 'PROD_NO', side: 'source', ctx: 'PRODUCT_MASTER', def: 'Prosys product number; carried forward as product_id.', samples: ['FG-1001', 'FG-1002', 'FG-1003'] },
    { name: 'product_name', side: 'target', ctx: 'Product', def: 'Marketing/display name of the product.', samples: ['Printed Sleeve 12oz', 'Printed Cup 8oz', 'Printed Cup 16oz'] },
    { name: 'uom', side: 'target', ctx: 'Product', def: 'Selling unit of measure, normalized to the Rootstock picklist.', samples: ['EA', 'EA', 'CS'] },
    { name: 'status', side: 'target', ctx: 'Product', def: 'Lifecycle status — Active, Hold, or Obsolete.', samples: ['Active', 'Hold', 'Obsolete'] },
  ] },
  { table: 'Work Center', entries: [
    { name: 'work_center_id', side: 'target', ctx: 'Work Center', def: 'Primary key for a production work center.', samples: ['WC-PRESS-01', 'WC-DIE-02', 'WC-LAM-03'] },
    { name: 'WC_NO', side: 'source', ctx: 'WORKCENTER', def: 'Prosys work-center number; carried forward as work_center_id.', samples: ['WC-PRESS-01', 'WC-DIE-02', 'WC-LAM-03'] },
    { name: 'name', side: 'target', ctx: 'Work Center', def: 'Display name of the work center.', samples: ['Flexo Press 1', 'Die Cutter 2', 'Laminator 3'] },
    { name: 'department', side: 'target', ctx: 'Work Center', def: 'Department the work center belongs to.', samples: ['Printing', 'Converting', 'Finishing'] },
    { name: 'burden_rate', side: 'target', ctx: 'Work Center', def: 'Hourly burden rate, rounded to two decimals.', samples: ['85.00', '72.50', '64.00'] },
  ] },
  { table: 'Routing', entries: [
    { name: 'routing_id', side: 'target', ctx: 'Routing', def: 'Primary key for a routing header.', samples: ['RT-DWS-01', 'RT-WHC08-01', 'RT-LID-01'] },
    { name: 'item_number', side: 'target', ctx: 'Routing', def: 'Item the routing produces; foreign key into Engineering Item Master.', samples: ['P-DWS', 'P-WHC08', 'P-LID-08'] },
    { name: 'operation_seq', side: 'target', ctx: 'Routing', def: 'Operation sequence number within the routing.', samples: ['10', '20', '30'] },
    { name: 'work_center_id', side: 'target', ctx: 'Routing', def: 'Work center the operation runs at.', samples: ['WC-PRESS-01', 'WC-DIE-02', 'WC-LAM-03'] },
    { name: 'run_time_min', side: 'target', ctx: 'Routing', def: 'Run time per piece in minutes.', samples: ['12.50', '8.00', '5.25'] },
  ] },
  { table: 'Customer', entries: [
    { name: 'customer_id', side: 'target', ctx: 'Customer', def: 'Primary key for a customer account.', samples: ['C-100432', 'C-100488', 'C-100512'] },
    { name: 'CUST_NO', side: 'source', ctx: 'CUST_MASTER', def: 'Prosys customer number; carried forward as customer_id.', samples: ['C-100432', 'C-100488', 'C-100512'] },
    { name: 'customer_name', side: 'target', ctx: 'Customer', def: 'Legal/display name of the customer.', samples: ['Atlantic Foods Co', 'Greenville Packaging', 'Summit Beverages'] },
    { name: 'address_line1', side: 'target', ctx: 'Customer', def: 'Street portion of the address, split from the composite source field.', samples: ['1247 Industrial Pkwy', '88 Foundry Rd', '440 Commerce St'] },
    { name: 'tax_id', side: 'target', ctx: 'Customer', def: 'Federal tax ID, normalized to 9 contiguous digits.', samples: ['123456789', '987654321', '554433221'] },
    { name: 'payment_terms', side: 'target', ctx: 'Customer', def: 'Payment terms code for the customer.', samples: ['Net 30', 'Net 45', '2/10 Net 30'] },
  ] },
  { table: 'Bill of Materials', entries: [
    { name: 'bom_id', side: 'target', ctx: 'Bill of Materials', def: 'Primary key for a bill-of-materials header.', samples: ['BOM-P-DWS', 'BOM-P-WHC08', 'BOM-P-LID-08'] },
    { name: 'parent_item', side: 'target', ctx: 'Bill of Materials', def: 'Assembly item the BOM produces.', samples: ['P-DWS', 'P-WHC08', 'P-LID-08'] },
    { name: 'component_item', side: 'target', ctx: 'Bill of Materials', def: 'Component consumed by the parent item.', samples: ['PR-SBS-DWSP', 'A0001', 'D0001'] },
    { name: 'quantity_per', side: 'target', ctx: 'Bill of Materials', def: 'Quantity of the component per parent assembly.', samples: ['1.0000', '0.0025', '0.0100'] },
    { name: 'uom', side: 'target', ctx: 'Bill of Materials', def: 'Unit of measure for the component quantity.', samples: ['EA', 'LB', 'GAL'] },
  ] },
]

function GlossaryListPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const qq = q.trim().toLowerCase()
  const groups = GLOSSARY.map((g) => ({
    table: g.table,
    entries: g.entries.filter(
      (e) =>
        !qq ||
        e.name.toLowerCase().includes(qq) ||
        e.ctx.toLowerCase().includes(qq) ||
        e.def.toLowerCase().includes(qq) ||
        g.table.toLowerCase().includes(qq),
    ),
  })).filter((g) => g.entries.length > 0)
  const totalFields = GLOSSARY.reduce((n, g) => n + g.entries.length, 0)

  return (
    <aside
      aria-label="Glossary list"
      className="fixed bottom-0 right-0 top-[100px] z-[60] flex w-[440px] flex-col overflow-hidden border-l border-[#E5E7EB] bg-white shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.08)]"
    >
      <div className="shrink-0 border-b border-[#E5E7EB] px-5 pb-3 pt-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Glossary</div>
            <div className="mt-2 text-[13.5px] text-[#6B7280]">
              <span className="font-medium tabular-nums text-[#111827]">{totalFields}</span> field definitions
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-0.5 -mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F9FAFB] hover:text-[#6B7280]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9CA3AF]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search fields..."
            className="w-full rounded-md border border-[#E5E7EB] bg-white py-1.5 pl-8 pr-3 text-[13px] text-[#111827] placeholder:text-[#9CA3AF] focus:border-[#3B82F6] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-5 py-10 text-center text-[12.5px] text-[#9CA3AF]">No fields match &ldquo;{q}&rdquo;.</div>
        ) : (
          groups.map((g) => (
            <div key={g.table} className="border-b border-[#E5E7EB] last:border-b-0">
              <div className="px-5 pb-1.5 pt-3 font-mono text-[10.5px] uppercase tracking-wider text-[#9CA3AF]">{g.table}</div>
              <div className="pb-2">
                {g.entries.map((e) => (
                  <button
                    key={`${e.ctx}.${e.name}`}
                    type="button"
                    className="group flex w-full items-start gap-2 px-5 py-2.5 text-left hover:bg-[#F9FAFB]"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] font-mono text-[12px] ${e.side === 'source' ? 'text-[#6B7280]' : 'text-[#111827]'}`}>
                          {e.name}
                        </span>
                        <span className="whitespace-nowrap text-[11px] text-[#9CA3AF]">{e.ctx} · {e.side}</span>
                      </div>
                      <div className="mt-1 text-[12.5px] leading-snug text-[#6B7280]">{e.def}</div>
                      {e.samples && e.samples.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {e.samples.slice(0, 3).map((v, i) => (
                            <span key={i} className="max-w-[130px] truncate rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-0.5 font-mono text-[11px] text-[#6B7280]">
                              {v}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <ChevronRightIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-[#D1D5DB] group-hover:text-[#9CA3AF]" />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}

function StatusStrip() {
  const [glossaryListOpen, setGlossaryListOpen] = useState(false)
  const chev = (
    <span className="text-[#9CA3AF] text-[14.5px] font-semibold leading-none" aria-hidden="true">
      ›
    </span>
  )
  const dot = <span className="text-[#D1D5DB] shrink-0">·</span>
  return (
    <>
    {glossaryListOpen ? <GlossaryListPanel onClose={() => setGlossaryListOpen(false)} /> : null}
    <div
      title="Sample values — not yet wired to live data"
      className="h-10 shrink-0 border-b border-gray-100 bg-white px-5 flex items-center gap-x-5 text-[12.5px] text-[#6B7280]"
    >
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <span className="text-[#9CA3AF] leading-none">Reviewed</span>
        <span className="text-[#111827] tabular-nums leading-none">0/50</span>
      </span>
      {dot}
      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <span className="text-[#9CA3AF] leading-none">Source</span>
        <span className="text-[#111827] tabular-nums leading-none">118/140</span>
        <span className="text-[#9CA3AF] leading-none">mapped</span>
        {chev}
      </span>
      {dot}
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <span className="text-[#9CA3AF] leading-none">Target</span>
        <span className="text-[#111827] tabular-nums leading-none">155/162</span>
        <span className="text-[#9CA3AF] leading-none">set</span>
      </span>
      {dot}
      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <AlertTriangle className="w-[13px] h-[13px] text-[#71717A]" />
        <span className="text-[#9CA3AF] leading-none">Issues</span>
        <span className="inline-flex items-center gap-2 leading-none">
          <span className="text-[#D97706] tabular-nums leading-none">15</span>
          <span aria-hidden="true" className="w-px h-3 bg-[#D4D4D8]" />
          <span className="text-[#DC2626] tabular-nums leading-none">41</span>
        </span>
        {chev}
      </span>

      <div className="flex-1" />

      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <span className="text-[#9CA3AF] leading-none">Rules</span>
        <span className="text-[#111827] tabular-nums leading-none">30</span>
        {chev}
      </span>
      {dot}
      <button
        type="button"
        onClick={() => setGlossaryListOpen(true)}
        className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors"
      >
        <BookOpen className="w-[13px] h-[13px] text-[#9CA3AF]" />
        <span className="text-[#9CA3AF] leading-none">Glossary</span>
        {chev}
      </button>
    </div>
    </>
  )
}

// "Mapping & Transformation Spec" heading + the Map & Transform / Data Preview
// segmented toggle. Controlled by the parent's `specTab`; both views are live
// (Data Preview renders the self-contained `<MockDataPreview>` mock surface).
function SpecHeaderRow({
  value,
  onChange,
}: {
  value: 'map' | 'data'
  onChange: (v: 'map' | 'data') => void
}) {
  return (
    <div className="bg-white px-5 pt-4 pb-3 shrink-0 flex items-center gap-3 flex-nowrap">
      <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-[#111827] whitespace-nowrap shrink-0">
        {value === 'data' ? 'Ready-to-load' : 'Mapping & Transformation Spec'}
      </h2>
      <div className="flex-1 min-w-0" />
      <div className="inline-flex rounded-full border border-[#E5E7EB] bg-white p-0.5 shrink-0">
        <button
          type="button"
          onClick={() => onChange('map')}
          className="px-4 py-1.5 text-[13px] font-medium rounded-full transition-colors hover:text-[#111827]"
          style={
            value === 'map'
              ? { background: '#111827', color: '#FFFFFF' }
              : { background: 'transparent', color: '#6B7280' }
          }
        >
          Map &amp; Transform
        </button>
        <button
          type="button"
          onClick={() => onChange('data')}
          className="px-4 py-1.5 text-[13px] font-medium rounded-full transition-colors hover:text-[#111827]"
          style={
            value === 'data'
              ? { background: '#111827', color: '#FFFFFF' }
              : { background: 'transparent', color: '#6B7280' }
          }
        >
          Data Preview
        </button>
      </div>
    </div>
  )
}

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
 * feat/mapping-row-uniformity — try to resolve a `?drawer=<id>` URL
 * param into a source-side projection. Mirrors the synthetic ids that
 * `flattenRowsForListView` emits:
 *
 *   • `unmapped-source::<sourceFieldId>` — pure source-only unmapped
 *     field. Returns a `SourceFieldDrawerRow` with no ack reason.
 *   • `ack::source::<acknowledgmentId>`  — source-side ack. Looks up
 *     the ack in `data.sourceFieldAcknowledgments` and the source
 *     field in `data.sourceFields`; the ack's `reason` carries through
 *     to the drawer stub.
 *
 * Returns `null` for any other id shape (the caller then falls back
 * to the wire-level `MappingRow` lookup against `filteredRows`).
 *
 * Pure module-level function — no React hooks, no state. Cheap enough
 * to invoke inside the `useMemo` that computes `drawerRow`.
 */
function resolveSourceSideDrawerRow(
  rowId: string,
  data: MappingsForRedesignResult,
): SourceFieldDrawerRow | null {
  const SOURCE_PREFIX = 'unmapped-source::'
  const ACK_PREFIX = 'ack::source::'
  if (rowId.startsWith(SOURCE_PREFIX)) {
    const sourceFieldId = rowId.slice(SOURCE_PREFIX.length)
    const sf = data.sourceFields.find((f) => f.id === sourceFieldId)
    if (!sf) return null
    return {
      kind: 'source-field-only',
      id: rowId,
      sourceField: sf,
      acknowledgmentReason: null,
    }
  }
  if (rowId.startsWith(ACK_PREFIX)) {
    const ackId = rowId.slice(ACK_PREFIX.length)
    const ack = data.sourceFieldAcknowledgments.find((a) => a.id === ackId)
    if (!ack) return null
    const sf = data.sourceFields.find((f) => f.id === ack.sourceFieldId)
    if (!sf) return null
    return {
      kind: 'source-field-only',
      id: rowId,
      sourceField: sf,
      acknowledgmentReason: ack.reason ?? null,
    }
  }
  return null
}

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
