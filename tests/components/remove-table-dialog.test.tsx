/**
 * RemoveTableDialog component tests.
 *
 * Covers Stop 2 test plan items 10-14: title + description copy, cancel UX,
 * happy-path confirm, mid-flight loading state, error rendering.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { RemoveTableDialog } from '@/app/app/projects/[projectId]/project/RemoveTableDialog'

function renderDialog(overrides: Partial<React.ComponentProps<typeof RemoveTableDialog>> = {}) {
  const onOpenChange = vi.fn()
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  const props = {
    open: true,
    onOpenChange,
    tableName: 'Item Master',
    rowCount: 1234,
    fieldCount: 37,
    onConfirm,
    errorMessage: null,
    ...overrides,
  }
  const utils = render(<RemoveTableDialog {...props} />)
  return { ...utils, onOpenChange, onConfirm, props }
}

describe('RemoveTableDialog', () => {
  it('renders title and description with table name plus formatted counts', () => {
    renderDialog()

    // Title: includes table name
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Delete table.*Item Master/)

    // Description: vague-but-honest copy with locale-formatted counts
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('1,234 rows')
    expect(dialog).toHaveTextContent('37 fields')
    expect(dialog).toHaveTextContent(/mappings, transformations, and validation rules/)
    expect(dialog).toHaveTextContent('cannot be undone')
  })

  it('clicking Cancel calls onOpenChange(false) and does not call onConfirm', () => {
    const { onOpenChange, onConfirm } = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clicking Delete table calls onConfirm and awaits the promise', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    const { props: _ } = renderDialog({ onConfirm })

    fireEvent.click(screen.getByTestId('remove-table-dialog-confirm'))

    expect(onConfirm).toHaveBeenCalledTimes(1)

    // Mid-flight: the action button label flips to "Deleting…"
    await waitFor(() => {
      expect(screen.getByTestId('remove-table-dialog-confirm')).toHaveTextContent('Deleting…')
    })

    // Resolve the promise — confirming state clears
    resolveConfirm()
    await waitFor(() => {
      expect(screen.getByTestId('remove-table-dialog-confirm')).toHaveTextContent('Delete table')
    })
  })

  it('disables both buttons while confirming is true (mid-flight)', async () => {
    let resolveConfirm: () => void = () => {}
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve
        }),
    )
    renderDialog({ onConfirm })

    const confirmBtn = screen.getByTestId('remove-table-dialog-confirm')
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })

    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(confirmBtn).toBeDisabled()
      expect(cancelBtn).toBeDisabled()
    })

    // Cleanup: resolve the pending promise
    resolveConfirm()
  })

  it('renders inline error block when errorMessage is set', () => {
    renderDialog({ errorMessage: 'Permission denied' })

    const errorBlock = screen.getByTestId('remove-table-dialog-error')
    expect(errorBlock).toBeInTheDocument()
    expect(errorBlock).toHaveAttribute('role', 'alert')
    expect(errorBlock).toHaveTextContent('Permission denied')
  })
})
