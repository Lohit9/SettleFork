import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks (mirrors tests/components/mapping-drawer.test.tsx) ───────────────
//
// `@/lib/actions/mappings-for-redesign` transitively pulls in
// `lib/ai/mapping-engine` → `lib/ai/llm-client` which instantiates an
// Anthropic client at module load. That fails in the jsdom test
// environment with "running in a browser-like environment". The
// existing drawer test suite already mocks this module — replicate the
// shape here so the new path-d-enrichment tests resolve their imports
// without bringing the LLM client along.
const {
  approveFieldMappingMock,
  rejectFieldMappingMock,
  createFieldMappingMock,
  suggestMappingForTargetMock,
} = vi.hoisted(() => ({
  approveFieldMappingMock: vi.fn(),
  rejectFieldMappingMock: vi.fn(),
  createFieldMappingMock: vi.fn(),
  suggestMappingForTargetMock: vi.fn(),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: (...args: unknown[]) => approveFieldMappingMock(...args),
  rejectFieldMapping: (...args: unknown[]) => rejectFieldMappingMock(...args),
  createFieldMapping: (...args: unknown[]) => createFieldMappingMock(...args),
  suggestMappingForTarget: (...args: unknown[]) =>
    suggestMappingForTargetMock(...args),
  setUnmappedRowRejected: vi.fn(),
}))

// MappingDrawer imports `@/lib/actions/field-acknowledgments` for the
// source-field-only drawer footer (Approve / Un-approve). It is a
// `'use server'` module that transitively loads `server-only`, which
// throws in jsdom — mock it so the module never really loads.
vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: vi.fn(),
  removeAcknowledgment: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
  }),
}))

