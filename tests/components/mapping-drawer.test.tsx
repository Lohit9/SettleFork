import { beforeEach, describe, expect, it, vi } from 'vitest'
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

// ─── Mapped-row body shape + footer (Gap 8b + Gap 9) ───────────────────────
//
// Gap 8b replaced the Gap 8a "Mapped row drawer body — coming in Gap 8b"
// placeholder with the real per-source-roster body. Gap 9 replaced the
// "Actions coming in Gap 10" footer placeholder with the real Approve /
// Reject button row. These tests lock the post-9 shape — neither
// placeholder may render any longer.

describe('MappingDrawer — mapped-row body shape + footer', () => {
  it('mapped row body renders the Target field section (Gap 8a placeholder removed)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
  })

  it('the Gap 8a mapped placeholder test-id no longer appears in the DOM', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-mapped-placeholder')).toBeNull()
  })

  it('the body no longer contains the Gap 8a placeholder copy', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(body.textContent).not.toContain(
      'Mapped row drawer body — coming in Gap 8b',
    )
  })

  it('the footer no longer renders the Gap 7/8 placeholder copy', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const footer = screen.getByTestId('mapping-drawer-footer')
    expect(footer.textContent).not.toContain('Actions coming in Gap 10')
  })

  it('renders Approve and Reject buttons in the footer for a mapped row', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).toBeInTheDocument()
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 8a — body content for Rule 5 / Rule 6 / VA rows.
// ─────────────────────────────────────────────────────────────────────────────
//
// Mapped rows (Rule 1-4) continue to render the placeholder — Gap 8b fills
// that. The drawer body wrapper (`data-testid="mapping-drawer-body"`) is
// preserved so the Gap 7 outside-click contract still holds.

// ─── Body skeleton invariants ──────────────────────────────────────────────

describe('MappingDrawer — body skeleton invariants (all kinds)', () => {
  const cases: Array<{ name: string; row: () => Parameters<typeof MappingDrawer>[0]['row'] }> = [
    { name: 'mapped', row: () => mapped() },
    { name: 'value_assignment', row: () => valueAssignment() },
    { name: 'target_acknowledged', row: () => targetAck() },
    { name: 'unmapped', row: () => unmapped() },
  ]

  it.each(cases)('renders the body wrapper test-id for $name rows', ({ row }) => {
    render(<MappingDrawer row={row()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('mapping-drawer-body')).toBeInTheDocument()
  })

  it('body wrapper is scrollable (flex-1 + overflow-auto)', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(body.className).toContain('flex-1')
    expect(body.className).toContain('overflow-auto')
  })
})

// ─── Rule 5 — Target Acknowledged body ─────────────────────────────────────

