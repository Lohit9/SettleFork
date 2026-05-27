/**
 * FlatPartitionChip component tests (PR Ω.3.2.2 §5 FPC1–8).
 *
 * Built on Radix Popover, which has the same jsdom pointer-event
 * issues as Radix Select. Module-mock the Popover primitives with
 * a flat inline-render shim so the checkbox list is always present
 * in the DOM (tests don't need the open/close lifecycle — they
 * exercise the chip's behavior shape, not Radix's portal mechanics).
 *
 * 8 invariant groups (FPC1–FPC8):
 *   FPC1 — auto-hide when partitionsEnabled === false
 *   FPC2 — auto-hide when no target_table has >= 2 partitions
 *   FPC3 — trigger renders when both gates pass
 *   FPC4 — trigger label (size 0/1/N)
 *   FPC5 — options grouped by target_table; only multi-partition tables surface
 *   FPC6 — checkbox toggle fires onChange with the updated Set
 *   FPC7 — Clear button resets to empty
 *   FPC8 — active-state styling (bg-blue-50/60) when selected
 */

import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { FlatPartitionChip } from '@/app/app/projects/[projectId]/mapping/redesign/components/FlatPartitionChip'
import type {
  PartitionInfo,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

// ─── Radix Popover shim — inline children, no portal ─────────────────────
//
// Same rationale as the Select shim in partition-rules-modal.test.tsx:
// jsdom lacks Radix's required pointer-event polyfills. The shim
// renders Trigger AND Content unconditionally inline; tests query
// checkboxes / Clear button without needing the open/close cycle.
vi.mock('@/components/ui/popover', () => {
  function Popover({ children }: { children: React.ReactNode }) {
    return <div data-testid="popover-root">{children}</div>
  }
  function PopoverTrigger({
    children,
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) {
    return <>{children}</>
  }
  function PopoverContent({
    children,
    className,
    ...props
  }: {
    children?: React.ReactNode
    className?: string
    [k: string]: unknown
  }) {
    return (
      <div className={className} {...props}>
        {children}
      </div>
    )
  }
  function PopoverPortal({ children }: { children: React.ReactNode }) {
    return <>{children}</>
  }
  function PopoverClose({ children }: { children: React.ReactNode }) {
    return <>{children}</>
  }
  return { Popover, PopoverTrigger, PopoverContent, PopoverPortal, PopoverClose }
})

// ─── Fixtures ─────────────────────────────────────────────────────────────

const tableA: TargetTableSummary = {
  id: 'tt-a',
  name: 'accounts',
  datasetName: 'erp',
  fieldCount: 5,
}
const tableB: TargetTableSummary = {
  id: 'tt-b',
  name: 'balances',
  datasetName: 'erp',
  fieldCount: 3,
}
const tableC: TargetTableSummary = {
  id: 'tt-c',
  name: 'customers',
  datasetName: 'erp',
  fieldCount: 8,
}

function partition(overrides: Partial<PartitionInfo> = {}): PartitionInfo {
  return {
    id: 'tm-default',
    label: 'Default partition',
    ordinal: 0,
    sourceTableId: 'st-1',
    sourceTableName: 'source_default',
    filterSql: null,
    identityFieldId: null,
    dedupPriority: null,
    ...overrides,
  }
}

// Multi-partition fixture: tableA has 2 partitions, tableB has 3,
// tableC has 1 (should NOT appear per Q1).
const PARTITIONS_BY_TABLE: Record<string, PartitionInfo[]> = {
  [tableA.id]: [
    partition({ id: 'tm-a-1', label: 'A1', sourceTableName: 'src_a_1' }),
    partition({ id: 'tm-a-2', label: 'A2', sourceTableName: 'src_a_2' }),
  ],
  [tableB.id]: [
    partition({ id: 'tm-b-1', label: 'B1', sourceTableName: 'src_b_1' }),
    partition({ id: 'tm-b-2', label: null, sourceTableName: 'src_b_2' }),
    partition({ id: 'tm-b-3', label: 'B3', sourceTableName: 'src_b_3' }),
  ],
  [tableC.id]: [
    // single-partition table — excluded per Q1.
    partition({ id: 'tm-c-1', label: 'C1', sourceTableName: 'src_c_1' }),
  ],
}

function renderChip(
  overrides: Partial<React.ComponentProps<typeof FlatPartitionChip>> = {},
) {
  const onChange = vi.fn()
  const props = {
    partitionsByTargetTable: PARTITIONS_BY_TABLE,
    partitionsEnabled: true,
    targetTables: [tableA, tableB, tableC] as TargetTableSummary[],
    selectedPartitionIds: new Set<string>(),
    onChange,
    ...overrides,
  }
  const utils = render(<FlatPartitionChip {...props} />)
  return { ...utils, onChange, props }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── FPC1 — auto-hide on partitionsEnabled=false ────────────────────────

describe('[FlatPartitionChip] FPC1 — auto-hide when partitions disabled', () => {
  it('renders NOTHING when partitionsEnabled is false', () => {
    const { container } = renderChip({ partitionsEnabled: false })
    expect(container.firstChild).toBeNull()
  })
})

// ─── FPC2 — auto-hide when no multi-partition table ─────────────────────

describe('[FlatPartitionChip] FPC2 — auto-hide when no multi-partition table', () => {
  it('renders NOTHING when every target_table has <= 1 partition', () => {
    const { container } = renderChip({
      partitionsByTargetTable: {
        [tableA.id]: [partition({ id: 'tm-a-1', label: 'Solo A' })],
        [tableC.id]: [partition({ id: 'tm-c-1', label: 'Solo C' })],
      },
    })
    expect(container.firstChild).toBeNull()
  })

  it('renders NOTHING when partitionsByTargetTable is empty', () => {
    const { container } = renderChip({ partitionsByTargetTable: {} })
    expect(container.firstChild).toBeNull()
  })
})

// ─── FPC3 — trigger renders when both gates pass ────────────────────────

describe('[FlatPartitionChip] FPC3 — trigger renders when gates pass', () => {
  it('renders the trigger button + popover content when gates pass', () => {
    renderChip()
    expect(screen.getByTestId('filter-flat-partition')).toBeInTheDocument()
    expect(screen.getByTestId('filter-flat-partition-popover')).toBeInTheDocument()
  })
})

// ─── FPC4 — trigger label (size 0 / 1 / N) ──────────────────────────────

describe('[FlatPartitionChip] FPC4 — trigger label', () => {
  it('"All partitions" when nothing is selected (size=0)', () => {
    renderChip()
    expect(screen.getByTestId('filter-flat-partition')).toHaveTextContent(/All partitions/)
  })

  it('"<partition label>" when exactly one is selected', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-2']) })
    expect(screen.getByTestId('filter-flat-partition')).toHaveTextContent(/A2/)
  })

  it('falls back to source-table-name when label is null and one is selected', () => {
    // tm-b-2 has label: null, sourceTableName: 'src_b_2'.
    renderChip({ selectedPartitionIds: new Set(['tm-b-2']) })
    expect(screen.getByTestId('filter-flat-partition')).toHaveTextContent(/src_b_2/)
  })

  it('"N partitions" when more than one is selected', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-1', 'tm-b-1', 'tm-b-3']) })
    expect(screen.getByTestId('filter-flat-partition')).toHaveTextContent(/3 partitions/)
  })

  it('"1 partition" fallback when the sole selected id is not in any group (stale URL)', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-deleted']) })
    // Stale id → no match in groups → falls back to plural-style placeholder.
    expect(screen.getByTestId('filter-flat-partition')).toHaveTextContent(/1 partition/)
  })
})

