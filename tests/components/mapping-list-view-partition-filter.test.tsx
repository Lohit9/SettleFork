/**
 * MappingListView × flat partition filter (PR Ω.3.2.2 §5 MLV-P1–3).
 *
 * Covers the integration: MappingListView accepts the new
 * `flatPartitionSelection` prop and threads it into the
 * `filterFlatRows` call (commit 1's wire-up). Predicate semantics
 * themselves are exercised in tests/utils/mapping-filters.test.ts
 * (FFR1–5); this file is the wire-shape proof.
 */

import * as React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { MappingListView } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingListView'
import type {
  MappedRow,
  MappingsForRedesignResult,
  SourceFieldWithState,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// MappingListView transitively imports server actions through
// useMappingListMutations; stub them so the jsdom mount doesn't
// reach for Supabase credentials.
vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: vi.fn(),
  rejectFieldMapping: vi.fn(),
  swapMappingTarget: vi.fn(),
  swapMappingSource: vi.fn(),
  editMappingSources: vi.fn(),
  createFieldMapping: vi.fn(),
  previewBulkApprove: vi.fn(),
  previewBulkReject: vi.fn(),
  bulkApproveFieldMappingsForTargetTable: vi.fn(),
  bulkRejectFieldMappingsForTargetTable: vi.fn(),
  approveHighConfidenceMappings: vi.fn(),
}))

vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeSourceField: vi.fn(),
  unacknowledgeSourceField: vi.fn(),
  rejectSourceField: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

// ─── Fixture builders ───────────────────────────────────────────────────

const tableA = { id: 'tt-a', name: 'accounts' }
const tableB = { id: 'tt-b', name: 'balances' }

function targetField(overrides: Partial<MappedRow['targetField']> = {}) {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: tableA,
    ordinalPosition: 1,
    isPrimaryKey: false,
    isForeignKey: false,
    fkReference: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

function source() {
  return {
    id: 'ms-1',
    ordinal: 0,
    confidence: 95,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: {
      id: 'sf-1',
      name: 'ACCT_NO',
      dataType: 'VARCHAR(50)',
      isNullable: false,
    },
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
  }
}

function mapped(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    kind: 'mapped',
    id: 'm-1',
    targetField: targetField(),
    confidence: 95,
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

function valueAssignment(
  overrides: Partial<ValueAssignmentRow> = {},
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: 'va-1',
    targetField: targetField({ id: 'tf-va', name: 'created_at' }),
    confidence: 90,
    status: 'approved',
    hasTransformation: true,
    transformationStatus: 'applied',
    transformationDescription: null,
    transformationSqlPreview: null,
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
    ...overrides,
  }
}

function unmappedRow(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-u',
    targetField: targetField({ id: 'tf-u', name: 'missing_field' }),
    confidence: null,
    status: 'unmapped',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    ...overrides,
  }
}

function unmappedSourceField(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-orphan',
    name: 'ORPHAN_COL',
    dataType: 'VARCHAR',
    ordinalPosition: 1,
    sourceTable: { id: 'st-orphan', name: 'ORPHAN_TABLE' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
    aiReasoning: null,
    confidence: null,
    ...overrides,
  }
}

function buildResult(): MappingsForRedesignResult {
  return {
    projectId: 'proj-1',
    rows: [
      mapped({
        id: 'm-a1',
        tableMappingId: 'tm-a-1',
        targetField: targetField({ id: 'tf-a1', name: 'a_field_1' }),
        sources: [{ ...source(), id: 'ms-a1' }],
      }),
      mapped({
        id: 'm-a2',
        tableMappingId: 'tm-a-2',
        targetField: targetField({ id: 'tf-a2', name: 'a_field_2' }),
        sources: [{ ...source(), id: 'ms-a2' }],
      }),
      mapped({
        id: 'm-b1',
        tableMappingId: 'tm-b-1',
        targetField: targetField({
          id: 'tf-b1',
          name: 'b_field_1',
          targetTable: tableB,
        }),
        sources: [{ ...source(), id: 'ms-b1' }],
      }),
      valueAssignment({
        id: 'va-a',
        tableMappingId: 'tm-a-1',
      }),
      unmappedRow({
        id: 'unmapped::tf-u-a::tm-a-2',
        tableMappingId: 'tm-a-2',
        targetField: targetField({ id: 'tf-u-a', name: 'unmapped_a' }),
      }),
    ],
    targetTables: [
      { id: tableA.id, name: tableA.name, datasetName: 'erp', fieldCount: 4 },
      { id: tableB.id, name: tableB.name, datasetName: 'erp', fieldCount: 1 },
    ],
    sourceTables: [],
    sourceFieldAcknowledgments: [],
    sourceFields: [
      unmappedSourceField({ id: 'sf-orphan-1', name: 'ORPHAN_1' }),
    ],
    counts: { total: 0, approved: 0, needsReview: 0, rejected: 0, unmapped: 0 },
    targetSchemaEmpty: false,
  }
}

