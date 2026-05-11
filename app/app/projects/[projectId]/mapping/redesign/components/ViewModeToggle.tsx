'use client'

import { cn } from '@/components/ui/utils'
import type { MappingViewMode } from '@/lib/utils/view-mode-url'

// ViewModeToggle — top-of-page segmented control for the Mapping page.
//
// Two views, mutually exclusive:
//   • Target-led — existing per-target-table card layout (default).
//   • Mapping list — flat spreadsheet view.
//
// Visual lineage: mirrors the cursor-underline style used by
// `components/CursorTabs.tsx` and `app/app/settings/SettingsTabs.tsx`.
// Keeping the styling local (rather than importing CursorTabs)
// avoids coupling the Mapping page to a primitive that today serves a
// different use case (route-driven tab nav). If a third callsite
// surfaces, extract a `<SegmentedToggle>` primitive then.

const OPTIONS: ReadonlyArray<{ value: MappingViewMode; label: string }> = [
  { value: 'target-led', label: 'Target-led' },
  { value: 'flat', label: 'Mapping list' },
]

export function ViewModeToggle({
  value,
  onChange,
}: {
  value: MappingViewMode
  onChange: (next: MappingViewMode) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Mapping view"
      data-testid="mapping-view-mode-toggle"
      className="flex flex-shrink-0 items-center gap-1 border-b border-gray-100 bg-white px-5 pt-2"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`mapping-view-mode-${opt.value}`}
            onClick={() => {
              if (!isActive) onChange(opt.value)
            }}
            className={cn(
              'h-8 rounded-t-md border-b-2 px-3 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
              isActive
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-800',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
