/**
 * PartitionDeleteConfirmDialog component tests (PR Ω.3.2.1 §4).
 *
 * 8 invariants (PDC1–PDC8):
 *   PDC1  open=false → renders nothing
 *   PDC2  SAFE state copy (label, source table, destructive line)
 *   PDC3  HAS-STAGED-ROWS state: warning + checkbox; Confirm disabled
 *         until checked
 *   PDC4  Cancel fires onCancel; does NOT fire onConfirm
 *   PDC5  Confirm in SAFE state → onConfirm({ force: false })
 *   PDC6  Confirm in HAS-STAGED-ROWS state (checkbox checked) →
 *         onConfirm({ force: true })
 *   PDC7  saving=true disables BOTH Cancel and Confirm
 *   PDC8  errorMessage renders an inline role="alert" banner
 *
 * No action mocks — this component is purely presentational and the
 * parent (MappingContent) owns deletePartition dispatch.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PartitionDeleteConfirmDialog } from '@/app/app/projects/[projectId]/mapping/redesign/components/PartitionDeleteConfirmDialog'
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

// ─── Fixtures ─────────────────────────────────────────────────────────────

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

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  partition: partition(),
  stagedRowsBlocking: null as number | null,
  errorMessage: null as string | null,
  saving: false,
  onCancel: vi.fn(),
  onConfirm: vi.fn(),
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof PartitionDeleteConfirmDialog>> = {},
) {
  const onOpenChange = vi.fn()
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const props = { ...BASE_PROPS, onOpenChange, onCancel, onConfirm, ...overrides }
  const utils = render(<PartitionDeleteConfirmDialog {...props} />)
  return { ...utils, onOpenChange, onCancel, onConfirm, props }
}

// ─── PDC1 — open=false renders nothing ───────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC1 — open gate', () => {
  it('renders nothing when open is false', () => {
    const { container } = renderDialog({ open: false })
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog content when open is true (sanity)', () => {
    renderDialog()
    expect(screen.getByTestId('partition-delete-confirm-dialog')).toBeInTheDocument()
  })
})

// ─── PDC2 — SAFE state copy ──────────────────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC2 — SAFE state', () => {
  it('renders the partition label + source table in the body copy', () => {
    renderDialog({
      partition: partition({ label: 'Active items', sourceTableName: 'inventory_items' }),
    })
    const dialog = screen.getByTestId('partition-delete-confirm-dialog')
    expect(dialog).toHaveTextContent(/Active items/)
    expect(dialog).toHaveTextContent(/inventory_items/)
    expect(dialog).toHaveTextContent(/target field mappings/i)
    expect(dialog).toHaveTextContent(/cannot be undone/i)
  })

  it('falls back to sourceTableName when label is null', () => {
    renderDialog({
      partition: partition({ label: null, sourceTableName: 'products' }),
    })
    expect(screen.getByTestId('partition-delete-confirm-dialog')).toHaveTextContent(/products/)
  })

  it('omits the staged-rows warning in SAFE state (stagedRowsBlocking=null)', () => {
    renderDialog({ stagedRowsBlocking: null })
    expect(screen.queryByTestId('partition-delete-confirm-staged-warning')).toBeNull()
    expect(screen.queryByTestId('partition-delete-confirm-force-checkbox')).toBeNull()
  })

  it('Confirm button label is plain "Delete partition" in SAFE state', () => {
    renderDialog()
    expect(screen.getByTestId('partition-delete-confirm-action')).toHaveTextContent(/^Delete partition$/)
  })
})

// ─── PDC3 — HAS-STAGED-ROWS state ────────────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC3 — HAS-STAGED-ROWS state', () => {
  it('renders the amber warning + force checkbox when stagedRowsBlocking > 0', () => {
    renderDialog({ stagedRowsBlocking: 47 })
    const warn = screen.getByTestId('partition-delete-confirm-staged-warning')
    expect(warn).toBeInTheDocument()
    expect(warn).toHaveTextContent(/47 staged rows/)
    expect(screen.getByTestId('partition-delete-confirm-force-checkbox')).toBeInTheDocument()
  })

  it('uses singular "row" when stagedRowsBlocking === 1', () => {
    renderDialog({ stagedRowsBlocking: 1 })
    const warn = screen.getByTestId('partition-delete-confirm-staged-warning')
    expect(warn).toHaveTextContent(/1 staged row\b/)
    expect(warn).not.toHaveTextContent(/staged rows\b/)
  })

  it('Confirm button is disabled until the force checkbox is checked', () => {
    renderDialog({ stagedRowsBlocking: 5 })
    const confirm = screen.getByTestId('partition-delete-confirm-action')
    expect(confirm).toBeDisabled()

    fireEvent.click(screen.getByTestId('partition-delete-confirm-force-checkbox'))
    expect(confirm).not.toBeDisabled()
  })

  it('Confirm button label reflects the staged row count when has-staged-rows', () => {
    renderDialog({ stagedRowsBlocking: 47 })
    expect(screen.getByTestId('partition-delete-confirm-action')).toHaveTextContent(
      /Delete partition \+ 47 rows/,
    )
  })

  it('checkbox state resets when stagedRowsBlocking transitions back to null', () => {
    const { rerender, props } = renderDialog({ stagedRowsBlocking: 3 })
    fireEvent.click(screen.getByTestId('partition-delete-confirm-force-checkbox'))
    expect(screen.getByTestId('partition-delete-confirm-force-checkbox')).toBeChecked()

    rerender(<PartitionDeleteConfirmDialog {...props} stagedRowsBlocking={null} />)
    // Warning + checkbox gone in SAFE state.
    expect(screen.queryByTestId('partition-delete-confirm-force-checkbox')).toBeNull()

    // Re-enter has-staged-rows state — checkbox should be unchecked again.
    rerender(<PartitionDeleteConfirmDialog {...props} stagedRowsBlocking={3} />)
    expect(screen.getByTestId('partition-delete-confirm-force-checkbox')).not.toBeChecked()
  })
})

// ─── PDC4 — Cancel ───────────────────────────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC4 — cancel', () => {
  it('clicking Cancel fires onCancel and does NOT fire onConfirm', () => {
    const { onCancel, onConfirm } = renderDialog()
    fireEvent.click(screen.getByTestId('partition-delete-confirm-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

// ─── PDC5 — Confirm in SAFE state ─────────────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC5 — confirm safe', () => {
  it('fires onConfirm with { force: false } in SAFE state', () => {
    const { onConfirm } = renderDialog({ stagedRowsBlocking: null })
    fireEvent.click(screen.getByTestId('partition-delete-confirm-action'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ force: false })
  })
})

// ─── PDC6 — Confirm in HAS-STAGED-ROWS state ─────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC6 — confirm with force', () => {
  it('fires onConfirm with { force: true } once the checkbox is checked', () => {
    const { onConfirm } = renderDialog({ stagedRowsBlocking: 12 })
    fireEvent.click(screen.getByTestId('partition-delete-confirm-force-checkbox'))
    fireEvent.click(screen.getByTestId('partition-delete-confirm-action'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith({ force: true })
  })

  it('Confirm is gated on the checkbox — clicking without checking is a no-op', () => {
    const { onConfirm } = renderDialog({ stagedRowsBlocking: 12 })
    fireEvent.click(screen.getByTestId('partition-delete-confirm-action'))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

// ─── PDC7 — saving disables both buttons ─────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC7 — mid-flight gate', () => {
  it('saving=true disables BOTH Cancel and Confirm in SAFE state', () => {
    renderDialog({ saving: true })
    expect(screen.getByTestId('partition-delete-confirm-cancel')).toBeDisabled()
    expect(screen.getByTestId('partition-delete-confirm-action')).toBeDisabled()
  })

  it('saving=true disables Cancel + Confirm + the checkbox in HAS-STAGED-ROWS state', () => {
    renderDialog({ saving: true, stagedRowsBlocking: 5 })
    expect(screen.getByTestId('partition-delete-confirm-cancel')).toBeDisabled()
    expect(screen.getByTestId('partition-delete-confirm-action')).toBeDisabled()
    expect(screen.getByTestId('partition-delete-confirm-force-checkbox')).toBeDisabled()
  })

  it('saving=true switches the Confirm label to "Deleting…"', () => {
    renderDialog({ saving: true })
    expect(screen.getByTestId('partition-delete-confirm-action')).toHaveTextContent(/^Deleting…$/)
  })
})

// ─── PDC8 — inline error banner ──────────────────────────────────────────

describe('[PartitionDeleteConfirmDialog] PDC8 — error banner', () => {
  it('renders the error banner with role="alert" when errorMessage is set', () => {
    renderDialog({
      errorMessage: 'Insufficient permissions to delete this partition.',
    })
    const banner = screen.getByTestId('partition-delete-confirm-error')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveAttribute('role', 'alert')
    expect(banner).toHaveTextContent(/Insufficient permissions/)
  })

  it('does NOT render the error banner when errorMessage is null', () => {
    renderDialog({ errorMessage: null })
    expect(screen.queryByTestId('partition-delete-confirm-error')).toBeNull()
  })

  it('error banner coexists with the staged-rows warning when both are present', () => {
    renderDialog({
      stagedRowsBlocking: 9,
      errorMessage: 'force flag rejected — retry now requires re-confirmation',
    })
    expect(screen.getByTestId('partition-delete-confirm-staged-warning')).toBeInTheDocument()
    expect(screen.getByTestId('partition-delete-confirm-error')).toBeInTheDocument()
  })
})
