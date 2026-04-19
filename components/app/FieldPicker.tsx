'use client'

import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react'
import { createPortal } from 'react-dom'

export interface PickerField {
  id: string
  name: string
  data_type: string
  is_nullable?: boolean
}

interface FieldPickerProps {
  tableName: string
  fields: PickerField[]
  selectedFieldId: string | null
  onSelect: (field: PickerField) => void
  onClose: () => void
  anchorRef?: React.RefObject<HTMLElement | null>
}

export function FieldPicker({
  tableName,
  fields,
  selectedFieldId,
  onSelect,
  onClose,
  anchorRef,
}: FieldPickerProps) {
  const [query, setQuery] = useState('')
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!anchorRef?.current) return

    function computePosition() {
      if (!anchorRef?.current) return
      const rect = anchorRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const viewportWidth = window.innerWidth
      const pickerHeight = 280
      const pickerWidth = Math.max(rect.width, 240)
      const margin = 8
      const spaceBelow = viewportHeight - rect.bottom

      setPosition({
        top:
          spaceBelow >= pickerHeight
            ? rect.bottom + 4
            : rect.top - pickerHeight - 4,
        left: Math.max(margin, Math.min(rect.left, viewportWidth - pickerWidth - margin)),
        width: pickerWidth,
      })
    }

    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !anchorRef?.current?.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () =>
      document.removeEventListener('mousedown', handleMouseDown)
  }, [onClose, anchorRef])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () =>
      document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const filteredFields = fields.filter(
    (f) =>
      !query.trim() ||
      f.name.toLowerCase().includes(query.toLowerCase())
  )

  const handleSelect = useCallback(
    (field: PickerField) => {
      onSelect(field)
      onClose()
    },
    [onSelect, onClose]
  )

  const style: React.CSSProperties =
    position && anchorRef
      ? {
          position: 'fixed',
          top: position.top,
          left: position.left,
          width: Math.max(position.width, 240),
          zIndex: 9999,
        }
      : {}

  const pickerContent = (
    <div
      ref={containerRef}
      style={style}
      onClick={(e) => e.stopPropagation()}
      className={`bg-white border border-settle-slate-200 rounded-xl shadow-lg overflow-hidden flex flex-col ${anchorRef ? 'max-h-[280px]' : ''}`}
    >
      <div className="px-3 py-2 border-b border-settle-slate-100 flex-shrink-0">
        <p className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide">
          {tableName}
        </p>
      </div>

      <div className="px-2 py-2 border-b border-settle-slate-100 flex-shrink-0">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder="Search fields…"
          className="w-full h-7 text-xs px-2.5 rounded-md border border-settle-slate-200 bg-white text-settle-slate-900 placeholder:text-settle-slate-400 focus:outline-none focus:ring-1 focus:ring-settle-blue-500"
        />
      </div>

      <div className="overflow-y-auto max-h-48 flex-1">
        {filteredFields.length === 0 ? (
          <div className="px-3 py-4 text-xs text-settle-slate-400 text-center">
            No fields match
          </div>
        ) : (
          filteredFields.map((field) => {
            const isSelected = field.id === selectedFieldId
            return (
              <button
                key={field.id}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  handleSelect(field)
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors border-b border-settle-slate-50 last:border-b-0 ${
                  isSelected
                    ? 'bg-settle-blue-50 text-settle-blue-700'
                    : 'hover:bg-settle-slate-50 text-settle-slate-900'
                }`}
              >
                <span className="text-xs font-mono truncate">
                  {field.name}
                </span>
                <span className="text-[10px] text-settle-slate-400 flex-shrink-0 ml-2">
                  {field.data_type}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )

  if (anchorRef) {
    if (!isMounted) return null
    return createPortal(pickerContent, document.body)
  }

  return pickerContent
}
