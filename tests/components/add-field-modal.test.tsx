/**
 * AddFieldModal component tests (FR-3).
 *
 * Mirrors tests/components/remove-table-dialog.test.tsx in shape:
 * vi.hoisted action mocks, fireEvent + waitFor for mid-flight assertions,
 * inline error-block role="alert" assertion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import AddFieldModal from '@/app/app/projects/[projectId]/data-overview/AddFieldModal'
import type { Field } from '@/lib/types/database'

// ─── Action mocks (canonical FR-3 contract per lib/validation/fields.ts) ──────

const { createFieldMock } = vi.hoisted(() => ({
  createFieldMock: vi.fn(),
}))

vi.mock('@/lib/actions/fields', () => ({
  createField: (...args: unknown[]) => createFieldMock(...args),
  updateField: vi.fn(),
  previewFieldDeletion: vi.fn(),
  deleteField: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeField(overrides: Partial<Field> = {}): Field {
  return {
    id: 'fld_new_001',
    table_id: 'tbl_eim',
    name: 'customer_status',
    data_type: 'VARCHAR(255)',
    inferred_type: 'string',
    is_nullable: true,
    is_primary_key: false,
    is_foreign_key: false,
    fk_reference: null,
    ordinal_position: 19,
    created_at: '2026-05-10T12:00:00Z',
    check_constraint: null,
    schema_source: 'manual',
    default_value: null,
    description: null,
    ...overrides,
  }
}

function renderModal(
  overrides: Partial<React.ComponentProps<typeof AddFieldModal>> = {},
) {
  const onClose = vi.fn()
  const onAdded = vi.fn()
  const props = {
    tableId: 'tbl_eim',
    tableName: 'Engineering Item Master',
    /** Existing field names — case-sensitive client-side dup-check per Q7. */
    existingFieldNames: ['id', 'sku', 'description'],
    /** PK options for the FK reference dropdown (TABLE.FIELD form). */
    fkOptions: ['Engineering BOM.id', 'Engineering Routing.id'],
    canEdit: true,
    onClose,
    onAdded,
    ...overrides,
  }
  const utils = render(<AddFieldModal {...props} />)
  return { ...utils, onClose, onAdded, props }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AddFieldModal', () => {
  // Reset mock call history + queued .once impls between tests. vi.fn()
  // instances persist across tests in a vitest file by default.
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ─── Render contract ────────────────────────────────────────────────────────

  it('renders heading with table name and the full input set', () => {
    renderModal()

    // h3 heading combines "Add field to" + the table-name span — query by role
    expect(
      screen.getByRole('heading', { name: /Add field to.*Engineering Item Master/i }),
    ).toBeInTheDocument()

    // Field Name input — empty by default
    expect(screen.getByLabelText(/Field Name/i)).toHaveValue('')

    // Data Type custom input present
    expect(screen.getByPlaceholderText(/Custom type/i)).toBeInTheDocument()

    // Three checkboxes; Nullable defaults to true (common Settle data shape)
    expect(screen.getByLabelText(/Nullable/i)).toBeChecked()
    expect(screen.getByLabelText(/Primary Key/i)).not.toBeChecked()
    expect(screen.getByLabelText(/Foreign Key/i)).not.toBeChecked()
  })

  // ─── PK / FK mutual exclusion (mirrors FieldEditModal:159-195) ──────────────

  it('checking Primary Key clears Foreign Key + reference', () => {
    renderModal()

    fireEvent.click(screen.getByLabelText(/Foreign Key/i))
    fireEvent.change(screen.getByPlaceholderText(/TableName\.field_name/i), {
      target: { value: 'Engineering BOM.id' },
    })
    expect(screen.getByLabelText(/Foreign Key/i)).toBeChecked()

    fireEvent.click(screen.getByLabelText(/Primary Key/i))

    expect(screen.getByLabelText(/Primary Key/i)).toBeChecked()
    expect(screen.getByLabelText(/Foreign Key/i)).not.toBeChecked()
    // FK section is conditionally rendered — gone when FK unchecked
    expect(
      screen.queryByPlaceholderText(/TableName\.field_name/i),
    ).not.toBeInTheDocument()
  })

  it('checking Foreign Key clears Primary Key', () => {
    renderModal()

    fireEvent.click(screen.getByLabelText(/Primary Key/i))
    expect(screen.getByLabelText(/Primary Key/i)).toBeChecked()

    fireEvent.click(screen.getByLabelText(/Foreign Key/i))
    expect(screen.getByLabelText(/Foreign Key/i)).toBeChecked()
    expect(screen.getByLabelText(/Primary Key/i)).not.toBeChecked()
  })

  it('unchecking Foreign Key clears the reference value', () => {
    renderModal()

    fireEvent.click(screen.getByLabelText(/Foreign Key/i))
    fireEvent.change(screen.getByPlaceholderText(/TableName\.field_name/i), {
      target: { value: 'Engineering BOM.id' },
    })

    fireEvent.click(screen.getByLabelText(/Foreign Key/i))
    expect(screen.getByLabelText(/Foreign Key/i)).not.toBeChecked()
    // Re-checking FK should NOT bring back the stale value
    fireEvent.click(screen.getByLabelText(/Foreign Key/i))
    expect(screen.getByPlaceholderText(/TableName\.field_name/i)).toHaveValue('')
  })

  // ─── Add-button gating ─────────────────────────────────────────────────────

  it('Add button disabled until name has non-whitespace content (Q7: trim)', () => {
    renderModal()

    const addBtn = screen.getByRole('button', { name: /^Add$/i })

    expect(addBtn).toBeDisabled()

    // Whitespace only — still disabled
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: '   ' },
    })
    expect(addBtn).toBeDisabled()

    // Real name — enabled
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    expect(addBtn).not.toBeDisabled()
  })

  it('Add button disabled when canEdit is false (defense-in-depth)', () => {
    renderModal({ canEdit: false })
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    expect(screen.getByRole('button', { name: /^Add$/i })).toBeDisabled()
  })

  // ─── Inline duplicate-name validation (Q7: case-sensitive collision) ────────

  it('inline-flags duplicate field name (case-sensitive) before submit', () => {
    renderModal({ existingFieldNames: ['id', 'sku'] })

    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'sku' },
    })

    expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Add$/i })).toBeDisabled()

    // Case-sensitive: 'SKU' should NOT trip the dup check (Postgres default)
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'SKU' },
    })
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Add$/i })).not.toBeDisabled()
  })

  // ─── Happy path ─────────────────────────────────────────────────────────────

  it('happy path: calls createField with full payload and onAdded with the returned row', async () => {
    const newField = makeField({ name: 'customer_status' })
    createFieldMock.mockResolvedValueOnce({ success: true, data: newField })

    const { onAdded, onClose } = renderModal()

    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(createFieldMock).toHaveBeenCalledWith({
        tableId: 'tbl_eim',
        name: 'customer_status',
        dataType: expect.any(String),
        isNullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        fkReference: null,
      })
    })

    expect(onAdded).toHaveBeenCalledWith(newField)
    expect(onClose).toHaveBeenCalled()
  })

  // ─── Mid-flight UX ──────────────────────────────────────────────────────────

  it('rapid double-click fires createField exactly once (INF-79 guard)', async () => {
    // Without the useRef guard, both clicks fire from the same render's
    // closure (canSubmit=true is captured before setSaving(true) commits)
    // and both invoke createField → duplicate INSERT in the DB.
    let resolveCreate: (v: { success: true; data: Field }) => void = () => {}
    createFieldMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )

    renderModal()
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })

    const addBtn = screen.getByRole('button', { name: /^Add$/i })
    // Two synchronous clicks — no React render between them.
    fireEvent.click(addBtn)
    fireEvent.click(addBtn)

    await waitFor(() => {
      expect(createFieldMock).toHaveBeenCalledTimes(1)
    })

    // Cleanup
    resolveCreate({ success: true, data: makeField() })
  })

  it('button label flips to "Adding…" mid-flight; inputs disabled', async () => {
    let resolveCreate: (v: { success: true; data: Field }) => void = () => {}
    createFieldMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )

    renderModal()
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Adding…/ }),
      ).toBeInTheDocument()
    })

    // Field Name input disabled mid-flight (prevents dirty edits during save)
    expect(screen.getByLabelText(/Field Name/i)).toBeDisabled()

    // Cleanup
    resolveCreate({ success: true, data: makeField() })
  })

  // ─── Error mapping (canonical FieldErrorCode union) ─────────────────────────

  it('name_collision server error: surfaces in the bottom alert block', async () => {
    createFieldMock.mockResolvedValueOnce({
      success: false,
      error: 'A field named "shipped_at" already exists on this table',
      errorCode: 'name_collision',
    })

    renderModal({ existingFieldNames: [] /* skip client-side dup-check */ })
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'shipped_at' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already exists/i)
    })
  })

  it('forbidden errorCode: surfaces a permission-specific message', async () => {
    createFieldMock.mockResolvedValueOnce({
      success: false,
      error: 'Insufficient permissions',
      errorCode: 'forbidden',
    })

    renderModal()
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/permission/i)
    })
  })

  it('db_error errorCode: surfaces the raw server message', async () => {
    createFieldMock.mockResolvedValueOnce({
      success: false,
      error: 'duplicate key value violates unique constraint',
      errorCode: 'db_error',
    })

    renderModal()
    fireEvent.change(screen.getByLabelText(/Field Name/i), {
      target: { value: 'customer_status' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/duplicate key/i)
    })
  })

  // ─── Cancel UX ──────────────────────────────────────────────────────────────

  it('Cancel button calls onClose and does not call createField', () => {
    const { onClose } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))

    expect(onClose).toHaveBeenCalled()
    expect(createFieldMock).not.toHaveBeenCalled()
  })
})
