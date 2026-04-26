'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2/4a-3 — Source field picker for the W1 manual mapping creation form.
// ─────────────────────────────────────────────────────────────────────────────
//
// Custom inline multi-select picker (founder decision 3 — no Radix
// Combobox, no cmdk). Reads from the page-level `sourceFields` array
// already supplied by the Gap 11b contract and surfaces an in-form
// view with:
//
//   • A search input at top (debounced — `SEARCH_DEBOUNCE_MS`)
//   • A chip strip of currently selected fields, grouped by source
//     table with subtle "Dominant" / "Joined" small-caps headers
//   • Grouped list of source fields (all tables visible)
//   • ✓ marker + tinted background on selected rows
//
// CROSS-TABLE SUPPORT (Phase 4a-3)
//
// The same-table constraint introduced in 4a-2 has been lifted: the
// picker no longer hides non-dominant source tables, and the muted
// footer note pointing at 4a-3 has been removed. The wrapper now
// performs an FK precheck and surfaces disambiguation through
// `CreateMappingForm`'s inline dropdown when needed.
//
// First-picked stable for dominant: the ordering of `selectedIds` is
// preserved verbatim — index 0 = ordinal 0 = dominant source. The
// picker never re-anchors when the user adds joined chips (§3-OQ-1).
//
// CHIP GROUPING (Phase 4a-3 — §3-OQ-2 / §3-OQ-3)
//
//   • Same-table selection (all chips from one source table) →
//     flat single-row chip strip, no headers.
//   • Cross-table selection (2+ source tables among chips) → chips
//     grouped under "DOMINANT" and "JOINED" small-caps text headers.
//     Within each group the per-table sub-grouping carries a faint
//     table name pill so the user can tell "joined chips from CIF"
//     apart from "joined chips from BRANCH" at a glance.
//
// HOVER TOOLTIP
//
// Reuses the CSS-only group-hover pattern from `SourceSchemaSidebar`'s
// `FieldTooltip` (Gap 11b) — same visual + a11y contract: tooltip
// renders inside the row, anchored below, exposed to screen readers
// via `aria-describedby`. No portal, no JS, no library dependency.
// Acceptable trade-off (already documented at the sidebar): the
// bottom-most row's tooltip can clip the picker's overflow boundary.
// Will revisit in 4a-5 polish if smoke-test feedback bites.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { SEARCH_DEBOUNCE_MS } from '@/lib/constants/redesign-ui'
import { formatSampleValues } from '@/lib/utils/mapping-drawer-format'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

export interface SourceFieldPickerProps {
  /**
   * Page-level source fields in canonical server order
   * (`sourceTable.name ASC, ordinalPosition ASC, name ASC`). Picker
   * iterates verbatim — no client-side `.sort()`. May be empty when
   * the project has no ingested source schema yet.
   */
  availableSourceFields: SourceFieldWithState[]
  /**
   * Currently selected source field ids. Order is the user's selection
   * order: index 0 = dominant source (ordinal 0 in the new mapping).
   */
  selectedIds: string[]
  /**
   * Called whenever the user toggles a field's selection. Receives the
   * full next list (selection order preserved) so the parent does not
   * have to derive add-vs-remove semantics.
   */
  onSelectedChange: (next: string[]) => void
  /**
   * Disables every interactive element inside the picker. Used while
   * the discard-confirm dialog is open or while a save is in flight.
   * Visual state stays unchanged — the picker is only de-interactivated.
   */
  disabled?: boolean
}

/**
 * Manual mapping source field picker.
 *
 * Component is presentational + state-light: it only owns the search
 * input's controlled value + debounced query. Selected ids are owned
 * by the parent (`CreateMappingForm`) so the form can compute dirty
 * state and the sample preview from one source of truth.
 */
