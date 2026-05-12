'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/components/ui/utils'

// ─────────────────────────────────────────────────────────────────────────────
// RejectConfirmPopover — Phase 4-polish-3 Block B.
// ─────────────────────────────────────────────────────────────────────────────
//
// Bespoke confirmation popover anchored to the inline ✗ (reject) button on a
// `FieldMappingRow`. Founder-locked decisions for polish-3:
//
//   1. Portal + computed position. Mirrors the
//      `components/app/FieldPicker.tsx` portal pattern: render under
//      `document.body`, position via `getBoundingClientRect`, recompute on
//      resize + scroll-capture so the popover stays glued to the trigger.
//      We did NOT promote a shared `components/ui/popover.tsx` primitive in
//      polish-3 — keeping scope tight; the pattern can promote later if a
//      second non-row caller appears.
//
//   2. Locked copy:
//        Title:  "Reject this mapping?"
//        Buttons: "Cancel" (default) + "Reject" (destructive red)
//      The drawer's existing reject AlertDialog carries a longer body
//      ("…will become unmapped. The mapping and any associated
//      transformation will be deleted. This cannot be undone."). The
//      inline popover stays terse — the row's destructive verb +
//      destructive-red affirm button communicate the intent without a
//      paragraph.
//
//   3. Dismiss on Esc / click-outside (treat as cancel); the destructive
//      action is invoked only on Reject click. Focus moves to the Cancel
//      button on mount so a stray Enter cancels rather than confirms
//      (defense-in-depth — the Reject button is destructive).

const POPOVER_WIDTH_PX = 240
const POPOVER_HEIGHT_PX = 96
const VIEWPORT_MARGIN_PX = 8

export interface RejectConfirmPopoverProps {
  /** Anchor element ref — the inline ✗ button on the row. */
  anchorRef: React.RefObject<HTMLElement | null>
  /**
   * Confirm — fired when the user clicks the destructive action
   * button. Parent dispatches the destructive server action and
   * surfaces the row removal animation + success toast.
   */
  onConfirm: () => void
  /** Cancel — fired on Esc, click-outside, or Cancel button click. */
  onCancel: () => void
  /**
   * Drawer redesign PR 2 — copy override for re-use as a per-source
   * remove confirm. Defaults to the row-level reject copy
   * ("Reject this mapping?" / "Reject"). Per-source remove sets
   * `title: "Remove this source from the mapping?"` / `confirmLabel:
   * "Remove"`.
   */
  title?: string
  confirmLabel?: string
}

export function RejectConfirmPopover({
  anchorRef,
  onConfirm,
  onCancel,
  title = 'Reject this mapping?',
  confirmLabel = 'Reject',
}: RejectConfirmPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [isMounted, setIsMounted] = useState(false)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    function computePosition() {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      const width = POPOVER_WIDTH_PX
      const spaceBelow = viewportHeight - rect.bottom
      const top =
        spaceBelow >= POPOVER_HEIGHT_PX
          ? rect.bottom + 4
          : Math.max(VIEWPORT_MARGIN_PX, rect.top - POPOVER_HEIGHT_PX - 4)
      // Right-align the popover under the trigger so it does not
      // overflow the viewport on the right side. The actions column
      // is the rightmost row column, so left-align would push the
      // popover off-screen on most layouts.
      const idealLeft = rect.right - width
      const left = Math.max(
        VIEWPORT_MARGIN_PX,
        Math.min(idealLeft, viewportWidth - width - VIEWPORT_MARGIN_PX),
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

  // Move focus to Cancel on mount so a stray Enter dismisses rather
  // than confirms. Defensive on a destructive popover.
  useEffect(() => {
    const t = setTimeout(() => cancelButtonRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  // Click-outside dismisses (treated as cancel).
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (target === null) return
      if (containerRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onCancel()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [onCancel, anchorRef])

  // Esc dismisses (treated as cancel).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleConfirmClick = useCallback(() => {
    onConfirm()
  }, [onConfirm])

  if (!isMounted || position === null) return null

  return createPortal(
    <div
      ref={containerRef}
      data-testid="reject-confirm-popover"
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: position.width,
        zIndex: 70,
      }}
      className={cn(
        'flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-3 shadow-lg',
      )}
    >
      <p className="text-[13px] font-medium text-slate-900">{title}</p>
      <div className="flex items-center justify-end gap-2">
        <button
          ref={cancelButtonRef}
          type="button"
          data-testid="reject-confirm-popover-cancel"
          onClick={onCancel}
          className={cn(
            'inline-flex h-7 items-center justify-center rounded border border-slate-300 bg-white px-2.5 text-[12px] font-medium text-slate-700',
            'transition-colors hover:bg-slate-50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="reject-confirm-popover-confirm"
          onClick={handleConfirmClick}
          className={cn(
            'inline-flex h-7 items-center justify-center rounded bg-red-600 px-2.5 text-[12px] font-medium text-white',
            'transition-colors hover:bg-red-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400',
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body,
  )
}
