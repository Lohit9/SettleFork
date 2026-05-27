import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PartitionTabs } from '@/app/app/projects/[projectId]/mapping/redesign/components/PartitionTabs'
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

// ─── Fixtures ────────────────────────────────────────────────────────────

function partition(overrides: Partial<PartitionInfo> = {}): PartitionInfo {
  return {
    id: 'tm-1',
    label: 'Engineering items',
    ordinal: 0,
    sourceTableId: 'src-tbl-1',
    sourceTableName: 'engineering_bom_masters',
    filterSql: null,
    identityFieldId: null,
    dedupPriority: null,
    ...overrides,
  }
}

// ─── PT1 — Auto-hide invariant (heritage byte-identity) ─────────────────

describe('[PartitionTabs] PT1 — auto-hide for heritage projects', () => {
  it('renders nothing when partitions.length === 1 and allowCreate is false', () => {
    const { container } = render(
      <PartitionTabs
        partitions={[partition()]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when partitions.length === 0 and allowCreate is false', () => {
    // Empty array edge case — pre-Ω.1 projects with no TMs at all.
    const { container } = render(
      <PartitionTabs
        partitions={[]}
        selectedPartitionId={null}
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ─── PT2 — Single partition + allowCreate (pilot opt-in) ────────────────

describe('[PartitionTabs] PT2 — single partition with allowCreate=true', () => {
  it('renders the single tab plus the "Add partition" button', () => {
    render(
      <PartitionTabs
        partitions={[partition({ label: 'Sole partition' })]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.getByRole('tab', { name: /Sole partition/ })).toBeInTheDocument()
    expect(screen.getByTestId('partition-add')).toBeInTheDocument()
  })
})

// ─── PT3 — Multi-partition strip ────────────────────────────────────────

describe('[PartitionTabs] PT3 — multi-partition strip', () => {
  const partitions = [
    partition({ id: 'tm-a', label: 'A' }),
    partition({ id: 'tm-b', label: 'B' }),
    partition({ id: 'tm-c', label: 'C' }),
  ]

  it('renders one tab per partition', () => {
    render(
      <PartitionTabs
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })

  it('marks the selected tab as active via data-state="active"', () => {
    render(
      <PartitionTabs
        partitions={partitions}
        selectedPartitionId="tm-b"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.find((t) => t.getAttribute('data-state') === 'active')?.textContent).toBe('B')
  })

  it('active tab has aria-selected="true"; siblings are false', () => {
    render(
      <PartitionTabs
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    const tabs = screen.getAllByRole('tab')
    const active = tabs.find((t) => t.textContent === 'A')
    const inactive = tabs.find((t) => t.textContent === 'B')
    expect(active?.getAttribute('aria-selected')).toBe('true')
    expect(inactive?.getAttribute('aria-selected')).toBe('false')
  })

  it('hides the "Add partition" tab when allowCreate=false', () => {
    render(
      <PartitionTabs
        partitions={partitions}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.queryByTestId('partition-add')).toBeNull()
  })
})

// ─── PT4 — Click handlers ───────────────────────────────────────────────

describe('[PartitionTabs] PT4 — click handlers', () => {
  it('clicking a tab fires onPartitionChange with the partition id', async () => {
    const handler = vi.fn()
    render(
      <PartitionTabs
        partitions={[partition({ id: 'tm-a', label: 'A' }), partition({ id: 'tm-b', label: 'B' })]}
        selectedPartitionId="tm-a"
        onPartitionChange={handler}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    await userEvent.click(screen.getByRole('tab', { name: /B/ }))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('tm-b')
  })

  it('clicking the "Add partition" button fires onAddPartition', async () => {
    const handler = vi.fn()
    render(
      <PartitionTabs
        partitions={[partition()]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={handler}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    await userEvent.click(screen.getByTestId('partition-add'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('clicking the [⚙] icon on a tab fires onEditPartition with the partition', async () => {
    const partA = partition({ id: 'tm-a', label: 'A' })
    const partB = partition({ id: 'tm-b', label: 'B' })
    const handler = vi.fn()
    render(
      <PartitionTabs
        partitions={[partA, partB]}
        selectedPartitionId="tm-a"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={handler}
        targetTableId="tt-1"
      />,
    )
    await userEvent.click(screen.getByTestId('partition-edit-tm-b'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(partB)
  })

  it('edit-icon click does NOT also fire onPartitionChange (event.stopPropagation)', async () => {
    const onChange = vi.fn()
    const onEdit = vi.fn()
    render(
      <PartitionTabs
        partitions={[partition({ id: 'tm-a', label: 'A' }), partition({ id: 'tm-b', label: 'B' })]}
        selectedPartitionId="tm-a"
        onPartitionChange={onChange}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={onEdit}
        targetTableId="tt-1"
      />,
    )
    await userEvent.click(screen.getByTestId('partition-edit-tm-b'))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  })
})

// ─── PT5 — Label fallback ───────────────────────────────────────────────

describe('[PartitionTabs] PT5 — tab label fallback', () => {
  it('uses partition.label when present', () => {
    render(
      <PartitionTabs
        partitions={[partition({ label: 'Custom Label' })]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.getByRole('tab', { name: /Custom Label/ })).toBeInTheDocument()
  })

  it('falls back to sourceTableName when label is null', () => {
    render(
      <PartitionTabs
        partitions={[partition({ label: null, sourceTableName: 'fallback_source' })]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.getByRole('tab', { name: /fallback_source/ })).toBeInTheDocument()
  })

  it('falls back to "Partition" placeholder when label AND sourceTableName are empty', () => {
    render(
      <PartitionTabs
        partitions={[partition({ label: null, sourceTableName: '' })]}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={true}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    expect(screen.getByRole('tab', { name: /Partition/ })).toBeInTheDocument()
  })
})

// ─── PT6 — Tab order preserved from props ───────────────────────────────

describe('[PartitionTabs] PT6 — tab order respects prop order (server-canonical)', () => {
  it('renders tabs in the order they appear in `partitions` prop', () => {
    // Server emits in `partition_ordinal ASC NULLS LAST, created_at ASC, id ASC`.
    // Component must NOT re-sort; just iterates the prop.
    const partitions = [
      partition({ id: 'tm-3', label: 'Third' }),
      partition({ id: 'tm-1', label: 'First' }),
      partition({ id: 'tm-2', label: 'Second' }),
    ]
    render(
      <PartitionTabs
        partitions={partitions}
        selectedPartitionId="tm-1"
        onPartitionChange={vi.fn()}
        allowCreate={false}
        onAddPartition={vi.fn()}
        onEditPartition={vi.fn()}
        targetTableId="tt-1"
      />,
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent)).toEqual(['Third', 'First', 'Second'])
  })
})
