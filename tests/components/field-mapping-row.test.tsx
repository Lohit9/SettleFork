import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FieldMappingRow } from '@/app/app/projects/[projectId]/mapping/redesign/components/FieldMappingRow'
import { TargetTableGroup } from '@/app/app/projects/[projectId]/mapping/redesign/components/TargetTableGroup'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  TargetAcknowledgedRow,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 5a — FieldMappingRow tests (Rules 1, 5, 6 + VA).
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers:
//   • kind-based dispatch (mapped 1-source / mapped multi-source fallback /
//     value_assignment / target_acknowledged / unmapped)
//   • source column rendering per rule
//   • target column rendering + acknowledged subtitle
//   • confidence formatting / em-dash for null
//   • status dot + label
//   • transformation indicator visibility
//   • aria-labels (full-sentence descriptions)
//   • positive-control: FieldMappingRow is rendered via TargetTableGroup
//     (prevents silent dead-code regression)
//
// Gap 3 regression guard (required-badge removal) preserved.
// Gap 5b (Rules 2/3/4 + chevron) will ADD tests; see TODO comments below.

// ─── Fixtures ────────────────────────────────────────────────────────────────

function targetField(overrides: Partial<TargetFieldRef> = {}): TargetFieldRef {
  return {
    id: 'tf-1',
    name: 'customer_id',
    dataType: 'VARCHAR(200)',
    isNullable: true,
    defaultValue: null,
    targetTable: { id: 'tt-1', name: 'accounts' },
    ordinalPosition: 1,
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
    combinationType: 'custom_sql',
    combinationSql: 'NOW()',
    aiReasoning: null,
    ...overrides,
  }
}

function targetAck(
  overrides: Partial<TargetAcknowledgedRow> = {},
): TargetAcknowledgedRow {
  return {
    kind: 'target_acknowledged',
    id: 'tfm-ack-1',
    targetField: targetField({ id: 'tf-3', name: 'internal_id' }),
    confidence: null,
    status: 'approved',
    hasTransformation: false,
    transformationStatus: null,
    acknowledgmentReason: 'system default',
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
    ...overrides,
  }
}

// ─── Rule 1: single-source mapped row ───────────────────────────────────────

