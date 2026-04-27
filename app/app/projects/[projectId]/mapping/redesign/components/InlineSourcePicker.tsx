'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/components/ui/utils'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import { SourceFieldPicker } from './SourceFieldPicker'

// ─────────────────────────────────────────────────────────────────────────────
// InlineSourcePicker — Phase 4-polish-3 Block A.
// ─────────────────────────────────────────────────────────────────────────────
//
// Portal-anchored wrapper around `SourceFieldPicker` that powers the inline
// "click source cell → swap sources" affordance on the mapping page list view.
// Founder-locked decisions for polish-3:
//
//   1. Wrap the existing `SourceFieldPicker` (which already provides multi-
//      select, search, group rendering, per-field tooltips, and the
//      DOMINANT/JOINED chip strip) — DO NOT extend the legacy
//      `components/app/FieldPicker.tsx`. Reusing the redesign primitive
//      keeps the inline picker visually + behaviourally identical to the
//      drawer's `CreateMappingForm` source picker.
//
//   2. Commit-on-close semantics. The picker manages its own pending
//      selection internally; on Esc / click-outside it fires
//      `onCommit(finalIds)` only when the selection has actually changed
//      vs. the initial set. A no-op close fires only `onClose()`.
//
//   3. Empty-selection guard. If the user attempts to close the picker
//      with zero sources selected, an inline error message is surfaced
//      and the picker stays open. The dedicated reject (✗) row button
//      is the canonical "remove this mapping" affordance — the picker
//      does not double as a delete path.
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
const PICKER_MAX_HEIGHT_PX = 360
const VIEWPORT_MARGIN_PX = 8

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
   * Fired on close when the pending selection differs from the initial
   * set. Args: the final selection in user-pick order. The parent is
   * responsible for dispatching `createFieldMapping` /
   * `editMappingSources` and surfacing post-save toasts.
   */
  onCommit: (finalSourceFieldIds: string[]) => void
  /**
   * Always fired on close (after `onCommit` if relevant). Allows the
   * parent to clear `pickerOpenRowId` and unmount this component.
   */
  onClose: () => void
}

export function InlineSourcePicker({
  anchorRef,
  initialSourceFieldIds,
  availableSourceFields,
  onCommit,
  onClose,
}: InlineSourcePickerProps) {
  // Snapshot the initial set ONCE so the diff at close time is stable
  // even if the parent re-renders with a fresh `initialSourceFieldIds`
  // array reference for the same logical value.
  const initialSetRef = useRef<Set<string>>(
    new Set(initialSourceFieldIds),
  )
  const [pendingIds, setPendingIds] = useState<string[]>(
    () => [...initialSourceFieldIds],
  )
  const [showEmptyError, setShowEmptyError] = useState(false)

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

  // Whether the close attempt should commit (selection changed) or skip
  // the wrapper (no-op close). Computed off the snapshot so a parent
  // re-render mid-flight cannot flip the verdict.
  const tryClose = useCallback(() => {
    if (pendingIds.length === 0) {
      setShowEmptyError(true)
      return
    }
    const initial = initialSetRef.current
    const isChanged =
      pendingIds.length !== initial.size ||
      pendingIds.some((id) => !initial.has(id))
    if (isChanged) {
      onCommit(pendingIds)
    }
    onClose()
  }, [pendingIds, onCommit, onClose])

  // Click-outside (mousedown) → attempt close. Use mousedown rather than
  // click so the picker dismisses BEFORE any outside button-click handler
  // fires (matching the FieldPicker primitive).
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (target === null) return
      if (containerRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      tryClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [tryClose, anchorRef])

  // Esc → attempt close. Same blocking-on-empty contract as click-outside.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      tryClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [tryClose])

  // Clear the inline error as soon as the user picks at least one
  // source. The error is purely a "you tried to close empty" signal;
  // it should not linger past the next selection event.
  const handleSelectedChange = useCallback((next: string[]) => {
    setPendingIds(next)
    if (next.length > 0) setShowEmptyError(false)
  }, [])

  // Memoise the field map for the picker body. (SourceFieldPicker
  // already does this internally; we just hand the array straight
  // through.)
  const fields = useMemo(() => availableSourceFields, [availableSourceFields])

  if (!isMounted || position === null) return null

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
      <SourceFieldPicker
        availableSourceFields={fields}
        selectedIds={pendingIds}
        onSelectedChange={handleSelectedChange}
      />
      {showEmptyError ? (
        <p
          role="alert"
          data-testid="inline-source-picker-empty-error"
          className="mt-2 text-[12px] text-red-600"
        >
          Select at least one source field
        </p>
      ) : null}
    </div>,
    document.body,
  )
}
