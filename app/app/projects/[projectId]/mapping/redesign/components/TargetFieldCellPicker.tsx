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
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/redesign-ui'
import type { TargetFieldRef } from '@/lib/types/mappings-for-redesign'
import { TableBadge } from './TableBadge'

// ─────────────────────────────────────────────────────────────────────────────
// TargetFieldCellPicker — flat-view target-cell editor.
// ─────────────────────────────────────────────────────────────────────────────
//
// Symmetric counterpart of `InlineSourcePicker` for the Mapping list view's
// target-side cell editing. Two operations funnel through this picker:
//
//   1. Swap a TFM's target field (mapped row → click target cell → pick
//      new target). Calls A's `updateMappingTargetField`.
//   2. Manually map an unmapped source row to a target field (unmapped
//      source row → click ✏ Edit → pick target). Calls A's
//      `createMappingFromUnmapped`.
//
// Both flows are single-pick autoCommit: the first click commits and
// closes. There is no chip strip and no Save / Cancel footer — the user's
// click IS the commit. The dedicated reject (✗) row button handles
// "remove this mapping" semantics, so the picker never needs a "no
// target" option.
//
// The position-portal pattern mirrors `InlineSourcePicker` 1:1
// (getBoundingClientRect against `anchorRef`, recompute on resize +
// scroll-capture, vertical flip when no room below). Duplication is
// deliberate for v1 — once a third callsite surfaces we can extract the
// shell into `lib/hooks/use-portal-anchor.ts`. Until then, two pickers
// with two clear responsibilities reads more cleanly than one
// over-parameterized one.

const PICKER_MIN_WIDTH_PX = 352 // 22rem
const PICKER_MAX_HEIGHT_PX = 420
const VIEWPORT_MARGIN_PX = 8

export interface TargetFieldCellCommitResult {
  success: boolean
}

export interface TargetFieldCellPickerProps {
  /** Anchor element ref — the target-cell trigger button. */
  anchorRef: React.RefObject<HTMLElement | null>
  /**
   * Current target field id, used to dim it in the list (so the user
   * cannot pick the same field they already have). Null when opening
   * from an unmapped source row (no current target).
   */
  initialTargetFieldId: string | null
  /**
   * Universe of target fields the picker can select. Caller derives
   * this from `result.rows.map(r => r.targetField)` since every target
   * field appears exactly once in the rows array per the data contract.
   */
  availableTargetFields: readonly TargetFieldRef[]
  /**
   * Fired when the user picks a target field. Returns a result that
   * drives whether the picker closes (success) or stays open (error).
   * The parent owns the server action dispatch and post-save toasts.
   */
  onCommit: (
    newTargetFieldId: string,
  ) => Promise<TargetFieldCellCommitResult>
  /**
   * Fired when the user closes the picker via Esc, click-outside, or a
   * successful commit. Allows the parent to clear its open-cell state.
   */
  onClose: () => void
}

