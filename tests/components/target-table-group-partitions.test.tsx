/**
 * TargetTableGroup × PartitionTabs wire-shape tests (PR Ω.3.2 commit 4).
 *
 * Verifies the integration contract introduced in commit 4:
 *   - PartitionTabs is mounted inside TargetTableGroup when partition
 *     props are wired
 *   - Heritage byte-identity holds (no partition-tabs DOM when no props
 *     wired OR when length<=1 AND !partitionsEnabled)
 *   - Tab click → onPartitionChange with the partition id
 *   - "+ Add partition" → onOpenPartitionModal({kind:'create'})
 *   - [⚙] → onOpenPartitionModal({kind:'edit', partition})
 *
 * Plus DrawerHeader partition annotation visibility from commit 4.
 */

import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import { DrawerHeader } from '@/app/app/projects/[projectId]/mapping/redesign/components/DrawerHeader'
import type {
  MappedRow,
  MappingSourceRef,
  PartitionInfo,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
} from '@/lib/types/mappings-for-redesign'

// ─── Fixtures ────────────────────────────────────────────────────────────

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'accounts' },
    ordinalPosition: 1,
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 98,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: {
      id: 'sf-1',
      name: 'ACCT_NO',
      dataType: 'NUMBER',
      isNullable: false,
    },
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...overrides,
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'tfm-1',
    targetField: targetField(),
    confidence: 98,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    sources: [source()],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

function unmapped(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-u',
    targetField: targetField({ id: 'tf-u', name: 'missing_field' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    ...overrides,
  }
}

function partition(overrides: Partial<PartitionInfo> = {}): PartitionInfo {
  return {
    id: 'tm-1',
    label: 'Engineering items',
    ordinal: 0,
    sourceTableId: 'st-1',
    sourceTableName: 'engineering_bom_masters',
    filterSql: null,
    identityFieldId: null,
    dedupPriority: null,
    ...overrides,
  }
}

const summary: TargetTableSummary = {
  id: 'tt-1',
  name: 'item_master',
  datasetName: 'Rootstock',
  fieldCount: 3,
}

// ─── PG1 — Heritage byte-identity ───────────────────────────────────────

describe('[TargetTableGroup × PartitionTabs] PG1 — heritage byte-identity', () => {
  it('renders NO partition-tabs DOM when no partition props are wired (legacy/fixture call)', () => {
    render(<TargetTableGroup targetTable={summary} rows={[mapped()]} />)
    expect(screen.queryByTestId('partition-tabs')).toBeNull()
  })

  it('renders NO partition-tabs DOM when partitions.length=1 AND partitionsEnabled=false', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={[partition({ label: null })]}
        selectedPartitionId={null}
        onPartitionChange={vi.fn()}
        partitionsEnabled={false}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    // PartitionTabs.tsx auto-hide guard: length<=1 && !allowCreate → null.
    expect(screen.queryByTestId('partition-tabs')).toBeNull()
  })

  it('still renders the rows + header when partition strip is hidden', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={[partition({ label: null })]}
        selectedPartitionId={null}
        onPartitionChange={vi.fn()}
        partitionsEnabled={false}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    expect(screen.getByText('item_master')).toBeInTheDocument()
    expect(screen.getAllByTestId('field-mapping-row')).toHaveLength(1)
  })
})

// ─── PG2 — Pilot opt-in (single partition + partitionsEnabled) ──────────

describe('[TargetTableGroup × PartitionTabs] PG2 — pilot opt-in', () => {
  it('renders the strip when partitions.length=1 AND partitionsEnabled=true', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={[partition({ label: 'Sole' })]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        partitionsEnabled={true}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    expect(screen.getByTestId('partition-tabs')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Sole/ })).toBeInTheDocument()
    expect(screen.getByTestId('partition-add')).toBeInTheDocument()
  })
})

// ─── PG3 — Multi-partition strip ────────────────────────────────────────

