import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  SourceDisambiguationDialog,
  type PendingSourceDisambiguation,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/SourceDisambiguationDialog'

const PENDING_SINGLE_EXISTING: PendingSourceDisambiguation = {
  rowId: 'tfm-existing',
  existingTfmId: 'tfm-existing',
  targetFieldId: 'tf-item-number',
  targetFieldName: 'Item Number',
  existingSources: [
    {
      id: 'ms-1',
      sourceFieldName: 'Assy Item',
      sourceTableName: 'EBM',
    },
  ],
  incomingSource: {
    sourceFieldId: 'sf-productsku',
    sourceFieldName: 'ProductSKU',
    sourceTableName: 'ICC',
  },
}

const PENDING_MULTI_EXISTING: PendingSourceDisambiguation = {
  rowId: 'tfm-existing',
  existingTfmId: 'tfm-existing',
  targetFieldId: 'tf-item-number',
  targetFieldName: 'Item Number',
  existingSources: [
    { id: 'ms-1', sourceFieldName: 'Assy Item', sourceTableName: 'EBM' },
    { id: 'ms-2', sourceFieldName: 'Item Code', sourceTableName: 'EBM' },
  ],
  incomingSource: {
    sourceFieldId: 'sf-part',
    sourceFieldName: 'Part #',
    sourceTableName: 'EIM',
  },
}

describe('SourceDisambiguationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when no disambiguation is pending', () => {
    render(
      <SourceDisambiguationDialog
        pending={null}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen.queryByTestId('source-disambiguation-dialog'),
    ).not.toBeInTheDocument()
  })

  it('renders target field, existing source, and incoming source copy', () => {
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const dialog = screen.getByTestId('source-disambiguation-dialog')
    expect(dialog).toHaveTextContent('Item Number')
    expect(dialog).toHaveTextContent('Assy Item')
    expect(dialog).toHaveTextContent('EBM')
    expect(dialog).toHaveTextContent('ProductSKU')
    expect(dialog).toHaveTextContent('ICC')
  })

  it('formats multi-source existing list as readable prose', () => {
    render(
      <SourceDisambiguationDialog
        pending={PENDING_MULTI_EXISTING}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const dialog = screen.getByTestId('source-disambiguation-dialog')
    expect(dialog).toHaveTextContent('Assy Item and Item Code')
  })

  it('renders all four option surfaces — create, combine (greyed), replace, cancel', () => {
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByTestId('source-disambiguation-create-separate')).toBeInTheDocument()
    expect(screen.getByTestId('source-disambiguation-combine')).toBeInTheDocument()
    expect(screen.getByTestId('source-disambiguation-replace')).toBeInTheDocument()
    expect(screen.getByTestId('source-disambiguation-cancel')).toBeInTheDocument()
  })

  it('Combine option is greyed (disabled) and carries the tooltip', () => {
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const combine = screen.getByTestId('source-disambiguation-combine')
    expect(combine.hasAttribute('disabled')).toBe(true)
    expect(combine.getAttribute('title')).toMatch(
      /Cross-table JOIN not yet supported/,
    )
  })

  it('Create separate invokes onCreateSeparate (and not onReplace)', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const onReplace = vi.fn().mockResolvedValue(undefined)
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={onCreate}
        onReplace={onReplace}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('source-disambiguation-create-separate'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onReplace).not.toHaveBeenCalled()
  })

  it('Replace existing invokes onReplace (and not onCreateSeparate)', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const onReplace = vi.fn().mockResolvedValue(undefined)
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={onCreate}
        onReplace={onReplace}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('source-disambiguation-replace'))
    await waitFor(() => expect(onReplace).toHaveBeenCalledTimes(1))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('Cancel invokes onCancel only', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined)
    const onReplace = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={onCreate}
        onReplace={onReplace}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('source-disambiguation-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCreate).not.toHaveBeenCalled()
    expect(onReplace).not.toHaveBeenCalled()
  })

  it('disables every actionable option while a confirm is in flight', () => {
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen
        .getByTestId('source-disambiguation-create-separate')
        .hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen.getByTestId('source-disambiguation-replace').hasAttribute('disabled'),
    ).toBe(true)
    expect(
      screen.getByTestId('source-disambiguation-cancel').hasAttribute('disabled'),
    ).toBe(true)
    // Combine remains greyed independently of the in-flight state.
    expect(
      screen.getByTestId('source-disambiguation-combine').hasAttribute('disabled'),
    ).toBe(true)
  })

  it('does not fire a second confirm if the user clicks twice mid-flight', async () => {
    // Slow-resolving handler — simulates the server round-trip window.
    let resolve!: () => void
    const slowPromise = new Promise<void>((r) => {
      resolve = r
    })
    const onCreate = vi.fn().mockReturnValue(slowPromise)
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={onCreate}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const button = screen.getByTestId('source-disambiguation-create-separate')
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onCreate).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
  })

  it('Escape key dismisses the dialog via onCancel', () => {
    const onCancel = vi.fn()
    render(
      <SourceDisambiguationDialog
        pending={PENDING_SINGLE_EXISTING}
        isPending={false}
        onCreateSeparate={vi.fn().mockResolvedValue(undefined)}
        onReplace={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
