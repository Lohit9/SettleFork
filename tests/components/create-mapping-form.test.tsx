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

const { createFieldMappingMock, suggestMappingMock, routerRefreshMock } =
  vi.hoisted(() => ({
    createFieldMappingMock: vi.fn(),
    suggestMappingMock: vi.fn(),
    routerRefreshMock: vi.fn(),
  }))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
  suggestMappingForTarget: (...args: unknown[]) => suggestMappingMock(...args),
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
  suggestMappingMock.mockReset()
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
      snapshot: null,
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
      snapshot: {
        targetFieldId: 'tf-1',
        selectedIds: ['sf-cif-1'],
        // Cycle 1 — `combinationType` is derived from selection length:
        // 1 source → 'single' (informational; persistence still routes
        // through `effectiveCombinationType` on the wrapper call).
        combinationType: 'single',
        joinAnnotations: {},
      },
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
      snapshot: null,
    })
  })
})

// ── Combination radios removed (Cycle 1) ────────────────────────────────────

describe('CreateMappingForm — combination radios removed (Cycle 1)', () => {
  it('NEVER renders the combination radios container, regardless of source count', async () => {
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
    expect(screen.queryByTestId('create-mapping-form-combination')).toBeNull()
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    expect(screen.queryByTestId('create-mapping-form-combination')).toBeNull()
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    expect(screen.queryByTestId('create-mapping-form-combination')).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-combination-concat_space'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-combination-concat_comma'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-combination-custom_sql'),
    ).toBeNull()
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

  it('preview renders concat_space-style joined samples for 2+ source selections (Cycle 1 — combination radios removed)', async () => {
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
    const rows = screen
      .getAllByTestId('create-mapping-form-preview-row')
      .map((r) => r.textContent)
    // Cycle 1 — `effectiveCombinationType` for 2+ sources in create
    // mode is the hard-coded default `'concat_space'`. The user no
    // longer has a UI to flip combination types.
    expect(rows[0]).toBe('Smith Alpha')
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
      joinAnnotations: {},
    })
    expect(onSaveSuccess).toHaveBeenCalledWith('tfm-new')
  })

  it('triggerSave with 2+ sources passes the derived `concat_space` combination_type (Cycle 1 — no user-facing radios)', async () => {
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

    await act(async () => {
      ref.current!.triggerSave()
    })

    expect(createFieldMappingMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      targetFieldId: 'tf-1',
      sourceFieldIds: ['sf-cif-1', 'sf-cif-2'],
      combinationType: 'concat_space',
      joinAnnotations: {},
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

  it('CROSS_TABLE_NOT_YET_SUPPORTED falls back to its generic copy when surfaced (legacy code, no longer emitted post-4a-3)', async () => {
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
    ).toMatch(/Cross-table mappings are not available/i)
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

// ── Cross-table disambiguation surface removed (Cycle 1) ────────────────────
//
// Cycle 1 deleted the form-side FK disambiguation prompt entirely
// (locked decision §6 — the wrapper's CROSS_TABLE_AMBIGUOUS error
// path was wholesale-deleted; multi-candidate ambiguity now surfaces
// at Transform-tab apply time as `CROSS_TABLE_FK_INFERENCE_FAILED`).
// The test surface that asserted the dropdown / zero-FK banner /
// resolved-row affordances was deleted alongside it. The regression
// guard below confirms none of those testids re-emerge.

describe('CreateMappingForm — cross-table disambiguation surface removed (Cycle 1)', () => {
  async function pickField(user: ReturnType<typeof userEvent.setup>, id: string) {
    const el = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === id)!
    await user.click(el)
  }

  it('passes joinAnnotations (defaulting to {}) on the wrapper call', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-new',
      tableMappingId: 'tm-new',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await pickField(user, 'sf-cif-1')
    await act(async () => {
      ref.current!.triggerSave()
    })
    const arg = createFieldMappingMock.mock.calls[0][0]
    // Wrapper still accepts `joinAnnotations` for backward-compat;
    // the value is `{}` since the form no longer surfaces the picker
    // that populated it. Cycle 1 ignores `joinAnnotations` on the
    // server side as well.
    expect(arg.joinAnnotations).toEqual({})
  })

  it('does NOT render the disambiguation dropdown / zero-FK banner / resolved row even when 2+ source tables are selected (Cycle 1)', async () => {
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-new',
      tableMappingId: 'tm-new',
    })
    render(
      <CreateMappingForm
        ref={ref}
        projectId="proj-1"
        targetField={targetField}
        availableSourceFields={allFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await pickField(user, 'sf-cif-1')
    await pickField(user, 'sf-acct-1')
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(screen.queryByTestId('create-mapping-form-disambiguation')).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-disambiguation-active'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-disambiguation-zero-fk'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-disambiguation-resolved'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-disambiguation-select'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-disambiguation-change'),
    ).toBeNull()
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4b — AI Suggest UI tests.
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTION_FIXTURE = {
  sourceFieldIds: ['sf-cif-1', 'sf-cif-2'],
  combinationType: 'concat_space' as const,
  confidence: 85,
  rationale: 'FIRST_NAME and LAST_NAME together best match customer_name.',
}

describe('CreateMappingForm — AI Suggest pill (idle state)', () => {
  it('renders the [Suggest with AI] pill on initial mount', () => {
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(
      screen.getByTestId('create-mapping-form-suggest-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('create-mapping-form-suggest-pending'),
    ).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-suggest-loaded'),
    ).toBeNull()
  })

  it('clicking the pill invokes suggestMappingForTarget with the target field id', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    expect(suggestMappingMock).toHaveBeenCalledWith({
      projectId: 'p1',
      targetFieldId: 'tf-1',
    })
  })
})

describe('CreateMappingForm — AI Suggest pending state', () => {
  it('renders "Suggesting…" while the wrapper is in flight', async () => {
    let resolve!: (v: unknown) => void
    suggestMappingMock.mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    )
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    expect(
      screen.getByTestId('create-mapping-form-suggest-pending'),
    ).toBeInTheDocument()
    // Resolve to release the promise so the test cleanup is clean.
    await act(async () => {
      resolve({ success: true, suggestion: SUGGESTION_FIXTURE })
    })
  })

  it('publishes isSuggestPending=true while pending and false after resolve', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const onSuggestStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onSuggestStateChange={onSuggestStateChange}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    // After resolution we should see at least one false call AFTER a true.
    const truthyCalls = onSuggestStateChange.mock.calls.filter(
      (c) => c[0].isSuggestPending === true,
    )
    expect(truthyCalls.length).toBeGreaterThanOrEqual(1)
    expect(onSuggestStateChange).toHaveBeenLastCalledWith({
      isSuggestPending: false,
    })
  })
})

describe('CreateMappingForm — AI Suggest loaded state (pre-fill)', () => {
  it('pre-fills selectedIds and combinationType from the suggestion', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        isDirty: true,
        canSave: true,
        snapshot: expect.objectContaining({
          selectedIds: ['sf-cif-1', 'sf-cif-2'],
          combinationType: 'concat_space',
        }),
      }),
    )
  })

  it('renders the ConfidencePill and Why? toggle', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-confidence-pill')
    expect(screen.getByTestId('create-mapping-form-why-toggle')).toBeInTheDocument()
  })

  it('Why? toggle expands the rationale panel', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-why-toggle')
    // Initially collapsed.
    expect(screen.queryByTestId('create-mapping-form-why-panel')).toBeNull()
    await user.click(screen.getByTestId('create-mapping-form-why-toggle'))
    expect(
      screen.getByTestId('create-mapping-form-why-panel').textContent,
    ).toContain('FIRST_NAME and LAST_NAME')
  })

  it('hides Why? toggle when rationale is empty', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: { ...SUGGESTION_FIXTURE, rationale: '' },
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(screen.queryByTestId('create-mapping-form-why-toggle')).toBeNull()
  })

  it('filters source ids that are not in availableSourceFields', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: {
        ...SUGGESTION_FIXTURE,
        sourceFieldIds: ['sf-cif-1', 'sf-not-present'],
      },
    })
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({ selectedIds: ['sf-cif-1'] }),
      }),
    )
  })

  it('surfaces AI_INVALID_RESPONSE if the filter empties the source list', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: {
        ...SUGGESTION_FIXTURE,
        sourceFieldIds: ['sf-not-present-1', 'sf-not-present-2'],
      },
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-error')
    expect(
      screen.getByTestId('create-mapping-form-suggest-error').textContent,
    ).toMatch(/AI suggestion didn't match/i)
  })

  it('narrows combinationType to "single" when filter reduces to 1 source', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: {
        ...SUGGESTION_FIXTURE,
        sourceFieldIds: ['sf-cif-1', 'sf-not-present'],
        combinationType: 'concat_space' as const,
      },
    })
    const onStateChange = vi.fn()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        onStateChange={onStateChange}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(onStateChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          selectedIds: ['sf-cif-1'],
          combinationType: 'single',
        }),
      }),
    )
  })

  it('defensively rejects custom_sql combinationType from the wrapper', async () => {
    // Wrapper narrows custom_sql server-side, but defense-in-depth on
    // the form per locked §4-OQ-1.
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: {
        ...SUGGESTION_FIXTURE,
        // Cast around the type guard to simulate a future drift.
        combinationType: 'custom_sql',
      },
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-error')
  })
})

