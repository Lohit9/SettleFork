import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MappingDrawer,
  MAPPING_DRAWER_WIDTH_PX,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  SourceFieldWithState,
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
// Surfaces as kind='unmapped' with status='approved'. `acknowledgmentReason`
// dropped from the contract; downstream tests no longer assert reason text.
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

describe('MappingDrawer — header (feat/mapping-drawer-header-redesign)', () => {
  // ── Layout: MAPPING label + title row + confidence line + close ──
  //
  // feat/mapping-drawer-header-redesign replaces the prior FROM/TO
  // stack with a compact 3-line header. Editing pencils, remove
  // buttons, ⊕ Add source, status badge — all retired. The relocations:
  //   • primary-source swap → flat view source-cell click
  //   • non-primary-source swap → drawer BODY SOURCE column pencil
  //   • add source → drawer BODY SOURCE column "+ Add source" button
  //   • remove one source from multi → drawer BODY ✕ on non-primary
  //   • target swap → flat view target-cell click
  //   • whole-TFM removal → flat-view row reject OR drawer body's
  //     "Remove mapping" link
  //   • status word/colour → folded into the new confidence line

  it('renders the MAPPING label, title row, and confidence line in order', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const header = screen.getByTestId('mapping-drawer-header')
    expect(within(header).getByTestId('mapping-drawer-header-label').textContent).toBe('Mapping')
    expect(
      within(header).getByTestId('mapping-drawer-header-title'),
    ).toBeInTheDocument()
    expect(
      within(header).getByTestId('mapping-drawer-header-confidence'),
    ).toBeInTheDocument()
  })

  it('mapped single-source title renders source side · target side with the muted arrow between', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-header-title')
    const sourceSide = within(title).getByTestId(
      'mapping-drawer-header-title-source',
    )
    const targetSide = within(title).getByTestId(
      'mapping-drawer-header-title-target',
    )
    expect(sourceSide.textContent).toContain('ACCT_MASTER')
    expect(sourceSide.textContent).toContain('ACCT_NO')
    expect(targetSide.textContent).toContain('accounts')
    expect(targetSide.textContent).toContain('customer_id')
    // Title row carries the arrow glyph between source and target.
    expect(title.textContent).toContain('→')
    // No multi-source pill on single-source rows.
    expect(
      within(title).queryByTestId('mapping-drawer-header-multi-source-pill'),
    ).toBeNull()
  })

  it('mapped multi-source title shows primary source + "+ N source" pill before the arrow', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              id: 'ms-a',
              ordinal: 0,
              sourceField: {
                id: 'sf-a',
                name: 'field_a',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-a', name: 'TBL_A' },
            }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'field_b',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
            source({
              id: 'ms-c',
              ordinal: 2,
              sourceField: {
                id: 'sf-c',
                name: 'field_c',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-c', name: 'TBL_C' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const sourceSide = screen.getByTestId('mapping-drawer-header-title-source')
    expect(sourceSide.textContent).toContain('TBL_A')
    expect(sourceSide.textContent).toContain('field_a')
    // Non-primary sources do NOT appear in the header title — only the pill.
    expect(sourceSide.textContent).not.toContain('field_b')
    expect(sourceSide.textContent).not.toContain('field_c')
    const pill = screen.getByTestId('mapping-drawer-header-multi-source-pill')
    // Singular "source" per mockup convention; count = sourceCount - 1.
    expect(pill.textContent).toContain('+ 2 source')
    expect(pill.getAttribute('data-source-count')).toBe('3')
  })

  it('unmapped-target title shows target side only (no arrow, no source side)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-header-title')
    expect(
      within(title).queryByTestId('mapping-drawer-header-title-source'),
    ).toBeNull()
    const targetSide = within(title).getByTestId(
      'mapping-drawer-header-title-target',
    )
    // Default `unmapped()` fixture: tf-4 / missing_field on table `accounts`.
    expect(targetSide.textContent).toContain('accounts')
    expect(targetSide.textContent).toContain('missing_field')
    expect(title.textContent).not.toContain('→')
  })

  it('value-assignment title shows "Value assignment" italic on the source side + target side after the arrow', () => {
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    const title = screen.getByTestId('mapping-drawer-header-title')
    const sourceSide = within(title).getByTestId(
      'mapping-drawer-header-title-source',
    )
    expect(sourceSide.textContent).toBe('Value assignment')
    expect(sourceSide.className).toContain('italic')
    expect(title.textContent).toContain('→')
    const targetSide = within(title).getByTestId(
      'mapping-drawer-header-title-target',
    )
    expect(targetSide.textContent).toContain('created_at')
  })

  it('confidence line renders dot + pct + status-derived label for an approved mapped row', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'approved', confidence: 98 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const line = screen.getByTestId('mapping-drawer-header-confidence')
    expect(line.getAttribute('data-status')).toBe('approved')
    const dot = within(line).getByTestId('mapping-drawer-header-confidence-dot')
    expect(dot.className).toContain('bg-emerald-500')
    const text = within(line).getByTestId('mapping-drawer-header-confidence-text')
    // formatConfidencePercent rounds to integer per Phase 4-polish-1 Refinement H.
    expect(text.textContent).toContain('98%')
    expect(text.textContent).toContain('confidence')
  })

  it('confidence line renders the status label for needs_review and rejected rows', () => {
    const { rerender } = render(
      <MappingDrawer
        row={mapped({ status: 'needs_review', confidence: 54 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    let line = screen.getByTestId('mapping-drawer-header-confidence')
    expect(line.getAttribute('data-status')).toBe('needs_review')
    expect(
      within(line).getByTestId('mapping-drawer-header-confidence-dot').className,
    ).toContain('bg-slate-400')
    expect(
      within(line).getByTestId('mapping-drawer-header-confidence-text').textContent,
    ).toContain('needs review')

    rerender(
      <MappingDrawer
        row={mapped({ status: 'rejected', confidence: 80 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    line = screen.getByTestId('mapping-drawer-header-confidence')
    expect(line.getAttribute('data-status')).toBe('rejected')
    // feat/normalize-rejected-rows-null-confidence: post-#157/#158/A2
    // 'rejected' collapses onto the needs_review visual (Reject =
    // reset). The dot renders slate-400, NOT red — matching the
    // flat-view `FlatStatusDot` / `StatusDot` collapse. The trailing
    // label word stays "rejected".
    expect(
      within(line).getByTestId('mapping-drawer-header-confidence-dot').className,
    ).toContain('bg-slate-400')
    expect(
      within(line).getByTestId('mapping-drawer-header-confidence-dot').className,
    ).not.toContain('bg-red-500')
    expect(
      within(line).getByTestId('mapping-drawer-header-confidence-text').textContent,
    ).toContain('rejected')
  })

  it('confidence line renders NOTHING when row.confidence is null (unmapped / null-confidence VA)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    // feat/normalize-rejected-rows-null-confidence: a null confidence
    // suppresses the whole line — no dot, no label. Pre-change it
    // rendered a bare status word with no number.
    expect(
      screen.queryByTestId('mapping-drawer-header-confidence'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-header-confidence-text'),
    ).toBeNull()
  })

  it('confidence line renders NOTHING for an approved row with null confidence (orphan-visual fix)', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'approved', confidence: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // The orphan visual this fix targets: approved + null confidence
    // previously showed the bare word "confidence" with no percentage.
    // Suppression is status-agnostic — it keys off confidence alone.
    expect(
      screen.queryByTestId('mapping-drawer-header-confidence'),
    ).toBeNull()
  })

  it('dialog aria-labelledby points at the new header title element id', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    const ariaLabelledBy = drawer.getAttribute('aria-labelledby')
    expect(ariaLabelledBy).toBeTruthy()
    const title = screen.getByTestId('mapping-drawer-header-title')
    expect(title.id).toBe(ariaLabelledBy)
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

  it('no editing affordances render in the header (regression guard)', () => {
    // The retired affordances must not reappear: per-source pencils,
    // per-source removes, ⊕ Add source, target ✏ / ✕, status badge.
    render(
      <MappingDrawer
        row={mapped({
          sources: [source({ id: 'ms-a' }), source({ id: 'ms-b' })],
        })}
        isOpen={true}
        onClose={vi.fn()}
        onSwapSource={vi.fn()}
        onSwapTarget={vi.fn()}
        onEditSources={vi.fn()}
        onUnmapMapping={vi.fn()}
        onCreateMapping={vi.fn()}
        onNavigateTarget={vi.fn()}
      />,
    )
    const header = screen.getByTestId('mapping-drawer-header')
    // No per-source pencils / removes anywhere in the header.
    expect(
      within(header).queryByLabelText(/edit source/i),
    ).toBeNull()
    expect(
      within(header).queryByLabelText(/remove source/i),
    ).toBeNull()
    // No add-source button.
    expect(
      within(header).queryByLabelText(/add source/i),
    ).toBeNull()
    // No target pencil or target ✕.
    expect(
      within(header).queryByLabelText(/edit target/i),
    ).toBeNull()
    expect(
      within(header).queryByLabelText(/unmap target/i),
    ).toBeNull()
    // No legacy status badge testid.
    expect(
      within(header).queryByTestId('mapping-drawer-header-status-badge'),
    ).toBeNull()
  })
})


// ─── PR 2 TASK 1.6 — UnmappedBody rejected-state banner ───────────────────

describe('MappingDrawer — PR 2 TASK 1.6 rejected-state banner', () => {
  it('renders the rejected banner when an unmapped row has status="rejected"', () => {
    render(
      <MappingDrawer
        row={unmapped({ status: 'rejected' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const banner = screen.getByTestId('drawer-unmapped-rejected-banner')
    expect(banner.textContent).toContain('This target field was unmapped.')
    expect(banner.textContent).toContain(
      'Click FROM above to assign a new source.',
    )
  })

  it('does NOT render the banner for non-rejected unmapped rows', () => {
    for (const status of ['needs_review', 'approved', 'unmapped'] as const) {
      const { unmount } = render(
        <MappingDrawer
          row={unmapped({ status })}
          isOpen={true}
          onClose={() => {}}
        />,
      )
      expect(
        screen.queryByTestId('drawer-unmapped-rejected-banner'),
      ).toBeNull()
      unmount()
    }
  })

  it('banner renders ABOVE the TARGET FIELD section in DOM order (PR 3b)', () => {
    // PR 3b: UnmappedBody body order is
    //   [rejected banner] → TARGET FIELD → [TRANSFORMATION] →
    //   [EXPLANATION] → DECISIONS
    // The legacy SOURCE section (which the pre-PR-3b test referenced)
    // is retired. Banner-above-target-field is the new DOM-order
    // invariant.
    render(
      <MappingDrawer
        row={unmapped({ status: 'rejected' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const banner = screen.getByTestId('drawer-unmapped-rejected-banner')
    const targetFieldSection = screen.getByTestId(
      'drawer-section-target-field',
    )
    expect(banner.compareDocumentPosition(targetFieldSection) & 4).toBe(4)
  })
})

// ─── PR 2 TASK 2+3 — source ✏ on every variant + target ✕ + ⊕ Add source ──
//
// Completes the editing surface on the header:
//   • Source ✏ on VA → editMappingSources (convert to mapped)
//   • Source ✏ on unmapped/rejected → createMappingFromUnmapped
//   • Target ✏ on unmapped/rejected → onNavigateTarget (client-only)
//   • Target ✕ on mapped + VA → onUnmapMapping (same handler as
//     single-source ✕)
//   • ⊕ Add source button on mapped variants only

describe('MappingDrawer — mapped-row body shape + footer', () => {
  it('mapped row Mapping tab renders the new two-column grid + WHY + SAMPLES + Remove link (feat/mapping-drawer-redesign)', () => {
    // feat/mapping-drawer-redesign — Mapping-tab body retires
    // SOURCE FIELDS + TARGET FIELD per-row sections in favor of a
    // two-column SOURCE/TARGET grid + WHY THIS MAPPING + SAMPLE SOURCE
    // VALUES + Remove mapping link. PR 3b testids
    // (drawer-section-source-fields / drawer-section-target-field) are
    // retired.
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: 'some reasoning' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('drawer-section-mapping-grid'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('drawer-section-why-this-mapping'),
    ).toBeInTheDocument()
    // Sample values render only when the primary source has samples;
    // the default `mapped()` fixture leaves them empty, so the section
    // is intentionally absent.
    expect(
      screen.queryByTestId('drawer-section-sample-source-values'),
    ).toBeNull()
    expect(
      screen.getByTestId('drawer-remove-mapping-link'),
    ).toBeInTheDocument()
    // Retired PR 3b sections.
    expect(
      screen.queryByTestId('drawer-section-source-fields'),
    ).toBeNull()
    expect(
      screen.queryByTestId('drawer-section-target-field'),
    ).toBeNull()
    // Legacy section testids stay retired.
    expect(screen.queryByTestId('drawer-section-source')).toBeNull()
    expect(screen.queryByTestId('drawer-section-sample-values')).toBeNull()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
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

  it('renders Reject button + (for needs_review) Approve button in the footer', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
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

  it('aria-labelledby points at the header title element', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    const ariaLabelledBy = drawer.getAttribute('aria-labelledby')
    expect(ariaLabelledBy).toBeTruthy()
    const title = screen.getByTestId('mapping-drawer-header-title')
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

// ─── Phase 3 Gap 10 — focus restore polish ──────────────────────────────────
//
// On drawer close, focus should restore to a sensible element so the user
// can continue keyboard navigation. Two edge cases require a fallback:
//
//   1. URL deep-link open (`?drawer=<rowId>` on initial mount). At capture
//      time `document.activeElement` is `<body>`. Without a fallback,
//      focus restore would silently do nothing (focusing `<body>` is a
//      no-op in jsdom and most browsers).
//
//   2. Post-Reject DOM rebuild. After a successful Reject the parent
//      calls `router.refresh()`, which can replace the original row body
//      element while the drawer is still mounted. By the time the cleanup
//      runs the captured trigger is detached (`isConnected === false`).
//      Focusing a detached element is a silent no-op.
//
// In both cases we fall back to the first `[data-testid="field-mapping-
// row-body"]` still in the DOM (rows are role=button + tabIndex=0).
//
// Microtask gymnastics: focus restoration is queued via `queueMicrotask`
// so React's commit phase tears down the drawer subtree first. Tests
// `await Promise.resolve()` before asserting on `document.activeElement`.

describe('MappingDrawer — Gap 10 focus restore polish', () => {
  it('URL deep-link case: trigger is <body>, focus falls back to first row body', async () => {
    // Render the drawer open with row bodies as siblings. Because nothing
    // was focused at mount time (jsdom default is `<body>`), the open-
    // effect captures `<body>` as the trigger — the URL deep-link scenario.
    const { rerender } = render(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-a" />
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-b" />
        <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />
      </div>,
    )
    expect(document.activeElement).toBe(document.body)

    rerender(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-a" />
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-b" />
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    // Flush the queueMicrotask deferring focus restore.
    await Promise.resolve()
    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement?.id).toBe('row-a')
  })

  it('post-Reject detached-node case: trigger is removed from DOM, focus falls back to first row body', async () => {
    // Step 1: render with drawer closed so the open-effect doesn't capture
    // anything yet.
    const { rerender, container } = render(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="trigger-row" />
        <div data-testid="field-mapping-row-body" tabIndex={0} id="other-row" />
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    // Step 2: focus the trigger row (simulating the user clicking it).
    container.querySelector<HTMLElement>('#trigger-row')!.focus()
    expect(document.activeElement?.id).toBe('trigger-row')

    // Step 3: open the drawer. The open-effect captures the focused
    // trigger row as `triggerRef`.
    rerender(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="trigger-row" />
        <div data-testid="field-mapping-row-body" tabIndex={0} id="other-row" />
        <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />
      </div>,
    )

    // Step 4: detach the trigger from the DOM (simulating the post-Reject
    // `router.refresh()` rebuilding the row tree) AND close the drawer.
    rerender(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="other-row" />
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    await Promise.resolve()

    // Trigger is gone; fallback should land on the remaining row body.
    expect(document.activeElement?.id).toBe('other-row')
  })

  it('happy path: connected non-body trigger receives focus on close', async () => {
    const { rerender, container } = render(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-a" />
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    const rowA = container.querySelector<HTMLElement>('#row-a')!
    rowA.focus()
    expect(document.activeElement).toBe(rowA)

    rerender(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-a" />
        <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />
      </div>,
    )
    rerender(
      <div>
        <div data-testid="field-mapping-row-body" tabIndex={0} id="row-a" />
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    await Promise.resolve()
    expect(document.activeElement?.id).toBe('row-a')
  })

  it('no fallback available (zero rows in DOM) leaves focus alone — does not throw', async () => {
    const { rerender } = render(
      <div>
        <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />
      </div>,
    )
    rerender(
      <div>
        <MappingDrawer row={mapped()} isOpen={false} onClose={() => {}} />
      </div>,
    )
    // Does not throw; focus stays on body (the jsdom default).
    await Promise.resolve()
    expect(document.activeElement).toBe(document.body)
  })
})

// ─── Width invariant ───────────────────────────────────────────────────────
//
// Phase 3 Gap 11a (2026-04-25) — drawer width changed from 520 → 480 as
// part of the always-overlay refactor. The exported constant and the
// inline `style.width` must agree, and both must equal 480.
describe('MappingDrawer — width', () => {
  it('inline width matches the exported MAPPING_DRAWER_WIDTH_PX (480)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const drawer = screen.getByTestId('mapping-drawer')
    expect(drawer.style.width).toBe('480px')
  })

  it('exports MAPPING_DRAWER_WIDTH_PX === 480', () => {
    expect(MAPPING_DRAWER_WIDTH_PX).toBe(480)
  })
})

// ─── Click-outside guard: sidebar coexistence (Gap 11a) ────────────────────
//
// The drawer's document-level mousedown handler closes the drawer on
// any click outside the drawer DOM. Two narrow exceptions exist:
//   1. Clicks on a `[data-testid="field-mapping-row-body"]` (so
//      clicking another row swaps the drawer's row).
//   2. Clicks on a `[data-testid="source-schema-sidebar"]` (so the
//      drawer + sidebar can coexist above 1024px without the sidebar
//      dismissing the drawer when the user toggles it).
//
// This suite regression-guards exception 2.
describe('MappingDrawer — click-outside guard for sidebar (Gap 11a)', () => {
  it('does not close the drawer when mousedown lands inside source-schema-sidebar', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="source-schema-sidebar">
          <button data-testid="sidebar-rail-button">rail</button>
        </div>
        <MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('sidebar-rail-button'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on mousedown landing outside both drawer and sidebar', () => {
    const onClose = vi.fn()
    render(
      <div>
        <div data-testid="source-schema-sidebar">sidebar</div>
        <div data-testid="random-content">unrelated</div>
        <MappingDrawer row={mapped()} isOpen={true} onClose={onClose} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('random-content'))
    expect(onClose).toHaveBeenCalledTimes(1)
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
    { name: 'coverage_approved_no_source', row: () => targetAck() },
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

// INF-57 cleanup (2026-05-10) dropped the entire "Rule 5 — Target
// Acknowledged body" describe block. Coverage-approved no-source rows
// (formerly target_acknowledged) now render UnmappedBody, so the Rule 6
// describe below covers them. The dropped tests asserted on
// AcknowledgedBody-specific testids (`drawer-section-acknowledgment`,
// `drawer-acknowledgment-reason`) and the OVERVIEW-vs-ANALYSIS section
// taxonomy that no longer applies under the unified body.

// ─── Rule 6 — Unmapped body (PR 3b body redesign) ──────────────────────────
//
// PR 3b: UnmappedBody body sequence is
//   [rejected banner if status=rejected] → TARGET FIELD → COVERAGE → DECISIONS
// The legacy `<DrawerSection title="Source">` (empty-state + body
// Edit-pencil that mounted CreateMappingForm) is retired. The header
// FROM stack's source ✏ is the entry point for creating a mapping.

describe('MappingDrawer — Rule 6 (Unmapped) body', () => {
  it('does NOT render the legacy body SOURCE section (retired in PR 3b)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-source')).toBeNull()
    expect(screen.queryByTestId('drawer-unmapped-empty-state')).toBeNull()
  })

  it('renders the new TARGET FIELD section', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
  })

  it('does NOT render a Status section (unmapped state is implicit)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-mapping-status')).toBeNull()
  })

  it('does NOT render a body Edit pencil (retired with body SOURCE section)', () => {
    // PR 3b: the body Edit pencil (EditPencilButton) that mounted the
    // legacy CreateMappingForm is gone. The header FROM stack's
    // source ✏ now handles source-creation entry. The form file
    // remains until commit 3 but is unreachable from the body UI.
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('mapping-drawer-edit-pencil')).toBeNull()
  })

  it('does NOT render an AI Reasoning or Transformation section', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-section-transformation')).toBeNull()
  })
})

// ─── VA — Value Assignment body (drawer redesign) ──────────────────────────
//
// Drawer redesign:
//   • Sources section renders an explanatory empty-state (VAs intentionally
//     have no sources).
//   • AI Reasoning is the standard collapsible disclosure (Q11.B/Q11.C).
//   • The legacy "Transformation" section is renamed `Value expression` and
//     shows the `combinationSql` block verbatim.
//   • Confidence + Status moved to the header line 2 dot/percent.

// ─── feat/mapping-row-uniformity — source-side drawer mount ───────────────

describe('MappingDrawer — source-field-only drawer (feat/unmapped-source-drawer-parity)', () => {
  // The drawer mounts SourceFieldDrawerStub when
  // `row.kind === 'source-field-only'`. feat/unmapped-source-drawer-parity
  // restructured it from a minimal stub into a full parity drawer:
  // compact header (MAPPING label · source title · confidence line),
  // Mapping / Transform tabs, and SOURCE / TARGET / EXPLANATION sections.

  function makeOrphanSourceField(
    overrides: Partial<SourceFieldWithState> = {},
  ): SourceFieldWithState {
    return {
      id: 'sf-bom',
      name: 'BOM_QUANTITY',
      dataType: 'NUMBER',
      ordinalPosition: 1,
      sourceTable: { id: 'st-bom', name: 'BOM_MASTERS' },
      mappingStatus: 'unmapped',
      sampleValues: ['12.5', '7.0', '3.25'],
      isAcknowledged: false,
      isRejected: false,
      aiReasoning: null,
      confidence: null,
      ...overrides,
    }
  }

  function sourceRow(
    sf: SourceFieldWithState = makeOrphanSourceField(),
    acknowledgmentReason: string | null = null,
  ) {
    return {
      kind: 'source-field-only' as const,
      id: 'unmapped-source::sf-bom',
      sourceField: sf,
      acknowledgmentReason,
    }
  }

  function renderSourceDrawer(
    row = sourceRow(),
    extraProps: Record<string, unknown> = {},
  ) {
    return render(
      <MappingDrawer
        row={row}
        isOpen={true}
        onClose={() => {}}
        {...extraProps}
      />,
    )
  }

  it('renders the compact header — MAPPING label, source title (table · field)', () => {
    renderSourceDrawer()
    const drawer = screen.getByTestId('mapping-drawer')
    expect(drawer.getAttribute('data-drawer-kind')).toBe('source-field-only')
    expect(
      screen.getByTestId('mapping-drawer-source-stub-label').textContent,
    ).toBe('Mapping')
    expect(
      screen.getByTestId('mapping-drawer-source-stub-table').textContent,
    ).toBe('BOM_MASTERS')
    expect(
      screen.getByTestId('mapping-drawer-source-stub-field').textContent,
    ).toBe('BOM_QUANTITY')
  })

  it('renders a confidence line — "{pct}% needs review" when confidence is set', () => {
    renderSourceDrawer(sourceRow(makeOrphanSourceField({ confidence: 80 })))
    const conf = screen.getByTestId('mapping-drawer-source-stub-confidence')
    expect(conf.getAttribute('data-status')).toBe('needs_review')
    expect(conf.textContent).toContain('80%')
    expect(conf.textContent).toContain('needs review')
  })

  it('renders the confidence line without a pct when confidence is null', () => {
    renderSourceDrawer(sourceRow(makeOrphanSourceField({ confidence: null })))
    const conf = screen.getByTestId(
      'mapping-drawer-source-stub-confidence-text',
    )
    expect(conf.textContent).toContain('needs review')
    expect(conf.textContent).not.toMatch(/\d/)
  })

  it('renders the Mapping / Transform tab strip', () => {
    renderSourceDrawer()
    expect(screen.getByTestId('drawer-tab-strip')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-tab-mapping')).toBeInTheDocument()
    expect(screen.getByTestId('drawer-tab-transform')).toBeInTheDocument()
  })

  it('renders the SOURCE section with field identity (name · table · type)', () => {
    renderSourceDrawer()
    expect(
      screen.getByTestId('drawer-section-source-stub-field'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('drawer-source-stub-field-name').textContent,
    ).toBe('BOM_QUANTITY')
    expect(
      screen.getByTestId('drawer-source-stub-field-table').textContent,
    ).toBe('BOM_MASTERS')
    expect(
      screen.getByTestId('drawer-source-stub-field-type').textContent,
    ).toBe('NUMBER')
  })

  it('renders collapsible sample values inside the SOURCE section', () => {
    renderSourceDrawer()
    // Collapsed by default — expand via the toggle.
    fireEvent.click(
      screen.getByTestId('drawer-source-stub-field-samples-toggle'),
    )
    const rows = screen.getAllByTestId('drawer-source-stub-field-sample-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('12.5')
  })

  it('caps sample values at 5 even when more are present on the wire', () => {
    renderSourceDrawer(
      sourceRow(
        makeOrphanSourceField({
          sampleValues: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        }),
      ),
    )
    fireEvent.click(
      screen.getByTestId('drawer-source-stub-field-samples-toggle'),
    )
    expect(
      screen.getAllByTestId('drawer-source-stub-field-sample-row'),
    ).toHaveLength(5)
  })

  it('shows the no-samples state when sampleValues is empty', () => {
    renderSourceDrawer(
      sourceRow(makeOrphanSourceField({ sampleValues: [] })),
    )
    expect(
      screen.getByTestId('drawer-source-stub-field-no-samples'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('drawer-source-stub-field-samples-toggle'),
    ).toBeNull()
  })

  it('renders the TARGET section with "Pick a target…" when promotion is wired', () => {
    renderSourceDrawer(sourceRow(), {
      onPromoteSource: vi.fn().mockResolvedValue({ success: true }),
      availableTargetFields: [targetField()],
    })
    expect(
      screen.getByTestId('drawer-section-source-stub-target'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('drawer-source-stub-pick-target'),
    ).toBeInTheDocument()
  })

  it('renders a "No target picked yet" placeholder when promotion is not wired', () => {
    renderSourceDrawer()
    expect(
      screen.queryByTestId('drawer-source-stub-pick-target'),
    ).toBeNull()
    expect(
      screen.getByTestId('drawer-source-stub-target-empty'),
    ).toBeInTheDocument()
  })

  it('renders the EXPLANATION section with the source field aiReasoning', () => {
    renderSourceDrawer(
      sourceRow(
        makeOrphanSourceField({
          aiReasoning:
            'Field type: NUMBER quantity.\n\nLeave as NO INVENTORY when blank.',
        }),
      ),
    )
    expect(
      screen.getByTestId('drawer-section-source-explanation'),
    ).toBeInTheDocument()
    // Same reasoning-prose treatment as WHY THIS MAPPING — paragraphs +
    // inline code chips.
    expect(
      screen.getAllByTestId('drawer-source-explanation-paragraph'),
    ).toHaveLength(2)
    expect(
      screen
        .getAllByTestId('drawer-source-explanation-code')
        .map((c) => c.textContent),
    ).toContain('NO INVENTORY')
  })

  it('omits the EXPLANATION section when aiReasoning is null', () => {
    renderSourceDrawer()
    expect(
      screen.queryByTestId('drawer-section-source-explanation'),
    ).toBeNull()
  })

  it('renders the acknowledgment reason when the row carries one', () => {
    renderSourceDrawer(
      sourceRow(makeOrphanSourceField(), 'Legacy column — not in scope'),
    )
    expect(
      screen.getByTestId('drawer-source-stub-ack-reason-text').textContent,
    ).toBe('Legacy column — not in scope')
  })

  it('shows the Transform tab placeholder (no target picked yet)', () => {
    renderSourceDrawer()
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(
      screen.getByTestId('drawer-source-stub-transform-empty'),
    ).toBeInTheDocument()
    // The Mapping-tab SOURCE section is not rendered on the Transform tab.
    expect(
      screen.queryByTestId('drawer-section-source-stub-field'),
    ).toBeNull()
  })

  it('exposes a close button + dialog a11y attributes (aria-labelledby → title)', () => {
    renderSourceDrawer()
    const drawer = screen.getByTestId('mapping-drawer')
    const ariaLabelledBy = drawer.getAttribute('aria-labelledby')
    expect(ariaLabelledBy).toBeTruthy()
    expect(
      screen.getByTestId('mapping-drawer-source-stub-title').id,
    ).toBe(ariaLabelledBy)
    expect(
      screen.getByTestId('mapping-drawer-close').getAttribute('aria-label'),
    ).toBe('Close drawer')
  })

  it('renders em-dash in the field chip when sourceField.name is the empty string', () => {
    renderSourceDrawer(sourceRow(makeOrphanSourceField({ name: '' })))
    expect(
      screen.getByTestId('mapping-drawer-source-stub-field').textContent,
    ).toBe('—')
  })

  it('keeps its own stub header (not the mainline DrawerHeader)', () => {
    // The source-field drawer keeps its own compact header
    // (`mapping-drawer-source-stub-header`), not the mainline
    // `DrawerHeader`.
    renderSourceDrawer(sourceRow(), {
      onSwapTarget: vi.fn(),
      onCreateMapping: vi.fn(),
    })
    expect(screen.queryByTestId('mapping-drawer-header')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-source-stub-header'),
    ).toBeInTheDocument()
  })

  // ── Footer (feat/source-drawer-footer) ──────────────────────────────
  //
  // The source-field drawer carries an Approve footer. needs_review →
  // [Approve]; an acknowledged source → [Un-approve] only. The buttons
  // reuse the presentational `UnmappedFooterButtons`, so the test-ids
  // match the unmapped-target footer.
  //
  // feat/reject-to-unmap: the footer no longer carries a Reject button.
  // On an unmapped-source row "reject" was a non-destructive no-op, so
  // the unmapped footer is Approve / Un-approve only — the destructive
  // Unmap action exists only on mapped/VA rows.

  it('renders the footer with Approve only (no Reject) in needs_review state', () => {
    renderSourceDrawer(sourceRow(), { projectId: 'proj-1' })
    expect(
      screen.getByTestId('mapping-drawer-source-stub-footer'),
    ).toBeInTheDocument()
    // feat/reject-to-unmap — no Reject button on an unmapped-source row.
    expect(
      screen.queryByTestId('mapping-drawer-reject-button'),
    ).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-unapprove-button'),
    ).toBeNull()
  })

  it('renders Un-approve only (no Reject) when the source is acknowledged', () => {
    renderSourceDrawer(
      sourceRow(makeOrphanSourceField({ isAcknowledged: true })),
      { projectId: 'proj-1' },
    )
    expect(
      screen.getByTestId('mapping-drawer-unapprove-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-reject-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
  })

  it('Approve click invokes acknowledgeField for the source field', async () => {
    const onActionComplete = vi.fn()
    renderSourceDrawer(sourceRow(), {
      projectId: 'proj-1',
      onActionComplete,
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('mapping-drawer-approve-button'))
    })
    expect(acknowledgeFieldMock).toHaveBeenCalledWith(
      'proj-1',
      'sf-bom',
      'source',
      '',
    )
    expect(onActionComplete).toHaveBeenCalledWith(
      'approve',
      'unmapped-source::sf-bom',
    )
  })

  // feat/reject-to-unmap — the test "Reject click invokes
  // setUnmappedRowRejected for the source field" was REMOVED: the
  // source-field drawer footer no longer renders a Reject button, so
  // there is nothing to click. The `setUnmappedRowRejected` server
  // action is unchanged in the codebase; only this UI call site is
  // gone. The absence of the Reject button is asserted by "renders the
  // footer with Approve only (no Reject) in needs_review state" above.

  it('Un-approve click invokes removeAcknowledgment for the source field', async () => {
    const onActionComplete = vi.fn()
    renderSourceDrawer(
      sourceRow(makeOrphanSourceField({ isAcknowledged: true })),
      { projectId: 'proj-1', onActionComplete },
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('mapping-drawer-unapprove-button'))
    })
    expect(removeAcknowledgmentMock).toHaveBeenCalledWith('proj-1', 'sf-bom')
    expect(onActionComplete).toHaveBeenCalledWith(
      'reset',
      'unmapped-source::sf-bom',
    )
  })

  it('footer follows the row: flips to Un-approve when the row prop becomes acknowledged', () => {
    // Post-action continuity at the component level — after Approve, the
    // parent refreshes and re-points the drawer at the same row, now
    // carrying `isAcknowledged: true`. The footer re-derives its state.
    const { rerender } = renderSourceDrawer(sourceRow(), {
      projectId: 'proj-1',
    })
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeInTheDocument()
    rerender(
      <MappingDrawer
        row={sourceRow(makeOrphanSourceField({ isAcknowledged: true }))}
        isOpen={true}
        onClose={() => {}}
        projectId="proj-1"
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-unapprove-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
  })
})

describe('MappingDrawer — Value Assignment body', () => {
  it('does NOT render a SOURCE section (drawer redesign PR 1)', () => {
    // PR 1: the legacy empty-state "Value assignment — no sources"
    // SOURCE section is removed. The header's left-side italic
    // "Value assignment" label carries that signal now.
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('drawer-section-source')).toBeNull()
    expect(screen.queryByTestId('drawer-va-no-sources')).toBeNull()
  })

  it('renders the new TARGET FIELD section (PR 3b)', () => {
    // PR 3b: VAs now show a TARGET FIELD section between VALUE
    // EXPRESSION and ANALYSIS. The pre-PR-3b assertion that
    // `drawer-section-target-field` is null is reversed.
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    expect(
      screen.getByTestId('drawer-section-target-field'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
  })

  it('renders the Value expression section with combinationSql in a code block', () => {
    // feat/mapping-drawer-redesign — Value expression lives on the
    // Transform sub-tab for VAs (the Mapping tab now carries target
    // identity + analysis only). Switch tabs before asserting.
    render(
      <MappingDrawer
        row={valueAssignment({ combinationSql: 'NOW()' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
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
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
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
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(screen.queryByTestId('drawer-value-expression')).toBeNull()
    expect(
      screen.getByTestId('drawer-value-expression-empty'),
    ).toBeInTheDocument()
  })

  it('Analysis section is omitted entirely when aiReasoning is null (drawer redesign §4)', () => {
    // Drawer redesign refinements §4: VAs have no source dataType to
    // compare, so type compat is not part of ANALYSIS for VAs. When
    // aiReasoning is also null, ANALYSIS has no content to render
    // and is omitted entirely.
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-section-analysis')).toBeNull()
    expect(screen.queryByTestId('drawer-ai-reasoning-toggle')).toBeNull()
    // Legacy section name from the prior pass is gone.
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
  })

  it('AI reasoning toggle renders inside Analysis when aiReasoning is non-null + status=approved (collapsed by default)', () => {
    // Drawer redesign refinements §4: AI reasoning lives inside the
    // ANALYSIS section. Q11.B lock carries over — collapsed by
    // default for `approved`, expanded by default for `needs_review`.
    render(
      <MappingDrawer
        row={valueAssignment({
          aiReasoning: 'Default created_at uses NOW()',
          status: 'approved',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const analysis = screen.getByTestId('drawer-section-analysis')
    const toggle = within(analysis).getByTestId('drawer-ai-reasoning-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(analysis).queryByTestId('drawer-ai-reasoning')).toBeNull()
  })

  it('Analysis section for VA does NOT render type compatibility (no source dataType)', () => {
    // Drawer redesign refinements §4: VAs have no source dataType to
    // compare against, so type compat is intentionally skipped. When
    // ANALYSIS renders for a VA, it contains AI reasoning only.
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: 'reason' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const analysis = screen.getByTestId('drawer-section-analysis')
    expect(
      within(analysis).queryByTestId('drawer-analysis-type-compat'),
    ).toBeNull()
  })

  it('section partition for VA — Mapping tab: [Target field, Explanation]; Transform tab: [Value expression] (feat/mapping-drawer-redesign)', () => {
    // feat/mapping-drawer-redesign — sections partition across the two
    // sub-tabs. The Mapping tab carries target identity + analysis;
    // the Transform tab carries the VA's authored SQL (Value expression).
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: 'reason text' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')

    // Mapping tab (default).
    expect(
      within(body)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Target field', 'Explanation'])

    // Transform tab.
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(
      within(body)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(['Value expression'])
  })
})

// ─── PR 3b — body section ordering invariants ─────────────────────────────

describe('MappingDrawer — body section ordering (feat/mapping-drawer-redesign)', () => {
  it('mapped Mapping tab: MAPPING GRID is the first content section; WHY THIS MAPPING follows when aiReasoning is present', () => {
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: 'reason text' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sectionTestIds = Array.from(
      body.querySelectorAll('[data-testid^="drawer-section-"]'),
    ).map((el) => el.getAttribute('data-testid'))
    const idx = (id: string) => sectionTestIds.indexOf(id)
    expect(idx('drawer-section-mapping-grid')).toBeGreaterThanOrEqual(0)
    expect(idx('drawer-section-why-this-mapping')).toBeGreaterThan(
      idx('drawer-section-mapping-grid'),
    )
  })

  it('mapped section partition — Mapping tab: MAPPING GRID → WHY THIS MAPPING; Transform tab: TRANSFORMATION (feat/mapping-drawer-redesign)', () => {
    // feat/mapping-drawer-redesign — the Mapping-tab body retired the
    // PR 3b SOURCE FIELDS + TARGET FIELD + ANALYSIS sections in favor
    // of a two-column MAPPING GRID + WHY THIS MAPPING (full
    // aiReasoning) + SAMPLE SOURCE VALUES + Remove mapping link. The
    // Transform sub-tab still carries the single TRANSFORMATION
    // section.
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'reason',
          hasTransformation: true,
          transformationStatus: 'applied',
          transformationDescription: 'desc',
          transformationSqlPreview: 'SELECT 1',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sectionTestIdsOnTab = () =>
      Array.from(
        body.querySelectorAll('[data-testid^="drawer-section-"]'),
      ).map((el) => el.getAttribute('data-testid'))

    // Mapping tab (default).
    const mappingTab = sectionTestIdsOnTab()
    const idxMapping = (id: string) => mappingTab.indexOf(id)
    expect(idxMapping('drawer-section-mapping-grid')).toBeGreaterThanOrEqual(0)
    expect(idxMapping('drawer-section-mapping-grid')).toBeLessThan(
      idxMapping('drawer-section-why-this-mapping'),
    )
    // Transformation section is NOT on the Mapping tab.
    expect(mappingTab).not.toContain('drawer-section-transformation')
    // Retired PR 3b section testids stay retired on the Mapping tab.
    expect(mappingTab).not.toContain('drawer-section-source-fields')
    expect(mappingTab).not.toContain('drawer-section-target-field')
    expect(mappingTab).not.toContain('drawer-section-analysis')

    // Transform tab.
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    const transformTab = sectionTestIdsOnTab()
    expect(transformTab).toContain('drawer-section-transformation')
    expect(transformTab).not.toContain('drawer-section-mapping-grid')
    expect(transformTab).not.toContain('drawer-section-why-this-mapping')
  })

  it('VA section partition — Mapping tab: TARGET FIELD → ANALYSIS; Transform tab: VALUE EXPRESSION (feat/mapping-drawer-redesign)', () => {
    // feat/mapping-drawer-redesign — VA's authored SQL lives on the
    // Transform tab (VAs author transform-side prose via the
    // combinationSql field rather than the standalone Transform page).
    // The Mapping tab keeps target identity + analysis.
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: 'reason' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sectionTestIdsOnTab = () =>
      Array.from(
        body.querySelectorAll('[data-testid^="drawer-section-"]'),
      ).map((el) => el.getAttribute('data-testid'))

    // Mapping tab (default).
    const mappingTab = sectionTestIdsOnTab()
    const idxMapping = (id: string) => mappingTab.indexOf(id)
    expect(idxMapping('drawer-section-target-field')).toBeGreaterThanOrEqual(0)
    expect(idxMapping('drawer-section-target-field')).toBeLessThan(
      idxMapping('drawer-section-analysis'),
    )
    expect(mappingTab).not.toContain('drawer-section-value-expression')

    // Transform tab.
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    const transformTab = sectionTestIdsOnTab()
    expect(transformTab).toContain('drawer-section-value-expression')
    expect(transformTab).not.toContain('drawer-section-target-field')
    expect(transformTab).not.toContain('drawer-section-analysis')
  })

  it('unmapped does not render the retired COVERAGE section', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-coverage')).toBeNull()
  })
})

// ─── feat/mapping-drawer-redesign — Mapping-tab redesigned sections ────────

describe('MappingDrawer — Mapping-tab MAPPING GRID (feat/mapping-drawer-redesign)', () => {
  it('renders SOURCE column + TARGET column with table name, field chip, and data type for each side (single-source mapped row)', () => {
    // Fixture defaults: source = ACCT_NO in ACCT_MASTER (NUMBER);
    // target = customer_id in accounts (VARCHAR(200)).
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const grid = screen.getByTestId('drawer-section-mapping-grid')
    const sourceCol = within(grid).getByTestId('drawer-mapping-source-col')
    const targetCol = within(grid).getByTestId('drawer-mapping-target-col')

    // SOURCE block — exactly one (single-source row).
    expect(
      within(sourceCol).getAllByTestId('drawer-mapping-source-block'),
    ).toHaveLength(1)
    expect(
      within(sourceCol).getByTestId('drawer-mapping-source-table').textContent,
    ).toBe('ACCT_MASTER')
    expect(
      within(sourceCol).getByTestId('drawer-mapping-source-field').textContent,
    ).toBe('ACCT_NO')
    expect(
      within(sourceCol).getByTestId('drawer-mapping-source-type').textContent,
    ).toBe('NUMBER')

    // TARGET block.
    expect(
      within(targetCol).getByTestId('drawer-mapping-target-table').textContent,
    ).toBe('accounts')
    expect(
      within(targetCol).getByTestId('drawer-mapping-target-field').textContent,
    ).toBe('customer_id')
    expect(
      within(targetCol).getByTestId('drawer-mapping-target-type').textContent,
    ).toBe('VARCHAR(200)')
  })

  it('stacks one SOURCE block per source for a multi-source mapped row (primary first by ordinal)', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              id: 'ms-a',
              ordinal: 0,
              sourceField: {
                id: 'sf-a',
                name: 'field_a',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-a', name: 'TBL_A' },
            }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'field_b',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const sourceCol = screen.getByTestId('drawer-mapping-source-col')
    const blocks = within(sourceCol).getAllByTestId('drawer-mapping-source-block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.getAttribute('data-mapping-source-id')).toBe('ms-a')
    expect(blocks[1]!.getAttribute('data-mapping-source-id')).toBe('ms-b')
  })
})

// ─── feat/mapping-drawer-header-redesign — body SOURCE column editing ─────

describe('MappingDrawer — body SOURCE column editing affordances (feat/mapping-drawer-header-redesign)', () => {
  // Editing affordances (pencil / ✕ / + Add source) render only when
  // the parent threads `onSwapSource` + `onEditSources` +
  // `availableSourceFields`. Test mounts that omit them get the
  // static identity view (regression-guard for that case lives below).

  function makeAvailable(): SourceFieldWithState[] {
    return [
      {
        id: 'sf-1',
        name: 'ACCT_NO',
        dataType: 'NUMBER',
        ordinalPosition: 0,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'unmapped',
        sampleValues: [],
        isAcknowledged: false,
        isRejected: false,
        aiReasoning: null,
        confidence: null,
      },
      {
        id: 'sf-2',
        name: 'CIF_NO',
        dataType: 'NUMBER',
        ordinalPosition: 1,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'unmapped',
        sampleValues: [],
        isAcknowledged: false,
        isRejected: false,
        aiReasoning: null,
        confidence: null,
      },
      {
        id: 'sf-new',
        name: 'NEW_COL',
        dataType: 'TEXT',
        ordinalPosition: 2,
        sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
        mappingStatus: 'unmapped',
        sampleValues: [],
        isAcknowledged: false,
        isRejected: false,
        aiReasoning: null,
        confidence: null,
      },
    ]
  }

  it('renders pencil + Add source on a single-source mapped row; NO remove ✕ when sources.length === 1', () => {
    const onSwapSource = vi.fn().mockResolvedValue({ success: true })
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={onSwapSource}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    const sourceCol = screen.getByTestId('drawer-mapping-source-col')
    expect(
      within(sourceCol).getByTestId('drawer-mapping-source-edit'),
    ).toBeInTheDocument()
    // No remove on single-source.
    expect(
      within(sourceCol).queryByTestId('drawer-mapping-source-remove'),
    ).toBeNull()
    expect(screen.getByTestId('drawer-mapping-add-source')).toBeInTheDocument()
  })

  it('renders pencil + ✕ on each source block + Add source on a multi-source mapped row', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({ id: 'ms-a', ordinal: 0 }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'b_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={vi.fn()}
        availableSourceFields={makeAvailable()}
      />,
    )
    const blocks = screen.getAllByTestId('drawer-mapping-source-block')
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      expect(
        within(block).getByTestId('drawer-mapping-source-edit'),
      ).toBeInTheDocument()
      expect(
        within(block).getByTestId('drawer-mapping-source-remove'),
      ).toBeInTheDocument()
    }
    expect(screen.getByTestId('drawer-mapping-add-source')).toBeInTheDocument()
  })

  it('clicking pencil on single-source mapped opens InlineSourcePicker; commit calls onSwapSource(bareTfmId, newSourceFieldId)', async () => {
    const onSwapSource = vi.fn().mockResolvedValue({ success: true })
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={onSwapSource}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    await user.click(screen.getByTestId('drawer-mapping-source-edit'))
    // Picker portal renders.
    expect(
      screen.getByTestId('inline-source-picker'),
    ).toBeInTheDocument()
    // Click a different source field in the picker — single-mode autoCommit fires onCommit.
    const sf2Row = document.querySelector(
      '[data-source-field-id="sf-2"]',
    ) as HTMLElement
    await user.click(sf2Row)
    expect(onSwapSource).toHaveBeenCalledWith('tfm-1', 'sf-2')
    expect(onEditSources).not.toHaveBeenCalled()
  })

  it('clicking pencil on multi-source mapped opens picker; commit calls onSwapSource with shimmed `<tfmId>::<msId>`', async () => {
    const onSwapSource = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({ id: 'ms-a', ordinal: 0 }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'b_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={onSwapSource}
        onEditSources={vi.fn()}
        availableSourceFields={makeAvailable()}
      />,
    )
    // Click the pencil on the SECOND (non-primary) block.
    const blocks = screen.getAllByTestId('drawer-mapping-source-block')
    await user.click(
      within(blocks[1]!).getByTestId('drawer-mapping-source-edit'),
    )
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
    // Commit by clicking a different source field.
    await user.click(
      document.querySelector('[data-source-field-id="sf-2"]') as HTMLElement,
    )
    // Shimmed contributor id for the second source (ms-b).
    expect(onSwapSource).toHaveBeenCalledWith('tfm-1::ms-b', 'sf-2')
  })

  it('clicking ✕ on a multi-source row calls onEditSources with the source filtered out; combinationType preserved when ≥ 2 remain', async () => {
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          combinationType: 'concat_space',
          sources: [
            source({ id: 'ms-a', ordinal: 0 }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'b_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
            source({
              id: 'ms-c',
              ordinal: 2,
              sourceField: {
                id: 'sf-c',
                name: 'c_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-c', name: 'TBL_C' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    const blocks = screen.getAllByTestId('drawer-mapping-source-block')
    // Remove the middle source (ms-b / sf-b).
    await user.click(
      within(blocks[1]!).getByTestId('drawer-mapping-source-remove'),
    )
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-1', 'sf-c'],
      combinationType: 'concat_space',
    })
  })

  it('clicking ✕ on a 2-source row collapses combinationType to "single" when one source remains', async () => {
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          combinationType: 'concat_space',
          sources: [
            source({ id: 'ms-a', ordinal: 0 }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'b_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    const blocks = screen.getAllByTestId('drawer-mapping-source-block')
    await user.click(
      within(blocks[1]!).getByTestId('drawer-mapping-source-remove'),
    )
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-1'],
      combinationType: 'single',
    })
  })

  it('clicking + Add source opens picker; commit appends source to existing list and switches single → concat_space', async () => {
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({ combinationType: 'single' })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    await user.click(screen.getByTestId('drawer-mapping-add-source'))
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
    // Commit by picking the new field.
    await user.click(
      document.querySelector('[data-source-field-id="sf-new"]') as HTMLElement,
    )
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-1', 'sf-new'],
      combinationType: 'concat_space',
    })
  })

  it('Add source on an already-multi row preserves the existing combinationType', async () => {
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          combinationType: 'concat_comma',
          sources: [
            source({ id: 'ms-a', ordinal: 0 }),
            source({
              id: 'ms-b',
              ordinal: 1,
              sourceField: {
                id: 'sf-b',
                name: 'b_field',
                dataType: 'TEXT',
                isNullable: false,
              },
              sourceTable: { id: 'st-b', name: 'TBL_B' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={onEditSources}
        availableSourceFields={makeAvailable()}
      />,
    )
    await user.click(screen.getByTestId('drawer-mapping-add-source'))
    await user.click(
      document.querySelector('[data-source-field-id="sf-new"]') as HTMLElement,
    )
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-1', 'sf-b', 'sf-new'],
      combinationType: 'concat_comma',
    })
  })

  it('TARGET column stays read-only — no pencil or ✕ on the target block', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        onSwapSource={vi.fn()}
        onEditSources={vi.fn()}
        availableSourceFields={makeAvailable()}
      />,
    )
    const targetCol = screen.getByTestId('drawer-mapping-target-col')
    expect(
      within(targetCol).queryByTestId('drawer-mapping-target-edit'),
    ).toBeNull()
    expect(
      within(targetCol).queryByTestId('drawer-mapping-target-remove'),
    ).toBeNull()
  })

  it('no editing affordances render when handler props are absent (static identity display)', () => {
    // Test mount without commit handlers — the body grid degrades to
    // the static read-only display from PR #145.
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.queryByTestId('drawer-mapping-source-edit'),
    ).toBeNull()
    expect(
      screen.queryByTestId('drawer-mapping-source-remove'),
    ).toBeNull()
    expect(
      screen.queryByTestId('drawer-mapping-add-source'),
    ).toBeNull()
  })
})

describe('MappingDrawer — Mapping-tab WHY THIS MAPPING (feat/mapping-drawer-redesign)', () => {
  it('renders the full aiReasoning text in the WHY THIS MAPPING section', () => {
    const reasoning = 'Customer external id is the canonical CRM anchor.'
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: reasoning })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('drawer-section-why-this-mapping')
    expect(
      within(section).getByTestId('drawer-why-this-mapping-text').textContent,
    ).toBe(reasoning)
  })

  it('omits the WHY THIS MAPPING section entirely when aiReasoning is null or whitespace', () => {
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('drawer-section-why-this-mapping'),
    ).toBeNull()
  })

  // Refinement #5b — reasoning-text visual treatment.

  it('renders \\n\\n-separated reasoning as discrete paragraphs', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning:
            'Field type: VARCHAR(16) identifier.\n\nMaps the customer SKU narrative.',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const paragraphs = screen.getAllByTestId(
      'drawer-why-this-mapping-paragraph',
    )
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]!.textContent).toContain('Field type:')
    expect(paragraphs[1]!.textContent).toContain(
      'Maps the customer SKU narrative.',
    )
  })

  it('bolds the leading "Field type:" prefix for skimmability', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Field type: integer surrogate key.\n\nNarrative.',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const firstParagraph = screen.getAllByTestId(
      'drawer-why-this-mapping-paragraph',
    )[0]!
    const prefix = within(firstParagraph).getByText('Field type:')
    expect(prefix.className).toContain('font-semibold')
  })

  it('renders all-caps SQL phrases and keywords as inline code chips', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning:
            'Leave the field as NO INVENTORY when the source value is NULL.',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const chips = screen.getAllByTestId('drawer-why-this-mapping-code')
    const chipText = chips.map((c) => c.textContent)
    // Multi-word all-caps run + recognised single SQL keyword both promoted.
    expect(chipText).toContain('NO INVENTORY')
    expect(chipText).toContain('NULL')
    // Each chip carries the monospace + tinted-background styling.
    for (const chip of chips) {
      expect(chip.className).toContain('font-mono')
      expect(chip.className).toContain('bg-slate-100')
    }
  })

  it('leaves lone non-keyword abbreviations (RCB) as plain prose', () => {
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: 'This column does not apply to RCB.' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // RCB is all-caps but not a SQL keyword → not promoted to a chip.
    expect(
      screen.queryByTestId('drawer-why-this-mapping-code'),
    ).toBeNull()
    expect(
      screen.getByTestId('drawer-why-this-mapping-text').textContent,
    ).toContain('RCB')
  })
})

describe('MappingDrawer — Transform tab "Transformation needed" indicator (Refinement #5b)', () => {
  it('renders a "Yes" indicator when transformationNeeded is true', () => {
    render(
      <MappingDrawer
        row={mapped({ transformationNeeded: true })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    const indicator = screen.getByTestId('drawer-transformation-needed')
    expect(indicator.getAttribute('data-needed')).toBe('yes')
    expect(indicator.textContent).toContain('Yes')
    // Section reads at full weight — no transformation is "not applied".
    expect(
      screen.getByTestId('drawer-transformation-body').className,
    ).not.toContain('opacity-60')
  })

  it('renders a "No" indicator and dims the section when transformationNeeded is false', () => {
    render(
      <MappingDrawer
        row={mapped({ transformationNeeded: false })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    const indicator = screen.getByTestId('drawer-transformation-needed')
    expect(indicator.getAttribute('data-needed')).toBe('no')
    expect(indicator.textContent).toContain('No')
    // Reduced visual weight — the recipe text still shows, dimmed.
    expect(
      screen.getByTestId('drawer-transformation-body').className,
    ).toContain('opacity-60')
  })

  it('renders no indicator when transformationNeeded is null', () => {
    render(
      <MappingDrawer
        row={mapped({ transformationNeeded: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(
      screen.queryByTestId('drawer-transformation-needed'),
    ).toBeNull()
  })

  it('renders no indicator when transformationNeeded is omitted (undefined)', () => {
    render(
      <MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />,
    )
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(
      screen.queryByTestId('drawer-transformation-needed'),
    ).toBeNull()
  })
})

describe('MappingDrawer — Mapping-tab SAMPLE SOURCE VALUES (feat/mapping-drawer-redesign)', () => {
  it('renders up to 5 rows of sample values with "row N" labels (1-indexed)', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              sampleValues: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'],
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('drawer-section-sample-source-values')
    const rows = within(section).getAllByTestId(
      'drawer-sample-source-values-row',
    )
    expect(rows).toHaveLength(5)
    // Each row: value on the left, "row N" label on the right.
    expect(rows[0]!.textContent).toContain('v1')
    expect(rows[0]!.textContent).toContain('row 1')
    expect(rows[4]!.textContent).toContain('v5')
    expect(rows[4]!.textContent).toContain('row 5')
  })

  it('omits the section when sampleValues is empty', () => {
    render(
      <MappingDrawer
        row={mapped({ sources: [source({ sampleValues: [] })] })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('drawer-section-sample-source-values'),
    ).toBeNull()
  })
})

describe('MappingDrawer — Mapping-tab Remove mapping link (feat/mapping-drawer-redesign)', () => {
  it('renders a red "Remove mapping" link at the bottom of the Mapping tab', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const link = screen.getByTestId('drawer-remove-mapping-link')
    expect(link.textContent).toBe('Remove mapping')
    expect(link.className).toContain('text-red-600')
  })

  it('clicking Remove mapping opens the existing RejectConfirmDialog (same flow as the footer reject button)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    // Dialog is closed at rest.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByTestId('drawer-remove-mapping-link'))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('Remove mapping link is NOT rendered on the Transform tab', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('drawer-tab-transform'))
    expect(screen.queryByTestId('drawer-remove-mapping-link')).toBeNull()
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
      // `joinAnnotation` per the canonical contract (see
      // `lib/actions/_mappings-for-redesign-core.ts::deriveJoinAnnotation`)
      // is already wrapped in `(join: …)`. Renderers must consume verbatim.
      joinAnnotation: '(join: PrimaryContactID)',
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
    source({ id: 'ms-r4-4', ordinal: 3, confidence: 75, sourceField: { id: 'sf-r4-4', name: 'F4', dataType: 'VARCHAR(50)', isNullable: true }, sourceTable: { id: 'st-b', name: 'TableB' }, joinAnnotation: '(join: JoinKey)' }),
    source({ id: 'ms-r4-5', ordinal: 4, confidence: 70, sourceField: { id: 'sf-r4-5', name: 'F5', dataType: 'VARCHAR(50)', isNullable: true }, sourceTable: { id: 'st-b', name: 'TableB' }, joinAnnotation: '(join: JoinKey)' }),
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

// ═══════════════════════════════════════════════════════════════════════════
// Gap 9 — Footer action buttons (Approve / Reject + confirmation + UX state)
// ═══════════════════════════════════════════════════════════════════════════
//
// The drawer's footer is now a stateful action surface. These tests cover:
//
//   • Disabled-state matrix per row.kind × row.status (the pinned
//     decisions act as regression guards):
//       - mapped/VA + needs_review: both enabled
//       - mapped/VA + approved:     Approve hidden, Reject enabled
//       - mapped/VA + rejected:     both enabled (legacy un-reject path)
//       - unmapped (status-driven, INF-57 cleanup):
//           needs_review → Suggest with AI / Create mapping
//           approved     → Un-approve (resetMappingStatus)
//           rejected     → Approve (re-approves coverage row)
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

const {
  approveFieldMappingMock,
  rejectFieldMappingMock,
  createFieldMappingMock,
  suggestMappingForTargetMock,
  setUnmappedRowRejectedMock,
  acknowledgeFieldMock,
  removeAcknowledgmentMock,
} = vi.hoisted(() => ({
  approveFieldMappingMock: vi.fn(),
  rejectFieldMappingMock: vi.fn(),
  createFieldMappingMock: vi.fn(),
  suggestMappingForTargetMock: vi.fn(),
  setUnmappedRowRejectedMock: vi.fn(),
  acknowledgeFieldMock: vi.fn(),
  removeAcknowledgmentMock: vi.fn(),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  approveFieldMapping: (...args: unknown[]) =>
    approveFieldMappingMock(...args),
  rejectFieldMapping: (...args: unknown[]) =>
    rejectFieldMappingMock(...args),
  createFieldMapping: (...args: unknown[]) =>
    createFieldMappingMock(...args),
  suggestMappingForTarget: (...args: unknown[]) =>
    suggestMappingForTargetMock(...args),
  setUnmappedRowRejected: (...args: unknown[]) =>
    setUnmappedRowRejectedMock(...args),
}))

vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: (...args: unknown[]) => acknowledgeFieldMock(...args),
  removeAcknowledgment: (...args: unknown[]) =>
    removeAcknowledgmentMock(...args),
}))

// Phase 4a-2 — `CreateMappingForm` calls `useRouter().refresh()` on
// successful save. The component-under-test renders the form when the
// user clicks [Create mapping] on an unmapped row, so router-mocking
// is now drawer-test-scoped (not just form-test-scoped).
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
    push: vi.fn(),
  }),
}))

beforeEach(() => {
  approveFieldMappingMock.mockReset()
  rejectFieldMappingMock.mockReset()
  createFieldMappingMock.mockReset()
  suggestMappingForTargetMock.mockReset()
  setUnmappedRowRejectedMock.mockReset()
  acknowledgeFieldMock.mockReset()
  removeAcknowledgmentMock.mockReset()
  setUnmappedRowRejectedMock.mockResolvedValue({ success: true, side: 'source' })
  acknowledgeFieldMock.mockResolvedValue(undefined)
  removeAcknowledgmentMock.mockResolvedValue(undefined)
})

describe('MappingDrawer Gap 9 — disabled-state matrix (drawer redesign)', () => {
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

  it('mapped row + status=approved: Approve is HIDDEN, Reject is enabled (Q11.A lock)', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'approved' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // Approve is no longer rendered-but-disabled; the redesign collapses
    // the approved-row footer to just `[Reject]`.
    expect(screen.queryByTestId('mapping-drawer-approve-button')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-reject-button'),
    ).not.toBeDisabled()
  })

  it('mapped row + status=rejected (legacy): BOTH buttons are enabled (un-reject path)', () => {
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

  it('coverage-approved no-source row: footer renders only the Un-approve control', () => {
    render(
      <MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-unapprove-button'),
    ).toBeInTheDocument()
  })

  it('unmapped row + status=needs_review: footer renders approve only (feat/reject-to-unmap)', () => {
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-needs-review-1', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('mapping-drawer-footer')).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeNull()
    expect(screen.getByTestId('mapping-drawer-approve-button')).toBeInTheDocument()
    // feat/reject-to-unmap — unmapped rows have no Unmap (reject) button.
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
  })

  // ── INF-57 cleanup — status-driven UnmappedFooterButtons (Option B) ────────
  //
  // Locked design decision 4: when an unmapped row's drawer is open, the
  // footer dispatches by row.status (inside UnmappedFooterButtons):
  //   needs_review / unmapped → [Approve]
  //   approved                → [Un-approve] (calls resetMappingStatus)
  //   rejected                → [Approve] (re-approves coverage row)
  //
  // feat/reject-to-unmap — none of these expose a Reject/Unmap button.
  // On an unmapped row "reject" was a non-destructive no-op; the
  // destructive Unmap action lives only on mapped/VA rows.

  it('unmapped + status=approved: footer renders only the Un-approve control', () => {
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-cov-1', status: 'approved' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('mapping-drawer-approve-button')).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-unapprove-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
  })

  it('unmapped + status=rejected: footer renders ONLY [Approve] (re-approve coverage row)', () => {
    // The status='rejected' branch surfaces the standard approve flow
    // alone — clicking it routes through approveFieldMapping (the same
    // wrapper mapped/VA rejected rows use to un-reject). feat/reject-to-
    // unmap — there is no Unmap (reject) button on an unmapped row.
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-cov-2', status: 'rejected' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-approve-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
  })

  it('unmapped + status=needs_review: footer exposes approve only (feat/reject-to-unmap)', () => {
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-cov-3', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
    expect(screen.getByTestId('mapping-drawer-approve-button')).toBeInTheDocument()
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
    // Pre-click sanity: header confidence line reflects Needs Review.
    expect(
      screen.getByTestId('mapping-drawer-header-confidence').getAttribute('data-status'),
    ).toBe('needs_review')
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    // While the promise is pending the optimistic overlay flips the
    // header confidence line's status to Approved.
    expect(
      screen.getByTestId('mapping-drawer-header-confidence').getAttribute('data-status'),
    ).toBe('approved')
    // The post-optimistic state is `mapped/approved` → footer collapses
    // to `[Reject]` only (Q11.A lock), so the Approve button is no
    // longer rendered.
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
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
    // Header confidence line reverted to Needs Review.
    expect(
      screen.getByTestId('mapping-drawer-header-confidence').getAttribute('data-status'),
    ).toBe('needs_review')
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
    expect(dialog.textContent).toContain('Unmap this mapping?')
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
    expect(banner.textContent).toContain("Couldn't unmap this mapping")
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — manual mapping creation (W1) drawer integration.
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers the drawer-side contract introduced by Phase 4a-2:
//   • Footer mode-switching (inactive → [Create mapping]; active →
//     [Cancel] [Save mapping]).
//   • Body morph (Mapping-status prose → CreateMappingForm).
//   • Imperative form-handle wiring (Save click → triggerSave; Cancel
//     click → requestClose).
//   • Close-with-confirm intercepts on Esc / X / click-outside / Cancel
//     when the form is dirty.
//   • Discard-dialog Esc/click guards (the dialog-only Esc per
//     founder decision §1-OQ-1, mousedown inside the dialog does NOT
//     close the drawer beneath it).
//   • Row-switch is silent — no discard prompt (founder decision
//     §8-OQ-1).
//   • onSaveSuccess is fired with the wrapper's new TFM id and the
//     drawer body deactivates the form afterwards.

function makeSourceField(
  overrides: Partial<SourceFieldWithState> = {},
): SourceFieldWithState {
  return {
    id: 'sf-acc',
    name: 'ACCT_NO',
    dataType: 'NUMBER',
    ordinalPosition: 1,
    sourceTable: { id: 'st-acc', name: 'ACCT_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: ['1001', '1002', '1003'],
    isAcknowledged: false,
    isRejected: false,
    aiReasoning: null,
    confidence: null,
    ...overrides,
  }
}

const SOURCE_FIELDS_FIXTURE: SourceFieldWithState[] = [
  makeSourceField({ id: 'sf-acc-1', name: 'ACCT_NO', ordinalPosition: 1 }),
  makeSourceField({ id: 'sf-acc-2', name: 'ACCT_TYPE', ordinalPosition: 2 }),
]
