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
  Sparkles,
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
import { CoverageSection } from './CoverageSection'
import { DecisionList } from './DecisionList'
import { DQList } from './DQList'
import {
  approveFieldMapping,
  previewEditInvalidation,
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
import {
  CreateMappingForm,
  type CreateMappingFormHandle,
  type CreateMappingFormSnapshot,
  type EditMappingInitialState,
  type EditSaveMeta,
} from './CreateMappingForm'
import { DrawerHeader } from './DrawerHeader'
import { EditInvalidationDialog } from './EditInvalidationDialog'

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
//   unmapped            → UnmappedBody         (Source / Coverage / Decisions —
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
// The drawer is deliberately tab-LESS; the spec's Details/Source/Transform
// tabs were retired at Gap 7 in favour of kind-dispatched single-page bodies.
// Founder Q3.
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

export interface MappingDrawerProps {
  /**
   * Row to show in the drawer. When `null` the drawer renders nothing
   * (no DOM at all). The parent decides whether to keep the row prop in
   * sync with `isOpen` — this component does not animate exit on its own.
   */
  row: MappingRow | null
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
   * Phase 4a-2 — required by the manual mapping creation form (W1)
   * when a Rule 6 unmapped drawer is open and the user clicks
   * [Create mapping]. The form invokes `createFieldMapping` with this
   * `projectId`. May be undefined for tests / non-unmapped rows.
   */
  projectId?: string
  /**
   * Phase 4a-2 — page-level source fields in canonical server order.
   * Required when the form is reachable (Rule 6 unmapped rows).
   * Optional otherwise.
   */
  availableSourceFields?: SourceFieldWithState[]
  /**
   * Phase 4a-2 — called with the new TFM id after `createFieldMapping`
   * succeeds. Parent should swap the drawer URL param from
   * `unmapped::<targetFieldId>` to the bare TFM uuid + arm the
   * `pendingDrawerRowId` sentinel so the auto-close-on-stale-id
   * effect doesn't unmount the drawer mid-refresh.
   *
   * Phase 4b-1 — `meta` is set when the save was an EDIT (W2/W3) of an
   * existing TFM. The parent uses it to drive the post-save toast:
   * "Mapping updated. <N> staged rows invalidated. [Re-author transform]"
   * with a deep-link to the Transform tab when `transformReset === true`.
   * For create-mode saves `meta` is omitted (callers should still
   * call `router.refresh()` to surface the new row).
   */
  onSaveSuccess?: (tfmId: string, meta?: EditSaveMeta) => void
  /**
   * Phase 4a-4a — fired whenever the unmapped-row form's dirty state
   * flips. Carries the dirty snapshot when the form has selections,
   * `null` when the form is clean (or absent). `MappingContent`
   * stores the latest snapshot so a row-switch can offer Undo.
   */
  onFormDirtyChange?: (snapshot: CreateMappingFormSnapshot | null) => void
  /**
   * Phase 4a-4a — when present and the snapshot's `targetFieldId`
   * matches the current row's target field, the drawer auto-activates
   * the form and threads the snapshot down to `CreateMappingForm` for
   * mount-time hydration. Cleared by the parent via
   * `onRestoreConsumed` once the form has consumed it.
   */
  restoreFormState?: CreateMappingFormSnapshot | null
  /** See `restoreFormState`. */
  onRestoreConsumed?: () => void
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
}

/**
 * Right-side drawer shell. See file header for the full Gap 7 contract.
 */
export function MappingDrawer({
  row,
  isOpen,
  onClose,
  onActionComplete,
  projectId,
  availableSourceFields,
  onSaveSuccess,
  onFormDirtyChange,
  restoreFormState,
  onRestoreConsumed,
  pathDOutputs,
  highlightedSourceFieldId,
  availableTargetFields,
  onSwapTarget,
  onSwapSource,
  onEditSources,
  onUnmapMapping,
  onCreateMapping,
  onNavigateTarget,
}: MappingDrawerProps) {
  const titleId = useId()
  const drawerRef = useRef<HTMLElement | null>(null)
  // Track the element that had focus before the drawer opened so we can
  // restore focus to it on close. We grab the active element synchronously
  // when `isOpen` flips from false → true; restoring on close happens in
  // the cleanup of the same effect.
  const triggerRef = useRef<HTMLElement | null>(null)

  // ── Phase 4a-2 — manual mapping creation form state ───────────────
  //
  // `isFormActive` toggles the unmapped body between the empty-state
  // prose and the `CreateMappingForm`. The footer mirrors this flag:
  // `[Create mapping]` when inactive, `[Cancel]` `[Save mapping]`
  // when active. `formState` is published from the form via its
  // `onStateChange` prop and drives:
  //   • The Save button's disabled flag (`!canSave`)
  //   • The close-with-confirm intercept (the `requestClose` flow on
  //     the form handle reads `isDirty` internally; this lifted copy
  //     is for footer button display only).
  //   • The maybeRequestClose helper (Esc / X / click-outside / Cancel
  //     all route through `formRef.current.requestClose()` which
  //     either pops the discard dialog when dirty or invokes
  //     `onCancel` immediately when clean).
  const [isFormActive, setIsFormActive] = useState(false)
  const [formState, setFormState] = useState<{
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
  }>({ isDirty: false, canSave: false, isSavePending: false })
  const formRef = useRef<CreateMappingFormHandle | null>(null)

  // ── Phase 4b-1 — edit-mode form state ─────────────────────────────
  //
  // `editFormActive`: when true on a mapped row (status approved or
  // needs_review per §3.2), the body switches from `MappedBody` to
  // a `CreateMappingForm` in `mode='edit'` and the footer transitions
  // to `[Cancel] [Save changes]`.
  //
  // `editInitialState`: hydration payload built from the current
  // mapped row's sources + combination type when the user clicks
  // [Edit]. Held at the drawer level (not the form) so the drawer
  // can read it for `previewEditInvalidation` lookups before save.
  //
  // `editInvalidationPreview`: result of the in-flight or last-
  // resolved `previewEditInvalidation` call. When non-null AND
  // `hasTransform === true`, the drawer pops the EditInvalidationDialog
  // before forwarding `triggerSave` to the form. Cleared on dialog
  // confirm or cancel.
  //
  // `isEditPreviewPending`: shown as a save-button spinner while the
  // preview is in flight. Disables the Save button to prevent double-
  // submission.
  //
  // `editPreviewError`: surfaced as the footer error banner if the
  // preview RPC fails. The user can retry via the same Save button.
  // Edit-only — does not interact with the create-mode error surface.
  const [editFormActive, setEditFormActive] = useState(false)
  const [editInitialState, setEditInitialState] =
    useState<EditMappingInitialState | null>(null)
  const [editInvalidationPreview, setEditInvalidationPreview] = useState<{
    hasTransform: boolean
    stagedRowCount: number
    capped: boolean
  } | null>(null)
  const [isEditPreviewPending, setIsEditPreviewPending] = useState(false)
  const [editPreviewError, setEditPreviewError] = useState<string | null>(null)

  // ── Phase 4a-4b — AI Suggest mode plumbing ───────────────────────
  //
  // `autoSuggestRequested`: latched true when the user clicks the
  // unmapped-row footer's [Suggest with AI] button. The drawer flips
  // both this AND `isFormActive=true` so the form mounts and immediately
  // sees `autoSuggest=true` on its first render. The form consumes it
  // via its mount-time effect and calls `onAutoSuggestConsumed`, which
  // flips this back to false. Reset on row.id change as defense-in-
  // depth (the form unmounts on row change, so consumed state would be
  // pre-cleared anyway, but this protects against future drift where
  // the form might persist across rows).
  //
  // `isSuggestPending`: mirrored from the form's `onSuggestStateChange`
  // callback. Drives the footer's mode-switch to a single
  // [Cancel suggestion] button while the LLM call is in flight.
  const [autoSuggestRequested, setAutoSuggestRequested] = useState(false)
  const [isSuggestPending, setIsSuggestPending] = useState(false)

  // ── Phase 4a-4b — strict-mode-resistant auto-suggest consumption ──
  //
  // The drawer owns the consumption guard so it survives the form's
  // strict-mode unmount/remount cycle in dev (Next.js 14 has
  // `reactStrictMode: true` by default for app router). A `useRef`
  // *inside the form* would reset on remount and let the auto-suggest
  // effect fire twice — issuing two server-side LLM calls per click
  // even though only the second result lands in UI.
  //
  // The Set is keyed by target field id (rather than row.id) because
  // unmapped row identity is `unmapped::${target_field_id}` — the
  // target field id is the stable invariant across row reshuffles.
  // Cleared on:
  //   • row identity change (defense-in-depth, alongside the existing
  //     reset effect)
  //   • a fresh user click on [Suggest with AI] in the footer (so a
  //     re-request after cancel fires correctly)
  const autoSuggestConsumedRowsRef = useRef<Set<string>>(new Set())
  const tryConsumeAutoSuggest = useCallback(
    (targetFieldId: string): boolean => {
      if (autoSuggestConsumedRowsRef.current.has(targetFieldId)) return false
      autoSuggestConsumedRowsRef.current.add(targetFieldId)
      return true
    },
    [],
  )

  // Reset form state on every row identity change. Founder decision §8 —
  // switch-row-while-dirty is a silent unmount (in 4a-4a the parent
  // additionally fires a row-switch-discard toast with Undo). We do
  // NOT route through the discard dialog here; the user explicitly
  // chose to view a different row, and prompting on every row click
  // would feel hostile.
  const rowIdForFormReset = row?.id ?? null
  useEffect(() => {
    setIsFormActive(false)
    setFormState({ isDirty: false, canSave: false, isSavePending: false })
    // Phase 4a-4b — reset AI Suggest mode state on row swap. Defense-
    // in-depth; the form unmounts on row change so its internal state
    // is gone, but these drawer-level mirrors must clear too.
    setAutoSuggestRequested(false)
    setIsSuggestPending(false)
    // Phase 4a-4b — clear the auto-suggest consumption Set on row swap
    // so a new row's first auto-suggest can fire even if a prior row
    // already populated the Set.
    autoSuggestConsumedRowsRef.current.clear()
    // Phase 4b-1 — clear edit-mode state on row swap. Same rationale
    // as the create-mode reset above: the row identity is the form's
    // mount key, so anything not re-derived from the new row's
    // contract would be stale.
    setEditFormActive(false)
    setEditInitialState(null)
    setEditInvalidationPreview(null)
    setIsEditPreviewPending(false)
    setEditPreviewError(null)
  }, [rowIdForFormReset])

  // Phase 4a-4a — restoreFormState auto-activate.
  //
  // When `MappingContent` passes a non-null snapshot whose
  // `targetFieldId` matches the current Rule 6 row's target field, we
  // flip `isFormActive` to true so the form mounts and consumes the
  // snapshot via its own mount-time hydration effect. Runs AFTER the
  // row-id reset effect (declaration order = run order in React) so
  // any stale `false` from the reset is immediately corrected to
  // `true` on the same render where the restore arrives.
  const restoreTargetFieldId = restoreFormState?.targetFieldId
  const currentTargetFieldId =
    row?.kind === 'unmapped' ? row.targetField.id : null
  useEffect(() => {
    if (
      restoreFormState &&
      currentTargetFieldId !== null &&
      restoreTargetFieldId === currentTargetFieldId
    ) {
      setIsFormActive(true)
    }
  }, [restoreFormState, restoreTargetFieldId, currentTargetFieldId])

  // Phase 4a-4a — dirty-change lift.
  //
  // The form publishes its full state via `onStateChange`. We mirror
  // it locally for footer display AND bubble the snapshot up so the
  // parent can keep a "latest dirty snapshot" cache for row-switch
  // undo. Snapshot is null when the form is clean OR absent.
  const handleFormStateChange = useCallback(
    (state: {
      isDirty: boolean
      canSave: boolean
      isSavePending: boolean
      snapshot: CreateMappingFormSnapshot | null
    }) => {
      setFormState({
        isDirty: state.isDirty,
        canSave: state.canSave,
        isSavePending: state.isSavePending,
      })
      onFormDirtyChange?.(state.snapshot)
    },
    [onFormDirtyChange],
  )

  // When the form un-mounts (drawer closes / row swaps / form
  // cancelled), publish a clean snapshot so the parent doesn't hold
  // a stale "dirty for row X" reference indefinitely.
  useEffect(() => {
    if (!isFormActive) {
      onFormDirtyChange?.(null)
    }
  }, [isFormActive, onFormDirtyChange])

  // Stable-onClose ref so the document-level handlers below don't have
  // to re-bind on every render of the parent.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // ── Close intercept — routes through the form when active ────────
  //
  // Esc / click-outside / X-button / Cancel-button all call
  // `maybeRequestClose`. When the form is active we hand off to its
  // imperative `requestClose` method, which decides between the
  // discard dialog (dirty) and immediate cancel (clean). When the
  // form is inactive we close the drawer normally.
  //
  // `maybeRequestCloseRef` keeps the document-level Esc / mousedown
  // listeners stable across renders.
  const maybeRequestClose = useCallback(() => {
    // Phase 4b-1 — when the edit form is active, route close intents
    // (Esc / X / click-outside / Cancel) through the form's
    // `requestClose` so a dirty edit pops the discard dialog before
    // tearing down the drawer. Same pattern as create-mode.
    if ((isFormActive || editFormActive) && formRef.current) {
      formRef.current.requestClose()
      return
    }
    onCloseRef.current()
  }, [isFormActive, editFormActive])
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
      row.id === optimisticApprove.rowId &&
      row.status === 'approved'
    ) {
      setOptimisticApprove(null)
    }
  }, [row?.id, row?.status, optimisticApprove])

  const effectiveRow = useMemo<MappingRow | null>(() => {
    if (!row) return null
    if (optimisticApprove && optimisticApprove.rowId === row.id) {
      return applyOptimisticApprove(row)
    }
    return row
  }, [row, optimisticApprove])

  const handleApprove = useCallback(() => {
    if (!row) return
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
    if (!row) return
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
    if (!row || row.status !== 'approved') return
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

  // ── Phase 4b-1 — edit-mode handlers ──────────────────────────────
  //
  // `handleEditClick`: invoked by the Edit button on mapped rows.
  //   1. Build `editInitialState` from the current row's sources +
  //      combinationType. Source field ids are extracted in ordinal
  //      order (no client sort — server emits ordinal-asc).
  //   2. Recover any `joinAnnotations` from the current row's
  //      `joinSpec.byJoinedTableId` map (Phase 4a-3 contract).
  //      Pre-population matches founder decision §5.2.
  //   3. Flip `editFormActive=true`. The body re-mounts to the form,
  //      the footer transitions to [Cancel] [Save changes].
  //
  // `handleEditFormCancel`: invoked when the form's discard dialog
  //   resolves (clean → immediate; dirty → after confirm). Clears
  //   edit state and returns the drawer body to MappedBody.
  //
  // `handleEditSavePrecheck`: invoked by the Save button. Runs
  //   `previewEditInvalidation`. If the result indicates a transform
  //   exists with staged rows, populates `editInvalidationPreview`
  //   so the EditInvalidationDialog renders. Otherwise calls
  //   `formRef.current.triggerSave()` directly.
  //
  // `handleEditInvalidationConfirm`: dialog [Save and reset transform]
  //   handler. Clears the preview and forwards to the form.
  //
  // `handleEditInvalidationCancel`: dialog [Cancel] handler. Clears
  //   the preview; the user remains in edit mode.
  //
  // `handleEditFormSaveSuccess`: invoked by the form once
  //   `editMappingSources` resolves. Clears all edit state, fires
  //   `onSaveSuccess` to the parent with the EditSaveMeta payload
  //   (parent runs router.refresh + post-save toast), and lets the
  //   drawer settle on the freshly-rendered MappedBody.
  const handleEditClick = useCallback(() => {
    if (!row || row.kind !== 'mapped') return
    // Status guard mirrors §3.2 — Edit is hidden on rejected / unmapped,
    // but defensively bail here too.
    if (row.status !== 'approved' && row.status !== 'needs_review') return

    const sourceFieldIds = row.sources.map((s) => s.sourceField.id)
    // Pre-populate joinAnnotations from each cross-table source's
    // `joinSpec.viaFkField` (the FK field NAME in the dominant table
    // pointing at this joined table). Per founder decision §5.2,
    // unchanged joined tables retain their annotations across edits;
    // the form's `cleanup` effect drops entries whose chip the user
    // removes. Same-table sources have `joinSpec === null` and are
    // skipped — they don't contribute to disambiguation.
    const joinAnnotations: Record<string, string> = {}
    for (const src of row.sources) {
      if (src.joinSpec) {
        joinAnnotations[src.sourceTable.id] = src.joinSpec.viaFkField
      }
    }

    // Phase 4b-1 — `combinationType: 'custom_sql'` is a Transform-tab
    // concern; the inline form does not author SQL. Defensively
    // refuse to enter edit mode for custom_sql TFMs (the Edit button
    // should be hidden for these by the footer dispatch, but defense
    // in depth — a future regression would otherwise fall through to
    // a form that can't represent the row's combination).
    if (row.combinationType === 'custom_sql') return

    setEditInitialState({
      tfmId: row.id,
      selectedIds: sourceFieldIds,
      combinationType: row.combinationType,
      joinAnnotations,
    })
    setEditInvalidationPreview(null)
    setEditPreviewError(null)
    setEditFormActive(true)
  }, [row])

  const handleEditFormCancel = useCallback(() => {
    setEditFormActive(false)
    setEditInitialState(null)
    setEditInvalidationPreview(null)
    setEditPreviewError(null)
  }, [])

  const handleEditSavePrecheck = useCallback(async () => {
    if (!editInitialState) return
    if (formState.isSavePending || isEditPreviewPending) return
    setEditPreviewError(null)
    setIsEditPreviewPending(true)
    try {
      const result = await previewEditInvalidation(editInitialState.tfmId)
      if (!result.success) {
        // Errors here are non-blocking — the user can still save (the
        // wrapper will re-validate server-side). Surface the error in
        // the footer banner so they can retry, but don't strand them.
        setEditPreviewError(
          "Couldn't check whether your edit will reset a transform. " +
            'You can still save; we will re-check server-side.',
        )
        return
      }
      const shouldWarn = result.hasTransform && result.stagedRowCount > 0
      if (shouldWarn) {
        setEditInvalidationPreview({
          hasTransform: result.hasTransform,
          stagedRowCount: result.stagedRowCount,
          capped: result.capped,
        })
        return
      }
      formRef.current?.triggerSave()
    } catch (err) {
      setEditPreviewError(
        "Couldn't check whether your edit will reset a transform. " +
          'You can still save; we will re-check server-side.',
      )
      if (typeof console !== 'undefined') {
        console.error('[MappingDrawer] previewEditInvalidation threw:', err)
      }
    } finally {
      setIsEditPreviewPending(false)
    }
  }, [editInitialState, formState.isSavePending, isEditPreviewPending])

  const handleEditInvalidationConfirm = useCallback(() => {
    setEditInvalidationPreview(null)
    formRef.current?.triggerSave()
  }, [])

  const handleEditInvalidationCancel = useCallback(() => {
    setEditInvalidationPreview(null)
  }, [])

  const handleEditFormSaveSuccess = useCallback(
    (tfmId: string, meta?: EditSaveMeta) => {
      setEditFormActive(false)
      setEditInitialState(null)
      setEditInvalidationPreview(null)
      setEditPreviewError(null)
      onSaveSuccess?.(tfmId, meta)
    },
    [onSaveSuccess],
  )

  if (!isOpen || !row || !effectiveRow) return null

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
      <DrawerHeader
        row={effectiveRow}
        titleId={titleId}
        onClose={maybeRequestClose}
        onSwapTarget={onSwapTarget}
        onSwapSource={onSwapSource}
        onEditSources={onEditSources}
        onUnmapMapping={onUnmapMapping}
        onCreateMapping={onCreateMapping}
        onNavigateTarget={onNavigateTarget}
        availableTargetFields={availableTargetFields}
        availableSourceFields={availableSourceFields}
      />
      <DrawerBody
        row={effectiveRow}
        isFormActive={isFormActive}
        formRef={formRef}
        projectId={projectId}
        availableSourceFields={availableSourceFields}
        onFormStateChange={handleFormStateChange}
        onFormCancel={() => setIsFormActive(false)}
        onFormSaveSuccess={(tfmId, meta) => {
          setIsFormActive(false)
          onSaveSuccess?.(tfmId, meta)
        }}
        restoreFormState={restoreFormState}
        onRestoreConsumed={onRestoreConsumed}
        autoSuggest={autoSuggestRequested}
        onAutoSuggestConsumed={() => setAutoSuggestRequested(false)}
        tryConsumeAutoSuggest={tryConsumeAutoSuggest}
        onSuggestStateChange={(s) => setIsSuggestPending(s.isSuggestPending)}
        editFormActive={editFormActive}
        editInitialState={editInitialState}
        onEditFormCancel={handleEditFormCancel}
        onEditFormSaveSuccess={handleEditFormSaveSuccess}
        onEditClick={handleEditClick}
        onCreateMappingClick={() => setIsFormActive(true)}
        pathDOutputs={pathDOutputs ?? null}
        highlightedSourceFieldId={highlightedSourceFieldId ?? null}
      />
      <DrawerFooter
        row={effectiveRow}
        errorMessage={errorMessage ?? editPreviewError}
        isApprovePending={isApprovePending}
        isRejecting={isRejecting}
        optimisticallyApproved={optimisticApprove !== null}
        onApprove={handleApprove}
        onRejectClick={() => setConfirmRejectOpen(true)}
        isFormActive={isFormActive}
        formCanSave={formState.canSave}
        formIsSavePending={formState.isSavePending}
        isSuggestPending={isSuggestPending}
        onCreateMappingClick={() => setIsFormActive(true)}
        onSuggestWithAIClick={() => {
          if (effectiveRow.kind === 'unmapped') {
            autoSuggestConsumedRowsRef.current.delete(
              effectiveRow.targetField.id,
            )
          }
          setAutoSuggestRequested(true)
          setIsFormActive(true)
        }}
        onCancelSuggestClick={() => formRef.current?.cancelSuggest()}
        onFormCancelClick={() => maybeRequestClose()}
        onFormSaveClick={() => formRef.current?.triggerSave()}
        editFormActive={editFormActive}
        isEditPreviewPending={isEditPreviewPending}
        onEditFormCancelClick={() => maybeRequestClose()}
        onEditFormSaveClick={() => void handleEditSavePrecheck()}
        isUnapproving={isUnapproving}
        onUnapproveClick={() => setConfirmUnapproveOpen(true)}
      />
      <EditInvalidationDialog
        preview={editInvalidationPreview}
        targetFieldName={effectiveRow.targetField.name}
        isSaving={formState.isSavePending}
        onConfirm={handleEditInvalidationConfirm}
        onCancel={handleEditInvalidationCancel}
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

interface DrawerBodyProps {
  row: MappingRow
  /** Phase 4a-2 — whether the manual-create form is active for an unmapped row. */
  isFormActive: boolean
  /** Phase 4a-2 — imperative handle the parent uses to drive triggerSave / requestClose. */
  formRef: React.MutableRefObject<CreateMappingFormHandle | null>
  /** Phase 4a-2 — required when isFormActive becomes true on an unmapped row. */
  projectId: string | undefined
  /** Phase 4a-2 — page-level source fields for the form's picker. */
  availableSourceFields: SourceFieldWithState[] | undefined
  onFormStateChange: (state: {
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
    snapshot: CreateMappingFormSnapshot | null
  }) => void
  onFormCancel: () => void
  onFormSaveSuccess: (tfmId: string, meta?: EditSaveMeta) => void
  /** Phase 4a-4a — restore-from-undo snapshot threaded to the form. */
  restoreFormState?: CreateMappingFormSnapshot | null
  /** Phase 4a-4a — invoked by the form once a restore has been applied. */
  onRestoreConsumed?: () => void
  /** Phase 4a-4b — when true, the form fires `invokeSuggest` once on mount. */
  autoSuggest?: boolean
  /** Phase 4a-4b — invoked by the form once autoSuggest has been consumed. */
  onAutoSuggestConsumed?: () => void
  /** Phase 4a-4b — strict-mode-resistant consumption guard owned by the drawer. */
  tryConsumeAutoSuggest?: (targetFieldId: string) => boolean
  /** Phase 4a-4b — fired whenever the form's AI Suggest pending state changes. */
  onSuggestStateChange?: (state: { isSuggestPending: boolean }) => void
  /**
   * Phase 4b-1 — true while the user is editing an existing TFM's
   * sources / combination. Exclusive with `isFormActive` (the create
   * form is for unmapped rows; the edit form is for mapped rows).
   * When true on a mapped row, the body renders `CreateMappingForm`
   * in `mode='edit'` instead of `MappedBody`.
   */
  editFormActive: boolean
  /** Phase 4b-1 — hydration payload for the edit form. Required when `editFormActive`. */
  editInitialState: EditMappingInitialState | null
  /** Phase 4b-1 — invoked by the form on Cancel / Discard from edit mode. */
  onEditFormCancel: () => void
  /** Phase 4b-1 — invoked by the form on a successful editMappingSources save. */
  onEditFormSaveSuccess: (tfmId: string, meta?: EditSaveMeta) => void
  /**
   * Drawer redesign (Q11.A lock) — invoked by the inline pencil in the
   * Sources section header on mapped rows. Replaces the legacy footer
   * Edit button. Only mapped/`needs_review`+`approved` rows where
   * `combinationType !== 'custom_sql'` show the affordance; the body
   * defends in depth by gating render on the same conditions.
   */
  onEditClick: () => void
  /**
   * Phase E PR α — invoked by the inline pencil in the Sources section
   * header on `kind: 'unmapped'` rows. Mirrors the mapped-row pattern
   * (`onEditClick`); routes to the same imperative state setter the
   * footer's `[Create mapping]` button uses (`setIsFormActive(true)`).
   */
  onCreateMappingClick: () => void
  /**
   * Phase E PR α — Path D outputs sidecar for per-row enrichment.
   * Threaded by the parent from `getPathDOutputsForProject`.
   * `null` indicates "no enrichment data" — every dependent section
   * collapses (Linear pattern).
   */
  pathDOutputs: PathDOutputs | null
  /**
   * Mapping list view — flat-view split rows can open the drawer with
   * a specific source attribution highlighted. Threaded through to
   * `SourcesRoster` so the matching `SourceCard` gets a left-border
   * accent + scrollIntoView on mount. Null in target-led usage.
   */
  highlightedSourceFieldId: string | null
}

function DrawerBody(props: DrawerBodyProps) {
  return (
    <div
      data-testid="mapping-drawer-body"
      className="flex-1 overflow-auto px-6 py-5"
    >
      <BodyContent {...props} />
    </div>
  )
}

function BodyContent({
  row,
  isFormActive,
  formRef,
  projectId,
  availableSourceFields,
  onFormStateChange,
  onFormCancel,
  onFormSaveSuccess,
  restoreFormState,
  onRestoreConsumed,
  autoSuggest,
  onAutoSuggestConsumed,
  tryConsumeAutoSuggest,
  onSuggestStateChange,
  editFormActive,
  editInitialState,
  onEditFormCancel,
  onEditFormSaveSuccess,
  onEditClick,
  onCreateMappingClick,
  pathDOutputs,
  highlightedSourceFieldId,
}: DrawerBodyProps) {
  switch (row.kind) {
    case 'mapped':
      return (
        <MappedBody
          row={row}
          editFormActive={editFormActive}
          editInitialState={editInitialState}
          formRef={formRef}
          projectId={projectId}
          availableSourceFields={availableSourceFields}
          onFormStateChange={onFormStateChange}
          onEditFormCancel={onEditFormCancel}
          onEditFormSaveSuccess={onEditFormSaveSuccess}
          onEditClick={onEditClick}
          pathDOutputs={pathDOutputs}
          highlightedSourceFieldId={highlightedSourceFieldId}
        />
      )
    case 'value_assignment':
      return <ValueAssignmentBody row={row} pathDOutputs={pathDOutputs} />
    case 'unmapped':
      return (
        <UnmappedBody
          row={row}
          isFormActive={isFormActive}
          formRef={formRef}
          projectId={projectId}
          availableSourceFields={availableSourceFields}
          onFormStateChange={onFormStateChange}
          onFormCancel={onFormCancel}
          onFormSaveSuccess={onFormSaveSuccess}
          restoreFormState={restoreFormState}
          onRestoreConsumed={onRestoreConsumed}
          autoSuggest={autoSuggest}
          onAutoSuggestConsumed={onAutoSuggestConsumed}
          tryConsumeAutoSuggest={tryConsumeAutoSuggest}
          onSuggestStateChange={onSuggestStateChange}
          onCreateMappingClick={onCreateMappingClick}
          pathDOutputs={pathDOutputs}
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
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Sample values
          </div>
          <ul
            data-testid="drawer-source-field-sample-values-list"
            className="mt-1 flex flex-col"
          >
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
        </div>
      ) : null}
    </li>
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
          <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
            Sample values
          </div>
          {visibleSamples.length > 0 ? (
            <ul
              data-testid="drawer-target-field-sample-values-list"
              className="mt-1 flex flex-col"
            >
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
          ) : (
            <p
              data-testid="drawer-target-field-no-samples"
              className="mt-1 text-xs italic text-slate-400"
            >
              No sample data available — target schema only
            </p>
          )}
        </div>
      </div>
    </DrawerSection>
  )
}

const UNMAPPED_EMPTY_STATE_COPY = 'No source mapped yet'

interface UnmappedBodyProps {
  row: UnmappedRow
  isFormActive: boolean
  formRef: React.MutableRefObject<CreateMappingFormHandle | null>
  projectId: string | undefined
  availableSourceFields: SourceFieldWithState[] | undefined
  onFormStateChange: (state: {
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
    snapshot: CreateMappingFormSnapshot | null
  }) => void
  onFormCancel: () => void
  onFormSaveSuccess: (tfmId: string, meta?: EditSaveMeta) => void
  restoreFormState?: CreateMappingFormSnapshot | null
  onRestoreConsumed?: () => void
  autoSuggest?: boolean
  onAutoSuggestConsumed?: () => void
  tryConsumeAutoSuggest?: (targetFieldId: string) => boolean
  onSuggestStateChange?: (state: { isSuggestPending: boolean }) => void
  /** Phase E PR α — fired when the user clicks the inline source pencil. */
  onCreateMappingClick: () => void
  /** Phase E PR α — Path D outputs sidecar for COVERAGE + DECISIONS. */
  pathDOutputs: PathDOutputs | null
}

function UnmappedBody({
  row,
  isFormActive,
  formRef,
  projectId,
  availableSourceFields,
  onFormStateChange,
  onFormCancel,
  onFormSaveSuccess,
  restoreFormState,
  onRestoreConsumed,
  autoSuggest,
  onAutoSuggestConsumed,
  tryConsumeAutoSuggest,
  onSuggestStateChange,
  onCreateMappingClick,
  pathDOutputs,
}: UnmappedBodyProps) {
  // Phase E PR α — coverage rationale always renders (synthesized
  // "Manual entry required" orphan label when no coverage row exists).
  // Decisions render only when a coverage row exists AND it has
  // applicable decisions; otherwise the section collapses (Linear
  // pattern via DecisionList's empty-array short-circuit).
  const coverage = pathDOutputs?.coverageByTargetFieldId.get(row.targetField.id)
  const coverageDecisions = coverage
    ? pathDOutputs?.decisionsByCoverageId.get(coverage.id) ?? []
    : []

  // Phase E PR α — pencil affordance. Mirrors the mapped-row pattern at
  // the SOURCE section's `headerAside` slot. Hidden while the form is
  // active (the pencil's job is "open the form"; once it's open, the
  // affordance becomes redundant).
  const showPencil = !isFormActive

  // Drawer redesign PR 2 TASK 1.6 — inline banner shown at the top
  // of UnmappedBody when the coverage status is 'rejected'. The
  // banner explains the just-unmapped state and points the user at
  // the FROM block (which becomes a click target in TASK 3 — until
  // then, the user can re-map via the bottom Approve / Create
  // mapping flow). Slate palette reads as informational rather than
  // alarming; no new component file — one inline div.
  const showRejectedBanner = row.status === 'rejected' && !isFormActive

  // Drawer redesign PR 3b — body section order for unmapped /
  // rejected variants is now
  //
  //   [rejected banner]  →  TARGET FIELD  →  COVERAGE  →  DECISIONS
  //
  // The legacy `<DrawerSection title="Source">` (which mounted the
  // inline create-form OR the "No source mapped yet" empty state)
  // is gone — the header's FROM stack already communicates the "no
  // source" state via its italic "No source mapped" / "Value
  // assignment" labels, and the source ✏ on the header is the
  // source-creation entry point.
  //
  // `isFormActive` keeps gating COVERAGE + DECISIONS visibility
  // until commit 3 retires the form path entirely; while the form
  // is mounted, the body is the form's exclusive surface.
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

      {isFormActive && projectId ? (
        <DrawerSection title="Source" testId={SOURCE_SECTION_TESTID}>
          <CreateMappingForm
            ref={formRef}
            projectId={projectId}
            targetField={{
              id: row.targetField.id,
              name: row.targetField.name,
            }}
            availableSourceFields={availableSourceFields ?? []}
            onSaveSuccess={onFormSaveSuccess}
            onCancel={onFormCancel}
            onStateChange={onFormStateChange}
            restoreFormState={restoreFormState}
            onRestoreConsumed={onRestoreConsumed}
            autoSuggest={autoSuggest}
            onAutoSuggestConsumed={onAutoSuggestConsumed}
            tryConsumeAutoSuggest={tryConsumeAutoSuggest}
            onSuggestStateChange={onSuggestStateChange}
          />
        </DrawerSection>
      ) : null}

      {!isFormActive ? (
        <>
          <TargetFieldSection targetField={row.targetField} />
          <DrawerSection title="Coverage" testId="drawer-section-coverage">
            <CoverageSection coverage={coverage ?? null} />
          </DrawerSection>

          {coverageDecisions.length > 0 ? (
            <DrawerSection
              title={`Decisions (${coverageDecisions.length})`}
              testId="drawer-section-decisions"
            >
              <DecisionList decisions={coverageDecisions} />
            </DrawerSection>
          ) : null}
        </>
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
}: {
  row: ValueAssignmentRow
  pathDOutputs: PathDOutputs | null
}) {
  // Phase E PR α — decisions for this VA's TFM (no DQ section: VAs have
  // no source field to scope DQ findings to).
  const decisions = pathDOutputs?.decisionsByTfmId.get(row.id) ?? []

  // Drawer redesign PR 1 — VA body order is VALUE EXPRESSION →
  // ANALYSIS → DECISIONS. The empty-state SOURCE section ("Value
  // assignment — no sources") is gone: the header's left-side
  // "Value assignment" italic label now carries that signal and a
  // section that exists solely to render "no sources" was pure
  // chrome. VALUE EXPRESSION is the row's actual definition for a
  // VA and gets the lead position.
  return (
    <>
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

      {/*
        Drawer redesign PR 3b — TARGET FIELD insertion between
        VALUE EXPRESSION and ANALYSIS. Order:
          VALUE EXPRESSION → TARGET FIELD → ANALYSIS → DECISIONS
      */}
      <TargetFieldSection targetField={row.targetField} />

      <AnalysisSection row={row} />

      {decisions.length > 0 ? (
        <DrawerSection
          title={`Decisions (${decisions.length})`}
          testId="drawer-section-decisions"
        >
          <DecisionList decisions={decisions} />
        </DrawerSection>
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
  /** Drawer redesign — true while the inline pencil edit form is mounted. */
  editFormActive: boolean
  editInitialState: EditMappingInitialState | null
  formRef: React.MutableRefObject<CreateMappingFormHandle | null>
  projectId: string | undefined
  availableSourceFields: SourceFieldWithState[] | undefined
  onFormStateChange: (state: {
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
    snapshot: CreateMappingFormSnapshot | null
  }) => void
  onEditFormCancel: () => void
  onEditFormSaveSuccess: (tfmId: string, meta?: EditSaveMeta) => void
  /** Pencil click handler — mounts the edit form in the Sources section. */
  onEditClick: () => void
  /** Phase E PR α — Path D outputs sidecar for DATA QUALITY + DECISIONS. */
  pathDOutputs: PathDOutputs | null
  /** Mapping list view — see DrawerBodyProps.highlightedSourceFieldId. */
  highlightedSourceFieldId: string | null
}

function MappedBody({
  row,
  editFormActive,
  editInitialState,
  formRef,
  projectId,
  availableSourceFields,
  onFormStateChange,
  onEditFormCancel,
  onEditFormSaveSuccess,
  onEditClick,
  pathDOutputs,
  highlightedSourceFieldId,
}: MappedBodyProps) {
  // Q11.A lock — pencil affordance is visible for needs_review + approved
  // mapped rows, except `custom_sql` (which is a Transform-page concern,
  // not a sources/combination edit). For other states (rejected) the
  // founder removed the affordance from the source-edit flow.
  //
  // Drawer redesign PR 1 (feat/drawer-header-rewrite) — additionally
  // suppress the inline body pencil on SINGLE-source mapped rows. Those
  // rows now have a header-level source-field pencil (DrawerHeader.tsx)
  // that opens the InlineSourcePicker auto-commit flow; the legacy body
  // pencil → CreateMappingForm inline form is redundant for the
  // single-source case. Multi-source rows keep the legacy pencil for
  // now — PR 2 introduces per-card affordances + retires the body
  // pencil entirely (open Q1 resolved: retire in PR 2).
  const showEditPencil =
    (row.status === 'needs_review' || row.status === 'approved') &&
    row.combinationType !== 'custom_sql' &&
    row.sources.length > 1

  // Edit-mode mounts the form INSIDE the Sources section (replacing the
  // source-card list), which keeps the visual context — "you are editing
  // these sources" — instead of stranding the form in a sibling section.
  const canMountEditForm =
    editFormActive &&
    editInitialState !== null &&
    projectId !== undefined &&
    availableSourceFields !== undefined

  // Drawer redesign refinements §3 (founder canary review): the body
  // section order is now
  //
  //   SOURCES   →   SAMPLE VALUES   →   ANALYSIS   →   TRANSFORMATION
  //
  // The leading OVERVIEW section that shipped in the prior pass is
  // removed entirely (Refinement 2):
  //
  //   • Status + confidence move to the header SOURCE row top-right
  //     (Refinement 1 — `HeaderStatusBadge`).
  //   • Type compatibility + AI reasoning move into the new ANALYSIS
  //     section (Refinement 4 — `AnalysisSection`).
  //
  // Section ordering rationale (drawer redesign refinements §3):
  //
  //   1. SOURCES      — the mapping definition. Edit affordance lives
  //                     here (the inline edit button still mounts in
  //                     the section header's `headerAside` slot).
  //   2. SAMPLE VALUES — the data evidence. For verify-task users this
  //                     is the primary content they want to scan after
  //                     seeing identity. Single-source rows default
  //                     the lone field block to expanded; multi-source
  //                     rows default all blocks collapsed (Refinement 5).
  //   3. ANALYSIS     — the deep-dive. Type compatibility (compact
  //                     form, always visible) + AI reasoning
  //                     (collapsible, default-expanded for
  //                     needs_review). Most users skip past it;
  //                     understand-task users find it where they
  //                     expect drill-in content.
  //   4. TRANSFORMATION — the action affordance for editing transforms.
  //                     Stays at the bottom.
  //
  // Edit-mode mount behavior unchanged: the `+N sources` chip in the
  // header still scrolls to SOURCES via `scrollToSourcesSection`
  // (queries by testid, not document position, so the reorder doesn't
  // affect scroll wiring). When the edit form mounts in place of the
  // source roster, SAMPLE VALUES is intentionally hidden — sample
  // values describe the existing data, not the in-flight authoring
  // state. ANALYSIS is also hidden during edit mode for the same
  // reason: type compat + AI reasoning are post-hoc evidence about
  // the row's current shape, not the form's draft state.
  // Drawer redesign PR 3b — body section order is now
  //
  //   SOURCE FIELDS → TARGET FIELD → TRANSFORMATION → ANALYSIS →
  //   DATA QUALITY → DECISIONS
  //
  // The legacy `<DrawerSection title="Source">` (which mounted the
  // inline `CreateMappingForm` in edit mode) is replaced by
  // `SourceFieldsSection` — per-source identity + samples in one
  // block. SAMPLE VALUES merges into SOURCE FIELDS. ANALYSIS no
  // longer renders the type-compat line (per-section type display
  // in the new sections covers it). The new `TargetFieldSection`
  // surfaces PR 3a's additive `TargetFieldRef` fields.
  //
  // `canMountEditForm` gating remains in place to keep the legacy
  // edit-form mount path functional for any consumer that still
  // routes through it (commit 3 retires the form file entirely).
  // When mounted, sources / target / analysis hide so the form has
  // the body to itself.
  return (
    <>
      {canMountEditForm ? (
        <DrawerSection title="Source" testId={SOURCE_SECTION_TESTID}>
          <CreateMappingForm
            ref={formRef}
            mode="edit"
            editInitialState={editInitialState!}
            projectId={projectId!}
            targetField={{
              id: row.targetField.id,
              name: row.targetField.name,
            }}
            availableSourceFields={availableSourceFields!}
            onSaveSuccess={onEditFormSaveSuccess}
            onCancel={onEditFormCancel}
            onStateChange={onFormStateChange}
          />
        </DrawerSection>
      ) : (
        <>
          <SourceFieldsSection sources={row.sources} />
          <TargetFieldSection targetField={row.targetField} />
        </>
      )}

      <TransformationSection row={row} projectId={projectId} />

      {!canMountEditForm ? (
        <>
          <AnalysisSection row={row} />
          <MappedEnrichmentSections row={row} pathDOutputs={pathDOutputs} />
        </>
      ) : null}
    </>
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
        <DrawerSection
          title={`Data quality (${dqIssues.length})`}
          testId="drawer-section-data-quality"
        >
          <DQList issues={dqIssues} />
        </DrawerSection>
      ) : null}

      {decisions.length > 0 ? (
        <DrawerSection
          title={`Decisions (${decisions.length})`}
          testId="drawer-section-decisions"
        >
          <DecisionList decisions={decisions} />
        </DrawerSection>
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
function EditPencilButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Edit mapping sources"
      data-testid="mapping-drawer-edit-pencil"
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5',
        'text-xs font-medium text-blue-700 transition-colors',
        'hover:bg-blue-50 hover:text-blue-800 hover:underline',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
      )}
    >
      <Pencil aria-hidden="true" className="h-3 w-3" />
      <span>Edit</span>
    </button>
  )
}

/**
 * Per-source roster body for the Sources section. Renders one `SourceCard`
 * per source in ordinal order.
 *
 * `highlightedSourceFieldId` is the flat-view's hook for routing a click
 * on a split child row to the matching source. When set, the matching
 * card gets a left-border accent and scrolls into view on mount. The
 * target-led view passes null (or omits the prop) and every source
 * renders identically.
 */
function SourcesRoster({
  row,
  highlightedSourceFieldId,
}: {
  row: MappedRow
  highlightedSourceFieldId: string | null
}) {
  return (
    <ul className="space-y-3" data-testid="drawer-sources-list">
      {row.sources.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          isHighlighted={
            highlightedSourceFieldId !== null &&
            source.sourceField.id === highlightedSourceFieldId
          }
        />
      ))}
    </ul>
  )
}

/**
 * Per-source card — drawer-redesign refinement (TARGET-led identity).
 *
 *   [srcTable] field_name                              confidence%
 *   (join: fk_field)                                   (when present)
 *
 * Drawer redesign — TARGET-led identity (this iteration): per-source
 * confidence is restored on ALL rows, including Rule 1 single-source.
 * The header now leads with the target field and carries no
 * confidence number, so the per-source percent here is the drawer's
 * only confidence surface. Color-banded via `classifyRowConfidence`
 * (≥85 high/green-medium, 40-84 amber, <40 low/red) — the same
 * thresholds the list view's `ConfidenceCell` uses, which keeps the
 * two surfaces semantically aligned.
 *
 * Drawer redesign refinements §2/§3: SOURCE is identity-only.
 * Type compatibility lives in ANALYSIS; per-source sample values
 * move to the standalone SAMPLE VALUES section. Per-source AI
 * reasoning is aggregated and rendered in ANALYSIS — `<SourceCard>`
 * does not render `source.aiReasoning` or `source.sampleValues`
 * directly.
 */
const SOURCE_CONFIDENCE_BAND_CLASSNAME: Record<RowConfidenceBand, string> = {
  high: 'text-green-600 font-medium',
  amber: 'text-amber-600',
  low: 'text-red-600',
}

function SourceCard({
  source,
  isHighlighted = false,
}: {
  source: MappingSourceRef
  isHighlighted?: boolean
}) {
  const confidenceBand: RowConfidenceBand | null =
    source.confidence === null
      ? null
      : classifyRowConfidence(source.confidence)
  // Flat-view split-row entry point. When `isHighlighted` is true, the
  // card scrolls into view on mount and renders with a 2px left-border
  // accent so the user lands on the source they clicked through from.
  // The ref is keyed only on the highlighted card — non-highlighted
  // cards skip the ref entirely.
  const cardRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (!isHighlighted) return
    const el = cardRef.current
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [isHighlighted])
  return (
    <li
      ref={isHighlighted ? cardRef : null}
      className={cn(
        'space-y-2',
        isHighlighted &&
          'border-l-2 border-blue-500 bg-blue-50/40 pl-3 -ml-3 rounded-sm',
      )}
      data-testid="drawer-source-card"
      data-highlighted={isHighlighted ? 'true' : 'false'}
    >
      <div className="flex min-w-0 items-center gap-2">
        <TableBadge tableName={source.sourceTable.name} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm text-slate-900"
          data-testid="drawer-source-field-name"
          title={source.sourceField.name}
        >
          {source.sourceField.name}
        </span>
        <span
          className={cn(
            'flex-shrink-0 text-sm font-medium tabular-nums',
            confidenceBand !== null
              ? SOURCE_CONFIDENCE_BAND_CLASSNAME[confidenceBand]
              : 'text-slate-500',
          )}
          data-testid="drawer-source-confidence"
          data-confidence-band={confidenceBand ?? 'none'}
        >
          {formatConfidencePercent(source.confidence)}
        </span>
      </div>

      {source.joinAnnotation ? (
        <div
          className="text-[11px] italic text-slate-500"
          data-testid="drawer-source-join"
        >
          {/* `source.joinAnnotation` is pre-formatted by `deriveJoinAnnotation`
              and already includes the `(join: …)` wrapper. Render verbatim. */}
          {source.joinAnnotation}
        </div>
      ) : null}
    </li>
  )
}

