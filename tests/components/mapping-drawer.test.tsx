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

// ─── Mapped-row placeholder + footer placeholder ───────────────────────────
//
// Gap 8a updated the mapped-row placeholder copy to call out Gap 8b explicitly
// (the per-source roster is Gap 8b's territory). The footer placeholder is
// unchanged from Gap 7 — Gap 9 fills it with action buttons.

describe('MappingDrawer — mapped-row placeholder + footer placeholder', () => {
  it('mapped row body shows the Gap 8b placeholder copy', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    expect(body.textContent).toContain(
      'Mapped row drawer body — coming in Gap 8b',
    )
  })

  it('mapped placeholder uses the dedicated test-id', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('drawer-mapped-placeholder')).toBeInTheDocument()
  })

  it('renders the footer placeholder text "Actions coming in Gap 10"', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const footer = screen.getByTestId('mapping-drawer-footer')
    expect(footer.textContent).toContain('Actions coming in Gap 10')
  })

  it('mapped placeholder uses muted text color (slate-400)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const placeholder = screen.getByTestId('drawer-mapped-placeholder')
    expect(placeholder.className).toContain('text-slate-400')
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
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const prose = screen.getByTestId('drawer-unmapped-prose')
    expect(prose.textContent).toContain('no source mapping yet')
    expect(prose.textContent).toContain('AI Suggest')
    expect(prose.textContent).toContain('acknowledge')
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

// ─── Mapped row regression ─────────────────────────────────────────────────

describe('MappingDrawer — Mapped row body (regression guard for Gap 8b)', () => {
  it('does NOT render Acknowledgment, Mapping status, Value expression sections', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-acknowledgment')).toBeNull()
    expect(screen.queryByTestId('drawer-section-mapping-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-value-expression')).toBeNull()
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
  })

  it('placeholder explicitly mentions Gap 8b so the deferred state is unambiguous', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const placeholder = screen.getByTestId('drawer-mapped-placeholder')
    expect(placeholder.textContent).toContain('Gap 8b')
  })

  it('mapped placeholder does not pollute the Rule 5 / Rule 6 / VA test-ids', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-target-field-name')).toBeNull()
    expect(screen.queryByTestId('drawer-acknowledgment-reason')).toBeNull()
    expect(screen.queryByTestId('drawer-unmapped-prose')).toBeNull()
    expect(screen.queryByTestId('drawer-value-expression')).toBeNull()
  })
})