describe('MappingDrawer — Rule 5 (Target Acknowledged) body', () => {
  it('renders the Target field section with name, table badge, type, and required indicator', () => {
    render(
      <MappingDrawer
        row={targetAck({
          targetField: targetField({
            name: 'description',
            dataType: 'VARCHAR(255)',
            isNullable: false,
            targetTable: { id: 'tt-9', name: 'account_status' },
          }),
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('drawer-section-target-field')
    expect(within(section).getByTestId('drawer-target-field-name').textContent).toBe(
      'description',
    )
    expect(within(section).getByText('account_status')).toBeInTheDocument()
    const meta = within(section).getByTestId('drawer-target-field-meta')
    expect(meta.textContent).toContain('VARCHAR(255)')
    expect(meta.textContent).toContain('required')
  })

  it('Target field meta shows "nullable" when isNullable=true', () => {
    render(
      <MappingDrawer
        row={targetAck({
          targetField: targetField({ isNullable: true }),
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const meta = screen.getByTestId('drawer-target-field-meta')
    expect(meta.textContent).toContain('nullable')
    expect(meta.textContent).not.toContain('required')
  })

  it('renders Acknowledgment section with the reason text when present', () => {
    render(
      <MappingDrawer
        row={targetAck({ acknowledgmentReason: 'system default' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const reason = screen.getByTestId('drawer-acknowledgment-reason')
    expect(reason.textContent).toBe('system default')
  })

  it('Acknowledgment section shows empty-state when acknowledgmentReason is null', () => {
    render(
      <MappingDrawer
        row={targetAck({ acknowledgmentReason: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-acknowledgment-reason')).toBeNull()
    expect(
      screen.getByTestId('drawer-acknowledgment-reason-empty'),
    ).toBeInTheDocument()
  })

  // Notes / acknowledged-by / acknowledged-at: NOT on the contract today.
  // Deferred per Gap 8a contract-shape decision (see AcknowledgedBody JSDoc).
  it('does NOT render any acknowledged-by, acknowledged-at, or notes sub-fields (deferred)', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByText(/acknowledged by/i)).toBeNull()
    expect(screen.queryByText(/acknowledged at/i)).toBeNull()
    expect(screen.queryByText(/^notes$/i)).toBeNull()
  })

  it('renders Status section with "Approved" + green dot', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    const status = screen.getByTestId('drawer-section-status')
    const indicator = within(status).getByTestId('drawer-status-indicator')
    expect(indicator.textContent).toContain('Approved')
    const dot = indicator.querySelector('span[aria-hidden="true"]')
    expect(dot?.className).toContain('bg-green-500')
  })

  it('section ordering is Target field → Acknowledgment → Status', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const sections = within(body).getAllByRole('heading', { level: 3 })
    expect(sections.map((h) => h.textContent)).toEqual([
      'Target field',
      'Acknowledgment',
      'Status',
    ])
  })

  it('does NOT show Value expression, AI reasoning, or Mapping status sections', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-value-expression')).toBeNull()
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-section-mapping-status')).toBeNull()
  })
})

// ─── Rule 6 — Unmapped body ────────────────────────────────────────────────

describe('MappingDrawer — Rule 6 (Unmapped) body', () => {
  it('renders the Target field section', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
  })

  it('renders the Mapping status section with the empty-state prose', () => {
    // Post-Gap-9 amendment (2026-04-25): the prose was rewritten to
    // stop referencing legacy-only affordances ("AI Suggest from the
    // Mapping page" / "acknowledge … intentionally unmapped"). The
    // redesign currently has no remap workflow, so the copy points
    // users to the legacy view until a future remap gap (Phase 4 /
    // TBD) ports those flows.
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const prose = screen.getByTestId('drawer-unmapped-prose')
    expect(prose.textContent).toContain('Remapping unmapped fields is coming soon')
    expect(prose.textContent).toContain('legacy Mapping view')
    // Regression guard: the old copy mentioned "AI Suggest" and
    // "acknowledge" — affordances absent from the redesign today.
    expect(prose.textContent).not.toContain('AI Suggest')
    expect(prose.textContent).not.toContain('acknowledge')
  })

  it('does NOT render a Status section (unmapped state is implicit)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
  })

  it('does NOT render any action buttons (Gap 9 territory)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(within(body).queryAllByRole('button')).toHaveLength(0)
  })

  it('section ordering is Target field → Mapping status', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const sections = within(body).getAllByRole('heading', { level: 3 })
    expect(sections.map((h) => h.textContent)).toEqual([
      'Target field',
      'Mapping status',
    ])
  })
})

// ─── VA — Value Assignment body ────────────────────────────────────────────

describe('MappingDrawer — Value Assignment body', () => {
  it('renders the Target field section', () => {
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
  })

  it('renders the Value expression section with combinationSql in a code block', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ combinationSql: 'NOW()' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const expr = screen.getByTestId('drawer-value-expression')
    expect(expr.textContent).toBe('NOW()')
    expect(expr.tagName).toBe('PRE')
    expect(expr.className).toContain('font-mono')
    expect(expr.className).toContain('bg-slate-50')
    expect(expr.className).toContain('text-xs')
  })

  it('Value expression code block preserves multiline whitespace', () => {
    const sql = "CASE\n  WHEN status = 'A' THEN 'active'\n  ELSE 'inactive'\nEND"
    render(
      <MappingDrawer
        row={valueAssignment({ combinationSql: sql })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const expr = screen.getByTestId('drawer-value-expression')
    expect(expr.className).toContain('whitespace-pre-wrap')
    expect(expr.textContent).toBe(sql)
  })

  it('Value expression shows empty-state when combinationSql is null', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ combinationSql: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-value-expression')).toBeNull()
    expect(
      screen.getByTestId('drawer-value-expression-empty'),
    ).toBeInTheDocument()
  })

  it('renders the AI reasoning section with prose when aiReasoning is non-null', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: 'Default created_at uses NOW()' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const reasoning = screen.getByTestId('drawer-ai-reasoning')
    expect(reasoning.textContent).toBe('Default created_at uses NOW()')
    expect(reasoning.className).toContain('italic')
  })

  it('AI reasoning section shows empty-state when aiReasoning is null', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-ai-reasoning')).toBeNull()
    const empty = screen.getByTestId('drawer-ai-reasoning-empty')
    expect(empty.textContent).toBe('No reasoning available')
  })

  it('renders Confidence section as 2-decimal percentage', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ confidence: 92 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const conf = screen.getByTestId('drawer-confidence')
    expect(conf.textContent).toBe('92.00%')
  })

  it('Confidence section shows em-dash when confidence is null', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ confidence: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-confidence')).toBeNull()
    const empty = screen.getByTestId('drawer-confidence-empty')
    expect(empty.textContent).toContain('—')
    expect(empty.getAttribute('aria-label')).toBe('no confidence available')
  })

  it('Status section reflects actual row.status (not hardcoded "Approved")', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const indicator = screen.getByTestId('drawer-status-indicator')
    expect(indicator.textContent).toContain('Needs Review')
    const dot = indicator.querySelector('span[aria-hidden="true"]')
    expect(dot?.className).toContain('bg-amber-400')
  })

  it('Status section shows Approved + green dot when status="approved"', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ status: 'approved' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const indicator = screen.getByTestId('drawer-status-indicator')
    expect(indicator.textContent).toContain('Approved')
    const dot = indicator.querySelector('span[aria-hidden="true"]')
    expect(dot?.className).toContain('bg-green-500')
  })

  it('section ordering is Target field → Value expression → AI reasoning → Confidence → Status', () => {
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sections = within(body).getAllByRole('heading', { level: 3 })
    expect(sections.map((h) => h.textContent)).toEqual([
      'Target field',
      'Value expression',
      'AI reasoning',
      'Confidence',
      'Status',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 8b — body content for mapped rows (Rules 1, 2, 3, 4).
// ─────────────────────────────────────────────────────────────────────────────
//
// Per-source roster + combination strategy + row-level reasoning/confidence.
// Replaces the Gap 8a "coming in Gap 8b" placeholder.

// ── Multi-source / cross-table fixture builders ─────────────────────────────

function rule2Mapped(
  overrides: Partial<MappedRow> = {},
  sourcesOverrides: Array<Partial<MappingSourceRef>> | null = null,
): MappedRow {
  // Same source table; 2+ sources → Rule 2.
  const defaultSources: MappingSourceRef[] = [
    source({
      id: 'ms-r2-a',
      ordinal: 0,
      confidence: 95,
      sourceField: { id: 'sf-r2-a', name: 'FNAME', dataType: 'VARCHAR(50)', isNullable: false },
      sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
    }),
    source({
      id: 'ms-r2-b',
      ordinal: 1,
      confidence: 90,
      sourceField: { id: 'sf-r2-b', name: 'LNAME', dataType: 'VARCHAR(50)', isNullable: false },
      sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
    }),
  ]
  const sources = sourcesOverrides
    ? sourcesOverrides.map((o, i) => ({ ...defaultSources[i % defaultSources.length]!, ...o }))
    : defaultSources
  return mapped({
    id: 'tfm-r2',
    targetField: targetField({ id: 'tf-r2', name: 'full_name' }),
    sources,
    combinationType: 'concat_space',
    combinationSql: null,
    confidence: 90,
    ...overrides,
  })
}

function rule3Mapped(
  overrides: Partial<MappedRow> = {},
): MappedRow {
  // 2+ sources, exactly 2 source tables → Rule 3.
  const sources: MappingSourceRef[] = [
    source({
      id: 'ms-r3-a',
      ordinal: 0,
      confidence: 88,
      sourceField: { id: 'sf-r3-a', name: 'AccountName', dataType: 'VARCHAR(100)', isNullable: false },
      sourceTable: { id: 'st-acc', name: 'AccountMaster' },
      joinAnnotation: null,
    }),
    source({
      id: 'ms-r3-b',
      ordinal: 1,
      confidence: 80,
      sourceField: { id: 'sf-r3-b', name: 'Email', dataType: 'VARCHAR(200)', isNullable: true },
      sourceTable: { id: 'st-con', name: 'ContactMaster' },
      joinAnnotation: 'PrimaryContactID',
    }),
  ]
  return mapped({
    id: 'tfm-r3',
    targetField: targetField({ id: 'tf-r3', name: 'display_name' }),
    sources,
    combinationType: 'concat_comma',
    combinationSql: null,
    confidence: 80,
    ...overrides,
  })
}

function rule4Mapped(
  overrides: Partial<MappedRow> = {},
): MappedRow {
  // 5 sources across 2 tables → Rule 4 (field-count threshold).
  const sources: MappingSourceRef[] = [
    source({ id: 'ms-r4-1', ordinal: 0, confidence: 90, sourceField: { id: 'sf-r4-1', name: 'F1', dataType: 'VARCHAR(50)', isNullable: false }, sourceTable: { id: 'st-a', name: 'TableA' } }),
    source({ id: 'ms-r4-2', ordinal: 1, confidence: 85, sourceField: { id: 'sf-r4-2', name: 'F2', dataType: 'VARCHAR(50)', isNullable: false }, sourceTable: { id: 'st-a', name: 'TableA' } }),
    source({ id: 'ms-r4-3', ordinal: 2, confidence: 80, sourceField: { id: 'sf-r4-3', name: 'F3', dataType: 'VARCHAR(50)', isNullable: true }, sourceTable: { id: 'st-a', name: 'TableA' } }),
    source({ id: 'ms-r4-4', ordinal: 3, confidence: 75, sourceField: { id: 'sf-r4-4', name: 'F4', dataType: 'VARCHAR(50)', isNullable: true }, sourceTable: { id: 'st-b', name: 'TableB' }, joinAnnotation: 'JoinKey' }),
    source({ id: 'ms-r4-5', ordinal: 4, confidence: 70, sourceField: { id: 'sf-r4-5', name: 'F5', dataType: 'VARCHAR(50)', isNullable: true }, sourceTable: { id: 'st-b', name: 'TableB' }, joinAnnotation: 'JoinKey' }),
  ]
  return mapped({
    id: 'tfm-r4',
    targetField: targetField({ id: 'tf-r4', name: 'composite_field' }),
    sources,
    combinationType: 'custom_sql',
    combinationSql: "F1 || ' ' || F2 || ' / ' || F3 || ' / ' || F4 || '-' || F5",
    confidence: 70,
    ...overrides,
  })
}

// ── Rule 1 mapped body (single source) ─────────────────────────────────────

describe('MappingDrawer — Rule 1 (single source) mapped body', () => {
  it('renders the Target field section', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
  })

  it('renders the Sources section (header kept for Rule 1 — consistency)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const section = screen.getByTestId('drawer-section-sources')
    expect(section).toBeInTheDocument()
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(
      'Sources',
    )
  })

  it('renders exactly one source card for Rule 1', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    expect(cards).toHaveLength(1)
  })

  it('source card shows TableBadge + source field name + per-source confidence', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              confidence: 98,
              sourceField: { id: 'sf-1', name: 'CIF_NO', dataType: 'NUMBER', isNullable: false },
              sourceTable: { id: 'st-1', name: 'CIF_MASTER' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const card = screen.getByTestId('drawer-source-card')
    expect(within(card).getByText('CIF_MASTER')).toBeInTheDocument()
    expect(within(card).getByTestId('drawer-source-field-name').textContent).toBe(
      'CIF_NO',
    )
    expect(within(card).getByTestId('drawer-source-confidence').textContent).toBe(
      '98.00%',
    )
  })

  it('source card does NOT render a join annotation for Rule 1 (always null)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-source-join')).toBeNull()
  })

  it('source card shows sample values when sampleValues is non-empty', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [source({ sampleValues: ['12345', '67890', '24680'] })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const samples = screen.getByTestId('drawer-source-samples')
    expect(samples.textContent).toContain('Sample values')
    expect(samples.textContent).toContain('12345, 67890, 24680')
  })

  it('source card omits sample values block when sampleValues is empty', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-source-samples')).toBeNull()
  })

  it('source card truncates sample values to first 8 + "... (+N more)" when >8 values', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `v${i + 1}`)
    render(
      <MappingDrawer
        row={mapped({ sources: [source({ sampleValues: ten })] })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const samples = screen.getByTestId('drawer-source-samples')
    expect(samples.textContent).toContain(
      'v1, v2, v3, v4, v5, v6, v7, v8, ... (+2 more)',
    )
  })

  it('source card renders per-source AI reasoning when non-null (italic prose)', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [source({ aiReasoning: 'Direct PK match in dominant table.' })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const reasoning = screen.getByTestId('drawer-source-reasoning')
    expect(reasoning.textContent).toBe('Direct PK match in dominant table.')
    expect(reasoning.className).toContain('italic')
  })

  it('source card OMITS per-source AI reasoning when null (silent — no empty-state)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-source-reasoning')).toBeNull()
  })

  it('does NOT render the Combination section for Rule 1 (single source)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-combination')).toBeNull()
  })

  it('renders row-level AI reasoning when non-null', () => {
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: 'Single-source mapping; high confidence.' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const reasoning = screen.getByTestId('drawer-ai-reasoning')
    expect(reasoning.textContent).toBe(
      'Single-source mapping; high confidence.',
    )
  })

  it('renders row-level AI reasoning empty-state when null (absence is meaningful at row level)', () => {
    render(<MappingDrawer row={mapped({ aiReasoning: null })} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-ai-reasoning')).toBeNull()
    const empty = screen.getByTestId('drawer-ai-reasoning-empty')
    expect(empty.textContent).toBe('No reasoning available')
  })

  it('renders row-level Confidence as 2-decimal percentage (always shown — Rule 1 included)', () => {
    render(
      <MappingDrawer
        row={mapped({ confidence: 87 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('drawer-confidence').textContent).toBe('87.00%')
  })

  it('renders em-dash with sr-only label when row-level confidence is null', () => {
    render(
      <MappingDrawer
        row={mapped({ confidence: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-confidence')).toBeNull()
    const empty = screen.getByTestId('drawer-confidence-empty')
    expect(empty.textContent).toContain('—')
    expect(empty.getAttribute('aria-label')).toBe('no confidence available')
  })

  it('renders the Status section with the row.status', () => {
    render(<MappingDrawer row={mapped({ status: 'needs_review' })} isOpen={true} onClose={() => {}} />)
    const indicator = screen.getByTestId('drawer-status-indicator')
    expect(indicator.textContent).toContain('Needs Review')
  })

  it('section ordering for Rule 1 is Target field → Sources → AI reasoning → Confidence → Status (no Combination)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Target field',
      'Sources',
      'AI reasoning',
      'Confidence',
      'Status',
    ])
  })
})

// ── Rule 2 mapped body (multi-source, same table) ──────────────────────────

describe('MappingDrawer — Rule 2 (multi-source, same table) mapped body', () => {
  it('renders multiple source cards (one per source)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getAllByTestId('drawer-source-card')).toHaveLength(2)
  })

  it('every source card shares the same source table (Rule 2 invariant)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    cards.forEach((card) => {
      expect(within(card).getByText('CIF_MASTER')).toBeInTheDocument()
    })
  })

  it('does NOT render any join annotation (same-table sources)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-source-join')).toBeNull()
  })

  it('renders the Combination section with the human-readable label', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    const section = screen.getByTestId('drawer-section-combination')
    expect(within(section).getByTestId('drawer-combination-label').textContent).toBe(
      'Concatenate with space',
    )
  })

  it('Combination section hides the SQL code block for non-custom_sql types', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-combination-sql')).toBeNull()
  })

  it('Combination section renders the SQL code block when combinationType=custom_sql AND combinationSql is non-null', () => {
    const sql = "FNAME || ' / ' || LNAME"
    render(
      <MappingDrawer
        row={rule2Mapped({ combinationType: 'custom_sql', combinationSql: sql })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const block = screen.getByTestId('drawer-combination-sql')
    expect(block.tagName).toBe('PRE')
    expect(block.textContent).toBe(sql)
    expect(block.className).toContain('font-mono')
    expect(block.className).toContain('bg-slate-50')
    expect(block.className).toContain('whitespace-pre-wrap')
    expect(within(screen.getByTestId('drawer-section-combination')).getByTestId('drawer-combination-label').textContent).toBe(
      'Custom SQL expression',
    )
  })

  it('Combination section hides the SQL code block when combinationType=custom_sql but combinationSql is null', () => {
    render(
      <MappingDrawer
        row={rule2Mapped({ combinationType: 'custom_sql', combinationSql: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-combination-sql')).toBeNull()
  })

  it('section ordering for Rule 2 is Target field → Sources → Combination → AI reasoning → Confidence → Status', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Target field',
      'Sources',
      'Combination',
      'AI reasoning',
      'Confidence',
      'Status',
    ])
  })
})

// ── Rule 3 mapped body (cross-table, two tables) ───────────────────────────

describe('MappingDrawer — Rule 3 (cross-table, two tables) mapped body', () => {
  it('renders cards from each of the two source tables (multiple TableBadges, one per card)', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    expect(cards).toHaveLength(2)
    expect(within(cards[0]!).getByText('AccountMaster')).toBeInTheDocument()
    expect(within(cards[1]!).getByText('ContactMaster')).toBeInTheDocument()
  })

  it('renders the join annotation inline as "(join: <annotation>)" when joinAnnotation is non-null', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const join = screen.getByTestId('drawer-source-join')
    expect(join.textContent).toBe('(join: PrimaryContactID)')
    expect(join.className).toContain('italic')
  })

  it('does NOT render a join annotation for the dominant source (joinAnnotation === null)', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    expect(within(cards[0]!).queryByTestId('drawer-source-join')).toBeNull()
    expect(within(cards[1]!).getByTestId('drawer-source-join')).toBeInTheDocument()
  })

  it('renders the Combination section with concat_comma label', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('drawer-combination-label').textContent).toBe(
      'Concatenate with comma',
    )
  })

  it('section ordering for Rule 3 includes Combination section', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toContain('Combination')
  })
})

