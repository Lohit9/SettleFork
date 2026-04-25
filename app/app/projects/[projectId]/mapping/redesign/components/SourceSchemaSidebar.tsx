'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3, Gap 11a (shell) + 11b (content + interactions).
// ─────────────────────────────────────────────────────────────────────────────
//
// Persistent left-side sidebar for browsing the project's source schema.
// Gap 11a shipped the SHELL (width animation, persistence, expand/collapse,
// accessibility). Gap 11b fills the field rendering, filter logic, search
// wiring with debounce, hover tooltips, and click-to-highlight wiring.
//
// LAYOUT
//
//   Collapsed (28px)        Expanded (200px)
//   ┌──────┐                ┌────────────────────┐
//   │ S    │                │ Source fields  N ⟨ │  ← header w/ close chev
//   │ o    │                ├────────────────────┤
//   │ u    │                │ [search…         ] │
//   │ r    │                ├────────────────────┤
//   │ c    │                │ [All][Mapped][Un…] │  ← filter pills + counts
//   │ e    │                ├────────────────────┤
//   │      │                │ ▾ CIF_MASTER (8)   │
//   │  N   │                │   • field_a        │  ← status dot + name
//   │      │                │   • field_b        │
//   │      │                │ ▾ ACCT_HIST (6)    │
//   │      │                │   …                │
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
//   - Filter pills are `aria-pressed` toggle buttons within an
//     `aria-label="Filter source fields"` group.
//   - Field rows are `<button>` with `aria-pressed={isHighlighted}` so
//     screen readers announce the active highlight state.
//   - Hover tooltip is wired with `aria-describedby` so focus reveals
//     the same content as hover.
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

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { formatSampleValues } from '@/lib/utils/mapping-drawer-format'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'
import type {
  SidebarFilter,
  SidebarState,
} from './useSidebarState'

/** Collapsed rail width in pixels. Founder decision 3. */
export const SIDEBAR_COLLAPSED_WIDTH_PX = 28
/** Expanded sidebar width in pixels. Founder decision 3. */
export const SIDEBAR_EXPANDED_WIDTH_PX = 200
/**
 * Debounce window for the search input — 200 ms before the typed value
 * propagates into the filter pipeline. Matches the main-view search
 * debounce in `redesign/MappingContent.tsx` for consistent feel.
 */
export const SIDEBAR_SEARCH_DEBOUNCE_MS = 200

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
   * forward to `useSidebarState.setSidebarFilter`.
   */
  onFilterChange: (next: SidebarFilter) => void
  /**
   * Source fields decorated with mapping state, in canonical server
   * order (`sourceTable.name ASC, ordinalPosition ASC, name ASC`). The
   * sidebar groups by `sourceTable.id` preserving server order — Map
   * insertion order yields canonical group order automatically.
   *
   * Always present (possibly empty). When empty, the list area shows
   * a "no source schema ingested" empty state.
   */
  sourceFields: SourceFieldWithState[]
  /**
   * Phase 3 Gap 11b — id of the source field whose main-view rows are
   * currently highlighted, or `null` if no highlight is active.
   * Drives the visual "active" state on the matching field row inside
   * the sidebar. Single-select: only one source field at a time.
   */
  highlightedSourceFieldId?: string | null
  /**
   * Phase 3 Gap 11b — called when the user clicks a field row.
   * Single-select toggle: clicking the already-highlighted field
   * clears the highlight; clicking a different field replaces it.
   * Optional so the sidebar still renders in test fixtures that
   * don't exercise the highlight wiring.
   */
  onFieldClick?: (fieldId: string) => void
}

