import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  MappingDrawer,
  type DrawerRow,
  type SourceFieldDrawerRow,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer'
import type {
  MappedRow,
  MappingSourceRef,
  SourceFieldWithState,
  TargetFieldRef,
  UnmappedRow,
} from '@/lib/types/mappings-for-redesign'

// MappingDrawer transitively imports `@/lib/actions/mappings-for-redesign`
// (for its footer Approve/Reject), which pulls in the Anthropic client at
// module load — disallowed in jsdom. Mock the action module so the AI
// client never loads; these tests drive the drawer via injected handler
// props, never the real server actions. Mirrors mapping-drawer.test.tsx.
vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: vi.fn(),
  rejectFieldMapping: vi.fn(),
  resetMappingStatus: vi.fn(),
  setUnmappedRowRejected: vi.fn(),
}))

// MappingDrawer also imports `@/lib/actions/field-acknowledgments` for
// the source-field-only drawer footer — a `'use server'` module that
// pulls in `server-only`, disallowed in jsdom. Mock it too.
vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: vi.fn(),
  removeAcknowledgment: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}))

// ─────────────────────────────────────────────────────────────────────────────
// feat/drawer-body-editing-surface — cardinality-transition tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// The drawer body is a parallel editing surface to the flat view. Each
// editing affordance triggers a server action that may change the
// cardinality of the underlying TFM. The actual row-list re-derivation
// happens server-side (flattenRowsForListView re-runs after
// router.refresh()); these tests pin the DETERMINISTIC client contract —
// "the affordance fires the correct handler with the correct arguments"
// — for every transition in the matrix, plus the drawer's continuity
// behavior (it follows a row through a promotion rather than closing).
//
// Transition matrix coverage:
//   T1  unmapped-source → unmapped target      → onPromoteSource
//   T2  unmapped-source → already-mapped target → onPromoteSource
//        (T1/T2 are one client call; the create-vs-append branch is
//         server-side in `promoteUnmappedSource` and is covered by the
//         server action's own logic, not the drawer UI.)
//   T3  unmapped-target → pick a source         → onCreateMapping
//   T4  mapped single → + Add source            → onEditSources (existing,
//        covered in mapping-drawer.test.tsx — re-asserted here lightly)
//   T5  mapped multi → ✕ remove to 1            → onEditSources 'single'
//        (existing, covered in mapping-drawer.test.tsx)
//   T6  mapped target swap → unmapped target     → onSwapTarget
//   T7  mapped target swap → already-mapped      → onSwapTarget returns
//        { success: false, mergeOpened: true }; the picker closes and
//        the merge-confirmation dialog takes over the surface. A plain
//        failed result still keeps the picker open for retry (T7b).

// ── Fixtures ────────────────────────────────────────────────────────────────

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'accounts' },
    ordinalPosition: 1,
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

function source(overrides: Partial<MappingSourceRef> = {}): MappingSourceRef {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 98,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: {
      id: 'sf-1',
      name: 'ACCT_NO',
      dataType: 'NUMBER',
      isNullable: false,
    },
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...overrides,
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'tfm-1',
    targetField: targetField(),
    confidence: 98,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    sources: [source()],
    combinationType: 'single',
    combinationSql: null,
    aiReasoning: null,
    ...overrides,
  }
}

function unmapped(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-4',
    targetField: targetField({ id: 'tf-4', name: 'missing_field' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    ...overrides,
  }
}

function sourceFieldWithState(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-orphan',
    name: 'LEGACY_CODE',
    dataType: 'VARCHAR(50)',
    ordinalPosition: 3,
    sourceTable: { id: 'st-9', name: 'LEGACY_TBL' },
    mappingStatus: 'unmapped',
    sampleValues: ['A1', 'B2'],
    isAcknowledged: false,
    isRejected: false,
    aiReasoning: null,
    confidence: null,
    ...overrides,
  }
}

function sourceStub(
  overrides: Partial<SourceFieldDrawerRow> = {},
): SourceFieldDrawerRow {
  return {
    kind: 'source-field-only',
    id: 'unmapped-source::sf-orphan',
    sourceField: sourceFieldWithState(),
    acknowledgmentReason: null,
    ...overrides,
  }
}

// Two target fields so the pickers always have a non-current option.
const TARGET_UNIVERSE: TargetFieldRef[] = [
  targetField(),
  targetField({
    id: 'tf-99',
    name: 'legacy_code',
    targetTable: { id: 'tt-2', name: 'ledger' },
  }),
]

const SOURCE_UNIVERSE: SourceFieldWithState[] = [
  sourceFieldWithState(),
  sourceFieldWithState({
    id: 'sf-2',
    name: 'CUST_REF',
    sourceTable: { id: 'st-9', name: 'LEGACY_TBL' },
  }),
]

// ─────────────────────────────────────────────────────────────────────────────
// T6 / T7 — mapped row TARGET column pencil → onSwapTarget
// ─────────────────────────────────────────────────────────────────────────────

