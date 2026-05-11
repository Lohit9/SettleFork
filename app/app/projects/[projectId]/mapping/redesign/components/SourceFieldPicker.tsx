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
//   • A chip strip of currently selected fields, grouped per source
//     table (Cycle 1 — no DOMINANT/JOINED primacy distinction)
//   • Grouped list of source fields (all tables visible)
//   • ✓ marker + tinted background on selected rows
//
// CROSS-TABLE SUPPORT
//
// All source tables are visible regardless of which table the user
// selected first. The wrapper allows authoring cross-table TFMs
// without an FK precheck; multi-candidate ambiguity surfaces at
// Transform-tab apply time as `CROSS_TABLE_FK_INFERENCE_FAILED`.
//
// Selection ordering: `selectedIds` is preserved verbatim — index 0 =
// ordinal 0. The first-listed source's table is the apply anchor
// under the hood (Cycle 1: first-source-wins for table_mapping
// ownership), but the picker UI does NOT advertise this.
//
// CHIP GROUPING (Cycle 1 — per-source-table grouping)
//
//   • Same-table selection (all chips from one source table) →
//     flat single-row chip strip, no headers.
//   • Cross-table selection (2+ source tables among chips) → chips
//     grouped under per-table small-caps headers. All groups render
//     identically (no primacy distinction). Header order is
//     alphabetical (inherited from `availableSourceFields`'s server
//     canonical order — `sourceTable.name ASC`); within each group
//     chips preserve selection order.
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
import { TableBadge } from './TableBadge'

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
   * order: index 0 = ordinal 0 in the new mapping. Cycle 1 — the first
   * entry's source table acts as the apply anchor under the hood
   * (table_mapping ownership), but the picker UI does NOT advertise
   * this.
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
  /**
   * When true, the selected-chips row at the top of the picker is
   * omitted entirely (including the "No source fields selected yet"
   * empty state). Added for the Mapping list view's single-pick
   * auto-commit cell editor, where there is no concept of an
   * accumulating selection. Default false preserves the
   * CreateMappingForm / target-led inline picker UX byte-identical.
   */
  hideChips?: boolean
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
  hideChips = false,
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
      {hideChips ? null : (
        <SelectedChipsRow
          fields={selectedFields}
          availableSourceFields={availableSourceFields}
          onRemove={handleToggle}
          disabled={disabled}
        />
      )}
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
// Layout rules (Cycle 1 — no DOMINANT/JOINED primacy distinction):
//
//   • 0 chips                    → empty-state line.
//   • 1+ chips, 1 source table   → flat single-row chip strip.
//   • 1+ chips, 2+ source tables → grouped per source table. All
//     groups render identically (no primacy label). Group order
//     follows `availableSourceFields`'s server canonical order
//     (`sourceTable.name ASC`) so headers appear alphabetically
//     without a client-side `.sort()`. Within each group chips
//     preserve selection order.

function SelectedChipsRow({
  fields,
  availableSourceFields,
  onRemove,
  disabled,
}: {
  fields: SourceFieldWithState[]
  availableSourceFields: SourceFieldWithState[]
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

  // Cross-table: bucket chips per source table. Walk the selected
  // `fields` so each bucket preserves selection order. Determine
  // bucket display order by walking `availableSourceFields` (server
  // canonical order = `sourceTable.name ASC`) and emitting any
  // bucket whose tableId is present — alphabetical without a
  // client-side `.sort()`.
  const fieldsByTableId = new Map<
    string,
    { tableName: string; fields: SourceFieldWithState[] }
  >()
  for (const field of fields) {
    const existing = fieldsByTableId.get(field.sourceTable.id)
    if (existing) {
      existing.fields.push(field)
    } else {
      fieldsByTableId.set(field.sourceTable.id, {
        tableName: field.sourceTable.name,
        fields: [field],
      })
    }
  }
  const orderedBuckets: Array<{
    tableId: string
    tableName: string
    fields: SourceFieldWithState[]
  }> = []
  const emittedTableIds = new Set<string>()
  for (const field of availableSourceFields) {
    const tableId = field.sourceTable.id
    if (emittedTableIds.has(tableId)) continue
    const bucket = fieldsByTableId.get(tableId)
    if (!bucket) continue
    emittedTableIds.add(tableId)
    orderedBuckets.push({
      tableId,
      tableName: bucket.tableName,
      fields: bucket.fields,
    })
  }

  return (
    <div
      data-testid="source-field-picker-chips"
      data-cross-table="true"
      className="flex flex-col gap-1.5"
    >
      {orderedBuckets.map((bucket) => (
        <ChipGroup
          key={bucket.tableId}
          label={bucket.tableName}
          tableId={bucket.tableId}
          fields={bucket.fields}
          onRemove={onRemove}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

function ChipGroup({
  label,
  tableId,
  fields,
  onRemove,
  disabled,
}: {
  label: string
  tableId: string
  fields: SourceFieldWithState[]
  onRemove: (id: string) => void
  disabled: boolean
}) {
  return (
    <div
      className="flex flex-col gap-1"
      data-testid="source-field-picker-chips-group"
      data-source-table-id={tableId}
      data-source-table-name={label}
    >
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
        <TableBadge
          tableName={field.sourceTable.name}
          size="sm"
          className="shrink-0"
        />
        <span
          className="flex-1 truncate font-mono text-[11px]"
          title={`${field.sourceTable.name} · ${field.name}`}
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
