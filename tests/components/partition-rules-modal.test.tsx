/**
 * PartitionRulesModal component tests (PR Ω.3.2 design doc §5.1).
 *
 * Mirrors tests/components/add-field-modal.test.tsx in shape:
 *   - vi.hoisted action mocks
 *   - fireEvent + waitFor for mid-flight assertions
 *   - role="alert" inline error block
 *
 * Radix `@/components/ui/select` is module-mocked with native HTML
 * controls — Radix Select needs hasPointerCapture / pointer-event
 * polyfills that jsdom does not provide. The shim preserves the same
 * `value` / `onValueChange` contract the component depends on; the
 * Radix-specific keyboard / focus behavior is tested separately at the
 * primitive level (intentionally out of scope here).
 */

import * as React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { PartitionRulesModal } from '@/app/app/projects/[projectId]/mapping/redesign/components/PartitionRulesModal'
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

// ─── Action mocks ─────────────────────────────────────────────────────────

const {
  createPartitionMock,
  updatePartitionFilterMock,
  updatePartitionMetadataMock,
  testFilterSqlMock,
} = vi.hoisted(() => ({
  createPartitionMock: vi.fn(),
  updatePartitionFilterMock: vi.fn(),
  updatePartitionMetadataMock: vi.fn(),
  testFilterSqlMock: vi.fn(),
}))

vi.mock('@/lib/actions/partitions', () => ({
  createPartition: (...args: unknown[]) => createPartitionMock(...args),
  updatePartitionFilter: (...args: unknown[]) => updatePartitionFilterMock(...args),
  updatePartitionMetadata: (...args: unknown[]) => updatePartitionMetadataMock(...args),
  testFilterSql: (...args: unknown[]) => testFilterSqlMock(...args),
  deletePartition: vi.fn(),
}))

// Radix Select shim — native <select>/<option> with the same prop surface
// the component uses (value + onValueChange + disabled). Each rendered
// <select> exposes itself with a positional testid: select-native-0,
// select-native-1, … (in source-tree DOM order). The component
// renders source-table first, identity-field second, so:
//   select-native-0 = source-table picker
//   select-native-1 = identity-field picker
//
// The instance counter is reset before each test by `beforeEach`.
let selectInstanceCounter = 0
function resetSelectShimCounter() {
  selectInstanceCounter = 0
}

vi.mock('@/components/ui/select', () => {
  const SelectContext = React.createContext<{
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    instanceId: number
  }>({ value: '', onValueChange: () => {}, instanceId: -1 })

  function Select({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string
    onValueChange: (v: string) => void
    disabled?: boolean
    children: React.ReactNode
  }) {
    // useMemo so the instance id is stable across re-renders.
    const instanceId = React.useMemo(() => selectInstanceCounter++, [])
    return (
      <SelectContext.Provider value={{ value, onValueChange, disabled, instanceId }}>
        <div data-testid={`select-root-${instanceId}`}>{children}</div>
      </SelectContext.Provider>
    )
  }

  function SelectTrigger({ children }: { children: React.ReactNode }) {
    return <div data-testid="select-trigger">{children}</div>
  }

  function SelectValue({ placeholder }: { placeholder?: string }) {
    const ctx = React.useContext(SelectContext)
    return <span>{ctx.value || placeholder}</span>
  }

  function SelectContent({ children }: { children: React.ReactNode }) {
    const ctx = React.useContext(SelectContext)
    return (
      <select
        data-testid={`select-native-${ctx.instanceId}`}
        value={ctx.value}
        disabled={ctx.disabled}
        onChange={(e) => ctx.onValueChange(e.target.value)}
      >
        {children}
      </select>
    )
  }

  function SelectItem({
    value,
    children,
  }: {
    value: string
    children: React.ReactNode
  }) {
    return <option value={value}>{children}</option>
  }

  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

const SOURCE_SELECT_TESTID = 'select-native-0'
const IDENTITY_SELECT_TESTID = 'select-native-1'

// ─── Fixtures ─────────────────────────────────────────────────────────────

function partition(overrides: Partial<PartitionInfo> = {}): PartitionInfo {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    label: 'Engineering items',
    ordinal: 0,
    sourceTableId: '22222222-2222-2222-2222-222222222222',
    sourceTableName: 'engineering_bom_masters',
    filterSql: null,
    identityFieldId: null,
    dedupPriority: null,
    ...overrides,
  }
}

const DEFAULT_PROPS = {
  projectId: '33333333-3333-3333-3333-333333333333',
  targetTableId: '44444444-4444-4444-4444-444444444444',
  targetTableName: 'item_master',
  sourceTables: [
    { id: '22222222-2222-2222-2222-222222222222', name: 'engineering_bom_masters', datasetName: 'erp' },
    { id: '55555555-5555-5555-5555-555555555555', name: 'products', datasetName: 'erp' },
  ],
  identityFieldOptions: [
    { id: '66666666-6666-6666-6666-666666666666', name: 'item_number' },
  ],
  siblings: [] as PartitionInfo[],
  editing: null as PartitionInfo | null,
  open: true,
  onClose: vi.fn(),
  onSaved: vi.fn(),
}

function renderModal(
  overrides: Partial<React.ComponentProps<typeof PartitionRulesModal>> = {},
) {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const props = { ...DEFAULT_PROPS, onClose, onSaved, ...overrides }
  const utils = render(<PartitionRulesModal {...props} />)
  return { ...utils, onClose, onSaved, props }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSelectShimCounter()
})

