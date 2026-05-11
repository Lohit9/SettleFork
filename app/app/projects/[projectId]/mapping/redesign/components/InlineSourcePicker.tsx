'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { SourceFieldPicker } from './SourceFieldPicker'

// ─────────────────────────────────────────────────────────────────────────────
// InlineSourcePicker — Phase 4-polish-3 Block A + Phase A (post-Phase-3) refit.
// ─────────────────────────────────────────────────────────────────────────────
//
// Portal-anchored wrapper around `SourceFieldPicker` that powers the inline
// "click source cell → swap sources" affordance on the mapping page list view.
// Founder-locked decisions:
//
//   1. Wrap the existing `SourceFieldPicker` (which already provides multi-
//      select, search, group rendering, per-field tooltips, and the
//      DOMINANT/JOINED chip strip) — DO NOT extend the legacy
//      `components/app/FieldPicker.tsx`. Reusing the redesign primitive
//      keeps the inline picker visually + behaviourally identical to the
//      drawer's `CreateMappingForm` source picker.
//
//   2. Explicit Save / Cancel footer (Phase A — replaces the original
//      polish-3 commit-on-close model). The picker tracks pending
//      selection internally; commit fires ONLY when the user clicks
//      Save and the selection has actually changed. Esc, click-outside,
//      and the Cancel button all close the picker without committing —
//      no implicit save. The Save button is disabled when there are
//      zero pending changes OR zero selected sources.
//
//   3. Async-aware Save. `onCommit` returns `Promise<{ success: boolean }>`
//      so the picker can show a spinner during the wrapper call and
//      decide whether to close on the result. On success → close. On
//      error → stay open; the parent surfaces a toast as before. During
//      the in-flight save Cancel is disabled and Esc / click-outside
//      are ignored — prevents the user from racing the wrapper.
//
//   4. No "delete via empty selection" path. The dedicated reject (✗)
//      row button is the canonical "remove this mapping" affordance —
//      the picker's empty selection just disables Save with a tooltip.
//      Cancel is always available even with empty selection so the
//      user can back out cleanly.
//
// Positioning: the picker portals to `document.body` and anchors itself to
// the source-cell trigger via `getBoundingClientRect`. We mirror the
// `components/app/FieldPicker.tsx` portal pattern (recompute on resize +
// scroll-capture; flip vertically when there is no room below) so the
// picker stays glued to the cell across viewport changes.
//
// Width: anchored at 22rem minimum to comfortably host the chip strip +
// search + grouped list. The chip strip stays visible (default per the
// founder decision); if a future canary review surfaces layout pressure,
// hiding the chip strip in inline mode is a one-line change here.

const PICKER_MIN_WIDTH_PX = 352 // 22rem
const PICKER_MAX_HEIGHT_PX = 420
const VIEWPORT_MARGIN_PX = 8

/**
 * Result the parent's `onCommit` handler returns after the wrapper call.
 *
 * `success: true`  → picker closes; parent surfaces the success toast.
 * `success: false` → picker stays open with the user's pending edit
 *                    intact; parent surfaces the error toast.
 *
 * Defined here (not on the parent) so the picker's contract is explicit
 * and the test harness can pin it. Mirrors the pattern used by
 * `MappingDrawer`'s save flow.
 */
export interface InlineSourceCommitResult {
  success: boolean
}

export interface InlineSourcePickerProps {
  /** Anchor element ref — the source-cell trigger button. */
  anchorRef: React.RefObject<HTMLElement | null>
  /**
   * Initial selection (the row's current `sources[].sourceField.id`
   * list, in `sources` order). The picker tracks pending state
   * internally; this is consulted ONLY at mount so re-renders from
   * the parent do not clobber an in-flight edit.
   */
  initialSourceFieldIds: string[]
  /** Page-level source fields (`MappingsForRedesignResult.sourceFields`). */
  availableSourceFields: SourceFieldWithState[]
  /**
   * Fired when the user clicks Save with a non-empty pending selection
   * that differs from the initial set. Returns a result that drives
   * whether the picker closes (success) or stays open (error). The
   * parent is responsible for dispatching `createFieldMapping` /
   * `editMappingSources` and surfacing post-save toasts.
   */
  onCommit: (
    finalSourceFieldIds: string[],
  ) => Promise<InlineSourceCommitResult>
  /**
   * Fired when the user closes the picker via Cancel, Esc, click-outside,
   * or a successful Save. Allows the parent to clear `pickerOpenRowId`
   * and unmount this component.
   */
  onClose: () => void
  /**
   * Selection mode (added for the Mapping list view's cell-level
   * editing affordance). 'multi' (default) preserves the target-led
   * chip-strip + Save/Cancel UX byte-identical. 'single' tightens to
   * one selection at a time; only meaningful in combination with
   * `autoCommit: true`.
   */
  mode?: 'single' | 'multi'
  /**
   * When true (only valid with `mode: 'single'`), the picker fires
   * `onCommit` on the user's first row click and closes on success —
   * no chip strip, no Save / Cancel footer. The flat list view uses
   * this for cell-level source swaps. Default false.
   */
  autoCommit?: boolean
}

