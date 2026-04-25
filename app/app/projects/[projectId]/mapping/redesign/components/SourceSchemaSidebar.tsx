'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3, Gap 11a — Source schema sidebar shell.
// ─────────────────────────────────────────────────────────────────────────────
//
// Persistent left-side sidebar for browsing the project's source schema.
// Gap 11a ships the SHELL only — width animation, persistence,
// expand/collapse interaction, accessibility, and the visual scaffolding
// for the expanded contents (header, search, filter pills, list area).
// Gap 11b fills the field rendering, filter logic, search wiring, hover
// tooltips, and click-to-highlight interactions.
//
// LAYOUT
//
//   Collapsed (28px)        Expanded (200px)
//   ┌──────┐                ┌────────────────────┐
//   │ S    │                │ Source fields  —  ⟨ │  ← header w/ close chev
//   │ o    │                ├────────────────────┤
//   │ u    │                │ [search…         ] │
//   │ r    │                ├────────────────────┤
//   │ c    │                │ [All][Mapped][Un…] │  ← filter pills
//   │ e    │                ├────────────────────┤
//   │      │                │                    │
//   │  —   │                │  empty-state copy  │
//   │      │                │   (Gap 11b fills)  │
//   │      │                │                    │
//   │      │                │                    │
//   │      │                │                    │
//   │      │                │                    │
//   └──────┘                └────────────────────┘
//
// The vertical label + count are TOP-anchored on the collapsed rail
// (founder amendment, 2026-04-25) so the affordance lands in the
// user's first scan zone instead of after a tall empty column.
//
// The collapsed-rail label uses `writing-mode: vertical-rl` plus a
// 180° rotation. The combination produces text that reads bottom-to-top
// (i.e., tilt your head LEFT to read it normally) — this is the
// conventional vertical sidebar label orientation in modern editors
// (VS Code activity bar, Linear icon labels, etc.).
//
// ACCESSIBILITY
//
//   - Wrapping element is `<aside aria-label="Source schema browser">`.
//   - Collapsed state: a single full-height `<button>` so the rail is
//     keyboard-reachable (Tab → Enter expands). aria-label
//     "Expand source schema browser".
//   - Expanded state: the close chevron is a `<button>` with aria-label
//     "Collapse source schema browser".
//   - Focus management: when the user expands, focus moves to the close
//     chevron (so Tab→Enter cycle to collapse is natural). When the user
//     collapses, focus moves back to the rail's button. Focus is NOT
//     moved on hydration (when the sidebar pops from 'collapsed' →
//     'expanded' because of a persisted user preference) — only on
//     direct user interaction. Tracked via a ref flag set in the click
//     handlers.
//
// COEXISTENCE WITH THE DRAWER
//
// The sidebar carries `data-testid="source-schema-sidebar"` so the
// drawer's document-level click-outside detector can scope the
// "click outside ⇒ close drawer" rule to exclude clicks landing on the
// sidebar (founder decision 4 — drawer + sidebar coexist above
// 1024px viewport). See `MappingDrawer.tsx` for the symmetric guard.

import { useEffect, useRef } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import type {
  SidebarFilter,
  SidebarState,
} from './useSidebarState'

/** Collapsed rail width in pixels. Founder decision 3. */
export const SIDEBAR_COLLAPSED_WIDTH_PX = 28
/** Expanded sidebar width in pixels. Founder decision 3. */
export const SIDEBAR_EXPANDED_WIDTH_PX = 200

const FILTER_OPTIONS: ReadonlyArray<{ value: SidebarFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'mapped', label: 'Mapped' },
  { value: 'unmapped', label: 'Unmapped' },
]

export interface SourceSchemaSidebarProps {
  /** Current sidebar state. Comes from `useSidebarState` in the parent. */
  state: SidebarState
  /** Current filter selection. Comes from `useSidebarState`. */
  filter: SidebarFilter
  /**
   * Called when the user clicks the rail to expand or the close chevron
   * to collapse. Parent is expected to forward to
   * `useSidebarState.setSidebarState` so the change persists.
   */
  onStateChange: (next: SidebarState) => void
  /**
   * Called when the user clicks a filter pill. Parent is expected to
   * forward to `useSidebarState.setSidebarFilter`. Gap 11a does not
   * apply filter logic to a fields list (the list does not yet exist);
   * we still write through to localStorage so the user's preference
   * survives until Gap 11b wires the rendering.
   */
  onFilterChange: (next: SidebarFilter) => void
}

/**
 * Source schema sidebar — Gap 11a structural shell.
 *
 * Renders a left-edge persistent sidebar with two states:
 *   - Collapsed (28 px): a vertical "Source fields" affordance acting
 *     as the click target to expand.
 *   - Expanded (200 px): header + search + filter pills + empty-state
 *     placeholder for the fields list (Gap 11b fills the list).
 *
 * The component is presentational — it does NOT own persistence, and
 * it does NOT participate in any auto-collapse-on-narrow-viewport
 * logic. Persistence is supplied by `useSidebarState` (parent owns the
 * hook); auto-collapse is supplied by the parent's matchMedia effect.
 * This separation keeps the sidebar reusable in tests without
 * matchMedia mocks and without the parent's drawer state machine.
 */
