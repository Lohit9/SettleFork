'use client'

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Sparkles,
  X,
} from '@/components/icons'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  MappingTransformationStatus,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import type { PathDOutputs } from '@/lib/actions/path-d-outputs'
import type { ProjectDataQualityIssueRow } from '@/lib/types/path-d'
import { DecisionList } from './DecisionList'
import { DQList } from './DQList'
import {
  approveFieldMapping,
  rejectFieldMapping,
  resetMappingStatus,
} from '@/lib/actions/mappings-for-redesign'
import {
  classifyRowConfidence,
  formatConfidencePercent,
  type RowConfidenceBand,
} from '@/lib/utils/confidence-format'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { TableBadge } from './TableBadge'
import { DrawerHeader } from './DrawerHeader'
import { InlineSourcePicker } from './InlineSourcePicker'
import { TargetFieldCellPicker } from './TargetFieldCellPicker'

// ─────────────────────────────────────────────────────────────────────────────
// MappingDrawer — Phase 3 Gaps 7 + 8a + 8b + 9, extended in Phase 4a-2 / 4a-3 /
// 4a-4a / 4a-4b for the full mapping-authoring loop.
// ─────────────────────────────────────────────────────────────────────────────
//
// Right-side drawer that opens when the user clicks a mapping row body.
//
// Gap 7 (shipped d0f8c58): the shell — sticky header with target field name +
// target TableBadge + close X, sticky rule-specific subheader, scrollable body,
// sticky footer (Esc / outside-click close, focus restore).
//
// Gap 8a (shipped f9d2896): body content for non-mapped row kinds.
//
// Gap 8b (shipped): body content for mapped rows (Rules 1-4) — per-source
// roster + combination strategy + row-level reasoning + row-level confidence.
//
// Gap 9 (this gap): drawer footer — Approve / Reject action buttons, kind-
// dispatched disabled-state matrix, AlertDialog confirmation for Reject,
// inline error banner above the footer, and the optimistic-Approve /
// request-response-Reject UX. Wires `approveFieldMapping` and
// `rejectFieldMapping` from `lib/actions/mappings-for-redesign.ts`. Reject
// closes the drawer + clears the URL (founder amendment: reject == delete →
// row identity dissolves); Approve stays open with status badge re-rendered.
//
// Final body kind dispatch:
//
//   unmapped            → UnmappedBody         (Target field / Transformation /
//                                               Explanation / Decisions —
//                                               Phase E PR α; coverage-approved
//                                               no-source rows live here too)
//   value_assignment    → ValueAssignmentBody  (Target field / Value expression /
//                                               AI reasoning / Confidence / Status)
//   mapped              → MappedBody           (Target field / Sources /
//                                               [Combination] / AI reasoning /
//                                               Confidence / Status)
//
// Footer dispatch:
//
//   mapped / value_assignment   → ApproveRejectButtons (status-driven)
//   unmapped                    → UnmappedFooterButtons (status-driven —
//                                  needs_review: Suggest with AI / Create
//                                  mapping; approved: Un-approve via
//                                  resetMappingStatus; rejected: Approve)
//
// HISTORICAL ADR — Gap 7 (retired): the drawer was originally
// tab-LESS; the spec's Details/Source/Transform tabs were retired in
// favour of kind-dispatched single-page bodies (Founder Q3).
//
// REVERSED — feat/mapping-drawer-redesign (refinement #3): the unified
// Configure drawer needs Mapping and Transform accessible from one
// context, so the drawer is now TABBED with two sub-tabs:
//   • Mapping  — source/target identity, why this mapping, sample
//                source values, remove mapping link.
//   • Transform — transformation intent, status, SQL preview, deep-link
//                 to the Transform page.
// The kind-dispatched body model (MappedBody / UnmappedBody /
// ValueAssignmentBody) is preserved underneath; tab selection just
// partitions each body's existing sections into the two surfaces.
//
// LOCKED FOUNDER DECISIONS (do not re-litigate; see Gap 7 prompt):
//
//   • Width 520px, fixed.
//   • Position: `fixed inset-y-0 right-0` — covers viewport top to bottom,
//     INCLUDING the PageHeader area. No backdrop scrim under the mapping page.
//   • Slide-in from right via `translate-x-full` → `translate-x-0`, 150ms.
//     Respects `prefers-reduced-motion` (transition becomes 0 if media query
//     matches). The reduced-motion gate uses the `motion-reduce:` Tailwind
//     variant which keys off the same media query.
//   • Hand-rolled (no `@radix-ui/react-dialog`, no shadcn Sheet — we don't
//     ship the dep). Style mirrors `components/ui/alert-dialog.tsx` and
//     `components/ui/fix-drawer.tsx`. Founder Q5 decision.
//   • Header: target field name in mono + TableBadge for target table only.
//     Type info / required indicator are deferred to the Gap 8 Details tab
//     body — the header stays "which field am I configuring?" exclusively.
//     Founder Q3 decision.
//   • Subheader (this gap): per-row-kind summary line — see
//     `DrawerSubheader` below for the full matrix.
//   • A11y: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the
//     field-name <h2>. NO focus trap — Tab can leave the drawer naturally
//     (founder Q2: drawer is "alongside content" semantically).
//   • Esc and click-outside both close. The click-outside detection is
//     handled in the parent (`MappingContent.tsx`) because the drawer is
//     position-fixed and its sibling page is the natural outside region.
//     This component owns ONLY Esc + the close button.
//
// LIGHT-MODE-ONLY INVARIANT
//
// This file MUST NOT use any Tailwind dark-prefix modifier. The grep
// invariant in `tests/lib/no-shim-in-redesign-path.test.ts` enforces it.
// See `FieldMappingRow.tsx` file header for the full rationale.

// ── Focus restore helper (Phase 3 Gap 10) ─────────────────────────────────
//
// Resolve the element to receive focus when the drawer closes. The drawer
// captures `document.activeElement` synchronously on open as
// `triggerRef.current`; on close we want to restore focus to that element.
//
// Two edge cases require a fallback:
//
//   1. URL deep-link open (`?drawer=<rowId>` on initial mount). At capture
//      time the active element is `<body>`. Focusing `<body>` is a silent
//      no-op that strands the user at the document root.
//
//   2. Post-Reject DOM rebuild. After a successful Reject the parent calls
//      `router.refresh()`, which can replace the original row body element
//      while the drawer is still mounted. By the time our cleanup runs the
//      captured trigger may be detached from the DOM (its `isConnected`
//      flag flips false). Focusing a detached element is a silent no-op.
//
// In both cases we fall back to the first mapping-row body still in the
// DOM (rows are `role="button" tabIndex={0}` since Gap 7) so the user
// keeps a visible focus affordance and can resume keyboard navigation.
//
// Returns `null` when no fallback can be found (e.g., a project with zero
// rows). Callers should leave focus alone in that case rather than force
// it somewhere arbitrary.
function resolveFocusTarget(
  triggerCandidate: HTMLElement | null,
): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (
    triggerCandidate &&
    triggerCandidate.isConnected &&
    triggerCandidate !== document.body &&
    typeof triggerCandidate.focus === 'function'
  ) {
    return triggerCandidate
  }
  const firstRow = document.querySelector<HTMLElement>(
    '[data-testid="field-mapping-row-body"]',
  )
  if (firstRow && firstRow.isConnected) return firstRow
  return null
}

// ── Drawer width ───────────────────────────────────────────────────────────

/**
 * Drawer width in pixels. Single source of truth for the inline width
 * style applied to the drawer aside.
 *
 * Phase 3 Gap 11a (2026-04-25): drawer is now ALWAYS-overlay across all
 * viewport widths (no more `xl:pr-[…]` reflow on the parent scroll
 * container). Width reduced from 520 → 480 to coexist comfortably with
 * the new left-side `SourceSchemaSidebar` at common viewport widths.
 *
 * Tailwind's JIT requires literal class names, so the parent's reflow
 * class — when it existed — was a hardcoded `'xl:pr-[520px]'` literal
 * rather than an interpolation of this constant. With the reflow gone,
 * this constant is now consumed only by the inline `style` prop below,
 * eliminating the historical drift risk.
 */
export const MAPPING_DRAWER_WIDTH_PX = 480

// ── Public API ────────────────────────────────────────────────────────────

/**
 * feat/mapping-row-uniformity — minimal source-side drawer mount.
 *
 * A drawer-internal projection of a source-side flat row
 * (`unmapped-source` kind in `flatten-rows-for-list-view.ts`). The
 * flat view dispatches `onOpenDrawer` with the row's `groupId`
 * (`'unmapped-source::<sfId>'` or `'ack::source::<ackId>'`);
 * `MappingContent` resolves that id into a `SourceFieldDrawerRow` by
 * matching against `result.sourceFields` + `result.sourceFieldAcknowledgments`
 * and passes it here as the drawer's `row` prop alongside the existing
 * `MappingRow` union.
 *
 * Stub rendering only — name + table + sample values + ack reason.
 * No tabs, no editing UI (approve / reject continue to flow from the
 * flat-view hover cluster), no footer. Content evolution is a follow-up
 * PR with proper design.
 */
export interface SourceFieldDrawerRow {
  kind: 'source-field-only'
  id: string
  sourceField: SourceFieldWithState
  acknowledgmentReason: string | null
}

export type DrawerRow = MappingRow | SourceFieldDrawerRow

export interface MappingDrawerProps {
  /**
   * Row to show in the drawer. When `null` the drawer renders nothing
   * (no DOM at all). The parent decides whether to keep the row prop in
   * sync with `isOpen` — this component does not animate exit on its own.
   *
   * Accepts a `SourceFieldDrawerRow` projection for unmapped-source
   * rows; in that case the drawer mounts a minimal source-side view
   * (no header pickers, no tabs, no footer — see `SourceFieldBody`).
   */
  row: DrawerRow | null
  /** Whether the drawer is currently open. */
  isOpen: boolean
  /**
   * Called when the user closes the drawer via the X button or the Esc
   * key. The parent should clear its `drawer=` URL param and clear the
   * row highlight in response.
   */
  onClose: () => void
  /**
   * Gap 9 — called after a successful Approve or Reject so the parent
   * can refetch server data (`router.refresh()`) and, for Reject, close
   * the drawer + clear the URL (founder decision 2 in the Gap 9
   * alignment). Receives the action verb and the row id so the parent
   * does not have to track in-flight state itself.
   *
   * Optional: tests render the drawer in isolation without a parent
   * refetcher; in that mode the drawer falls back to its own derived
   * state (no harm done — the optimistic overlay self-corrects on the
   * next prop change).
   */
  onActionComplete?: (
    action: 'approve' | 'reject' | 'reset',
    rowId: string,
  ) => void
  /**
   * Required by header pickers + by the TRANSFORMATION section's
   * deep-link route. May be undefined for tests / non-mapped rows.
   */
  projectId?: string
  /**
   * Page-level source fields in canonical server order. Threaded to
   * the header's `InlineSourcePicker` instances. Optional for tests.
   */
  availableSourceFields?: SourceFieldWithState[]
  /**
   * Phase E PR α — Path D outputs sidecar (coverage rows, decisions, DQ
   * issues) keyed for per-row lookup. Threaded by `MappingContent` from
   * `getPathDOutputsForProject`. Drawer treats `null` / `undefined` as
   * "no enrichment available" — every dependent section collapses
   * (Linear pattern). Never a hard dependency: the drawer renders
   * row-prop content unchanged when the sidecar is absent.
   */
  pathDOutputs?: PathDOutputs | null
  /**
   * Mapping list view — flat-view split rows can open the drawer with
   * a specific source attribution highlighted. When set on a mapped
   * row, the matching `SourceCard` in the Sources section is rendered
   * with a left-border accent and scrolled into view on mount. The
   * prop is optional and defaults to "no highlight" — the target-led
   * view passes nothing and renders all sources equally.
   */
  highlightedSourceFieldId?: string | null
  /**
   * Drawer redesign PR 1 — universe of target fields for the header's
   * inline target-field picker. Threaded from the parent
   * (`MappingContent`) which derives one entry per target field from
   * `data.rows`. Optional: when absent, the header skips the target
   * pencil affordance (test fixtures, transitional callers).
   */
  availableTargetFields?: readonly TargetFieldRef[]
  /**
   * Drawer redesign PR 1 — header inline-edit commit handler for the
   * target-field swap flow. Receives the bare TFM uuid and the new
   * target field id. The parent wraps `mutations.swapMappingTarget`
   * (which calls `updateMappingTargetField` server-side). Optional:
   * when absent, the header skips the target pencil affordance.
   */
  onSwapTarget?: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 1 — header inline-edit commit handler for the
   * source-field swap flow. Receives the row id and the new source
   * field id. The parent wraps `mutations.swapMappingSource` (which
   * calls `updateMappingSourceField` server-side).
   *
   * PR 1 single-source: caller passes the bare TFM uuid (ordinal-0
   * branch). PR 2 multi-source per-source ✏: caller passes the
   * shimmed contributor row id (`<tfmId>::<mappingSourceId>`) via
   * `encodeContributorRowId` from `lib/compat/mapping-shim.ts`.
   */
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 — header commit handler for source-set
   * changes on an existing TFM. Used by per-source ✕ remove (and by
   * TASK 2 ⊕ Add source / TASK 3 VA conversion). The parent wraps
   * `mutations.editMappingSources` which dispatches the same-named
   * server action; the server flips status to `needs_review` on any
   * source change.
   */
  onEditSources?: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: 'single' | 'concat_space' | 'concat_comma'
  }) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 1.6 / 2+3 — handler for the
   * "Remove mapping" flow. Reused by:
   *   • Single-source row ✕ (TASK 1.6)
   *   • Target row ✕ on mapped + VA variants (TASK 2+3)
   * Deletes the TFM via `rejectFieldMapping` BUT keeps the drawer
   * open and transitions the row identity from `<tfmId>` to
   * `unmapped::<targetFieldId>`. Distinct from the footer Reject
   * button (which closes the drawer per founder decision 2). The
   * parent (`MappingContent`) updates the `drawerRowId` URL state
   * via the `pendingDrawerRowId` sentinel + `buildUnmappedOverride`
   * so the drawer renders `UnmappedBody` immediately without
   * flicker.
   */
  onUnmapMapping?: (
    tfmId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 2+3 — handler for the source ✏ on
   * unmapped/rejected variants. Picker → on commit fires
   * `createMappingFromUnmapped(projectId, sourceFieldId,
   * targetFieldId)` which creates a new TFM AND clears any coverage
   * rejection. Auto-approves the new TFM (per the server action).
   */
  onCreateMapping?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * Drawer redesign PR 2 TASK 2+3 — handler for the target ✏ on
   * unmapped/rejected variants. Distinct from `onSwapTarget` (which
   * needs a TFM uuid). Picker → on commit navigates the drawer to
   * the new target field's row id (mapped/VA TFM uuid OR
   * `unmapped::<newTargetFieldId>`). Client-only — no server action.
   */
  onNavigateTarget?: (
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * feat/drawer-body-editing-surface — handler for the source-field
   * stub's "Pick a target…" affordance. Promotes an unmapped-source
   * row to a mapped row: picker → on commit fires
   * `promoteUnmappedSource(projectId, sourceFieldId, targetFieldId)`,
   * which creates a new 1:1 TFM (target unmapped) or appends the source
   * to the existing TFM (target already mapped). The parent re-points
   * the drawer at the resulting TFM id via the `pendingDrawerRowId`
   * sentinel. Optional: when absent, the stub skips the affordance.
   */
  onPromoteSource?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
}

