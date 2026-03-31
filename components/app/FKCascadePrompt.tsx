'use client'

import { useState, useEffect } from 'react'
import { Link2 } from 'lucide-react'
import type { FKDependent } from '@/lib/actions/fk-cascade'

interface Props {
  pkTableName: string
  pkFieldName: string
  pkTransformSQL: string
  dependents: FKDependent[]
  onCascade: (selectedFmIds: string[]) => void
  onSkip: () => void
}

export default function FKCascadePrompt({
  pkTableName,
  pkFieldName,
  dependents,
  onCascade,
  onSkip,
}: Props) {
  // All mappable dependents checked by default
  const mappable = dependents.filter((d) => d.fieldMappingId !== null)
  const [checked, setChecked] = useState<Set<string>>(
    new Set(mappable.map((d) => d.fieldMappingId!))
  )

  // Dismiss on Escape key
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onSkip()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onSkip])

  function toggle(fmId: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(fmId)) next.delete(fmId)
      else next.add(fmId)
      return next
    })
  }

  function handleCascade() {
    const selectedFmIds = [...checked]
    onCascade(selectedFmIds)
  }

  const selectedCount = checked.size

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onSkip() }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fk-cascade-title"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <Link2 className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h2
                id="fk-cascade-title"
                className="text-base font-semibold text-gray-900"
              >
                Cascade transform to related tables?
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                You applied a transform to{' '}
                <span className="font-mono text-gray-700 text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                  {pkTableName}.{pkFieldName}
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-gray-600">
            These foreign key fields reference it and should use the same
            transform to maintain referential integrity:
          </p>

          <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {dependents.map((dep) => {
              const isMappable = dep.fieldMappingId !== null
              const isChecked = isMappable && checked.has(dep.fieldMappingId!)

              return (
                <label
                  key={dep.fieldId}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                    !isMappable
                      ? 'border-gray-100 bg-gray-50 cursor-not-allowed opacity-60'
                      : isChecked
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 flex-shrink-0 accent-blue-600"
                    checked={isChecked}
                    disabled={!isMappable}
                    onChange={() => isMappable && toggle(dep.fieldMappingId!)}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-gray-800 font-mono">
                      {dep.tableName}.{dep.fieldName}
                    </span>
                    {!isMappable && (
                      <span className="ml-2 text-xs text-gray-400">
                        (no field mapping — cannot cascade)
                      </span>
                    )}
                    {isMappable && dep.hasExistingTransform && (
                      <span className="ml-2 text-xs text-amber-600">
                        (has existing transform — will be overwritten)
                      </span>
                    )}
                  </div>
                </label>
              )
            })}
          </div>

          <p className="text-xs text-gray-500 pt-1">
            Cascaded transforms will be{' '}
            <span className="font-medium text-gray-600">applied immediately</span>{' '}
            using the same SQL. You can edit them individually later if needed.
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-3">
          <button
            onClick={onSkip}
            className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors"
          >
            Skip
          </button>
          <button
            onClick={handleCascade}
            disabled={selectedCount === 0}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {selectedCount > 0
              ? `Cascade to ${selectedCount} field${selectedCount > 1 ? 's' : ''}`
              : 'Cascade Selected'}
          </button>
        </div>

        {/* Dismiss ✕ */}
        <button
          onClick={onSkip}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 p-1 rounded"
          aria-label="Skip cascade"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