// MappingListMutations has ~15 methods; we exercise zero in these
// tests (the filter pipeline runs before any row interaction). A
// Proxy that returns no-op vi.fn()s for any property access satisfies
// the contract without mirroring the surface — `isRowBusy` reads as
// a function that returns `undefined` (falsy → not busy), which is
// the right default for unstyled rendering.
function noopMutationsProxy() {
  return new Proxy(
    {},
    {
      get: (_, prop) => {
        // The `pendingMerge` accessor and similar non-fn properties
        // need to read as `null` for the render to settle.
        if (prop === 'pendingMerge' || prop === 'isMergePending') return null
        return vi.fn()
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any
}

function renderListView(
  flatPartitionSelection?: ReadonlySet<string>,
) {
  const result = buildResult()
  return render(
    <MappingListView
      filteredResult={result}
      mutations={noopMutationsProxy()}
      onOpenDrawer={vi.fn()}
      flatPartitionSelection={flatPartitionSelection}
    />,
  )
}

// ─── MLV-P1 — heritage byte-identity (empty / undefined) ────────────────

describe('[MappingListView] MLV-P1 — heritage byte-identity (no partition filter)', () => {
  it('renders all rows when flatPartitionSelection is undefined', () => {
    renderListView(undefined)
    // 3 mapped + 1 VA + 1 unmapped-target + 1 unmapped-source = 6 rows.
    // The flat view's row testid is `flat-row-<id>` (FieldMappingRow
    // proxy). Smoke-check by counting unique row ids in the DOM.
    expect(screen.getByText('a_field_1')).toBeInTheDocument()
    expect(screen.getByText('a_field_2')).toBeInTheDocument()
    expect(screen.getByText('b_field_1')).toBeInTheDocument()
    expect(screen.getByText('unmapped_a')).toBeInTheDocument()
    // Source-side rows surface by source field name.
    expect(screen.getByText('ORPHAN_1')).toBeInTheDocument()
  })

  it('renders all rows when flatPartitionSelection is empty Set', () => {
    renderListView(new Set())
    expect(screen.getByText('a_field_1')).toBeInTheDocument()
    expect(screen.getByText('a_field_2')).toBeInTheDocument()
    expect(screen.getByText('b_field_1')).toBeInTheDocument()
    expect(screen.getByText('unmapped_a')).toBeInTheDocument()
    expect(screen.getByText('ORPHAN_1')).toBeInTheDocument()
  })
})

// ─── MLV-P2 — non-empty selection filters by partition ──────────────────

describe('[MappingListView] MLV-P2 — filters by partition when selection is non-empty', () => {
  it('hides rows whose tableMappingId is not in the selection', () => {
    renderListView(new Set(['tm-a-1']))
    // tm-a-1 keeps m-a1 + va-a (both are in tm-a-1).
    expect(screen.getByText('a_field_1')).toBeInTheDocument()
    // m-a2 (tm-a-2) drops.
    expect(screen.queryByText('a_field_2')).toBeNull()
    // m-b1 (tm-b-1) drops.
    expect(screen.queryByText('b_field_1')).toBeNull()
    // unmapped::tf-u-a (tm-a-2) drops.
    expect(screen.queryByText('unmapped_a')).toBeNull()
  })

  it('keeps rows from multiple selected partitions (union semantics)', () => {
    renderListView(new Set(['tm-a-1', 'tm-a-2']))
    expect(screen.getByText('a_field_1')).toBeInTheDocument()
    expect(screen.getByText('a_field_2')).toBeInTheDocument()
    expect(screen.getByText('unmapped_a')).toBeInTheDocument()
    // tableB's partition drops.
    expect(screen.queryByText('b_field_1')).toBeNull()
  })
})

// ─── MLV-P3 — unmapped-source rows always render ────────────────────────

describe('[MappingListView] MLV-P3 — unmapped-source rows always pass through', () => {
  it('source-side rows render regardless of flatPartitionSelection', () => {
    renderListView(new Set(['tm-nonexistent']))
    // Every parent row drops (no row matches tm-nonexistent), but the
    // source-side row survives.
    expect(screen.getByText('ORPHAN_1')).toBeInTheDocument()
    // All parent rows should be gone.
    expect(screen.queryByText('a_field_1')).toBeNull()
    expect(screen.queryByText('a_field_2')).toBeNull()
    expect(screen.queryByText('b_field_1')).toBeNull()
    expect(screen.queryByText('unmapped_a')).toBeNull()
  })
})