export function SourceFieldPicker({
  availableSourceFields,
  selectedIds,
  onSelectedChange,
  disabled = false,
}: SourceFieldPickerProps) {
  // ── Search — controlled input + debounced query ───────────────────
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

  // ── Derived selected-field objects (in selection order) ───────────
  // We resolve the chip list by walking `selectedIds` (preserves user
  // order) rather than `availableSourceFields` (would force server
  // canonical order). Lookup map is small + cheap; rebuilds on
  // available-fields change.
  const fieldsById = useMemo(() => {
    const m = new Map<string, SourceFieldWithState>()
    for (const f of availableSourceFields) m.set(f.id, f)
    return m
  }, [availableSourceFields])

  const selectedFields = useMemo<SourceFieldWithState[]>(() => {
    const out: SourceFieldWithState[] = []
    for (const id of selectedIds) {
      const f = fieldsById.get(id)
      if (f) out.push(f)
    }
    return out
  }, [selectedIds, fieldsById])

  // ── Visible fields: search filter only (cross-table allowed) ──────
  const visibleFields = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase()
    if (trimmed.length === 0) return availableSourceFields
    return availableSourceFields.filter((field) => {
      const haystack = `${field.name} ${field.sourceTable.name}`.toLowerCase()
      return haystack.includes(trimmed)
    })
  }, [availableSourceFields, searchQuery])

  // ── Group by source table (Map preserves server order) ───────────
  const grouped = useMemo(() => {
    const out = new Map<
      string,
      { tableName: string; fields: SourceFieldWithState[] }
    >()
    for (const field of visibleFields) {
      const existing = out.get(field.sourceTable.id)
      if (existing) {
        existing.fields.push(field)
      } else {
        out.set(field.sourceTable.id, {
          tableName: field.sourceTable.name,
          fields: [field],
        })
      }
    }
    return out
  }, [visibleFields])

  const handleToggle = (id: string) => {
    if (disabled) return
    if (selectedIds.includes(id)) {
      onSelectedChange(selectedIds.filter((x) => x !== id))
    } else {
      onSelectedChange([...selectedIds, id])
    }
  }

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  return (
    <div data-testid="source-field-picker" className="flex flex-col gap-2">
      <SelectedChipsRow
        fields={selectedFields}
        onRemove={handleToggle}
        disabled={disabled}
      />
      <SearchInput
        value={searchInput}
        onChange={setSearchInput}
        disabled={disabled}
      />
      <div
        data-testid="source-field-picker-list"
        className={cn(
          'flex max-h-72 flex-col overflow-y-auto rounded border border-slate-200',
          disabled && 'opacity-60',
        )}
      >
        <FieldsListBody
          grouped={grouped}
          hasFields={availableSourceFields.length > 0}
          selectedSet={selectedSet}
          onToggle={handleToggle}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

// ── Selected chips ───────────────────────────────────────────────────────────
//
// Layout rules (Phase 4a-3):
//
//   • 0 chips                    → empty-state line.
//   • 1+ chips, 1 source table   → flat single-row chip strip.
//   • 1+ chips, 2+ source tables → grouped under DOMINANT / JOINED
//     small-caps headers; within JOINED the chips remain in selection
//     order. The dominant table is always the first selected chip's
//     table (§3-OQ-1: stable, no re-anchor).

function SelectedChipsRow({
  fields,
  onRemove,
  disabled,
}: {
  fields: SourceFieldWithState[]
  onRemove: (id: string) => void
  disabled: boolean
}) {
  if (fields.length === 0) {
    return (
      <p
        data-testid="source-field-picker-chips-empty"
        className="text-[11px] italic text-slate-400"
      >
        No source fields selected yet.
      </p>
    )
  }

  // Determine cross-table state up-front. The dominant table id is
  // the first chip's table (selection order is the source of truth).
  const dominantTableId = fields[0].sourceTable.id
  const uniqueTableIds = new Set(fields.map((f) => f.sourceTable.id))
  const isCrossTable = uniqueTableIds.size > 1

  if (!isCrossTable) {
    // Single-table case: collapse to flat chip strip with no group
    // headers. Visually identical to the 4a-2 shape.
    return (
      <ul
        data-testid="source-field-picker-chips"
        data-cross-table="false"
        className="flex flex-wrap gap-1.5"
      >
        {fields.map((field) => (
          <ChipListItem
            key={field.id}
            field={field}
            onRemove={onRemove}
            disabled={disabled}
          />
        ))}
      </ul>
    )
  }

  // Cross-table: split into dominant + joined buckets. Within
  // `joinedFields` we preserve selection order, so a user picking
  // CIF.A → BRANCH.B → CIF.C ends up with chips [CIF.A] under
  // dominant and [BRANCH.B, CIF.C] under joined — order matches
  // input ordinal.
  const dominantFields = fields.filter(
    (f) => f.sourceTable.id === dominantTableId,
  )
  const joinedFields = fields.filter(
    (f) => f.sourceTable.id !== dominantTableId,
  )

  return (
    <div
      data-testid="source-field-picker-chips"
      data-cross-table="true"
      className="flex flex-col gap-1.5"
    >
      <ChipGroup
        label="Dominant"
        testId="source-field-picker-chips-dominant"
        fields={dominantFields}
        onRemove={onRemove}
        disabled={disabled}
      />
      <ChipGroup
        label="Joined"
        testId="source-field-picker-chips-joined"
        fields={joinedFields}
        onRemove={onRemove}
        disabled={disabled}
      />
    </div>
  )
}

function ChipGroup({
  label,
  testId,
  fields,
  onRemove,
  disabled,
}: {
  label: string
  testId: string
  fields: SourceFieldWithState[]
  onRemove: (id: string) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span
        className={cn(
          'text-[9px] font-semibold uppercase tracking-[0.08em]',
          'text-slate-400',
        )}
      >
        {label}
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {fields.map((field) => (
          <ChipListItem
            key={field.id}
            field={field}
            onRemove={onRemove}
            disabled={disabled}
          />
        ))}
      </ul>
    </div>
  )
}

function ChipListItem({
  field,
  onRemove,
  disabled,
}: {
  field: SourceFieldWithState
  onRemove: (id: string) => void
  disabled: boolean
}) {
  return (
    <li>
      <span
        data-testid="source-field-picker-chip"
        data-source-field-id={field.id}
        data-source-table-id={field.sourceTable.id}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full',
          'border border-blue-200 bg-blue-50 px-2 py-0.5',
          'text-[11px] font-medium text-blue-900',
        )}
      >
        <span className="font-mono">{field.name}</span>
        <span className="text-blue-400">·</span>
        <span className="text-blue-700">{field.sourceTable.name}</span>
        <button
          type="button"
          onClick={() => onRemove(field.id)}
          disabled={disabled}
          data-testid="source-field-picker-chip-remove"
          aria-label={`Remove ${field.name}`}
          className={cn(
            'inline-flex h-3.5 w-3.5 items-center justify-center rounded-full',
            'text-blue-500 hover:bg-blue-100 hover:text-blue-800',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    </li>
  )
}

// ── Search input ─────────────────────────────────────────────────────────────

function SearchInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Search source fields…"
      disabled={disabled}
      data-testid="source-field-picker-search"
      aria-label="Search source fields"
      className={cn(
        'w-full rounded border border-slate-200 bg-white px-2 py-1 text-xs',
        'text-slate-700 placeholder:text-slate-400',
        'focus:outline-none focus:ring-1 focus:ring-blue-500',
        'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
      )}
    />
  )
}