// ── Sample values section (drawer redesign refinements §3 + §5) ────────────
//
// SAMPLE VALUES is the second body section (the "data evidence" tier
// — drawer redesign refinements §3 ordering: SOURCES → SAMPLE VALUES →
// ANALYSIS → TRANSFORMATION). It promotes the prior pass's per-source
// nested block (`SampleValuesBlock`, always-visible bordered strip
// rendered inside `<SourceCard>`) to a top-level section with one
// collapsible field block per source.
//
// Default-open behavior — drawer redesign refinements §5 (founder
// canary review):
//
//   • Single-source rows (Rule 1): the lone field block defaults to
//     expanded. There is one source and no choice to make; showing
//     values immediately serves the verify-task case (user lands on
//     drawer, sees evidence without a click).
//   • Multi-source rows (Rule 2/3/4): all field blocks default to
//     collapsed. The user typically inspects one source at a time;
//     default-collapsed keeps the section compact while preserving
//     independent per-block toggle state.
//
// `totalSourceCount` is the number of *sources with non-empty
// sampleValues* (the same set that's actually rendered as field
// blocks). Sources with empty sample arrays are filtered out before
// the count is computed, so a Rule 2 row where only one of two
// sources has sample data still gets the "single-source expanded"
// default — there's only one block actually rendered.
//
// The section omits itself entirely when no source has sample data
// (consistent with the prior `SampleValuesBlock`'s silent-omission
// behavior — the section header isn't worth rendering an empty body
// just to label "no samples available").
function SampleValuesSection({
  sources,
}: {
  sources: readonly MappingSourceRef[]
}) {
  const sourcesWithSamples = sources.filter((s) => s.sampleValues.length > 0)
  if (sourcesWithSamples.length === 0) return null
  const totalSourceCount = sourcesWithSamples.length
  return (
    <DrawerSection
      title="Sample values"
      testId="drawer-section-sample-values"
    >
      <ul
        className="space-y-2"
        data-testid="drawer-sample-values-list"
      >
        {sourcesWithSamples.map((source) => (
          <SampleValuesFieldBlock
            key={source.id}
            source={source}
            totalSourceCount={totalSourceCount}
          />
        ))}
      </ul>
    </DrawerSection>
  )
}