// ─── PRM1 — Open / closed visibility ────────────────────────────────────

describe('[PartitionRulesModal] PRM1 — open prop gates render', () => {
  it('renders nothing when open is false', () => {
    const { container } = renderModal({ open: false })
    expect(container.firstChild).toBeNull()
  })

  it('renders the dialog and form fields when open is true (create mode)', () => {
    renderModal()

    expect(screen.getByTestId('partition-rules-modal')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /Add partition to.*item_master/i }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Partition label/i)).toHaveValue('')
    expect(screen.getByLabelText(/Row filter/i)).toHaveValue('')
    expect(screen.getByLabelText(/Dedup priority/i)).toHaveValue(null)
  })

  it('renders edit-mode heading and pre-fills fields when `editing` is set', () => {
    const editing = partition({
      label: 'Active items',
      filterSql: "status = 'ACTIVE'",
      dedupPriority: 1,
    })
    renderModal({ editing })

    expect(
      screen.getByRole('heading', { name: /Edit partition/i }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Partition label/i)).toHaveValue('Active items')
    expect(screen.getByLabelText(/Row filter/i)).toHaveValue("status = 'ACTIVE'")
    expect(screen.getByLabelText(/Dedup priority/i)).toHaveValue(1)
  })
})

// ─── PRM2 — Submit gating ───────────────────────────────────────────────

describe('[PartitionRulesModal] PRM2 — submit gating', () => {
  it('Add partition button disabled when label is empty (create mode)', () => {
    renderModal()
    const btn = screen.getByTestId('partition-modal-submit')
    expect(btn).toBeDisabled()
  })

  it('Add partition button disabled with whitespace-only label', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: '   ' },
    })
    expect(screen.getByTestId('partition-modal-submit')).toBeDisabled()
  })

  it('Add partition button disabled when source table not picked', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    // sourceTableId is still '' — submit should remain gated by Zod
    expect(screen.getByTestId('partition-modal-submit')).toBeDisabled()
  })

  it('Add partition button enables once label + source table are valid', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    expect(screen.getByTestId('partition-modal-submit')).not.toBeDisabled()
  })
})

// ─── PRM3 — Inline validation (duplicate label, dedup priority) ─────────

