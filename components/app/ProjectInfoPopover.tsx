'use client'

import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

export interface ProjectInfo {
  projectName: string
  sourceSystem: string | null
  targetSystem: string | null
  createdAt: string
}

export function ProjectInfoPopover({ info }: { info: ProjectInfo }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const formattedDate = new Date(info.createdAt).toLocaleDateString(
    undefined,
    { month: 'long', day: 'numeric', year: 'numeric' }
  )

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center w-7 h-7 rounded-md text-settle-slate-400 hover:text-settle-slate-600 hover:bg-settle-slate-50 transition-colors"
        aria-label="Project information"
        aria-expanded={open}
      >
        <Info size={15} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 z-50 w-64 rounded-xl border border-settle-slate-200 bg-white shadow-lg"
          role="dialog"
          aria-label="Project information"
        >
          <div className="px-4 py-3 border-b border-settle-slate-100">
            <p className="text-xs font-semibold text-settle-slate-900">
              Project Info
            </p>
          </div>

          <div className="px-4 py-3 space-y-3">
            <div>
              <p className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide mb-0.5">
                Project
              </p>
              <p className="text-xs font-medium text-settle-slate-900">
                {info.projectName}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide mb-0.5">
                Source System
              </p>
              <p className="text-xs text-settle-slate-700">
                {info.sourceSystem ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide mb-0.5">
                Target System
              </p>
              <p className="text-xs text-settle-slate-700">
                {info.targetSystem ?? '—'}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide mb-0.5">
                Created
              </p>
              <p className="text-xs text-settle-slate-700">
                {formattedDate}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