import { MappingDrawer } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer'
import type { PathDOutputs } from '@/lib/utils/_path-d-outputs-core'
import type {
  ProjectDataQualityIssueRow,
  ProjectDecisionRow,
  TargetFieldCoverageRow,
} from '@/lib/types/path-d'
import type {
  MappedRow,
  MappingSourceRef,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — drawer body integration tests for Path D enrichment.
// ─────────────────────────────────────────────────────────────────────────────
//
// Companion to mapping-drawer.test.tsx (the pre-α baseline). This file
// pins the new sections (COVERAGE / DATA QUALITY / DECISIONS) and their
// per-body-kind ordering against the locked design.
//
// Section order locks:
//   • MappedBody         : SOURCE → SAMPLE → ANALYSIS → TRANSFORMATION → DQ → DECISIONS
//   • ValueAssignmentBody: SOURCE → ANALYSIS → VALUE → DECISIONS
//   • UnmappedBody       : SOURCE (with pencil) → COVERAGE → DECISIONS
//                          (coverage-approved no-source rows live here too
//                          post-INF-57 cleanup)

// ── Fixtures (mirror mapping-drawer.test.tsx) ──────────────────────────────

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

function valueAssignment(
  overrides: Partial<ValueAssignmentRow> = {},
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: 'tfm-va-1',
    targetField: targetField({ id: 'tf-2', name: 'created_at' }),
    confidence: 92,
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

// INF-57 cleanup — coverage-approved no-source row (formerly target_acknowledged).
function targetAck(overrides: Partial<UnmappedRow> = {}): UnmappedRow {
  return {
    kind: 'unmapped',
    id: 'unmapped::tf-3',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    mapping_content: 'no-source',
    coverageStatus: 'gap',
    statusSetBy: 'user',
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

function coverageRow(
  partial: Partial<TargetFieldCoverageRow>,
): TargetFieldCoverageRow {
  return {
    id: 'cov-1',
    project_id: 'proj-1',
    target_field_id: 'tf-1',
    coverage_status: 'gap',
    ai_reasoning: null,
    default_value_recommendation: null,
    default_value_decided: null,
    default_decided_at: null,
    default_decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

function decisionRow(partial: Partial<ProjectDecisionRow>): ProjectDecisionRow {
  return {
    id: 'dec-1',
    project_id: 'proj-1',
    decision_type: 'mapping',
    title: 'Decision title',
    description: null,
    ai_recommendation: {},
    alternatives: [],
    customer_decision: null,
    applies_to: null,
    status: 'pending',
    decided_at: null,
    decided_by: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

function dqRow(
  partial: Partial<ProjectDataQualityIssueRow>,
): ProjectDataQualityIssueRow {
  return {
    id: 'dq-1',
    project_id: 'proj-1',
    source_field_id: 'sf-1',
    severity: 'warning',
    category: 'completeness',
    description: 'Missing values',
    example_values: null,
    recommendation: null,
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

function pathDOutputs(
  partial: Partial<PathDOutputs> = {},
): PathDOutputs {
  return {
    coverageByTargetFieldId: new Map(),
    decisionsByTfmId: new Map(),
    decisionsByCoverageId: new Map(),
    dqIssuesBySourceFieldId: new Map(),
    ...partial,
  }
}

// AcknowledgedBody describe block dropped — INF-57 cleanup folded
// AcknowledgedBody into UnmappedBody, so coverage-approved no-source rows
// (formerly target_acknowledged) are exercised by the UnmappedBody describe
// below using the targetAck() fixture (which now produces a kind='unmapped'
// row with status='approved').

// ── UnmappedBody ────────────────────────────────────────────────────────────

describe('MappingDrawer — UnmappedBody (Phase E PR α)', () => {
  it('renders SOURCE → COVERAGE with synthesized orphan label when no coverage exists', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={pathDOutputs()}
      />,
    )
    // PR 3b: body SOURCE section retired. UnmappedBody renders
    // [rejected banner] → TARGET FIELD → [TRANSFORMATION] →
    // [EXPLANATION] → DECISIONS.
    expect(screen.queryByTestId('drawer-section-source')).toBeNull()
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-section-coverage')).toBeNull()
    expect(screen.queryByTestId('drawer-section-decisions')).toBeNull()
  })

  it('renders DECISIONS section when coverage row has applicable decisions', async () => {
    const user = userEvent.setup()
    const row = unmapped()
    const cov = coverageRow({
      id: 'cov-x',
      target_field_id: row.targetField.id,
      coverage_status: 'gap',
    })
    const outputs = pathDOutputs({
      coverageByTargetFieldId: new Map([[row.targetField.id, cov]]),
      decisionsByCoverageId: new Map([
        [
          cov.id,
          [
            decisionRow({
              id: 'dec-x',
              title: 'Acknowledge legacy gap',
              status: 'pending',
            }),
          ],
        ],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    // PR 3b refinement — DECISIONS defaults to collapsed; click to expand
    // before asserting on inner content.
    const decisionsSection = screen.getByTestId('drawer-section-decisions')
    await user.click(
      within(decisionsSection).getByTestId('drawer-decisions-toggle'),
    )
    expect(
      within(decisionsSection).getByTestId('drawer-decision-title').textContent,
    ).toBe('Acknowledge legacy gap')
  })

  // PR 3b dropped per Q7 from STOP 1: the body Edit-pencil →
  // CreateMappingForm flow is retired. COVERAGE + DECISIONS no
  // longer have a form-active hide path — they render whenever the
  // unmapped row has a coverage row + applicable decisions. The
  // "hides COVERAGE + DECISIONS while the create-mapping form is
  // mounted" assertion is moot.
})

// ── ValueAssignmentBody ────────────────────────────────────────────────────

describe('MappingDrawer — ValueAssignmentBody (Phase E PR α)', () => {
  it('collapses DECISIONS when no decision indexes the VA TFM', () => {
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={pathDOutputs()}
      />,
    )
    expect(screen.queryByTestId('drawer-section-decisions')).toBeNull()
  })

  it('renders DECISIONS at the tail of the body when sidecar carries TFM-applicable decisions', async () => {
    const user = userEvent.setup()
    const va = valueAssignment()
    const outputs = pathDOutputs({
      decisionsByTfmId: new Map([
        [
          va.id,
          [
            decisionRow({
              id: 'dec-va',
              title: 'Stamp NOW() on missing created_at',
              status: 'auto_applied',
            }),
          ],
        ],
      ]),
    })
    render(
      <MappingDrawer
        row={va}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const section = screen.getByTestId('drawer-section-decisions')
    // PR 3b refinement — DECISIONS defaults to collapsed; expand first.
    await user.click(within(section).getByTestId('drawer-decisions-toggle'))
    expect(
      within(section).getByTestId('drawer-decision-title').textContent,
    ).toBe('Stamp NOW() on missing created_at')
    // Tail position: order should be SOURCE → ANALYSIS → VALUE → DECISIONS.
    // The drawer body is the only flex column carrying these sections;
    // testid order in the rendered DOM mirrors render order.
    const body = screen.getByTestId('mapping-drawer-body')
    const sectionTestIds = Array.from(
      body.querySelectorAll('[data-testid^="drawer-section-"]'),
    ).map((el) => el.getAttribute('data-testid'))
    const decisionsIndex = sectionTestIds.indexOf('drawer-section-decisions')
    const valueIndex = sectionTestIds.indexOf('drawer-section-value-expression')
    expect(decisionsIndex).toBeGreaterThan(valueIndex)
  })
})

// ── MappedBody ──────────────────────────────────────────────────────────────

describe('MappingDrawer — MappedBody (Phase E PR α)', () => {
  it('collapses both DATA QUALITY and DECISIONS when sidecar carries no relevant rows', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={pathDOutputs()}
      />,
    )
    expect(screen.queryByTestId('drawer-section-data-quality')).toBeNull()
    expect(screen.queryByTestId('drawer-section-decisions')).toBeNull()
  })

  it('renders DATA QUALITY for each unique DQ issue across the row\'s sources', async () => {
    const user = userEvent.setup()
    const row = mapped({
      sources: [
        source({
          id: 'ms-A',
          sourceField: {
            id: 'sf-A',
            name: 'A',
            dataType: 'VARCHAR',
            isNullable: false,
          },
        }),
        source({
          id: 'ms-B',
          sourceField: {
            id: 'sf-B',
            name: 'B',
            dataType: 'VARCHAR',
            isNullable: false,
          },
        }),
      ],
    })
    const outputs = pathDOutputs({
      dqIssuesBySourceFieldId: new Map([
        ['sf-A', [dqRow({ id: 'dq-A1', severity: 'critical', category: 'integrity' })]],
        ['sf-B', [dqRow({ id: 'dq-B1', severity: 'warning', category: 'completeness' })]],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const section = screen.getByTestId('drawer-section-data-quality')
    // PR 3b refinement — DATA QUALITY defaults to collapsed; expand first.
    await user.click(within(section).getByTestId('drawer-data-quality-toggle'))
    const items = within(section).getAllByTestId('drawer-dq-item')
    expect(items).toHaveLength(2)
    // Severity sort: critical first.
    expect(items[0]?.getAttribute('data-dq-id')).toBe('dq-A1')
    expect(items[1]?.getAttribute('data-dq-id')).toBe('dq-B1')
  })

  it('de-duplicates DQ issues that are referenced by multiple sources on the row', async () => {
    const user = userEvent.setup()
    // Same DQ id appears in two sources' lookup arrays — the row
    // should render it only once.
    const row = mapped({
      sources: [
        source({
          id: 'ms-A',
          sourceField: {
            id: 'sf-A',
            name: 'A',
            dataType: 'VARCHAR',
            isNullable: false,
          },
        }),
        source({
          id: 'ms-B',
          sourceField: {
            id: 'sf-B',
            name: 'B',
            dataType: 'VARCHAR',
            isNullable: false,
          },
        }),
      ],
    })
    const sharedIssue = dqRow({
      id: 'shared',
      severity: 'critical',
      category: 'integrity',
    })
    const outputs = pathDOutputs({
      dqIssuesBySourceFieldId: new Map([
        ['sf-A', [sharedIssue]],
        ['sf-B', [sharedIssue]],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    // PR 3b refinement — DATA QUALITY defaults to collapsed; expand first.
    await user.click(screen.getByTestId('drawer-data-quality-toggle'))
    expect(screen.getAllByTestId('drawer-dq-item')).toHaveLength(1)
  })

  it('renders DECISIONS keyed by TFM id', async () => {
    const user = userEvent.setup()
    const row = mapped()
    const outputs = pathDOutputs({
      decisionsByTfmId: new Map([
        [
          row.id,
          [
            decisionRow({
              id: 'dec-mapped',
              title: 'Map to canonical account',
              status: 'decided',
            }),
          ],
        ],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const section = screen.getByTestId('drawer-section-decisions')
    // PR 3b refinement — DECISIONS defaults to collapsed; expand first.
    await user.click(within(section).getByTestId('drawer-decisions-toggle'))
    expect(
      within(section).getByTestId('drawer-decision-title').textContent,
    ).toBe('Map to canonical account')
  })

  it('places DATA QUALITY before DECISIONS in the section sequence', () => {
    const row = mapped()
    const outputs = pathDOutputs({
      dqIssuesBySourceFieldId: new Map([
        ['sf-1', [dqRow({ id: 'dq-1', severity: 'warning' })]],
      ]),
      decisionsByTfmId: new Map([[row.id, [decisionRow({ id: 'dec-1' })]]]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sectionTestIds = Array.from(
      body.querySelectorAll('[data-testid^="drawer-section-"]'),
    ).map((el) => el.getAttribute('data-testid'))
    const dqIndex = sectionTestIds.indexOf('drawer-section-data-quality')
    const decisionsIndex = sectionTestIds.indexOf('drawer-section-decisions')
    expect(dqIndex).toBeGreaterThan(-1)
    expect(decisionsIndex).toBeGreaterThan(dqIndex)
  })

  // ── PR 3b refinement — DQ + Decisions collapse pattern ──────────────────
  //
  // Generalised from the sample-values disclosure: each enrichment section
  // mounts as a `Data quality (N)` / `Decisions (N)` button chevron + count
  // chip that toggles the section's body. Default state is collapsed so
  // multi-issue rows don't push everything below offscreen.
  it('keeps DATA QUALITY contents collapsed by default; toggle expands the list', async () => {
    const user = userEvent.setup()
    const row = mapped()
    const outputs = pathDOutputs({
      dqIssuesBySourceFieldId: new Map([
        ['sf-1', [dqRow({ id: 'dq-collapse', severity: 'critical' })]],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const section = screen.getByTestId('drawer-section-data-quality')
    // Toggle exists with "Data quality (N)" label.
    const toggle = within(section).getByTestId('drawer-data-quality-toggle')
    expect(toggle.textContent).toContain('Data quality (1)')
    // Collapsed default — panel + list items not in the tree.
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(section).queryByTestId('drawer-data-quality-panel')).toBeNull()
    expect(within(section).queryByTestId('drawer-dq-item')).toBeNull()
    // Expand.
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(
      within(section).getByTestId('drawer-data-quality-panel'),
    ).toBeInTheDocument()
    expect(within(section).getAllByTestId('drawer-dq-item')).toHaveLength(1)
  })

  it('keeps DECISIONS contents collapsed by default; toggle expands the list', async () => {
    const user = userEvent.setup()
    const row = mapped()
    const outputs = pathDOutputs({
      decisionsByTfmId: new Map([
        [
          row.id,
          [decisionRow({ id: 'dec-collapse', title: 'Collapsed decision' })],
        ],
      ]),
    })
    render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        pathDOutputs={outputs}
      />,
    )
    const section = screen.getByTestId('drawer-section-decisions')
    const toggle = within(section).getByTestId('drawer-decisions-toggle')
    expect(toggle.textContent).toContain('Decisions (1)')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(section).queryByTestId('drawer-decisions-panel')).toBeNull()
    expect(within(section).queryByTestId('drawer-decision-title')).toBeNull()
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(
      within(section).getByTestId('drawer-decisions-panel'),
    ).toBeInTheDocument()
    expect(
      within(section).getByTestId('drawer-decision-title').textContent,
    ).toBe('Collapsed decision')
  })
})

// ── Graceful degradation ───────────────────────────────────────────────────

describe('MappingDrawer — graceful degradation when pathDOutputs is null/undefined', () => {
  it('renders mapped, VA, coverage-approved no-source, and raw unmapped bodies without crashing when pathDOutputs is undefined', () => {
    for (const row of [mapped(), valueAssignment(), targetAck(), unmapped()]) {
      const { unmount } = render(
        <MappingDrawer row={row} isOpen={true} onClose={() => {}} />,
      )
      expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
      unmount()
    }
  })

  it('does not render the legacy COVERAGE section on no-source rows when sidecar is absent', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-coverage')).toBeNull()
  })

  // INF-57 cleanup — coverage-approved no-source rows (formerly target_acknowledged
  // dispatched into AcknowledgedBody) now render UnmappedBody. The
  // legacy COVERAGE section was retired; explanation content lives in
  // the main Explanation section when AI reasoning exists.
  it('does not render the legacy COVERAGE section on coverage-approved no-source rows when sidecar is absent', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-coverage')).toBeNull()
  })
})
