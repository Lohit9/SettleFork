'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2/4a-3 — W1 manual mapping creation form.
// Phase 4b-1     — parameterized for edit mode (W2 edit sources / W3
//                  edit combination type).
// ─────────────────────────────────────────────────────────────────────────────
//
// In-drawer inline form that lets a user create a `target_field_mapping`
// for a Rule 6 unmapped target field (founder decision 1: in-drawer
// inline, no modal) — and as of 4b-1, edit an existing TFM's source list.
// Composed of:
//
//   1. SourceFieldPicker — chip strip + search + grouped list
//   2. SamplePreview     — real-time client-side preview
//
// The drawer parent renders the visible [Cancel] [Save] buttons in the
// drawer footer; the form exposes its imperative save trigger via a
// `forwardRef` handle so the parent can fire it without owning the
// form's internal state shape.
//
// SAVE FLOW
//
//   `useTransition` wraps the call to `createFieldMapping`. On success
//   we yield `tfmId` to the parent via `onSaveSuccess` so it can flip
//   the drawer URL param and trigger `router.refresh()`. On failure we
//   surface a curated error string above the picker; the form stays
//   mounted so the user can correct + retry.
//
// EXISTING_TFM AFFORDANCE
//
//   Per founder decision §3-OQ-1, the wrapper's existing-TFM collision
//   error renders an inline [Refresh] button. Clicking it triggers a
//   `router.refresh()` and dismisses the form via `onCancel` so the
//   user lands on the freshly-rendered server state.
//
// COMBINATION TYPE (Cycle 1 architectural rebuild)
//
//   The combination_type radio UI was removed in Cycle 1. The form now
//   derives `combinationType` for the wrapper payload:
//     • create mode — 0 sources → 'custom_sql' (VA path, unreachable
//       from this form), 1 source → 'single', 2+ sources →
//       'concat_space' (default).
//     • edit mode — snap to 'single' for 1 source; preserve
//       `editInitialState.combinationType` otherwise (legacy
//       'concat_comma' TFMs retain their authored combination on edit).
//
//   `joinAnnotations` is still passed to the wrapper as an opaque
//   pass-through (driven by `editInitialState.joinAnnotations` in edit
//   mode, empty in create mode). The form-side disambiguation prompt
//   is gone in Cycle 1; the wrapper ignores `joinAnnotations` after the
//   FK precheck deletion in Block 2.

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2 } from 'lucide-react'
import { ChevronDown, ChevronRight, Sparkles } from '@/components/icons'
import { cn } from '@/components/ui/utils'
import {
  createFieldMapping,
  editMappingSources,
  type CreateFieldMappingErrorCode,
  type CreateFieldMappingCombinationType,
  type EditMappingErrorCode,
  type SuggestMappingErrorCode,
  suggestMappingForTarget,
} from '@/lib/actions/mappings-for-redesign'
import { DiscardChangesDialog } from './DiscardChangesDialog'
import {
  computeSamplePreview,
  type SamplePreviewCombinationType,
} from '@/lib/utils/mapping-preview'
import {
  classifyConfidence,
  formatConfidenceLabel,
} from '@/lib/utils/confidence-format'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { SourceFieldPicker } from './SourceFieldPicker'

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Phase 4a-4a — minimal serializable snapshot of the form's USER-INPUT
 * fields. Used by:
 *
 *   • The drawer's `onFormDirtyChange` lift — published whenever the
 *     form is dirty so `MappingContent` can offer Undo on row-switch.
 *   • The drawer's `restoreFormState` re-hydrate path — the `Undo`
 *     toast action passes a previously-captured snapshot back down so
 *     the form re-mounts with the user's prior selections.
 *
 * Scope (founder decision §11-OQ-1): fields ONLY. Errors, dialog state,
 * and ephemeral disambiguation cleanup are deliberately excluded — they
 * are recovery surfaces, not draft content. `targetFieldId` is included
 * so a stale snapshot for a different row can be detected and ignored
 * cheaply.
 */
export interface CreateMappingFormSnapshot {
  targetFieldId: string
  selectedIds: string[]
  /**
   * Cycle 1 — informational only. Re-derived from selection on restore
   * (`'single'` for 1 source, `editInitialState.combinationType` in edit
   * mode, `'concat_space'` default in create mode, `'custom_sql'` for
   * the 0-source defensive case which never persists through this form).
   */
  combinationType: CreateFieldMappingCombinationType | 'custom_sql'
  joinAnnotations: Record<string, string>
}

/**
 * Phase 4a-4b — AI Suggest result shape, mirrors the wrapper's
 * `SuggestMappingForTargetResult.suggestion` payload. Values are
 * post-resolution: `sourceFieldIds` are real DB UUIDs, `combinationType`
 * is narrowed to the form's union (custom_sql is impossible at this
 * level — wrapper never emits it; the form's `applyLoadedSuggestion`
 * defends against future drift), `confidence` is integer 0-100, and
 * `rationale` is ≤ 280 chars.
 */
export interface AISuggestion {
  sourceFieldIds: string[]
  combinationType: CreateFieldMappingCombinationType
  confidence: number
  rationale: string
}

/**
 * Phase 4a-4b — error sentinel for client-side network/connectivity
 * failures (server action throws before returning a `success: false`
 * result). Distinct from `SuggestMappingErrorCode` which is the
 * wrapper's structured error union. Both feed into `SUGGEST_ERROR_COPY`
 * for ErrorBanner copy + affordance dispatch.
 */
export type SuggestErrorCode = SuggestMappingErrorCode | 'NETWORK'

/**
 * Phase 4a-4b — discriminated union for the AI Suggest lifecycle. The
 * `pending` variant carries its own `AbortController` so the imperative
 * cancel path (footer [Cancel suggestion] button) can read the live
 * controller without an extra ref dereference. A second
 * `prePendingSnapshotRef` outside this union captures restore state
 * (Flow B per locked §7-OQ-1).
 */
export type SuggestState =
  | { kind: 'idle' }
  | { kind: 'pending'; abortController: AbortController }
  | { kind: 'loaded'; suggestion: AISuggestion }
  | { kind: 'error'; code: SuggestErrorCode; message: string }

/**
 * Phase 4a-4b — pre-pending field snapshot used by `cancelSuggest` to
 * restore the form to its state before the user invoked Suggest. Held
 * in a ref (not state) since it's read-once in the cancel path and
 * doesn't need to drive any rendering. Captures `suggestState` too so
 * cancelling a re-suggest restores to the prior 'loaded' or 'error'
 * state, not just 'idle'.
 */
interface PreSuggestSnapshot {
  selectedIds: string[]
  joinAnnotations: Record<string, string>
  suggestState: SuggestState
}

/**
 * Imperative handle exposed by `CreateMappingForm` to its parent
 * (`MappingDrawer`). The parent owns the visible footer buttons; the
 * handle lets it dispatch into the form without lifting the form's
 * internal state shape.
 */
export interface CreateMappingFormHandle {
  /**
   * Trigger the save flow as if the user clicked the (parent-rendered)
   * Save button. No-op when already saving or when nothing is selected.
   */
  triggerSave: () => void
  /**
   * Tell the form the user wants to close (Esc / X / click-outside /
   * Cancel). When dirty the form opens its own discard dialog and
   * resolves to `onCancel()` only after the user confirms. When clean
   * the form invokes `onCancel()` immediately.
   */
  requestClose: () => void
  /**
   * Phase 4a-4b — abort the in-flight AI Suggest invocation and restore
   * the form's pre-pending snapshot. No-op when not pending.
   */
  cancelSuggest: () => void
}

/**
 * Phase 4b-1 — edit-mode hydration payload. The drawer constructs this
 * from the row's existing `target_field_mapping` + `mapping_sources` rows
 * before mounting the form in `mode='edit'`. Fields:
 *
 *   • `tfmId` — the row id; passed verbatim into `editMappingSources`.
 *   • `selectedIds` — current source field ids in canonical order
 *     (dominant-table sources first, then joined). The form renders
 *     this as the initial picker selection.
 *   • `combinationType` — current `combination_type`. Form's combination
 *     radios pre-select this. When `selectedIds.length <= 1` the form
 *     collapses to `'single'` regardless (matches create-mode behavior).
 *   • `joinAnnotations` — current join_spec entries, one per joined
 *     source table. Pre-populated so the user sees which FK each cross-
 *     table join is using and can change it without re-deriving.
 *
 * Provenance is NOT carried here. The wrapper reads
 * `mapping_sources.ai_reasoning` server-side and applies the laundering
 * rule (founder §1.f) without form-side input — a manual TFM stays
 * manual, an AI TFM stays AI iff at least one originally-AI source
 * survives.
 */
