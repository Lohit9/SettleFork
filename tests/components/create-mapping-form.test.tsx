import { createRef } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CreateMappingForm,
  type CreateMappingFormHandle,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/CreateMappingForm'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — `CreateMappingForm` + DiscardChangesDialog tests.
// ─────────────────────────────────────────────────────────────────────────────

const { createFieldMappingMock, routerRefreshMock } = vi.hoisted(() => ({
  createFieldMappingMock: vi.fn(),
  routerRefreshMock: vi.fn(),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

beforeEach(() => {
  createFieldMappingMock.mockReset()
  routerRefreshMock.mockReset()
})

// ── Fixtures ────────────────────────────────────────────────────────────────

function field(overrides: Partial<SourceFieldWithState> = {}): SourceFieldWithState {
  return {
    id: 'sf-1',
    name: 'FIRST_NAME',
    dataType: 'VARCHAR',
    ordinalPosition: 0,
    sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: ['Alpha', 'Bravo', 'Charlie'],
    isAcknowledged: false,
    ...overrides,
  }
}

const cifFields: SourceFieldWithState[] = [
  field({ id: 'sf-cif-1', name: 'FIRST_NAME' }),
  field({ id: 'sf-cif-2', name: 'LAST_NAME', sampleValues: ['Smith', 'Doe', 'Roe'] }),
  field({ id: 'sf-cif-3', name: 'EMAIL', sampleValues: [] }),
]

const acctFields: SourceFieldWithState[] = [
  field({
    id: 'sf-acct-1',
    name: 'ACCT_NO',
    sourceTable: { id: 'st-acct', name: 'ACCT_MASTER' },
    sampleValues: ['1', '2'],
  }),
]

const allFields: SourceFieldWithState[] = [...cifFields, ...acctFields]

const targetField = { id: 'tf-1', name: 'customer_name' }

// ── Initial render ──────────────────────────────────────────────────────────

describe('CreateMappingForm — initial render', () => {
  it('renders the picker and the preview block, no combination radios', () => {
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    expect(screen.getByTestId('source-field-picker')).toBeInTheDocument()
    expect(screen.getByTestId('create-mapping-form-preview')).toBeInTheDocument()
    expect(screen.queryByTestId('create-mapping-form-combination')).toBeNull()
  })

  it('preview block shows empty placeholder when no sources selected', () => {
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(
      screen.getByTestId('create-mapping-form-preview-empty'),
    ).toBeInTheDocument()
  })

  it('publishes initial state via onStateChange (clean, can-not-save)', () => {
    const onStateChange = vi.fn()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    expect(onStateChange).toHaveBeenCalledWith({
      isDirty: false,
      canSave: false,
      isSavePending: false,
    })
  })
})

// ── Selection + dirty + canSave ─────────────────────────────────────────────

describe('CreateMappingForm — selection + dirty/canSave publishing', () => {
  it('selecting a source flips isDirty and canSave to true', async () => {
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    const fieldEl = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(fieldEl)
    expect(onStateChange).toHaveBeenLastCalledWith({
      isDirty: true,
      canSave: true,
      isSavePending: false,
    })
  })

  it('unselecting last source flips isDirty back to false', async () => {
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    const fieldEl = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(fieldEl)
    await user.click(fieldEl)
    expect(onStateChange).toHaveBeenLastCalledWith({
      isDirty: false,
      canSave: false,
      isSavePending: false,
    })
  })
})

// ── Combination radios visibility ───────────────────────────────────────────

describe('CreateMappingForm — combination radios', () => {
  it('combination radios appear once 2+ sources are selected', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    expect(screen.queryByTestId('create-mapping-form-combination')).toBeNull()
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    expect(screen.getByTestId('create-mapping-form-combination')).toBeInTheDocument()
  })

  it('concat_space is pre-selected when 2 sources selected', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    const concatSpaceLabel = screen.getByTestId(
      'create-mapping-form-combination-concat_space',
    )
    const radio = concatSpaceLabel.querySelector('input[type="radio"]')!
    expect(radio).toHaveProperty('checked', true)
  })

  it('custom_sql radio is rendered as disabled with a tooltip', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    const customLabel = screen.getByTestId(
      'create-mapping-form-combination-custom_sql',
    )
    expect(customLabel.getAttribute('data-disabled')).toBe('true')
    expect(customLabel.getAttribute('title')).toContain(
      'Custom SQL combinations are managed in the Transform tab',
    )
    const radio = customLabel.querySelector('input[type="radio"]')!
    expect(radio).toHaveProperty('disabled', true)
  })

  it('renders a dynamic example text from selected sources samples', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!, // LAST_NAME → 'Smith'
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!, // FIRST_NAME → 'Alpha'
    )
    // selection order: LAST_NAME then FIRST_NAME → 'Smith Alpha'
    const space = screen.getByTestId('create-mapping-form-combination-concat_space')
    expect(space.textContent).toContain('"Smith Alpha"')
    const comma = screen.getByTestId('create-mapping-form-combination-concat_comma')
    expect(comma.textContent).toContain('"Smith, Alpha"')
  })

  it('falls back to canned example when any source has no samples', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    // EMAIL has no samples — pair with FIRST_NAME
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-3')!, // EMAIL no samples
    )
    const space = screen.getByTestId('create-mapping-form-combination-concat_space')
    expect(space.textContent).toContain('"Smith John"')
  })
})