/**
 * Source schema sidebar — Gap 11a shell + Gap 11b content.
 *
 * Renders a left-edge persistent sidebar with two states:
 *   - Collapsed (28 px): a vertical "Source fields" affordance with a
 *     count badge, acting as the click target to expand.
 *   - Expanded (200 px): header + search + filter pills + grouped
 *     field rows.
 *
 * The component is presentational — it does NOT own persistence, and
 * it does NOT participate in any auto-collapse-on-narrow-viewport
 * logic. Persistence is supplied by `useSidebarState` (parent owns the
 * hook); auto-collapse is supplied by the parent's matchMedia effect.
 * This separation keeps the sidebar reusable in tests without
 * matchMedia mocks and without the parent's drawer state machine.
 *
 * NOTE — Gap 11c TODO (acknowledged-field visual treatment):
 * `SourceFieldWithState.isAcknowledged` is plumbed through the
 * contract today but Gap 11b does NOT differentiate acknowledged
 * fields visually. They render identically to other unmapped fields
 * under the Unmapped pill. Gap 11c will design the dedicated
 * treatment (strike-through, muted opacity, separate sub-section,
 * etc.) pending a founder discussion. Do not add ad-hoc styling
 * here — wait for the design call.
 */
export function SourceSchemaSidebar({
  state,
  filter,
  onStateChange,
  onFilterChange,
  sourceFields,
  highlightedSourceFieldId = null,
  onFieldClick,
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

  // ── Search input — immediate visible value + debounced applied query ─
  //
  // We hold two strings: the raw `searchInput` reflects the user's
  // current keystroke (controlled input, no flicker) and the debounced
  // `searchQuery` is what the filter pipeline reads. A single 200ms
  // setTimeout covers consecutive keystrokes; clear-on-unmount keeps
  // tests deterministic.
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
    }
    searchTimerRef.current = setTimeout(() => {
      setSearchQuery(searchInput)
      searchTimerRef.current = null
    }, SIDEBAR_SEARCH_DEBOUNCE_MS)
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  }, [searchInput])

  // ── Filter pill counts ───────────────────────────────────────────
  // Derived client-side from `sourceFields` per founder decision 3
  // (Gap 11b). No extra contract surface; counts always reflect the
  // exact payload the sidebar has in memory.
  const counts = useMemo(() => {
    let mapped = 0
    let unmapped = 0
    for (const f of sourceFields) {
      if (f.mappingStatus === 'mapped') mapped++
      else unmapped++
    }
    return { all: sourceFields.length, mapped, unmapped }
  }, [sourceFields])

  // ── Filter + search pipeline ─────────────────────────────────────
  // Pure pass over `sourceFields`. Server order is preserved
  // (no `.sort()` — the redesign-path sort guard would fail otherwise).
  const visibleFields = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase()
    return sourceFields.filter((f) => {
      if (filter === 'mapped' && f.mappingStatus !== 'mapped') return false
      if (filter === 'unmapped' && f.mappingStatus !== 'unmapped') return false
      if (trimmed.length > 0) {
        const haystack = `${f.name} ${f.sourceTable.name}`.toLowerCase()
        if (!haystack.includes(trimmed)) return false
      }
      return true
    })
  }, [sourceFields, filter, searchQuery])

  // ── Group by source table (Map preserves server order) ───────────
  const groupedFields = useMemo(() => {
    const out = new Map<
      string,
      { tableName: string; fields: SourceFieldWithState[] }
    >()
    for (const f of visibleFields) {
      const existing = out.get(f.sourceTable.id)
      if (existing) {
        existing.fields.push(f)
      } else {
        out.set(f.sourceTable.id, {
          tableName: f.sourceTable.name,
          fields: [f],
        })
      }
    }
    return out
  }, [visibleFields])

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
        // the count stack at the TOP of the rail (`justify-start` +
        // ~16px top padding) so the affordance lands in the user's
        // first scan zone rather than after a tall empty column.
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
            {sourceFields.length === 0 ? '—' : counts.all}
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
              className="text-xs font-medium text-slate-400 tabular-nums"
            >
              {sourceFields.length === 0 ? '—' : counts.all}
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

          {/* Search — controlled input, debounced 200ms before applied. */}
          <div className="border-b border-slate-200 px-3 py-2">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
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

          {/* Filter pills with counts. */}
          <div
            role="group"
            aria-label="Filter source fields"
            className="flex flex-wrap gap-1 border-b border-slate-200 px-3 py-2"
          >
            {FILTER_OPTIONS.map((opt) => {
              const isActive = filter === opt.value
              const count =
                opt.value === 'all'
                  ? counts.all
                  : opt.value === 'mapped'
                    ? counts.mapped
                    : counts.unmapped
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onFilterChange(opt.value)}
                  data-testid={`source-schema-sidebar-filter-${opt.value}`}
                  aria-pressed={isActive}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums',
                    'transition-colors motion-reduce:transition-none',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                  )}
                >
                  {opt.label} {count}
                </button>
              )
            })}
          </div>

          {/* Fields list. */}
          <div
            data-testid="source-schema-sidebar-list"
            className="flex-1 overflow-y-auto"
          >
            <FieldsListBody
              groupedFields={groupedFields}
              hasSourceFields={sourceFields.length > 0}
              highlightedSourceFieldId={highlightedSourceFieldId}
              onFieldClick={onFieldClick}
            />
          </div>
        </div>
      )}
    </aside>
  )
}

