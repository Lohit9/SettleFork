'use client'

import { cn } from '@/components/ui/utils'
import type { MappingViewMode } from '@/lib/utils/view-mode-url'

// ViewModeToggle — segmented outline control for the Mapping page.
//
// Two views, mutually exclusive:
//   • Mapping list (default) — the flat spreadsheet view.
//   • Target-led             — the per-target-table card layout.
//
// Styled to match shadcn's ToggleGroup `variant='outline' size='sm'`
// aesthetic — bordered pill containing two segment buttons with the
// active segment in a tinted bg. Hand-rolled rather than imported so
// the codebase doesn't pick up a new `@radix-ui/react-toggle-group`
// dep for a single callsite; if a second segmented control surfaces
// elsewhere, extract a `components/ui/segmented-toggle.tsx` then.
//
// A11y: `role='radiogroup'` on the container, `role='radio' +
// aria-checked` on each button. Arrow-key navigation between
// segments via `onKeyDown` so the keyboard story matches Radix.

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
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const idx = OPTIONS.findIndex((o) => o.value === value)
    if (idx === -1) return
    const delta = e.key === 'ArrowRight' ? 1 : -1
    const nextIdx = (idx + delta + OPTIONS.length) % OPTIONS.length
    onChange(OPTIONS[nextIdx].value)
  }
  return (
    <div
      role="radiogroup"
      aria-label="Mapping view"
      data-testid="mapping-view-mode-toggle"
      onKeyDown={handleKeyDown}
      className="inline-flex flex-shrink-0 items-center rounded-md border border-gray-200 bg-white p-0.5"
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-state={isActive ? 'on' : 'off'}
            data-testid={`mapping-view-mode-${opt.value}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              if (!isActive) onChange(opt.value)
            }}
            className={cn(
              'inline-flex h-7 items-center justify-center rounded-sm px-2.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
              isActive
                ? 'bg-gray-100 text-gray-900'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