describe('CreateMappingForm — AI Suggest error states', () => {
  it('RATE_LIMITED renders the wrapper verbatim message and disables the pill', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: false,
      errorCode: 'RATE_LIMITED',
      error:
        'AI rate limit reached (100/hour). Try again in 47 minutes.',
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    const banner = await screen.findByTestId(
      'create-mapping-form-suggest-error',
    )
    expect(banner.textContent).toContain('AI rate limit reached')
    // No Try-again button on RATE_LIMITED.
    expect(
      screen.queryByTestId('create-mapping-form-suggest-error-action'),
    ).toBeNull()
    // Pill becomes disabled with the rate-limit tooltip.
    const pill = screen.getByTestId('create-mapping-form-suggest-button')
    expect(pill).toBeDisabled()
    expect(pill.getAttribute('title')).toMatch(/rate-limited/i)
  })

  it('AI_INVALID_RESPONSE renders Try again affordance', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: false,
      errorCode: 'AI_INVALID_RESPONSE',
      error: 'parse error',
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-error')
    const action = screen.getByTestId(
      'create-mapping-form-suggest-error-action',
    )
    expect(action.textContent).toBe('Try again')

    // Clicking Try again re-invokes the wrapper.
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    await user.click(action)
    expect(suggestMappingMock).toHaveBeenCalledTimes(2)
  })

  it('NETWORK error (wrapper throws) renders Try again', async () => {
    suggestMappingMock.mockRejectedValueOnce(new Error('fetch failed'))
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    const banner = await screen.findByTestId(
      'create-mapping-form-suggest-error',
    )
    expect(banner.textContent).toMatch(/connection/i)
    expect(
      screen.getByTestId('create-mapping-form-suggest-error-action').textContent,
    ).toBe('Try again')
  })

  it('selection change clears a non-rate-limit error banner', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: false,
      errorCode: 'AI_INVALID_RESPONSE',
      error: 'parse error',
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-error')
    // Now flip the picker — error banner should clear (per locked §7-OQ-2).
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    expect(
      screen.queryByTestId('create-mapping-form-suggest-error'),
    ).toBeNull()
  })
})