export interface EditMappingInitialState {
  tfmId: string
  selectedIds: string[]
  combinationType: CreateFieldMappingCombinationType
  joinAnnotations: Record<string, string>
}

/**
 * Phase 4b-1 — meta payload returned to the parent on a successful
 * edit save. The drawer uses `transformReset` + `stagedRowsReverted`
 * to drive the post-save success toast (with `[Re-author transform]`
 * deep-link affordance when a transform was reset).
 */
export interface EditSaveMeta {
  mode: 'edit'
  tfmId: string
  transformReset: boolean
  stagedRowsReverted: number
  nextStatus: 'needs_review'
}

export interface CreateMappingFormProps {
  projectId: string
  /**
   * Phase 4b-1 — discriminator between the two top-level shapes the
   * form supports. Defaults to `'create'` for backward compatibility
   * with all existing 4a-* call sites.
   *
   *   • `'create'` (default) — Rule 6 form. AI Suggest visible. Submit
   *     handler routes to `createFieldMapping`. Discard dialog title
   *     reads "Discard changes?".
   *   • `'edit'`             — edit form. AI Suggest hidden (deferred
   *     to Phase 4-extras). Submit routes to `editMappingSources`.
   *     Hydrates from `editInitialState` on mount. Discard dialog
   *     copy unchanged (founder §3 — "selected sources for X will be
   *     lost" reads correctly for both new and edited selection).
   */
  mode?: 'create' | 'edit'
  /**
   * Phase 4b-1 — when `mode='edit'`, the snapshot of the existing TFM
   * to hydrate from. REQUIRED when `mode='edit'`; ignored otherwise.
   * Hydration runs once on mount (or when the snapshot identity
   * changes), matching the `restoreFormState` pattern.
   */
  editInitialState?: EditMappingInitialState
  /**
   * The target field this form is mapping. For `mode='create'` this
   * is the Rule 6 unmapped target field. For `mode='edit'` this is
   * the same field whose existing TFM is being edited. Only `id` is
   * required for create-mode wrapper calls; `name` is rendered in
   * the discard-dialog body for context. (For edit-mode the TFM id
   * comes from `editInitialState.tfmId`.)
   */
  targetField: { id: string; name: string }
  /**
   * Page-level source fields in canonical server order. Picker filters
   * and same-table-constrains in-line.
   */
  availableSourceFields: SourceFieldWithState[]
  /**
   * Called once a save succeeds.
   *
   *   • `mode='create'` — `tfmId` is the newly-created row's id; `meta`
   *     is omitted. Parent updates the drawer URL param and calls
   *     `router.refresh()` so the row morphs from Rule 6 to Rule 1/2.
   *   • `mode='edit'`   — `tfmId` is the same row id (unchanged);
   *     `meta` carries `transformReset` + `stagedRowsReverted` +
   *     `nextStatus` so the drawer can show the post-save toast
   *     (with the `[Re-author transform]` deep-link when a transform
   *     was reset).
   */
  onSaveSuccess: (tfmId: string, meta?: EditSaveMeta) => void
  /**
   * Called when the user cancels (clean form OR after confirming
   * discard). Parent typically clears `isFormActive` so the drawer
   * body returns to the Rule 6 empty state.
   */
  onCancel: () => void
  /**
   * Notifies the parent (drawer) whenever the dirty flag flips so the
   * drawer's close-with-confirm intercept and the footer's Save-button
   * disabled state can read a single source of truth.
   *
   * Phase 4a-4a: also carries `snapshot` — the dirty-time snapshot of
   * user-input fields, or `null` when the form is clean. The drawer
   * lifts this further to `MappingContent` so a row-switch-while-dirty
   * can offer an Undo affordance.
   */
  onStateChange?: (state: {
    isDirty: boolean
    canSave: boolean
    isSavePending: boolean
    snapshot: CreateMappingFormSnapshot | null
  }) => void
  /**
   * Phase 4a-4a — when a user undoes a row-switch-discard, the toast
   * action passes a previously-captured snapshot back down here. The
   * form applies the snapshot on mount, then immediately invokes
   * `onRestoreConsumed` so the parent can clear the prop and avoid
   * re-applying on subsequent renders. Stale snapshots whose
   * `targetFieldId` doesn't match the current `targetField.id` are
   * silently ignored (defense-in-depth — `MappingContent` already
   * gates by row identity).
   */
  restoreFormState?: CreateMappingFormSnapshot | null
  /** See `restoreFormState`. */
  onRestoreConsumed?: () => void
  /**
   * Phase 4a-4b — when true on mount the form auto-fires AI Suggest
   * once. Used by Flow A (user clicks [Suggest with AI] from the
   * Rule 6 footer): the drawer flips `isFormActive=true` AND sets this
   * prop. The form consumes it in a one-shot mount-time effect and
   * immediately invokes `onAutoSuggestConsumed` so the parent can clear
   * the flag (matches the `restoreFormState` consume pattern).
   */
  autoSuggest?: boolean
  /** See `autoSuggest`. */
  onAutoSuggestConsumed?: () => void
  /**
   * Phase 4a-4b — strict-mode-resistant consumption guard owned by the
   * parent (drawer). When the form's mount-time `autoSuggest` effect
   * fires, it calls this with the current `targetField.id` and only
   * proceeds if the return is `true`.
   *
   * Why parent-owned: in Next.js 14 dev (`reactStrictMode: true` by
   * default for app router), every mount runs the effect twice (mount
   * → cleanup → mount-again). A `useRef(false)` *inside* the form
   * resets to `false` on the second mount, so the guard fails and
   * `invokeSuggest` fires twice — issuing two server-side LLM calls
   * per click. The drawer doesn't remount during the form's strict-
   * mode cycle, so a `Set<string>` owned by the drawer survives the
   * cycle and short-circuits the second mount.
   *
   * Optional for tests that exercise mount-time behavior without
   * needing the cross-mount guarantee. Production path always passes
   * a real implementation.
   */
  tryConsumeAutoSuggest?: (targetFieldId: string) => boolean
  /**
   * Phase 4a-4b — fired whenever the AI Suggest lifecycle phase changes.
   * The drawer reads `isSuggestPending` to swap its footer to the
   * single [Cancel suggestion] button. Other phases use the existing
   * Cancel + Save pair.
   */
  onSuggestStateChange?: (state: { isSuggestPending: boolean }) => void
}

// ── Defaults / mappings ──────────────────────────────────────────────────────

const DEFAULT_COMBINATION_TYPE: CreateFieldMappingCombinationType = 'concat_space'

const ERROR_CODE_COPY: Record<CreateFieldMappingErrorCode, string> = {
  PERMISSION_DENIED:
    "You don't have permission to create mappings on this project.",
  NOT_FOUND: "Couldn't create the mapping. Please refresh and try again.",
  VALIDATION:
    "Couldn't create the mapping. Please check your selections and try again.",
  MAINTENANCE_MODE:
    'Mapping changes are temporarily disabled. Please try again in a moment.',
  INTERNAL: "Couldn't create the mapping. Please try again.",
  // Retained on the union for client compatibility but no longer
  // emitted post-4a-3 (cross-table input is fully supported).
  CROSS_TABLE_NOT_YET_SUPPORTED:
    'Cross-table mappings are not available in this build. Please pick sources from a single source table.',
}

const EXISTING_TFM_COPY =
  'This target field was mapped while you were editing. Refresh to see the current state.'