// ── Fields list body ─────────────────────────────────────────────────────────

interface FieldsListBodyProps {
  grouped: Map<
    string,
    { tableName: string; fields: SourceFieldWithState[] }
  >
  hasFields: boolean
  selectedSet: Set<string>
  onToggle: (id: string) => void
  disabled: boolean
}

function FieldsListBody({
  grouped,
  hasFields,
  selectedSet,
  onToggle,
  disabled,
}: FieldsListBodyProps) {
  if (!hasFields) {
    return (
      <div
        data-testid="source-field-picker-empty-no-schema"
        className="px-3 py-6 text-center text-[11px] italic text-slate-400"
      >
        No source schema ingested yet. Use the legacy Mapping view.
      </div>
    )
  }
  if (grouped.size === 0) {
    return (
      <div
        data-testid="source-field-picker-empty-no-match"
        className="px-3 py-6 text-center text-[11px] italic text-slate-400"
      >
        No source fields match the current search.
      </div>
    )
  }

  // Map iteration preserves insertion order, which matches the server
  // canonical order. Convert to an array purely for React's keyed list
  // ergonomics — no client-side `.sort()`.
  const groupEntries = Array.from(grouped.entries())

  return (
    <div className="flex flex-col">
      {groupEntries.map(([tableId, group]) => (
        <SourceTableGroup
          key={tableId}
          tableName={group.tableName}
          fields={group.fields}
          selectedSet={selectedSet}
          onToggle={onToggle}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

// ── Source table group ───────────────────────────────────────────────────────

function SourceTableGroup({
  tableName,
  fields,
  selectedSet,
  onToggle,
  disabled,
}: {
  tableName: string
  fields: SourceFieldWithState[]
  selectedSet: Set<string>
  onToggle: (id: string) => void
  disabled: boolean
}) {
  return (
    <section
      data-testid="source-field-picker-group"
      data-source-table-name={tableName}
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
            isSelected={selectedSet.has(field.id)}
            onToggle={onToggle}
            disabled={disabled}
          />
        ))}
      </ul>
    </section>
  )
}

// ── Field row + tooltip ──────────────────────────────────────────────────────

interface PickerFieldRowProps {
  field: SourceFieldWithState
  isSelected: boolean
  onToggle: (id: string) => void
  disabled: boolean
}

function PickerFieldRow({
  field,
  isSelected,
  onToggle,
  disabled,
}: PickerFieldRowProps) {
  const tooltipId = useId()
  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onToggle(field.id)}
        disabled={disabled}
        data-testid="source-field-picker-field"
        data-source-field-id={field.id}
        data-mapping-status={field.mappingStatus}
        data-is-selected={isSelected ? 'true' : 'false'}
        aria-pressed={isSelected}
        aria-describedby={tooltipId}
        className={cn(
          'group/field relative flex w-full items-center gap-1.5 px-3 py-1 text-left',
          'text-[11px] leading-tight text-slate-700',
          'transition-colors motion-reduce:transition-none',
          'cursor-pointer hover:bg-slate-50',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-blue-500',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent',
          isSelected && 'bg-blue-50',
        )}
      >
        <SelectionIndicator isSelected={isSelected} />
        <span
          className="flex-1 truncate font-mono text-[11px]"
          title={field.name}
        >
          {field.name}
        </span>
        <FieldTooltip id={tooltipId} field={field} />
      </button>
    </li>
  )
}

function SelectionIndicator({ isSelected }: { isSelected: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="source-field-picker-selection-indicator"
      className={cn(
        'inline-flex h-3 w-3 flex-shrink-0 items-center justify-center rounded-sm border',
        isSelected
          ? 'border-blue-500 bg-blue-500 text-white'
          : 'border-slate-300 bg-white',
      )}
    >
      {isSelected ? (
        <svg
          viewBox="0 0 12 12"
          className="h-2.5 w-2.5"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M3 6.5l2 2 4-4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  )
}

// ── Hover tooltip ────────────────────────────────────────────────────────────
//
// CSS-only — same pattern as `SourceSchemaSidebar`'s `FieldTooltip`.
// Hover OR focus reveals; no JS during pure interaction. Acceptable
// clipping at picker bottom edge per Gap 11b precedent.

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
      data-testid="source-field-picker-tooltip"
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
