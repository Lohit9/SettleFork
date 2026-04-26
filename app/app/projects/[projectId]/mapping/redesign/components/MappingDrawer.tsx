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
import { AlertCircle, Sparkles, X } from '@/components/icons'
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
  TargetAcknowledgedRow,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import {
  approveFieldMapping,
  previewEditInvalidation,
  rejectFieldMapping,
  unacknowledgeField,
} from '@/lib/actions/mappings-for-redesign'
import { classifyMappedRow, type MappingRowRule } from '@/lib/utils/mapping-row-rules'
import { formatSampleValues } from '@/lib/utils/mapping-drawer-format'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { TableBadge } from './TableBadge'
import {
  CreateMappingForm,
  type CreateMappingFormHandle,
  type CreateMappingFormSnapshot,
  type EditMappingInitialState,
  type EditSaveMeta,
} from './CreateMappingForm'
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
//   target_acknowledged → AcknowledgedBody     (Target field / Acknowledgment /
//                                               Status)
//   unmapped            → UnmappedBody         (Target field / Mapping status)
//   value_assignment    → ValueAssignmentBody  (Target field / Value expression /
//                                               AI reasoning / Confidence / Status)
//   mapped              → MappedBody           (Target field / Sources /
//                                               [Combination] / AI reasoning /
//                                               Confidence / Status)
//
// Footer dispatch (Gap 9):
//
//   mapped / value_assignment   → ApproveRejectFooter (both buttons, disabled
//                                                      states per status)
//   target_acknowledged         → AcknowledgedFooter  (both buttons disabled,
//                                                      explanatory tooltips)
//   unmapped                    → no footer (no actions yet — Gap 11+ may add
//                                            "Suggest mapping" CTA)
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
    action: 'approve' | 'reject' | 'unacknowledge',
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
  // Phase 4b-2 — un-acknowledge in-flight + confirm dialog state. Mirrors
  // the reject-confirmation shape (single-shot destructive action gated
  // behind an AlertDialog, drawer closes on success).
  const [isUnacknowledging, setIsUnacknowledging] = useState(false)
  const [confirmUnacknowledgeOpen, setConfirmUnacknowledgeOpen] = useState(false)

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
    setConfirmUnacknowledgeOpen(false)
    setIsUnacknowledging(false)
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

  // ── Phase 4b-2 — un-acknowledge handler ──────────────────────────
  //
  // Mirrors `handleRejectConfirm`'s shape: a destructive single-shot
  // action gated behind an AlertDialog. On success the parent closes
  // the drawer + clears the URL (the TFM row id dissolves; the field
  // returns to Rule 6 unmapped). On failure we surface uniform copy
  // and log the underlying errorCode for ops triage.
  const handleUnacknowledgeConfirm = useCallback(async () => {
    if (!row || row.kind !== 'target_acknowledged') return
    // Defensive bail when the drawer was mounted without a projectId
    // (the real flow always threads it from MappingContent — this is
    // belt-and-suspenders for storybook / standalone test contexts).
    if (!projectId) return
    const targetRowId = row.id
    const targetFieldId = row.targetField.id
    setErrorMessage(null)
    setIsUnacknowledging(true)
    try {
      const result = await unacknowledgeField({
        projectId,
        targetFieldId,
      })
      if (!result.success) {
        setIsUnacknowledging(false)
        setConfirmUnacknowledgeOpen(false)
        setErrorMessage(GENERIC_UNACKNOWLEDGE_ERROR)
        if (typeof console !== 'undefined') {
          console.error('[MappingDrawer] unacknowledgeField failed:', result)
        }
        return
      }
      // Success — drawer about to unmount. Do NOT clear isUnacknowledging
      // for the same reason as the reject path.
      setConfirmUnacknowledgeOpen(false)
      onActionComplete?.('unacknowledge', targetRowId)
    } catch (err) {
      setIsUnacknowledging(false)
      setConfirmUnacknowledgeOpen(false)
      setErrorMessage(GENERIC_UNACKNOWLEDGE_ERROR)
      if (typeof console !== 'undefined') {
        console.error('[MappingDrawer] unacknowledgeField threw:', err)
      }
    }
  }, [row, projectId, onActionComplete])

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
    // Status guard mirrors §3.2 — Edit is hidden on rejected /
    // target_acknowledged / unmapped, but defensively bail here too.
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
      />
      <DrawerSubheader row={effectiveRow} />
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
        onEditClick={handleEditClick}
        onEditFormCancelClick={() => maybeRequestClose()}
        onEditFormSaveClick={() => void handleEditSavePrecheck()}
        isUnacknowledging={isUnacknowledging}
        onUnacknowledgeClick={() => setConfirmUnacknowledgeOpen(true)}
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
      <UnacknowledgeConfirmDialog
        open={confirmUnacknowledgeOpen}
        onOpenChange={(next) => {
          if (isUnacknowledging) return
          setConfirmUnacknowledgeOpen(next)
        }}
        targetFieldName={effectiveRow.targetField.name}
        isUnacknowledging={isUnacknowledging}
        onConfirm={handleUnacknowledgeConfirm}
      />
    </aside>
  )
}