// ─── Fields list body ────────────────────────────────────────────────────────

interface FieldsListBodyProps {
  groupedFields: Map<
    string,
    { tableName: string; fields: SourceFieldWithState[] }
  >
  hasSourceFields: boolean
  highlightedSourceFieldId: string | null
  onFieldClick: ((fieldId: string) => void) | undefined
}

function FieldsListBody({
  groupedFields,
  hasSourceFields,
  highlightedSourceFieldId,
  onFieldClick,
}: FieldsListBodyProps) {
  if (!hasSourceFields) {
    return (
      <div
        data-testid="source-schema-sidebar-empty-no-schema"
        className="px-3 py-6 text-[11px] leading-relaxed text-slate-400"
      >
        No source schema ingested for this project.
      </div>
    )
  }

  if (groupedFields.size === 0) {
    return (
      <div
        data-testid="source-schema-sidebar-empty-no-match"
        className="px-3 py-6 text-[11px] leading-relaxed text-slate-400"
      >
        No source fields match the current filter.
      </div>
    )
  }

  // Map iteration preserves insertion order, which mirrors server
  // ordering (sourceTable.name ASC, ordinalPosition ASC, name ASC).
  // No client-side `.sort()` here — guarded by no-shim test.
  const groupEntries = Array.from(groupedFields.entries())

  return (
    <div className="flex flex-col">
      {groupEntries.map(([tableId, group]) => (
        <SourceTableGroup
          key={tableId}
          tableName={group.tableName}
          fields={group.fields}
          highlightedSourceFieldId={highlightedSourceFieldId}
          onFieldClick={onFieldClick}
        />
      ))}
    </div>
  )
}

// ─── Source table group ──────────────────────────────────────────────────────

interface SourceTableGroupProps {
  tableName: string
  fields: SourceFieldWithState[]
  highlightedSourceFieldId: string | null
  onFieldClick: ((fieldId: string) => void) | undefined
}

function SourceTableGroup({
  tableName,
  fields,
  highlightedSourceFieldId,
  onFieldClick,
}: SourceTableGroupProps) {
  return (
    <section
      data-testid="source-schema-sidebar-group"
      data-source-table-name={tableName}
      className="border-b border-slate-100 last:border-b-0"
    >
      <header className="flex items-baseline gap-1.5 bg-slate-50/60 px-3 py-1.5">
        <h3
          className="truncate text-[11px] font-semibold uppercase tracking-wide text-slate-600"
          title={tableName}
        >
          {tableName}
        </h3>
        <span className="text-[10px] font-medium text-slate-400 tabular-nums">
          {fields.length}
        </span>
      </header>
      <ul className="flex flex-col py-0.5">
        {fields.map((field) => (
          <SourceFieldRow
            key={field.id}
            field={field}
            isHighlighted={highlightedSourceFieldId === field.id}
            onFieldClick={onFieldClick}
          />
        ))}
      </ul>
    </section>
  )
}

