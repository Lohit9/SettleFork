'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'

// ── Types ──────────────────────────────────────────────────

export interface FilterTable {
  /** Stable unique ID — tableMappingId or sourceTableId */
  id: string
  /** Display label e.g. "Employees → WD_WORKERS" */
  label: string
  fields: FilterField[]
}

export interface FilterField {
  id: string
  /** Display label e.g. "first_name → legal_first_name" */
  label: string
}

export interface TableFieldSelection {
  /**
   * null = no filter (show all).
   * Empty Set = nothing selected (show nothing).
   * Non-empty Set = show only these fieldMappingIds.
   */
  selectedFieldIds: Set<string> | null
  /** Convenience: which tableIds are fully or partially selected */
  selectedTableIds: Set<string>
}

interface TableFieldFilterProps {
  tables: FilterTable[]
  /** Current active selection — null means "All" */
  value: TableFieldSelection
  onChange: (next: TableFieldSelection) => void
  /** Label shown on the trigger button when nothing is selected */
  allLabel?: string
}

// ── Helper ────────────────────────────────────────────────

function buildSelection(
  tables: FilterTable[],
  selectedFieldIds: Set<string>
): TableFieldSelection {
  const selectedTableIds = new Set<string>()
  for (const t of tables) {
    if (t.fields.some((f) => selectedFieldIds.has(f.id))) {
      selectedTableIds.add(t.id)
    }
  }
  return { selectedFieldIds, selectedTableIds }
}

// ── Component ────────────────────────────────────────────