// ── Optimistic overlay helper ───────────────────────────────────────────────
//
// Apply the "Approve in flight" overlay to a row. Only mapped /
// value_assignment rows are reachable here — Approve is disabled for
// `target_acknowledged` and the button does not exist for `unmapped`.
// Returning the row unchanged for those kinds is purely defensive.

function applyOptimisticApprove(row: MappingRow): MappingRow {
  if (row.kind === 'mapped') return { ...row, status: 'approved' }
  if (row.kind === 'value_assignment') return { ...row, status: 'approved' }
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
const GENERIC_UNACKNOWLEDGE_ERROR =
  "Couldn't un-acknowledge this field. Please try again."

// ── Header ─────────────────────────────────────────────────────────────────

function DrawerHeader({
  row,
  titleId,
  onClose,
}: {
  row: MappingRow
  titleId: string
  onClose: () => void
}) {
  return (
    <header
      data-testid="mapping-drawer-header"
      className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h2
          id={titleId}
          data-testid="mapping-drawer-title"
          className="truncate font-mono text-base font-semibold text-slate-900"
          title={row.targetField.name}
        >
          {row.targetField.name}
        </h2>
        <TableBadge tableName={row.targetField.targetTable.name} />
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        data-testid="mapping-drawer-close"
        className={cn(
          'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
          'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  )
}

// ── Subheader (per-row-kind summary) ───────────────────────────────────────

/**
 * Sticky summary line directly under the header. The content varies by
 * row kind / rule per the Gap 7 founder spec:
 *
 *   Rule 1 (mapped, 1 source)        "from" + field [Badge]
 *   Rule 2 (same-table multi-source) "from" + comma-fields [Badge]
 *   Rule 3 (cross-table, 2 tables)   "from" + field [Badge], field [Badge]
 *   Rule 4 (3+ tables OR 5+ fields)  "from" + first 3 (field [Badge]) + "+ N more"
 *   Rule 5 (target_acknowledged)     "acknowledged — <reason>" (italic)
 *                                    or "acknowledged" alone if no reason
 *   Rule 6 (unmapped)                "no source mapped yet" (italic)
 *   VA                               "value assignment" (italic)
 *
 * Pure presentational. The classification call delegates to
 * `classifyMappedRow` so Rule semantics stay in one place.
 */
function DrawerSubheader({ row }: { row: MappingRow }) {
  return (
    <div
      data-testid="mapping-drawer-subheader"
      className="sticky z-[9] border-b border-slate-100 bg-white px-5 py-2.5 text-sm text-slate-500"
      style={{ top: 'var(--drawer-header-offset, 65px)' }}
    >
      <SubheaderContent row={row} />
    </div>
  )
}

function SubheaderContent({ row }: { row: MappingRow }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSubheader row={row} />
    case 'value_assignment':
      return (
        <span className="italic" data-testid="mapping-drawer-subheader-va">
          value assignment
        </span>
      )
    case 'target_acknowledged':
      return <AcknowledgedSubheader row={row} />
    case 'unmapped':
      return (
        <span className="italic" data-testid="mapping-drawer-subheader-unmapped">
          no source mapped yet
        </span>
      )
  }
}

function MappedSubheader({ row }: { row: MappedRow }) {
  if (row.sources.length === 0) {
    // Defensive: a 'mapped' row with zero sources is a contract violation
    // upstream (would be 'value_assignment' / 'target_acknowledged'). Fall
    // back to the unmapped phrasing rather than crashing.
    return <span className="italic">no source mapped yet</span>
  }
  const rule = classifyMappedRow(row.sources)
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`mapping-drawer-subheader-${rule}`}
    >
      <span>from</span>
      <SubheaderRuleBody rule={rule} sources={row.sources} />
    </div>
  )
}

const RULE_4_PREVIEW_LIMIT = 3

function SubheaderRuleBody({
  rule,
  sources,
}: {
  rule: MappingRowRule
  sources: MappingSourceRef[]
}) {
  switch (rule) {
    case 'rule_1': {
      const s = sources[0]!
      return (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-slate-700">{s.sourceField.name}</span>
          <TableBadge tableName={s.sourceTable.name} />
        </span>
      )
    }
    case 'rule_2': {
      // All sources share a table by classifier guarantee; render one badge.
      const fieldList = sources.map((s) => s.sourceField.name).join(', ')
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-slate-700" title={fieldList}>
            {fieldList}
          </span>
          <TableBadge tableName={sources[0]!.sourceTable.name} />
        </span>
      )
    }
    case 'rule_3': {
      // Cross-table, 2 tables. Render each source as `field [Badge]`,
      // comma-separated. We walk the sources in ordinal order — no client
      // sort — so per-source visual order matches the row.
      return (
        <>
          {sources.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-2">
              <span className="font-mono text-slate-700">{s.sourceField.name}</span>
              <TableBadge tableName={s.sourceTable.name} />
              {i < sources.length - 1 ? <span aria-hidden="true">,</span> : null}
            </span>
          ))}
        </>
      )
    }
    case 'rule_4': {
      const preview = sources.slice(0, RULE_4_PREVIEW_LIMIT)
      const overflow = sources.length - preview.length
      return (
        <>
          {preview.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-2">
              <span className="font-mono text-slate-700">{s.sourceField.name}</span>
              <TableBadge tableName={s.sourceTable.name} />
              {i < preview.length - 1 ? <span aria-hidden="true">,</span> : null}
            </span>
          ))}
          {overflow > 0 ? (
            <span
              className="text-slate-500"
              data-testid="mapping-drawer-subheader-more"
            >
              + {overflow} more
            </span>
          ) : null}
        </>
      )
    }
  }
}

