'use client'

import { useRef, useState, useEffect } from 'react'
import { useInView } from 'framer-motion'

interface DataObject {
  source_object: string
  target_object: string
  notes: string
}

interface MappingPreviewProps {
  dataObjects: DataObject[]
  sourceSystem: string
  targetSystem: string
}

const MAX_ROWS = 5

export default function MappingPreview({ dataObjects, sourceSystem, targetSystem }: MappingPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, margin: '-60px' })
  const [visibleCount, setVisibleCount] = useState(0)

  const rows = dataObjects.slice(0, MAX_ROWS)
  const remaining = dataObjects.length - MAX_ROWS

  useEffect(() => {
    if (!isInView || visibleCount >= rows.length) return
    const timer = setTimeout(() => setVisibleCount((c) => c + 1), 120)
    return () => clearTimeout(timer)
  }, [isInView, visibleCount, rows.length])

  return (
    <div ref={containerRef} className="bg-settle-slate-900 rounded-2xl overflow-hidden shadow-2xl">
      {/* Top bar */}
      <div className="h-10 bg-settle-slate-800 flex items-center px-4 gap-2 border-b border-settle-slate-700">
        <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
        <span className="w-2.5 h-2.5 rounded-full bg-[#22C55E]" />
        <span className="text-settle-slate-400 text-xs ml-2 font-mono">
          settle — {sourceSystem} → {targetSystem}
        </span>
      </div>

      {/* Content */}
      <div className="p-5">
        {/* Header */}
        <div className="grid grid-cols-[1fr_24px_1fr] gap-x-3 pb-3 border-b border-settle-slate-700">
          <span className="text-[10px] uppercase tracking-widest text-settle-slate-500">Source</span>
          <span />
          <span className="text-[10px] uppercase tracking-widest text-settle-slate-500">Target</span>
        </div>

        {/* Rows */}
        {rows.map((obj, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_24px_1fr] gap-x-3 py-2.5 border-b border-settle-slate-800 transition-all duration-300"
            style={{
              opacity: i < visibleCount ? 1 : 0,
              transform: i < visibleCount ? 'translateY(0)' : 'translateY(6px)',
            }}
          >
            <span className="text-blue-300 text-sm font-mono truncate">{obj.source_object}</span>
            <span className="text-settle-slate-600 text-sm text-center">→</span>
            <span className="text-teal-300 text-sm font-mono truncate">{obj.target_object}</span>
          </div>
        ))}

        {/* Summary */}
        <div className="mt-3 pt-3 border-t border-settle-slate-700 flex justify-between items-center">
          <span className="text-settle-slate-500 text-xs">
            {remaining > 0 ? `+${remaining} more objects mapped` : `${dataObjects.length} objects mapped`}
          </span>
          <span className="text-green-400 text-xs flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
            94% avg confidence
          </span>
        </div>

        {/* CTA */}
        <div className="mt-4 text-center">
          <span className="text-settle-blue-400 hover:text-settle-blue-200 text-xs font-medium transition-colors cursor-pointer">
            See full mapping →
          </span>
        </div>
      </div>
    </div>
  )
}