describe('[TargetTableGroup × PartitionTabs] PG3 — multi-partition strip', () => {
  const partitions = [
    partition({ id: 'tm-a', label: 'Engineering' }),
    partition({ id: 'tm-b', label: 'Products' }),
    partition({ id: 'tm-c', label: 'Inventory' }),
  ]

  it('renders one tab per partition + the strip wrapper', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        partitionsEnabled={false}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    expect(screen.getByTestId('partition-tabs')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('hides "+ Add partition" when partitionsEnabled=false (length>1 + no opt-in)', () => {
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        partitionsEnabled={false}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('partition-add')).toBeNull()
  })

  it('tab click fires onPartitionChange with the partition id', () => {
    const onChange = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={onChange}
        partitionsEnabled={false}
        onOpenPartitionModal={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /Products/ }))
    expect(onChange).toHaveBeenCalledWith('tm-b')
  })
})

// ─── PG4 — Modal trigger callbacks (create + edit) ──────────────────────

describe('[TargetTableGroup × PartitionTabs] PG4 — onOpenPartitionModal dispatch', () => {
  const partitions = [
    partition({ id: 'tm-a', label: 'A' }),
    partition({ id: 'tm-b', label: 'B' }),
  ]

  it('+ Add partition fires onOpenPartitionModal with create kind + targetTableId', () => {
    const onOpen = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        partitionsEnabled={true}
        onOpenPartitionModal={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('partition-add'))
    expect(onOpen).toHaveBeenCalledWith({
      kind: 'create',
      targetTableId: 'tt-1',
    })
  })

  it('[⚙] fires onOpenPartitionModal with edit kind + partition + targetTableId', () => {
    const onOpen = vi.fn()
    render(
      <TargetTableGroup
        targetTable={summary}
        rows={[mapped()]}
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        partitionsEnabled={false}
        onOpenPartitionModal={onOpen}
      />,
    )
    fireEvent.click(screen.getByTestId('partition-edit-tm-b'))
    expect(onOpen).toHaveBeenCalledWith({
      kind: 'edit',
      targetTableId: 'tt-1',
      partition: partitions[1],
    })
  })
})

// ─── DH1 — DrawerHeader partition annotation ────────────────────────────

describe('[DrawerHeader] DH1 — partition annotation visibility', () => {
  function makeRow(partitionLabel: string | null | undefined): MappedRow {
    return mapped({
      partitionLabel,
      tableMappingId: 'tm-x',
    })
  }

  it('OMITS the partition line when row.partitionLabel is null (heritage)', () => {
    render(
      <DrawerHeader row={makeRow(null)} titleId="t" onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('mapping-drawer-header-partition')).toBeNull()
  })

  it('OMITS the partition line when row.partitionLabel is undefined (back-compat)', () => {
    render(
      <DrawerHeader row={makeRow(undefined)} titleId="t" onClose={vi.fn()} />,
    )
    expect(screen.queryByTestId('mapping-drawer-header-partition')).toBeNull()
  })

  it('RENDERS "Partition: <label>" when row.partitionLabel is a string', () => {
    render(
      <DrawerHeader
        row={makeRow('Engineering items')}
        titleId="t"
        onClose={vi.fn()}
      />,
    )
    const node = screen.getByTestId('mapping-drawer-header-partition')
    expect(node).toBeInTheDocument()
    expect(node).toHaveTextContent(/Partition:/)
    expect(node).toHaveTextContent(/Engineering items/)
  })

  it('annotation renders ABOVE the title (mapping label → partition → title order)', () => {
    const { container } = render(
      <DrawerHeader
        row={makeRow('Engineering items')}
        titleId="t"
        onClose={vi.fn()}
      />,
    )
    const label = container.querySelector('[data-testid="mapping-drawer-header-label"]')
    const part = container.querySelector('[data-testid="mapping-drawer-header-partition"]')
    const title = container.querySelector('[data-testid="mapping-drawer-header-title"]')
    expect(label).not.toBeNull()
    expect(part).not.toBeNull()
    expect(title).not.toBeNull()
    // DOM source order: label → partition → title.
    // `compareDocumentPosition`: bit 4 = FOLLOWING (other is after this).
    expect(label!.compareDocumentPosition(part!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(part!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('also renders for value_assignment + unmapped rows when partitionLabel set', () => {
    // Defensive cross-kind smoke. The same MappingRowBase field powers
    // all three kinds — the annotation must not be gated on row.kind.
    render(
      <DrawerHeader
        row={unmapped({ partitionLabel: 'Inventory items', tableMappingId: 'tm-u' })}
        titleId="t-u"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('mapping-drawer-header-partition')).toHaveTextContent(
      /Inventory items/,
    )
  })
})