function AcknowledgedSubheader({ row }: { row: TargetAcknowledgedRow }) {
  if (row.acknowledgmentReason) {
    return (
      <span data-testid="mapping-drawer-subheader-ack">
        <span>acknowledged — </span>
        <span className="italic">{row.acknowledgmentReason}</span>
      </span>
    )
  }
  return (
    <span className="italic" data-testid="mapping-drawer-subheader-ack">
      acknowledged
    </span>
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
//   target_acknowledged → AcknowledgedBody
//   unmapped            → UnmappedBody
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
}: DrawerBodyProps) {
  switch (row.kind) {
    case 'mapped':
      // Phase 4b-1 — when the user clicks Edit on a mapped row, the
      // body switches from the read-only roster to the same
      // `CreateMappingForm` used for creation, parameterized in
      // `mode='edit'`. The form needs `projectId` + the page-level
      // source fields list (for the picker) — both are threaded down
      // from the drawer's existing props.
      if (
        editFormActive &&
        editInitialState !== null &&
        projectId !== undefined &&
        availableSourceFields !== undefined
      ) {
        return (
          <>
            <TargetFieldSection targetField={row.targetField} />
            <DrawerSection
              title="Edit mapping"
              testId="drawer-section-edit-mapping"
            >
              <CreateMappingForm
                ref={formRef}
                mode="edit"
                editInitialState={editInitialState}
                projectId={projectId}
                targetField={{
                  id: row.targetField.id,
                  name: row.targetField.name,
                }}
                availableSourceFields={availableSourceFields}
                onSaveSuccess={onEditFormSaveSuccess}
                onCancel={onEditFormCancel}
                onStateChange={onFormStateChange}
              />
            </DrawerSection>
          </>
        )
      }
      return <MappedBody row={row} />
    case 'value_assignment':
      return <ValueAssignmentBody row={row} />
    case 'target_acknowledged':
      return <AcknowledgedBody row={row} />
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
    <section className="mb-6 last:mb-0" data-testid={testId}>
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

// ── Shared "Target field" section (used by every kind body) ────────────────

/**
 * Reused by all four kinds. Shows target name + TableBadge on the first
 * line, then `<dataType> · <required|nullable>` underneath. The target field
 * identity is the one constant across every drawer body.
 */
function TargetFieldSection({ targetField }: { targetField: TargetFieldRef }) {
  return (
    <DrawerSection title="Target field" testId="drawer-section-target-field">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="font-mono text-sm text-slate-900"
            data-testid="drawer-target-field-name"
          >
            {targetField.name}
          </span>
          <TableBadge tableName={targetField.targetTable.name} />
        </div>
        <div
          className="text-xs text-slate-500"
          data-testid="drawer-target-field-meta"
        >
          <span className="font-mono">{targetField.dataType}</span>
          <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
          <span>{targetField.isNullable ? 'nullable' : 'required'}</span>
        </div>
      </div>
    </DrawerSection>
  )
}

// ── Shared "Status" section (Rule 5 + VA) ──────────────────────────────────
//
// Mirrors the row-level `STATUS_CONFIG` literal in `FieldMappingRow.tsx`. The
// duplication is small (one config map) and deliberate: refactoring into a
// shared module is premature until Gap 9's footer wires up the same vocabulary
// for Approve / Reject buttons. At that point a single source of truth makes
// sense — currently the change would be churn for two callers.

type DrawerStatus = MappingRow['status']

const DRAWER_STATUS_CONFIG: Record<
  DrawerStatus,
  { label: string; dotClassName: string }
> = {
  approved: { label: 'Approved', dotClassName: 'bg-green-500' },
  needs_review: { label: 'Needs Review', dotClassName: 'bg-amber-400' },
  rejected: { label: 'Rejected', dotClassName: 'bg-red-500' },
  unmapped: { label: 'Unmapped', dotClassName: 'bg-slate-300' },
}

function StatusSection({ status }: { status: DrawerStatus }) {
  const cfg = DRAWER_STATUS_CONFIG[status]
  return (
    <DrawerSection title="Status" testId="drawer-section-status">
      <div
        className="flex items-center gap-2"
        data-testid="drawer-status-indicator"
      >
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 flex-shrink-0 rounded-full', cfg.dotClassName)}
        />
        <span className="text-sm text-slate-900">{cfg.label}</span>
      </div>
    </DrawerSection>
  )
}

// ── Rule 5 — Target Acknowledged ───────────────────────────────────────────

/**
 * Acknowledged-row drawer body.
 *
 * NOTE on omitted fields (Gap 8a contract-shape decision, 2026-04-24):
 * The Gap 8a spec mentions optional `acknowledgmentNotes`, `acknowledgedBy`,
 * and `acknowledgedAt` rows. The redesign data contract
 * (`lib/types/mappings-for-redesign.ts` `TargetAcknowledgedRow`) currently
 * exposes ONLY `acknowledgmentReason`. The other three fields are not on the
 * wire and not surfaced in the underlying server action. They are deferred
 * pending a contract change — adding them here would require expanding
 * `TargetAcknowledgedRow`, the translator, and the read-path tests in
 * lockstep. Out of scope for Gap 8a per the original prompt's constraint
 * "do NOT touch lib/actions/mappings-for-redesign.ts or types".
 */
function AcknowledgedBody({ row }: { row: TargetAcknowledgedRow }) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      <DrawerSection title="Acknowledgment" testId="drawer-section-acknowledgment">
        {row.acknowledgmentReason ? (
          <p
            className="text-sm text-slate-900"
            data-testid="drawer-acknowledgment-reason"
          >
            {row.acknowledgmentReason}
          </p>
        ) : (
          <DrawerEmptyState
            text="No reason recorded"
            testId="drawer-acknowledgment-reason-empty"
          />
        )}
      </DrawerSection>
      <StatusSection status={row.status} />
    </>
  )
}