describe('[PartitionRulesModal] PRM3 — inline validation', () => {
  it('flags duplicate label against siblings and blocks submit', () => {
    const sibling = partition({ id: 'sib-1', label: 'Engineering' })
    renderModal({ siblings: [sibling] })

    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'Engineering' },
    })

    expect(screen.getByText(/already exists for this target table/i)).toBeInTheDocument()
    expect(screen.getByTestId('partition-modal-submit')).toBeDisabled()
  })

  it('does NOT flag duplicate label against the partition being edited', () => {
    const editing = partition({ id: 'sib-1', label: 'Engineering' })
    renderModal({ siblings: [editing], editing })

    // Label still 'Engineering' (unchanged) — no duplicate error.
    expect(screen.queryByText(/already exists for this target table/i)).toBeNull()
  })

  it('flags non-integer dedup priority and blocks submit', () => {
    renderModal()
    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.change(screen.getByLabelText(/Dedup priority/i), {
      target: { value: '-1' },
    })

    expect(screen.getByText(/non-negative integer/i)).toBeInTheDocument()
    expect(screen.getByTestId('partition-modal-submit')).toBeDisabled()
  })
})

// ─── PRM4 — Test filter affordance ───────────────────────────────────────

describe('[PartitionRulesModal] PRM4 — test filter affordance', () => {
  it('Test filter button disabled when filter is empty', () => {
    renderModal()
    expect(screen.getByTestId('partition-test-filter')).toBeDisabled()
  })

  it('clicking Test filter calls testFilterSql with the form values', async () => {
    testFilterSqlMock.mockResolvedValueOnce({ success: true })
    renderModal()

    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "status = 'ACTIVE'" },
    })
    fireEvent.click(screen.getByTestId('partition-test-filter'))

    await waitFor(() => {
      expect(testFilterSqlMock).toHaveBeenCalledWith({
        projectId: DEFAULT_PROPS.projectId,
        sourceTableId: '22222222-2222-2222-2222-222222222222',
        filterSql: "status = 'ACTIVE'",
      })
    })
    expect(await screen.findByTestId('partition-test-result-ok')).toBeInTheDocument()
  })

  it('renders verbose error inline when testFilterSql fails (Q7 pilot)', async () => {
    testFilterSqlMock.mockResolvedValueOnce({
      success: false,
      error: 'column "stautus" does not exist (typo at line 1, col 8)',
      errorCode: 'VALIDATION',
    })
    renderModal()

    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "stautus = 'ACTIVE'" },
    })
    fireEvent.click(screen.getByTestId('partition-test-filter'))

    const err = await screen.findByTestId('partition-test-result-err')
    expect(err).toHaveTextContent(/stautus/)
    expect(err).toHaveTextContent(/does not exist/)
  })

  it('clears prior test result when the filter text changes', async () => {
    testFilterSqlMock.mockResolvedValueOnce({ success: true })
    renderModal()

    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "x = 1" },
    })
    fireEvent.click(screen.getByTestId('partition-test-filter'))

    await screen.findByTestId('partition-test-result-ok')

    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "x = 2" },
    })
    expect(screen.queryByTestId('partition-test-result-ok')).toBeNull()
  })
})

// ─── PRM5 — Create-mode submit ───────────────────────────────────────────