// ── Sample preview ───────────────────────────────────────────────────────────

describe('CreateMappingForm — sample preview', () => {
  it('renders single source preview head-capped at 3 with overflow', async () => {
    const user = userEvent.setup()
    const longField = field({
      id: 'sf-long',
      name: 'BIGGY',
      sampleValues: ['1', '2', '3', '4', '5'],
    })
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={[longField]}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('source-field-picker-field'))
    const rows = screen.getAllByTestId('create-mapping-form-preview-row')
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.textContent)).toEqual(['1', '2', '3'])
    expect(
      screen.getByTestId('create-mapping-form-preview-overflow').textContent,
    ).toContain('+ 2 more')
  })

  it('updates preview when combination changes from concat_space to concat_comma', async () => {
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!, // LAST_NAME (Smith,Doe,Roe)
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!, // FIRST_NAME (Alpha,Bravo,Charlie)
    )
    const initialRows = screen
      .getAllByTestId('create-mapping-form-preview-row')
      .map((r) => r.textContent)
    expect(initialRows[0]).toBe('Smith Alpha')

    const commaRadio = screen
      .getByTestId('create-mapping-form-combination-concat_comma')
      .querySelector('input[type="radio"]')! as HTMLElement
    await user.click(commaRadio)
    const updatedRows = screen
      .getAllByTestId('create-mapping-form-preview-row')
      .map((r) => r.textContent)
    expect(updatedRows[0]).toBe('Smith, Alpha')
  })
})

// ── Save success ────────────────────────────────────────────────────────────

describe('CreateMappingForm — save flow', () => {
  it('triggerSave invokes wrapper with single source and concat collapsed to single', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onSaveSuccess = vi.fn()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-new',
      tableMappingId: 'tm-1',
    })

    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={onSaveSuccess}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )

    await act(async () => {
      ref.current!.triggerSave()
    })

    expect(createFieldMappingMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
      sourceFieldIds: ['sf-cif-1'],
      combinationType: 'single',
    })
    expect(onSaveSuccess).toHaveBeenCalledWith('tfm-new')
  })

  it('triggerSave with 2 sources passes user-selected combination_type', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-2',
      tableMappingId: 'tm-1',
    })

    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    const commaRadio = screen
      .getByTestId('create-mapping-form-combination-concat_comma')
      .querySelector('input[type="radio"]')! as HTMLElement
    await user.click(commaRadio)

    await act(async () => {
      ref.current!.triggerSave()
    })

    expect(createFieldMappingMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
      sourceFieldIds: ['sf-cif-1', 'sf-cif-2'],
      combinationType: 'concat_comma',
    })
  })

  it('triggerSave is a no-op when nothing selected', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(createFieldMappingMock).not.toHaveBeenCalled()
  })

  it('eventually publishes isSavePending=false after a successful save', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-x',
      tableMappingId: 'tm-1',
    })

    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    // The very last published state must reflect a settled transition
    // — isSavePending=false is the steady state. (The pending-true
    // intermediate value is best observed via DOM disabled attributes
    // on the parent's footer buttons, exercised by drawer tests.)
    const lastCall = onStateChange.mock.calls.at(-1)![0]
    expect(lastCall.isSavePending).toBe(false)
  })
})