describe('FieldMappingRow — Rule 1 (single-source mapped)', () => {
  it('renders TableBadge + source field name + confidence + target field name', () => {
    render(<FieldMappingRow row={mapped()} />)
    // TableBadge renders the source table name as a pill.
    expect(screen.getByText('ACCT_MASTER')).toBeInTheDocument()
    // Source field name.
    expect(screen.getByText('ACCT_NO')).toBeInTheDocument()
    // Confidence.
    expect(screen.getByText('98.00%')).toBeInTheDocument()
    // Target field name.
    expect(screen.getByText('customer_id')).toBeInTheDocument()
    // Status.
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })

  it('does NOT render an em-dash in the source column (the source exists)', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    // The only em-dash that could render is in the confidence/source columns
    // — on Rule 1 neither should fire.
    expect(container.textContent).not.toContain('—')
  })

  it('applies mono font to both source and target field names', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const monoSpans = container.querySelectorAll('.font-mono')
    // Source field name + target field name = at least 2 mono spans (plus
    // TableBadge's internal mono name, for 3 total).
    expect(monoSpans.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Rule 1 fallback: multi-source mapped row (Gap 5a) ──────────────────────

describe('FieldMappingRow — Rule 1 fallback (multi-source; Gap 5b deferred)', () => {
  it('renders only the DOMINANT source when sources.length > 1', () => {
    const row = mapped({
      sources: [
        source({
          id: 'ms-a',
          ordinal: 0,
          sourceField: {
            id: 'sf-a',
            name: 'FNAME',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-b',
          ordinal: 1,
          sourceField: {
            id: 'sf-b',
            name: 'LNAME',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'CIF_MASTER' },
        }),
        source({
          id: 'ms-c',
          ordinal: 2,
          sourceField: {
            id: 'sf-c',
            name: 'MI',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-1', name: 'CIF_MASTER' },
        }),
      ],
      combinationType: 'concat_space',
      targetField: targetField({ name: 'full_name' }),
    })
    render(<FieldMappingRow row={row} />)
    // Dominant source (ordinal=0) renders.
    expect(screen.getByText('FNAME')).toBeInTheDocument()
    // Non-dominant sources must NOT render on the collapsed Gap 5a row
    // (Gap 5b adds the Rule 2 comma-separated rendering + chevron).
    expect(screen.queryByText('LNAME')).toBeNull()
    expect(screen.queryByText('MI')).toBeNull()
    // TableBadge for the shared table still renders once.
    expect(screen.getAllByText('CIF_MASTER').length).toBeGreaterThanOrEqual(1)
  })

  it('picks the ordinal=0 source even when the array is not sorted ascending', () => {
    // Defense-in-depth: contract guarantees sorted ordinal ASC, but the
    // component scans for ordinal=0 explicitly so a server regression
    // cannot silently render the wrong source.
    const row = mapped({
      sources: [
        source({
          id: 'ms-2',
          ordinal: 2,
          sourceField: {
            id: 'sf-2',
            name: 'SECONDARY_COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-2', name: 'SECONDARY_TABLE' },
        }),
        source({
          id: 'ms-0',
          ordinal: 0,
          sourceField: {
            id: 'sf-0',
            name: 'DOMINANT_COL',
            dataType: 'VARCHAR',
            isNullable: false,
          },
          sourceTable: { id: 'st-0', name: 'DOMINANT_TABLE' },
        }),
      ],
    })
    render(<FieldMappingRow row={row} />)
    expect(screen.getByText('DOMINANT_COL')).toBeInTheDocument()
    expect(screen.getByText('DOMINANT_TABLE')).toBeInTheDocument()
    expect(screen.queryByText('SECONDARY_COL')).toBeNull()
  })
})

// ─── Value assignment (founder Gap 4a §9 Q5) ────────────────────────────────

describe('FieldMappingRow — Value assignment', () => {
  it('renders "No source mapped" text instead of a TableBadge', () => {
    render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.getByText('No source mapped')).toBeInTheDocument()
    // No TableBadge-like text should appear — VA's source column is
    // explicitly the inline "No source mapped" phrase.
    expect(screen.queryByText('ACCT_MASTER')).toBeNull()
  })

  it('renders confidence normally (not em-dashed) — VAs carry confidence', () => {
    render(<FieldMappingRow row={valueAssignment({ confidence: 92 })} />)
    expect(screen.getByText('92.00%')).toBeInTheDocument()
  })

  it('renders the target field name in mono', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    expect(screen.getByText('created_at')).toBeInTheDocument()
    const monoTarget = container.querySelector('.font-mono.text-sm')
    expect(monoTarget).toBeTruthy()
  })
})

// ─── Rule 5: target-acknowledged row ────────────────────────────────────────

describe('FieldMappingRow — Rule 5 (target-acknowledged)', () => {
  it('renders em-dashes in both source and confidence columns', () => {
    render(<FieldMappingRow row={targetAck()} />)
    // Screen-reader labels hand us a reliable selector for each em-dash.
    expect(screen.getByLabelText('no source mapped')).toBeInTheDocument()
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
  })

  it('renders the target field name with an "acknowledged: <reason>" subtitle', () => {
    render(<FieldMappingRow row={targetAck({ acknowledgmentReason: 'system default' })} />)
    expect(screen.getByText('internal_id')).toBeInTheDocument()
    expect(screen.getByText('acknowledged: system default')).toBeInTheDocument()
  })

  it('renders the "acknowledged" subtitle without a reason when acknowledgmentReason is null', () => {
    render(<FieldMappingRow row={targetAck({ acknowledgmentReason: null })} />)
    expect(screen.getByText('internal_id')).toBeInTheDocument()
    // Exact-match so "acknowledged: ..." variants don't accidentally pass.
    expect(screen.getByText(/^acknowledged$/)).toBeInTheDocument()
  })

  it('does NOT render a transformation indicator (ack rows never carry one)', () => {
    const { container } = render(<FieldMappingRow row={targetAck()} />)
    expect(container.querySelector('[aria-label^="transformation:"]')).toBeNull()
  })
})

// ─── Rule 6: unmapped row ───────────────────────────────────────────────────

describe('FieldMappingRow — Rule 6 (unmapped)', () => {
  it('renders em-dashes in both source and confidence columns; no subtitle', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByLabelText('no source mapped')).toBeInTheDocument()
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
    expect(screen.getByText('missing_field')).toBeInTheDocument()
    // Rule 6 explicitly has no subtitle (spec line ~776).
    expect(screen.queryByText(/^acknowledged/)).toBeNull()
  })

  it('renders the "Unmapped" status chip', () => {
    render(<FieldMappingRow row={unmapped()} />)
    expect(screen.getByText('Unmapped')).toBeInTheDocument()
  })
})

// ─── Status chip (shared across all kinds) ──────────────────────────────────

describe('FieldMappingRow — status chip', () => {
  it('renders "Needs Review" for status=needs_review', () => {
    render(<FieldMappingRow row={mapped({ status: 'needs_review' })} />)
    expect(screen.getByText('Needs Review')).toBeInTheDocument()
  })

  it('renders "Rejected" for status=rejected', () => {
    render(<FieldMappingRow row={mapped({ status: 'rejected' })} />)
    expect(screen.getByText('Rejected')).toBeInTheDocument()
  })

  it('renders "Approved" for status=approved', () => {
    render(<FieldMappingRow row={mapped({ status: 'approved' })} />)
    expect(screen.getByText('Approved')).toBeInTheDocument()
  })
})

// ─── Confidence formatting ──────────────────────────────────────────────────

describe('FieldMappingRow — confidence formatting', () => {
  it('formats fractional confidence to 2 decimals', () => {
    render(<FieldMappingRow row={mapped({ confidence: 87.5 })} />)
    expect(screen.getByText('87.50%')).toBeInTheDocument()
  })

  it('formats integer confidence to 2 decimals', () => {
    render(<FieldMappingRow row={mapped({ confidence: 92 })} />)
    expect(screen.getByText('92.00%')).toBeInTheDocument()
  })

  it('interprets 0-1 fractional input as a 0-100 percentage', () => {
    // Defensive formatting: DB stores 0-100 today but drift can't corrupt UI.
    render(<FieldMappingRow row={mapped({ confidence: 0.85 })} />)
    expect(screen.getByText('85.00%')).toBeInTheDocument()
  })

  it('renders an em-dash when confidence is null', () => {
    render(<FieldMappingRow row={targetAck({ confidence: null })} />)
    expect(screen.getByLabelText('no confidence available')).toBeInTheDocument()
  })
})

// ─── Transformation indicator ───────────────────────────────────────────────

describe('FieldMappingRow — transformation indicator', () => {
  it('renders an "applied" indicator when hasTransformation=true, status=applied', () => {
    render(
      <FieldMappingRow
        row={mapped({ hasTransformation: true, transformationStatus: 'applied' })}
      />,
    )
    expect(screen.getByLabelText('transformation: applied')).toBeInTheDocument()
  })

  it('renders a "draft" indicator when hasTransformation=true and status is null', () => {
    render(
      <FieldMappingRow
        row={mapped({ hasTransformation: true, transformationStatus: null })}
      />,
    )
    expect(screen.getByLabelText('transformation: draft')).toBeInTheDocument()
  })

  it('renders nothing visible in the transform slot when hasTransformation=false', () => {
    const { queryByLabelText } = render(<FieldMappingRow row={mapped()} />)
    expect(queryByLabelText(/^transformation:/)).toBeNull()
  })
})

// ─── Gap 3 regression guard ─────────────────────────────────────────────────

describe('FieldMappingRow — Gap 3 regression guard (required badge)', () => {
  it('does NOT render a "required" badge even when isNullable=false (Gap 3 amendment)', () => {
    // The NOT-NULL / required indicator was added in Gap 4c as a sidebar
    // row badge, then removed during Gap 3 review — it communicated nothing
    // per-row on Heritage (95% of fields are NOT NULL). The drawer header
    // (Gaps 7-10) is the canonical home for required/nullable display.
    // Regression guard: if a future change re-adds the badge, this fails.
    render(
      <FieldMappingRow row={mapped({ targetField: targetField({ isNullable: false }) })} />,
    )
    expect(screen.queryByText(/^required$/)).toBeNull()
  })
})

// ─── Accessibility: aria-labels ─────────────────────────────────────────────

describe('FieldMappingRow — aria-labels', () => {
  it('describes a 1:1 mapped row as "source.field mapped to target.field at X% confidence, status"', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const row = container.querySelector('[data-testid="field-mapping-row"]')
    expect(row?.getAttribute('aria-label')).toBe(
      'ACCT_MASTER.ACCT_NO mapped to accounts.customer_id at 98.00% confidence, approved',
    )
  })

  it('notes "(+N more)" when a mapped row has non-dominant sources hidden', () => {
    const row = mapped({
      sources: [
        source({ id: 'ms-0', ordinal: 0 }),
        source({ id: 'ms-1', ordinal: 1 }),
        source({ id: 'ms-2', ordinal: 2 }),
      ],
    })
    const { container } = render(<FieldMappingRow row={row} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toContain('(+2 more)')
  })

  it('describes a value-assignment row', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toBe(
      'accounts.created_at value assignment at 92.00% confidence, approved',
    )
  })

  it('describes an acknowledged row with the reason inlined', () => {
    const { container } = render(
      <FieldMappingRow row={targetAck({ acknowledgmentReason: 'system default' })} />,
    )
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toBe(
      'accounts.internal_id acknowledged as not migratable: system default',
    )
  })

  it('describes an unmapped row as "not yet mapped"', () => {
    const { container } = render(<FieldMappingRow row={unmapped()} />)
    const el = container.querySelector('[data-testid="field-mapping-row"]')
    expect(el?.getAttribute('aria-label')).toBe(
      'accounts.missing_field not yet mapped',
    )
  })
})