export function TargetFieldCellPicker({
  anchorRef,
  initialTargetFieldId,
  availableTargetFields,
  onCommit,
  onClose,
}: TargetFieldCellPickerProps) {
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
  const [isSaving, setIsSaving] = useState(false)

  // ── Positioning (mirrors InlineSourcePicker) ────────────────────────
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

  // ── Search ──────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSearchQuery(searchInput)
      timerRef.current = null
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [searchInput])

  // ── Filter + group ──────────────────────────────────────────────────
  const visibleFields = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase()
    if (trimmed.length === 0) return availableTargetFields
    return availableTargetFields.filter((field) => {
      const haystack =
        `${field.name} ${field.targetTable.name}`.toLowerCase()
      return haystack.includes(trimmed)
    })
  }, [availableTargetFields, searchQuery])

  const grouped = useMemo(() => {
    const out = new Map<
      string,
      { tableName: string; fields: TargetFieldRef[] }
    >()
    for (const field of visibleFields) {
      const existing = out.get(field.targetTable.id)
      if (existing) {
        existing.fields.push(field)
      } else {
        out.set(field.targetTable.id, {
          tableName: field.targetTable.name,
          fields: [field],
        })
      }
    }
    return out
  }, [visibleFields])

  // ── Commit ──────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (fieldId: string) => {
      if (isSaving) return
      if (fieldId === initialTargetFieldId) {
        // No-op: user re-selected the same field. Close without firing.
        onClose()
        return
      }
      setIsSaving(true)
      void (async () => {
        let result: TargetFieldCellCommitResult
        try {
          result = await onCommit(fieldId)
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
    [initialTargetFieldId, isSaving, onCommit, onClose],
  )

  // ── Esc + click-outside (cancels — never auto-commits) ──────────────
  const handleCancel = useCallback(() => {
    if (isSaving) return
    onClose()
  }, [isSaving, onClose])

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
  }, [anchorRef, handleCancel, isSaving])

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

  if (!isMounted || position === null) return null

  const groupEntries = Array.from(grouped.entries())
  const hasFields = availableTargetFields.length > 0
  const noMatches = grouped.size === 0

  return createPortal(
    <div
      ref={containerRef}
      data-testid="target-field-cell-picker"
      role="dialog"
      aria-label="Edit target field"
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
      <input
        type="text"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        placeholder="Search target fields…"
        disabled={isSaving}
        data-testid="target-field-cell-picker-search"
        aria-label="Search target fields"
        className={cn(
          'w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs',
          'text-slate-700 placeholder:text-slate-400',
          'focus:outline-none focus:ring-1 focus:ring-blue-500',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
        )}
      />
      <div
        data-testid="target-field-cell-picker-list"
        className={cn(
          'mt-2 flex flex-1 flex-col overflow-y-auto rounded border border-slate-200',
          isSaving && 'opacity-60',
        )}
      >
        {!hasFields ? (
          <div
            data-testid="target-field-cell-picker-empty-no-schema"
            className="px-3 py-6 text-center text-[11px] italic text-slate-400"
          >
            No target schema available.
          </div>
        ) : noMatches ? (
          <div
            data-testid="target-field-cell-picker-empty-no-match"
            className="px-3 py-6 text-center text-[11px] italic text-slate-400"
          >
            No target fields match the current search.
          </div>
        ) : (
          groupEntries.map(([tableId, group]) => (
            <TargetTableGroup
              key={tableId}
              tableName={group.tableName}
              fields={group.fields}
              currentTargetFieldId={initialTargetFieldId}
              onSelect={handleSelect}
              disabled={isSaving}
            />
          ))
        )}
      </div>
      {isSaving ? (
        <div
          data-testid="target-field-cell-picker-saving"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500"
        >
          <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
          <span>Saving…</span>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}

function TargetTableGroup({
  tableName,
  fields,
  currentTargetFieldId,
  onSelect,
  disabled,
}: {
  tableName: string
  fields: TargetFieldRef[]
  currentTargetFieldId: string | null
  onSelect: (fieldId: string) => void
  disabled: boolean
}) {
  return (
    <section
      data-testid="target-field-cell-picker-group"
      data-target-table-name={tableName}
      className="border-b border-slate-100 last:border-b-0"
    >
      <header className="flex items-baseline gap-1.5 bg-slate-50/60 px-3 py-1.5">
        <h4
          className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-600"
          title={tableName}
        >
          {tableName}
        </h4>
        <span className="text-[10px] font-medium text-slate-400 tabular-nums">
          {fields.length}
        </span>
      </header>
      <ul className="flex flex-col py-0.5">
        {fields.map((field) => (
          <PickerFieldRow
            key={field.id}
            field={field}
            isCurrent={field.id === currentTargetFieldId}
            onSelect={onSelect}
            disabled={disabled}
          />
        ))}
      </ul>
    </section>
  )
}

function PickerFieldRow({
  field,
  isCurrent,
  onSelect,
  disabled,
}: {
  field: TargetFieldRef
  isCurrent: boolean
  onSelect: (fieldId: string) => void
  disabled: boolean
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(field.id)}
        disabled={disabled || isCurrent}
        data-testid="target-field-cell-picker-field"
        data-target-field-id={field.id}
        data-is-current={isCurrent ? 'true' : 'false'}
        className={cn(
          'group/field relative flex w-full items-center gap-1.5 px-3 py-1 text-left',
          'text-[11px] leading-tight text-slate-700',
          'transition-colors motion-reduce:transition-none',
          'cursor-pointer hover:bg-slate-50',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
          isCurrent && 'bg-slate-50',
        )}
        title={
          isCurrent
            ? 'Current target field'
            : `${field.targetTable.name} · ${field.name}`
        }
      >
        <TableBadge
          tableName={field.targetTable.name}
          size="sm"
          className="shrink-0"
        />
        <span className="flex-1 truncate font-mono text-[11px]">
          {field.name}
        </span>
        <span className="ml-2 shrink-0 text-[10px] uppercase tracking-wide text-slate-400">
          {field.dataType}
        </span>
        {isCurrent ? (
          <span className="ml-1 shrink-0 text-[9px] italic text-slate-400">
            current
          </span>
        ) : null}
      </button>
    </li>
  )
}