// ── Error mapping ────────────────────────────────────────────────────────────

describe('CreateMappingForm — save errors', () => {
  it('PERMISSION_DENIED renders the curated copy in the error banner', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: false,
      errorCode: 'PERMISSION_DENIED',
      error: 'no perm',
    })

    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fieldEl = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(fieldEl)
    await act(async () => {
      ref.current!.triggerSave()
    })

    const banner = screen.getByTestId('create-mapping-form-error')
    expect(banner.textContent).toContain("don't have permission")
    expect(screen.queryByTestId('create-mapping-form-refresh')).toBeNull()
  })

  it('VALIDATION (non-existing-tfm) renders generic copy WITHOUT refresh', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: false,
      errorCode: 'VALIDATION',
      error: 'something else',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    const banner = screen.getByTestId('create-mapping-form-error')
    expect(banner.textContent).toContain('check your selections')
    expect(screen.queryByTestId('create-mapping-form-refresh')).toBeNull()
  })

  it('EXISTING_TFM (VALIDATION + canonical phrase) renders refresh affordance', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: false,
      errorCode: 'VALIDATION',
      error:
        'This target field was mapped while you were editing. Refresh to see the current state.',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(
      screen.getByTestId('create-mapping-form-error').textContent,
    ).toContain('mapped while you were editing')
    const refresh = screen.getByTestId('create-mapping-form-refresh')
    await user.click(refresh)
    expect(routerRefreshMock).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('CROSS_TABLE_NOT_YET_SUPPORTED renders the 4a-3 copy', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: false,
      errorCode: 'CROSS_TABLE_NOT_YET_SUPPORTED',
      error: 'cross table',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(
      screen.getByTestId('create-mapping-form-error').textContent,
    ).toContain('Phase 4a-3')
  })

  it('thrown error falls back to INTERNAL copy', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockRejectedValue(new Error('network down'))
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(
      screen.getByTestId('create-mapping-form-error').textContent,
    ).toContain("Couldn't create the mapping. Please try again.")
  })

  it('clears error banner when user changes selection after a failure', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: false,
      errorCode: 'VALIDATION',
      error: 'something',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    const fieldEl = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(fieldEl)
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(screen.getByTestId('create-mapping-form-error')).toBeInTheDocument()
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    expect(screen.queryByTestId('create-mapping-form-error')).toBeNull()
  })
})

// ── Discard dialog ──────────────────────────────────────────────────────────

describe('CreateMappingForm — requestClose / discard dialog', () => {
  it('requestClose on a clean form invokes onCancel immediately (no dialog)', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onCancel = vi.fn()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await act(async () => {
      ref.current!.requestClose()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('create-mapping-form-discard-dialog')).toBeNull()
  })

  it('requestClose on a dirty form opens the discard dialog (no onCancel yet)', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.requestClose()
    })
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog'),
    ).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Keep editing dismisses dialog and does NOT call onCancel', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.requestClose()
    })
    await user.click(screen.getByTestId('create-mapping-form-discard-cancel'))
    expect(screen.queryByTestId('create-mapping-form-discard-dialog')).toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Discard confirms call onCancel and closes the dialog', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={onCancel}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.requestClose()
    })
    await user.click(screen.getByTestId('create-mapping-form-discard-confirm'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('create-mapping-form-discard-dialog')).toBeNull()
  })

  it('discard dialog body includes the target field name', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={{ id: 'tf-x', name: 'EMAIL_ADDR' }}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(
      screen
        .getAllByTestId('source-field-picker-field')
        .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await act(async () => {
      ref.current!.requestClose()
    })
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog').textContent,
    ).toContain('EMAIL_ADDR')
  })
})

// ── Light-mode invariant ────────────────────────────────────────────────────

describe('CreateMappingForm — light-mode invariant', () => {
  it('rendered HTML contains no dark: tailwind modifiers', () => {
    const { container } = render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