export function TableFieldFilter({
  tables,
  value,
  onChange,
  allLabel = 'All Tables',
}: TableFieldFilterProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expandedTableIds, setExpandedTableIds] = useState<Set<string>>(
    new Set()
  )
  // Draft state — applied only on "Apply" click
  const [draftFieldIds, setDraftFieldIds] = useState<Set<string>>(
    () => value.selectedFieldIds ?? new Set()
  )
  const [isMounted, setIsMounted] = useState(false)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // Sync draft when external value changes
  useEffect(() => {
    setDraftFieldIds(value.selectedFieldIds ?? new Set())
  }, [value.selectedFieldIds])

  // Compute panel position from trigger
  const computePosition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const panelHeight = 360
    const spaceBelow = viewportHeight - rect.bottom
    setPosition({
      top:
        spaceBelow >= panelHeight
          ? rect.bottom + 4
          : rect.top - panelHeight - 4,
      left: rect.left,
      width: Math.max(rect.width, 280),
    })
  }, [])

  useEffect(() => {
    if (!open) return
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [open, computePosition])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () =>
      document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () =>
      document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  // Filtered tables based on search query
  const filteredTables = useMemo(() => {
    if (!query.trim()) return tables
    const q = query.toLowerCase()
    return tables
      .map((t) => ({
        ...t,
        fields: t.fields.filter((f) =>
          f.label.toLowerCase().includes(q)
        ),
      }))
      .filter(
        (t) =>
          t.label.toLowerCase().includes(q) || t.fields.length > 0
      )
  }, [tables, query])

  // Auto-expand tables that have matching fields when searching
  useEffect(() => {
    if (!query.trim()) return
    const ids = new Set<string>()
    for (const t of filteredTables) {
      if (t.fields.length > 0) ids.add(t.id)
    }
    setExpandedTableIds(ids)
  }, [query, filteredTables])

  // Table check state: 'all' | 'none' | 'partial'
  function tableCheckState(
    table: FilterTable
  ): 'all' | 'none' | 'partial' {
    const selected = table.fields.filter((f) =>
      draftFieldIds.has(f.id)
    ).length
    if (selected === 0) return 'none'
    if (selected === table.fields.length) return 'all'
    return 'partial'
  }

  function toggleTable(table: FilterTable) {
    const state = tableCheckState(table)
    setDraftFieldIds((prev) => {
      const next = new Set(prev)
      if (state === 'all') {
        for (const f of table.fields) next.delete(f.id)
      } else {
        for (const f of table.fields) next.add(f.id)
      }
      return next
    })
  }

  function toggleField(fieldId: string) {
    setDraftFieldIds((prev) => {
      const next = new Set(prev)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
      }
      return next
    })
  }

  function handleApply() {
    if (draftFieldIds.size === 0) {
      onChange({ selectedFieldIds: null, selectedTableIds: new Set() })
    } else {
      onChange(buildSelection(tables, draftFieldIds))
    }
    setOpen(false)
  }

  function handleClear() {
    setDraftFieldIds(new Set())
    onChange({ selectedFieldIds: null, selectedTableIds: new Set() })
    setOpen(false)
  }

  // Trigger button label
  const triggerLabel = useMemo(() => {
    if (!value.selectedFieldIds || value.selectedFieldIds.size === 0) {
      return allLabel
    }
    const tableCount = value.selectedTableIds.size
    const fieldCount = value.selectedFieldIds.size
    const totalFields = tables.reduce(
      (sum, t) => sum + t.fields.length,
      0
    )
    const allFieldsSelected = tables
      .filter((t) => value.selectedTableIds.has(t.id))
      .every((t) =>
        t.fields.every((f) => value.selectedFieldIds!.has(f.id))
      )
    if (allFieldsSelected) {
      return `${tableCount} ${tableCount === 1 ? 'table' : 'tables'}`
    }
    return `${fieldCount} of ${totalFields} fields`
  }, [value, tables, allLabel])

  const isFiltered =
    value.selectedFieldIds !== null && value.selectedFieldIds.size > 0

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: Math.max(position.width, 280),
          zIndex: 9999,
        }}
        className="bg-white border border-settle-slate-200 rounded-xl shadow-lg flex flex-col max-h-[360px] overflow-hidden"
      >
        {/* Search */}
        <div className="px-3 py-2 border-b border-settle-slate-100 flex-shrink-0">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Search tables and fields…"
            className="w-full h-7 text-xs px-2.5 rounded-md border border-settle-slate-200 bg-white text-settle-slate-900 placeholder:text-settle-slate-400 focus:outline-none focus:ring-1 focus:ring-settle-blue-500"
          />
        </div>

        {/* Table + field list */}
        <div className="flex-1 overflow-y-auto">
          {filteredTables.length === 0 ? (
            <div className="px-3 py-4 text-xs text-settle-slate-400 text-center">
              No tables match
            </div>
          ) : (
            filteredTables.map((table) => {
              const checkState = tableCheckState(table)
              const expanded = expandedTableIds.has(table.id)
              return (
                <div
                  key={table.id}
                  className="border-b border-settle-slate-50 last:border-b-0"
                >
                  {/* Table row */}
                  <div className="flex items-center gap-2 px-3 py-2 hover:bg-settle-slate-50 transition-colors">
                    <Checkbox
                      checked={checkState === 'all'}
                      onCheckedChange={() => toggleTable(table)}
                      className={
                        checkState === 'partial' ? 'opacity-60' : ''
                      }
                    />
                    <button
                      onClick={() =>
                        setExpandedTableIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(table.id)) {
                            next.delete(table.id)
                          } else {
                            next.add(table.id)
                          }
                          return next
                        })
                      }
                      className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
                    >
                      <span className="text-xs font-medium text-settle-slate-900 truncate flex-1">
                        {table.label}
                      </span>
                      <ChevronRight
                        className={`w-3 h-3 text-settle-slate-400 flex-shrink-0 transition-transform ${
                          expanded ? 'rotate-90' : ''
                        }`}
                      />
                    </button>
                  </div>

                  {/* Field rows */}
                  {expanded && (
                    <div className="bg-settle-slate-50/50">
                      {table.fields.map((field) => (
                        <div
                          key={field.id}
                          className="flex items-center gap-2 pl-8 pr-3 py-1.5 hover:bg-settle-slate-100/50 transition-colors"
                        >
                          <Checkbox
                            checked={draftFieldIds.has(field.id)}
                            onCheckedChange={() => toggleField(field.id)}
                          />
                          <span className="text-[11px] text-settle-slate-700 font-mono truncate">
                            {field.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer: Clear + Apply */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-settle-slate-100 flex-shrink-0">
          <button
            onClick={handleClear}
            className="text-xs text-settle-slate-400 hover:text-settle-slate-600 transition-colors"
          >
            Clear all
          </button>
          <button
            onClick={handleApply}
            className="text-xs font-medium px-3 py-1.5 rounded-md bg-settle-blue-500 text-white hover:bg-settle-blue-600 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    ) : null

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className={`h-8 text-xs border rounded-lg px-3 flex items-center justify-between gap-2 cursor-pointer transition-colors bg-white min-w-[120px] w-full focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
          isFiltered
            ? 'border-settle-blue-500 text-settle-blue-700'
            : 'border-gray-200 text-gray-900 hover:border-gray-300'
        }`}
      >
        <span className="flex-1 text-left truncate text-xs text-gray-900">
          {triggerLabel}
        </span>
        <ChevronDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
      </button>

      {isMounted && panel ? createPortal(panel, document.body) : null}
    </>
  )
}
