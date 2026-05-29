import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { ReactNode } from 'react'
import {
  useMappingListMutations,
  type MappingMutationsLookups,
} from '@/app/app/projects/[projectId]/mapping/redesign/hooks/useMappingListMutations'
import type { PendingSourceDisambiguation } from '@/app/app/projects/[projectId]/mapping/redesign/components/SourceDisambiguationDialog'
import type {
  MappedRow,
  SourceFieldWithState,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────
// PR Ω.3.x.1 — Hook orchestration tests for the disambiguation popup.
// ─────────────────────────────────────────────────────────────────────
//
// We mock the wrapper server actions so the hook never reaches the
// real Anthropic/Supabase plumbing. The tests pin:
//
//   • `openPendingDisambiguation` parks the payload.
//   • `confirmDisambiguatedCreate` calls `createFieldMapping` with the
//     locked arguments (allowCrossTable: true, combinationType: 'single',
//     regenerateTrigger: 'create_disambiguated', sourceFieldIds:
//     [incoming]).
//   • `confirmDisambiguatedReplace` calls `rejectFieldMapping` THEN
//     `createFieldMapping` in order; both with the same locked
//     arguments.
//   • On success, the pending state clears and router.refresh fires.
//   • On reject failure during Replace, create is NEVER called.
//   • Cancel clears state without invoking either action.

const createFieldMappingMock = vi.fn()
const rejectFieldMappingMock = vi.fn()
const promoteUnmappedSourceMock = vi.fn()
const editMappingSourcesMock = vi.fn()
const routerRefreshMock = vi.fn()

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: vi.fn(),
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
  createMappingFromUnmapped: vi.fn(),
  editMappingSources: (...args: unknown[]) => editMappingSourcesMock(...args),
  promoteUnmappedSource: (...args: unknown[]) =>
    promoteUnmappedSourceMock(...args),
  rejectFieldMapping: (...args: unknown[]) => rejectFieldMappingMock(...args),
  setUnmappedRowRejected: vi.fn(),
  updateMappingSourceField: vi.fn(),
  updateMappingTargetField: vi.fn(),
}))

vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}))