describe('CreateMappingForm — AI Suggest cancel + race resolution', () => {
  it('cancelSuggest aborts the in-flight request and restores pre-pending state', async () => {
    let resolveFirst!: (v: unknown) => void
    suggestMappingMock.mockImplementationOnce(
      () => new Promise((r) => (resolveFirst = r)),
    )
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    expect(
      screen.getByTestId('create-mapping-form-suggest-pending'),
    ).toBeInTheDocument()
    await act(async () => {
      ref.current!.cancelSuggest()
    })
    expect(
      screen.queryByTestId('create-mapping-form-suggest-pending'),
    ).toBeNull()
    // Resolve the dropped promise; the form should ignore it.
    await act(async () => {
      resolveFirst({ success: true, suggestion: SUGGESTION_FIXTURE })
    })
    expect(
      screen.queryByTestId('create-mapping-form-suggest-loaded'),
    ).toBeNull()
  })

  it('rapid Suggest+Cancel+Suggest yields exactly one loaded state', async () => {
    let resolveFirst!: (v: unknown) => void
    suggestMappingMock.mockImplementationOnce(
      () => new Promise((r) => (resolveFirst = r)),
    )
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await act(async () => {
      ref.current!.cancelSuggest()
    })
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    // Resolve the first dropped promise — should NOT replace the loaded state.
    await act(async () => {
      resolveFirst({
        success: true,
        suggestion: { ...SUGGESTION_FIXTURE, confidence: 30 },
      })
    })
    const pill = screen.getByTestId('create-mapping-form-confidence-pill')
    // The current loaded state should still be the SECOND invocation (85),
    // not the dropped first one (30).
    expect(pill.dataset.threshold).toBe('high')
  })
})