// ── Rule 6 — Unmapped ──────────────────────────────────────────────────────

const UNMAPPED_BODY_PROSE =
  'Remapping unmapped fields is coming soon. For now, use the legacy Mapping view to create a new mapping.'

/**
 * Unmapped-row drawer body. No status section — unmapped state is implicit
 * from the prose.
 *
 * Phase 4a closure (2026-04-26): the TODO previously parked here for
 * "future remap gap, Phase 4 / TBD" has shipped. Phase 4a-2 wired the
 * inline `CreateMappingForm` (manual same-table creation), Phase 4a-3
 * extended it to cross-table sources, and Phase 4a-4b added AI Suggest
 * (footer button + in-form pill, ConfidencePill, replace-warning gate,
 * laundering-prevention save metadata). The footer below now mirrors
 * the form lifecycle — `[Suggest with AI]` `[Create mapping]` when
 * inactive, `[Cancel suggestion]` while a suggestion is in flight,
 * `[Cancel]` `[Save mapping]` once the form is active.
 *
 * `UNMAPPED_BODY_PROSE` remains as the empty-state copy shown before
 * the user clicks either footer button. The "use the legacy Mapping
 * view" steer is now stale on Heritage but kept for non-flag projects
 * (where the legacy `MappingContent.tsx` still owns this surface);
 * a copy revisit is queued as polish in Phase 5-Cleanup once the flag
 * comes off and the legacy file retires.
 */
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
}: UnmappedBodyProps) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      {isFormActive && projectId ? (
        <DrawerSection
          title="Create mapping"
          testId="drawer-section-create-mapping"
        >
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
      ) : (
        <DrawerSection
          title="Mapping status"
          testId="drawer-section-mapping-status"
        >
          <p
            className="text-sm text-slate-600"
            data-testid="drawer-unmapped-prose"
          >
            {UNMAPPED_BODY_PROSE}
          </p>
        </DrawerSection>
      )}
    </>
  )
}

// ── VA — Value Assignment ──────────────────────────────────────────────────

/**
 * Value-assignment drawer body.
 *
 * `combinationSql` is the single field that distinguishes a VA from any other
 * row in the drawer view. We render it in a code block (slate-50 bg, mono,
 * `whitespace-pre-wrap` so multi-line SQL preserves formatting). Long lines
 * are allowed to scroll horizontally to keep the multiline reading pose.
 *
 * The status section uses the actual `row.status` (not hardcoded "Approved").
 * VAs are nominally created at `'approved'` but the contract permits all three
 * states (`'needs_review' | 'approved' | 'rejected'`); rendering the actual
 * value avoids lying to the user when they are mid-review.
 */