// ─── FPC5 — options grouped by target_table; multi-partition only ───────

describe('[FlatPartitionChip] FPC5 — option grouping + Q1 exclusion', () => {
  it('renders one group per target_table with >= 2 partitions', () => {
    renderChip()
    expect(screen.getByTestId(`flat-partition-group-${tableA.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`flat-partition-group-${tableB.id}`)).toBeInTheDocument()
  })

  it('EXCLUDES single-partition target_tables from option groups (Q1)', () => {
    renderChip()
    // tableC has only 1 partition; must NOT appear.
    expect(screen.queryByTestId(`flat-partition-group-${tableC.id}`)).toBeNull()
  })

  it('renders one checkbox per partition (5 total — 2 + 3)', () => {
    renderChip()
    expect(screen.getByTestId('flat-partition-option-tm-a-1')).toBeInTheDocument()
    expect(screen.getByTestId('flat-partition-option-tm-a-2')).toBeInTheDocument()
    expect(screen.getByTestId('flat-partition-option-tm-b-1')).toBeInTheDocument()
    expect(screen.getByTestId('flat-partition-option-tm-b-2')).toBeInTheDocument()
    expect(screen.getByTestId('flat-partition-option-tm-b-3')).toBeInTheDocument()
    expect(screen.queryByTestId('flat-partition-option-tm-c-1')).toBeNull()
  })

  it('outer group order is alphabetical by table name (accounts before balances)', () => {
    const { container } = renderChip()
    const groups = container.querySelectorAll('[data-testid^="flat-partition-group-"]')
    expect(groups[0]).toHaveAttribute('data-testid', `flat-partition-group-${tableA.id}`)
    expect(groups[1]).toHaveAttribute('data-testid', `flat-partition-group-${tableB.id}`)
  })
})

// ─── FPC6 — checkbox toggle fires onChange ──────────────────────────────

describe('[FlatPartitionChip] FPC6 — checkbox onChange dispatch', () => {
  it('checking an unselected partition fires onChange with the id added', () => {
    const { onChange } = renderChip({ selectedPartitionIds: new Set(['tm-a-1']) })
    fireEvent.click(
      screen.getByTestId('flat-partition-option-tm-b-1').querySelector('input')!,
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    const arg = onChange.mock.calls[0][0] as ReadonlySet<string>
    expect([...arg].sort()).toEqual(['tm-a-1', 'tm-b-1'])
  })

  it('unchecking a selected partition fires onChange with the id removed', () => {
    const { onChange } = renderChip({
      selectedPartitionIds: new Set(['tm-a-1', 'tm-a-2']),
    })
    fireEvent.click(
      screen.getByTestId('flat-partition-option-tm-a-1').querySelector('input')!,
    )
    expect(onChange).toHaveBeenCalledTimes(1)
    const arg = onChange.mock.calls[0][0] as ReadonlySet<string>
    expect([...arg]).toEqual(['tm-a-2'])
  })

  it('selected partitions render as checked', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-1', 'tm-b-3']) })
    const a1 = screen
      .getByTestId('flat-partition-option-tm-a-1')
      .querySelector('input') as HTMLInputElement
    const a2 = screen
      .getByTestId('flat-partition-option-tm-a-2')
      .querySelector('input') as HTMLInputElement
    const b3 = screen
      .getByTestId('flat-partition-option-tm-b-3')
      .querySelector('input') as HTMLInputElement
    expect(a1).toBeChecked()
    expect(a2).not.toBeChecked()
    expect(b3).toBeChecked()
  })
})

// ─── FPC7 — Clear button resets to empty ────────────────────────────────

describe('[FlatPartitionChip] FPC7 — Clear button', () => {
  it('Clear button fires onChange with an empty Set', () => {
    const { onChange } = renderChip({
      selectedPartitionIds: new Set(['tm-a-1', 'tm-b-1']),
    })
    fireEvent.click(screen.getByTestId('filter-flat-partition-clear'))
    expect(onChange).toHaveBeenCalledTimes(1)
    const arg = onChange.mock.calls[0][0] as ReadonlySet<string>
    expect(arg.size).toBe(0)
  })

  it('Clear button is DISABLED when no partitions are selected', () => {
    renderChip({ selectedPartitionIds: new Set() })
    expect(screen.getByTestId('filter-flat-partition-clear')).toBeDisabled()
  })

  it('summary text reflects the selection count', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-1', 'tm-b-1']) })
    expect(screen.getByTestId('filter-flat-partition-summary')).toHaveTextContent(
      /2 partitions selected/,
    )
  })

  it('summary uses singular form for size=1', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-1']) })
    expect(screen.getByTestId('filter-flat-partition-summary')).toHaveTextContent(
      /^1 partition selected$/,
    )
  })
})

// ─── FPC8 — active-state trigger styling ────────────────────────────────

describe('[FlatPartitionChip] FPC8 — active-state styling', () => {
  it('trigger carries the active blue tint when at least one partition is selected', () => {
    renderChip({ selectedPartitionIds: new Set(['tm-a-1']) })
    expect(screen.getByTestId('filter-flat-partition').className).toMatch(/bg-blue-50/)
    expect(screen.getByTestId('filter-flat-partition').className).toMatch(/text-blue-900/)
  })

  it('trigger DOES NOT carry the active tint when nothing is selected', () => {
    renderChip({ selectedPartitionIds: new Set() })
    expect(screen.getByTestId('filter-flat-partition').className).not.toMatch(/bg-blue-50/)
  })
})