interface SampleValuesFieldBlockProps {
  source: MappingSourceRef
  /**
   * Number of sources with non-empty sample data in the parent
   * section. Drives the initial `useState` value: `=== 1` opens by
   * default; `> 1` starts collapsed.
   */
  totalSourceCount: number
}

/**
 * Collapsible per-source field block inside SAMPLE VALUES.
 *
 *   ▸ [SRC_TABLE] src_field            (collapsed)
 *   ▾ [SRC_TABLE] src_field            (expanded)
 *     DDA
 *     NOW
 *     SAV
 *
 * Each block manages its own open/closed state — toggling one block
 * does not affect any other block in the section. The chevron
 * (right when collapsed, down when expanded) and the
 * `aria-expanded` / `aria-controls` wiring mirror the disclosure
 * pattern used elsewhere in the drawer (`NestedAiReasoningDisclosure`).
 */
function SampleValuesFieldBlock({
  source,
  totalSourceCount,
}: SampleValuesFieldBlockProps) {
  const isSingleSource = totalSourceCount === 1
  const [isOpen, setIsOpen] = useState(isSingleSource)
  const panelId = useId()
  return (
    <li data-testid="drawer-sample-values-field-block">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        data-testid="drawer-sample-values-toggle"
        data-source-id={source.id}
        className={cn(
          'inline-flex w-full items-center gap-2 rounded px-1 py-1',
          'text-left transition-colors hover:bg-slate-50',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        {isOpen ? (
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 flex-shrink-0 text-slate-500"
          />
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 flex-shrink-0 text-slate-500"
          />
        )}
        <TableBadge tableName={source.sourceTable.name} size="sm" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm text-slate-900"
          title={source.sourceField.name}
        >
          {source.sourceField.name}
        </span>
      </button>
      {isOpen ? (
        <div
          id={panelId}
          className="ml-6 mt-1 flex flex-col"
          data-testid="drawer-sample-values-panel"
          data-source-id={source.id}
        >
          {source.sampleValues.map((value, idx) => (
            <div
              key={`${idx}-${value}`}
              className={cn(
                'border-b border-slate-100 py-1 last:border-b-0',
                'break-words font-mono text-xs text-slate-700',
              )}
              data-testid="drawer-sample-values-row"
            >
              {value}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}

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
}: {
  row: MappedRow | ValueAssignmentRow
}) {
  const isMapped = row.kind === 'mapped'

  const perSourceReasonings = isMapped
    ? collectPerSourceReasonings(row.sources)
    : []
  const rowAiReasoning = row.aiReasoning
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
    <DrawerSection title="Analysis" testId="drawer-section-analysis">
      <NestedAiReasoningDisclosure
        rowAiReasoning={rowAiReasoning}
        perSourceReasonings={perSourceReasonings}
        rowStatus={row.status}
      />
    </DrawerSection>
  )
}

// ── Type compatibility (compact verdict line) ──────────────────────────────
//
// Compact glance line consumed by `AnalysisSection` (drawer redesign
// refinements §4 — type compatibility lives in ANALYSIS, not OVERVIEW):
//
//   VARCHAR(4) → VARCHAR(10)  ✓ compatible
//   VARCHAR(50) → VARCHAR(20) ⚠ conversion needed
//
// Verdict heuristic. The wire contract carries `typeCompatibility` as
// a free-form `string | null` (legacy storage of Claude's prose). We
// classify by keyword scan into one of three buckets:
//
//   compatible (✓ green)  — text matches the same "direct compatible"
//                           keywords used elsewhere in the codebase
//                           (`fieldNeedsTransform` in
//                           `lib/utils/transform-helpers.ts` Step 4
//                           uses /direct compatible|no conversion
//                           needed|compatible.?no/). Re-using that
//                           regex keeps the verdict logic consistent
//                           with the existing transform-scope
//                           classifier.
//
//   warning (⚠ amber)     — default for any non-null
//                           `typeCompatibility` that isn't an explicit
//                           "direct compatible". Covers truncation
//                           risk, lossy conversion, format conversion,
//                           etc. The amber color is deliberately
//                           cautious — most real-world non-direct
//                           cases need user attention, and a single
//                           amber bucket is easier to scan than three
//                           color levels.
//
//   unknown (slate)       — `typeCompatibility === null`. Renders the
//                           type pair without a verdict glyph; the
//                           caller (`AnalysisSection`) only mounts
//                           this component when there's a dominant
//                           source, so null here is genuinely
//                           "AI never assessed" rather than "no
//                           source".
//
// Three-state rather than the prompt's optional fourth ✗ "incompatible"
// state: the dataset has no examples of an `incompatible` verdict
// surfaced through `typeCompatibility` (the legacy classifier only
// emitted compatible/needs-conversion). Adding ✗ as a fourth bucket
// would require a contract change. If a future canary surfaces a real
// incompatible case, the bucket map below extends with one entry.

type TypeCompatVerdict = 'compatible' | 'warning' | 'unknown'

function classifyTypeCompatibility(
  rawText: string | null,
): TypeCompatVerdict {
  if (rawText === null) return 'unknown'
  const compat = rawText.toLowerCase()
  // Mirror the regex used in `fieldNeedsTransform` Step 4 so the
  // drawer's verdict and the readiness-score classifier stay in
  // lockstep. If the keyword catalogue evolves, both surfaces
  // update together.
  if (/direct compatible|no conversion needed|compatible.?no/.test(compat)) {
    return 'compatible'
  }
  return 'warning'
}

function TypeCompatibility({
  sourceType,
  targetType,
  rawText,
}: {
  sourceType: string
  targetType: string
  rawText: string | null
}) {
  const verdict = classifyTypeCompatibility(rawText)
  return (
    <div
      className="flex items-center gap-2 text-sm text-slate-600"
      data-testid="drawer-analysis-type-compat"
      data-verdict={verdict}
    >
      <span className="font-mono text-xs text-slate-500">
        <span data-testid="drawer-analysis-type-compat-source">
          {sourceType}
        </span>{' '}
        <span aria-hidden="true" className="text-slate-400">
          →
        </span>{' '}
        <span data-testid="drawer-analysis-type-compat-target">
          {targetType}
        </span>
      </span>
      <TypeCompatibilityVerdict verdict={verdict} />
    </div>
  )
}

function TypeCompatibilityVerdict({
  verdict,
}: {
  verdict: TypeCompatVerdict
}) {
  if (verdict === 'compatible') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-green-700"
        data-testid="drawer-analysis-type-compat-verdict-compatible"
      >
        <Check aria-hidden="true" className="h-4 w-4" />
        compatible
      </span>
    )
  }
  if (verdict === 'warning') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs font-medium text-amber-700"
        data-testid="drawer-analysis-type-compat-verdict-warning"
      >
        <AlertTriangle aria-hidden="true" className="h-4 w-4" />
        conversion needed
      </span>
    )
  }
  // verdict === 'unknown' — render nothing visible; the type pair
  // itself is sufficient. Returning null keeps the layout flush
  // when the AI hasn't assessed compatibility.
  return null
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

function TransformationSection({
  row,
  projectId,
}: {
  row: MappedRow
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

  if (row.hasTransformation) {
    return (
      <DrawerSection
        title="Transformation"
        testId="drawer-section-transformation"
      >
        <div className="space-y-2">
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

  // No transformation. Show the "Define Transform →" affordance only for
  // non-custom_sql mapped rows — `custom_sql` flows author SQL through a
  // different surface entirely (the Transform page's custom-SQL editor),
  // and there's no inline transform-author flow to link to.
  if (row.combinationType === 'custom_sql') return null

  return (
    <DrawerSection
      title="Transformation"
      testId="drawer-section-transformation"
    >
      <div data-testid="drawer-transformation-empty">
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
  /** Phase 4a-2 — manual mapping creation footer mode-switch flags. */
  isFormActive: boolean
  formCanSave: boolean
  formIsSavePending: boolean
  /** Phase 4a-4b — true while the form's AI Suggest call is in flight. */
  isSuggestPending: boolean
  onCreateMappingClick: () => void
  /** Phase 4a-4b — Rule 6 footer's [Suggest with AI] click handler. */
  onSuggestWithAIClick: () => void
  /** Phase 4a-4b — single [Cancel suggestion] button click handler. */
  onCancelSuggestClick: () => void
  onFormCancelClick: () => void
  onFormSaveClick: () => void
  /**
   * Phase 4b-1 — true while the user is editing an existing mapped
   * row's sources / combination. When true, the footer shows
   * `[Cancel] [Save changes]` instead of `[Reject] [Approve] [Edit]`.
   */
  editFormActive: boolean
  /**
   * Phase 4b-1 — true while the drawer is running
   * `previewEditInvalidation` between the user's Save click and the
   * actual `editMappingSources` call. The Save button shows a spinner
   * during this window so the user gets feedback for the (usually
   * sub-100ms) preview round-trip.
   */
  isEditPreviewPending: boolean
  /** Phase 4b-1 — edit-mode [Cancel] click handler. */
  onEditFormCancelClick: () => void
  /** Phase 4b-1 — edit-mode [Save changes] click handler (runs preview-then-save). */
  onEditFormSaveClick: () => void
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

function DrawerFooter({
  row,
  errorMessage,
  isApprovePending,
  isRejecting,
  optimisticallyApproved,
  onApprove,
  onRejectClick,
  isFormActive,
  formCanSave,
  formIsSavePending,
  isSuggestPending,
  onCreateMappingClick,
  onSuggestWithAIClick,
  onCancelSuggestClick,
  onFormCancelClick,
  onFormSaveClick,
  editFormActive,
  isEditPreviewPending,
  onEditFormCancelClick,
  onEditFormSaveClick,
  isUnapproving,
  onUnapproveClick,
}: DrawerFooterProps) {
  // Phase 4b-1 — when the user is editing a mapped row, the footer
  // collapses to `[Cancel] [Save changes]` regardless of the row's
  // status. Mirrors the unmapped-form footer; `formIsSavePending`
  // also drives this Save button's spinner because both flows go
  // through the same imperative `formRef.current.triggerSave()`.
  if (editFormActive && row.kind === 'mapped') {
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
        <EditFooterButtons
          formCanSave={formCanSave}
          formIsSavePending={formIsSavePending}
          isEditPreviewPending={isEditPreviewPending}
          onEditFormCancelClick={onEditFormCancelClick}
          onEditFormSaveClick={onEditFormSaveClick}
        />
      </footer>
    )
  }
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
          isFormActive={isFormActive}
          formCanSave={formCanSave}
          formIsSavePending={formIsSavePending}
          isSuggestPending={isSuggestPending}
          isApprovePending={isApprovePending}
          isUnapproving={isUnapproving}
          onCreateMappingClick={onCreateMappingClick}
          onSuggestWithAIClick={onSuggestWithAIClick}
          onCancelSuggestClick={onCancelSuggestClick}
          onFormCancelClick={onFormCancelClick}
          onFormSaveClick={onFormSaveClick}
          onApproveClick={onApprove}
          onUnapproveClick={onUnapproveClick}
        />
      ) : (
        // Drawer redesign — Q11.A lock: Edit moved out of the footer
        // entirely. The inline Sources-section pencil (rendered by the
        // body) is now the only edit affordance.
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

// ── Unmapped footer (Phase 4a-2 + 4a-4b + INF-57 cleanup) ───────────────────
//
// Mode-switches by `isFormActive` first, then by row.status for the
// inactive branch (INF-57 cleanup added the status-driven dispatch):
//
//   isFormActive = false:
//     status='needs_review'/'unmapped' → [Suggest with AI] [Create mapping]
//                                        — the form-entry path
//     status='approved'                → [Un-approve]
//                                        — calls resetMappingStatus; the
//                                        coverage row flips to needs_review
//                                        and the drawer closes (parent's
//                                        handleDrawerActionComplete `'reset'`
//                                        arm mirrors the reject behaviour)
//     status='rejected'                → [Approve]
//                                        — re-approves the coverage row
//                                        via the standard approve flow
//
//   isFormActive = true:
//     • Suggest pending → [Cancel suggestion] (aborts in-flight AI call)
//     • Otherwise       → [Cancel] [Save mapping] (form-save flow)

interface UnmappedFooterButtonsProps {
  status: 'needs_review' | 'approved' | 'rejected' | 'unmapped'
  isFormActive: boolean
  formCanSave: boolean
  formIsSavePending: boolean
  isSuggestPending: boolean
  isApprovePending: boolean
  isUnapproving: boolean
  onCreateMappingClick: () => void
  onSuggestWithAIClick: () => void
  onCancelSuggestClick: () => void
  onFormCancelClick: () => void
  onFormSaveClick: () => void
  onApproveClick: () => void
  onUnapproveClick: () => void
}

function UnmappedFooterButtons({
  status,
  isFormActive,
  formCanSave,
  formIsSavePending,
  isSuggestPending,
  isApprovePending,
  isUnapproving,
  onCreateMappingClick,
  onSuggestWithAIClick,
  onCancelSuggestClick,
  onFormCancelClick,
  onFormSaveClick,
  onApproveClick,
  onUnapproveClick,
}: UnmappedFooterButtonsProps) {
  if (!isFormActive) {
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
              'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-shadow',
              'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
              'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
              'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
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
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="mapping-drawer-approve-button"
            aria-label="Approve mapping"
            onClick={onApproveClick}
            disabled={isApprovePending}
            className={cn(
              'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
              'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
              'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
              'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
            )}
          >
            Approve
          </button>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="mapping-drawer-suggest-with-ai-button"
          aria-label="Suggest mapping with AI"
          onClick={onSuggestWithAIClick}
          className={cn(
            'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
            'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/30',
          )}
        >
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
          <span>Suggest with AI</span>
        </button>
        <button
          type="button"
          data-testid="mapping-drawer-create-mapping-button"
          aria-label="Create mapping"
          onClick={onCreateMappingClick}
          className={cn(
            'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
            'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
          )}
        >
          Create mapping
        </button>
      </div>
    )
  }
  if (isSuggestPending) {
    return (
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="mapping-drawer-cancel-suggest-button"
          aria-label="Cancel AI suggestion"
          onClick={onCancelSuggestClick}
          className={cn(
            'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
            'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
            'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
          )}
        >
          Cancel suggestion
        </button>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        data-testid="mapping-drawer-form-cancel-button"
        aria-label="Cancel mapping creation"
        onClick={onFormCancelClick}
        disabled={formIsSavePending}
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
          'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
        )}
      >
        Cancel
      </button>
      <button
        type="button"
        data-testid="mapping-drawer-form-save-button"
        aria-label="Save mapping"
        onClick={onFormSaveClick}
        disabled={!formCanSave}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
          'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
        )}
      >
        {formIsSavePending ? (
          <>
            <Loader2
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin"
              data-testid="mapping-drawer-form-save-spinner"
            />
            <span>Saving…</span>
          </>
        ) : (
          'Save mapping'
        )}
      </button>
    </div>
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
//   The Edit button is gone from the footer entirely; the inline
//   Sources-section pencil is now the only edit affordance. Approve
//   was previously rendered-but-disabled on `approved`; collapsing it
//   to a single Reject button gives a meaningfully cleaner footer in
//   the 480px drawer.
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

// ── Edit-mode footer (Phase 4b-1) ──────────────────────────────────────────
//
// Mirrors `UnmappedFooterButtons`'s active-and-not-pending shape: a
// `[Cancel] [Save changes]` pair. The Save button shows a spinner during
// EITHER the preview-invalidation round-trip (`isEditPreviewPending`) OR
// the actual `editMappingSources` save (`formIsSavePending`) — both are
// part of the user-perceivable save path. Cancel is disabled while either
// is in flight to prevent double-fire / partial-state bugs.

interface EditFooterButtonsProps {
  formCanSave: boolean
  formIsSavePending: boolean
  isEditPreviewPending: boolean
  onEditFormCancelClick: () => void
  onEditFormSaveClick: () => void
}

function EditFooterButtons({
  formCanSave,
  formIsSavePending,
  isEditPreviewPending,
  onEditFormCancelClick,
  onEditFormSaveClick,
}: EditFooterButtonsProps) {
  const inflight = formIsSavePending || isEditPreviewPending
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        data-testid="mapping-drawer-edit-cancel-button"
        aria-label="Cancel editing mapping"
        onClick={onEditFormCancelClick}
        disabled={inflight}
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
          'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
        )}
      >
        Cancel
      </button>
      <button
        type="button"
        data-testid="mapping-drawer-edit-save-button"
        aria-label="Save mapping changes"
        onClick={onEditFormSaveClick}
        disabled={!formCanSave || inflight}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
          'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
        )}
      >
        {inflight ? (
          <>
            <Loader2
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin"
              data-testid="mapping-drawer-edit-save-spinner"
            />
            <span>Saving…</span>
          </>
        ) : (
          'Save changes'
        )}
      </button>
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