// The toast context provider isn't required — we mock the consumer.
vi.mock('@/lib/contexts/ToastContext', () => ({
  useToast: () => ({ pushToast: vi.fn() }),
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

const PROJECT_ID = '11111111-1111-1111-1111-111111111111'

const PENDING: PendingSourceDisambiguation = {
  rowId: 'tfm-existing',
  existingTfmId: 'tfm-existing',
  targetFieldId: 'tf-item-number',
  targetFieldName: 'Item Number',
  existingSources: [
    { id: 'ms-1', sourceFieldName: 'Assy Item', sourceTableName: 'EBM' },
  ],
  incomingSource: {
    sourceFieldId: 'sf-productsku',
    sourceFieldName: 'ProductSKU',
    sourceTableName: 'ICC',
  },
}

// ── Lookups fixture for the in-hook intercept tests ───────────────────
//
// Tiny stand-ins for the maps `MappingContentLoaded` constructs from
// `data.rows` + `data.sourceFields`. The hook calls `.get()` / `.size`
// only — readonly Map<> is sufficient and we don't need the full
// `MappingRow` / `SourceFieldWithState` shape, just the fields the
// intercept logic reads.

const TARGET_ROW_MAPPED_EBM = {
  id: 'tfm-existing',
  kind: 'mapped' as const,
  targetField: {
    id: 'tf-item-number',
    name: 'Item Number',
  },
  sources: [
    {
      id: 'ms-1',
      sourceField: { id: 'sf-assyitem', name: 'Assy Item' },
      sourceTable: { id: 'st-ebm', name: 'EBM' },
    },
  ],
} as unknown as MappedRow

const SOURCE_ICC: SourceFieldWithState = {
  id: 'sf-productsku',
  name: 'ProductSKU',
  dataType: 'VARCHAR(40)',
  ordinalPosition: 1,
  sourceTable: { id: 'st-icc', name: 'ICC' },
  mappingStatus: 'unmapped',
  sampleValues: [],
  isAcknowledged: false,
  isRejected: false,
  aiReasoning: null,
  confidence: null,
}

const SOURCE_EBM_ANOTHER: SourceFieldWithState = {
  id: 'sf-itemcode',
  name: 'Item Code',
  dataType: 'VARCHAR(40)',
  ordinalPosition: 2,
  sourceTable: { id: 'st-ebm', name: 'EBM' },
  mappingStatus: 'unmapped',
  sampleValues: [],
  isAcknowledged: false,
  isRejected: false,
  aiReasoning: null,
  confidence: null,
}

function makeLookups(): MappingMutationsLookups {
  const rowsByTargetFieldId = new Map<string, MappedRow>()
  const mappedRowsByTfmId = new Map<string, MappedRow>()
  rowsByTargetFieldId.set(TARGET_ROW_MAPPED_EBM.targetField.id, TARGET_ROW_MAPPED_EBM)
  mappedRowsByTfmId.set(TARGET_ROW_MAPPED_EBM.id, TARGET_ROW_MAPPED_EBM)
  const sourceFieldsById = new Map<string, SourceFieldWithState>()
  sourceFieldsById.set(SOURCE_ICC.id, SOURCE_ICC)
  sourceFieldsById.set(SOURCE_EBM_ANOTHER.id, SOURCE_EBM_ANOTHER)
  return { rowsByTargetFieldId, mappedRowsByTfmId, sourceFieldsById }
}

describe('useMappingListMutations — PR Ω.3.x.1 disambiguation orchestration', () => {
  beforeEach(() => {
    createFieldMappingMock.mockReset()
    rejectFieldMappingMock.mockReset()
    promoteUnmappedSourceMock.mockReset()
    editMappingSourcesMock.mockReset()
    routerRefreshMock.mockReset()
  })

  it('initial state: nothing pending', () => {
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    expect(result.current.pendingDisambiguation).toBeNull()
    expect(result.current.isDisambiguationPending).toBe(false)
  })

  it('openPendingDisambiguation parks the payload verbatim', () => {
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    expect(result.current.pendingDisambiguation).toEqual(PENDING)
  })

  it('cancelPendingDisambiguation clears the payload', () => {
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    act(() => {
      result.current.cancelPendingDisambiguation()
    })
    expect(result.current.pendingDisambiguation).toBeNull()
  })

  it('confirmDisambiguatedCreate calls createFieldMapping with locked args + clears state on success', async () => {
    createFieldMappingMock.mockResolvedValue({ success: true, tfmId: 'tfm-new' })
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    let res: { success: boolean; tfmId?: string } = { success: false }
    await act(async () => {
      res = await result.current.confirmDisambiguatedCreate()
    })
    expect(res.success).toBe(true)
    expect(res.tfmId).toBe('tfm-new')
    expect(createFieldMappingMock).toHaveBeenCalledTimes(1)
    expect(createFieldMappingMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      targetFieldId: PENDING.targetFieldId,
      sourceFieldIds: [PENDING.incomingSource.sourceFieldId],
      combinationType: 'single',
      allowCrossTable: true,
      regenerateTrigger: 'create_disambiguated',
    })
    expect(rejectFieldMappingMock).not.toHaveBeenCalled()
    expect(result.current.pendingDisambiguation).toBeNull()
    expect(routerRefreshMock).toHaveBeenCalled()
  })

  it('confirmDisambiguatedCreate keeps state on server failure', async () => {
    createFieldMappingMock.mockResolvedValue({ success: false, error: 'boom' })
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    let res: { success: boolean; tfmId?: string } = { success: true }
    await act(async () => {
      res = await result.current.confirmDisambiguatedCreate()
    })
    expect(res.success).toBe(false)
    // Pending payload stays so the user can retry.
    expect(result.current.pendingDisambiguation).toEqual(PENDING)
    expect(routerRefreshMock).not.toHaveBeenCalled()
  })

  it('confirmDisambiguatedReplace calls reject THEN create, in order', async () => {
    const callOrder: string[] = []
    rejectFieldMappingMock.mockImplementation(async () => {
      callOrder.push('reject')
      return { success: true }
    })
    createFieldMappingMock.mockImplementation(async () => {
      callOrder.push('create')
      return { success: true, tfmId: 'tfm-replacement' }
    })

    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    let res: { success: boolean; tfmId?: string } = { success: false }
    await act(async () => {
      res = await result.current.confirmDisambiguatedReplace()
    })
    expect(res.success).toBe(true)
    expect(res.tfmId).toBe('tfm-replacement')
    expect(callOrder).toEqual(['reject', 'create'])
    expect(rejectFieldMappingMock).toHaveBeenCalledWith('tfm-existing')
    expect(createFieldMappingMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      targetFieldId: PENDING.targetFieldId,
      sourceFieldIds: [PENDING.incomingSource.sourceFieldId],
      combinationType: 'single',
      allowCrossTable: true,
      regenerateTrigger: 'create_disambiguated',
    })
    expect(result.current.pendingDisambiguation).toBeNull()
  })

  it('confirmDisambiguatedReplace short-circuits on reject failure — create is NEVER called', async () => {
    rejectFieldMappingMock.mockResolvedValue({ success: false, error: 'no perm' })
    createFieldMappingMock.mockResolvedValue({ success: true, tfmId: 'unreachable' })

    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    act(() => {
      result.current.openPendingDisambiguation(PENDING)
    })
    let res: { success: boolean; tfmId?: string } = { success: true }
    await act(async () => {
      res = await result.current.confirmDisambiguatedReplace()
    })
    expect(res.success).toBe(false)
    expect(rejectFieldMappingMock).toHaveBeenCalledTimes(1)
    expect(createFieldMappingMock).not.toHaveBeenCalled()
    // Pending stays so the user can retry.
    expect(result.current.pendingDisambiguation).toEqual(PENDING)
  })

  it('confirm methods are no-ops when nothing is pending', async () => {
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    let res: { success: boolean } = { success: true }
    await act(async () => {
      res = await result.current.confirmDisambiguatedCreate()
    })
    expect(res.success).toBe(false)
    expect(createFieldMappingMock).not.toHaveBeenCalled()
    await act(async () => {
      res = await result.current.confirmDisambiguatedReplace()
    })
    expect(res.success).toBe(false)
    expect(rejectFieldMappingMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// PR Ω.3.x.1 v1.1 — Hook-level intercept (covers flat view + drawer
// paths that don't go through MappingContent's handlers).
// ─────────────────────────────────────────────────────────────────────

describe('useMappingListMutations — PR Ω.3.x.1 promoteUnmappedSource intercept', () => {
  beforeEach(() => {
    promoteUnmappedSourceMock.mockReset()
  })

  it('parks the popup + SKIPS the server action when cross-table append is detected', async () => {
    const lookups = makeLookups()
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups }),
    )
    let res: { success: boolean; tfmId?: string } = { success: false }
    await act(async () => {
      // Picked source belongs to ICC; existing TFM is mapped from EBM.
      // → cross-table → intercept fires.
      res = await result.current.promoteUnmappedSource({
        sourceFieldId: SOURCE_ICC.id,
        targetFieldId: TARGET_ROW_MAPPED_EBM.targetField.id,
        pendingKey: 'unmapped-source::sf-productsku',
      })
    })
    expect(res.success).toBe(true)
    // Server action must NOT have fired.
    expect(promoteUnmappedSourceMock).not.toHaveBeenCalled()
    // Popup parked with the correct identities.
    const parked = result.current.pendingDisambiguation
    expect(parked).not.toBeNull()
    expect(parked?.targetFieldId).toBe(TARGET_ROW_MAPPED_EBM.targetField.id)
    expect(parked?.existingTfmId).toBe(TARGET_ROW_MAPPED_EBM.id)
    expect(parked?.incomingSource.sourceFieldId).toBe(SOURCE_ICC.id)
    expect(parked?.incomingSource.sourceTableName).toBe('ICC')
    expect(parked?.existingSources).toHaveLength(1)
    expect(parked?.existingSources[0].sourceTableName).toBe('EBM')
  })

  it('passes through to the server action when same-table (no intercept)', async () => {
    promoteUnmappedSourceMock.mockResolvedValue({ success: true, tfmId: 'tfm-new' })
    const lookups = makeLookups()
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups }),
    )
    await act(async () => {
      // Picked source belongs to EBM (same table as existing). Note:
      // this case is actually a duplicate-source append for an existing
      // mapped row — the server will likely reject as VALIDATION
      // ("source already in mapping"), but THAT's a server concern.
      // The hook intercept only fires on the cross-table predicate.
      await result.current.promoteUnmappedSource({
        sourceFieldId: SOURCE_EBM_ANOTHER.id,
        targetFieldId: TARGET_ROW_MAPPED_EBM.targetField.id,
        pendingKey: 'unmapped-source::sf-itemcode',
      })
    })
    expect(promoteUnmappedSourceMock).toHaveBeenCalledTimes(1)
    // Popup NOT parked.
    expect(result.current.pendingDisambiguation).toBeNull()
  })

  it('passes through when target is unmapped (no existing TFM)', async () => {
    promoteUnmappedSourceMock.mockResolvedValue({ success: true, tfmId: 'tfm-new' })
    // No row at all for this target field id → first branch of the
    // intercept short-circuits.
    const emptyLookups: MappingMutationsLookups = {
      rowsByTargetFieldId: new Map(),
      mappedRowsByTfmId: new Map(),
      sourceFieldsById: new Map([[SOURCE_ICC.id, SOURCE_ICC]]),
    }
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups: emptyLookups }),
    )
    await act(async () => {
      await result.current.promoteUnmappedSource({
        sourceFieldId: SOURCE_ICC.id,
        targetFieldId: 'tf-other',
        pendingKey: 'unmapped-source::sf-productsku',
      })
    })
    expect(promoteUnmappedSourceMock).toHaveBeenCalledTimes(1)
    expect(result.current.pendingDisambiguation).toBeNull()
  })

  it('when lookups are omitted, intercept is bypassed entirely', async () => {
    promoteUnmappedSourceMock.mockResolvedValue({ success: true, tfmId: 'tfm-new' })
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID }),
    )
    await act(async () => {
      await result.current.promoteUnmappedSource({
        sourceFieldId: SOURCE_ICC.id,
        targetFieldId: TARGET_ROW_MAPPED_EBM.targetField.id,
        pendingKey: 'unmapped-source::sf-productsku',
      })
    })
    expect(promoteUnmappedSourceMock).toHaveBeenCalledTimes(1)
    expect(result.current.pendingDisambiguation).toBeNull()
  })
})

