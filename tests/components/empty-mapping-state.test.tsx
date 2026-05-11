import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  EmptyMappingState,
  selectEmptyMappingCase,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/EmptyMappingState'
import type {
  MappingsForRedesignResult,
  SourceTableSummary,
  TargetTableSummary,
  SourceFieldWithState,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// EmptyMappingState — Phase 4 four-case discriminator unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked discriminator matrix in `EmptyMappingState.tsx`:
//
//   Case 1 — no source AND no target schema → "Upload source and target…"
//   Case 2 — no target schema, source ready → "Upload a target schema…"
//   Case 3 — no source schema, target ready → "Upload a source schema…"
//   Case 4 — both schemas, every target field is unmapped → GenerateMappingsPanel
//   null   — populated (≥ 1 non-unmapped row) → caller renders TFM list
//
// Cases 1-3 surface a primary [Go to Data Overview] button linking to
// `/app/projects/<projectId>/data-overview?tab=schema-overview`.
// Case 4 mounts `<GenerateMappingsPanel>` (separate suite covers its
// behavior; this suite verifies the discriminator routes there).

// `GenerateMappingsPanel` transitively pulls in the toast context and
// the redesign action surface. Stub the action and the toast hook so
// the discriminator suite stays focused on routing and copy.
vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  generateMappings: vi.fn().mockResolvedValue({ success: true, generated: 0 }),
}))
vi.mock('@/lib/contexts/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ pushToast: vi.fn(), dismissToast: vi.fn() }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

// ── Fixture helpers ──────────────────────────────────────────────────────────

const PROJECT_ID = 'p-empty-state-test'

function targetTable(
  overrides: Partial<TargetTableSummary> = {},
): TargetTableSummary {
  return {
    id: 'tt-1',
    name: 'accounts',
    datasetName: 'core',
    fieldCount: 5,
    ...overrides,
  }
}

function sourceTable(
  overrides: Partial<SourceTableSummary> = {},
): SourceTableSummary {
  return {
    id: 'st-1',
    name: 'ACCT_MASTER',
    datasetName: 'legacy',
    fieldCount: 4,
    ...overrides,
  }
}

function sourceField(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-1',
    name: 'COL_A',
    dataType: 'VARCHAR(50)',
    ordinalPosition: 1,
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
    ...overrides,
  }
}

function buildResult(
  overrides: Partial<MappingsForRedesignResult> = {},
): MappingsForRedesignResult {
  return {
    projectId: PROJECT_ID,
    rows: [],
    targetTables: [],
    sourceTables: [],
    sourceFieldAcknowledgments: [],
    sourceFields: [],
    counts: {
      total: 0,
      approved: 0,
      needsReview: 0,
      rejected: 0,
      unmapped: 0,
    },
    targetSchemaEmpty: true,
    ...overrides,
  }
}

// ── selectEmptyMappingCase — pure discriminator ──────────────────────────────

describe('selectEmptyMappingCase — pure discriminator', () => {
  it('case 1: targetSchemaEmpty AND no source tables → 1', () => {
    const r = buildResult({ targetSchemaEmpty: true, sourceTables: [] })
    expect(selectEmptyMappingCase(r)).toBe(1)
  })

  it('case 2: targetSchemaEmpty BUT source tables present → 2', () => {
    const r = buildResult({
      targetSchemaEmpty: true,
      sourceTables: [sourceTable()],
      sourceFields: [sourceField()],
    })
    expect(selectEmptyMappingCase(r)).toBe(2)
  })

  it('case 3a: target schema present, sourceTables empty → 3', () => {
    const r = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [],
      sourceFields: [],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    expect(selectEmptyMappingCase(r)).toBe(3)
  })

  it('case 3b: target schema present, sourceTables present but sourceFields empty → 3', () => {
    const r = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [sourceTable()],
      sourceFields: [],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    expect(selectEmptyMappingCase(r)).toBe(3)
  })

  it('case 4: both schemas, every target field is unmapped → 4', () => {
    const r = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [sourceTable()],
      sourceFields: [sourceField()],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    expect(selectEmptyMappingCase(r)).toBe(4)
  })

  it('populated: at least one non-unmapped row → null (caller renders TFM list)', () => {
    const r = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [sourceTable()],
      sourceFields: [sourceField()],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 1,
        needsReview: 0,
        rejected: 0,
        unmapped: 4,
      },
    })
    expect(selectEmptyMappingCase(r)).toBeNull()
  })

  it('case-3-takes-precedence-over-4 — sourceFields=[] with all-unmapped counts still routes to case 3', () => {
    // The case-3 predicate (`sourceFields.length === 0`) is checked
    // before case 4 inside `selectEmptyMappingCase`. Without that
    // ordering, a target-schema-only project with sourceTables
    // present-but-empty-of-fields would fall through to case 4 and
    // surface the Generate panel — but the panel can't generate
    // anything against zero source fields. The discriminator must
    // route to case 3 instead.
    const r = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [sourceTable()],
      sourceFields: [],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    expect(selectEmptyMappingCase(r)).toBe(3)
  })
})

// ── EmptyMappingState — JSX render ──────────────────────────────────────────