function ValueAssignmentBody({ row }: { row: ValueAssignmentRow }) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />

      <DrawerSection title="Value expression" testId="drawer-section-value-expression">
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

      <DrawerSection title="AI reasoning" testId="drawer-section-ai-reasoning">
        {row.aiReasoning ? (
          <p
            className="text-sm italic text-slate-600"
            data-testid="drawer-ai-reasoning"
          >
            {row.aiReasoning}
          </p>
        ) : (
          <DrawerEmptyState
            text="No reasoning available"
            testId="drawer-ai-reasoning-empty"
          />
        )}
      </DrawerSection>

      <DrawerSection title="Confidence" testId="drawer-section-confidence">
        {row.confidence !== null ? (
          <span
            className="text-sm tabular-nums text-slate-900"
            data-testid="drawer-confidence"
          >
            {formatConfidencePercent(row.confidence)}
          </span>
        ) : (
          <span
            aria-label="no confidence available"
            className="inline-flex items-center text-sm text-slate-400"
            data-testid="drawer-confidence-empty"
          >
            <span aria-hidden="true">—</span>
          </span>
        )}
      </DrawerSection>

      <StatusSection status={row.status} />
    </>
  )
}


// ── Mapped row body — Gap 8b ───────────────────────────────────────────────
//
// Per-source roster + combination strategy + row-level reasoning/confidence.
// Sections:
//
//   1. Target field      (reused — TargetFieldSection)
//   2. Sources           (per-source roster, 1+ SourceCards)
//   3. Combination       (multi-source rows only — sources.length >= 2)
//   4. AI reasoning      (row-level; empty-state when null since absence is
//                         meaningful at the row level — contrast with
//                         per-source reasoning, which silently omits)
//   5. Confidence        (row-level)
//   6. Status            (reused — StatusSection)
//
// Source ordering invariant: `sources[]` is server-emitted in ordinal-asc
// order. The roster MUST iterate verbatim — no client-side sort. The
// codebase grep invariant in `tests/lib/no-shim-in-redesign-path.test.ts`
// guards this for the redesign path generally.

/**
 * Combination-type → human-readable phrase. Defensive over the full enum
 * even though `'single'` is functionally unreachable in the rendered output
 * (the Combination section is gated on `sources.length >= 2`, while
 * `combinationType: 'single'` only ever appears with `sources.length === 1`
 * per migration 074 STEP 5 and the contract JSDoc). Keeping all four
 * entries:
 *
 *   • Exhaustive maps catch enum widening at compile time without ad-hoc
 *     `default:` branches.
 *   • If a future contract drift produces `'single'` on a multi-source
 *     row, this renders a sensible label instead of throwing.
 */
const COMBINATION_TYPE_LABELS: Record<MappedRow['combinationType'], string> = {
  single: 'Use single source',
  concat_space: 'Concatenate with space',
  concat_comma: 'Concatenate with comma',
  custom_sql: 'Custom SQL expression',
}

/**
 * Mapped-row drawer body. Reuses Gap 8a primitives wherever possible
 * (`TargetFieldSection`, `StatusSection`, `DrawerSection`, `DrawerEmptyState`,
 * `formatConfidence`).
 */
function MappedBody({ row }: { row: MappedRow }) {
  const isMultiSource = row.sources.length >= 2
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      <SourcesSection sources={row.sources} />
      {isMultiSource ? (
        <CombinationSection
          combinationType={row.combinationType}
          combinationSql={row.combinationSql}
        />
      ) : null}
      <RowAiReasoningSection aiReasoning={row.aiReasoning} />
      <RowConfidenceSection confidence={row.confidence} />
      <StatusSection status={row.status} />
    </>
  )
}

/**
 * Per-source roster wrapper. Always renders the "Sources" section header
 * for visual consistency with the rest of the drawer body — including for
 * Rule 1 (single source). See Gap 8b investigation report Q1 for the
 * consistency-over-density rationale.
 *
 * `sources[]` is iterated verbatim (no `.sort()` — server ordinal order is
 * authoritative).
 */