describe('useMappingListMutations — PR Ω.3.x.1 editMappingSources intercept', () => {
  beforeEach(() => {
    editMappingSourcesMock.mockReset()
  })

  it('parks the popup + SKIPS the server action when a newly-added source is cross-table', async () => {
    const lookups = makeLookups()
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups }),
    )
    let res: { success: boolean } = { success: false }
    await act(async () => {
      // tfm already has EBM/Assy Item — adding ICC/ProductSKU = cross-table.
      res = await result.current.editMappingSources({
        tfmId: TARGET_ROW_MAPPED_EBM.id,
        sourceFieldIds: ['sf-assyitem', SOURCE_ICC.id],
        combinationType: 'concat_space',
      })
    })
    expect(res.success).toBe(true)
    expect(editMappingSourcesMock).not.toHaveBeenCalled()
    expect(result.current.pendingDisambiguation).not.toBeNull()
    expect(result.current.pendingDisambiguation?.incomingSource.sourceFieldId).toBe(
      SOURCE_ICC.id,
    )
  })

  it('passes through to server action when the new source is same-table', async () => {
    editMappingSourcesMock.mockResolvedValue({ success: true })
    const lookups = makeLookups()
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups }),
    )
    await act(async () => {
      // Adding SOURCE_EBM_ANOTHER (also in EBM) — silent combine path.
      await result.current.editMappingSources({
        tfmId: TARGET_ROW_MAPPED_EBM.id,
        sourceFieldIds: ['sf-assyitem', SOURCE_EBM_ANOTHER.id],
        combinationType: 'concat_space',
      })
    })
    expect(editMappingSourcesMock).toHaveBeenCalledTimes(1)
    expect(result.current.pendingDisambiguation).toBeNull()
  })

  it('passes through when there are no NEW sources (removal-only edit)', async () => {
    editMappingSourcesMock.mockResolvedValue({ success: true })
    const lookups = makeLookups()
    const { result } = renderHook(() =>
      useMappingListMutations({ projectId: PROJECT_ID, lookups }),
    )
    await act(async () => {
      // Same source set, no new fields — never cross-table by predicate.
      await result.current.editMappingSources({
        tfmId: TARGET_ROW_MAPPED_EBM.id,
        sourceFieldIds: ['sf-assyitem'],
        combinationType: 'single',
      })
    })
    expect(editMappingSourcesMock).toHaveBeenCalledTimes(1)
    expect(result.current.pendingDisambiguation).toBeNull()
  })
})