export function InlineSourcePicker({
  anchorRef,
  initialSourceFieldIds,
  availableSourceFields,
  onCommit,
  onClose,
  mode = 'multi',
  autoCommit = false,
}: InlineSourcePickerProps) {
  // Flat-view single-pick-auto-commit branch. Activates ONLY when
  // mode === 'single' AND autoCommit === true; every other prop
  // combination falls through to the existing target-led multi-pick
  // UX byte-identical.
  const isSingleAutoCommit = mode === 'single' && autoCommit
  // Snapshot the initial set ONCE so the diff at Save time is stable
  // even if the parent re-renders with a fresh `initialSourceFieldIds`
  // array reference for the same logical value.
  const initialSetRef = useRef<Set<string>>(
    new Set(initialSourceFieldIds),
  )
  const [pendingIds, setPendingIds] = useState<string[]>(
    () => [...initialSourceFieldIds],
  )
  const [isSaving, setIsSaving] = useState(false)

  // Defer the portal mount until after first render so SSR-safe (the
  // server has no `document.body`).
  const [isMounted, setIsMounted] = useState(false)
  useEffect(() => {
    setIsMounted(true)
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)

  // Position the popover relative to the anchor. Recompute on resize +
  // scroll (capture phase so we catch scrolls inside any ancestor
  // scroll container, e.g. the body's `overflow-auto` wrapper).
  useEffect(() => {
    function computePosition() {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      const width = Math.max(rect.width, PICKER_MIN_WIDTH_PX)
      const spaceBelow = viewportHeight - rect.bottom
      const spaceAbove = rect.top
      const top =
        spaceBelow >= PICKER_MAX_HEIGHT_PX || spaceBelow >= spaceAbove
          ? rect.bottom + 4
          : Math.max(VIEWPORT_MARGIN_PX, rect.top - PICKER_MAX_HEIGHT_PX - 4)
      const left = Math.max(
        VIEWPORT_MARGIN_PX,
        Math.min(rect.left, viewportWidth - width - VIEWPORT_MARGIN_PX),
      )
      setPosition({ top, left, width })
    }
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [anchorRef])

  // ── Pending-changes computation ─────────────────────────────────────
  //
  // Symmetric difference between the initial set (snapshot at mount) and
  // the current pending list. Counts both additions AND removals as
  // changes — drives the Save button copy ("Save (N changes)") and the
  // Save-disabled-when-clean state.
  const changeCount = useMemo(() => {
    const initial = initialSetRef.current
    const pendingSet = new Set(pendingIds)
    let count = 0
    for (const id of pendingIds) if (!initial.has(id)) count++
    for (const id of initial) if (!pendingSet.has(id)) count++
    return count
  }, [pendingIds])

  const hasPendingChanges = changeCount > 0
  const hasSelection = pendingIds.length > 0
  const canSave = hasPendingChanges && hasSelection && !isSaving

  // Save: validate → fire onCommit (await) → close on success, stay
  // open on error. The parent owns the toast for both branches.
  //
  // Order matters at the success branch: we clear `isSaving` BEFORE
  // calling `onClose`. In production the parent unmounts the picker
  // immediately on `onClose`, so the state-update is moot. But if a
  // future parent keeps the picker mounted across the close (e.g. a
  // keep-open variant), the button must not stay stuck on the
  // spinner state. Defence-in-depth.
  const handleSave = useCallback(async () => {
    if (!hasPendingChanges || !hasSelection || isSaving) return
    setIsSaving(true)
    let result: InlineSourceCommitResult
    try {
      result = await onCommit(pendingIds)
    } catch {
      // Parent's onCommit shouldn't throw (it returns a result), but
      // belt-and-suspenders: treat throws as failures. The user keeps
      // their pending edit and can retry.
      setIsSaving(false)
      return
    }
    if (result.success) {
      setIsSaving(false)
      onClose()
      return
    }
    setIsSaving(false)
  }, [hasPendingChanges, hasSelection, isSaving, onCommit, pendingIds, onClose])

  // Cancel: close without committing. Always allowed (even with empty
  // selection) so users can back out of an accidental clear. Disabled
  // only during an in-flight save to prevent racing the wrapper.
  const handleCancel = useCallback(() => {
    if (isSaving) return
    onClose()
  }, [isSaving, onClose])

  // Click-outside (mousedown) → cancel. Use mousedown rather than click
  // so the picker dismisses BEFORE any outside button-click handler
  // fires (matching the FieldPicker primitive). Ignored during an
  // in-flight save.
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (isSaving) return
      const target = e.target as Node | null
      if (target === null) return
      if (containerRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      handleCancel()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [handleCancel, anchorRef, isSaving])

  // Esc → cancel. Same in-flight guard as click-outside.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (isSaving) return
      e.preventDefault()
      handleCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleCancel, isSaving])

  const handleSelectedChange = useCallback(
    (next: string[]) => {
      if (!isSingleAutoCommit) {
        setPendingIds(next)
        return
      }
      // Single autoCommit branch: detect the newly added id and fire
      // onCommit immediately. The inner SourceFieldPicker emits the
      // full next list (selection + toggle), so the newly added id is
      // any element in `next` that wasn't in `pendingIds`. Removal
      // toggles (clicking an already-selected row) are a no-op in
      // this mode — there is no "deselect" affordance for a cell
      // swap, and the dedicated reject button covers row deletion.
      const previous = new Set(pendingIds)
      const newlyAdded = next.find((id) => !previous.has(id))
      if (newlyAdded === undefined) return
      if (isSaving) return
      setIsSaving(true)
      setPendingIds([newlyAdded])
      void (async () => {
        let result: InlineSourceCommitResult
        try {
          result = await onCommit([newlyAdded])
        } catch {
          setIsSaving(false)
          return
        }
        if (result.success) {
          setIsSaving(false)
          onClose()
          return
        }
        setIsSaving(false)
      })()
    },
    [isSingleAutoCommit, pendingIds, isSaving, onCommit, onClose],
  )

  // Memoise the field map for the picker body. (SourceFieldPicker
  // already does this internally; we just hand the array straight
  // through.)
  const fields = useMemo(() => availableSourceFields, [availableSourceFields])

  if (!isMounted || position === null) return null

  // Save button copy: "Save", "Save (1 change)", or "Save (N changes)".
  const saveLabel = !hasPendingChanges
    ? 'Save'
    : `Save (${changeCount} ${changeCount === 1 ? 'change' : 'changes'})`

  // Disabled-state hint; surfaces via the button's `title` attribute on
  // hover so the user understands why Save is greyed out.
  const saveDisabledHint = !hasSelection
    ? 'Select at least one source field'
    : !hasPendingChanges
      ? 'No changes to save'
      : undefined

  return createPortal(
    <div
      ref={containerRef}
      data-testid="inline-source-picker"
      role="dialog"
      aria-label="Edit source fields"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: PICKER_MAX_HEIGHT_PX,
        zIndex: 60,
      }}
      className={cn(
        'flex flex-col overflow-hidden rounded-md border border-slate-200 bg-white p-3 shadow-lg',
      )}
    >
      {/*
        Sticky-footer layout: the SourceFieldPicker subtree takes all
        remaining vertical space within the picker's max-height; the
        footer below it is `shrink-0` so it stays anchored to the
        picker's bottom edge regardless of how tall the chip strip /
        search / list grow.

        `flex-1 min-h-0` is the standard fix for "scrollable child in
        a flex column with a sibling that needs to stay visible" —
        without `min-h-0` the flex child cannot shrink below its
        intrinsic content height and the footer gets pushed outside
        the container's `overflow-hidden` bounds.

        The inner `overflow-y-auto` rarely engages in practice: the
        SourceFieldPicker's own list already scrolls internally
        (`max-h-72`). The wrapper-level scroll only kicks in when the
        chip strip + search + list-at-max collectively exceed the
        available space (e.g. 5+ chips).
      */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SourceFieldPicker
          availableSourceFields={fields}
          selectedIds={isSingleAutoCommit ? [] : pendingIds}
          onSelectedChange={handleSelectedChange}
          disabled={isSaving}
          hideChips={isSingleAutoCommit}
        />
        {isSingleAutoCommit && isSaving ? (
          <div
            data-testid="inline-source-picker-single-saving"
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500"
          >
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            <span>Saving…</span>
          </div>
        ) : null}
      </div>
      {isSingleAutoCommit ? null : (
        <div
          data-testid="inline-source-picker-footer"
          className="mt-3 flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 pt-3"
        >
          <button
            type="button"
            data-testid="inline-source-picker-cancel"
            onClick={handleCancel}
            disabled={isSaving}
            className={cn(
              'inline-flex h-7 items-center justify-center rounded border border-slate-300 bg-white px-2.5 text-[12px] font-medium text-slate-700',
              'transition-colors hover:bg-slate-50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
              'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400',
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="inline-source-picker-save"
            aria-label="Save source field changes"
            onClick={handleSave}
            disabled={!canSave}
            title={saveDisabledHint}
            className={cn(
              'inline-flex h-7 items-center justify-center gap-1.5 rounded border px-2.5 text-[12px] font-medium transition-colors',
              'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
            )}
          >
            {isSaving ? (
              <>
                <Loader2
                  aria-hidden="true"
                  data-testid="inline-source-picker-save-spinner"
                  className="h-3 w-3 animate-spin"
                />
                <span>Saving…</span>
              </>
            ) : (
              saveLabel
            )}
          </button>
        </div>
      )}
    </div>,
    document.body,
  )
}
