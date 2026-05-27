'use client'

/**
 * PartitionTabs — horizontal tab strip rendered above a TargetTableGroup
 * when the target table has 2+ partitions OR `partitions_enabled` is set
 * (pilot opt-in). Selecting a tab filters the parent group's rows by the
 * selected partition's `table_mapping_id`.
 *
 * AUTO-HIDE INVARIANT — byte-identity for heritage projects:
 *   When `partitions.length === 1 && !allowCreate`, the component returns
 *   null. Zero DOM presence. Heritage projects render identically to
 *   pre-Ω.3.2 because every target_table has exactly 1 TM and
 *   `partitions_enabled` defaults to false.
 *
 * AFFORDANCES (per design doc §6.1 + §6.2):
 *   - One tab per partition; active state via `data-state="active"`
 *   - Tab label falls back to `partition.sourceTableName` when
 *     `partition.label` is null
 *   - [⚙] icon per-tab → opens PartitionRulesModal in edit mode (Q7)
 *   - "+ Add Partition" tab on the right edge → opens modal in create mode
 *     (gated on `allowCreate=true`)
 *
 * STYLING — follows the legacy `CursorTabs` pattern (plain buttons, no
 * Radix dep). No `dark:` prefixes — redesign-tree invariant documented
 * in FieldMappingRow.tsx.
 *
 * STATE OWNERSHIP — parent (MappingContent or TargetTableGroup wrapper)
 * owns `selectedPartitionId` as URL-derived state (`?partition=<id>`);
 * this component is purely presentational + dispatches callbacks.
 */

import * as React from 'react'
import { cn } from '@/components/ui/utils'
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

interface PartitionTabsProps {
  /** All partitions for this target table, server-ordered. */
  partitions: PartitionInfo[]
  /** Currently selected partition's table_mapping_id (URL-driven). */
  selectedPartitionId: string | null
  /** Click handler for a partition tab. */
  onPartitionChange: (partitionId: string) => void
  /** Gates the "+ Add Partition" tab. Sourced from
   *  `MappingsForRedesignResult.partitionsEnabled`
   *  (i.e. `projects.partitions_enabled`). Heritage = false → hidden. */
  allowCreate: boolean
  /** Click handler for the "+ Add Partition" tab. */
  onAddPartition: () => void
  /** Click handler for the per-tab [⚙] edit icon. Receives the partition
   *  the user wants to edit. */
  onEditPartition: (partition: PartitionInfo) => void
  /** The target_table_id this strip belongs to. Threaded through to the
   *  modal so it knows the parent table context. Not used by the tab
   *  component itself but kept on the prop surface so callers can't
   *  forget to provide it. */
  targetTableId: string
}

/**
 * Tab label resolution: explicit partition_label first, then source table
 * name as fallback. Matches the design doc §3.1 spec.
 */
function tabLabelFor(partition: PartitionInfo): string {
  if (partition.label && partition.label.trim().length > 0) {
    return partition.label
  }
  if (partition.sourceTableName && partition.sourceTableName.trim().length > 0) {
    return partition.sourceTableName
  }
  // Last-ditch fallback — shouldn't render in practice (sourceTableName is
  // server-derived from a join), but keeps the UI from rendering an empty
  // tab if data drifts.
  return 'Partition'
}

export function PartitionTabs({
  partitions,
  selectedPartitionId,
  onPartitionChange,
  allowCreate,
  onAddPartition,
  onEditPartition,
  // targetTableId is held in the closure of the parent's callbacks; not
  // used directly by this component but kept on the prop surface for
  // clarity and to forbid forgotten wiring.
  targetTableId: _targetTableId,
}: PartitionTabsProps) {
  // Auto-hide invariant: zero DOM when N≤1 and the project hasn't opted
  // into partitions. Returns null so the parent group renders identically
  // to pre-Ω.3.2. The length-0 branch guards against a degenerate
  // server state (no TMs at all) — empty `<div role="tablist">` is
  // visual noise, not heritage byte-identity.
  if (partitions.length <= 1 && !allowCreate) {
    return null
  }

  return (
    <div
      role="tablist"
      aria-label="Partitions"
      data-testid="partition-tabs"
      className="flex items-center gap-1 border-b border-gray-200 bg-white px-3 py-1.5"
    >
      {partitions.map((partition) => {
        const isActive = partition.id === selectedPartitionId
        const label = tabLabelFor(partition)
        return (
          <div
            key={partition.id}
            className={cn(
              'group inline-flex items-center rounded-md transition-colors',
              isActive ? 'bg-gray-100' : 'hover:bg-gray-50',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              data-state={isActive ? 'active' : 'inactive'}
              data-partition-id={partition.id}
              onClick={() => onPartitionChange(partition.id)}
              className={cn(
                'px-3 py-1 text-sm font-medium transition-colors',
                isActive ? 'text-gray-900' : 'text-gray-600 hover:text-gray-900',
              )}
            >
              {label}
            </button>
            <button
              type="button"
              aria-label={`Edit partition ${label}`}
              data-testid={`partition-edit-${partition.id}`}
              onClick={(e) => {
                e.stopPropagation()
                onEditPartition(partition)
              }}
              className={cn(
                'mr-1 inline-flex h-5 w-5 items-center justify-center rounded',
                'text-gray-400 opacity-0 transition-opacity',
                'group-hover:opacity-100 focus:opacity-100',
                'hover:bg-gray-200 hover:text-gray-600',
                'focus:outline-none focus:ring-1 focus:ring-blue-500',
              )}
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}

      {allowCreate ? (
        <button
          type="button"
          aria-label="Add partition"
          data-testid="partition-add"
          onClick={onAddPartition}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-3 py-1',
            'text-sm font-medium text-gray-500',
            'transition-colors hover:bg-gray-50 hover:text-gray-700',
            'focus:outline-none focus:ring-1 focus:ring-blue-500',
          )}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          <span>Add partition</span>
        </button>
      ) : null}
    </div>
  )
}

// ─── Inline icons (small, no extra dependency) ──────────────────────────

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="1.5" />
      <path d="M8 1.5v1.75M8 12.75v1.75M14.5 8h-1.75M3.25 8H1.5M12.6 3.4l-1.24 1.24M4.64 11.36 3.4 12.6M12.6 12.6l-1.24-1.24M4.64 4.64 3.4 3.4" />
    </svg>
  )
}
