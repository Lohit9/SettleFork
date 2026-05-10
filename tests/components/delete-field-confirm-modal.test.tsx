/**
 * DeleteFieldConfirmModal component tests (FR-3).
 *
 * Mirrors tests/components/remove-table-dialog.test.tsx for shape
 * (AlertDialog primitive, confirming-state mid-flight UX, inline error
 * block role="alert"). Adds: async impact load on open, type-to-confirm
 * gate driven by server `requiresTypedConfirmation`, stagedRowsCapped
 * "100+" rendering, hasAuthoredTransformSQL warning, canonical
 * FieldErrorCode → message map.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import DeleteFieldConfirmModal from '@/app/app/projects/[projectId]/data-overview/DeleteFieldConfirmModal'
import type {
  AppliedCascade,
  DeleteFieldImpact,
  FieldActionResult,
  FieldErrorCode,
} from '@/lib/validation/fields'

// ─── Action mocks (canonical FR-3 contract) ──────────────────────────────────

const { previewMock, deleteMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  deleteMock: vi.fn(),
}))

vi.mock('@/lib/actions/fields', () => ({
  previewFieldDeletion: (...args: unknown[]) => previewMock(...args),
  deleteField: (...args: unknown[]) => deleteMock(...args),
  updateField: vi.fn(),
  createField: vi.fn(),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeImpact(overrides: Partial<DeleteFieldImpact> = {}): DeleteFieldImpact {
  return {
    fieldId: 'fld_001',
    fieldName: 'customer_status',
    tableId: 'tbl_eim',
    counts: {
      tfms: 3,
      mappingSources: 4,
      transformations: 1,
      stagedRows: 47293,
      acknowledgments: 0,
      coverageRows: 0,
      validationRules: 2,
    },
    stagedRowsCapped: false,
    hasAuthoredTransformSQL: false,
    requiresTypedConfirmation: true,
    ...overrides,
  }
}

function makeAppliedCascade(
  overrides: Partial<AppliedCascade> = {},
): AppliedCascade {
  return {
    targetFieldMappings: 3,
    mappingSources: 4,
    transformations: 1,
    stagedRowsScrubbed: 47293,
    acknowledgments: 0,
    coverageRows: 0,
    validationRules: 2,
    hadAuthoredTransformSql: false,
    ...overrides,
  }
}

function renderModal(
  overrides: Partial<React.ComponentProps<typeof DeleteFieldConfirmModal>> = {},
) {
  const onOpenChange = vi.fn()
  const onDeleted = vi.fn()
  const props = {
    open: true,
    onOpenChange,
    fieldId: 'fld_001',
    fieldName: 'customer_status',
    onDeleted,
    ...overrides,
  }
  const utils = render(<DeleteFieldConfirmModal {...props} />)
  return { ...utils, onOpenChange, onDeleted, props }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DeleteFieldConfirmModal', () => {
  // Reset mock call history + queued .once impls between tests. vi.fn()
  // instances persist across tests in a vitest file by default.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── Render contract ────────────────────────────────────────────────────────

  it('renders title with the field name', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact(),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        /Delete field.*customer_status/,
      )
    })
  })

  // ─── Loading → impact summary ───────────────────────────────────────────────

  it('shows a loading state while previewFieldDeletion is in flight', async () => {
    let resolvePreview: (v: FieldActionResult<DeleteFieldImpact>) => void = () => {}
    previewMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve
        }),
    )

    renderModal()

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByTestId('delete-field-impact-loading')).toBeInTheDocument()

    // Cleanup
    resolvePreview({ success: true, data: makeImpact() })
  })

  it('renders impact summary with locale-formatted counts (incl. validationRules)', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact(),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      const dialog = screen.getByRole('alertdialog')
      expect(dialog).toHaveTextContent(/3 mapping/i) // counts.tfms = 3
      expect(dialog).toHaveTextContent(/1 transformation/i)
      expect(dialog).toHaveTextContent(/2 validation rule/i)
      expect(dialog).toHaveTextContent('47,293') // locale-formatted comma
    })
  })

  it('renders "100+ staged rows" when stagedRowsCapped is true', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 101,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
        stagedRowsCapped: true,
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      // "101+ staged rows" rather than exact "101 staged rows" — signals the
      // count was capped by PREVIEW_STAGED_ROW_CAP and the true number may
      // be higher.
      expect(screen.getByRole('alertdialog')).toHaveTextContent(/101\+ staged rows/i)
    })
  })

  it('renders authored-SQL warning when hasAuthoredTransformSQL is true', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({ hasAuthoredTransformSQL: true }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      // Amber warning callout signals destructive impact: a hand-written
      // transform will be lost (server flag, not derived from counts).
      const warning = screen.getByRole('note')
      expect(warning).toHaveTextContent(/hand-authored transform/i)
    })
  })

  // ─── Type-to-confirm gating (server `requiresTypedConfirmation` flag) ───────

  it('shows type-to-confirm input when requiresTypedConfirmation is true', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({ requiresTypedConfirmation: true }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Type the field name to confirm/i),
      ).toBeInTheDocument()
    })
  })

  it('hides type-to-confirm input when requiresTypedConfirmation is false', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        requiresTypedConfirmation: false,
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 0,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      // Empty-impact copy when nothing depends on the field
      expect(
        screen.getByText(/Nothing else depends on this field/i),
      ).toBeInTheDocument()
    })
    expect(
      screen.queryByLabelText(/Type the field name to confirm/i),
    ).not.toBeInTheDocument()
  })

  it('Delete disabled until typed name matches exactly (case-sensitive)', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({ requiresTypedConfirmation: true }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    const deleteBtn = await screen.findByTestId(
      'delete-field-confirm-modal-confirm',
    )
    expect(deleteBtn).toBeDisabled()

    const input = await screen.findByLabelText(/Type the field name to confirm/i)

    // Wrong case — Postgres-default case-sensitive collision (Q7)
    fireEvent.change(input, { target: { value: 'CUSTOMER_STATUS' } })
    expect(deleteBtn).toBeDisabled()

    // Exact match — enables
    fireEvent.change(input, { target: { value: 'customer_status' } })
    expect(deleteBtn).not.toBeDisabled()
  })

  // ─── Happy path ─────────────────────────────────────────────────────────────

  it('happy path: calls deleteField with fieldId only and forwards appliedCascade to onDeleted', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({ requiresTypedConfirmation: true }),
    } satisfies FieldActionResult<DeleteFieldImpact>)
    const cascade = makeAppliedCascade()
    deleteMock.mockResolvedValueOnce({
      success: true,
      data: { appliedCascade: cascade },
    } satisfies FieldActionResult<{ appliedCascade: AppliedCascade }>)

    const { onDeleted } = renderModal()

    const input = await screen.findByLabelText(/Type the field name to confirm/i)
    fireEvent.change(input, { target: { value: 'customer_status' } })
    fireEvent.click(screen.getByTestId('delete-field-confirm-modal-confirm'))

    await waitFor(() => {
      // Type-to-confirm is a UI-only gate — no confirmName passed to the server
      expect(deleteMock).toHaveBeenCalledWith('fld_001')
    })

    await waitFor(() => {
      // Parent receives the *post-action* cascade counts (not preview).
      // appliedCascade is nested under result.data per the canonical contract.
      expect(onDeleted).toHaveBeenCalledWith(cascade)
    })
  })

  it('calls deleteField with just fieldId when type-to-confirm is not required', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        requiresTypedConfirmation: false,
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 0,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)
    deleteMock.mockResolvedValueOnce({
      success: true,
      data: {
        appliedCascade: makeAppliedCascade({
          targetFieldMappings: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRowsScrubbed: 0,
          validationRules: 0,
        }),
      },
    } satisfies FieldActionResult<{ appliedCascade: AppliedCascade }>)

    renderModal()

    const deleteBtn = await screen.findByTestId(
      'delete-field-confirm-modal-confirm',
    )
    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('fld_001')
    })
  })

  // ─── Mid-flight UX (mirrors RemoveTableDialog confirming state) ─────────────

  it('disables both buttons mid-flight; flips Delete label to "Deleting…"', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        requiresTypedConfirmation: false,
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 0,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    let resolveDelete: (
      v: FieldActionResult<{ appliedCascade: AppliedCascade }>,
    ) => void = () => {}
    deleteMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    )

    renderModal()
    const deleteBtn = await screen.findByTestId(
      'delete-field-confirm-modal-confirm',
    )
    const cancelBtn = screen.getByRole('button', { name: /cancel/i })

    fireEvent.click(deleteBtn)

    await waitFor(() => {
      expect(deleteBtn).toBeDisabled()
      expect(cancelBtn).toBeDisabled()
      expect(deleteBtn).toHaveTextContent(/Deleting…/)
    })

    // Cleanup
    resolveDelete({ success: true, data: { appliedCascade: makeAppliedCascade() } })
  })

  it('blocks onOpenChange(false) while a delete is in flight', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        requiresTypedConfirmation: false,
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 0,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    let resolveDelete: (
      v: FieldActionResult<{ appliedCascade: AppliedCascade }>,
    ) => void = () => {}
    deleteMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve
        }),
    )

    const { onOpenChange } = renderModal()
    const deleteBtn = await screen.findByTestId(
      'delete-field-confirm-modal-confirm',
    )
    fireEvent.click(deleteBtn)

    // Cancel button click should be a no-op while confirming
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => {
      // Mirrors RemoveTableDialog: onOpenChange MUST NOT be called with
      // false during the confirming window.
      expect(onOpenChange).not.toHaveBeenCalledWith(false)
    })

    resolveDelete({ success: true, data: { appliedCascade: makeAppliedCascade() } })
  })

  // ─── Cancel UX ──────────────────────────────────────────────────────────────

  it('Cancel calls onOpenChange(false) and does not call deleteField', async () => {
    previewMock.mockResolvedValueOnce({
      success: true,
      data: makeImpact({
        requiresTypedConfirmation: false,
        counts: {
          tfms: 0,
          mappingSources: 0,
          transformations: 0,
          stagedRows: 0,
          acknowledgments: 0,
          coverageRows: 0,
          validationRules: 0,
        },
      }),
    } satisfies FieldActionResult<DeleteFieldImpact>)

    const { onOpenChange } = renderModal()

    await screen.findByTestId('delete-field-confirm-modal-confirm')
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(deleteMock).not.toHaveBeenCalled()
  })

  // ─── ErrorCode → message map (canonical FieldErrorCode union) ───────────────

  // Parameterised: each errorCode renders its mapped UX message in the
  // role="alert" inline error block. The matrix covers the codes that
  // deleteField actually returns (per lib/actions/fields.ts:459-568).
  it.each<{ errorCode: FieldErrorCode; matcher: RegExp }>([
    { errorCode: 'forbidden', matcher: /permission/i },
    { errorCode: 'field_not_found', matcher: /no longer exists/i },
    { errorCode: 'maintenance_mode', matcher: /maintenance/i },
    { errorCode: 'not_authenticated', matcher: /signed out/i },
    { errorCode: 'db_error', matcher: /Delete failed/i },
  ])(
    'maps errorCode "$errorCode" to its user-facing message',
    async ({ errorCode, matcher }) => {
      previewMock.mockResolvedValueOnce({
        success: true,
        data: makeImpact({
          requiresTypedConfirmation: false,
          counts: {
            tfms: 0,
            mappingSources: 0,
            transformations: 0,
            stagedRows: 0,
            acknowledgments: 0,
            coverageRows: 0,
            validationRules: 0,
          },
        }),
      } satisfies FieldActionResult<DeleteFieldImpact>)
      deleteMock.mockResolvedValueOnce({
        success: false,
        error: 'server-side raw error',
        errorCode,
      } satisfies FieldActionResult<{ appliedCascade: AppliedCascade }>)

      renderModal()
      const deleteBtn = await screen.findByTestId(
        'delete-field-confirm-modal-confirm',
      )
      fireEvent.click(deleteBtn)

      await waitFor(() => {
        const alert = screen.getByTestId('delete-field-confirm-modal-error')
        expect(alert).toHaveTextContent(matcher)
      })
    },
  )

  // ─── Preview-time error path ────────────────────────────────────────────────

  it('handles previewFieldDeletion failure (discriminated result; no null)', async () => {
    previewMock.mockResolvedValueOnce({
      success: false,
      error: 'Field not found',
      errorCode: 'field_not_found',
    } satisfies FieldActionResult<DeleteFieldImpact>)

    renderModal()

    await waitFor(() => {
      // Preview error renders inside the dialog body as the description text
      expect(screen.getByRole('alertdialog')).toHaveTextContent(
        /no longer exists/i,
      )
    })

    // Delete button must NOT be enabled when impact never loaded
    const deleteBtn = screen.queryByTestId('delete-field-confirm-modal-confirm')
    if (deleteBtn) expect(deleteBtn).toBeDisabled()
  })
})
