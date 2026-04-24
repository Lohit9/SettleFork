import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MappingDrawer } from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer'
import type {
  MappedRow,
  MappingSourceRef,
  TargetAcknowledgedRow,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 7 — MappingDrawer shell tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers the shell-only contract:
//   • Closed-state rendering (nothing in DOM)
//   • Open-state header (target field name + target TableBadge + close X)
//   • Subheader content per row kind / mapped-row rule (Rules 1-6 + VA)
//   • Body + footer placeholders
//   • A11y attributes (role=dialog, aria-modal, aria-labelledby)
//   • Esc / X close behaviors
//   • Light-mode-only invariant (no dark: classNames in rendered HTML)
//
// Out of scope (Gaps 8-10): tab content, action buttons, sample values,
// AI reasoning, SQL editor.

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

function cifSource(ordinal: number, fieldName: string): MappingSourceRef {
  return source({
    id: `ms-${fieldName}`,
    ordinal,
    sourceField: {
      id: `sf-${fieldName}`,
      name: fieldName,
      dataType: 'VARCHAR',
      isNullable: false,
    },
    sourceTable: { id: 'st-CIF', name: 'CIF_MASTER' },
  })
}

// ─── Closed state ───────────────────────────────────────────────────────────

describe('MappingDrawer — closed state', () => {
  it('renders nothing in the DOM when isOpen=false', () => {
    const { container } = render(
      <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('mapping-drawer')).toBeNull()
  })

  it('renders nothing when row is null even if isOpen=true', () => {
    const { container } = render(
      <MappingDrawer row={null} isOpen={true} onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ─── Header ─────────────────────────────────────────────────────────────────

describe('MappingDrawer — header', () => {
  it('renders the target field name as the labelled heading', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.textContent).toBe('customer_id')
    expect(title.tagName).toBe('H2')
  })

  it('field name uses font-mono and font-semibold', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.className).toContain('font-mono')
    expect(title.className).toContain('font-semibold')
  })

  it('renders a TableBadge for the target table in the header', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const header = screen.getByTestId('mapping-drawer-header')
    expect(within(header).getByText('accounts')).toBeInTheDocument()
  })

  it('exposes a close button with aria-label="Close drawer"', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const close = screen.getByTestId('mapping-drawer-close')
    expect(close.getAttribute('aria-label')).toBe('Close drawer')
  })

  it('close button calls onClose when clicked', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />)
    await user.click(screen.getByTestId('mapping-drawer-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ─── Subheader (per row kind / rule) ────────────────────────────────────────

describe('MappingDrawer — subheader Rule 1 (single source)', () => {
  it('renders "from <field> [Badge]" for a single-source mapped row', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_1')
    expect(sub.textContent).toContain('from')
    expect(within(sub).getByText('ACCT_NO')).toBeInTheDocument()
    expect(within(sub).getByText('ACCT_MASTER')).toBeInTheDocument()
  })

  it('source field name uses font-mono', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_1')
    const fieldSpan = within(sub).getByText('ACCT_NO')
    expect(fieldSpan.className).toContain('font-mono')
  })
})

describe('MappingDrawer — subheader Rule 2 (multi-source same table)', () => {
  const row = () =>
    mapped({
      sources: [
        cifSource(0, 'FNAME'),
        cifSource(1, 'LNAME'),
        cifSource(2, 'MI'),
      ],
      targetField: targetField({ name: 'full_name' }),
    })

  it('renders comma-separated fields and ONE TableBadge', () => {
    render(<MappingDrawer row={row()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_2')
    expect(within(sub).getByText('FNAME, LNAME, MI')).toBeInTheDocument()
    // Only one CIF_MASTER badge inside the subheader (the header has its
    // own target-table badge for "accounts" — unrelated).
    expect(within(sub).getAllByText('CIF_MASTER')).toHaveLength(1)
  })

  it('field list uses font-mono', () => {
    render(<MappingDrawer row={row()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_2')
    const list = within(sub).getByText('FNAME, LNAME, MI')
    expect(list.className).toContain('font-mono')
  })
})

describe('MappingDrawer — subheader Rule 3 (cross-table, 2 tables)', () => {
  const row = () =>
    mapped({
      sources: [
        source({
          id: 'ms-A',
          ordinal: 0,
          sourceField: { id: 'sf-A', name: 'A_COL', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-A', name: 'TBL_A' },
        }),
        source({
          id: 'ms-B',
          ordinal: 1,
          sourceField: { id: 'sf-B', name: 'B_COL', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-B', name: 'TBL_B' },
        }),
      ],
    })

  it('renders each source with its own TableBadge', () => {
    render(<MappingDrawer row={row()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_3')
    expect(within(sub).getByText('A_COL')).toBeInTheDocument()
    expect(within(sub).getByText('B_COL')).toBeInTheDocument()
    expect(within(sub).getByText('TBL_A')).toBeInTheDocument()
    expect(within(sub).getByText('TBL_B')).toBeInTheDocument()
  })
})

describe('MappingDrawer — subheader Rule 4 (3+ tables or 5+ sources)', () => {
  const row = () =>
    mapped({
      sources: [
        source({
          id: 'ms-1',
          ordinal: 0,
          sourceField: { id: 'sf-1', name: 'F1', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'T1' },
        }),
        source({
          id: 'ms-2',
          ordinal: 1,
          sourceField: { id: 'sf-2', name: 'F2', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-2', name: 'T2' },
        }),
        source({
          id: 'ms-3',
          ordinal: 2,
          sourceField: { id: 'sf-3', name: 'F3', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-3', name: 'T3' },
        }),
        source({
          id: 'ms-4',
          ordinal: 3,
          sourceField: { id: 'sf-4', name: 'F4', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-4', name: 'T4' },
        }),
        source({
          id: 'ms-5',
          ordinal: 4,
          sourceField: { id: 'sf-5', name: 'F5', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-5', name: 'T5' },
        }),
      ],
    })

  it('renders the first 3 sources + "+ N more" pill (N=2)', () => {
    render(<MappingDrawer row={row()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_4')
    expect(within(sub).getByText('F1')).toBeInTheDocument()
    expect(within(sub).getByText('F2')).toBeInTheDocument()
    expect(within(sub).getByText('F3')).toBeInTheDocument()
    expect(within(sub).queryByText('F4')).toBeNull()
    expect(within(sub).queryByText('F5')).toBeNull()
    const more = within(sub).getByTestId('mapping-drawer-subheader-more')
    expect(more.textContent).toContain('+ 2 more')
  })

  it('does NOT render "+ N more" when sources count exactly equals the preview limit (defensive)', () => {
    // 3 sources / 3 tables → Rule 4 (table-count threshold), but no overflow.
    const r = mapped({
      sources: [
        source({
          id: 'ms-1',
          ordinal: 0,
          sourceField: { id: 'sf-1', name: 'F1', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-1', name: 'T1' },
        }),
        source({
          id: 'ms-2',
          ordinal: 1,
          sourceField: { id: 'sf-2', name: 'F2', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-2', name: 'T2' },
        }),
        source({
          id: 'ms-3',
          ordinal: 2,
          sourceField: { id: 'sf-3', name: 'F3', dataType: 'VARCHAR', isNullable: false },
          sourceTable: { id: 'st-3', name: 'T3' },
        }),
      ],
    })
    render(<MappingDrawer row={r} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-rule_4')
    expect(within(sub).queryByTestId('mapping-drawer-subheader-more')).toBeNull()
  })
})

describe('MappingDrawer — subheader Rule 5 (target_acknowledged)', () => {
  it('renders "acknowledged — <reason>" with reason in italic', () => {
    render(
      <MappingDrawer
        row={targetAck({ acknowledgmentReason: 'system default' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const sub = screen.getByTestId('mapping-drawer-subheader-ack')
    expect(sub.textContent).toContain('acknowledged')
    expect(sub.textContent).toContain('system default')
    // Reason rendered inside an italic span.
    const reason = within(sub).getByText('system default')
    expect(reason.className).toContain('italic')
  })

  it('renders "acknowledged" alone (italic) when reason is null', () => {
    render(
      <MappingDrawer
        row={targetAck({ acknowledgmentReason: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const sub = screen.getByTestId('mapping-drawer-subheader-ack')
    expect(sub.textContent).toBe('acknowledged')
    expect(sub.className).toContain('italic')
  })
})

describe('MappingDrawer — subheader Rule 6 (unmapped)', () => {
  it('renders italic "no source mapped yet"', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const sub = screen.getByTestId('mapping-drawer-subheader-unmapped')
    expect(sub.textContent).toBe('no source mapped yet')
    expect(sub.className).toContain('italic')
  })
})

describe('MappingDrawer — subheader VA (value_assignment)', () => {
  it('renders italic "value assignment"', () => {
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const sub = screen.getByTestId('mapping-drawer-subheader-va')
    expect(sub.textContent).toBe('value assignment')
    expect(sub.className).toContain('italic')
  })
})

// ─── Body + footer placeholders ────────────────────────────────────────────

describe('MappingDrawer — body + footer placeholders', () => {
  it('renders the body placeholder text "Tab content coming in Gaps 8-10"', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(body.textContent).toContain('Tab content coming in Gaps 8-10')
  })

  it('renders the footer placeholder text "Actions coming in Gap 10"', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const footer = screen.getByTestId('mapping-drawer-footer')
    expect(footer.textContent).toContain('Actions coming in Gap 10')
  })

  it('body uses muted text color (slate-400)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const p = body.querySelector('p')
    expect(p?.className).toContain('text-slate-400')
  })
})

// ─── A11y attributes ───────────────────────────────────────────────────────

describe('MappingDrawer — accessibility', () => {
  it('exposes role="dialog" and aria-modal="true"', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    expect(drawer.getAttribute('role')).toBe('dialog')
    expect(drawer.getAttribute('aria-modal')).toBe('true')
  })

  it('aria-labelledby points at the field-name heading element', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    const ariaLabelledBy = drawer.getAttribute('aria-labelledby')
    expect(ariaLabelledBy).toBeTruthy()
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.id).toBe(ariaLabelledBy)
  })
})

// ─── Esc key close behavior ────────────────────────────────────────────────

describe('MappingDrawer — Esc closes', () => {
  it('Esc keydown anywhere on document calls onClose', () => {
    const onClose = vi.fn()
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('non-Escape keys do NOT call onClose', () => {
    const onClose = vi.fn()
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Enter' })
    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not register the keydown listener when isOpen=false', () => {
    const onClose = vi.fn()
    render(<MappingDrawer row={mapped()} isOpen={false} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ─── Click outside close behavior ──────────────────────────────────────────

describe('MappingDrawer — click outside closes', () => {
  it('mousedown on a non-drawer, non-row element calls onClose', () => {
    const onClose = vi.fn()
    render(
      <div>
        <button data-testid="page-button">Outside</button>
        <MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('page-button'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('mousedown inside the drawer does NOT call onClose', () => {
    const onClose = vi.fn()
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />)
    fireEvent.mouseDown(screen.getByTestId('mapping-drawer-body'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mousedown on a row body does NOT call onClose (row click switches drawer instead)', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="field-mapping-row-body">Some row</div>
        <MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('field-mapping-row-body'))
    expect(onClose).not.toHaveBeenCalled()
  })
})

// ─── Width invariant ───────────────────────────────────────────────────────

describe('MappingDrawer — width', () => {
  it('inline width matches the exported MAPPING_DRAWER_WIDTH_PX (520)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    expect(drawer.style.width).toBe('520px')
  })
})

// ─── Light-mode-only invariant (regression guard for the Gap 5a hotfix) ────

describe('MappingDrawer — light-mode-only invariant', () => {
  it('rendered HTML contains no Tailwind dark-prefix classes', () => {
    const { container } = render(
      <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />,
    )
    expect(container.innerHTML).not.toMatch(/\bdark:[a-z]/i)
  })
})