describe('EmptyMappingState — case 1 (no schemas)', () => {
  it('renders the no-schemas card with the Go to Data Overview CTA', () => {
    const data = buildResult({ targetSchemaEmpty: true, sourceTables: [] })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(
      screen.getByTestId('mapping-redesign-empty-no-schemas'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Upload source and target schemas to begin mapping.'),
    ).toBeInTheDocument()
    const cta = screen.getByTestId('mapping-redesign-empty-cta')
    expect(cta).toBeInTheDocument()
    expect(cta.getAttribute('href')).toBe(
      `/app/projects/${PROJECT_ID}/data-overview?tab=schema-overview`,
    )
  })

  it('does NOT render the GenerateMappingsPanel in case 1', () => {
    const data = buildResult({ targetSchemaEmpty: true, sourceTables: [] })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(screen.queryByTestId('generate-mappings-panel')).toBeNull()
  })
})

describe('EmptyMappingState — case 2 (target missing)', () => {
  it('renders the no-target card with the Go to Data Overview CTA', () => {
    const data = buildResult({
      targetSchemaEmpty: true,
      sourceTables: [sourceTable()],
      sourceFields: [sourceField()],
    })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(
      screen.getByTestId('mapping-redesign-empty-no-target'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Upload a target schema to begin mapping.'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-redesign-empty-cta').getAttribute('href'),
    ).toBe(`/app/projects/${PROJECT_ID}/data-overview?tab=schema-overview`)
    expect(screen.queryByTestId('generate-mappings-panel')).toBeNull()
  })
})

describe('EmptyMappingState — case 3 (source missing)', () => {
  it('renders the no-source card with the Go to Data Overview CTA', () => {
    const data = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [],
      sourceFields: [],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(
      screen.getByTestId('mapping-redesign-empty-no-source'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Upload a source schema to begin mapping.'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-redesign-empty-cta').getAttribute('href'),
    ).toBe(`/app/projects/${PROJECT_ID}/data-overview?tab=schema-overview`)
    expect(screen.queryByTestId('generate-mappings-panel')).toBeNull()
  })

  it('hides the all-Unmapped row list (case-3 predicate is upstream of GenerateMappingsPanel)', () => {
    // Case 3 means there ARE target fields (each emits an
    // UnmappedRow on the server) but the source schema is missing.
    // The discriminator must route to NoSchemaState, not to the
    // populated row list — the list would be a wall of Unmapped
    // rows with no path forward.
    const data = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [],
      sourceFields: [],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    // The discriminator surfaces the no-source CTA, NOT the panel.
    expect(
      screen.getByTestId('mapping-redesign-empty-no-source'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('mapping-redesign-empty-generate')).toBeNull()
  })
})

describe('EmptyMappingState — case 4 (both schemas, all unmapped)', () => {
  it('renders the GenerateMappingsPanel with both table selectors', () => {
    const data = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [
        sourceTable({ id: 'st-1', name: 'ACCT_MASTER' }),
        sourceTable({ id: 'st-2', name: 'CUST_MASTER' }),
      ],
      sourceFields: [sourceField()],
      targetTables: [
        targetTable({ id: 'tt-1', name: 'accounts' }),
        targetTable({ id: 'tt-2', name: 'customers' }),
      ],
      counts: {
        total: 10,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 10,
      },
    })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(
      screen.getByTestId('mapping-redesign-empty-generate'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('generate-mappings-panel')).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-source-panel'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-target-panel'),
    ).toBeInTheDocument()
    // Case 4 must NOT render any of the no-schema CTAs.
    expect(screen.queryByTestId('mapping-redesign-empty-no-schemas')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-target')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-source')).toBeNull()
  })

  it('seeds the source and target table panels from data.sourceTables/data.targetTables', () => {
    const data = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [
        sourceTable({ id: 'st-1', name: 'ACCT_MASTER' }),
        sourceTable({ id: 'st-2', name: 'CUST_MASTER' }),
      ],
      sourceFields: [sourceField()],
      targetTables: [targetTable({ id: 'tt-1', name: 'accounts' })],
      counts: {
        total: 5,
        approved: 0,
        needsReview: 0,
        rejected: 0,
        unmapped: 5,
      },
    })
    render(<EmptyMappingState projectId={PROJECT_ID} data={data} />)
    expect(
      screen.getByTestId('generate-mappings-source-row-st-1'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-source-row-st-2'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('generate-mappings-target-row-tt-1'),
    ).toBeInTheDocument()
  })
})

describe('EmptyMappingState — populated case', () => {
  it('returns null (no card rendered) when at least one mapping exists', () => {
    const data = buildResult({
      targetSchemaEmpty: false,
      sourceTables: [sourceTable()],
      sourceFields: [sourceField()],
      targetTables: [targetTable()],
      counts: {
        total: 5,
        approved: 1,
        needsReview: 0,
        rejected: 0,
        unmapped: 4,
      },
    })
    const { container } = render(
      <EmptyMappingState projectId={PROJECT_ID} data={data} />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-schemas')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-target')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-no-source')).toBeNull()
    expect(screen.queryByTestId('mapping-redesign-empty-generate')).toBeNull()
  })
})