// ── Rule 4 mapped body (3+ tables OR 5+ sources) ───────────────────────────

describe('MappingDrawer — Rule 4 (multi-table complex) mapped body', () => {
  it('renders all 5 sources as individual cards (no truncation in drawer)', () => {
    render(<MappingDrawer row={rule4Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getAllByTestId('drawer-source-card')).toHaveLength(5)
  })

  it('renders join annotations on the cross-table sources (last 2)', () => {
    render(<MappingDrawer row={rule4Mapped()} isOpen={true} onClose={() => {}} />)
    const joins = screen.getAllByTestId('drawer-source-join')
    expect(joins).toHaveLength(2)
    joins.forEach((j) => {
      expect(j.textContent).toBe('(join: JoinKey)')
    })
  })

  it('renders the Combination section with custom_sql label + code block', () => {
    render(<MappingDrawer row={rule4Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('drawer-combination-label').textContent).toBe(
      'Custom SQL expression',
    )
    const block = screen.getByTestId('drawer-combination-sql')
    expect(block.textContent).toContain("F1 || ' ' || F2")
  })
})

// ── Mapped body regression guards ──────────────────────────────────────────

describe('MappingDrawer — Mapped body regression guards', () => {
  it('Gap 8a placeholder test-id is gone (drawer-mapped-placeholder must not render)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-mapped-placeholder')).toBeNull()
  })

  it('mapped body does NOT leak Acknowledgment / Mapping status / Value expression sections', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-acknowledgment')).toBeNull()
    expect(screen.queryByTestId('drawer-section-mapping-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-value-expression')).toBeNull()
  })

  it('body wrapper test-id is preserved (Gap 7 outside-click contract)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(body).toBeInTheDocument()
    expect(body.className).toContain('flex-1')
    expect(body.className).toContain('overflow-auto')
  })

  it('source-card render order matches the input sources[] (server ordinal order preserved)', () => {
    const cifA = source({
      id: 'ms-ord-a',
      ordinal: 0,
      sourceField: { id: 'sf-ord-a', name: 'ALPHA', dataType: 'VARCHAR(10)', isNullable: false },
      sourceTable: { id: 'st-x', name: 'TX' },
    })
    const cifB = source({
      id: 'ms-ord-b',
      ordinal: 1,
      sourceField: { id: 'sf-ord-b', name: 'BETA', dataType: 'VARCHAR(10)', isNullable: false },
      sourceTable: { id: 'st-x', name: 'TX' },
    })
    const cifC = source({
      id: 'ms-ord-c',
      ordinal: 2,
      sourceField: { id: 'sf-ord-c', name: 'GAMMA', dataType: 'VARCHAR(10)', isNullable: false },
      sourceTable: { id: 'st-x', name: 'TX' },
    })
    render(
      <MappingDrawer
        row={mapped({
          sources: [cifA, cifB, cifC],
          combinationType: 'concat_space',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const names = screen
      .getAllByTestId('drawer-source-field-name')
      .map((el) => el.textContent)
    expect(names).toEqual(['ALPHA', 'BETA', 'GAMMA'])
  })

  it('reuses TargetFieldSection and StatusSection (no duplication of those test-ids)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getAllByTestId('drawer-section-target-field')).toHaveLength(1)
    expect(screen.getAllByTestId('drawer-section-status')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Gap 9 — Footer action buttons (Approve / Reject + confirmation + UX state)
// ═══════════════════════════════════════════════════════════════════════════
//
// The drawer's footer is now a stateful action surface. These tests cover:
//
//   • Disabled-state matrix per row.kind × row.status (the 5 pinned
//     decisions act as regression guards):
//       - mapped/VA + needs_review: both enabled
//       - mapped/VA + approved:     Approve disabled, Reject enabled
//       - mapped/VA + rejected:     both enabled (legacy un-reject path)
//       - target_acknowledged:      both disabled with explanatory tooltips
//       - unmapped:                 footer hidden entirely
//
//   • Approve UX:
//       - Click → optimistic status update visible immediately
//       - Server success → onActionComplete('approve', rowId) fired
//       - Server failure → optimistic state reverted, error banner shown
//
//   • Reject UX:
//       - Click → confirmation dialog opens with locked copy
//       - Cancel → dialog closes, no action call
//       - Confirm → spinner appears, action call fires, dialog stays open
//                   until the call resolves
//       - Server success → onActionComplete('reject', rowId) fired
//       - Server failure → dialog closes, error banner shown
//
//   • Reject confirmation copy is the founder-locked exact text.
//
// We mock `@/lib/actions/mappings-for-redesign` so tests don't need a
// Supabase harness. `vi.hoisted` is required because `vi.mock` factories
// are hoisted to the top of the file by vitest's transformer; without
// hoisting these closure variables would be uninitialized when the
// factory runs.

import { act } from 'react'

const { approveFieldMappingMock, rejectFieldMappingMock } = vi.hoisted(() => ({
  approveFieldMappingMock: vi.fn(),
  rejectFieldMappingMock: vi.fn(),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: (...args: unknown[]) =>
    approveFieldMappingMock(...args),
  rejectFieldMapping: (...args: unknown[]) =>
    rejectFieldMappingMock(...args),
}))

beforeEach(() => {
  approveFieldMappingMock.mockReset()
  rejectFieldMappingMock.mockReset()
})

describe('MappingDrawer Gap 9 — disabled-state matrix', () => {
  it('mapped row + status=needs_review: both Approve and Reject are enabled', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).not.toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).not.toBeDisabled()
  })

  it('mapped row + status=approved: Approve is DISABLED, Reject is enabled', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'approved' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('mapping-drawer-approve-button')).toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).not.toBeDisabled()
  })

  it('mapped row + status=rejected (legacy): BOTH buttons are enabled', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'rejected' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).not.toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).not.toBeDisabled()
  })

  it('value_assignment row + status=needs_review: both buttons enabled', () => {
    render(
      <MappingDrawer
        row={valueAssignment({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).not.toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).not.toBeDisabled()
  })

  it('target_acknowledged: BOTH buttons are disabled with explanatory tooltips', () => {
    render(
      <MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />,
    )
    const approveBtn = screen.getByTestId('mapping-drawer-approve-button')
    const rejectBtn = screen.getByTestId('mapping-drawer-reject-button')
    expect(approveBtn).toBeDisabled()
    expect(rejectBtn).toBeDisabled()
    expect(rejectBtn.getAttribute('title')).toContain(
      'Acknowledged rows',
    )
    expect(approveBtn.getAttribute('title')).toContain(
      'Acknowledged rows',
    )
  })

  it('unmapped row: the footer is NOT rendered (no actions available)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('mapping-drawer-footer')).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
  })
})

