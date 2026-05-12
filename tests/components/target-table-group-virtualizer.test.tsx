import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { RefObject } from 'react'
import type {
  MappedRow,
  MappingRow,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

// Regression guard for PR 111 / VIRT2 at the call-site level: a ≥50-row
// TargetTableGroup MUST call element-based `useVirtualizer` with a
// `getScrollElement` function, and MUST NOT call window-scoped
// `useWindowVirtualizer` (the source of the whitespace bug — the page's
// outer wrapper is `min-h-0 flex-1 overflow-hidden`, so the window
// itself does not scroll).

const virtualizerStub = {
  getVirtualItems: () => [],
  getTotalSize: () => 0,
  measureElement: () => undefined,
  options: { scrollMargin: 0 },
}

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => virtualizerStub),
  useWindowVirtualizer: vi.fn(() => virtualizerStub),
}))

// Mocks must be hoisted above imports of the unit under test.
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'

const summary: TargetTableSummary = {
  id: 'tt-icc',
  name: 'inventory_commodity_code',
  datasetName: 'Heritage Core',
  fieldCount: 60,
}

function makeRow(i: number): MappedRow {
  return {
    kind: 'mapped',
    id: `tfm-${i}`,
    targetField: {
      id: `tf-${i}`,
      name: `field_${i}`,
      dataType: 'VARCHAR(200)',
      isNullable: true,
      defaultValue: null,
      targetTable: { id: 'tt-icc', name: 'inventory_commodity_code' },
      ordinalPosition: i,
      isPrimaryKey: false,
      isForeignKey: false,
      fkReference: null,
      description: null,
      sampleValues: [],
    },
    confidence: 90,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    sources: [],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
  }
}

const scrollContainerRef: RefObject<HTMLDivElement | null> = { current: null }

describe('TargetTableGroup — virtualizer scroll element (PR 111)', () => {
  // 60 rows > 50-row threshold → VirtualizedRowList mounts, so the
  // virtualizer hook fires once during commit.
  beforeEach(() => {
    vi.mocked(useVirtualizer).mockClear()
    vi.mocked(useWindowVirtualizer).mockClear()
    const rows: MappingRow[] = Array.from({ length: 60 }, (_, i) => makeRow(i))
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={rows}
        scrollContainerRef={scrollContainerRef}
      />,
    )
  })

  it('uses element-based useVirtualizer for ≥50-row groups', () => {
    expect(useVirtualizer).toHaveBeenCalled()
  })

  it('does NOT use useWindowVirtualizer (the source of the whitespace bug)', () => {
    expect(useWindowVirtualizer).not.toHaveBeenCalled()
  })

  it('passes a getScrollElement function in the virtualizer options', () => {
    const options = vi.mocked(useVirtualizer).mock.calls[0]?.[0]
    expect(options).toBeDefined()
    expect(typeof options?.getScrollElement).toBe('function')
  })
})