export function SourceSchemaSidebar({
  state,
  filter,
  onStateChange,
  onFilterChange,
}: SourceSchemaSidebarProps) {
  const railRef = useRef<HTMLButtonElement | null>(null)
  const chevronRef = useRef<HTMLButtonElement | null>(null)
  // 'expand' or 'collapse' marks a user-initiated state change so the
  // post-commit effect knows whether to move focus. A null value
  // signals "non-interactive update" — for example, the hydration pass
  // in `useSidebarState` switching to a persisted 'expanded' state on
  // first render, which should NOT steal focus from the user.
  const lastUserActionRef = useRef<'expand' | 'collapse' | null>(null)

  useEffect(() => {
    const action = lastUserActionRef.current
    lastUserActionRef.current = null
    if (action === 'expand') {
      chevronRef.current?.focus()
    } else if (action === 'collapse') {
      railRef.current?.focus()
    }
  }, [state])

  const handleExpand = () => {
    lastUserActionRef.current = 'expand'
    onStateChange('expanded')
  }
  const handleCollapse = () => {
    lastUserActionRef.current = 'collapse'
    onStateChange('collapsed')
  }

  return (
    <aside
      data-testid="source-schema-sidebar"
      data-state={state}
      aria-label="Source schema browser"
      className={cn(
        'relative z-20 flex flex-shrink-0 flex-col self-stretch overflow-hidden',
        'border-r border-slate-200 bg-white',
        'transition-[width] duration-150 ease-out motion-reduce:transition-none',
      )}
      style={{
        width:
          state === 'collapsed'
            ? `${SIDEBAR_COLLAPSED_WIDTH_PX}px`
            : `${SIDEBAR_EXPANDED_WIDTH_PX}px`,
      }}
    >
      {state === 'collapsed' ? (
        // ── Collapsed rail ────────────────────────────────────────────
        // A single full-height button — clicking anywhere on the rail
        // expands the sidebar. The vertical "Source fields" label and
        // the count placeholder stack at the TOP of the rail
        // (`justify-start` + ~16px top padding) so the affordance
        // lands in the user's first scan zone rather than after a tall
        // empty column.
        <button
          ref={railRef}
          type="button"
          onClick={handleExpand}
          data-testid="source-schema-sidebar-rail"
          aria-label="Expand source schema browser"
          className={cn(
            'flex h-full w-full flex-col items-center justify-start gap-2 px-1 pb-3 pt-4',
            'text-slate-500 hover:bg-slate-50 hover:text-slate-700',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500',
            'transition-colors motion-reduce:transition-none',
          )}
        >
          <span
            // `writing-mode: vertical-rl` rotates the text container so
            // letters stack vertically reading top-down by default; the
            // 180deg rotation flips it to read bottom-to-top, which is
            // the conventional orientation for vertical sidebar labels.
            // Tailwind has no built-in utility for either; we use
            // arbitrary-property classes so the value lives in markup
            // (no separate CSS file edit).
            className="text-[11px] font-medium tracking-wide [transform:rotate(180deg)] [writing-mode:vertical-rl]"
          >
            Source fields
          </span>
          <span
            data-testid="source-schema-sidebar-count"
            aria-hidden="true"
            className="text-[11px] font-medium text-slate-400"
          >
            —
          </span>
        </button>
      ) : (
        // ── Expanded panel ────────────────────────────────────────────
        <div className="flex h-full w-full flex-col">
          {/* Header */}
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <span className="text-xs font-semibold text-slate-700">
              Source fields
            </span>
            <span
              data-testid="source-schema-sidebar-count"
              className="text-xs font-medium text-slate-400"
            >
              —
            </span>
            <button
              ref={chevronRef}
              type="button"
              onClick={handleCollapse}
              data-testid="source-schema-sidebar-collapse"
              aria-label="Collapse source schema browser"
              className={cn(
                'ml-auto inline-flex h-5 w-5 items-center justify-center rounded',
                'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                'transition-colors motion-reduce:transition-none',
              )}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Search — Gap 11a renders visible but unwired (no onChange).
              Gap 11b will replace this with a controlled, debounced
              input. Kept as an uncontrolled input so the field accepts
              focus and keystrokes (visible-but-non-functional, per
              founder spec). */}
          <div className="border-b border-slate-200 px-3 py-2">
            <input
              type="text"
              placeholder="Search…"
              data-testid="source-schema-sidebar-search"
              aria-label="Search source fields"
              className={cn(
                'w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs',
                'text-slate-700 placeholder:text-slate-400',
                'focus:outline-none focus:ring-1 focus:ring-blue-500',
              )}
            />
          </div>

          {/* Filter pills — Gap 11a renders visual selection only. Gap
              11b wires the predicate against the rendered fields list. */}
          <div
            role="group"
            aria-label="Filter source fields"
            className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-2"
          >
            {FILTER_OPTIONS.map((opt) => {
              const isActive = filter === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onFilterChange(opt.value)}
                  data-testid={`source-schema-sidebar-filter-${opt.value}`}
                  aria-pressed={isActive}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                    'transition-colors motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* Fields list area — Gap 11a placeholder. Gap 11b renders
              the field rows with hover tooltips and click-highlight
              wiring. */}
          <div
            data-testid="source-schema-sidebar-list"
            className="flex-1 overflow-auto px-3 py-3 text-[11px] leading-relaxed text-slate-400"
          >
            Source fields data coming in Gap 11b
          </div>
        </div>
      )}
    </aside>
  )
}