/**
 * Right-side drawer shell. See file header for the full Gap 7 contract.
 */
/**
 * Drawer sub-tab discriminator (feat/mapping-drawer-redesign — reverses
 * Gap-7 ADR). Local to MappingDrawer state, threaded into DrawerHeader
 * (tab strip render) and BodyContent (content partition).
 */
export type DrawerTab = 'mapping' | 'transform'

export function MappingDrawer({
  row,
  isOpen,
  onClose,
  onActionComplete,
  projectId,
  availableSourceFields,
  pathDOutputs,
  highlightedSourceFieldId,
  availableTargetFields,
  onSwapTarget,
  onSwapSource,
  onEditSources,
  onUnmapMapping,
  onCreateMapping,
  onNavigateTarget,
  onPromoteSource,
}: MappingDrawerProps) {
  const titleId = useId()
  const drawerRef = useRef<HTMLElement | null>(null)
  // Track the element that had focus before the drawer opened so we can
  // restore focus to it on close. We grab the active element synchronously
  // when `isOpen` flips from false → true; restoring on close happens in
  // the cleanup of the same effect.
  const triggerRef = useRef<HTMLElement | null>(null)

  // feat/mapping-drawer-redesign — Mapping / Transform sub-tabs.
  // Local state, reset to 'mapping' whenever the drawer opens onto a
  // different row id so reopening a row never lands on a stale tab.
  const [activeTab, setActiveTab] = useState<DrawerTab>('mapping')
  useEffect(() => {
    setActiveTab('mapping')
  }, [row?.id])

  // PR 3b commit 3 — CreateMappingForm + DiscardChangesDialog +
  // EditInvalidationDialog and their orchestration state (isFormActive,
  // editFormActive, formRef, formState, editInitialState,
  // editInvalidationPreview, isEditPreviewPending, editPreviewError,
  // autoSuggestRequested, isSuggestPending, autoSuggestConsumedRowsRef,
  // tryConsumeAutoSuggest, handleFormStateChange + row-id reset
  // effect + restoreFormState auto-activate effect + dirty-change
  // lift) all retire here. Body source-creation entry points moved to
  // the header FROM-stack source ✏ (PR 2 TASK 2+3); no in-drawer form
  // surface remains.

  // Stable-onClose ref so the document-level handlers below don't have
  // to re-bind on every render of the parent.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // ── Close intercept ──────────────────────────────────────────────
  //
  // PR 3b commit 3 simplified this — the form-active discard-dialog
  // routing retired with `CreateMappingForm`. Esc / click-outside /
  // X / Cancel just close the drawer.
  //
  // `maybeRequestCloseRef` keeps the document-level Esc / mousedown
  // listeners stable across renders.
  const maybeRequestClose = useCallback(() => {
    onCloseRef.current()
  }, [])
  const maybeRequestCloseRef = useRef(maybeRequestClose)
  useEffect(() => {
    maybeRequestCloseRef.current = maybeRequestClose
  }, [maybeRequestClose])

  // Esc + outside-click + focus-restore — all gated behind `isOpen`.
  useEffect(() => {
    if (!isOpen) return
    triggerRef.current =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Phase 4a-2 — when a modal-on-modal dialog (discard or
        // reject) is open above the drawer, Esc must dismiss the
        // dialog only. The `AlertDialog` primitive owns its own Esc
        // listener; if we let the drawer's listener fire too the
        // drawer would close right behind the dialog. The dialog
        // root is rendered via a fixed-position overlay we can
        // detect via `[role="alertdialog"]` in the DOM.
        if (typeof document !== 'undefined') {
          const dialogOpen = document.querySelector('[role="alertdialog"]')
          if (dialogOpen) return
        }
        maybeRequestCloseRef.current()
      }
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target === null) return
      // If the click landed inside the drawer itself, ignore — the
      // close button has its own React onClick wiring.
      if (drawerRef.current && drawerRef.current.contains(target)) return
      if (target instanceof Element) {
        // Phase 4a-2 — clicks inside an open AlertDialog (discard or
        // reject) must not bubble up to "user clicked outside drawer".
        // The dialog renders above the drawer in a higher-z-index
        // overlay; without this guard mousedown on the dialog body
        // would close the drawer beneath it.
        const insideDialog = target.closest('[role="alertdialog"]')
        if (insideDialog) return

        // If the click landed on another clickable row body, let that
        // row's own onClick switch the drawer to it (don't close-then-
        // re-open in a single tick). We detect row bodies by their
        // documented data-testid.
        const clickedRow = target.closest('[data-testid="field-mapping-row-body"]')
        if (clickedRow) return
        // Phase 3 Gap 11a — the new left-side `SourceSchemaSidebar`
        // coexists with the drawer at viewports above 1024px (founder
        // decision 4). Without this guard, mousedown on the sidebar's
        // collapsed rail or close chevron would close the drawer
        // before the sidebar's own click handler ran. We scope the
        // exception by data-testid so unrelated DOM never benefits
        // from this exclusion.
        const clickedSidebar = target.closest(
          '[data-testid="source-schema-sidebar"]',
        )
        if (clickedSidebar) return
        // Drawer redesign PR 2 TASK 1.5 — the header's inline pickers
        // and per-source remove popover all portal to `document.body`
        // (outside `drawerRef`). Mousedown inside any of them must
        // NOT close the drawer. The pickers own their own
        // outside-click dismissal, so they still close themselves
        // when the user clicks the page area beyond both the drawer
        // and the picker. Scoped by testid (explicit allowlist) to
        // avoid catching future dialogs we'd want to behave
        // differently.
        const clickedPickerOrPopover = target.closest(
          '[data-testid="inline-source-picker"],' +
            '[data-testid="target-field-cell-picker"],' +
            '[data-testid="reject-confirm-popover"]',
        )
        if (clickedPickerOrPopover) return
      }
      maybeRequestCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      // Defer focus restoration to the next tick so React's commit phase
      // has finished tearing down the drawer subtree first.
      // Phase 3 Gap 10 — `resolveFocusTarget` falls back to the first
      // mapping row body when the trigger is `<body>` (URL deep-link) or
      // detached (post-Reject DOM rebuild).
      const trigger = triggerRef.current
      queueMicrotask(() => {
        const target = resolveFocusTarget(trigger)
        if (target) target.focus()
      })
    }
  }, [isOpen])

  const handleAsideRef = useCallback((node: HTMLElement | null) => {
    drawerRef.current = node
  }, [])

  // ── Gap 9 — action state ───────────────────────────────────────────────
  //
  // Optimistic overlay for Approve. Keyed by row id so the overlay does
  // NOT bleed into a different row if the user clicks another mapping
  // before the server replies. The effective status used by the body's
  // `StatusSection` and the footer's button-disabled matrix is derived
  // by overlaying this onto `row.status`.
  //
  // We deliberately store the overlay in a single state slot rather than
  // a Map: only one Approve can be in flight at a time (Approve disables
  // its own trigger, Reject is gated behind a confirmation dialog), so
  // multiple concurrent overlays are not reachable.
  const [optimisticApprove, setOptimisticApprove] = useState<{
    rowId: string
  } | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isApprovePending, startApproveTransition] = useTransition()
  const [isRejecting, setIsRejecting] = useState(false)
  const [confirmRejectOpen, setConfirmRejectOpen] = useState(false)
  // INF-57 cleanup — un-approve in-flight + confirm dialog state. Mirrors
  // the reject-confirmation shape but is non-destructive: the row's
  // status flips from approved → needs_review via resetMappingStatus,
  // the row identity is preserved, and the drawer closes on success
  // (parent treats `'reset'` like `'reject'` — see handleDrawerActionComplete).
  const [isUnapproving, setIsUnapproving] = useState(false)
  const [confirmUnapproveOpen, setConfirmUnapproveOpen] = useState(false)

  // Reset transient action state whenever the row identity changes —
  // including drawer close (`row` becomes null between renders) and
  // user clicks on a different row body.
  const rowId = row?.id ?? null
  useEffect(() => {
    setOptimisticApprove(null)
    setErrorMessage(null)
    setConfirmRejectOpen(false)
    // Note: we deliberately do NOT clear `isRejecting` here — Reject
    // closes the drawer (founder decision 2 in the Gap 9 alignment),
    // which unmounts everything; if a new row mounts, the in-flight
    // state was for a different row and would never resolve here.
    setIsRejecting(false)
    setConfirmUnapproveOpen(false)
    setIsUnapproving(false)
  }, [rowId])

  // Clear the optimistic overlay once the server confirms by handing
  // back a row whose status already matches our optimistic intent.
  // After `router.refresh()` the parent re-renders with fresh server
  // data; this effect reconciles. Keeping the overlay until then would
  // double-flash the Approved state when the server data arrives in
  // the same tick.
  useEffect(() => {
    if (
      optimisticApprove &&
      row &&
      row.kind !== 'source-field-only' &&
      row.id === optimisticApprove.rowId &&
      row.status === 'approved'
    ) {
      setOptimisticApprove(null)
    }
  }, [row, optimisticApprove])

  const effectiveRow = useMemo<MappingRow | null>(() => {
    // feat/mapping-row-uniformity — source-side drawer mount bypasses
    // the optimistic-approve machinery entirely. `effectiveRow` stays
    // null when the row is a `SourceFieldDrawerRow`; the source-side
    // render branch in the main return handles that case explicitly.
    if (!row || row.kind === 'source-field-only') return null
    if (optimisticApprove && optimisticApprove.rowId === row.id) {
      return applyOptimisticApprove(row)
    }
    return row
  }, [row, optimisticApprove])

  const handleApprove = useCallback(() => {
    if (!row || row.kind === 'source-field-only') return
    const targetRowId = row.id
    setErrorMessage(null)
    setOptimisticApprove({ rowId: targetRowId })
    startApproveTransition(async () => {
      try {
        const result = await approveFieldMapping(targetRowId)
        if (!result.success) {
          setOptimisticApprove((current) =>
            current && current.rowId === targetRowId ? null : current,
          )
          setErrorMessage(GENERIC_APPROVE_ERROR)
          if (typeof console !== 'undefined') {
            console.error('[MappingDrawer] approveFieldMapping failed:', result)
          }
          return
        }
        onActionComplete?.('approve', targetRowId)
      } catch (err) {
        setOptimisticApprove((current) =>
          current && current.rowId === targetRowId ? null : current,
        )
        setErrorMessage(GENERIC_APPROVE_ERROR)
        if (typeof console !== 'undefined') {
          console.error('[MappingDrawer] approveFieldMapping threw:', err)
        }
      }
    })
  }, [row, onActionComplete])

  const handleRejectConfirm = useCallback(async () => {
    if (!row || row.kind === 'source-field-only') return
    const targetRowId = row.id
    setErrorMessage(null)
    setIsRejecting(true)
    try {
      const result = await rejectFieldMapping(targetRowId)
      if (!result.success) {
        setIsRejecting(false)
        setConfirmRejectOpen(false)
        setErrorMessage(GENERIC_REJECT_ERROR)
        if (typeof console !== 'undefined') {
          console.error('[MappingDrawer] rejectFieldMapping failed:', result)
        }
        return
      }
      // Success path — parent will close the drawer + refresh data.
      // We do NOT clear `isRejecting` here; the drawer is about to
      // unmount.
      setConfirmRejectOpen(false)
      onActionComplete?.('reject', targetRowId)
    } catch (err) {
      setIsRejecting(false)
      setConfirmRejectOpen(false)
      setErrorMessage(GENERIC_REJECT_ERROR)
      if (typeof console !== 'undefined') {
        console.error('[MappingDrawer] rejectFieldMapping threw:', err)
      }
    }
  }, [row, onActionComplete])

  // ── INF-57 cleanup — un-approve handler ──────────────────────────
  //
  // Mirrors `handleRejectConfirm`'s shape but is non-destructive: the
  // row's status flips from approved → needs_review via
  // `resetMappingStatus`. Surface dispatch (coverage_only / tfm_mapped_or_va
  // / legacy_bare_ack) is decided server-side off the row id format. On
  // success the parent closes the drawer + clears the URL (mirrors
  // reject's drawer-close behavior — see handleDrawerActionComplete's
  // `'reset'` arm). On failure we surface uniform copy and log the
  // underlying errorCode for ops triage.
  const handleUnapproveConfirm = useCallback(async () => {
    if (!row || row.kind === 'source-field-only') return
    if (row.status !== 'approved') return
    const targetRowId = row.id
    setErrorMessage(null)
    setIsUnapproving(true)
    try {
      const result = await resetMappingStatus({ rowId: targetRowId })
      if (!result.success) {
        setIsUnapproving(false)
        setConfirmUnapproveOpen(false)
        setErrorMessage(GENERIC_UNAPPROVE_ERROR)
        if (typeof console !== 'undefined') {
          console.error('[MappingDrawer] resetMappingStatus failed:', result)
        }
        return
      }
      // Success — drawer about to unmount. Do NOT clear isUnapproving
      // for the same reason as the reject path.
      setConfirmUnapproveOpen(false)
      onActionComplete?.('reset', targetRowId)
    } catch (err) {
      setIsUnapproving(false)
      setConfirmUnapproveOpen(false)
      setErrorMessage(GENERIC_UNAPPROVE_ERROR)
      if (typeof console !== 'undefined') {
        console.error('[MappingDrawer] resetMappingStatus threw:', err)
      }
    }
  }, [row, onActionComplete])

  // PR 3b commit 3 — edit-mode handlers (handleEditClick,
  // handleEditFormCancel, handleEditSavePrecheck,
  // handleEditInvalidationConfirm, handleEditInvalidationCancel,
  // handleEditFormSaveSuccess) and the previewEditInvalidation
  // wrapper retired with `CreateMappingForm`. The inline body
  // edit-form path is gone; header-level inline pickers handle
  // source / target edits directly (PR 2 TASK 2+3).

  if (!isOpen || !row) return null

  // feat/mapping-row-uniformity — minimal source-side mount. The
  // drawer chrome is the same `<aside>` shell (so outside-click, Esc,
  // focus restore, and width all behave consistently), but the
  // contents are a stripped-down identity view: source field name +
  // table + sample values + ack reason (if present). No DrawerHeader
  // pickers, no tabs, no footer — editing affordances stay in the
  // flat-view hover cluster. This is intentionally a stub; richer
  // source-field content is a follow-up PR with proper design.
  if (row.kind === 'source-field-only') {
    return (
      <aside
        ref={handleAsideRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="mapping-drawer"
        data-drawer-kind="source-field-only"
        className={cn(
          'fixed inset-y-0 right-0 z-30 flex flex-col',
          'border-l border-slate-200 bg-white shadow-[-4px_0_16px_-2px_rgba(15,23,42,0.08)]',
          'translate-x-0 transition-transform duration-150 ease-out',
          'motion-reduce:transition-none',
        )}
        style={{ width: `${MAPPING_DRAWER_WIDTH_PX}px` }}
      >
        <SourceFieldDrawerStub
          row={row}
          titleId={titleId}
          onClose={maybeRequestClose}
          onPromoteSource={onPromoteSource}
          availableTargetFields={availableTargetFields}
        />
      </aside>
    )
  }

  if (!effectiveRow) return null

  return (
    <aside
      ref={handleAsideRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="mapping-drawer"
      className={cn(
        'fixed inset-y-0 right-0 z-30 flex flex-col',
        'border-l border-slate-200 bg-white shadow-[-4px_0_16px_-2px_rgba(15,23,42,0.08)]',
        'translate-x-0 transition-transform duration-150 ease-out',
        'motion-reduce:transition-none',
      )}
      style={{ width: `${MAPPING_DRAWER_WIDTH_PX}px` }}
    >
      {/* feat/mapping-drawer-header-redesign — compact header (MAPPING
          label + title row + confidence line + close). Editing
          affordances retired here moved to the flat view
          (primary-source swap, target swap, create-from-unmapped) or
          to the drawer body's SOURCE column (non-primary source
          swap, per-source remove, add source). See `DrawerHeader.tsx`
          file-top comment for the relocation map. The
          `onSwapSource` / `onEditSources` / `onSwapTarget` /
          `onUnmapMapping` / `onCreateMapping` / `onNavigateTarget`
          props on `MappingDrawerProps` stay so commit 2 can thread
          them into `MappedBody`'s `MappingSourceTargetGrid`. */}
      <DrawerHeader
        row={effectiveRow}
        titleId={titleId}
        onClose={maybeRequestClose}
      />
      <DrawerTabStrip activeTab={activeTab} onTabChange={setActiveTab} />
      <DrawerBody
        row={effectiveRow}
        activeTab={activeTab}
        projectId={projectId}
        pathDOutputs={pathDOutputs ?? null}
        onRemoveMappingClick={() => setConfirmRejectOpen(true)}
        onSwapSource={onSwapSource}
        onEditSources={onEditSources}
        onSwapTarget={onSwapTarget}
        onCreateMapping={onCreateMapping}
        availableSourceFields={availableSourceFields}
        availableTargetFields={availableTargetFields}
      />
      <DrawerFooter
        row={effectiveRow}
        errorMessage={errorMessage}
        isApprovePending={isApprovePending}
        isRejecting={isRejecting}
        optimisticallyApproved={optimisticApprove !== null}
        onApprove={handleApprove}
        onRejectClick={() => setConfirmRejectOpen(true)}
        isUnapproving={isUnapproving}
        onUnapproveClick={() => setConfirmUnapproveOpen(true)}
      />
      <RejectConfirmDialog
        open={confirmRejectOpen}
        onOpenChange={(next) => {
          if (isRejecting) return
          setConfirmRejectOpen(next)
        }}
        targetFieldName={effectiveRow.targetField.name}
        isRejecting={isRejecting}
        onConfirm={handleRejectConfirm}
      />
      <UnapproveConfirmDialog
        open={confirmUnapproveOpen}
        onOpenChange={(next) => {
          if (isUnapproving) return
          setConfirmUnapproveOpen(next)
        }}
        targetFieldName={effectiveRow.targetField.name}
        isUnapproving={isUnapproving}
        onConfirm={handleUnapproveConfirm}
      />
    </aside>
  )
}

// ── Optimistic overlay helper ───────────────────────────────────────────────
//
// Apply the "Approve in flight" overlay to a row. Reachable for any row
// kind that exposes the Approve button (mapped/VA via ApproveRejectButtons,
// unmapped via UnmappedFooterButtons's status-driven dispatch when status
// is 'rejected').

function applyOptimisticApprove(row: MappingRow): MappingRow {
  if (row.kind === 'mapped') return { ...row, status: 'approved' }
  if (row.kind === 'value_assignment') return { ...row, status: 'approved' }
  if (row.kind === 'unmapped') return { ...row, status: 'approved' }
  return row
}

// ── feat/mapping-row-uniformity — source-side drawer stub ──────────────────
//
// Minimal viewing surface for source-side rows. Renders identity
// (table + field name) + up to 5 sample values + ack reason (when the
// row carries one) + close button. No editing UI: approve / reject
// for source-side rows continue to live on the flat-view hover
// cluster. Content evolution is a follow-up PR with proper design.

function SourceFieldDrawerStub({
  row,
  titleId,
  onClose,
  onPromoteSource,
  availableTargetFields,
}: {
  row: SourceFieldDrawerRow
  titleId: string
  onClose: () => void
  /**
   * feat/drawer-body-editing-surface — "Pick a target…" promotion
   * handler. The stub stays minimal otherwise (per founder direction:
   * no ack-lifecycle UI, no rich sample layouts) — this is the one
   * editing affordance it carries.
   */
  onPromoteSource?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  availableTargetFields?: readonly TargetFieldRef[]
}) {
  const sf = row.sourceField
  const samples = sf.sampleValues.slice(0, 5)

  // feat/drawer-body-editing-surface — anchored "Pick a target…" picker.
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const pickButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeTargetPicker = useCallback(() => setPickerAnchor(null), [])
  const targetPickable = Boolean(onPromoteSource && availableTargetFields)

  const handlePickTargetCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (!onPromoteSource) return { success: false }
      const result = await onPromoteSource(sf.id, newTargetFieldId)
      if (result.success) setPickerAnchor(null)
      return result
    },
    [onPromoteSource, sf.id],
  )
  return (
    <>
      <header
        data-testid="mapping-drawer-source-stub-header"
        className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4"
      >
        <div className="min-w-0 flex-1">
          <div
            data-testid="mapping-drawer-source-stub-label"
            className="text-[11px] font-medium uppercase tracking-wide text-slate-500"
          >
            Source field
          </div>
          <h2
            id={titleId}
            data-testid="mapping-drawer-source-stub-title"
            className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 text-base font-normal text-slate-900"
          >
            <span
              data-testid="mapping-drawer-source-stub-table"
              title={sf.sourceTable.name}
              className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500"
            >
              {sf.sourceTable.name}
            </span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span
              data-testid="mapping-drawer-source-stub-field"
              title={sf.name}
              className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm font-medium text-slate-700"
            >
              {sf.name || '—'}
            </span>
          </h2>
          <div
            data-testid="mapping-drawer-source-stub-type"
            className="mt-1 font-mono text-xs text-slate-500"
          >
            {sf.dataType}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          data-testid="mapping-drawer-close"
          className={cn(
            'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md',
            'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div
        data-testid="mapping-drawer-body"
        data-drawer-kind="source-field-only"
        className="flex-1 overflow-auto px-6 py-5"
      >
        {targetPickable ? (
          <section
            data-testid="drawer-section-source-stub-target"
            className="mb-6"
          >
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Target
            </h3>
            <button
              ref={pickButtonRef}
              type="button"
              data-testid="drawer-source-stub-pick-target"
              onClick={() => {
                if (pickButtonRef.current) {
                  setPickerAnchor(pickButtonRef.current)
                }
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1',
                'text-xs text-slate-500 transition-colors',
                'hover:border-slate-400 hover:text-slate-700',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
              )}
            >
              <Plus className="h-3 w-3" />
              <span>Pick a target…</span>
            </button>
          </section>
        ) : null}
        {samples.length > 0 ? (
          <section
            data-testid="drawer-section-source-stub-samples"
            className="mb-6"
          >
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Sample source values
            </h3>
            <ul
              data-testid="drawer-source-stub-samples-list"
              className="divide-y divide-slate-100 rounded border border-slate-200"
            >
              {samples.map((value, idx) => (
                <li
                  key={`${idx}-${value}`}
                  data-testid="drawer-source-stub-sample-row"
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate break-words font-mono text-slate-700">
                    {value}
                  </span>
                  <span className="shrink-0 text-[11px] text-slate-400">
                    row {idx + 1}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {row.acknowledgmentReason ? (
          <section
            data-testid="drawer-section-source-stub-ack-reason"
            className="mb-6"
          >
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Acknowledgment reason
            </h3>
            <p
              data-testid="drawer-source-stub-ack-reason-text"
              className="text-sm leading-relaxed text-slate-700"
            >
              {row.acknowledgmentReason}
            </p>
          </section>
        ) : null}
        {pickerAnchor && availableTargetFields ? (
          <TargetFieldCellPicker
            anchorRef={{ current: pickerAnchor }}
            initialTargetFieldId={null}
            availableTargetFields={availableTargetFields}
            onCommit={handlePickTargetCommit}
            onClose={closeTargetPicker}
          />
        ) : null}
      </div>
    </>
  )
}

// ── Action error copy ───────────────────────────────────────────────────────
//
// Founder decision 4 (Gap 9 alignment) — uniform error copy regardless
// of underlying errorCode (PERMISSION_DENIED vs MAINTENANCE_MODE vs
// INTERNAL etc.). Technical details land in console only. The user
// gets a clear, actionable retry prompt.

const GENERIC_APPROVE_ERROR =
  "Couldn't approve this mapping. Please try again."
const GENERIC_REJECT_ERROR =
  "Couldn't reject this mapping. Please try again."
const GENERIC_UNAPPROVE_ERROR =
  "Couldn't un-approve this mapping. Please try again."

// ── Header ─────────────────────────────────────────────────────────────────
//
// Drawer redesign PR 1 (feat/drawer-header-rewrite): the header is now a
// standalone two-row component in [./DrawerHeader.tsx] — source identity →
// target identity on row 1, status badge + confidence right-aligned on
// row 2. Click-to-edit pencils on the source field (single-source mapped
// only) and target field (mapped/VA) open the existing portal-anchored
// `InlineSourcePicker` / `TargetFieldCellPicker` used by the flat view.
// See `DrawerHeader.tsx` file header for the full per-variant matrix.

// Drawer redesign — TARGET-led identity: the body's first section is
// named `SOURCE` (singular). The testid follows suit:
// `drawer-section-source`. The section name is singular regardless of
// source count — Rule 1 has one source, Rule 2/3/4 list multiple
// sources under a single SOURCE section heading; the list itself
// carries the plurality cue. VA rows omit this section entirely
// (drawer redesign PR 1 — empty-state SOURCE removed for VAs).
const SOURCE_SECTION_TESTID = 'drawer-section-source'

// ── Sub-tab strip (feat/mapping-drawer-redesign) ───────────────────────────
//
// Two-button tab strip between the header and the body. Minimal styling
// in commit 1 — commit 2 moves this strip into the rewritten compact
// DrawerHeader. The strip itself stays a pure presentational component;
// state lives on the parent (MappingDrawer) so the focus/scroll context
// of the active tab survives re-renders triggered by row mutations.

function DrawerTabStrip({
  activeTab,
  onTabChange,
}: {
  activeTab: DrawerTab
  onTabChange: (next: DrawerTab) => void
}) {
  return (
    <div
      role="tablist"
      data-testid="drawer-tab-strip"
      className="flex items-end gap-6 border-b border-slate-200 px-6 pt-2"
    >
      <DrawerTabButton
        tab="mapping"
        label="Mapping"
        active={activeTab === 'mapping'}
        onClick={() => onTabChange('mapping')}
      />
      <DrawerTabButton
        tab="transform"
        label="Transform"
        active={activeTab === 'transform'}
        onClick={() => onTabChange('transform')}
      />
    </div>
  )
}

function DrawerTabButton({
  tab,
  label,
  active,
  onClick,
}: {
  tab: DrawerTab
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="tab"
      data-testid={`drawer-tab-${tab}`}
      data-active={active ? 'true' : 'false'}
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'border-b-2 pb-2 text-sm transition-colors',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
        active
          ? 'border-slate-900 font-medium text-slate-900'
          : 'border-transparent text-slate-500 hover:text-slate-700',
      )}
    >
      {label}
    </button>
  )
}

// ── Body — kind-dispatched (Gap 8a) ────────────────────────────────────────
//
// The wrapping `<div data-testid="mapping-drawer-body">` is preserved so:
//   • The outside-click handler in `MappingDrawer` (line ~130) can still
//     test `drawerRef.current.contains(target)` against any descendant.
//   • Existing Gap 7 tests that use `mapping-drawer-body` to fire `mousedown`
//     on a non-closing target keep passing.
// Inside the wrapper, content is dispatched on `row.kind`:
//   unmapped            → UnmappedBody (coverage-approved no-source rows live
//                                       here too post-INF-57 cleanup)
//   value_assignment    → ValueAssignmentBody
//   mapped              → MappedBody (Gap 8b — per-source roster + combination)
//
// feat/mapping-drawer-redesign — each body kind now partitions its
// sections by `activeTab`: 'mapping' renders identity + analysis +
// enrichment sections; 'transform' renders the TransformationSection
// (and intent prose for unmapped rows). The kind-dispatch lives one
// level up; tab-dispatch lives inside each body.

interface DrawerBodyProps {
  row: MappingRow
  /** Required for the TRANSFORMATION section's deep-link route. */
  projectId: string | undefined
  /**
   * Phase E PR α — Path D outputs sidecar for per-row enrichment.
   * Threaded by the parent from `getPathDOutputsForProject`.
   * `null` indicates "no enrichment data" — every dependent section
   * collapses (Linear pattern).
   */
  pathDOutputs: PathDOutputs | null
  /** feat/mapping-drawer-redesign — which sub-tab content to render. */
  activeTab: DrawerTab
  /**
   * feat/mapping-drawer-redesign — handler for the body's "Remove
   * mapping" link (red text, bottom of Mapping tab). Same trigger as
   * the footer's reject button: opens the existing RejectConfirmDialog
   * and on confirm fires the existing `handleRejectConfirm`.
   */
  onRemoveMappingClick: () => void
  /**
   * feat/mapping-drawer-header-redesign — per-source swap handler
   * relocated from the retired header pencil into the body's SOURCE
   * column pencil. Receives the shimmed contributor row id
   * (`<tfmId>::<mappingSourceId>` for multi-source, bare TFM uuid for
   * single-source) and the new source field id. Undefined when the
   * parent has not threaded edit handlers (test mounts).
   */
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * feat/mapping-drawer-header-redesign — source-set replace handler
   * for the body's "+ Add source" button and per-source ✕ remove.
   * Mirrors the retired header `AddSourceButton` / `HeaderRemoveButton`
   * dispatch contract.
   */
  onEditSources?: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: 'single' | 'concat_space' | 'concat_comma'
  }) => Promise<{ success: boolean }>
  /**
   * feat/drawer-body-editing-surface — body TARGET column pencil swap
   * (mapped rows). Receives the bare TFM uuid and the new target field
   * id; wraps `mutations.swapMappingTarget`.
   */
  onSwapTarget?: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  /**
   * feat/drawer-body-editing-surface — body SOURCE picker on the
   * unmapped-target variant. "Pick a source…" → on commit promotes the
   * unmapped-target row to a mapped row via `createMappingFromUnmapped`.
   */
  onCreateMapping?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /** Source field universe for the body's source-swap and add-source pickers. */
  availableSourceFields?: readonly SourceFieldWithState[]
  /** Target field universe for the body's TARGET column swap picker. */
  availableTargetFields?: readonly TargetFieldRef[]
}

function DrawerBody(props: DrawerBodyProps) {
  return (
    <div
      data-testid="mapping-drawer-body"
      data-active-tab={props.activeTab}
      className="flex-1 overflow-auto px-6 py-5"
    >
      <BodyContent {...props} />
    </div>
  )
}

function BodyContent({
  row,
  projectId,
  pathDOutputs,
  activeTab,
  onRemoveMappingClick,
  onSwapSource,
  onEditSources,
  onSwapTarget,
  onCreateMapping,
  availableSourceFields,
  availableTargetFields,
}: DrawerBodyProps) {
  switch (row.kind) {
    case 'mapped':
      return (
        <MappedBody
          row={row}
          projectId={projectId}
          pathDOutputs={pathDOutputs}
          activeTab={activeTab}
          onRemoveMappingClick={onRemoveMappingClick}
          onSwapSource={onSwapSource}
          onEditSources={onEditSources}
          onSwapTarget={onSwapTarget}
          availableSourceFields={availableSourceFields}
          availableTargetFields={availableTargetFields}
        />
      )
    case 'value_assignment':
      return (
        <ValueAssignmentBody
          row={row}
          pathDOutputs={pathDOutputs}
          activeTab={activeTab}
        />
      )
    case 'unmapped':
      return (
        <UnmappedBody
          row={row}
          projectId={projectId}
          pathDOutputs={pathDOutputs}
          activeTab={activeTab}
          onCreateMapping={onCreateMapping}
          availableSourceFields={availableSourceFields}
        />
      )
  }
}

// ── Body primitives — shared across kinds ──────────────────────────────────
//
// Three light primitives keep the kind bodies declarative and the visual
// language (small-caps section title, generous spacing, no border separators)
// in one place. They are intentionally thin wrappers — extracting them into
// their own files is premature until Gap 8b confirms the conventions hold for
// the more complex mapped-row roster.

/**
 * Stacked section with a small-caps title and arbitrary children. Spacing
 * is `mb-6` between sections (clean Linear / Notion vibe — no border rules).
 *
 * `headerAside` (optional) renders a trailing slot in the header row,
 * right-aligned. Used by `SourcesSection` to surface the Phase 4a-3
 * cross-table apply badge without disrupting the rest of the drawer's
 * uniform section header style.
 */
function DrawerSection({
  title,
  testId,
  children,
  headerAside,
}: {
  title: string
  testId: string
  children: React.ReactNode
  headerAside?: React.ReactNode
}) {
  return (
    <section className="mb-4 last:mb-0" data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {title}
        </h3>
        {headerAside}
      </div>
      <div>{children}</div>
    </section>
  )
}

/**
 * Stacked label/value pair. `mono` switches the value to `font-mono` (used
 * for field names, data types, and other identifier-shaped values). Empty
 * `value` is supported but callers should reach for `<DrawerEmptyState />`
 * for readability when the field is intentionally absent.
 */
function DrawerField({
  label,
  value,
  mono = false,
  testId,
}: {
  label: string
  value: string
  mono?: boolean
  testId?: string
}) {
  return (
    <div className="mb-3 last:mb-0" data-testid={testId}>
      <div className="text-xs text-slate-500">{label}</div>
      <div
        className={cn(
          'text-sm text-slate-900',
          mono && 'font-mono',
        )}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * Italic muted line for "field intentionally absent" states. Visually
 * matches the row-level em-dash treatment from Gap 5a so the drawer reads
 * consistently with the rows underneath it.
 */
function DrawerEmptyState({
  text,
  testId,
}: {
  text: string
  testId?: string
}) {
  return (
    <p
      className="text-sm italic text-slate-400"
      data-testid={testId}
    >
      {text}
    </p>
  )
}

// ── Status palette (drawer redesign — header + sections share) ─────────────
//
// Four-entry palette, color + label per status. The drawer redesign moves
// the status presence to the header line 2 dot (no label, color only) but
// the palette stays here as the single source of truth — the AI Reasoning
// section's header pill (when added) and the Transformation section's
// `applied/tested/draft/stale` pill both consume from cousin palettes
// defined alongside.

// Drawer redesign PR 1 — the DRAWER_STATUS_CONFIG palette + DrawerStatus
// type that previously lived here moved to [./DrawerHeader.tsx] alongside
// the new HeaderStatusBadge. No other body component consumes the
// palette, so it's no longer re-exported here.

// ── Rule 6 — Unmapped ──────────────────────────────────────────────────────
//
// Drawer redesign: Rule 6 reuses the `Sources` section title with an
// empty-state body ("No source mapped yet"), so the chrome matches Rules
// 1-4 even when there's no roster to show. The form mounts in place of
// the empty-state when `isFormActive` flips (the footer's [Create mapping]
// or [Suggest with AI] button). Edit pencil is hidden — there's no mapping
// to edit until a source is chosen.

const SOURCE_CONFIDENCE_BAND_CLASSNAME: Record<RowConfidenceBand, string> = {
  high: 'text-green-600 font-medium',
  amber: 'text-amber-600',
  low: 'text-red-600',
}

// ── PR 3b SOURCE FIELDS section ─────────────────────────────────────────────
//
// Replaces the legacy `<DrawerSection title="Source">` + the separate
// SAMPLE VALUES section on mapped rows. Renders one block per source
// in server ordinal-asc order. Each block shows:
//
//   field_name · table_name · data_type · NN%
//   (join: <annotation>)               ← when source.joinAnnotation is non-null
//   Sample values:
//     "<value-1>"
//     "<value-2>"
//     ...
//
// Hidden when the row has no sources (VA / unmapped / rejected — those
// variants render different body content; the FROM stack already
// communicates their "no source" state).
//
// Sample values cap is the wire-side `MAX_SAMPLE_VALUES = 10` (per
// `mapping-engine.ts:769`). We render all that arrive — no further
// UI-level cap because the redesigned drawer treats samples as
// per-source evidence the user wants in full when they expand a row.

function SourceFieldsSection({
  sources,
}: {
  sources: readonly MappingSourceRef[]
}) {
  if (sources.length === 0) return null
  return (
    <DrawerSection title="Source fields" testId="drawer-section-source-fields">
      <ul className="space-y-4" data-testid="drawer-source-fields-list">
        {sources.map((source) => (
          <SourceFieldBlock key={source.id} source={source} />
        ))}
      </ul>
    </DrawerSection>
  )
}

function SourceFieldBlock({ source }: { source: MappingSourceRef }) {
  const confidenceBand: RowConfidenceBand | null =
    source.confidence === null
      ? null
      : classifyRowConfidence(source.confidence)
  return (
    <li
      data-testid="drawer-source-field-block"
      data-mapping-source-id={source.id}
      data-ordinal={source.ordinal}
      className="space-y-1"
    >
      {/* Identity line: name · table · type · confidence */}
      <div
        data-testid="drawer-source-field-identity"
        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm"
      >
        <span
          data-testid="drawer-source-field-name"
          className="min-w-0 truncate font-mono text-slate-900"
          title={source.sourceField.name}
        >
          {source.sourceField.name}
        </span>
        <span aria-hidden="true" className="text-slate-400">
          ·
        </span>
        <span
          data-testid="drawer-source-field-table"
          className="truncate text-slate-600"
          title={source.sourceTable.name}
        >
          {source.sourceTable.name}
        </span>
        <span aria-hidden="true" className="text-slate-400">
          ·
        </span>
        <span
          data-testid="drawer-source-field-type"
          className="font-mono text-xs text-slate-500"
        >
          {source.sourceField.dataType}
        </span>
        {source.confidence !== null ? (
          <>
            <span aria-hidden="true" className="text-slate-400">
              ·
            </span>
            <span
              data-testid="drawer-source-field-confidence"
              data-confidence-band={confidenceBand ?? 'none'}
              className={cn(
                'tabular-nums',
                confidenceBand !== null
                  ? SOURCE_CONFIDENCE_BAND_CLASSNAME[confidenceBand]
                  : 'text-slate-500',
              )}
            >
              {formatConfidencePercent(source.confidence)}
            </span>
          </>
        ) : null}
      </div>

      {source.joinAnnotation ? (
        <div
          data-testid="drawer-source-field-join"
          className="text-[11px] italic text-slate-500"
        >
          {source.joinAnnotation}
        </div>
      ) : null}

      {source.sampleValues.length > 0 ? (
        <div data-testid="drawer-source-field-samples">
          <CollapsibleSection
            label="Sample values"
            count={source.sampleValues.length}
            toggleTestId="drawer-source-field-samples-toggle"
            panelTestId="drawer-source-field-sample-values-list"
          >
            <ul className="flex flex-col">
              {source.sampleValues.map((value, idx) => (
                <li
                  key={`${idx}-${value}`}
                  className={cn(
                    'border-b border-slate-100 py-1 last:border-b-0',
                    'break-words font-mono text-xs text-slate-700',
                  )}
                  data-testid="drawer-source-field-sample-row"
                >
                  {value}
                </li>
              ))}
            </ul>
          </CollapsibleSection>
        </div>
      ) : null}
    </li>
  )
}

// ── PR 3b refinement — collapsible section disclosure ──────────────────────
//
// Surfaced from Kaan's smoke test: multi-source TFMs were pushing
// TARGET FIELD offscreen with 30+ rows of expanded samples. The
// disclosure pattern now generalises across:
//   • Sample values lists in SOURCE FIELDS + TARGET FIELD (size='sm',
//     nested inside an outer block).
//   • DATA QUALITY (N) + DECISIONS (N) top-level sections inside the
//     mapped / VA / unmapped body (size='md', replaces the h3 heading
//     of a `DrawerSection` so the count chip itself is the toggle).
//
// Pattern mirrors `NestedAiReasoningDisclosure` — chevron + label
// in a single button, `aria-expanded` + `aria-controls` wired,
// children render inside a panel toggled by local `expanded` state.
// State is per-instance — instances don't share open/closed.
//
// Empty-content case is handled by the CALLER, not this helper.
// (Targets render a separate "No sample data available" line; DQ /
// Decisions sections collapse to null when count===0.)
function CollapsibleSection({
  label,
  count,
  toggleTestId,
  panelTestId,
  initialExpanded = false,
  size = 'sm',
  children,
}: {
  label: string
  count: number
  toggleTestId: string
  panelTestId?: string
  initialExpanded?: boolean
  size?: 'sm' | 'md'
  children: React.ReactNode
}) {
  const panelId = useId()
  const [expanded, setExpanded] = useState(initialExpanded)
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={panelId}
        data-testid={toggleTestId}
        className={cn(
          'inline-flex h-6 items-center gap-0.5 rounded px-1 font-medium uppercase tracking-wide',
          size === 'md' ? 'text-xs' : 'text-[11px]',
          'text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="h-3 w-3" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-3 w-3" />
        )}
        <span>
          {label} ({count})
        </span>
      </button>
      {expanded ? (
        <div
          id={panelId}
          data-testid={panelTestId}
          className={size === 'md' ? 'mt-2' : 'mt-1'}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

// ── PR 3b TARGET FIELD section ──────────────────────────────────────────────
//
// Renders for every variant (mapped, value_assignment, unmapped/
// rejected). Consumes the additive `TargetFieldRef` fields from PR 3a:
//
//   field_name · table_name · data_type
//   Primary key                          ← if isPrimaryKey
//   Foreign key → <fkReference>          ← if isForeignKey AND not PK
//   Required                             ← if !isNullable
//   Default: <defaultValue>              ← if defaultValue is non-null
//   Description: <description>           ← if description is non-null
//
//   Sample values:
//     "<value-1>"            (up to 5)
//     "<value-2>"
//   — OR —
//     No sample data available — target schema only
//
// PK / FK display: PK takes precedence. A target field that is BOTH
// PK and FK (compound key) shows only "Primary key" — keeps the
// section compact; the FK reference is recoverable from the target
// schema view. Spec §TASK 4B Q4.
//
// Target sample-values cap is 5 (UI-side cap, even though the wire
// carries up to 10). Read-only orientation; representative taste is
// enough — no expand affordance. Spec Q2.

const TARGET_SAMPLE_VALUES_UI_CAP = 5

function TargetFieldSection({
  targetField,
}: {
  targetField: TargetFieldRef
}) {
  const showPk = targetField.isPrimaryKey
  const showFk = !showPk && targetField.isForeignKey
  const showRequired = !targetField.isNullable
  const showDefault = targetField.defaultValue !== null
  const showDescription = targetField.description !== null
  const visibleSamples = targetField.sampleValues.slice(
    0,
    TARGET_SAMPLE_VALUES_UI_CAP,
  )

  return (
    <DrawerSection title="Target field" testId="drawer-section-target-field">
      <div className="space-y-1">
        <div
          data-testid="drawer-target-field-identity"
          className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm"
        >
          <span
            data-testid="drawer-target-field-name"
            className="min-w-0 truncate font-mono text-slate-900"
            title={targetField.name}
          >
            {targetField.name}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span
            data-testid="drawer-target-field-table"
            className="truncate text-slate-600"
            title={targetField.targetTable.name}
          >
            {targetField.targetTable.name}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            ·
          </span>
          <span
            data-testid="drawer-target-field-type"
            className="font-mono text-xs text-slate-500"
          >
            {targetField.dataType}
          </span>
        </div>

        {showPk ? (
          <div
            data-testid="drawer-target-field-pk"
            className="text-xs text-slate-600"
          >
            Primary key
          </div>
        ) : null}

        {showFk ? (
          <div
            data-testid="drawer-target-field-fk"
            className="text-xs text-slate-600"
          >
            Foreign key →{' '}
            <span className="font-mono text-slate-700">
              {targetField.fkReference}
            </span>
          </div>
        ) : null}

        {showRequired ? (
          <div
            data-testid="drawer-target-field-required"
            className="text-xs text-slate-600"
          >
            Required
          </div>
        ) : null}

        {showDefault ? (
          <div
            data-testid="drawer-target-field-default"
            className="text-xs text-slate-600"
          >
            Default:{' '}
            <span className="font-mono text-slate-700">
              {targetField.defaultValue}
            </span>
          </div>
        ) : null}

        {showDescription ? (
          <div
            data-testid="drawer-target-field-description"
            className="mt-2 text-xs text-slate-700"
          >
            {targetField.description}
          </div>
        ) : null}

        <div className="mt-3">
          {visibleSamples.length > 0 ? (
            <CollapsibleSection
              label="Sample values"
              count={visibleSamples.length}
              toggleTestId="drawer-target-field-samples-toggle"
              panelTestId="drawer-target-field-sample-values-list"
            >
              <ul className="flex flex-col">
                {visibleSamples.map((value, idx) => (
                  <li
                    key={`${idx}-${value}`}
                    className={cn(
                      'border-b border-slate-100 py-1 last:border-b-0',
                      'break-words font-mono text-xs text-slate-700',
                    )}
                    data-testid="drawer-target-field-sample-row"
                  >
                    {value}
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          ) : (
            <>
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Sample values
              </div>
              <p
                data-testid="drawer-target-field-no-samples"
                className="mt-1 text-xs italic text-slate-400"
              >
                No sample data available — target schema only
              </p>
            </>
          )}
        </div>
      </div>
    </DrawerSection>
  )
}

const UNMAPPED_EMPTY_STATE_COPY = 'No source mapped yet'

interface UnmappedBodyProps {
  row: UnmappedRow
  projectId: string | undefined
  /** Phase E PR α — Path D outputs sidecar for COVERAGE + DECISIONS. */
  pathDOutputs: PathDOutputs | null
  /** feat/mapping-drawer-redesign — which sub-tab content to render. */
  activeTab: DrawerTab
  /**
   * feat/drawer-body-editing-surface — "Pick a source…" promotion
   * handler. Commits `createMappingFromUnmapped`, promoting this
   * unmapped-target row to a mapped row.
   */
  onCreateMapping?: (
    sourceFieldId: string,
    targetFieldId: string,
  ) => Promise<{ success: boolean }>
  /** Source field universe for the "Pick a source…" picker. */
  availableSourceFields?: readonly SourceFieldWithState[]
}

function UnmappedBody({
  row,
  projectId,
  pathDOutputs,
  activeTab,
  onCreateMapping,
  availableSourceFields,
}: UnmappedBodyProps) {
  // feat/drawer-body-editing-surface — "Pick a source…" affordance.
  // The picker is an anchored popover; `pickerAnchor` holds the trigger
  // button element while open. Hooks stay above the activeTab early
  // return so the hook order is stable across tab switches.
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null)
  const pickButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeSourcePicker = useCallback(() => setPickerAnchor(null), [])
  const sourcePickable = Boolean(onCreateMapping && availableSourceFields)

  const handlePickSourceCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      const newId = newSourceFieldIds[0]
      if (!newId || !onCreateMapping) return { success: false }
      const result = await onCreateMapping(newId, row.targetField.id)
      if (result.success) setPickerAnchor(null)
      return result
    },
    [onCreateMapping, row.targetField.id],
  )
  // Phase E PR α — coverage rationale always renders (synthesized
  // "Manual entry required" orphan label when no coverage row exists).
  // Decisions render only when a coverage row exists AND it has
  // applicable decisions; otherwise the section collapses (Linear
  // pattern via DecisionList's empty-array short-circuit).
  const coverage = pathDOutputs?.coverageByTargetFieldId.get(row.targetField.id)
  const coverageDecisions = coverage
    ? pathDOutputs?.decisionsByCoverageId.get(coverage.id) ?? []
    : []

  // Drawer redesign PR 3b — body section order for unmapped /
  // rejected variants:
  //
  //   [rejected banner]  →  TARGET FIELD  →  TRANSFORMATION  →
  //   EXPLANATION  →  DECISIONS
  //
  // The legacy body SOURCE section (empty-state + CreateMappingForm
  // mount) is gone — the header's FROM stack source ✏ is the
  // source-creation entry point. The rejected banner remains, gated
  // on row.status === 'rejected'.
  const showRejectedBanner = row.status === 'rejected'

  // feat/mapping-drawer-redesign — same partition rule as MappedBody:
  // transform-related content lives on the Transform tab; everything
  // else (target identity, analysis, decisions, rejected banner) lives
  // on the Mapping tab.
  if (activeTab === 'transform') {
    return <TransformTabContent row={row} projectId={projectId} />
  }
  return (
    <>
      {showRejectedBanner ? (
        <div
          data-testid="drawer-unmapped-rejected-banner"
          className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
        >
          This target field was unmapped. Click{' '}
          <span className="font-medium">FROM</span> above to assign a new
          source.
        </div>
      ) : null}

      {sourcePickable ? (
        <section
          data-testid="drawer-section-unmapped-source"
          className="mb-4"
        >
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Source
          </h3>
          <button
            ref={pickButtonRef}
            type="button"
            data-testid="drawer-unmapped-pick-source"
            onClick={() => {
              if (pickButtonRef.current) {
                setPickerAnchor(pickButtonRef.current)
              }
            }}
            className={cn(
              'inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-2 py-1',
              'text-xs text-slate-500 transition-colors',
              'hover:border-slate-400 hover:text-slate-700',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
            )}
          >
            <Plus className="h-3 w-3" />
            <span>Pick a source…</span>
          </button>
        </section>
      ) : null}

      <TargetFieldSection targetField={row.targetField} />

      <AnalysisSection row={row} rowAiReasoningOverride={coverage?.ai_reasoning} />

      {coverageDecisions.length > 0 ? (
        <section
          className="mb-4 last:mb-0"
          data-testid="drawer-section-decisions"
        >
          <CollapsibleSection
            label="Decisions"
            count={coverageDecisions.length}
            toggleTestId="drawer-decisions-toggle"
            panelTestId="drawer-decisions-panel"
            size="md"
          >
            <DecisionList decisions={coverageDecisions} />
          </CollapsibleSection>
        </section>
      ) : null}

      {pickerAnchor && availableSourceFields ? (
        <InlineSourcePicker
          anchorRef={{ current: pickerAnchor }}
          initialSourceFieldIds={[]}
          availableSourceFields={[...availableSourceFields]}
          onCommit={handlePickSourceCommit}
          onClose={closeSourcePicker}
          mode="single"
          autoCommit={true}
        />
      ) : null}
    </>
  )
}

// ── VA — Value Assignment ──────────────────────────────────────────────────
//
// Drawer redesign refinements §3 (canary feedback): VA body order is
// now SOURCES → ANALYSIS → Value expression (drawer's structural lock —
// `Sources → Sample Values → Analysis → Transformation` collapses to
// three sections for VA because there are no sources to surface
// sample values for, and the Transformation slot is filled by the
// VA-specific `Value expression` section). The prior pass's leading
// OVERVIEW section is removed entirely; status + confidence move to
// the header SOURCE row top-right (Refinement 1) and AI reasoning
// moves into the new ANALYSIS section. Type compatibility is
// intentionally skipped for VAs — they have no source dataType to
// compare against.
function ValueAssignmentBody({
  row,
  pathDOutputs,
  activeTab,
}: {
  row: ValueAssignmentRow
  pathDOutputs: PathDOutputs | null
  activeTab: DrawerTab
}) {
  // Phase E PR α — decisions for this VA's TFM (no DQ section: VAs have
  // no source field to scope DQ findings to).
  const decisions = pathDOutputs?.decisionsByTfmId.get(row.id) ?? []

  // feat/mapping-drawer-redesign — VA body partitions by sub-tab:
  //   'mapping' tab   → TARGET FIELD · ANALYSIS · DECISIONS
  //   'transform' tab → VALUE EXPRESSION (the row's SQL — VAs author
  //                     transform-side prose here rather than via the
  //                     standalone Transform page).
  // The header's "Value assignment" italic label carries the
  // no-source signal so the Mapping tab doesn't need a placeholder
  // SOURCE section for VAs.
  if (activeTab === 'transform') {
    return (
      <DrawerSection
        title="Value expression"
        testId="drawer-section-value-expression"
      >
        {row.combinationSql ? (
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs text-slate-900"
            data-testid="drawer-value-expression"
          >
            {row.combinationSql}
          </pre>
        ) : (
          <DrawerEmptyState
            text="No expression authored yet"
            testId="drawer-value-expression-empty"
          />
        )}
      </DrawerSection>
    )
  }
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />

      <AnalysisSection row={row} />

      {decisions.length > 0 ? (
        <section
          className="mb-4 last:mb-0"
          data-testid="drawer-section-decisions"
        >
          <CollapsibleSection
            label="Decisions"
            count={decisions.length}
            toggleTestId="drawer-decisions-toggle"
            panelTestId="drawer-decisions-panel"
            size="md"
          >
            <DecisionList decisions={decisions} />
          </CollapsibleSection>
        </section>
      ) : null}
    </>
  )
}


// ── Mapped row body — drawer redesign ──────────────────────────────────────
//
// Drawer redesign refinements §3 (founder canary review): body
// section order is now
//
//   1. SOURCES         (always rendered; inline edit affordance in
//                       `headerAside` for needs_review + approved on
//                       non-custom_sql rows; per-source line shape is
//                       identity-only — type compatibility moved to
//                       ANALYSIS, sample values moved to SAMPLE
//                       VALUES. Combination label below the roster
//                       for multi-source rows.)
//   2. SAMPLE VALUES   (collapsible per-source field blocks; section
//                       omitted when no source has sample data.
//                       Single-source rows default the lone block to
//                       expanded; multi-source rows default all
//                       blocks collapsed. Section also hidden in
//                       edit-mode — sample values describe the
//                       existing row, not the in-flight form.)
//   3. ANALYSIS        (type compatibility line + AI reasoning
//                       disclosure. Type compat for the dominant
//                       source, always visible. AI reasoning
//                       collapsible — default-expanded for
//                       needs_review, default-collapsed for approved.
//                       Section also hidden in edit-mode for the same
//                       reason as SAMPLE VALUES.)
//   4. TRANSFORMATION  (per Q11.E lock — full read with description +
//                       SQL preview when hasTransformation; nav-only
//                       when absent on non-custom_sql mapped rows)
//
// Confidence + Status live in the header SOURCE row top-right
// (drawer redesign refinements §1 — `HeaderStatusBadge`). The
// standalone OVERVIEW section that shipped in the prior pass is
// removed entirely (drawer redesign refinements §2).
//
// Source ordering invariant: `sources[]` is server-emitted in ordinal-asc
// order. The roster MUST iterate verbatim — no client-side sort.

interface MappedBodyProps {
  row: MappedRow
  /** Required for the TRANSFORMATION section's deep-link route. */
  projectId: string | undefined
  /** Phase E PR α — Path D outputs sidecar for DATA QUALITY + DECISIONS. */
  pathDOutputs: PathDOutputs | null
  /** feat/mapping-drawer-redesign — which sub-tab content to render. */
  activeTab: DrawerTab
  /** feat/mapping-drawer-redesign — Remove mapping link click handler. */
  onRemoveMappingClick: () => void
  /** feat/mapping-drawer-header-redesign — body SOURCE column pencil swap. */
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  /** feat/mapping-drawer-header-redesign — body SOURCE column add/remove. */
  onEditSources?: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: 'single' | 'concat_space' | 'concat_comma'
  }) => Promise<{ success: boolean }>
  /** feat/drawer-body-editing-surface — body TARGET column pencil swap. */
  onSwapTarget?: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  /** Source field universe for body pickers. */
  availableSourceFields?: readonly SourceFieldWithState[]
  /** Target field universe for the body's TARGET column swap picker. */
  availableTargetFields?: readonly TargetFieldRef[]
}

function MappedBody({
  row,
  projectId,
  pathDOutputs,
  activeTab,
  onRemoveMappingClick,
  onSwapSource,
  onEditSources,
  onSwapTarget,
  availableSourceFields,
  availableTargetFields,
}: MappedBodyProps) {
  // feat/mapping-drawer-redesign — sections partition by sub-tab:
  //
  //   'mapping' tab   → SOURCE/TARGET two-column grid · WHY THIS MAPPING ·
  //                     SAMPLE SOURCE VALUES · (enrichment if present) ·
  //                     Remove mapping link
  //   'transform' tab → TRANSFORMATION (intent, status, SQL preview,
  //                     deep-link to /transform)
  //
  // DATA QUALITY + DECISIONS (MappedEnrichmentSections) stay on the
  // Mapping tab as conditional sections — the mockup doesn't show them
  // but they only render when Path D produced applicable findings, so
  // they degrade to nothing on projects without enrichment data
  // (matching the mockup empirically on the Rootstock POC).
  if (activeTab === 'transform') {
    return <TransformTabContent row={row} projectId={projectId} />
  }
  return (
    <>
      <MappingSourceTargetGrid
        tfmId={row.id}
        sources={row.sources}
        combinationType={row.combinationType}
        targetField={row.targetField}
        onSwapSource={onSwapSource}
        onEditSources={onEditSources}
        onSwapTarget={onSwapTarget}
        availableSourceFields={availableSourceFields}
        availableTargetFields={availableTargetFields}
      />
      <WhyThisMappingSection aiReasoning={row.aiReasoning} />
      <SampleSourceValuesSection
        sampleValues={row.sources[0].sampleValues}
        sourceFieldName={row.sources[0].sourceField.name}
      />
      <MappedEnrichmentSections row={row} pathDOutputs={pathDOutputs} />
      <RemoveMappingLink onClick={onRemoveMappingClick} />
    </>
  )
}

// ── feat/mapping-drawer-redesign — new Mapping-tab content blocks ─────────
//
// Four reusable section components matching the mockup spec. Each is a
// thin presentational helper — no external state, no fetching. Data
// comes in via props from the body kind that mounts them.

/**
 * Two-column SOURCE / TARGET grid for the Mapping sub-tab.
 *
 * Each column shows: column label (small-caps muted) · table name
 * (uppercase muted) · field chip (monospace) · data type
 * (e.g. `VARCHAR(16)`).
 *
 * Multi-source TFMs stack each source's block under the SOURCE column,
 * primary (sources[0]) first. The TARGET column is always a single block.
 *
 * feat/mapping-drawer-header-redesign — per-source editing affordances
 * relocated from the retired header pencils into the SOURCE column:
 *   • Per-source pencil ✏ — opens `InlineSourcePicker`, swaps that
 *     specific source via `onSwapSource(rowId, newSourceFieldId)` with
 *     `rowId = '<tfmId>::<msId>'` for multi-source rows, bare TFM uuid
 *     for single-source.
 *   • Per-source ✕ — calls `onEditSources({tfmId, sourceFieldIds:
 *     <filtered>, combinationType})` to drop the source. Rendered only
 *     when `sources.length > 1`; combinationType collapses to 'single'
 *     when one source remains. Single-source removal happens via the
 *     "Remove mapping" link at the bottom of the body.
 *   • "+ Add source" button — opens `InlineSourcePicker` with no
 *     initial selection, calls `onEditSources` with the new source
 *     appended; switches combinationType single → concat_space.
 *
 * Editing affordances render only when their handler props are threaded
 * AND `availableSourceFields` is provided. Otherwise the grid reads as
 * a static identity display (matches test mounts that don't wire the
 * commit handlers).
 */
function MappingSourceTargetGrid({
  tfmId,
  sources,
  combinationType,
  targetField,
  onSwapSource,
  onEditSources,
  onSwapTarget,
  availableSourceFields,
  availableTargetFields,
}: {
  tfmId: string
  sources: readonly MappingSourceRef[]
  combinationType: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'
  targetField: TargetFieldRef
  onSwapSource?: (
    rowId: string,
    newSourceFieldId: string,
  ) => Promise<{ success: boolean }>
  onEditSources?: (args: {
    tfmId: string
    sourceFieldIds: string[]
    combinationType: 'single' | 'concat_space' | 'concat_comma'
  }) => Promise<{ success: boolean }>
  onSwapTarget?: (
    tfmId: string,
    newTargetFieldId: string,
  ) => Promise<{ success: boolean }>
  availableSourceFields?: readonly SourceFieldWithState[]
  availableTargetFields?: readonly TargetFieldRef[]
}) {
  // Picker open state. Three modes:
  //   'swap-source'  — pencil clicked on a specific source block. The
  //                     picker pre-selects that source field; on commit
  //                     swap the single mapping_sources row via
  //                     `onSwapSource`.
  //   'add-source'   — "+ Add source" button clicked. Picker opens with
  //                     no initial selection; on commit append to the
  //                     existing source list via `onEditSources`.
  //   'swap-target'  — pencil clicked on the TARGET block. The picker
  //                     pre-selects the current target; on commit swap
  //                     the TFM's target field via `onSwapTarget`.
  type PickerState =
    | {
        mode: 'swap-source'
        anchorEl: HTMLElement
        sourceId: string
        sourceFieldId: string
      }
    | {
        mode: 'add-source'
        anchorEl: HTMLElement
      }
    | {
        mode: 'swap-target'
        anchorEl: HTMLElement
      }
    | null
  const [picker, setPicker] = useState<PickerState>(null)
  const closePicker = useCallback(() => setPicker(null), [])

  // Edit affordances render only when both the handler and the
  // available-source-fields universe are threaded.
  const editable = Boolean(
    onSwapSource && onEditSources && availableSourceFields,
  )
  // The TARGET pencil is gated independently — a row can be source-
  // editable without a target-swap handler threaded (test mounts).
  const targetEditable = Boolean(onSwapTarget && availableTargetFields)
  const isMulti = sources.length > 1

  // `editMappingSources` rejects `custom_sql`. For mapped rows this is
  // not 'custom_sql' in practice (custom_sql is VA territory); the
  // defensive fallback below mirrors the existing flat-view convention.
  const safeCombinationType: 'single' | 'concat_space' | 'concat_comma' =
    combinationType === 'single' ||
    combinationType === 'concat_space' ||
    combinationType === 'concat_comma'
      ? combinationType
      : 'concat_space'

  const handleSwapSourceClick = useCallback(
    (source: MappingSourceRef, anchorEl: HTMLElement) => {
      setPicker({
        mode: 'swap-source',
        anchorEl,
        sourceId: source.id,
        sourceFieldId: source.sourceField.id,
      })
    },
    [],
  )

  const handleRemoveSourceClick = useCallback(
    async (source: MappingSourceRef) => {
      if (!onEditSources) return
      const remainingIds = sources
        .filter((s) => s.id !== source.id)
        .map((s) => s.sourceField.id)
      if (remainingIds.length === 0) return // shouldn't happen — guarded by isMulti
      // Collapse to 'single' when exactly one source remains; otherwise
      // preserve the existing combinationType.
      const nextCombinationType =
        remainingIds.length === 1 ? 'single' : safeCombinationType
      await onEditSources({
        tfmId,
        sourceFieldIds: remainingIds,
        combinationType: nextCombinationType,
      })
    },
    [onEditSources, sources, tfmId, safeCombinationType],
  )

  const handleAddSourceClick = useCallback(
    (anchorEl: HTMLElement) => {
      setPicker({ mode: 'add-source', anchorEl })
    },
    [],
  )

  const handleSwapTargetClick = useCallback((anchorEl: HTMLElement) => {
    setPicker({ mode: 'swap-target', anchorEl })
  }, [])

  // Target swap is TFM-atomic. A TARGET_CONFLICT (the picked target is
  // already mapped) surfaces as an error toast from the mutation layer
  // and `{ success: false }` keeps the picker open for a retry.
  const handleTargetPickerCommit = useCallback(
    async (newTargetFieldId: string) => {
      if (!onSwapTarget) return { success: false }
      return onSwapTarget(tfmId, newTargetFieldId)
    },
    [onSwapTarget, tfmId],
  )

  const handlePickerCommit = useCallback(
    async (newSourceFieldIds: string[]) => {
      if (!picker) return { success: false }
      const newId = newSourceFieldIds[0]
      if (!newId) return { success: false }
      if (picker.mode === 'swap-source') {
        if (!onSwapSource) return { success: false }
        const rowId = isMulti ? `${tfmId}::${picker.sourceId}` : tfmId
        return onSwapSource(rowId, newId)
      }
      // 'add-source'
      if (!onEditSources) return { success: false }
      const existingIds = sources.map((s) => s.sourceField.id)
      const nextIds = [...existingIds, newId]
      // single + 1 new → concat_space (default multi combinator); else preserve.
      const nextCombinationType =
        combinationType === 'single' ? 'concat_space' : safeCombinationType
      return onEditSources({
        tfmId,
        sourceFieldIds: nextIds,
        combinationType: nextCombinationType,
      })
    },
    [
      picker,
      onSwapSource,
      onEditSources,
      sources,
      tfmId,
      isMulti,
      combinationType,
      safeCombinationType,
    ],
  )

  // Initial selection for the picker (single-pick autoCommit).
  const pickerInitialIds =
    picker?.mode === 'swap-source' ? [picker.sourceFieldId] : []

  return (
    <section data-testid="drawer-section-mapping-grid" className="mb-6">
      <div className="grid grid-cols-2 gap-6">
        <div data-testid="drawer-mapping-source-col">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Source
          </div>
          <div className="space-y-3">
            {sources.map((source) => (
              <MappingFieldBlock
                key={source.id}
                testIdPrefix="drawer-mapping-source"
                dataMappingSourceId={source.id}
                tableName={source.sourceTable.name}
                fieldName={source.sourceField.name}
                dataType={source.sourceField.dataType}
                onEditClick={
                  editable
                    ? (anchorEl) => handleSwapSourceClick(source, anchorEl)
                    : undefined
                }
                editAriaLabel={`Edit source ${source.sourceField.name}`}
                onRemoveClick={
                  editable && isMulti
                    ? () => void handleRemoveSourceClick(source)
                    : undefined
                }
                removeAriaLabel={`Remove source ${source.sourceField.name} from this mapping`}
              />
            ))}
          </div>
          {editable ? (
            <AddSourceButton onClick={handleAddSourceClick} />
          ) : null}
        </div>
        <div data-testid="drawer-mapping-target-col">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Target
          </div>
          <MappingFieldBlock
            testIdPrefix="drawer-mapping-target"
            tableName={targetField.targetTable.name}
            fieldName={targetField.name}
            dataType={targetField.dataType}
            onEditClick={
              targetEditable ? handleSwapTargetClick : undefined
            }
            editAriaLabel={`Edit target ${targetField.name}`}
          />
        </div>
      </div>
      {picker &&
      (picker.mode === 'swap-source' || picker.mode === 'add-source') &&
      availableSourceFields ? (
        <InlineSourcePicker
          anchorRef={{ current: picker.anchorEl }}
          initialSourceFieldIds={pickerInitialIds}
          availableSourceFields={[...availableSourceFields]}
          onCommit={handlePickerCommit}
          onClose={closePicker}
          mode="single"
          autoCommit={true}
        />
      ) : null}
      {picker && picker.mode === 'swap-target' && availableTargetFields ? (
        <TargetFieldCellPicker
          anchorRef={{ current: picker.anchorEl }}
          initialTargetFieldId={targetField.id}
          availableTargetFields={availableTargetFields}
          onCommit={handleTargetPickerCommit}
          onClose={closePicker}
        />
      ) : null}
    </section>
  )
}

/**
 * Per-side block inside the SOURCE/TARGET grid: table name (uppercase
 * muted) · field chip · data type. The chip uses the same gray monospace
 * pill aesthetic as the flat view's `FieldNameChip` so the drawer and
 * grid feel like one visual system.
 *
 * feat/mapping-drawer-header-redesign — source-side blocks gain
 * optional pencil (swap) + ✕ (remove) buttons. Both render only when
 * their handlers are threaded; target-side mounts leave them undefined
 * and stay read-only.
 */
function MappingFieldBlock({
  testIdPrefix,
  dataMappingSourceId,
  tableName,
  fieldName,
  dataType,
  onEditClick,
  editAriaLabel,
  onRemoveClick,
  removeAriaLabel,
}: {
  testIdPrefix: 'drawer-mapping-source' | 'drawer-mapping-target'
  dataMappingSourceId?: string
  tableName: string
  fieldName: string
  dataType: string
  /** Click handler for the pencil button. Anchor element threaded for the picker. */
  onEditClick?: (anchorEl: HTMLElement) => void
  editAriaLabel?: string
  /** Click handler for the ✕ button. */
  onRemoveClick?: () => void
  removeAriaLabel?: string
}) {
  const editButtonRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div
      data-testid={`${testIdPrefix}-block`}
      data-mapping-source-id={dataMappingSourceId}
      className="space-y-1"
    >
      <div
        data-testid={`${testIdPrefix}-table`}
        title={tableName}
        className="truncate text-[10px] font-medium uppercase tracking-wide text-slate-500"
      >
        {tableName}
      </div>
      <div className="flex items-center gap-1.5">
        <span
          data-testid={`${testIdPrefix}-field`}
          title={fieldName}
          className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 align-middle font-mono text-sm font-medium text-slate-700"
        >
          {fieldName}
        </span>
        {onEditClick ? (
          <button
            ref={editButtonRef}
            type="button"
            data-testid={`${testIdPrefix}-edit`}
            aria-label={editAriaLabel ?? 'Edit'}
            title={editAriaLabel ?? 'Edit'}
            onClick={() => {
              if (editButtonRef.current) onEditClick(editButtonRef.current)
            }}
            className={cn(
              'inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded',
              'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        ) : null}
        {onRemoveClick ? (
          <button
            type="button"
            data-testid={`${testIdPrefix}-remove`}
            aria-label={removeAriaLabel ?? 'Remove'}
            title={removeAriaLabel ?? 'Remove'}
            onClick={onRemoveClick}
            className={cn(
              'inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded',
              'text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300',
            )}
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <div
        data-testid={`${testIdPrefix}-type`}
        className="font-mono text-xs text-slate-500"
      >
        {dataType}
      </div>
    </div>
  )
}

/**
 * "+ Add source" button below the SOURCE column. Opens
 * `InlineSourcePicker` anchored on itself; the picker's commit appends
 * the chosen source field to the TFM's source list via
 * `onEditSources({sourceFieldIds: [...existing, new], combinationType})`.
 */
function AddSourceButton({
  onClick,
}: {
  onClick: (anchorEl: HTMLElement) => void
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="drawer-mapping-add-source"
      aria-label="Add another source field"
      onClick={() => {
        if (buttonRef.current) onClick(buttonRef.current)
      }}
      className={cn(
        'mt-3 inline-flex items-center gap-1 text-xs text-slate-500',
        'transition-colors hover:text-slate-800',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500',
      )}
    >
      <Plus className="h-3 w-3" />
      <span>Add source</span>
    </button>
  )
}

/**
 * WHY THIS MAPPING — full `aiReasoning` text in regular weight. Null
 * reasoning short-circuits to render nothing (don't render an empty
 * section label).
 */
// ── WHY THIS MAPPING — reasoning-text treatment (Refinement #5b) ─────────────
//
// `ai_reasoning` (post-PR #151: only the JSON `explanation` field) is a
// short multi-paragraph string with `\n\n` separators. The section is
// rendered for skimmability:
//   • `\n\n` → discrete <p> blocks (a single <p> folds them to one run).
//   • All-caps SQL keyword phrases + double-quoted values → inline <code>
//     chips (a smaller cousin of the field-name chip).
//   • A leading "Field type:" sentence → bold prefix.

const FIELD_TYPE_PREFIX = 'Field type:'

// Lone all-caps tokens promoted to inline code. Multi-word all-caps runs
// (NO INVENTORY, CASE WHEN) are always promoted; a single all-caps token
// is promoted only if it is a recognised SQL keyword — this keeps plain
// abbreviations (RCB, SKU, CRM, ID) as prose.
const REASONING_SQL_KEYWORDS = new Set<string>([
  'NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'COALESCE', 'CAST', 'CONCAT', 'NULLIF', 'TRUE', 'FALSE', 'DEFAULT',
])

// A double-quoted span OR a run of one-or-more all-caps words. Single-
// quoted spans are intentionally not matched — a lone apostrophe in
// prose ("doesn't"/"won't") would let the pattern swallow a sentence.
const REASONING_CODE_TOKEN_RE =
  /"[^"\n]+"|[A-Z][A-Z0-9_]+(?:\s[A-Z][A-Z0-9_]+)*/g

function isReasoningCodeToken(match: string): boolean {
  if (match.startsWith('"')) return true
  const words = match.split(/\s+/)
  if (words.length >= 2) return true
  return REASONING_SQL_KEYWORDS.has(words[0]!)
}

// Split a paragraph into plain-text + inline <code> nodes.
function renderReasoningInline(
  text: string,
  keyPrefix: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIndex = 0
  let codeIndex = 0
  for (const m of text.matchAll(REASONING_CODE_TOKEN_RE)) {
    const matchText = m[0]
    const at = m.index ?? 0
    if (!isReasoningCodeToken(matchText)) continue
    if (at > lastIndex) nodes.push(text.slice(lastIndex, at))
    nodes.push(
      <code
        key={`${keyPrefix}-code-${codeIndex}`}
        data-testid="drawer-why-this-mapping-code"
        className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700"
      >
        {matchText}
      </code>,
    )
    lastIndex = at + matchText.length
    codeIndex++
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}

function WhyThisMappingSection({ aiReasoning }: { aiReasoning: string | null }) {
  const text = aiReasoning?.trim()
  if (!text) return null
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  return (
    <section
      data-testid="drawer-section-why-this-mapping"
      className="mb-6"
    >
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
        Why this mapping
      </h3>
      {/* The `drawer-why-this-mapping-text` testid moves to this wrapper
          (now spanning every paragraph) so callers reading its
          textContent stay correct. */}
      <div
        data-testid="drawer-why-this-mapping-text"
        className="space-y-2"
      >
        {paragraphs.map((para, idx) => {
          const isLeading = idx === 0 && para.startsWith(FIELD_TYPE_PREFIX)
          return (
            <p
              key={idx}
              data-testid="drawer-why-this-mapping-paragraph"
              className="text-sm leading-relaxed text-slate-700"
            >
              {isLeading ? (
                <>
                  <span className="font-semibold text-slate-900">
                    {FIELD_TYPE_PREFIX}
                  </span>
                  {renderReasoningInline(
                    para.slice(FIELD_TYPE_PREFIX.length),
                    `p${idx}`,
                  )}
                </>
              ) : (
                renderReasoningInline(para, `p${idx}`)
              )}
            </p>
          )
        })}
      </div>
    </section>
  )
}

const SAMPLE_SOURCE_VALUES_MAX = 5

/**
 * SAMPLE SOURCE VALUES — up to 5 rows of sample data from the primary
 * source's `sampleValues`, each labeled `row N` (1-indexed) on the
 * right. Empty array short-circuits to render nothing.
 */
function SampleSourceValuesSection({
  sampleValues,
  sourceFieldName,
}: {
  sampleValues: readonly string[]
  /** Surfaced via `title` on the section heading so multi-source rows
   *  hint at which source the samples belong to. */
  sourceFieldName: string
}) {
  const rows = sampleValues.slice(0, SAMPLE_SOURCE_VALUES_MAX)
  if (rows.length === 0) return null
  return (
    <section
      data-testid="drawer-section-sample-source-values"
      className="mb-6"
    >
      <h3
        title={`Samples from ${sourceFieldName}`}
        className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500"
      >
        Sample source values
      </h3>
      <ul
        data-testid="drawer-sample-source-values-list"
        className="divide-y divide-slate-100 rounded border border-slate-200"
      >
        {rows.map((value, idx) => (
          <li
            key={`${idx}-${value}`}
            data-testid="drawer-sample-source-values-row"
            className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm"
          >
            <span className="min-w-0 flex-1 truncate break-words font-mono text-slate-700">
              {value}
            </span>
            <span className="shrink-0 text-[11px] text-slate-400">
              row {idx + 1}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Remove mapping link — bottom of the Mapping tab, red text, wires to
 * the same reject flow as the footer button (opens
 * `RejectConfirmDialog`, on confirm fires `handleRejectConfirm` →
 * `rejectFieldMapping`).
 */
function RemoveMappingLink({ onClick }: { onClick: () => void }) {
  return (
    <div className="mt-2 mb-2">
      <button
        type="button"
        data-testid="drawer-remove-mapping-link"
        onClick={onClick}
        className={cn(
          'text-sm text-red-600 underline-offset-2 hover:underline',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-red-500',
        )}
      >
        Remove mapping
      </button>
    </div>
  )
}

/**
 * Phase E PR α — DATA QUALITY + DECISIONS sections rendered at the tail
 * of `MappedBody`. Both collapse to nothing when the sidecar carries no
 * applicable rows. Hidden during edit-mode for the same reason as
 * SAMPLE VALUES + ANALYSIS — those sections describe the existing row,
 * not the in-flight form draft.
 *
 * DQ fan-in: every source field on the row is looked up against
 * `dqIssuesBySourceFieldId`. The flat-mapped result is de-duplicated by
 * issue id (a single DQ issue scoped to a shared source field would
 * otherwise render twice on a multi-source row that references it).
 *
 * Decisions fan-in: looked up by TFM id (`row.id`) against
 * `decisionsByTfmId`. Decisions tied to the row's coverage row (rather
 * than the TFM directly) are NOT surfaced on mapped rows in PR α — the
 * coverage-id channel is reserved for no-source rows where the coverage
 * row IS the row identity.
 */
function MappedEnrichmentSections({
  row,
  pathDOutputs,
}: {
  row: MappedRow
  pathDOutputs: PathDOutputs | null
}) {
  const dqIssues = collectDqIssuesForSources(row, pathDOutputs)
  const decisions = pathDOutputs?.decisionsByTfmId.get(row.id) ?? []

  if (dqIssues.length === 0 && decisions.length === 0) return null

  return (
    <>
      {dqIssues.length > 0 ? (
        <section
          className="mb-4 last:mb-0"
          data-testid="drawer-section-data-quality"
        >
          <CollapsibleSection
            label="Data quality"
            count={dqIssues.length}
            toggleTestId="drawer-data-quality-toggle"
            panelTestId="drawer-data-quality-panel"
            size="md"
          >
            <DQList issues={dqIssues} />
          </CollapsibleSection>
        </section>
      ) : null}

      {decisions.length > 0 ? (
        <section
          className="mb-4 last:mb-0"
          data-testid="drawer-section-decisions"
        >
          <CollapsibleSection
            label="Decisions"
            count={decisions.length}
            toggleTestId="drawer-decisions-toggle"
            panelTestId="drawer-decisions-panel"
            size="md"
          >
            <DecisionList decisions={decisions} />
          </CollapsibleSection>
        </section>
      ) : null}
    </>
  )
}

function collectDqIssuesForSources(
  row: MappedRow,
  pathDOutputs: PathDOutputs | null,
): ProjectDataQualityIssueRow[] {
  if (!pathDOutputs) return []
  const seen = new Set<string>()
  const out: ProjectDataQualityIssueRow[] = []
  for (const source of row.sources) {
    const issues =
      pathDOutputs.dqIssuesBySourceFieldId.get(source.sourceField.id) ?? []
    for (const issue of issues) {
      if (seen.has(issue.id)) continue
      seen.add(issue.id)
      out.push(issue)
    }
  }
  return out
}

/**
 * Build the per-source reasoning aggregate for `AiReasoningDisclosure`.
 * Filters out sources whose `aiReasoning` is null or whitespace-only so
 * the section doesn't render orphan empty paragraphs. Order preserved
 * from the input (server ordinal, dominant first) so the drawer
 * narrative matches the Sources section line order.
 */
function collectPerSourceReasonings(
  sources: readonly MappingSourceRef[],
): Array<{
  sourceId: string
  sourceTable: string
  sourceField: string
  reasoning: string
}> {
  return sources.flatMap((s) => {
    const trimmed = s.aiReasoning?.trim()
    if (!trimmed) return []
    return [
      {
        sourceId: s.id,
        sourceTable: s.sourceTable.name,
        sourceField: s.sourceField.name,
        reasoning: trimmed,
      },
    ]
  })
}

/**
 * Edit button rendered inside the Sources section header's `headerAside`
 * slot. Replaces the legacy footer Edit button per Q11.A lock — section-
 * scoped affordance reads cleaner than a row-level verb in the footer.
 *
 * Refinement 1 (canary feedback): the pencil-icon-only affordance was
 * too subtle. The button now renders as a small text link with a
 * leading pencil glyph, matching the "Define Transform ›" link
 * pattern in the Transformation section. The text "Edit" is the
 * primary affordance; the icon is decorative and reinforces the verb.
 *
 * The testid `mapping-drawer-edit-pencil` is preserved verbatim so
 * existing tests and edit-pencil dependents (D1/D2 tests, the inline
 * edit-form mount logic) continue to resolve the affordance without
 * a rename pass. The semantic shift (icon-only → text+icon) doesn't
 * change the testid contract.
 */

// ── Analysis section (drawer redesign refinements §4) ──────────────────────
//
// Drawer redesign refinements §4 (founder canary review): ANALYSIS is
// the third body section (drawer redesign refinements §3 ordering:
// SOURCES → SAMPLE VALUES → ANALYSIS → TRANSFORMATION). It's the
// "deep-dive" tier consolidating two pieces of information that the
// prior pass had bundled into the now-removed OVERVIEW section:
//
//   ┌─────────────────────────────────────────────┐
//   │ ANALYSIS                                    │
//   │ VARCHAR(4) → VARCHAR(10)  ✓ compatible      │   ← line 1: type compat (always visible)
//   │ ▸ AI reasoning  (collapsible)               │   ← line 2: AI reasoning disclosure
//   └─────────────────────────────────────────────┘
//
// Visibility matrix (drawer redesign refinements §4):
//
//   row.kind === 'mapped'        → ANALYSIS renders. Type compat
//                                  shows for the dominant source. AI
//                                  reasoning disclosure renders when
//                                  any row-level or per-source
//                                  reasoning is non-empty.
//   row.kind === 'value_assignment'
//                                → ANALYSIS renders only when AI
//                                  reasoning is non-empty. Type
//                                  compat is intentionally skipped
//                                  (VAs have no source dataType to
//                                  compare against).
//   row.kind === 'unmapped'      → ANALYSIS not rendered. `UnmappedBody`
//                                  doesn't mount this component (no
//                                  source = no type compat, no AI
//                                  reasoning to surface).
//
// AI reasoning disclosure (`NestedAiReasoningDisclosure`) keeps its
// Q11.B/Q11.C lock verbatim:
//   • Default-expanded for `needs_review` (review moment — user is
//     actively evaluating the AI's rationale).
//   • Default-collapsed for `approved` / other (already signed off).
//   • Disclosure mechanic, per-source aggregation, and reset-on-
//     status-change all carry over from the prior pass.

function AnalysisSection({
  row,
  rowAiReasoningOverride,
}: {
  row: MappedRow | ValueAssignmentRow | UnmappedRow
  rowAiReasoningOverride?: string | null
}) {
  const isMapped = row.kind === 'mapped'

  const perSourceReasonings = isMapped
    ? collectPerSourceReasonings(row.sources)
    : []
  const rowAiReasoning =
    row.kind === 'unmapped'
      ? row.aiReasoning ?? rowAiReasoningOverride ?? null
      : row.aiReasoning
  const hasAnyReasoning =
    rowAiReasoning !== null || perSourceReasonings.length > 0

  // Drawer redesign PR 3b — ANALYSIS section is now AI-reasoning
  // only. The type-comp `VARCHAR(80) → VARCHAR(100)` line moved into
  // the per-section type displays in the new SOURCE FIELDS + TARGET
  // FIELD sections — having each side show its own type lets users
  // compare directly without an aggregated verdict line. If there's
  // no AI reasoning to surface, the section omits itself entirely.
  if (!hasAnyReasoning) return null

  return (
    <DrawerSection title="Explanation" testId="drawer-section-analysis">
      <NestedAiReasoningDisclosure
        rowAiReasoning={rowAiReasoning}
        perSourceReasonings={perSourceReasonings}
        rowStatus={row.status}
      />
    </DrawerSection>
  )
}


// ── AI Reasoning disclosure (nested inside Analysis) ───────────────────────
//
// Q11.B/Q11.C lock (carried over from prior passes):
//   • Hidden entirely when neither row-level nor per-source reasoning
//     is present.
//   • Open by default for `needs_review` (review moment — user is
//     actively evaluating the AI's rationale).
//   • Closed by default for `approved` / other (already signed off).
//   • Disclosure mechanic mirrors the prior `AiReasoningDisclosure`
//     verbatim (chevron + `aria-expanded` + plain-text panel).
//
// Drawer redesign refinements §4: this disclosure renders INSIDE the
// new ANALYSIS section (the prior pass had it nested under OVERVIEW;
// OVERVIEW is removed entirely). The component drops the section
// wrapper but otherwise keeps the same shape — chevron + label at
// smaller text size to fit ANALYSIS's tighter context. The testid
// contract reuses `drawer-ai-reasoning-toggle` / `drawer-ai-reasoning`
// so existing tests resolving the affordance continue to pass.

function NestedAiReasoningDisclosure({
  rowAiReasoning,
  perSourceReasonings,
  rowStatus,
}: {
  rowAiReasoning: string | null
  perSourceReasonings: Array<{
    sourceId: string
    sourceTable: string
    sourceField: string
    reasoning: string
  }>
  rowStatus: MappingRow['status']
}) {
  const panelId = useId()
  const initialExpanded = rowStatus === 'needs_review'
  const [expanded, setExpanded] = useState(initialExpanded)

  // Reset open/closed default when the row's status flips between
  // approved ↔ needs_review (e.g. user approves from inside the drawer).
  const [lastStatus, setLastStatus] = useState(rowStatus)
  if (lastStatus !== rowStatus) {
    setLastStatus(rowStatus)
    setExpanded(rowStatus === 'needs_review')
  }

  return (
    <div className="mt-3" data-testid="drawer-analysis-ai-reasoning">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={panelId}
        data-testid="drawer-ai-reasoning-toggle"
        className={cn(
          'inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-medium',
          'text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="h-3 w-3" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-3 w-3" />
        )}
        <span>{expanded ? 'Hide AI reasoning' : 'AI reasoning'}</span>
      </button>
      {expanded ? (
        <div
          id={panelId}
          className="mt-2 space-y-2"
          data-testid="drawer-ai-reasoning"
        >
          {rowAiReasoning !== null ? (
            <p
              className="text-sm italic text-slate-600"
              data-testid="drawer-ai-reasoning-row"
            >
              {rowAiReasoning}
            </p>
          ) : null}
          {perSourceReasonings.map((entry) => (
            <p
              key={entry.sourceId}
              className="text-sm italic text-slate-600"
              data-testid="drawer-ai-reasoning-source"
              data-source-id={entry.sourceId}
            >
              <span className="not-italic font-mono text-xs font-medium text-slate-700">
                {entry.sourceTable}.{entry.sourceField}:
              </span>{' '}
              {entry.reasoning}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}


// ── Transformation section (Q11.E lock) ────────────────────────────────────
//
// Conditional render matrix (locked):
//
//   hasTransformation === true
//     → Full section: status pill + description + truncated SQL preview
//       block + "View in Transform →" link
//   !hasTransformation && row.kind === 'mapped' && combinationType !== 'custom_sql'
//     → Section header + "Define Transform →" inline link only
//   row.kind === 'value_assignment'
//     → Handled inline by ValueAssignmentBody as a "Value expression"
//       section (the VA's combinationSql is the value, not a transform).
//   row.kind === 'unmapped'
//     → Section hidden (no TFM, no transform).
//
// Status pill values from `transformationStatus`:
//   applied → green   tested/saved → blue   draft → slate   stale → amber
//
// "View / Define Transform →" routes to
// `/app/projects/<projectId>/transform?targetFieldMappingId=<row.id>`
// (the canonical Phase 3+ URL contract; the Transform page reads either
// `targetFieldMappingId` or the legacy `fieldMappingId` per
// `lib/url/transform-params.ts`).

const TRANSFORMATION_STATUS_PILL: Record<
  MappingTransformationStatus,
  { label: string; className: string }
> = {
  applied: {
    label: 'Applied',
    className: 'bg-green-100 text-green-800',
  },
  tested: {
    label: 'Tested',
    className: 'bg-blue-100 text-blue-800',
  },
  saved: {
    label: 'Saved',
    className: 'bg-blue-100 text-blue-800',
  },
  draft: {
    label: 'Draft',
    className: 'bg-slate-100 text-slate-700',
  },
  stale: {
    label: 'Stale',
    className: 'bg-amber-100 text-amber-800',
  },
}

// ── Transform tab — "Transformation needed" indicator (Refinement #5b) ───────
//
// Surfaces the wire `transformationNeeded` verdict above the
// TRANSFORMATION section. `null` / `undefined` (agent-generated projects
// without the field, coverage-only orphans) → render nothing rather than
// an empty label.
function TransformationNeededIndicator({
  needed,
}: {
  needed: boolean | null | undefined
}) {
  if (needed === null || needed === undefined) return null
  return (
    <div
      data-testid="drawer-transformation-needed"
      data-needed={needed ? 'yes' : 'no'}
      className="mb-3 flex items-center gap-1.5"
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          needed ? 'bg-emerald-500' : 'bg-slate-300',
        )}
      />
      <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        Transformation needed: {needed ? 'Yes' : 'No'}
      </span>
    </div>
  )
}

// Transform sub-tab content: the needed-indicator stacked above the
// TRANSFORMATION section. When `transformationNeeded === false` the
// section is dimmed — the recipe text (e.g. "Leave NULL — does not
// apply to RCB.") still shows but reads as "no transformation applied".
function TransformTabContent({
  row,
  projectId,
}: {
  row: MappedRow | UnmappedRow
  projectId: string | undefined
}) {
  const needed = row.transformationNeeded
  return (
    <>
      <TransformationNeededIndicator needed={needed} />
      <div
        data-testid="drawer-transformation-body"
        className={cn(needed === false && 'opacity-60')}
      >
        <TransformationSection row={row} projectId={projectId} />
      </div>
    </>
  )
}

function TransformationSection({
  row,
  projectId,
}: {
  row: MappedRow | UnmappedRow
  projectId: string | undefined
}) {
  // Resolve the Transform-page route once per render. The route shape
  // matches the existing Transform page's URL contract (deeplink reads
  // `targetFieldMappingId` per `lib/url/transform-params.ts`). When
  // `projectId` is unavailable (test contexts that mount the drawer
  // standalone without a parent), the link points at a same-page
  // anchor instead of throwing — defensive only; production always
  // has projectId.
  const transformHref = projectId
    ? `/app/projects/${projectId}/transform?targetFieldMappingId=${row.id}`
    : '#'
  const transformationIntent = row.transformationIntent?.trim() || null

  if (row.hasTransformation) {
    return (
      <DrawerSection
        title="Transformation"
        testId="drawer-section-transformation"
      >
        <div className="space-y-2">
          {transformationIntent ? (
            <p
              className="text-sm text-slate-700"
              data-testid="drawer-transformation-intent"
            >
              {transformationIntent}
            </p>
          ) : null}
          {row.transformationStatus ? (
            <TransformationStatusPill status={row.transformationStatus} />
          ) : null}
          {row.transformationDescription ? (
            <p
              className="text-sm text-slate-700"
              data-testid="drawer-transformation-description"
            >
              {row.transformationDescription}
            </p>
          ) : null}
          {row.transformationSqlPreview ? (
            <pre
              className={cn(
                'overflow-y-auto rounded bg-slate-50 px-3 py-2',
                'font-mono text-[11px] text-slate-900',
                'whitespace-pre-wrap break-words',
                'max-h-32',
              )}
              data-testid="drawer-transformation-sql-preview"
            >
              {row.transformationSqlPreview}
            </pre>
          ) : null}
          <TransformLink
            href={transformHref}
            label="View in Transform"
            testId="drawer-transformation-view-link"
          />
        </div>
      </DrawerSection>
    )
  }

  if (row.kind === 'unmapped') {
    if (!transformationIntent) return null
    return (
      <DrawerSection
        title="Transformation"
        testId="drawer-section-transformation"
      >
        <p
          className="text-sm text-slate-700"
          data-testid="drawer-transformation-intent"
        >
          {transformationIntent}
        </p>
      </DrawerSection>
    )
  }

  // No transformation. Show the "Define Transform →" affordance only for
  // non-custom_sql mapped rows — `custom_sql` flows author SQL through a
  // different surface entirely (the Transform page's custom-SQL editor),
  // and there's no inline transform-author flow to link to.
  if (row.combinationType === 'custom_sql' && !transformationIntent) return null

  return (
    <DrawerSection
      title="Transformation"
      testId="drawer-section-transformation"
    >
      <div data-testid="drawer-transformation-empty">
        {transformationIntent ? (
          <p
            className="mb-2 text-sm text-slate-700"
            data-testid="drawer-transformation-intent"
          >
            {transformationIntent}
          </p>
        ) : null}
        <TransformLink
          href={transformHref}
          label="Define Transform"
          testId="drawer-transformation-define-link"
        />
      </div>
    </DrawerSection>
  )
}

function TransformationStatusPill({
  status,
}: {
  status: MappingTransformationStatus
}) {
  const cfg = TRANSFORMATION_STATUS_PILL[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        cfg.className,
      )}
      data-testid={`drawer-transformation-status-${status}`}
    >
      {cfg.label}
    </span>
  )
}

function TransformLink({
  href,
  label,
  testId,
}: {
  href: string
  label: string
  testId: string
}) {
  // Refinement 2 (canary feedback): trailing icon switches from
  // `ExternalLink` (↗) to `ChevronRight` (›). The Transform page is
  // an in-app surface, not an external destination — the external
  // arrow signaled "leaves the app", which was misleading. The
  // chevron reads as "drill into" / "go to", consistent with native
  // app navigation patterns.
  return (
    <a
      href={href}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium text-blue-700',
        'hover:text-blue-800 hover:underline',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
      )}
    >
      <span>{label}</span>
      <ChevronRight aria-hidden="true" className="h-4 w-4" />
    </a>
  )
}

// ── Footer — Gap 9 ──────────────────────────────────────────────────────────
//
// Kind-dispatched action surface. Buttons are sticky-bottom so they
// remain visible while the body scrolls. The error banner sits
// immediately above the button row inside the same `<footer>` so
// keyboard tab order moves: body → error (if any) → Approve → Reject.
//
// Disabled-state matrix (founder decision 7 + the existing status
// taxonomy):
//
//   mapped/value_assignment + status='needs_review'
//     Approve: enabled    Reject: enabled
//   mapped/value_assignment + status='approved'
//     Approve: DISABLED ("already approved")    Reject: enabled
//   mapped/value_assignment + status='rejected'      ← legacy data
//     Approve: enabled (un-reject)               Reject: enabled (delete)
//   unmapped (status-driven, INF-57 cleanup):
//     status='needs_review' → Suggest with AI / Create mapping (form flow)
//     status='approved'     → Un-approve (resetMappingStatus)
//     status='rejected'     → Approve (re-approves coverage row)
//
// Optimistic-Approve overlay is applied at the row level before this
// component sees it, so the button row only needs to read `row.status`.

interface DrawerFooterProps {
  row: MappingRow
  errorMessage: string | null
  isApprovePending: boolean
  isRejecting: boolean
  optimisticallyApproved: boolean
  onApprove: () => void
  onRejectClick: () => void
  /**
   * INF-57 cleanup — true while the un-approve call (resetMappingStatus)
   * is in flight. Drives the spinner on the Un-approve button (and on
   * the confirm dialog's primary action).
   */
  isUnapproving: boolean
  /**
   * INF-57 cleanup — Un-approve click handler. Opens the confirm
   * dialog; the actual server call fires from the dialog's confirm
   * action.
   */
  onUnapproveClick: () => void
}

// PR 3b commit 3 — DrawerFooter is now Approve / Reject / Un-approve
// only. The form-active / edit-form-active mode-switches retired with
// CreateMappingForm. Footer dispatches by row.kind + status:
//   unmapped + approved → [Un-approve]
//   unmapped + rejected → [Approve]   (re-approves coverage row)
//   unmapped + needs_review → no footer affordance — header source ✏
//     creates the mapping
//   mapped / VA + needs_review / rejected → [Reject] [Approve]
//   mapped / VA + approved → [Reject]
function DrawerFooter({
  row,
  errorMessage,
  isApprovePending,
  isRejecting,
  optimisticallyApproved,
  onApprove,
  onRejectClick,
  isUnapproving,
  onUnapproveClick,
}: DrawerFooterProps) {
  return (
    <footer
      data-testid="mapping-drawer-footer"
      className="sticky bottom-0 z-10 border-t border-slate-200 bg-white px-5 py-3"
    >
      {errorMessage ? (
        <div
          role="alert"
          data-testid="mapping-drawer-error"
          className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
        >
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500"
          />
          <span className="leading-snug">{errorMessage}</span>
        </div>
      ) : null}
      {row.kind === 'unmapped' ? (
        <UnmappedFooterButtons
          status={row.status}
          isApprovePending={isApprovePending}
          isRejecting={isRejecting}
          optimisticallyApproved={optimisticallyApproved}
          onApprove={onApprove}
          onRejectClick={onRejectClick}
          isUnapproving={isUnapproving}
          onUnapproveClick={onUnapproveClick}
        />
      ) : (
        <ApproveRejectButtons
          status={row.status}
          isApprovePending={isApprovePending}
          isRejecting={isRejecting}
          optimisticallyApproved={optimisticallyApproved}
          onApprove={onApprove}
          onRejectClick={onRejectClick}
        />
      )}
    </footer>
  )
}

interface UnmappedFooterButtonsProps {
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped'
  isApprovePending: boolean
  isRejecting: boolean
  optimisticallyApproved: boolean
  onApprove: () => void
  onRejectClick: () => void
  isUnapproving: boolean
  onUnapproveClick: () => void
}

function UnmappedFooterButtons({
  status,
  isApprovePending,
  isRejecting,
  optimisticallyApproved,
  onApprove,
  onRejectClick,
  isUnapproving,
  onUnapproveClick,
}: UnmappedFooterButtonsProps) {
  if (status === 'approved') {
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="mapping-drawer-unapprove-button"
          aria-label="Un-approve mapping"
          onClick={onUnapproveClick}
          disabled={isUnapproving}
          className={cn(
            'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
            'border-blue-200 bg-white text-blue-700 hover:bg-blue-50',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/30',
            'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-slate-50',
          )}
        >
          {isUnapproving ? (
            <>
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
                data-testid="mapping-drawer-unapprove-spinner"
              />
              <span>Un-approving…</span>
            </>
          ) : (
            'Un-approve'
          )}
        </button>
      </div>
    )
  }

  if (status === 'rejected') {
    return (
      <ApproveRejectButtons
        status={status}
        isApprovePending={isApprovePending}
        isRejecting={isRejecting}
        optimisticallyApproved={optimisticallyApproved}
        onApprove={onApprove}
        onRejectClick={onRejectClick}
      />
    )
  }

  return (
    <ApproveRejectButtons
      status={status}
      isApprovePending={isApprovePending}
      isRejecting={isRejecting}
      optimisticallyApproved={optimisticallyApproved}
      onApprove={onApprove}
      onRejectClick={onRejectClick}
    />
  )
}

interface ApproveRejectButtonsProps {
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped'
  isApprovePending: boolean
  isRejecting: boolean
  optimisticallyApproved: boolean
  onApprove: () => void
  onRejectClick: () => void
}

// Drawer redesign — Q11.A lock:
//   needs_review            → [Reject] [Approve]
//   approved                → [Reject]                  (Approve hidden — already approved)
//   rejected (legacy data)  → [Reject] [Approve]        (Approve = un-reject path)
function ApproveRejectButtons({
  status,
  isApprovePending,
  isRejecting,
  optimisticallyApproved,
  onApprove,
  onRejectClick,
}: ApproveRejectButtonsProps) {
  const showApprove =
    !optimisticallyApproved &&
    (status === 'needs_review' || status === 'rejected')
  const approveDisabled = isApprovePending || isRejecting
  const rejectDisabled = isApprovePending || isRejecting

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        data-testid="mapping-drawer-reject-button"
        aria-label="Reject mapping"
        onClick={onRejectClick}
        disabled={rejectDisabled}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
          'border-red-200 bg-white text-red-700 hover:bg-red-50',
          'focus:outline-none focus:ring-2 focus:ring-red-500/30',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-slate-50',
        )}
      >
        {isRejecting ? (
          <>
            <Loader2
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin"
              data-testid="mapping-drawer-reject-spinner"
            />
            <span>Rejecting…</span>
          </>
        ) : (
          'Reject'
        )}
      </button>
      {showApprove ? (
        <button
          type="button"
          data-testid="mapping-drawer-approve-button"
          aria-label="Approve mapping"
          onClick={onApprove}
          disabled={approveDisabled}
          className={cn(
            'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
            'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
            'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
          )}
        >
          Approve
        </button>
      ) : null}
    </div>
  )
}


// ── Reject confirmation dialog ──────────────────────────────────────────────
//
// Locked copy (Gap 9 alignment):
//
//   Title:  "Reject this mapping?"
//   Body:   "<field_name> will become unmapped. The mapping and any
//            associated transformation will be deleted. This cannot be
//            undone."
//   Buttons: "Cancel" (default) + "Reject" (destructive)
//
// The dialog reuses `components/ui/alert-dialog.tsx` (the hand-rolled
// shadcn AlertDialog used elsewhere in the app — Transform / FK
// cascade prompts). We force `AlertDialogAction`'s default blue styling
// to red to signal destructive intent.

interface RejectConfirmDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  targetFieldName: string
  isRejecting: boolean
  onConfirm: () => void
}

function RejectConfirmDialog({
  open,
  onOpenChange,
  targetFieldName,
  isRejecting,
  onConfirm,
}: RejectConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="mapping-drawer-reject-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this mapping?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-slate-900">{targetFieldName}</span>{' '}
            will become unmapped. The mapping and any associated transformation
            will be deleted. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={isRejecting}
            data-testid="mapping-drawer-reject-cancel"
            onClick={() => {
              if (!isRejecting) onOpenChange(false)
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Prevent the AlertDialog from auto-closing — we close
              // explicitly on success / failure inside `onConfirm` so
              // the loading-state spinner has time to render.
              e.preventDefault()
              onConfirm()
            }}
            disabled={isRejecting}
            data-testid="mapping-drawer-reject-confirm"
            className="bg-red-600 hover:bg-red-700 focus:ring-red-500/40"
          >
            {isRejecting ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
                Rejecting…
              </>
            ) : (
              'Reject'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ── Un-approve confirmation dialog (INF-57 cleanup) ─────────────────────────
//
// Locked copy:
//
//   Title:  "Un-approve this mapping?"
//   Body:   "This will return <field_name> to needs review. The mapping is
//            unchanged."
//   Buttons: "Cancel" (default) + "Un-approve" (neutral, not destructive —
//            the operation is reversible by re-approving through the
//            existing approve flow; only the row's coverage status flips).
//
// Visually distinct from RejectConfirmDialog: button uses the default blue
// styling rather than red because un-approve is NOT a destructive
// "delete and lose data" action — it just flips the coverage row's status
// back to needs_review.

interface UnapproveConfirmDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  targetFieldName: string
  isUnapproving: boolean
  onConfirm: () => void
}

function UnapproveConfirmDialog({
  open,
  onOpenChange,
  targetFieldName,
  isUnapproving,
  onConfirm,
}: UnapproveConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="mapping-drawer-unapprove-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Un-approve this mapping?</AlertDialogTitle>
          <AlertDialogDescription>
            This will return{' '}
            <span className="font-mono text-slate-900">{targetFieldName}</span>{' '}
            to needs review. The mapping is unchanged.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={isUnapproving}
            data-testid="mapping-drawer-unapprove-cancel"
            onClick={() => {
              if (!isUnapproving) onOpenChange(false)
            }}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              // Same pattern as RejectConfirmDialog — close explicitly
              // inside onConfirm so the spinner has time to render.
              e.preventDefault()
              onConfirm()
            }}
            disabled={isUnapproving}
            data-testid="mapping-drawer-unapprove-confirm"
          >
            {isUnapproving ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
                Un-approving…
              </>
            ) : (
              'Un-approve'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