describe('MappingDrawer Gap 9 — Approve action', () => {
  it('clicking Approve calls approveFieldMapping with the row id', async () => {
    approveFieldMappingMock.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ id: 'tfm-test', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    expect(approveFieldMappingMock).toHaveBeenCalledWith('tfm-test')
  })

  it('on success, fires onActionComplete("approve", rowId)', async () => {
    approveFieldMappingMock.mockResolvedValue({ success: true })
    const onActionComplete = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ id: 'tfm-success', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
        onActionComplete={onActionComplete}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    // Wait for the transition / async callback to settle.
    await act(async () => {
      await Promise.resolve()
    })
    expect(onActionComplete).toHaveBeenCalledWith('approve', 'tfm-success')
  })

  it('optimistically reflects approved status before the server resolves', async () => {
    const deferred: { resolve?: (v: { success: boolean }) => void } = {}
    approveFieldMappingMock.mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // Pre-click sanity: status indicator says Needs Review.
    expect(
      screen.getByTestId('drawer-status-indicator').textContent,
    ).toContain('Needs Review')
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    // While the promise is pending the optimistic overlay is applied.
    expect(
      screen.getByTestId('drawer-status-indicator').textContent,
    ).toContain('Approved')
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeDisabled()
    // Resolve the promise to clean up.
    deferred.resolve?.({ success: true })
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('on server failure, reverts optimistic state and shows the error banner', async () => {
    approveFieldMappingMock.mockResolvedValue({
      success: false,
      error: 'boom',
      errorCode: 'INTERNAL',
    })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Status reverted to Needs Review.
    expect(
      screen.getByTestId('drawer-status-indicator').textContent,
    ).toContain('Needs Review')
    // Error banner shows the generic copy.
    const banner = screen.getByTestId('mapping-drawer-error')
    expect(banner.textContent).toContain("Couldn't approve this mapping")
  })
})

describe('MappingDrawer Gap 9 — Reject action', () => {
  it('clicking Reject opens the confirmation dialog (does NOT call rejectFieldMapping yet)', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    expect(
      screen.getByTestId('mapping-drawer-reject-confirm-dialog'),
    ).toBeInTheDocument()
    expect(rejectFieldMappingMock).not.toHaveBeenCalled()
  })

  it('confirmation dialog uses the founder-locked title and body copy', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          targetField: targetField({ name: 'cool_field' }),
          status: 'needs_review',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    const dialog = screen.getByTestId('mapping-drawer-reject-confirm-dialog')
    expect(dialog.textContent).toContain('Reject this mapping?')
    expect(dialog.textContent).toContain('cool_field')
    expect(dialog.textContent).toContain('will become unmapped')
    expect(dialog.textContent).toContain(
      'The mapping and any associated transformation will be deleted',
    )
    expect(dialog.textContent).toContain('This cannot be undone')
  })

  it('Cancel button closes the dialog and does NOT call rejectFieldMapping', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    await user.click(screen.getByTestId('mapping-drawer-reject-cancel'))
    expect(
      screen.queryByTestId('mapping-drawer-reject-confirm-dialog'),
    ).toBeNull()
    expect(rejectFieldMappingMock).not.toHaveBeenCalled()
  })

  it('Confirm button calls rejectFieldMapping with the row id', async () => {
    rejectFieldMappingMock.mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ id: 'tfm-rej', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    await user.click(screen.getByTestId('mapping-drawer-reject-confirm'))
    expect(rejectFieldMappingMock).toHaveBeenCalledWith('tfm-rej')
  })

  it('shows a loading spinner on the confirm button while the action is in flight', async () => {
    const deferred: { resolve?: (v: { success: boolean }) => void } = {}
    rejectFieldMappingMock.mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          deferred.resolve = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    await user.click(screen.getByTestId('mapping-drawer-reject-confirm'))
    // While pending, both Cancel and Confirm are disabled and the
    // footer Reject button shows the spinner.
    expect(
      screen.getByTestId('mapping-drawer-reject-confirm'),
    ).toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-cancel'),
    ).toBeDisabled()
    expect(
      screen.getByTestId('mapping-drawer-reject-spinner'),
    ).toBeInTheDocument()
    deferred.resolve?.({ success: true })
    await act(async () => {
      await Promise.resolve()
    })
  })

  it('on success, fires onActionComplete("reject", rowId)', async () => {
    rejectFieldMappingMock.mockResolvedValue({ success: true })
    const onActionComplete = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ id: 'tfm-rej-ok', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
        onActionComplete={onActionComplete}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    await user.click(screen.getByTestId('mapping-drawer-reject-confirm'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(onActionComplete).toHaveBeenCalledWith('reject', 'tfm-rej-ok')
  })

  it('on server failure, closes the dialog and shows the error banner', async () => {
    rejectFieldMappingMock.mockResolvedValue({
      success: false,
      error: 'boom',
      errorCode: 'INTERNAL',
    })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-reject-button'))
    await user.click(screen.getByTestId('mapping-drawer-reject-confirm'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      screen.queryByTestId('mapping-drawer-reject-confirm-dialog'),
    ).toBeNull()
    const banner = screen.getByTestId('mapping-drawer-error')
    expect(banner.textContent).toContain("Couldn't reject this mapping")
  })
})

describe('MappingDrawer Gap 9 — error banner reset on row change', () => {
  it('clears the error banner when the drawer switches to a different row', async () => {
    approveFieldMappingMock.mockResolvedValue({
      success: false,
      error: 'boom',
    })
    const user = userEvent.setup()
    const { rerender } = render(
      <MappingDrawer
        row={mapped({ id: 'tfm-a', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('mapping-drawer-error')).toBeInTheDocument()
    rerender(
      <MappingDrawer
        row={mapped({ id: 'tfm-b', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('mapping-drawer-error')).toBeNull()
  })
})
