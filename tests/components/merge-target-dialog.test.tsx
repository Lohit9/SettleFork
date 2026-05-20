import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MergeTargetDialog } from '@/app/app/projects/[projectId]/mapping/redesign/components/MergeTargetDialog'
import type { PendingTargetMerge } from '@/app/app/projects/[projectId]/mapping/redesign/hooks/useMappingListMutations'

const PENDING: PendingTargetMerge = {
  swappingTfmId: 'tfm-swapping',
  newTargetFieldId: 'tf-new',
  preview: {
    conflictingTfmId: 'tfm-survivor',
    targetFieldName: 'customer_email',
    existingSourceNames: ['EMAIL_ADDR'],
    incomingSourceNames: ['CONTACT_EMAIL', 'ALT_EMAIL'],
  },
}

describe('MergeTargetDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when no merge is pending', () => {
    render(
      <MergeTargetDialog
        pendingMerge={null}
        isPending={false}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('merge-target-dialog')).not.toBeInTheDocument()
  })

  it('renders the merge preview — target, existing source, and incoming sources', () => {
    render(
      <MergeTargetDialog
        pendingMerge={PENDING}
        isPending={false}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const dialog = screen.getByTestId('merge-target-dialog')
    expect(dialog).toHaveTextContent('customer_email')
    expect(dialog).toHaveTextContent('EMAIL_ADDR')
    // Incoming sources rendered as readable prose.
    expect(dialog).toHaveTextContent('CONTACT_EMAIL and ALT_EMAIL')
    expect(dialog).toHaveTextContent('multi-source mapping')
  })

  it('Proceed invokes onConfirm', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <MergeTargetDialog
        pendingMerge={PENDING}
        isPending={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('merge-target-dialog-confirm'))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('Cancel invokes onCancel and not onConfirm', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    render(
      <MergeTargetDialog
        pendingMerge={PENDING}
        isPending={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('merge-target-dialog-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('disables both buttons and shows progress while the merge is pending', () => {
    render(
      <MergeTargetDialog
        pendingMerge={PENDING}
        isPending
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )
    const confirm = screen.getByTestId('merge-target-dialog-confirm')
    const cancel = screen.getByTestId('merge-target-dialog-cancel')
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(cancel.hasAttribute('disabled')).toBe(true)
    expect(confirm).toHaveTextContent('Merging')
  })
})