describe('CreateMappingForm — AI Suggest replace-warning gate', () => {
  it('does NOT pop replace-warning on empty form', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    expect(
      screen
        .queryByTestId('create-mapping-form-discard-dialog')
        ?.getAttribute('data-variant'),
    ).not.toBe('replace-ai')
  })

  it('does NOT pop replace-warning on second click when user has not edited the suggestion', async () => {
    suggestMappingMock.mockResolvedValue({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    // Second click on the in-form re-suggest button — silent replace.
    await user.click(
      screen.getByTestId('create-mapping-form-suggest-replace-button'),
    )
    expect(
      screen
        .queryByTestId('create-mapping-form-discard-dialog')
        ?.getAttribute('data-variant'),
    ).not.toBe('replace-ai')
  })

  it('pops replace-warning when user edited the loaded suggestion', async () => {
    suggestMappingMock.mockResolvedValue({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    // Edit the suggestion: deselect one of the suggested fields.
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    // Now click re-suggest — should pop the replace-warning variant.
    await user.click(
      screen.getByTestId('create-mapping-form-suggest-replace-button'),
    )
    const dlg = screen.getByTestId('create-mapping-form-discard-dialog')
    expect(dlg.getAttribute('data-variant')).toBe('replace-ai')
    // Confirming Replace fires a new suggest.
    await user.click(
      screen.getByTestId('create-mapping-form-discard-confirm'),
    )
    expect(suggestMappingMock).toHaveBeenCalledTimes(2)
  })

  it('Keep editing dismisses replace-warning without invoking', async () => {
    suggestMappingMock.mockResolvedValue({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
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
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      screen.getByTestId('create-mapping-form-suggest-replace-button'),
    )
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog').getAttribute(
        'data-variant',
      ),
    ).toBe('replace-ai')
    await user.click(screen.getByTestId('create-mapping-form-discard-cancel'))
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)
  })
})

describe('CreateMappingForm — autoSuggest one-shot mount-time fire', () => {
  it('autoSuggest=true fires invokeSuggest exactly once on mount', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const onAutoSuggestConsumed = vi.fn()
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
        autoSuggest
        onAutoSuggestConsumed={onAutoSuggestConsumed}
      />,
    )
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)
    expect(onAutoSuggestConsumed).toHaveBeenCalledTimes(1)
  })

  it('autoSuggest=false (default) does NOT auto-fire', () => {
    render(
      <CreateMappingForm
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(suggestMappingMock).not.toHaveBeenCalled()
  })

  // Phase 4a-4b — strict-mode-resistant consumption guard regression.
  //
  // In Next.js 14 dev (`reactStrictMode: true` by default for app
  // router) every component mount runs effects twice (mount → cleanup
  // → mount-again). A `useRef(false)` *inside* the form would reset on
  // the second mount and admit a duplicate `invokeSuggest` invocation,
  // issuing two server-side LLM calls per click.
  //
  // The fix lifts the consumption guard to the parent (drawer): a
  // `Set<string>` keyed by target field id, owned by the drawer's
  // `useRef`, threaded down via `tryConsumeAutoSuggest`. The drawer
  // does not remount during the form's strict-mode cycle, so the Set
  // survives and the second mount short-circuits.
  //
  // These tests assert the parent-owned guard contract directly,
  // without depending on `<React.StrictMode>` (which Vitest does not
  // enable by default).
  it('parent-owned guard: same target field id remount does NOT re-fire invokeSuggest', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const consumed = new Set<string>()
    const tryConsume = (id: string) => {
      if (consumed.has(id)) return false
      consumed.add(id)
      return true
    }
    const props = {
      projectId: 'p1',
      targetField,
      availableSourceFields: cifFields,
      onSaveSuccess: () => {},
      onCancel: () => {},
      autoSuggest: true,
      tryConsumeAutoSuggest: tryConsume,
    }
    const { unmount } = render(<CreateMappingForm {...props} />)
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)

    // Simulate strict-mode unmount → remount on the same row. The
    // parent's Set persists across the form's lifecycle.
    unmount()
    render(<CreateMappingForm {...props} />)

    // Give any queued effect a tick to run (and demonstrate it does
    // NOT fire invokeSuggest a second time).
    await act(() => Promise.resolve())
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)
  })

  it('parent-owned guard: different target field id DOES fire invokeSuggest on second mount', async () => {
    suggestMappingMock.mockResolvedValue({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const consumed = new Set<string>()
    const tryConsume = (id: string) => {
      if (consumed.has(id)) return false
      consumed.add(id)
      return true
    }
    const otherTarget = { id: 'tf-2', name: 'customer_email' }
    const baseProps = {
      projectId: 'p1',
      availableSourceFields: cifFields,
      onSaveSuccess: () => {},
      onCancel: () => {},
      autoSuggest: true,
      tryConsumeAutoSuggest: tryConsume,
    }
    const { unmount } = render(
      <CreateMappingForm {...baseProps} targetField={targetField} />,
    )
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)

    unmount()
    render(<CreateMappingForm {...baseProps} targetField={otherTarget} />)

    // New target field id was not in the Set — should fire a second
    // invocation.
    await act(() => Promise.resolve())
    expect(suggestMappingMock).toHaveBeenCalledTimes(2)
  })

  it('parent-owned guard: re-request on same row after Set entry is cleared DOES fire again', async () => {
    suggestMappingMock.mockResolvedValue({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    const consumed = new Set<string>()
    const tryConsume = (id: string) => {
      if (consumed.has(id)) return false
      consumed.add(id)
      return true
    }
    const props = {
      projectId: 'p1',
      targetField,
      availableSourceFields: cifFields,
      onSaveSuccess: () => {},
      onCancel: () => {},
      autoSuggest: true,
      tryConsumeAutoSuggest: tryConsume,
    }
    const { unmount } = render(<CreateMappingForm {...props} />)
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(suggestMappingMock).toHaveBeenCalledTimes(1)

    // Simulate the drawer's `onSuggestWithAIClick` clearing the entry
    // (re-request on the same row after a cancel).
    unmount()
    consumed.delete(targetField.id)
    render(<CreateMappingForm {...props} />)

    await screen.findByTestId('create-mapping-form-suggest-loaded')
    expect(suggestMappingMock).toHaveBeenCalledTimes(2)
  })
})

describe('CreateMappingForm — save flow with AI metadata + laundering correction', () => {
  it('saves with aiSuggested+confidence+aiReasoning when AI sources are kept', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    createFieldMappingMock.mockResolvedValueOnce({
      success: true,
      tfmId: 'tfm-1',
    })
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(createFieldMappingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSuggested: true,
        confidence: 85,
        aiReasoning: SUGGESTION_FIXTURE.rationale,
      }),
    )
  })

  it('saves WITHOUT AI metadata when ALL original sources are removed (laundering prevention)', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    createFieldMappingMock.mockResolvedValueOnce({
      success: true,
      tfmId: 'tfm-1',
    })
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    // Remove BOTH original suggested ids and add a different one.
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-3')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    const call = createFieldMappingMock.mock.calls[0][0]
    expect(call.aiSuggested).toBeUndefined()
    expect(call.confidence).toBeUndefined()
    expect(call.aiReasoning).toBeUndefined()
  })

  it('preserves AI metadata when at least one original source is kept', async () => {
    suggestMappingMock.mockResolvedValueOnce({
      success: true,
      suggestion: SUGGESTION_FIXTURE,
    })
    createFieldMappingMock.mockResolvedValueOnce({
      success: true,
      tfmId: 'tfm-1',
    })
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
        projectId="p1"
        targetField={targetField}
        availableSourceFields={cifFields}
        onSaveSuccess={() => {}}
        onCancel={() => {}}
      />,
    )
    await user.click(screen.getByTestId('create-mapping-form-suggest-button'))
    await screen.findByTestId('create-mapping-form-suggest-loaded')
    // Drop ONE of two AI sources, keep the other.
    const fields = screen.getAllByTestId('source-field-picker-field')
    await user.click(
      fields.find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-2')!,
    )
    await act(async () => {
      ref.current!.triggerSave()
    })
    expect(createFieldMappingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        aiSuggested: true,
        confidence: 85,
      }),
    )
  })

  it('saves WITHOUT AI metadata on a never-AI-suggested manual flow (control)', async () => {
    createFieldMappingMock.mockResolvedValueOnce({
      success: true,
      tfmId: 'tfm-1',
    })
    const ref = createRef<CreateMappingFormHandle>()
    const user = userEvent.setup()
    render(
      <CreateMappingForm
        ref={ref}
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
    await act(async () => {
      ref.current!.triggerSave()
    })
    const call = createFieldMappingMock.mock.calls[0][0]
    expect(call.aiSuggested).toBeUndefined()
    expect(call.confidence).toBeUndefined()
    expect(call.aiReasoning).toBeUndefined()
  })
})