// ─── Data attributes (debugging + snapshot hooks) ───────────────────────────

describe('FieldMappingRow — data attributes', () => {
  it('exposes row kind via data-row-kind for debugging and snapshots', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const rowEl = container.querySelector('[data-testid="field-mapping-row"]')
    expect(rowEl?.getAttribute('data-row-kind')).toBe('value_assignment')
  })
})

// ─── Gap 5a hotfix 2026-04-23 ─── light-mode-only invariant ────────────────
//
// The surrounding redesign UI hardcodes a light background (bg-white on
// TargetTableGroup, bg-gray-50 on the page). Tailwind's `darkMode: 'media'`
// default would fire any dark-prefix text variant automatically in OS dark
// mode, producing near-white-on-white ghosted text (the 2026-04-23 bug).
//
// Companion invariant: tests/lib/no-shim-in-redesign-path.test.ts greps
// every redesign source file for the dark-prefix token at CI time. These
// className assertions are the component-level smoke-test safety net.

describe('FieldMappingRow — light-mode-only invariant', () => {
  it('target name span uses full-contrast light-mode color and font-medium', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const targetSpan = container.querySelector('.font-mono.text-sm')
    expect(targetSpan).toBeTruthy()
    const cls = targetSpan?.className ?? ''
    expect(cls).toContain('text-slate-900')
    expect(cls).toContain('font-medium')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('source field name span uses light-mode slate-700 and no dark-prefix', () => {
    render(<FieldMappingRow row={mapped()} />)
    const sourceSpan = screen.getByText('ACCT_NO')
    const cls = sourceSpan.className
    expect(cls).toContain('text-slate-700')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('confidence span uses light-mode slate-500 and no dark-prefix', () => {
    const { container } = render(<FieldMappingRow row={mapped()} />)
    const confidence = container.querySelector('.tabular-nums')
    expect(confidence).toBeTruthy()
    const cls = confidence?.className ?? ''
    expect(cls).toContain('text-slate-500')
    expect(cls).not.toMatch(/\bdark:/)
  })

  it('"No source mapped" VA slot uses light-mode slate-500 and no dark-prefix', () => {
    const { container } = render(<FieldMappingRow row={valueAssignment()} />)
    const vaText = screen.getByText('No source mapped')
    const cls = vaText.className
    expect(cls).toContain('text-slate-500')
    expect(cls).not.toMatch(/\bdark:/)
    // Sanity: the container must not carry any dark-prefix substring either.
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })

  it('entire rendered tree for an acknowledged row contains no dark-prefix substring', () => {
    const { container } = render(
      <FieldMappingRow row={targetAck({ acknowledgmentReason: 'system default' })} />,
    )
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})

// ─── Positive control: group wires through to the row ───────────────────────

describe('FieldMappingRow — positive control', () => {
  it('is rendered by TargetTableGroup (prevents dead-code regression)', () => {
    const summary: TargetTableSummary = {
      id: 'tt-1',
      name: 'accounts',
      datasetName: 'Heritage Core',
      fieldCount: 1,
    }
    const rows: MappingRow[] = [
      mapped({ id: 'canary-row', targetField: targetField({ name: 'canary_field' }) }),
    ]
    render(<TargetTableGroup targetTable={summary} rows={rows} />)
    expect(screen.getByText('canary_field')).toBeInTheDocument()
    expect(screen.getByTestId('field-mapping-row')).toBeInTheDocument()
  })
})