// ─── Source field row ────────────────────────────────────────────────────────

interface SourceFieldRowProps {
  field: SourceFieldWithState
  isHighlighted: boolean
  onFieldClick: ((fieldId: string) => void) | undefined
}

function SourceFieldRow({
  field,
  isHighlighted,
  onFieldClick,
}: SourceFieldRowProps) {
  const tooltipId = useId()
  const isClickable = onFieldClick !== undefined

  const handleClick = isClickable ? () => onFieldClick!(field.id) : undefined

  return (
    <li className="relative">
      <button
        type="button"
        onClick={handleClick}
        data-testid="source-schema-sidebar-field"
        data-source-field-id={field.id}
        data-mapping-status={field.mappingStatus}
        data-is-highlighted={isHighlighted ? 'true' : 'false'}
        aria-pressed={isClickable ? isHighlighted : undefined}
        aria-describedby={tooltipId}
        className={cn(
          'group/field relative flex w-full items-center gap-1.5 px-3 py-1 text-left',
          'text-[11px] leading-tight text-slate-700',
          'transition-colors motion-reduce:transition-none',
          isClickable
            ? 'cursor-pointer hover:bg-slate-50'
            : 'cursor-default',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500',
          isHighlighted && 'bg-blue-50',
        )}
      >
        <StatusDot mappingStatus={field.mappingStatus} />
        <span className="flex-1 truncate font-mono text-[11px]" title={field.name}>
          {field.name}
        </span>
        <FieldTooltip id={tooltipId} field={field} />
      </button>
    </li>
  )
}

// ─── Status dot ──────────────────────────────────────────────────────────────

function StatusDot({
  mappingStatus,
}: {
  mappingStatus: 'mapped' | 'unmapped'
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="source-schema-sidebar-status-dot"
      data-mapping-status={mappingStatus}
      className={cn(
        'inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
        mappingStatus === 'mapped' ? 'bg-emerald-500' : 'bg-slate-300',
      )}
    />
  )
}

// ─── Hover/focus tooltip ─────────────────────────────────────────────────────
//
// CSS-only tooltip pattern using Tailwind's group-hover + group-focus-within
// composition. Tooltip renders inside the same row as the button, anchored
// below the row (top-full) and aligned to the row's left edge. Width caps
// at the sidebar's width minus padding so values wrap inside the sidebar
// rather than spilling horizontally — the list area's `overflow-y-auto` is
// the only scroll axis, so spilling vertically is fine.
//
// Trade-off: when hovering the bottom-most row the tooltip can extend past
// the sidebar's bottom edge and clip. This is acceptable for Gap 11b — a
// portal-based tooltip with viewport repositioning is a Gap-11c upgrade if
// the clipping bites in real use. The CSS-only approach avoids running JS
// during pure hover.

function FieldTooltip({
  id,
  field,
}: {
  id: string
  field: SourceFieldWithState
}) {
  const sampleValuesText = formatSampleValues(field.sampleValues)

  return (
    <div
      id={id}
      role="tooltip"
      data-testid="source-schema-sidebar-tooltip"
      className={cn(
        'pointer-events-none absolute left-2 right-2 top-full z-50 mt-1',
        'rounded-md border border-slate-200 bg-white p-2 text-left shadow-md',
        'opacity-0 transition-opacity duration-100 motion-reduce:transition-none',
        'group-hover/field:opacity-100 group-focus-visible/field:opacity-100',
      )}
    >
      <div className="mb-0.5 font-mono text-[10px] font-semibold text-slate-900">
        {field.dataType || '—'}
      </div>
      {sampleValuesText.length > 0 ? (
        <div className="text-[10px] leading-snug text-slate-600">
          <span className="font-medium text-slate-500">Sample values: </span>
          <span className="break-words">{sampleValuesText}</span>
        </div>
      ) : (
        <div className="text-[10px] italic text-slate-400">
          No sample values profiled
        </div>
      )}
    </div>
  )
}