describe('[PartitionRulesModal] PRM5 — create-mode submit', () => {
  it('happy path: calls createPartition with the full payload and fires onSaved + onClose', async () => {
    createPartitionMock.mockResolvedValueOnce({
      success: true,
      tableMappingId: 'new-tm-id',
    })

    const { onSaved, onClose } = renderModal()

    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "status = 'ACTIVE'" },
    })

    fireEvent.click(screen.getByTestId('partition-modal-submit'))

    await waitFor(() => {
      expect(createPartitionMock).toHaveBeenCalledWith({
        projectId: DEFAULT_PROPS.projectId,
        sourceTableId: '22222222-2222-2222-2222-222222222222',
        targetTableId: DEFAULT_PROPS.targetTableId,
        partitionLabel: 'New partition',
        filterSql: "status = 'ACTIVE'",
        identityFieldId: null,
        dedupPriority: null,
      })
    })

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('server error surfaces in role=alert and does NOT close the modal', async () => {
    createPartitionMock.mockResolvedValueOnce({
      success: false,
      error: 'duplicate partition_label for target table',
      errorCode: 'CONFLICT',
    })

    const { onSaved, onClose } = renderModal()

    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })
    fireEvent.click(screen.getByTestId('partition-modal-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/duplicate partition_label/i)
    })
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ─── PRM6 — Edit-mode submit ─────────────────────────────────────────────

describe('[PartitionRulesModal] PRM6 — edit-mode submit', () => {
  const editing = partition({
    id: 'edit-tm-1',
    label: 'Old label',
    filterSql: "status = 'OLD'",
    dedupPriority: 1,
  })

  it('calls updatePartitionFilter only when filter changed', async () => {
    updatePartitionFilterMock.mockResolvedValueOnce({ success: true, stagedRowsAffected: 0 })

    const { onSaved, onClose } = renderModal({ editing })

    // Change ONLY the filter SQL — label / identity / priority untouched.
    fireEvent.change(screen.getByLabelText(/Row filter/i), {
      target: { value: "status = 'NEW'" },
    })
    fireEvent.click(screen.getByTestId('partition-modal-submit'))

    await waitFor(() => {
      expect(updatePartitionFilterMock).toHaveBeenCalledWith({
        tableMappingId: 'edit-tm-1',
        filterSql: "status = 'NEW'",
      })
    })
    expect(updatePartitionMetadataMock).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })
  })

  it('calls updatePartitionMetadata only when non-filter fields change', async () => {
    updatePartitionMetadataMock.mockResolvedValueOnce({ success: true })

    renderModal({ editing })

    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'Brand new label' },
    })
    fireEvent.click(screen.getByTestId('partition-modal-submit'))

    await waitFor(() => {
      expect(updatePartitionMetadataMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tableMappingId: 'edit-tm-1',
          partitionLabel: 'Brand new label',
        }),
      )
    })
    expect(updatePartitionFilterMock).not.toHaveBeenCalled()
  })

  it('source-table Select is disabled in edit mode (Q9: can\'t reassign source)', () => {
    renderModal({ editing })
    // jsdom-shim native select is disabled when ctx.disabled is true.
    expect(screen.getByTestId(SOURCE_SELECT_TESTID)).toBeDisabled()
    expect(
      screen.getByText(/Source table cannot be changed after creation/i),
    ).toBeInTheDocument()
  })

  it('failed metadata update surfaces in role=alert and keeps modal open', async () => {
    updatePartitionMetadataMock.mockResolvedValueOnce({
      success: false,
      error: 'identity_field_id must match sibling partitions',
      errorCode: 'VALIDATION',
    })

    const { onSaved, onClose } = renderModal({ editing })

    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'Renamed' },
    })
    fireEvent.click(screen.getByTestId('partition-modal-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/must match sibling/i)
    })
    expect(onSaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ─── PRM7 — Cancel + double-click guard ─────────────────────────────────

describe('[PartitionRulesModal] PRM7 — cancel + double-click guard', () => {
  it('Cancel button calls onClose and does not call createPartition', () => {
    const { onClose } = renderModal()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(onClose).toHaveBeenCalled()
    expect(createPartitionMock).not.toHaveBeenCalled()
  })

  it('rapid double-click fires createPartition exactly once (INF-79 guard)', async () => {
    let resolveCreate: (v: { success: true; tableMappingId: string }) => void = () => {}
    createPartitionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        }),
    )

    renderModal()
    fireEvent.change(screen.getByLabelText(/Partition label/i), {
      target: { value: 'New partition' },
    })
    fireEvent.change(screen.getByTestId(SOURCE_SELECT_TESTID), {
      target: { value: '22222222-2222-2222-2222-222222222222' },
    })

    const submit = screen.getByTestId('partition-modal-submit')
    fireEvent.click(submit)
    fireEvent.click(submit)

    await waitFor(() => {
      expect(createPartitionMock).toHaveBeenCalledTimes(1)
    })

    resolveCreate({ success: true, tableMappingId: 'new-tm' })
  })
})