// ── Phase 4b-1 edit-mode copy ────────────────────────────────────────────────
//
// `EditMappingErrorCode` shares the create-form codes (PERMISSION_DENIED,
// NOT_FOUND, VALIDATION, MAINTENANCE_MODE, INTERNAL) and adds two
// edit-only codes:
//
//   • TFM_REJECTED       — TFM was rejected by another user / tab between
//                          drawer open and save. Edit is not allowed in
//                          this state per §3.2; refresh to recover.
//   • TFM_ACKNOWLEDGED   — TFM target field was acknowledged-as-empty;
//                          edit is not allowed (must un-acknowledge first
//                          via 4b-2). Refresh to recover.
//
// NOTE: a "TFM was deleted while editing" race surfaces as `NOT_FOUND`
// (the wrapper folds DB-row-missing into NOT_FOUND because the user-
// visible recovery is identical: refresh).
const EDIT_ERROR_CODE_COPY: Record<EditMappingErrorCode, string> = {
  PERMISSION_DENIED:
    "You don't have permission to edit mappings on this project.",
  NOT_FOUND:
    'This mapping was removed while you were editing. Refresh to see the current state.',
  VALIDATION:
    "Couldn't update the mapping. Please check your selections and try again.",
  MAINTENANCE_MODE:
    'Mapping changes are temporarily disabled. Please try again in a moment.',
  INTERNAL: "Couldn't update the mapping. Please try again.",
  TFM_REJECTED:
    'This mapping was rejected while you were editing. Refresh to see the current state.',
  TFM_ACKNOWLEDGED:
    'This target field was acknowledged-as-empty while you were editing. Refresh to see the current state.',
}

// Edit-mode codes that should surface the [Refresh] affordance — same
// pattern as the create-mode EXISTING_TFM banner. NOT_FOUND is included
// here because the wrapper uses it as the "TFM was concurrently deleted"
// signal (vs. a non-existent input id, which is caught by VALIDATION).
const EDIT_REFRESH_AFFORDANCE_CODES: ReadonlySet<EditMappingErrorCode> =
  new Set<EditMappingErrorCode>([
    'NOT_FOUND',
    'TFM_REJECTED',
    'TFM_ACKNOWLEDGED',
  ])

// ── AI Suggest error copy + affordance map (Phase 4a-4b) ─────────────────────
//
// Maps each `SuggestErrorCode` to its display copy and the affordance the
// inline ErrorBanner should offer. Three affordance shapes:
//
//   • 'try-again' — re-invokes Suggest. Shown for retryable errors
//     (AI_INVALID_RESPONSE, INTERNAL, NETWORK).
//   • 'refresh'   — calls `router.refresh()` and dismisses the form.
//     Mirrors the existing EXISTING_TFM affordance from 4a-2.
//   • 'none'      — non-retryable. PERMISSION_DENIED is permission-
//     scoped (no retry will help). RATE_LIMITED is timed-out (the
//     pill becomes disabled with the wait-time tooltip per §7c — the
//     banner is the persistent textual explanation; retry button
//     would feel spammy).
//
// `RATE_LIMITED` displays the wrapper's verbatim error message (which
// includes the wait time, e.g. "AI rate limit reached (100/hour). Try
// again in 47 minutes.") rather than a hardcoded string — the wait
// duration is dynamic.
type SuggestErrorAffordance = 'try-again' | 'refresh' | 'none'

interface SuggestErrorRender {
  /** Copy to display, or 'verbatim' to use the wrapper's `result.error`. */
  copy: string | 'verbatim'
  affordance: SuggestErrorAffordance
}

const SUGGEST_ERROR_COPY: Record<SuggestErrorCode, SuggestErrorRender> = {
  PERMISSION_DENIED: {
    copy: "You don't have permission to use AI Suggest on this project.",
    affordance: 'none',
  },
  NOT_FOUND: {
    copy: "Couldn't find the target field. Please refresh and try again.",
    affordance: 'refresh',
  },
  RATE_LIMITED: {
    copy: 'verbatim',
    affordance: 'none',
  },
  AI_INVALID_RESPONSE: {
    copy:
      "The AI suggestion didn't match the expected format. Try again or create the mapping manually.",
    affordance: 'try-again',
  },
  INTERNAL: {
    copy: "Couldn't get an AI suggestion. Try again.",
    affordance: 'try-again',
  },
  NETWORK: {
    copy:
      "Couldn't reach the AI service. Check your connection and try again.",
    affordance: 'try-again',
  },
}

// ── Component ────────────────────────────────────────────────────────────────

export const CreateMappingForm = forwardRef<
  CreateMappingFormHandle,
  CreateMappingFormProps