function SourcesSection({ sources }: { sources: MappingSourceRef[] }) {
  // Phase 4a-6 retired the cross-table transparency badge — the
  // `dq_apply_field_transform_joined` RPC now wires the cross-table
  // branch via migration 076. Sources can span multiple source tables
  // without limitation. See `docs/features/mapping-redesign.md`
  // (Phase 4a-6 closure) for the historical narrative.
  return (
    <DrawerSection title="Sources" testId="drawer-section-sources">
      <ul className="space-y-3" data-testid="drawer-sources-list">
        {sources.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </ul>
    </DrawerSection>
  )
}

/**
 * Per-source card. Layout (founder decision 1):
 *
 *   [TableBadge] field_name        confidence    (join: …)
 *   Sample values
 *   v1, v2, v3, v4 (... (+N more) when truncated)
 *   <italic per-source reasoning>
 *
 * Sample-values block omits entirely when `sampleValues` is empty (silent).
 * Per-source reasoning omits entirely when null (silent — sources without
 * reasoning are common; an empty-state would clutter). Contrast with the
 * row-level reasoning section, which DOES surface absence.
 *
 * No card border — vertical whitespace separates cards. Matches the
 * Linear/Notion-style aesthetic established in Gap 8a.
 */
function SourceCard({ source }: { source: MappingSourceRef }) {
  const samplesLine = formatSampleValues(source.sampleValues)
  return (
    <li className="space-y-1.5" data-testid="drawer-source-card">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TableBadge tableName={source.sourceTable.name} />
        <span
          className="truncate font-mono text-sm text-slate-900"
          data-testid="drawer-source-field-name"
          title={source.sourceField.name}
        >
          {source.sourceField.name}
        </span>
        <span
          className="ml-auto flex-shrink-0 tabular-nums text-xs text-slate-500"
          data-testid="drawer-source-confidence"
        >
          {formatConfidencePercent(source.confidence)}
        </span>
        {source.joinAnnotation ? (
          <span
            className="basis-full text-xs italic text-slate-500"
            data-testid="drawer-source-join"
          >
            {/* `source.joinAnnotation` is pre-formatted by
                `deriveJoinAnnotation` in
                `lib/actions/_mappings-for-redesign-core.ts` and
                already includes the `(join: …)` wrapper. Render
                verbatim — wrapping again produces "(join: (join: X))". */}
            {source.joinAnnotation}
          </span>
        ) : null}
      </div>

      {samplesLine !== '' ? (
        <div data-testid="drawer-source-samples">
          <div className="text-xs text-slate-500">Sample values</div>
          <div className="break-words text-xs text-slate-600">
            {samplesLine}
          </div>
        </div>
      ) : null}

      {source.aiReasoning ? (
        <p
          className="text-sm italic text-slate-600"
          data-testid="drawer-source-reasoning"
        >
          {source.aiReasoning}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Combination strategy. Renders the human-readable label for the
 * `combinationType`; when `combinationType === 'custom_sql'` AND
 * `combinationSql` is non-null, also renders the SQL in a code block whose
 * styling matches `ValueAssignmentBody`'s Value expression block exactly
 * (consistency for the same visual primitive across body kinds).
 *
 * Caller-gated on `sources.length >= 2` — single-source rows never see
 * this section.
 */
function CombinationSection({
  combinationType,
  combinationSql,
}: {
  combinationType: MappedRow['combinationType']
  combinationSql: string | null
}) {
  const label = COMBINATION_TYPE_LABELS[combinationType]
  const showSql = combinationType === 'custom_sql' && combinationSql !== null
  return (
    <DrawerSection title="Combination" testId="drawer-section-combination">
      <div
        className="text-sm text-slate-900"
        data-testid="drawer-combination-label"
      >
        {label}
      </div>
      {showSql ? (
        <pre
          className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs text-slate-900"
          data-testid="drawer-combination-sql"
        >
          {combinationSql}
        </pre>
      ) : null}
    </DrawerSection>
  )
}

/**
 * Row-level AI reasoning. Surfaces an empty-state when null — at the row
 * level, "no reasoning" IS information (the AI couldn't justify the
 * mapping, the user should know). Per-source reasoning by contrast is
 * silently omitted when absent.
 */
function RowAiReasoningSection({ aiReasoning }: { aiReasoning: string | null }) {
  return (
    <DrawerSection title="AI reasoning" testId="drawer-section-ai-reasoning">
      {aiReasoning ? (
        <p
          className="text-sm italic text-slate-600"
          data-testid="drawer-ai-reasoning"
        >
          {aiReasoning}
        </p>
      ) : (
        <DrawerEmptyState
          text="No reasoning available"
          testId="drawer-ai-reasoning-empty"
        />
      )}
    </DrawerSection>
  )
}

/**
 * Row-level confidence. Mirrors the VA body's Confidence section exactly —
 * percentage when non-null, em-dash with sr-only label when null. Always
 * rendered (including for Rule 1 even though the value duplicates the
 * single source's confidence) per Gap 8b investigation Q2 — consistency
 * with the rest of the drawer body wins over the marginal density saving.
 */
function RowConfidenceSection({ confidence }: { confidence: number | null }) {
  return (
    <DrawerSection title="Confidence" testId="drawer-section-confidence">
      {confidence !== null ? (
        <span
          className="text-sm tabular-nums text-slate-900"
          data-testid="drawer-confidence"
        >
          {formatConfidencePercent(confidence)}
        </span>
      ) : (
        <span
          aria-label="no confidence available"
          className="inline-flex items-center text-sm text-slate-400"
          data-testid="drawer-confidence-empty"
        >
          <span aria-hidden="true">—</span>
        </span>
      )}
    </DrawerSection>
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
//   target_acknowledged
//     Approve: DISABLED ("acknowledged" tooltip)
//     Reject:  DISABLED ("acknowledged" tooltip)
//   unmapped
//     no footer — no actions are valid yet
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
  /** Phase 4b-1 — [Edit] click handler on mapped rows. */
  onEditClick: () => void
  /** Phase 4b-1 — edit-mode [Cancel] click handler. */
  onEditFormCancelClick: () => void
  /** Phase 4b-1 — edit-mode [Save changes] click handler (runs preview-then-save). */
  onEditFormSaveClick: () => void
  /**
   * Phase 4b-2 — true while the un-acknowledge call is in flight.
   * Drives the spinner on the Un-acknowledge button (and on the
   * confirm dialog's destructive action).
   */
  isUnacknowledging: boolean
  /**
   * Phase 4b-2 — Un-acknowledge click handler. Opens the confirm
   * dialog; the actual server call fires from the dialog's confirm
   * action.
   */
  onUnacknowledgeClick: () => void
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
  onEditClick,
  onEditFormCancelClick,
  onEditFormSaveClick,
  isUnacknowledging,
  onUnacknowledgeClick,
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
          isFormActive={isFormActive}
          formCanSave={formCanSave}
          formIsSavePending={formIsSavePending}
          isSuggestPending={isSuggestPending}
          onCreateMappingClick={onCreateMappingClick}
          onSuggestWithAIClick={onSuggestWithAIClick}
          onCancelSuggestClick={onCancelSuggestClick}
          onFormCancelClick={onFormCancelClick}
          onFormSaveClick={onFormSaveClick}
        />
      ) : row.kind === 'target_acknowledged' ? (
        <AcknowledgedFooterButtons
          isUnacknowledging={isUnacknowledging}
          onUnacknowledgeClick={onUnacknowledgeClick}
        />
      ) : (
        <ApproveRejectButtons
          status={row.status}
          isApprovePending={isApprovePending}
          isRejecting={isRejecting}
          optimisticallyApproved={optimisticallyApproved}
          onApprove={onApprove}
          onRejectClick={onRejectClick}
          // Phase 4b-1 — Edit affordance. Visible only on `mapped`
          // rows in `needs_review` / `approved` (founder §3.2 hides
          // it on `rejected`; VAs and acknowledged rows are entirely
          // separate footer dispatches above). `custom_sql` mapped
          // rows are also excluded — those are Transform-tab edits,
          // not source-list edits.
          showEditButton={
            row.kind === 'mapped' &&
            (row.status === 'needs_review' || row.status === 'approved') &&
            row.combinationType !== 'custom_sql'
          }
          isEditDisabled={isApprovePending || isRejecting}
          onEditClick={onEditClick}
        />
      )}
    </footer>
  )
}

// ── Unmapped footer (Phase 4a-2 + 4a-4b) ────────────────────────────────────
//
// Mode-switches between THREE visual states (4a-4b adds the third):
//
//   • Inactive — Two-button row: [Suggest with AI] [Create mapping]. The
//     Suggest variant flips both `isFormActive` AND `autoSuggestRequested`
//     (drawer level) so the form mounts ready to fire its mount-time
//     `invokeSuggest`. Both buttons are always enabled on initial render
//     per locked §2-OQ-2 — rate-limit gating happens INSIDE the form's
//     pill, not at the footer.
//
//   • Active + Suggest pending — Single [Cancel suggestion] button. Drives
//     `formRef.current.cancelSuggest()` which aborts the in-flight
//     controller and restores the form's pre-pending snapshot.
//
//   • Active + not pending — [Cancel] [Save mapping] pair (4a-2 shape).
//     The Save button is disabled until the form publishes `canSave=true`.
//     Both buttons are disabled while the save is inflight.

interface UnmappedFooterButtonsProps {
  isFormActive: boolean
  formCanSave: boolean
  formIsSavePending: boolean
  isSuggestPending: boolean
  onCreateMappingClick: () => void
  onSuggestWithAIClick: () => void
  onCancelSuggestClick: () => void
  onFormCancelClick: () => void
  onFormSaveClick: () => void
}

function UnmappedFooterButtons({
  isFormActive,
  formCanSave,
  formIsSavePending,
  isSuggestPending,
  onCreateMappingClick,
  onSuggestWithAIClick,
  onCancelSuggestClick,
  onFormCancelClick,
  onFormSaveClick,
}: UnmappedFooterButtonsProps) {
  if (!isFormActive) {
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
  /**
   * Phase 4b-1 — when true, render the Edit button to the RIGHT of
   * Approve (founder §3.3 — rightmost in footer). The drawer decides
   * visibility based on row kind, status, and `combinationType`; this
   * component only handles rendering.
   */
  showEditButton?: boolean
  /** Phase 4b-1 — disable Edit while approve/reject is in flight. */
  isEditDisabled?: boolean
  /** Phase 4b-1 — Edit click handler (no-op when `showEditButton` is false). */
  onEditClick?: () => void
}

function ApproveRejectButtons({
  status,
  isApprovePending,
  isRejecting,
  optimisticallyApproved,
  onApprove,
  onRejectClick,
  showEditButton = false,
  isEditDisabled = false,
  onEditClick,
}: ApproveRejectButtonsProps) {
  // Effective approve-disabled: already approved (incl. optimistic),
  // or another action is in flight.
  const approveDisabled =
    optimisticallyApproved ||
    status === 'approved' ||
    isApprovePending ||
    isRejecting
  const rejectDisabled = isApprovePending || isRejecting

  const approveTitle =
    status === 'approved' || optimisticallyApproved
      ? 'This mapping is already approved'
      : undefined

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
      <button
        type="button"
        data-testid="mapping-drawer-approve-button"
        aria-label="Approve mapping"
        onClick={onApprove}
        disabled={approveDisabled}
        title={approveTitle}
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
          'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/40',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
        )}
      >
        Approve
      </button>
      {showEditButton ? (
        <button
          type="button"
          data-testid="mapping-drawer-edit-button"
          aria-label="Edit mapping"
          onClick={onEditClick}
          disabled={isEditDisabled}
          className={cn(
            'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors',
            'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
            'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
            'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-slate-50',
          )}
        >
          Edit
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

/**
 * Footer button row for `target_acknowledged` rows. Approve/Reject
 * remain disabled with explanatory `title` tooltips — acknowledged
 * rows are an intentional "no source mapping" declaration, not a
 * candidate for approve/reject. Phase 4b-2 adds the rightmost
 * [Un-acknowledge] button which is the canonical way to reverse the
 * acknowledgment (deletes the bare-ack TFM and lets the field return
 * to Rule 6 unmapped). Founder §3.j locked the affordance to the
 * footer (matches Approve/Reject/Edit verb-action shape), and §3.k
 * locked the semantic (delete the row, no new status enum value).
 */
interface AcknowledgedFooterButtonsProps {
  isUnacknowledging: boolean
  onUnacknowledgeClick: () => void
}

function AcknowledgedFooterButtons({
  isUnacknowledging,
  onUnacknowledgeClick,
}: AcknowledgedFooterButtonsProps) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        data-testid="mapping-drawer-reject-button"
        aria-label="Reject mapping"
        disabled
        title="Acknowledged rows can't be rejected; un-acknowledge first."
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium',
          'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400',
        )}
      >
        Reject
      </button>
      <button
        type="button"
        data-testid="mapping-drawer-approve-button"
        aria-label="Approve mapping"
        disabled
        title="Acknowledged rows can't be approved; un-acknowledge first."
        className={cn(
          'inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium',
          'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400',
        )}
      >
        Approve
      </button>
      <button
        type="button"
        data-testid="mapping-drawer-unacknowledge-button"
        aria-label="Un-acknowledge field"
        onClick={onUnacknowledgeClick}
        disabled={isUnacknowledging}
        className={cn(
          'inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors',
          'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
          'focus:outline-none focus:ring-2 focus:ring-slate-500/30',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
        )}
      >
        {isUnacknowledging ? (
          <>
            <Loader2
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin"
              data-testid="mapping-drawer-unacknowledge-spinner"
            />
            <span>Un-acknowledging…</span>
          </>
        ) : (
          'Un-acknowledge'
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

// ── Un-acknowledge confirmation dialog (Phase 4b-2) ─────────────────────────
//
// Locked copy (founder §3.j + investigation report):
//
//   Title:  "Un-acknowledge this field?"
//   Body:   "This will return <field_name> to unmapped (Rule 6) and clear
//            the acknowledgment reason."
//   Buttons: "Cancel" (default) + "Un-acknowledge" (neutral, not destructive
//            — the operation is reversible by re-acknowledging through the
//            existing acknowledgment surface).
//
// Visually distinct from RejectConfirmDialog: button uses the default blue
// styling rather than red because un-acknowledge is NOT a destructive
// "delete and lose data" action — it just toggles the field back to
// unmapped. The user can re-acknowledge or map it without re-authoring
// content.

interface UnacknowledgeConfirmDialogProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  targetFieldName: string
  isUnacknowledging: boolean
  onConfirm: () => void
}

function UnacknowledgeConfirmDialog({
  open,
  onOpenChange,
  targetFieldName,
  isUnacknowledging,
  onConfirm,
}: UnacknowledgeConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="mapping-drawer-unacknowledge-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Un-acknowledge this field?</AlertDialogTitle>
          <AlertDialogDescription>
            This will return{' '}
            <span className="font-mono text-slate-900">{targetFieldName}</span>{' '}
            to unmapped (Rule 6) and clear the acknowledgment reason.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={isUnacknowledging}
            data-testid="mapping-drawer-unacknowledge-cancel"
            onClick={() => {
              if (!isUnacknowledging) onOpenChange(false)
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
            disabled={isUnacknowledging}
            data-testid="mapping-drawer-unacknowledge-confirm"
          >
            {isUnacknowledging ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                />
                Un-acknowledging…
              </>
            ) : (
              'Un-acknowledge'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
