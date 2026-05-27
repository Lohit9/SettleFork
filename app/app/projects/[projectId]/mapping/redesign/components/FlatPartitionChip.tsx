'use client'

/**
 * FlatPartitionChip — multi-select dropdown that scopes the flat
 * (list) view to a subset of partitions across the project.
 *
 * Mounted inside FilterRow alongside the existing single-select
 * Source / Target / Status / Confidence chips. Unlike those, this
 * chip is multi-select — the flat view is a project-wide
 * spreadsheet, and the natural mental model is "show me rows from
 * partitions A and B" (union semantics).
 *
 * AUTO-HIDE GATES — chip returns null when EITHER:
 *   1. `partitionsEnabled === false` (project hasn't opted into the
 *      partition primitive), OR
 *   2. No target table has `partitions.length >= 2` (single-partition
 *      tables would surface a checkbox with no opposing choice).
 *
 * Heritage projects (flag off, no multi-partition tables) get zero
 * chip DOM — flat view rendering is byte-identical to pre-Ω.3.2.2.
 *
 * URL: state lives in `MappingContent` (`flatPartitionSelection: Set<string>`,
 * seeded from `?flatpartitions=`). Per Ω.3.2.2 §4, this is INDEPENDENT
 * of Target-led's `?partition=` — different mental models (per-table
 * single vs project-wide multi).
 *
 * Built on Radix Popover + plain checkbox list (no Radix Select —
 * Radix Select is single-select only). Pattern reference:
 * `SourceFieldPicker` (custom inline multi-select; founder decision
 * "no Radix Combobox, no cmdk" — see SourceFieldPicker.tsx:7).
 */

import * as React from 'react'
import { ChevronDown } from '@/components/icons'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/components/ui/utils'
import type {
  PartitionInfo,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

export interface FlatPartitionChipProps {
  /** Per-target-table partition catalog from `MappingsForRedesignResult`. */
  partitionsByTargetTable: Record<string, PartitionInfo[]>
  /** `projects.partitions_enabled`. Gates chip visibility (gate #1). */
  partitionsEnabled: boolean
  /** Universe of target tables — provides the display name for each
   *  group header. */
  targetTables: readonly TargetTableSummary[]
  /** Currently selected partition ids (table_mappings.id values).
   *  Empty set = no filter active = "All partitions" trigger label. */
  selectedPartitionIds: ReadonlySet<string>
  /** Fired with the FULL updated set on every checkbox toggle.
   *  Parent commits to URL via the standard writeUrl machinery. */
  onChange: (next: ReadonlySet<string>) => void
}

/**
 * Display label resolution — mirrors `tabLabelFor` from PartitionTabs:
 * partition_label first, source_table_name as fallback, then a generic
 * sentinel for the (impossible-in-prod) double-null case.
 */
function partitionDisplayLabel(p: PartitionInfo): string {
  if (p.label && p.label.trim().length > 0) return p.label
  if (p.sourceTableName && p.sourceTableName.trim().length > 0) return p.sourceTableName
  return 'Partition'
}

export function FlatPartitionChip({
  partitionsByTargetTable,
  partitionsEnabled,
  targetTables,
  selectedPartitionIds,
  onChange,
}: FlatPartitionChipProps) {
  // Build `[{table, partitions}]` for tables with >= 2 partitions,
  // alphabetical by table name. Inner order is server-canonical
  // (PR Ω.1: `partition_ordinal ASC NULLS LAST, created_at ASC, id ASC`).
  const groups = React.useMemo(() => {
    const tablesByName = [...targetTables].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const out: Array<{ table: TargetTableSummary; partitions: PartitionInfo[] }> = []
    for (const table of tablesByName) {
      const partitions = partitionsByTargetTable[table.id] ?? []
      if (partitions.length < 2) continue
      out.push({ table, partitions })
    }
    return out
  }, [partitionsByTargetTable, targetTables])

  // Auto-hide. Heritage byte-identity guarantee.
  if (!partitionsEnabled) return null
  if (groups.length === 0) return null

  const totalSelected = selectedPartitionIds.size

  // Trigger label per §2: "All partitions" / "<label>" / "N partitions".
  // When exactly one is selected, look up its display label across all
  // visible groups so users see the partition name (not an opaque id).
  let triggerLabel: string
  if (totalSelected === 0) {
    triggerLabel = 'All partitions'
  } else if (totalSelected === 1) {
    const sole = [...selectedPartitionIds][0]
    let foundLabel: string | null = null
    for (const { partitions } of groups) {
      const match = partitions.find((p) => p.id === sole)
      if (match) {
        foundLabel = partitionDisplayLabel(match)
        break
      }
    }
    // Stale id (partition deleted after URL bookmark saved) — fall back
    // to a sensible plural-style placeholder rather than crashing or
    // showing the raw id.
    triggerLabel = foundLabel ?? '1 partition'
  } else {
    triggerLabel = `${totalSelected} partitions`
  }

  const isActive = totalSelected > 0

  const handleToggle = (id: string) => {
    const next = new Set(selectedPartitionIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  const handleClear = () => {
    onChange(new Set())
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter by partition"
          data-testid="filter-flat-partition"
          className={cn(
            'inline-flex h-8 w-auto min-w-[8rem] max-w-[14rem] items-center justify-between gap-1.5',
            'rounded-md border border-gray-300 bg-white px-3 text-xs text-gray-900',
            'transition-colors hover:bg-gray-50',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400',
            isActive && 'border-blue-200 bg-blue-50/60 text-blue-900',
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-gray-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-h-[400px] overflow-y-auto p-2"
        data-testid="filter-flat-partition-popover"
      >
        <div className="space-y-3">
          {groups.map(({ table, partitions }) => (
            <div
              key={table.id}
              data-testid={`flat-partition-group-${table.id}`}
            >
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                {table.name}
              </div>
              <ul className="space-y-0.5">
                {partitions.map((p) => {
                  const checked = selectedPartitionIds.has(p.id)
                  return (
                    <li key={p.id}>
                      <label
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-gray-50"
                        data-testid={`flat-partition-option-${p.id}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggle(p.id)}
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-xs text-gray-900">
                          {partitionDisplayLabel(p)}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-gray-100 px-2 pt-2">
          <span
            className="text-[10px] text-gray-500"
            data-testid="filter-flat-partition-summary"
          >
            {totalSelected === 0
              ? 'No partitions selected'
              : `${totalSelected} partition${totalSelected === 1 ? '' : 's'} selected`}
          </span>
          <button
            type="button"
            data-testid="filter-flat-partition-clear"
            onClick={handleClear}
            disabled={totalSelected === 0}
            className="text-[10px] font-medium text-gray-700 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