describe('drawer mapped body — TARGET column swap (T6 / T7)', () => {
  it('renders the target pencil only when onSwapTarget + availableTargetFields are threaded', () => {
    const { rerender } = render(
      <MappingDrawer row={mapped()} isOpen onClose={() => {}} />,
    )
    // No handler → read-only target block, no pencil.
    expect(
      screen.queryByTestId('drawer-mapping-target-edit'),
    ).not.toBeInTheDocument()

    rerender(
      <MappingDrawer
        row={mapped()}
        isOpen
        onClose={() => {}}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    expect(
      screen.getByTestId('drawer-mapping-target-edit'),
    ).toBeInTheDocument()
  })

  it('T6 — committing a new target fires onSwapTarget(tfmId, newTargetFieldId)', async () => {
    const onSwapTarget = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen
        onClose={() => {}}
        onSwapTarget={onSwapTarget}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-mapping-target-edit'))
    const picker = await screen.findByTestId('target-field-cell-picker')

    // Pick the non-current target field (tf-1 is the row's current target
    // and is rendered disabled by the picker).
    const option = within(picker)
      .getAllByTestId('target-field-cell-picker-field')
      .find((el) => el.getAttribute('data-target-field-id') === 'tf-99')
    expect(option).toBeDefined()
    fireEvent.click(option as HTMLElement)

    expect(onSwapTarget).toHaveBeenCalledWith('tfm-1', 'tf-99')
  })

  it('T7 — a merge-required swap closes the picker (the merge dialog takes over)', async () => {
    // A swap onto an already-mapped target returns
    // { success: false, mergeOpened: true }. The picker closes — the
    // merge-confirmation dialog (hosted by MappingContent) owns the
    // surface from here.
    const onSwapTarget = vi
      .fn()
      .mockResolvedValue({ success: false, mergeOpened: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen
        onClose={() => {}}
        onSwapTarget={onSwapTarget}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-mapping-target-edit'))
    const picker = await screen.findByTestId('target-field-cell-picker')
    const option = within(picker)
      .getAllByTestId('target-field-cell-picker-field')
      .find((el) => el.getAttribute('data-target-field-id') === 'tf-99')
    fireEvent.click(option as HTMLElement)

    expect(onSwapTarget).toHaveBeenCalledWith('tfm-1', 'tf-99')
    await waitFor(() => {
      expect(
        screen.queryByTestId('target-field-cell-picker'),
      ).not.toBeInTheDocument()
    })
  })

  it('T7b — a plain failed swap keeps the picker open for retry', async () => {
    // A genuine failure (no mergeOpened) surfaces an error toast and
    // returns { success: false }. The picker stays open so the user can
    // pick a different target.
    const onSwapTarget = vi.fn().mockResolvedValue({ success: false })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen
        onClose={() => {}}
        onSwapTarget={onSwapTarget}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-mapping-target-edit'))
    const picker = await screen.findByTestId('target-field-cell-picker')
    const option = within(picker)
      .getAllByTestId('target-field-cell-picker-field')
      .find((el) => el.getAttribute('data-target-field-id') === 'tf-99')
    fireEvent.click(option as HTMLElement)

    expect(onSwapTarget).toHaveBeenCalledWith('tfm-1', 'tf-99')
    // Picker still mounted — the user can pick a different target.
    expect(screen.getByTestId('target-field-cell-picker')).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3 — unmapped-target body "Pick a source…" → onCreateMapping
// ─────────────────────────────────────────────────────────────────────────────

describe('drawer unmapped-target body — "Pick a source…" (T3)', () => {
  it('renders the affordance only when onCreateMapping + availableSourceFields are threaded', () => {
    const { rerender } = render(
      <MappingDrawer row={unmapped()} isOpen onClose={() => {}} />,
    )
    expect(
      screen.queryByTestId('drawer-unmapped-pick-source'),
    ).not.toBeInTheDocument()

    rerender(
      <MappingDrawer
        row={unmapped()}
        isOpen
        onClose={() => {}}
        onCreateMapping={vi.fn().mockResolvedValue({ success: true })}
        availableSourceFields={SOURCE_UNIVERSE}
      />,
    )
    expect(
      screen.getByTestId('drawer-unmapped-pick-source'),
    ).toBeInTheDocument()
  })

  it('committing a source fires onCreateMapping(sourceFieldId, targetFieldId)', async () => {
    const onCreateMapping = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen
        onClose={() => {}}
        onCreateMapping={onCreateMapping}
        availableSourceFields={SOURCE_UNIVERSE}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-unmapped-pick-source'))
    const picker = await screen.findByTestId('inline-source-picker')

    const option = within(picker)
      .getAllByTestId('source-field-picker-field')
      .find((el) => el.getAttribute('data-source-field-id') === 'sf-2')
    expect(option).toBeDefined()
    fireEvent.click(option as HTMLElement)

    // unmapped() fixture's target field id is tf-4.
    expect(onCreateMapping).toHaveBeenCalledWith('sf-2', 'tf-4')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T1 / T2 — unmapped-source stub "Pick a target…" → onPromoteSource
// ─────────────────────────────────────────────────────────────────────────────

describe('drawer source-field stub — "Pick a target…" (T1 / T2)', () => {
  it('renders the affordance only when onPromoteSource + availableTargetFields are threaded', () => {
    const { rerender } = render(
      <MappingDrawer row={sourceStub()} isOpen onClose={() => {}} />,
    )
    // The stub stays minimal — no affordance without the handler.
    expect(
      screen.queryByTestId('drawer-source-stub-pick-target'),
    ).not.toBeInTheDocument()

    rerender(
      <MappingDrawer
        row={sourceStub()}
        isOpen
        onClose={() => {}}
        onPromoteSource={vi.fn().mockResolvedValue({ success: true })}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    expect(
      screen.getByTestId('drawer-source-stub-pick-target'),
    ).toBeInTheDocument()
  })

  it('committing a target fires onPromoteSource(sourceFieldId, targetFieldId)', async () => {
    // T1 (target unmapped → new 1:1 TFM) and T2 (target already mapped →
    // source appended) are ONE client call; the branch is server-side in
    // promoteUnmappedSource. The drawer contract is identical for both.
    const onPromoteSource = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={sourceStub()}
        isOpen
        onClose={() => {}}
        onPromoteSource={onPromoteSource}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-source-stub-pick-target'))
    const picker = await screen.findByTestId('target-field-cell-picker')

    // No current target on a source-side promotion — every option is
    // selectable. Pick tf-1.
    const option = within(picker)
      .getAllByTestId('target-field-cell-picker-field')
      .find((el) => el.getAttribute('data-target-field-id') === 'tf-1')
    expect(option).toBeDefined()
    fireEvent.click(option as HTMLElement)

    expect(onPromoteSource).toHaveBeenCalledWith('sf-orphan', 'tf-1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4 / T5 — mapped + Add source / multi ✕ remove (existing affordances)
// ─────────────────────────────────────────────────────────────────────────────

describe('drawer mapped body — source-set edits (T4 / T5)', () => {
  // The "+ Add source" button and per-source ✕ remove predate this PR
  // (feat/mapping-drawer-header-redesign). Their commit wiring is covered
  // in mapping-drawer.test.tsx. Here we only re-assert that adding the
  // TARGET pencil did not disturb the SOURCE column affordances.
  it('+ Add source and per-source pencil still render alongside the new target pencil', () => {
    render(
      <MappingDrawer
        row={mapped({
          combinationType: 'concat_space',
          sources: [
            source(),
            source({
              id: 'ms-2',
              ordinal: 1,
              sourceField: {
                id: 'sf-2',
                name: 'ACCT_SUFFIX',
                dataType: 'VARCHAR',
                isNullable: true,
              },
            }),
          ],
        })}
        isOpen
        onClose={() => {}}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        availableSourceFields={SOURCE_UNIVERSE}
        availableTargetFields={TARGET_UNIVERSE}
      />,
    )
    // SOURCE column: add-source button + per-source remove (multi) intact.
    expect(
      screen.getByTestId('drawer-mapping-add-source'),
    ).toBeInTheDocument()
    expect(
      screen.getAllByTestId('drawer-mapping-source-remove').length,
    ).toBe(2)
    // TARGET column: the new pencil coexists.
    expect(
      screen.getByTestId('drawer-mapping-target-edit'),
    ).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Drawer continuity — the drawer follows a row through promotion
// ─────────────────────────────────────────────────────────────────────────────

describe('drawer continuity through promotion', () => {
  // MappingContent re-points `drawerRowId` at the resolved TFM id after a
  // successful promotion (reusing the pendingDrawerRowId sentinel). This
  // harness plays MappingContent's role: it holds the drawer `row` in
  // state and swaps it from the source-field stub to the promoted mapped
  // row when onPromoteSource resolves — exactly what the real parent does
  // once router.refresh() rehydrates. The drawer must STAY OPEN and
  // render the mapped body.
  function ContinuityHarness() {
    const [row, setRow] = useState<DrawerRow>(sourceStub())
    return (
      <MappingDrawer
        row={row}
        isOpen
        onClose={() => {}}
        availableTargetFields={TARGET_UNIVERSE}
        onPromoteSource={async () => {
          setRow(mapped({ id: 'tfm-promoted' }))
          return { success: true }
        }}
      />
    )
  }

  it('promoting an unmapped-source row keeps the drawer open and shows the mapped body', async () => {
    render(<ContinuityHarness />)

    // Before: the source-field stub is rendered.
    expect(
      screen.getByTestId('mapping-drawer-source-stub-title'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('drawer-section-mapping-grid'),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('drawer-source-stub-pick-target'))
    const picker = await screen.findByTestId('target-field-cell-picker')
    fireEvent.click(
      within(picker).getAllByTestId('target-field-cell-picker-field')[0],
    )

    // After: the drawer followed the row — still open, now the mapped body.
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
    expect(
      await screen.findByTestId('drawer-section-mapping-grid'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-source-stub-title'),
    ).not.toBeInTheDocument()
  })
})