>(function CreateMappingForm(
  {
    projectId,
    mode = 'create',
    editInitialState,
    targetField,
    availableSourceFields,
    onSaveSuccess,
    onCancel,
    onStateChange,
    restoreFormState,
    onRestoreConsumed,
    autoSuggest = false,
    onAutoSuggestConsumed,
    tryConsumeAutoSuggest,
    onSuggestStateChange,
  },
  ref,
) {
  const router = useRouter()
  const whyPanelDomId = useId()
  const isEditMode = mode === 'edit'

  // ── Phase 4b-1 — edit-mode initial state hydration ────────────────
  //
  // When `mode='edit'`, seed `selectedIds` / `joinAnnotations` from the
  // snapshot on first mount. `useState`'s lazy initializer pattern
  // runs once per mount and paints synchronously, so the first render
  // shows the user's existing selection (no flicker / empty-then-fill).
  //
  // `combinationType` is no longer a useState — Cycle 1 removed the
  // combination radios. The effective value is derived just-in-time:
  //   • create mode: 0 → 'custom_sql' (VA path), 1 → 'single',
  //     2+ → DEFAULT_COMBINATION_TYPE (concat_space).
  //   • edit mode: 1 → 'single'; 0 or ≥2 → preserve
  //     `editInitialState.combinationType` (so legacy 'concat_comma'
  //     TFMs survive an edit unchanged).
  //
  // `editInitialState` is required by contract when `mode='edit'`;
  // we defensively coerce missing values to empty so a misconfigured
  // call site doesn't crash (the form renders empty and the dirty
  // flag stays false until the user makes a selection).
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    isEditMode && editInitialState ? [...editInitialState.selectedIds] : [],
  )
  const [isSavePending, startSaveTransition] = useTransition()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<
    CreateFieldMappingErrorCode | EditMappingErrorCode | null
  >(null)
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  // ── Phase 4a-4b — AI Suggest state ─────────────────────────────
  //
  // `suggestState`: discriminated union driving the AI Suggest UI
  //   (idle pill → pending spinner → loaded pill+rationale → error
  //   banner+pill).
  // `suggestErrorCode`: typed error sentinel separate from the
  //   message — used by the inline ErrorBanner to dispatch on
  //   affordance (try-again vs refresh vs none).
  // `userEditedAfterSuggest`: orthogonal flag (lives outside the
  //   discriminated union). Flips true on any manual selection /
  //   combination / annotation change while a suggestion is loaded.
  //   Used by the replace-warning gate to differentiate "AI's own
  //   output" from "user has invested manual effort on top of AI
  //   output".
  // `suggestRateLimited`: persists past `kind` transitions for the
  //   form session. Disables the in-form pill with a tooltip.
  //   Cleared only on form unmount.
  // `originalSuggestedIds`: snapshot of the most recent suggestion's
  //   `sourceFieldIds`. Used at save time for laundering prevention:
  //   `aiSuggested=true` is preserved only when at least one
  //   originally-suggested source survives in the final selection.
  //   Set by `applyLoadedSuggestion`; survives manual edits.
  // `whyExpanded`: controls the Why? collapsible. Default collapsed
  //   per locked §5-OQ-1.
  // `replaceWarningOpen`: controls the replace-AI-suggestion variant
  //   of `DiscardChangesDialog`. Distinct from `confirmDiscardOpen`
  //   which is the cancel-with-dirty-form path.
  const [suggestState, setSuggestState] = useState<SuggestState>({
    kind: 'idle',
  })
  const [userEditedAfterSuggest, setUserEditedAfterSuggest] = useState(false)
  const [suggestRateLimited, setSuggestRateLimited] = useState(false)
  const [originalSuggestedIds, setOriginalSuggestedIds] = useState<
    string[] | null
  >(null)
  const [whyExpanded, setWhyExpanded] = useState(false)
  const [replaceWarningOpen, setReplaceWarningOpen] = useState(false)

  // Latest in-flight AbortController (per locked §7-OQ-2: abort prior +
  // fire new). Distinct from the one inside `SuggestState.pending`
  // because we need a stable reference outside the discriminated union
  // for the unmount cleanup effect, and because race resolution must
  // abort even when the prior state was already replaced (e.g. fast
  // pending → loaded → pending sequence).
  const suggestAbortRef = useRef<AbortController | null>(null)

  // Pre-pending field snapshot for cancel restoration (Flow B per
  // locked §7-OQ-1). Single-level snapshot (overwritten on every new
  // invokeSuggest) per locked §3-OQ-1. Stored in a ref since it's
  // read once in the cancel path and doesn't drive any rendering.
  const prePendingSnapshotRef = useRef<PreSuggestSnapshot | null>(null)

  // Phase 4a-4b — see `tryConsumeAutoSuggest` prop docs. The
  // consumption guard lives in the parent so it survives the form's
  // strict-mode unmount/remount cycle in dev. No form-local guard is
  // needed (and would in fact be incorrect — a `useRef(false)` would
  // reset on the strict-mode remount and admit a second invocation).

  // `joinAnnotations` is preserved as state for two reasons:
  //   • Edit-mode hydration retains the existing TFM's join_spec
  //     entries so they survive a save round-trip without re-derivation.
  //   • The cancel-suggest path snapshots and restores it.
  // Cycle 1 removed the user-facing JoinDisambiguation surface; this
  // map is now an opaque pass-through into the wrapper. Block 2 of
  // Cycle 1 deleted the wrapper's FK precheck / join_spec persistence,
  // so the value is effectively a no-op server-side until Cycle 2
  // garbage-collects the parameter from the wrapper signature.
  const [joinAnnotations, setJoinAnnotations] = useState<
    Record<string, string>
  >(() =>
    isEditMode && editInitialState
      ? { ...editInitialState.joinAnnotations }
      : {},
  )

  // ── Derived: selected fields, dominant table, joined-table set ──
  const selectedFields = useMemo<SourceFieldWithState[]>(() => {
    const map = new Map<string, SourceFieldWithState>()
    for (const f of availableSourceFields) map.set(f.id, f)
    const out: SourceFieldWithState[] = []
    for (const id of selectedIds) {
      const f = map.get(id)
      if (f) out.push(f)
    }
    return out
  }, [selectedIds, availableSourceFields])

  const dominantTableId =
    selectedFields.length > 0 ? selectedFields[0].sourceTable.id : null
  const presentJoinedTableIds = useMemo<Set<string>>(() => {
    if (dominantTableId === null) return new Set()
    const out = new Set<string>()
    for (const f of selectedFields) {
      if (f.sourceTable.id !== dominantTableId) out.add(f.sourceTable.id)
    }
    return out
  }, [selectedFields, dominantTableId])

  // ── Cleanup effect (§4-OQ-3) ─────────────────────────────────
  // When chips for a joined table are all removed, silently drop that
  // table's entries from `joinAnnotations`. The map is now an opaque
  // wrapper-payload pass-through (Cycle 1 removed the user-facing
  // disambiguation surface), but stale entries pointing at removed
  // tables are still hygienically purged so the saved payload matches
  // the visible source set.
  useEffect(() => {
    setJoinAnnotations((prev) => {
      let changed = false
      const next: Record<string, string> = {}
      for (const k of Object.keys(prev)) {
        if (presentJoinedTableIds.has(k)) {
          next[k] = prev[k]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [presentJoinedTableIds])

  // ── Phase 4a-4a — restoreFormState mount-time hydration ─────────
  //
  // When a user undoes a row-switch-discard, `MappingContent` passes
  // the previously-captured snapshot back down through the drawer.
  // We apply it on mount (or on the first render where it becomes
  // non-null), then call `onRestoreConsumed` so the parent clears the
  // prop. The targetFieldId check is defense-in-depth — the drawer is
  // keyed by row identity so a mismatched snapshot is unreachable in
  // production paths, but defensive code beats a crash if a future
  // bug threads the wrong shape through.
  //
  // We track "applied" via a ref instead of state so re-renders during
  // the apply pass don't double-fire. The dependency on the snapshot
  // identity covers the case where the user invokes Undo a second
  // time within the same form mount (rare, but possible if they
  // somehow row-switch + undo in rapid succession before unmount).
  const restoreAppliedRef = useRef<CreateMappingFormSnapshot | null>(null)
  useEffect(() => {
    if (
      restoreFormState !== null &&
      restoreFormState !== undefined &&
      restoreFormState !== restoreAppliedRef.current &&
      restoreFormState.targetFieldId === targetField.id
    ) {
      restoreAppliedRef.current = restoreFormState
      setSelectedIds(restoreFormState.selectedIds)
      setJoinAnnotations({ ...restoreFormState.joinAnnotations })
      // Snapshot's `combinationType` field is informational only after
      // Cycle 1 — the form derives the effective combination from the
      // restored selection length, so there is no setter to call.
      onRestoreConsumed?.()
    }
  }, [restoreFormState, targetField.id, onRestoreConsumed])

  // ── Effective combination ───────────────────────────────────────
  //
  // Cycle 1 removed the combination radios. The effective value is
  // derived from `selectedIds.length` and (in edit mode) the original
  // TFM's `editInitialState.combinationType`:
  //
  //   • 1 source         → 'single' (single-source TFMs always store
  //                         'single' regardless of mode).
  //   • create + 0       → 'custom_sql' (VA path; this form is not
  //                         the surface that authors VA TFMs, but the
  //                         derivation defends against an empty save).
  //   • create + 2+      → DEFAULT_COMBINATION_TYPE ('concat_space').
  //   • edit + 0 or 2+   → preserve `editInitialState.combinationType`
  //                         so legacy 'concat_comma' TFMs survive an
  //                         edit unchanged.
  const effectiveCombinationType: CreateFieldMappingCombinationType | 'custom_sql' = (() => {
    if (selectedIds.length === 1) return 'single' as const
    if (isEditMode && editInitialState) {
      return editInitialState.combinationType
    }
    if (selectedIds.length === 0) return 'custom_sql' as const
    return DEFAULT_COMBINATION_TYPE
  })()

  // ── Derived flags ───────────────────────────────────────────────
  //
  // Phase 4b-1 — `isDirty` becomes mode-aware:
  //
  //   • create — dirty as soon as the user picks a single source.
  //     Matches the original 4a-2 semantics (an empty form is clean,
  //     a populated form is dirty).
  //   • edit   — dirty only when the current selection / join
  //     annotations differ from `editInitialState`. The user opening
  //     the drawer in edit mode and clicking Cancel without touching
  //     anything is NOT dirty (no confirm dialog). `combinationType`
  //     is derived from selection length, so a count-driven flip
  //     surfaces through the selection diff.
  //
  // Same flag drives the discard-confirm intercept and the Save-
  // button disabled state — saving a no-op edit is not allowed.
  const isDirty = useMemo(() => {
    if (!isEditMode) return selectedIds.length > 0
    if (!editInitialState) return selectedIds.length > 0
    if (selectedIds.length !== editInitialState.selectedIds.length) return true
    for (let i = 0; i < selectedIds.length; i++) {
      if (selectedIds[i] !== editInitialState.selectedIds[i]) return true
    }
    // Order-independent record comparison without `.sort()` — the
    // redesign path bans client-side sorting (server guarantees row
    // ordering). For two records to be equal, every key in either
    // direction must exist in the other AND map to the same value.
    const initEntries = Object.entries(editInitialState.joinAnnotations)
    const curEntries = Object.entries(joinAnnotations)
    if (initEntries.length !== curEntries.length) return true
    for (const [k, v] of initEntries) {
      if (joinAnnotations[k] !== v) return true
    }
    for (const [k, v] of curEntries) {
      if (editInitialState.joinAnnotations[k] !== v) return true
    }
    return false
  }, [
    isEditMode,
    editInitialState,
    selectedIds,
    joinAnnotations,
  ])

  // Phase 4b-1 — edit mode requires `isDirty` (no-op saves blocked at
  // UI level even though the wrapper short-circuits silently). Create
  // mode preserves the 4a-2 behavior (any selection is saveable).
  const canSave =
    selectedIds.length > 0 &&
    !isSavePending &&
    (!isEditMode || isDirty)

  // Phase 4a-4a — publish a snapshot whenever the form is dirty so
  // the drawer can lift it to `MappingContent` for row-switch undo.
  // `null` when clean. `combinationType` carried for parent compat;
  // it is informational only and re-derived from selection on restore.
  useEffect(() => {
    const snapshot: CreateMappingFormSnapshot | null = isDirty
      ? {
          targetFieldId: targetField.id,
          selectedIds: [...selectedIds],
          combinationType: effectiveCombinationType,
          joinAnnotations: { ...joinAnnotations },
        }
      : null
    onStateChange?.({ isDirty, canSave, isSavePending, snapshot })
  }, [
    isDirty,
    canSave,
    isSavePending,
    selectedIds,
    effectiveCombinationType,
    joinAnnotations,
    targetField.id,
    onStateChange,
  ])

  // ── Sample preview ──────────────────────────────────────────────
  const previewCombination: SamplePreviewCombinationType =
    effectiveCombinationType === 'custom_sql' ? 'single' : effectiveCombinationType
  const samplePreview = useMemo(
    () => computeSamplePreview(selectedFields, previewCombination),
    [selectedFields, previewCombination],
  )

  // ── Selection / combination handlers ─────────────────────────────
  const handleSelectedChange = (next: string[]) => {
    setSelectedIds(next)
    setUserEditedAfterSuggest(true)
    if (errorMessage !== null) {
      setErrorMessage(null)
      setErrorCode(null)
    }
    // Per locked §7-OQ-2 — selection change is the implicit "user is
    // back in the saddle" signal that clears any AI Suggest error
    // banner left over from a previous failed invocation. The pill's
    // RATE_LIMITED disabled state is the persistent affordance.
    if (suggestState.kind === 'error') {
      setSuggestState({ kind: 'idle' })
    }
  }

  // ── Phase 4a-4b — AI Suggest invocation ─────────────────────────
  //
  // `invokeSuggest` is the single entry point for both Flow A (auto-
  // trigger from Rule 6 footer) and Flow B (in-form pill click). It
  // handles race resolution (abort prior + fire new per locked
  // §7-OQ-2), captures the pre-pending snapshot for cancel restore,
  // and dispatches the wrapper result into either `applyLoadedSuggestion`
  // (success) or `setSuggestState({ kind: 'error', ... })` (failure).
  //
  // The wrapper does NOT accept an AbortSignal (server actions in
  // Next 14 don't propagate signals — see investigation §8 / locked
  // §7-OQ-2). The AbortController here is purely a CLIENT-SIDE
  // discard mechanism: the LLM call completes server-side regardless;
  // we ignore the late result via `signal.aborted` checks after the
  // await.
  const invokeSuggest = useCallback(async () => {
    // Race resolution — drop any prior pending controller before
    // arming a new one. Reads `current` + replaces in one step.
    suggestAbortRef.current?.abort()
    const controller = new AbortController()
    suggestAbortRef.current = controller

    // Capture pre-pending snapshot for cancel restoration. For Flow A
    // (mounted form, no prior selection), this snapshot is empty/idle —
    // restoring it on cancel yields a clean form ready for manual
    // entry, which is the correct Flow A cancel UX. For Flow B (in-
    // form pill click on top of a prior loaded/error/manual state),
    // the snapshot captures whatever the user had so cancel feels
    // like an undo.
    prePendingSnapshotRef.current = {
      selectedIds: [...selectedIds],
      joinAnnotations: { ...joinAnnotations },
      // Note: capture suggestState BEFORE we replace it below. This
      // is read-only access — we're not mutating the union variant.
      suggestState,
    }

    setSuggestState({ kind: 'pending', abortController: controller })
    // Clear any prior ErrorBanner content so the pending state shows
    // a clean "Suggesting..." surface. The createFieldMapping error
    // banner shares the same surface — clear it too.
    setErrorMessage(null)
    setErrorCode(null)

    try {
      const result = await suggestMappingForTarget({
        projectId,
        targetFieldId: targetField.id,
      })
      // Race guard: if the user cancelled (or fired a new suggest)
      // while we awaited, drop this result. The newer invocation
      // owns the suggestState now.
      if (controller.signal.aborted) return
      if (!result.success) {
        const render = SUGGEST_ERROR_COPY[result.errorCode]
        const msg =
          render.copy === 'verbatim' ? result.error : render.copy
        setSuggestState({
          kind: 'error',
          code: result.errorCode,
          message: msg,
        })
        if (result.errorCode === 'RATE_LIMITED') {
          setSuggestRateLimited(true)
        }
        if (typeof console !== 'undefined') {
          console.error(
            '[CreateMappingForm] suggestMappingForTarget failed:',
            result,
          )
        }
        return
      }
      applyLoadedSuggestion(result.suggestion)
    } catch (err) {
      // The server action threw — typically network failure. Wrap as
      // the NETWORK sentinel so the ErrorBanner gets the right copy +
      // affordance.
      if (controller.signal.aborted) return
      const networkRender = SUGGEST_ERROR_COPY.NETWORK
      setSuggestState({
        kind: 'error',
        code: 'NETWORK',
        message:
          networkRender.copy === 'verbatim'
            ? 'Network error'
            : networkRender.copy,
      })
      if (typeof console !== 'undefined') {
        console.error('[CreateMappingForm] suggestMappingForTarget threw:', err)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    projectId,
    targetField.id,
    selectedIds,
    joinAnnotations,
    suggestState,
  ])

  // ── Apply a loaded suggestion to the form ──────────────────────
  //
  // Pre-fill `selectedIds` from the wrapper's suggestion payload.
  // Two defenses applied here:
  //
  //   1. Filter `sourceFieldIds` against `availableSourceFields`. If a
  //      stale prop dropped some ids (rare — this prop comes from the
  //      same DB read that fed the wrapper, but a sub-second
  //      `router.refresh()` window could miss them), narrow silently.
  //      If the filter empties the list, surface as
  //      `AI_INVALID_RESPONSE` so the user retries (matches the
  //      wrapper's own zero-resolution branch).
  //
  //   2. Defensive `custom_sql` narrowing. The wrapper guarantees one
  //      of `'single' | 'concat_space' | 'concat_comma'`, but if a
  //      future drift lifts the narrowing we want a clear error rather
  //      than silently corrupting the form's persisted combination
  //      (the wrapper still receives `effectiveCombinationType`, which
  //      is derived from selection length, but a custom_sql suggestion
  //      indicates a behavior we do not yet author from this surface).
  //
  // On success: snapshot original suggested ids for laundering
  // prevention at save time, reset `userEditedAfterSuggest` to false,
  // and clear any error banner.
  function applyLoadedSuggestion(s: AISuggestion) {
    // Defense 2 — narrow against future custom_sql drift.
    if ((s.combinationType as string) === 'custom_sql') {
      setSuggestState({
        kind: 'error',
        code: 'AI_INVALID_RESPONSE',
        message:
          (SUGGEST_ERROR_COPY.AI_INVALID_RESPONSE.copy as string),
      })
      return
    }

    // Defense 1 — filter to ids actually present in availableSourceFields.
    const presentIds = new Set(availableSourceFields.map((f) => f.id))
    const validIds = s.sourceFieldIds.filter((id) => presentIds.has(id))
    if (validIds.length === 0) {
      setSuggestState({
        kind: 'error',
        code: 'AI_INVALID_RESPONSE',
        message:
          (SUGGEST_ERROR_COPY.AI_INVALID_RESPONSE.copy as string),
      })
      return
    }

    setSelectedIds(validIds)
    // Setting suggestState second so any consumer reading both fields
    // in the same render observes consistent {selectedIds, suggestion}.
    setSuggestState({
      kind: 'loaded',
      suggestion: { ...s, sourceFieldIds: validIds },
    })
    setOriginalSuggestedIds(validIds)
    setUserEditedAfterSuggest(false)
    // Clear the form-level createFieldMapping error too — fresh
    // suggestion supersedes any prior save attempt's complaint.
    setErrorMessage(null)
    setErrorCode(null)
    // Reset the Why? expansion so each new suggestion starts collapsed
    // (per §6 lean — each suggestion is a fresh thing the user should
    // re-engage with consciously).
    setWhyExpanded(false)
  }

  // ── Cancel suggest — Flow B snapshot restore ───────────────────
  //
  // Aborts the pending controller and restores the pre-pending field
  // snapshot. For Flow A the snapshot is empty/idle — cancel yields a
  // clean form. For Flow B the snapshot captures whatever the user
  // had (manual selection, prior loaded suggestion, etc.) — cancel
  // feels like an undo.
  const cancelSuggest = useCallback(() => {
    if (suggestState.kind !== 'pending') return
    suggestState.abortController.abort()
    suggestAbortRef.current = null
    const snap = prePendingSnapshotRef.current
    if (snap) {
      setSelectedIds(snap.selectedIds)
      setJoinAnnotations(snap.joinAnnotations)
      setSuggestState(snap.suggestState)
    } else {
      setSuggestState({ kind: 'idle' })
    }
  }, [suggestState])

  // ── Replace-warning gate ───────────────────────────────────────
  //
  // Determines whether a new Suggest invocation should pop the
  // replace-AI variant of DiscardChangesDialog before firing.
  //
  // Rule (per investigation §3):
  //   • Empty form (no selection) → no warning, just invoke.
  //   • Loaded suggestion + user has not edited → silent replace.
  //   • Anything else with a selection → warn (user has invested
  //     manual effort that the new suggestion would overwrite).
  function shouldShowReplaceWarning(): boolean {
    if (selectedIds.length === 0) return false
    if (suggestState.kind === 'loaded' && !userEditedAfterSuggest) {
      return false
    }
    return true
  }

  // Public-ish entry point used by the in-form pill click. The Rule 6
  // footer's [Suggest with AI] click flips `autoSuggest=true` AND
  // mounts an empty form, so it bypasses the gate (handled by the
  // mount-time effect calling `invokeSuggest` directly).
  const requestSuggest = useCallback(() => {
    if (suggestRateLimited) return
    if (suggestState.kind === 'pending') return
    if (isSavePending) return
    if (shouldShowReplaceWarning()) {
      setReplaceWarningOpen(true)
      return
    }
    void invokeSuggest()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    suggestRateLimited,
    suggestState,
    isSavePending,
    selectedIds,
    userEditedAfterSuggest,
    invokeSuggest,
  ])

  const handleConfirmReplace = () => {
    setReplaceWarningOpen(false)
    void invokeSuggest()
  }

  const handleKeepEditingReplace = () => {
    setReplaceWarningOpen(false)
  }

  // ── Mount-time autoSuggest one-shot ─────────────────────────────
  //
  // Flow A — when the user clicks [Suggest with AI] from the Rule 6
  // footer, the drawer flips both `isFormActive=true` and
  // `autoSuggest=true`. The form mounts; this effect sees `autoSuggest`
  // and fires `invokeSuggest` immediately, then calls
  // `onAutoSuggestConsumed` so the parent clears the prop before any
  // re-render that could re-fire.
  //
  // The consumption guard is parent-owned via `tryConsumeAutoSuggest`
  // (see prop docs). A parent-owned guard survives the form's strict-
  // mode unmount/remount cycle in Next.js dev (`reactStrictMode: true`
  // by default for app router); a `useRef(false)` *inside* the form
  // would reset on the second mount and admit a duplicate invocation,
  // resulting in two server-side LLM calls per click.
  //
  // `tryConsumeAutoSuggest` is optional: when absent (some unit tests),
  // the effect fires unconditionally. Production always passes it.
  useEffect(() => {
    if (!autoSuggest) return
    // Phase 4b-1 — defense in depth. Edit mode hides the [Suggest with
    // AI] surface so the parent should never set `autoSuggest=true`,
    // but a future regression that does should be a no-op rather than
    // a stray LLM call against a TFM the user is already editing.
    if (isEditMode) return
    if (tryConsumeAutoSuggest && !tryConsumeAutoSuggest(targetField.id)) {
      return
    }
    void invokeSuggest()
    onAutoSuggestConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSuggest])

  // ── Cleanup on unmount ─────────────────────────────────────────
  //
  // Abort any in-flight controller so the post-await `setSuggestState`
  // calls don't fire setState-on-unmounted warnings. The signal.aborted
  // checks already guard the state writes, but aborting here also
  // releases any HTTP keep-alive on the underlying request (Next 14
  // server actions are HTTP fetch underneath).
  useEffect(() => {
    return () => {
      suggestAbortRef.current?.abort()
    }
  }, [])

  // Publish suggest-pending state to the drawer for footer mode-switch.
  useEffect(() => {
    onSuggestStateChange?.({
      isSuggestPending: suggestState.kind === 'pending',
    })
  }, [suggestState, onSuggestStateChange])

  // ── Save flow ───────────────────────────────────────────────────
  const handleSave = () => {
    if (selectedIds.length === 0 || isSavePending) return
    if (suggestState.kind === 'pending') return
    if (isEditMode && !isDirty) return
    setErrorMessage(null)
    setErrorCode(null)

    if (isEditMode) {
      handleEditSave()
      return
    }

    // ── Phase 4a-4b — AI provenance with laundering correction ──
    //
    // `aiSuggested=true` only when:
    //   (a) we have a snapshot of original suggested ids (form has
    //       seen at least one successful suggest), AND
    //   (b) at least one of those original ids is still in the
    //       final selectedIds (user kept some AI signal).
    //
    // This prevents the "user removes all AI sources, picks unrelated
    // ones, saves with ai_suggested=true" laundering risk identified
    // in the structural-finding correction. Removing every AI source
    // and replacing with manual picks → manual provenance.
    //
    // confidence + aiReasoning ride on the same gate — they describe
    // the AI signal the user ultimately accepted. If they removed all
    // of it, those values are lies and we drop them.
    const stillHasOriginal =
      originalSuggestedIds !== null &&
      originalSuggestedIds.some((id) => selectedIds.includes(id))
    const aiSuggested =
      stillHasOriginal && suggestState.kind === 'loaded' ? true : undefined
    const confidence =
      stillHasOriginal && suggestState.kind === 'loaded'
        ? suggestState.suggestion.confidence
        : undefined
    const aiReasoning =
      stillHasOriginal && suggestState.kind === 'loaded'
        ? suggestState.suggestion.rationale
        : undefined

    startSaveTransition(async () => {
      try {
        const result = await createFieldMapping({
          projectId,
          targetFieldId: targetField.id,
          sourceFieldIds: selectedIds,
          combinationType: effectiveCombinationType,
          joinAnnotations,
          aiSuggested,
          confidence,
          aiReasoning,
        })
        if (!result.success) {
          // EXISTING_TFM is a special VALIDATION case — the wrapper
          // returns errorCode='VALIDATION' with a stable phrase baked
          // into `error`. Sniff for the canonical phrase to surface
          // the inline [Refresh] affordance.
          const isExistingTfm =
            result.errorCode === 'VALIDATION' &&
            typeof result.error === 'string' &&
            result.error.toLowerCase().includes('mapped while you were editing')
          setErrorCode(result.errorCode)
          setErrorMessage(
            isExistingTfm
              ? EXISTING_TFM_COPY
              : ERROR_CODE_COPY[result.errorCode] ?? ERROR_CODE_COPY.INTERNAL,
          )
          if (typeof console !== 'undefined') {
            console.error(
              '[CreateMappingForm] createFieldMapping failed:',
              result,
            )
          }
          return
        }
        onSaveSuccess(result.tfmId)
      } catch (err) {
        setErrorCode('INTERNAL')
        setErrorMessage(ERROR_CODE_COPY.INTERNAL)
        if (typeof console !== 'undefined') {
          console.error('[CreateMappingForm] createFieldMapping threw:', err)
        }
      }
    })
  }

  // ── Phase 4b-1 — edit-mode save flow ─────────────────────────────
  //
  // Routes `selectedIds` / `effectiveCombinationType` / `joinAnnotations`
  // into `editMappingSources`. Mirrors `handleSave`'s try/catch and
  // error-dispatch shape, but with the edit-specific error code map
  // and result fields (`tfmId` is unchanged, `transformReset` /
  // `stagedRowsReverted` / `nextStatus` carry post-save UX signal).
  //
  // TFM_NOT_FOUND / TFM_REJECTED / TFM_ACKNOWLEDGED all surface the
  // [Refresh] affordance — the page state is stale and re-deriving
  // server-side is the only correct recovery.
  const handleEditSave = () => {
    if (!editInitialState) return

    // Phase 4b-1 — provenance laundering happens entirely server-side
    // inside `editMappingSources`. The wrapper reads the existing
    // `mapping_sources.ai_reasoning` rows and decides whether to
    // preserve `ai_suggested` / `ai_reasoning` based on whether ANY
    // surviving row carries non-null AI provenance (founder §1.f).
    // The form sends only the source set + combination + join
    // annotations; no provenance flags ride the wire.

    startSaveTransition(async () => {
      try {
        const result = await editMappingSources({
          tfmId: editInitialState.tfmId,
          sourceFieldIds: selectedIds,
          combinationType: effectiveCombinationType,
          joinAnnotations,
        })
        if (!result.success) {
          setErrorCode(result.errorCode)
          setErrorMessage(
            EDIT_ERROR_CODE_COPY[result.errorCode] ??
              EDIT_ERROR_CODE_COPY.INTERNAL,
          )
          if (typeof console !== 'undefined') {
            console.error(
              '[CreateMappingForm] editMappingSources failed:',
              result,
            )
          }
          return
        }
        // The wrapper always sets `status='needs_review'` on a
        // sources/combination change (founder §3.2). Bake that as a
        // literal here — the wrapper's success result doesn't carry
        // status because there is no other branch.
        onSaveSuccess(result.tfmId, {
          mode: 'edit',
          tfmId: result.tfmId,
          transformReset: result.transformReset,
          stagedRowsReverted: result.stagedRowsReverted,
          nextStatus: 'needs_review',
        })
      } catch (err) {
        setErrorCode('INTERNAL')
        setErrorMessage(EDIT_ERROR_CODE_COPY.INTERNAL)
        if (typeof console !== 'undefined') {
          console.error('[CreateMappingForm] editMappingSources threw:', err)
        }
      }
    })
  }

  const handleRefreshOnExistingTfm = () => {
    router.refresh()
    onCancel()
  }

  // ── Close routing — dirty → confirm dialog; clean → immediate ───
  const requestClose = () => {
    if (isDirty) {
      setConfirmDiscardOpen(true)
    } else {
      onCancel()
    }
  }

  const handleDialogKeepEditing = () => {
    setConfirmDiscardOpen(false)
  }

  const handleDialogDiscard = () => {
    setConfirmDiscardOpen(false)
    onCancel()
  }

  useImperativeHandle(
    ref,
    () => ({
      triggerSave: handleSave,
      requestClose,
      cancelSuggest,
    }),
    // intentionally re-create the handle on each render — closures
    // over `selectedIds`/`isSavePending`/`isDirty` need to be fresh.
  )

  // ── Derived UI flags ────────────────────────────────────────────
  const isSuggestPending = suggestState.kind === 'pending'
  const fieldsDisabled =
    isSavePending ||
    confirmDiscardOpen ||
    isSuggestPending ||
    replaceWarningOpen
  // Phase 4b-1 — the [Refresh] affordance fires on:
  //   • create mode existing-tfm collision (errorCode VALIDATION +
  //     EXISTING_TFM_COPY message), AND
  //   • edit mode TFM_NOT_FOUND / TFM_REJECTED / TFM_ACKNOWLEDGED
  //     (server-side state was concurrently mutated; refresh is the
  //     only recovery).
  const isExistingTfmError =
    (errorMessage === EXISTING_TFM_COPY && errorCode === 'VALIDATION') ||
    (isEditMode &&
      errorCode !== null &&
      EDIT_REFRESH_AFFORDANCE_CODES.has(errorCode as EditMappingErrorCode))

  // ── AI Suggest section render bits ─────────────────────────────
  //
  // Three render branches drive the AI Suggest top-row:
  //   • idle   → [Suggest with AI] pill button (or rate-limited dim
  //              variant if `suggestRateLimited`).
  //   • pending → spinner + "Suggesting…" inline label.
  //   • loaded → ConfidencePill + Why? toggle.
  //   • error  → ErrorBanner only (the dim pill below stays usable per
  //              try-again affordance, except for RATE_LIMITED).
  //
  // Per locked §6-OQ-2, the Why? toggle is hidden entirely when
  // rationale is empty (rare — wrapper enforces ≤ 280 chars but does
  // not enforce non-empty).
  // Phase 4b-1 — AI Suggest is hidden in edit mode (founder decision
  // §1 — defer to 4-extras). The form's other affordances (picker,
  // sample preview) work identically across both modes; AI Suggest is
  // the one surface that doesn't have a defined edit-mode UX yet.
  const showAISuggestRow =
    !isEditMode &&
    (suggestState.kind === 'idle' ||
      suggestState.kind === 'pending' ||
      suggestState.kind === 'loaded' ||
      suggestState.kind === 'error')

  // Suggest error banner content. Distinct from the form-save error
  // banner (which renders separately at the top). The fallback
  // affordance for AI errors is "Try again" → re-invokeSuggest.
  let aiBanner: { message: string; affordance: SuggestErrorAffordance } | null = null
  if (suggestState.kind === 'error') {
    aiBanner = {
      message: suggestState.message,
      affordance: SUGGEST_ERROR_COPY[suggestState.code].affordance,
    }
  }

  return (
    <div data-testid="create-mapping-form" className="flex flex-col gap-3">
      {errorMessage ? (
        <ErrorBanner
          message={errorMessage}
          actionLabel={isExistingTfmError ? 'Refresh' : null}
          onAction={isExistingTfmError ? handleRefreshOnExistingTfm : null}
          testId="create-mapping-form-error"
          actionTestId="create-mapping-form-refresh"
        />
      ) : null}

      {aiBanner ? (
        <ErrorBanner
          message={aiBanner.message}
          actionLabel={aiBanner.affordance === 'try-again' ? 'Try again' : aiBanner.affordance === 'refresh' ? 'Refresh' : null}
          onAction={
            aiBanner.affordance === 'try-again'
              ? () => void invokeSuggest()
              : aiBanner.affordance === 'refresh'
                ? handleRefreshOnExistingTfm
                : null
          }
          testId="create-mapping-form-suggest-error"
          actionTestId="create-mapping-form-suggest-error-action"
        />
      ) : null}

      {showAISuggestRow ? (
        <AISuggestSection
          suggestState={suggestState}
          rateLimited={suggestRateLimited}
          isSavePending={isSavePending}
          whyExpanded={whyExpanded}
          onToggleWhy={() => setWhyExpanded((v) => !v)}
          onRequestSuggest={requestSuggest}
          onCancelSuggest={cancelSuggest}
          whyPanelDomId={whyPanelDomId}
        />
      ) : null}

      <SourceFieldPicker
        availableSourceFields={availableSourceFields}
        selectedIds={selectedIds}
        onSelectedChange={handleSelectedChange}
        disabled={fieldsDisabled}
      />

      <SamplePreview preview={samplePreview} />

      <DiscardChangesDialog
        variant="discard"
        targetFieldName={targetField.name}
        open={confirmDiscardOpen}
        onKeepEditing={handleDialogKeepEditing}
        onConfirm={handleDialogDiscard}
      />

      <DiscardChangesDialog
        variant="replace-ai"
        targetFieldName={targetField.name}
        open={replaceWarningOpen}
        onKeepEditing={handleKeepEditingReplace}
        onConfirm={handleConfirmReplace}
      />
    </div>
  )
})

// ── Error banner ─────────────────────────────────────────────────────────────
//
// Phase 4a-4b: generalized from the 4a-2 fixed-affordance shape
// (`showRefreshButton` boolean → static "Refresh" copy) to a parameterized
// `actionLabel` + `onAction` pair. Two consumers:
//
//   • Form-save errors: actionLabel='Refresh' for EXISTING_TFM,
//     actionLabel=null otherwise. Test ids unchanged
//     (create-mapping-form-error, create-mapping-form-refresh).
//
//   • AI Suggest errors: actionLabel='Try again' for retryable codes
//     (AI_INVALID_RESPONSE, INTERNAL, NETWORK), 'Refresh' for NOT_FOUND,
//     null for non-retryable (PERMISSION_DENIED, RATE_LIMITED). Test
//     ids: create-mapping-form-suggest-error,
//     create-mapping-form-suggest-error-action.
//
// `testId` and `actionTestId` are required so each consumer's tests
// stay non-overlapping (vs a single shared id that would let tests
// accidentally bind to the wrong banner).

function ErrorBanner({
  message,
  actionLabel,
  onAction,
  testId,
  actionTestId,
}: {
  message: string
  actionLabel: string | null
  onAction: (() => void) | null
  testId: string
  actionTestId: string
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={cn(
        'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800',
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500"
      />
      <div className="flex flex-1 items-center justify-between gap-2">
        <span className="leading-snug">{message}</span>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            data-testid={actionTestId}
            className={cn(
              'inline-flex h-6 items-center justify-center rounded border px-2 text-[11px] font-medium',
              'border-red-300 bg-white text-red-800 hover:bg-red-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40',
            )}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ── AI Suggest section (Phase 4a-4b) ────────────────────────────────────────
//
// Top-of-form row that surfaces the AI Suggest lifecycle. Visible whenever
// the form is mounted (idle/pending/loaded/error) — never hidden, since the
// pill is the discoverability surface for AI suggestions even before the
// user invokes one. Three visual variants:
//
//   • idle  / error → [✨ Suggest with AI] action pill. Disabled with a
//                     tooltip when `rateLimited` (locked §7c) or while a
//                     save is pending (locked §10-OQ-1).
//
//   • pending       → Spinner + "Suggesting…" inline label. The cancel
//                     affordance lives in the drawer footer
//                     ([Cancel suggestion]) per locked §10-OQ-2 — this
//                     row stays minimal to avoid two cancel buttons.
//
//   • loaded        → `ConfidencePill` (color-banded, label includes
//                     percentage) + Why? toggle that expands the
//                     `WhyPanel` with the rationale. Toggle hidden
//                     when rationale empty (locked §6-OQ-2).

function AISuggestSection({
  suggestState,
  rateLimited,
  isSavePending,
  whyExpanded,
  onToggleWhy,
  onRequestSuggest,
  onCancelSuggest,
  whyPanelDomId,
}: {
  suggestState: SuggestState
  rateLimited: boolean
  isSavePending: boolean
  whyExpanded: boolean
  onToggleWhy: () => void
  onRequestSuggest: () => void
  onCancelSuggest: () => void
  whyPanelDomId: string
}) {
  void onCancelSuggest // imperative cancel lives in drawer footer; reserved.
  if (suggestState.kind === 'pending') {
    return (
      <div
        data-testid="create-mapping-form-suggest-pending"
        className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-900"
      >
        <Loader2
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin"
        />
        <span>Suggesting…</span>
      </div>
    )
  }
  if (suggestState.kind === 'loaded') {
    const { suggestion } = suggestState
    const hasRationale = suggestion.rationale.trim().length > 0
    return (
      <div
        data-testid="create-mapping-form-suggest-loaded"
        className="flex flex-col gap-1.5 rounded border border-slate-200 bg-slate-50 px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <ConfidencePill confidence={suggestion.confidence} />
          {hasRationale ? (
            <WhyToggle
              expanded={whyExpanded}
              onToggle={onToggleWhy}
              panelId={whyPanelDomId}
            />
          ) : null}
          <button
            type="button"
            onClick={onRequestSuggest}
            disabled={rateLimited || isSavePending}
            data-testid="create-mapping-form-suggest-replace-button"
            title={
              rateLimited
                ? 'AI Suggest is rate-limited; try again later.'
                : isSavePending
                  ? 'Save in progress.'
                  : undefined
            }
            className={cn(
              'ml-auto inline-flex h-6 items-center gap-1 rounded border px-1.5 text-[11px] font-medium',
              'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30',
              'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
            )}
          >
            <Sparkles aria-hidden="true" className="h-3 w-3" />
            <span>Re-suggest</span>
          </button>
        </div>
        {hasRationale ? (
          <WhyPanel
            rationale={suggestion.rationale}
            expanded={whyExpanded}
            panelId={whyPanelDomId}
          />
        ) : null}
      </div>
    )
  }
  // idle or error — render the action pill. RATE_LIMITED disables the
  // pill (locked §7c persistent affordance). Save-pending also disables
  // (§10-OQ-1).
  const disabled = rateLimited || isSavePending
  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={onRequestSuggest}
        disabled={disabled}
        data-testid="create-mapping-form-suggest-button"
        aria-label="Suggest with AI"
        title={
          rateLimited
            ? 'AI Suggest is rate-limited; try again later.'
            : isSavePending
              ? 'Save in progress.'
              : undefined
        }
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
          'border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
          'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
        )}
      >
        <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
        <span>Suggest with AI</span>
      </button>
    </div>
  )
}

// ── ConfidencePill ──────────────────────────────────────────────────────────
//
// Color-banded confidence badge, only consumer of `classifyConfidence`
// thresholds. Three bands (green ≥70 / amber 40-69 / red <40) per
// locked §5/§6 visual contract.
//
// A11y: plain `<span>` per locked §5-OQ-1 (no role attribute — the
// surrounding `Suggested:` context is a sibling, not container, and
// adding a role would be ARIA noise). The `title` attribute carries
// the same label text on hover for sighted users on small viewports.

function ConfidencePill({ confidence }: { confidence: number }) {
  const { label, threshold } = formatConfidenceLabel(confidence)
  const palette =
    threshold === 'high'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
      : threshold === 'possible'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-red-200 bg-red-50 text-red-800'
  const dotColor =
    threshold === 'high'
      ? 'bg-emerald-500'
      : threshold === 'possible'
        ? 'bg-amber-500'
        : 'bg-red-500'
  return (
    <span
      data-testid="create-mapping-form-confidence-pill"
      data-threshold={threshold}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium',
        palette,
      )}
      title={label}
    >
      <span
        aria-hidden="true"
        className={cn('inline-block h-1.5 w-1.5 rounded-full', dotColor)}
      />
      <Sparkles aria-hidden="true" className="h-3 w-3" />
      <span>{label}</span>
    </span>
  )
}

// ── Why? toggle + panel ─────────────────────────────────────────────────────
//
// Toggle is a chevron + "Why?" text. Panel is the rationale plain text
// rendered below. Both colocated here to keep the AI Suggest visual
// surface in one file. Per locked §6-OQ-1 the rationale is plain-text
// rendered via `{rationale}` only — no markdown, no HTML.

function WhyToggle({
  expanded,
  onToggle,
  panelId,
}: {
  expanded: boolean
  onToggle: () => void
  panelId: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={panelId}
      data-testid="create-mapping-form-why-toggle"
      className={cn(
        'inline-flex h-6 items-center gap-0.5 rounded px-1.5 text-[11px] font-medium',
        'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30',
      )}
    >
      {expanded ? (
        <ChevronDown aria-hidden="true" className="h-3 w-3" />
      ) : (
        <ChevronRight aria-hidden="true" className="h-3 w-3" />
      )}
      <span>Why?</span>
    </button>
  )
}

function WhyPanel({
  rationale,
  expanded,
  panelId,
}: {
  rationale: string
  expanded: boolean
  panelId: string
}) {
  if (!expanded) return null
  return (
    <p
      id={panelId}
      data-testid="create-mapping-form-why-panel"
      className="text-[11px] leading-snug text-slate-700"
    >
      {rationale}
    </p>
  )
}

// ── Sample preview ───────────────────────────────────────────────────────────

function SamplePreview({
  preview,
}: {
  preview: { preview: string[]; overflow: number }
}) {
  return (
    <div
      data-testid="create-mapping-form-preview"
      className="rounded border border-slate-200 px-3 py-2"
    >
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        Sample preview
      </div>
      {preview.preview.length === 0 ? (
        <p
          data-testid="create-mapping-form-preview-empty"
          className="text-[11px] italic text-slate-400"
        >
          No sample values available
        </p>
      ) : (
        <ul
          data-testid="create-mapping-form-preview-list"
          className="space-y-0.5"
        >
          {preview.preview.map((row, idx) => (
            <li
              key={idx}
              data-testid="create-mapping-form-preview-row"
              className="truncate font-mono text-[11px] text-slate-700"
              title={row}
            >
              {row}
            </li>
          ))}
          {preview.overflow > 0 ? (
            <li
              data-testid="create-mapping-form-preview-overflow"
              className="text-[11px] italic text-slate-400"
            >
              + {preview.overflow} more
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

// DiscardChangesDialog extracted to ./DiscardChangesDialog.tsx in Phase 4b-1
// (shared with the edit-mapping flow on the drawer footer Cancel path).
