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

describe('MappingDrawer — header', () => {
  it('renders the target field name as the dialog-labelled title node', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.textContent).toBe('customer_id')
    // Drawer redesign — title is an inline span inside the compressed
    // 2-line header (Q11.J lock); accessible labelling is preserved
    // via the dialog's `aria-labelledby` attribute pointing at this
    // element's id.
    expect(title.tagName).toBe('SPAN')
    const dialog = screen.getByTestId('mapping-drawer')
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
  })

  it('target field name uses font-mono and font-normal (Refinement 4 — alignment with list view + source side)', () => {
    // Refinement 4 lock: drawer header source and target field rows
    // render identically — same font, same weight, same color. The
    // SOURCE / TARGET small-caps labels carry section emphasis on
    // their own; bolded field names duplicated that signal and broke
    // visual parity with the list view (where 4-polish-1 dropped
    // `font-semibold` from the target cell in the same pass).
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.className).toContain('font-mono')
    expect(title.className).toContain('font-normal')
    expect(title.className).not.toContain('font-semibold')
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

// ─── Header — PR 1 redesign (FROM/TO vertical stack) ──────────────────────
//
// Drawer redesign PR 1 (feat/drawer-header-rewrite): the header is a
// vertical FROM/TO stack so long field names render in full at the
// 480px drawer width. Layout:
//
//   FROM                                         ✕
//   [src_tbl] src_field ✏  (or "+N more" for multi)
//
//   TO
//   [tgt_tbl] tgt_field ✏
//                         ● Status · confidence
//
// Source-side renders source identity for mapped rows, italic
// "Value assignment" for VA, italic "No source mapped" for
// unmapped. Multi-source mapped rows show dominant source + `+N`
// chip with NO source pencil (per-source editing is PR 2's
// responsibility). Status + confidence sit on their own meta row,
// right-aligned, below the TO block.

describe('MappingDrawer — PR 1 header (FROM/TO stack)', () => {
  it('renders target identity (table badge + field name) below the TO label', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const tgt = screen.getByTestId('mapping-drawer-header-target')
    expect(within(tgt).getByText('accounts')).toBeInTheDocument()
    expect(within(tgt).getByTestId('mapping-drawer-title').textContent).toBe(
      'customer_id',
    )
  })

  it('target field renders at font-mono text-base font-normal text-slate-900', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const title = screen.getByTestId('mapping-drawer-title')
    expect(title.className).toContain('font-mono')
    expect(title.className).toContain('text-base')
    expect(title.className).toContain('font-normal')
    expect(title.className).toContain('text-slate-900')
    expect(title.className).not.toContain('font-semibold')
  })

  it('renders one source row (table badge + field name) below FROM for single-source mapped', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const src = screen.getByTestId('mapping-drawer-header-source')
    const rows = within(src).getAllByTestId('mapping-drawer-header-source-row')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]!).getByText('ACCT_MASTER')).toBeInTheDocument()
    expect(
      within(rows[0]!).getByTestId('mapping-drawer-header-source-field').textContent,
    ).toBe('ACCT_NO')
  })

  it('stacks ALL source rows vertically for multi-source mapped (NO +N chip, NO source pencil)', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            cifSource(0, 'FNAME'),
            cifSource(1, 'LNAME'),
            cifSource(2, 'MI'),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const src = screen.getByTestId('mapping-drawer-header-source')
    const rows = within(src).getAllByTestId('mapping-drawer-header-source-row')
    expect(rows).toHaveLength(3)
    // Server ordinal-asc ordering preserved verbatim (no client sort).
    expect(rows.map((r) => r.getAttribute('data-ordinal'))).toEqual([
      '0',
      '1',
      '2',
    ])
    // Each row carries badge + mono field name.
    const fieldNames = within(src)
      .getAllByTestId('mapping-drawer-header-source-field')
      .map((el) => el.textContent)
    expect(fieldNames).toEqual(['FNAME', 'LNAME', 'MI'])
    // PR 1 multi-source amendment: the legacy "+N" chip is gone — the
    // stacked rows themselves carry the plurality cue.
    expect(
      within(src).queryByTestId('mapping-drawer-header-sources-chip'),
    ).toBeNull()
    // PR 1 lock: multi-source header is read-only (per-source pencils
    // ship in PR 2).
    expect(
      within(src).queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('source wrapper uses flex-col so multi-source rows stack vertically', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [cifSource(0, 'FNAME'), cifSource(1, 'LNAME')],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const src = screen.getByTestId('mapping-drawer-header-source')
    expect(src.className).toContain('flex-col')
  })

  it('renders "Value assignment" italic label below FROM for VA rows', () => {
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    const src = screen.getByTestId('mapping-drawer-header-source')
    const label = within(src).getByTestId('mapping-drawer-header-source-label')
    expect(label.textContent).toBe('Value assignment')
    expect(label.className).toContain('italic')
    expect(label.getAttribute('data-variant')).toBe('value-assignment')
    // VAs have no source side to edit.
    expect(
      within(src).queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('renders "No source mapped" italic label below FROM for unmapped rows', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const src = screen.getByTestId('mapping-drawer-header-source')
    const label = within(src).getByTestId('mapping-drawer-header-source-label')
    expect(label.textContent).toBe('No source mapped')
    expect(label.className).toContain('italic')
    expect(label.getAttribute('data-variant')).toBe('unmapped')
  })

  it('renders FROM and TO labels in uppercase tracking style', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    for (const labelId of [
      'mapping-drawer-header-from-label',
      'mapping-drawer-header-to-label',
    ]) {
      const label = screen.getByTestId(labelId)
      expect(label.className).toContain('uppercase')
      expect(label.className).toContain('tracking-wide')
      expect(label.className).toContain('text-slate-500')
    }
    expect(
      screen.getByTestId('mapping-drawer-header-from-label').textContent,
    ).toBe('FROM')
    expect(
      screen.getByTestId('mapping-drawer-header-to-label').textContent,
    ).toBe('TO')
  })

  it('DOM order is FROM → source identity → TO → target identity → meta', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const fromLabel = screen.getByTestId('mapping-drawer-header-from-label')
    const source = screen.getByTestId('mapping-drawer-header-source')
    const toLabel = screen.getByTestId('mapping-drawer-header-to-label')
    const target = screen.getByTestId('mapping-drawer-header-target')
    const meta = screen.getByTestId('mapping-drawer-header-meta')
    // `compareDocumentPosition(other) & 4 === 4` means `other` follows.
    expect(fromLabel.compareDocumentPosition(source) & 4).toBe(4)
    expect(source.compareDocumentPosition(toLabel) & 4).toBe(4)
    expect(toLabel.compareDocumentPosition(target) & 4).toBe(4)
    expect(target.compareDocumentPosition(meta) & 4).toBe(4)
  })

  it('legacy "arrow between source and target" affordance is gone (regression guard)', () => {
    // PR 1: the horizontal layout's `mapping-drawer-header-arrow` icon
    // was retired with the FROM/TO vertical stack — the labels carry
    // the semantic, no arrow needed.
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('mapping-drawer-header-arrow')).toBeNull()
  })

  it('meta row renders the status badge right-aligned (justify-end)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const meta = screen.getByTestId('mapping-drawer-header-meta')
    expect(meta.className).toContain('justify-end')
    expect(
      within(meta).getByTestId('mapping-drawer-header-status-badge'),
    ).toBeInTheDocument()
  })

  it('meta row status badge renders dot + sentence-case word + confidence percent', () => {
    render(
      <MappingDrawer
        row={mapped({ status: 'needs_review', confidence: 88 })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const badge = screen.getByTestId('mapping-drawer-header-status-badge')
    expect(
      within(badge).getByTestId('mapping-drawer-header-status-needs_review'),
    ).toBeInTheDocument()
    const word = within(badge).getByTestId('mapping-drawer-header-status-word')
    expect(word.textContent).toBe('Needs review')
    expect(word.className).toContain('text-amber-700')
    const confidence = within(badge).getByTestId(
      'mapping-drawer-header-confidence',
    )
    expect(confidence.textContent).toMatch(/88%/)
  })

  it('meta row confidence renders em-dash when row.confidence is null (VA / unmapped)', () => {
    render(<MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />)
    const badge = screen.getByTestId('mapping-drawer-header-status-badge')
    expect(
      within(badge).getByTestId('mapping-drawer-header-confidence').textContent,
    ).toBe('—')
    expect(badge.textContent).not.toMatch(/\d+%/)
  })

  it('meta row status badge surfaces matched-hue className for each status variant', () => {
    for (const [row, variant, label, hueClass] of [
      [mapped({ status: 'approved' }), 'approved', 'Approved', 'text-green-700'] as const,
      [
        mapped({ status: 'needs_review' }),
        'needs_review',
        'Needs review',
        'text-amber-700',
      ] as const,
      [mapped({ status: 'rejected' }), 'rejected', 'Rejected', 'text-red-700'] as const,
      [targetAck(), 'approved', 'Approved', 'text-green-700'] as const,
    ]) {
      const { unmount } = render(
        <MappingDrawer row={row} isOpen={true} onClose={() => {}} />,
      )
      const dot = screen.getByTestId(`mapping-drawer-header-status-${variant}`)
      expect(dot.getAttribute('title')).toBe(label)
      expect(dot.getAttribute('aria-label')).toBe(label)
      const word = screen.getByTestId('mapping-drawer-header-status-word')
      expect(word.textContent).toBe(label)
      expect(word.className).toContain(hueClass)
      unmount()
    }
  })

  it('header is NOT sticky (scrolls with body content)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const header = screen.getByTestId('mapping-drawer-header')
    expect(header.className).not.toContain('sticky')
    expect(header.className).not.toContain('top-0')
  })

  it('close button shares the FROM label row (top-right) and precedes the rest in DOM order', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const headerRow = screen.getByTestId('mapping-drawer-header-row')
    const fromLabel = screen.getByTestId('mapping-drawer-header-from-label')
    const close = screen.getByTestId('mapping-drawer-close')
    const target = screen.getByTestId('mapping-drawer-header-target')
    expect(headerRow.contains(fromLabel)).toBe(true)
    expect(headerRow.contains(close)).toBe(true)
    // Close is on the top row, so it precedes the target identity
    // block which sits below the TO label.
    expect(close.compareDocumentPosition(target) & 4).toBe(4)
  })

  it('does NOT render legacy subheader testids (regression guard)', () => {
    for (const row of [
      mapped(),
      valueAssignment(),
      targetAck(),
      unmapped(),
    ]) {
      const { unmount } = render(
        <MappingDrawer row={row} isOpen={true} onClose={() => {}} />,
      )
      expect(screen.queryByTestId('mapping-drawer-subheader-rule_1')).toBeNull()
      expect(screen.queryByTestId('mapping-drawer-subheader-ack')).toBeNull()
      expect(screen.queryByTestId('mapping-drawer-subheader-va')).toBeNull()
      expect(screen.queryByTestId('mapping-drawer-subheader-unmapped')).toBeNull()
      unmount()
    }
  })
})

// ─── Header — inline edit affordances (PR 1) ──────────────────────────────
//
// Pencils are gated on (a) the parent threading commit handlers AND
// (b) the variant rules — single-source mapped + every mapped/VA
// target. Multi-source mapped rows + unmapped rows do NOT surface a
// source-side pencil (PR 2 covers per-card editing). When the parent
// threads handlers, clicking the pencil opens the matching portal
// picker (`inline-source-picker` / `target-field-cell-picker`).

describe('MappingDrawer — PR 1 header inline edit pencils', () => {
  const sf: SourceFieldWithState = {
    id: 'sf-other',
    name: 'OTHER_ACCT_NO',
    dataType: 'NUMBER',
    ordinalPosition: 0,
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
  }
  const tf: TargetFieldRef = targetField({ id: 'tf-other', name: 'other_id' })

  it('renders target pencil for single-source mapped when handlers are threaded', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-pencil'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-header-source-pencil'),
    ).toBeInTheDocument()
  })

  it('renders target pencil but NOT source pencil for multi-source mapped', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            cifSource(0, 'FNAME'),
            cifSource(1, 'LNAME'),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-pencil'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('renders target pencil for VA rows (no source pencil)', () => {
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, valueAssignment().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-pencil'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('does NOT render target pencil for unmapped rows (PR 2 territory)', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-target-pencil'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('omits both pencils when commit handlers are not threaded (standalone test mount)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.queryByTestId('mapping-drawer-header-target-pencil'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })

  it('clicking the target pencil opens the TargetFieldCellPicker portal', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-target-pencil'))
    expect(
      screen.getByTestId('target-field-cell-picker'),
    ).toBeInTheDocument()
  })

  it('clicking the source pencil (single-source mapped) opens the InlineSourcePicker portal', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-source-pencil'))
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
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
  it('mapped row body renders the Sources section (drawer redesign — Target field section removed)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('drawer-section-source')).toBeInTheDocument()
    // Drawer redesign: Target field, Status, Confidence sections all
    // moved into the compressed header. Their testids must not render.
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
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

// ─── Rule 6 — Unmapped body (drawer redesign) ──────────────────────────────
//
// Drawer redesign: Rule 6 reuses the `Sources` section title with an
// empty-state body ("No source mapped yet"). Footer carries the dual
// `[Suggest with AI] [Create mapping]` pair (Q11.F lock).

describe('MappingDrawer — Rule 6 (Unmapped) body', () => {
  it('renders ONE Sources section with empty-state copy', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const section = screen.getByTestId('drawer-section-source')
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(
      'Source',
    )
    const empty = screen.getByTestId('drawer-unmapped-empty-state')
    expect(empty.textContent).toBe('No source mapped yet')
    expect(empty.className).toContain('italic')
  })

  it('does NOT render the legacy Target field / Mapping status sections (moved to header)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
    expect(screen.queryByTestId('drawer-section-mapping-status')).toBeNull()
  })

  it('does NOT render a Status section (unmapped state is implicit + dot is hidden)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
  })

  it('renders ONLY the Sources-section edit pencil button in the body (Phase E PR α — replaces the pre-α negative-assert)', () => {
    // Pre-Phase E PR α: this test asserted ZERO buttons in the body
    // (the only path to mounting the create form was the footer's
    // [Create mapping] button). PR α adds the inline pencil affordance
    // in the SOURCE section's headerAside slot to mirror the grid's
    // pencil-edit pattern; the pencil is the only body-level button.
    // Approve / Reject / Suggest still live in the footer, never in
    // the body.
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const buttons = within(body).queryAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('data-testid')).toBe(
      'mapping-drawer-edit-pencil',
    )
  })

  it('renders the Sources-section edit pencil for unmapped rows (Phase E PR α — flip of the pre-α negative-assert)', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    const pencil = screen.getByTestId('mapping-drawer-edit-pencil')
    expect(pencil.tagName).toBe('BUTTON')
    expect(pencil.getAttribute('aria-label')).toBe('Edit mapping sources')
  })

  it('hides the Sources-section edit pencil while the create form is mounted (Phase E PR α)', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="project-1"
        availableSourceFields={[]}
      />,
    )
    // Click the pencil → form should mount and the pencil should
    // disappear (the affordance is "open the form"; once open it
    // would be redundant).
    await user.click(screen.getByTestId('mapping-drawer-edit-pencil'))
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

  it('does NOT render the legacy Target field / Status / Confidence sections', () => {
    render(
      <MappingDrawer row={valueAssignment()} isOpen={true} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
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

  it('section ordering for VA is Value expression → Analysis (drawer redesign PR 1)', () => {
    // Drawer redesign PR 1 (feat/drawer-header-rewrite): the empty-
    // state SOURCE section is removed, and VALUE EXPRESSION is
    // promoted to the lead position. Order is `Value expression →
    // Analysis [→ Decisions]`. The leading OVERVIEW section from
    // the prior pass remains removed.
    render(
      <MappingDrawer
        row={valueAssignment({ aiReasoning: 'reason text' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const sections = within(body).getAllByRole('heading', { level: 3 })
    expect(sections.map((h) => h.textContent)).toEqual([
      'Value expression',
      'Analysis',
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

// ── Rule 1 mapped body (single source) ─────────────────────────────────────

describe('MappingDrawer — Rule 1 (single source) mapped body', () => {
  it('renders the Sources section as the FIRST body section (drawer redesign §3)', () => {
    // Drawer redesign refinements §3: SOURCES is now the first body
    // section. The prior pass's leading OVERVIEW section is removed
    // entirely (drawer redesign refinements §2).
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const section = screen.getByTestId('drawer-section-source')
    expect(section).toBeInTheDocument()
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(
      'Source',
    )
    // OVERVIEW is gone.
    expect(screen.queryByTestId('drawer-section-overview')).toBeNull()
  })

  it('renders exactly one source card for Rule 1', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    expect(cards).toHaveLength(1)
  })

  it('Rule 1 source card shows TableBadge + field name AND per-source confidence (TARGET-led identity)', () => {
    // Drawer redesign — TARGET-led identity (this iteration): per-
    // source confidence is restored on ALL rows, including Rule 1
    // single-source. The header now leads with the target field and
    // carries no confidence number, so the per-source percent is
    // the drawer's only confidence surface. The minor redundancy
    // with the list view's right-edge confidence column on Rule 1
    // is acceptable — adjacency to the source identity makes the
    // number meaningful in context.
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
    // Per-source confidence is VISIBLE on Rule 1, color-banded.
    const confidence = within(card).getByTestId('drawer-source-confidence')
    expect(confidence.textContent).toBe('98%')
    expect(confidence.getAttribute('data-confidence-band')).toBe('high')
    // High band uses green-medium (matches list-view ConfidenceCell).
    expect(confidence.className).toContain('text-green-600')
    expect(confidence.className).toContain('font-medium')
  })

  it('Rule 1 source confidence color-bands by classifyRowConfidence (≥85 high, 40-84 amber, <40 low)', () => {
    for (const [conf, band, hueClass] of [
      [98, 'high', 'text-green-600'] as const,
      [85, 'high', 'text-green-600'] as const,
      [70, 'amber', 'text-amber-600'] as const,
      [40, 'amber', 'text-amber-600'] as const,
      [25, 'low', 'text-red-600'] as const,
    ]) {
      const { unmount } = render(
        <MappingDrawer
          row={mapped({
            sources: [
              source({
                confidence: conf,
                sourceField: { id: 'sf-c', name: 'F', dataType: 'VARCHAR', isNullable: false },
                sourceTable: { id: 'st-c', name: 'T' },
              }),
            ],
          })}
          isOpen={true}
          onClose={() => {}}
        />,
      )
      const cell = screen.getByTestId('drawer-source-confidence')
      expect(cell.getAttribute('data-confidence-band')).toBe(band)
      expect(cell.className).toContain(hueClass)
      unmount()
    }
  })

  it('source card does NOT render a join annotation for Rule 1 (always null)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-source-join')).toBeNull()
  })

  it('Sample Values is a top-level body section between Sources and Analysis (drawer redesign §3)', () => {
    // Drawer redesign refinements §3: SAMPLE VALUES is the second
    // body section, sitting between SOURCES and ANALYSIS. The
    // section is rendered only when at least one source has
    // non-empty sample data.
    render(
      <MappingDrawer
        row={mapped({
          sources: [source({ sampleValues: ['12345', '67890', '24680'] })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('drawer-section-sample-values')
    expect(within(section).getByRole('heading', { level: 3 }).textContent).toBe(
      'Sample values',
    )
    // Sources legacy nested block is gone.
    expect(screen.queryByTestId('drawer-source-samples')).toBeNull()
  })

  it('Sample Values single-source field block is EXPANDED by default (drawer redesign §5)', () => {
    // Drawer redesign refinements §5 (founder canary review):
    // single-source rows default the lone field block to expanded.
    // There's one source and no choice to make; showing values
    // immediately serves the verify-task case.
    render(
      <MappingDrawer
        row={mapped({
          sources: [source({ sampleValues: ['12345', '67890', '24680'] })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const section = screen.getByTestId('drawer-section-sample-values')
    const toggle = within(section).getByTestId('drawer-sample-values-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = within(section).getAllByTestId('drawer-sample-values-row')
    expect(rows.map((n) => n.textContent)).toEqual([
      '12345',
      '67890',
      '24680',
    ])
  })

  it('Sample Values section is omitted when no source has sample data', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-sample-values')).toBeNull()
    expect(screen.queryByTestId('drawer-sample-values-toggle')).toBeNull()
  })

  it('Sample Values renders one row per value with no client-side truncation', () => {
    // The wire payload caps sample values at 10. The drawer surfaces
    // every value verbatim — no "+N more", no truncation, no
    // grid-mode collapse.
    const ten = Array.from({ length: 10 }, (_, i) => `v${i + 1}`)
    render(
      <MappingDrawer
        row={mapped({ sources: [source({ sampleValues: ten })] })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const rows = screen.getAllByTestId('drawer-sample-values-row')
    expect(rows.map((n) => n.textContent)).toEqual(ten)
  })

  it('Sample Values long values wrap with break-words rather than truncate', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              sampleValues: [
                'one very long descriptive value that overflows a narrow drawer',
              ],
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const row = screen.getByTestId('drawer-sample-values-row')
    expect(row.className).toContain('break-words')
    expect(row.className).not.toContain('truncate')
    expect(row.getAttribute('title')).toBeNull()
  })

  it('per-source AI reasoning is NO LONGER rendered inline on the source card', () => {
    // Drawer redesign §2 lock — per-source aiReasoning folds into the
    // AI Reasoning section (one labelled paragraph per source) so the
    // Sources section line stays scannable.
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({ aiReasoning: 'Direct PK match in dominant table.' }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-source-reasoning')).toBeNull()
  })

  it('type compatibility renders ONLY in Analysis, not per-source (drawer redesign §4)', () => {
    // Drawer redesign refinements §4: type compatibility moves from
    // the now-removed OVERVIEW section into the new ANALYSIS section
    // as a compact verdict line (`VARCHAR(4) → VARCHAR(10) ✓
    // compatible`). The per-source `<SourceCard>` does not render
    // type-compat at all — SOURCES is identity-only.
    render(
      <MappingDrawer
        row={mapped({
          sources: [
            source({
              typeCompatibility: 'NUMBER → VARCHAR(200) needs CAST',
              sourceField: {
                id: 'sf-1',
                name: 'F',
                dataType: 'NUMBER',
                isNullable: false,
              },
            }),
          ],
          targetField: targetField({ dataType: 'VARCHAR(200)' }),
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // Per-source type-compat span is gone.
    expect(screen.queryByTestId('drawer-source-type-compat')).toBeNull()
    // Negative invariant — no standalone Type Compatibility section.
    expect(screen.queryByTestId('drawer-section-type-compat')).toBeNull()
    // The prior pass's Overview-scoped testid is gone.
    expect(screen.queryByTestId('drawer-overview-type-compat')).toBeNull()
    // Type compat appears in Analysis as a compact verdict line.
    const compat = screen.getByTestId('drawer-analysis-type-compat')
    expect(compat.getAttribute('data-verdict')).toBe('warning')
    expect(compat.textContent).toContain('NUMBER')
    expect(compat.textContent).toContain('VARCHAR(200)')
    expect(
      within(compat).getByTestId(
        'drawer-analysis-type-compat-verdict-warning',
      ),
    ).toBeInTheDocument()
  })

  it('does NOT render the legacy Target field / Confidence / Status sections', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
  })

  it('does NOT render the Combination "Combine with" label for Rule 1 (single source)', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-combination-label')).toBeNull()
    // Legacy Combination SECTION testid is also absent.
    expect(screen.queryByTestId('drawer-section-combination')).toBeNull()
  })

  it('Analysis section omits AI reasoning when neither row-level nor per-source is present (Q11.C lock)', () => {
    // Drawer redesign refinements §4: AI reasoning lives inside the
    // ANALYSIS section. The visibility gate (hide when no reasoning
    // of any kind) carries over verbatim. Type compatibility still
    // renders for the dominant source.
    render(
      <MappingDrawer
        row={mapped({ aiReasoning: null })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-ai-reasoning-toggle')).toBeNull()
    // ANALYSIS still renders because type compat is always shown for
    // mapped rows (mapped rows have a dominant source).
    expect(screen.getByTestId('drawer-section-analysis')).toBeInTheDocument()
  })

  it('AI Reasoning toggle inside Analysis is OPEN by default for needs_review (Q11.B lock)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Single-source mapping; high confidence.',
          status: 'needs_review',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const analysis = screen.getByTestId('drawer-section-analysis')
    const toggle = within(analysis).getByTestId('drawer-ai-reasoning-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const reasoning = within(analysis).getByTestId('drawer-ai-reasoning')
    expect(reasoning.textContent).toBe('Single-source mapping; high confidence.')
  })

  it('AI Reasoning toggle inside Analysis is CLOSED by default for approved (Q11.B lock)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Single-source mapping; high confidence.',
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

  it('clicking the AI Reasoning toggle inside Analysis expands and collapses the panel', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Single-source mapping; high confidence.',
          status: 'approved',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const toggle = screen.getByTestId('drawer-ai-reasoning-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('drawer-ai-reasoning')).toBeInTheDocument()
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('drawer-ai-reasoning')).toBeNull()
  })

  it('section ordering for Rule 1 is Sources → Analysis → Transformation when no sample data (drawer redesign §3)', () => {
    // Drawer redesign refinements §3: body order is SOURCES →
    // SAMPLE VALUES → ANALYSIS → TRANSFORMATION. SAMPLE VALUES is
    // omitted when no source has sample data, leaving three
    // sections. The leading OVERVIEW from the prior pass is gone.
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'reason text',
          // Force the Transformation section to render via the Define link.
          combinationType: 'single',
          hasTransformation: false,
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Source',
      'Analysis',
      'Transformation',
    ])
  })

  it('section ordering for Rule 1 is Sources → Sample Values → Analysis → Transformation when sample data is present (drawer redesign §3)', () => {
    // Drawer redesign refinements §3: full four-section body when
    // every section has content. SAMPLE VALUES sits between SOURCES
    // and ANALYSIS.
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'reason text',
          combinationType: 'single',
          hasTransformation: false,
          sources: [source({ sampleValues: ['A', 'B'] })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Source',
      'Sample values',
      'Analysis',
      'Transformation',
    ])
  })
})

// ── AI Reasoning aggregation, nested inside Analysis (drawer redesign §4) ──
//
// Drawer redesign refinements §4 (founder canary review): the AI
// reasoning disclosure lives inside the new ANALYSIS section (the
// prior pass had it nested under OVERVIEW, which is removed entirely).
// The aggregation rules are unchanged:
//
//   • Disclosure visible if EITHER row-level OR any per-source
//     reasoning is non-null. (Identical Q11.C lock — no reasoning of
//     any kind ⇒ no toggle.)
//   • Default-open for `needs_review`, default-closed for everything
//     else (Q11.B lock).
//   • When the panel renders: row-level paragraph first (when
//     present), then one labelled paragraph per source
//     ("[srcTable].field_name: ...") in server ordinal order.
//   • Per-source paragraphs carry `data-testid="drawer-ai-reasoning-source"`
//     plus `data-source-id` to enable per-source assertions.
//
// Testid contract: the toggle/panel keep their prior IDs
// (`drawer-ai-reasoning-toggle`, `drawer-ai-reasoning`,
// `drawer-ai-reasoning-row`, `drawer-ai-reasoning-source`) so legacy
// tests resolving the affordances continue to pass. The disclosure
// wrapper now exposes `drawer-analysis-ai-reasoning` (the prior pass's
// `drawer-overview-ai-reasoning` is gone alongside OVERVIEW).

describe('MappingDrawer — AI Reasoning aggregation (nested inside Analysis)', () => {
  it('disclosure is HIDDEN when both row-level AND every per-source reasoning is null', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: null,
          sources: [source({ aiReasoning: null })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-analysis-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-ai-reasoning-toggle')).toBeNull()
    // Legacy testids from prior passes are gone.
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
    expect(screen.queryByTestId('drawer-overview-ai-reasoning')).toBeNull()
  })

  it('disclosure is VISIBLE when only row-level reasoning is present (single paragraph)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'TFM-level reasoning.',
          status: 'needs_review',
          sources: [source({ aiReasoning: null })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('drawer-analysis-ai-reasoning'),
    ).toBeInTheDocument()
    // needs_review opens the disclosure by default.
    const row = screen.getByTestId('drawer-ai-reasoning-row')
    expect(row.textContent).toBe('TFM-level reasoning.')
    expect(screen.queryByTestId('drawer-ai-reasoning-source')).toBeNull()
  })

  it('disclosure is VISIBLE when only per-source reasoning is present (no row-level paragraph rendered)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: null,
          status: 'needs_review',
          sources: [
            source({
              id: 'ms-only',
              aiReasoning: 'Per-source-only reasoning.',
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('drawer-analysis-ai-reasoning'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-ai-reasoning-row')).toBeNull()
    const perSource = screen.getByTestId('drawer-ai-reasoning-source')
    expect(perSource.textContent).toContain('Per-source-only reasoning.')
    expect(perSource.getAttribute('data-source-id')).toBe('ms-only')
  })

  it('multi-source row renders row-level paragraph + one labelled paragraph per source (in ordinal order)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Combined name from FNAME + LNAME.',
          status: 'needs_review',
          sources: [
            source({
              id: 'ms-fname',
              ordinal: 0,
              aiReasoning: 'First name from CIF master.',
              sourceField: {
                id: 'sf-fname',
                name: 'FNAME',
                dataType: 'VARCHAR',
                isNullable: false,
              },
              sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
            }),
            source({
              id: 'ms-lname',
              ordinal: 1,
              aiReasoning: 'Last name from CIF master.',
              sourceField: {
                id: 'sf-lname',
                name: 'LNAME',
                dataType: 'VARCHAR',
                isNullable: false,
              },
              sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
            }),
          ],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('drawer-ai-reasoning-row').textContent,
    ).toBe('Combined name from FNAME + LNAME.')
    const perSource = screen.getAllByTestId('drawer-ai-reasoning-source')
    expect(perSource).toHaveLength(2)
    expect(perSource[0]!.getAttribute('data-source-id')).toBe('ms-fname')
    expect(perSource[0]!.textContent).toContain('CIF_MASTER.FNAME:')
    expect(perSource[0]!.textContent).toContain('First name from CIF master.')
    expect(perSource[1]!.getAttribute('data-source-id')).toBe('ms-lname')
    expect(perSource[1]!.textContent).toContain('CIF_MASTER.LNAME:')
    expect(perSource[1]!.textContent).toContain('Last name from CIF master.')
  })

  it('whitespace-only per-source reasoning is treated as empty (no paragraph rendered)', () => {
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'Row-level only.',
          status: 'needs_review',
          sources: [source({ id: 'ms-blank', aiReasoning: '   \n  ' })],
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-ai-reasoning-source')).toBeNull()
    expect(
      screen.getByTestId('drawer-ai-reasoning-row').textContent,
    ).toBe('Row-level only.')
  })

  it('VA rows do NOT aggregate per-source reasoning (VAs have no sources)', () => {
    render(
      <MappingDrawer
        row={valueAssignment({
          aiReasoning: 'NOW() default for created_at.',
          status: 'needs_review',
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('drawer-ai-reasoning-source')).toBeNull()
    expect(
      screen.getByTestId('drawer-ai-reasoning-row').textContent,
    ).toBe('NOW() default for created_at.')
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

  it('does NOT render any inline `Combine with: …` label or custom-SQL block (Cycle 1 — combination labels removed)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-combination-label')).toBeNull()
    expect(screen.queryByTestId('drawer-combination-sql')).toBeNull()
    // Legacy Combination SECTION testid stays absent.
    expect(screen.queryByTestId('drawer-section-combination')).toBeNull()
  })

  it('does NOT surface combination metadata even when combinationType=custom_sql AND combinationSql is non-null (Cycle 1)', () => {
    const sql = "FNAME || ' / ' || LNAME"
    render(
      <MappingDrawer
        row={rule2Mapped({ combinationType: 'custom_sql', combinationSql: sql })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    // The SourcesRoster-internal combine/SQL preview is removed in
    // Cycle 1. The VA-path "Value expression" DrawerSection (separate
    // surface, gated on `kind === 'value_assignment'`) is unaffected
    // and stays alive elsewhere.
    expect(screen.queryByTestId('drawer-combination-label')).toBeNull()
    expect(screen.queryByTestId('drawer-combination-sql')).toBeNull()
  })

  it('section ordering for Rule 2 is Sources → Analysis → Transformation when no sample data (drawer redesign §3)', () => {
    // Drawer redesign refinements §3: body order is SOURCES →
    // SAMPLE VALUES → ANALYSIS → TRANSFORMATION. SAMPLE VALUES is
    // omitted when no source has sample data. The leading OVERVIEW
    // from the prior pass is removed entirely.
    render(
      <MappingDrawer
        row={rule2Mapped({ aiReasoning: 'reason' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      'Source',
      'Analysis',
      'Transformation',
    ])
  })

  it('multi-source SAMPLE VALUES field blocks all default to COLLAPSED (drawer redesign §5)', () => {
    // Drawer redesign refinements §5 (founder canary review):
    // multi-source rows default all field blocks to collapsed. The
    // user typically inspects one source at a time; default-
    // collapsed keeps the section compact while preserving
    // independent per-block toggle state.
    render(
      <MappingDrawer
        row={rule2Mapped(
          {},
          [
            { sampleValues: ['DDA', 'NOW'] },
            { sampleValues: ['ABC', 'DEF'] },
          ],
        )}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const toggles = screen.getAllByTestId('drawer-sample-values-toggle')
    expect(toggles).toHaveLength(2)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    }
    // No values rendered yet — every block is collapsed.
    expect(screen.queryByTestId('drawer-sample-values-row')).toBeNull()
  })

  it('multi-source SAMPLE VALUES blocks toggle independently (drawer redesign §5)', async () => {
    // Drawer redesign refinements §5: each field block manages its
    // own open/closed state. Clicking one block does not affect any
    // other block in the section.
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={rule2Mapped(
          {},
          [
            { sampleValues: ['DDA', 'NOW'] },
            { sampleValues: ['ABC', 'DEF'] },
          ],
        )}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    const toggles = screen.getAllByTestId('drawer-sample-values-toggle')
    // Open the first block; the second remains collapsed.
    await user.click(toggles[0]!)
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false')
    // The first block's values render; the second's do not.
    const firstPanel = screen.getByTestId('drawer-sample-values-panel')
    expect(
      within(firstPanel).getAllByTestId('drawer-sample-values-row')
        .map((n) => n.textContent),
    ).toEqual(['DDA', 'NOW'])
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

  // Regression test (Phase 4a-3 smoke): the canonical
  // `deriveJoinAnnotation` output (`'(join: …)'`) must NOT be wrapped a
  // second time by the renderer. Earlier the drawer emitted
  // `(join: (join: PrimaryContactID))`. Guard against re-introduction.
  it('does NOT double-wrap the canonical "(join: …)" annotation produced by the server', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const join = screen.getByTestId('drawer-source-join')
    expect(join.textContent).not.toMatch(/\(join:\s*\(join:/)
    // exactly one "(join:" substring
    const occurrences = (join.textContent ?? '').match(/\(join:/g) ?? []
    expect(occurrences).toHaveLength(1)
  })

  it('does NOT render a join annotation for the dominant source (joinAnnotation === null)', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const cards = screen.getAllByTestId('drawer-source-card')
    expect(within(cards[0]!).queryByTestId('drawer-source-join')).toBeNull()
    expect(within(cards[1]!).getByTestId('drawer-source-join')).toBeInTheDocument()
  })

  it('does NOT render the inline `Combine with: …` label even for cross-table multi-source rows (Cycle 1)', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-combination-label')).toBeNull()
  })

  it('drawer redesign drops the standalone Combination section heading', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    const body = screen.getByTestId('mapping-drawer-body')
    const headings = within(body)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent)
    expect(headings).not.toContain('Combination')
  })

  // ── Cross-table apply transparency badge (Phase 4a-3 → retired in 4a-6) ──
  //
  // Phase 4a-6 wired the cross-table apply RPC branch (migration 076) and
  // retired the transparency badge. Negative invariant kept here so a
  // regression that re-introduces the testid surfaces immediately.

  it('does NOT render a cross-table-apply transparency badge for cross-table TFMs (retired in 4a-6)', () => {
    render(<MappingDrawer row={rule3Mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.queryByTestId('drawer-section-source-cross-table-badge'),
    ).toBeNull()
    expect(screen.queryByText(/cross-table not yet applicable/i)).toBeNull()
  })
})

describe('MappingDrawer — same-table mappings DO NOT render cross-table badge', () => {
  it('Rule 1 (single-source) does not render the badge', () => {
    render(<MappingDrawer row={mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.queryByTestId('drawer-section-source-cross-table-badge'),
    ).toBeNull()
  })

  it('Rule 2 (multi-source same-table) does not render the badge', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(
      screen.queryByTestId('drawer-section-source-cross-table-badge'),
    ).toBeNull()
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

  it('does NOT render the inline `Combine with: …` label or custom_sql block (Cycle 1)', () => {
    render(<MappingDrawer row={rule4Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-combination-label')).toBeNull()
    expect(screen.queryByTestId('drawer-combination-sql')).toBeNull()
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

  it('drawer redesign — Target field / Status / Confidence sections are NOT in the body (moved to header)', () => {
    render(<MappingDrawer row={rule2Mapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.queryByTestId('drawer-section-target-field')).toBeNull()
    expect(screen.queryByTestId('drawer-section-status')).toBeNull()
    expect(screen.queryByTestId('drawer-section-confidence')).toBeNull()
    // Sources section is the unique entry-point for source identity
    // inside the body — exactly one render.
    expect(screen.getAllByTestId('drawer-section-source')).toHaveLength(1)
  })

  it('body sections use tightened mb-4 spacing (drawer redesign §3 — Sources / Analysis / Transformation)', () => {
    // Drawer redesign refinements §3: body sections are SOURCES,
    // SAMPLE VALUES (when present), ANALYSIS, TRANSFORMATION. The
    // tightened mb-4 spacing applies to every rendered section.
    // The fixture below has no sample data so SAMPLE VALUES is
    // omitted; the remaining three sections all carry mb-4.
    render(
      <MappingDrawer
        row={mapped({
          aiReasoning: 'reason',
          combinationType: 'single',
          hasTransformation: false,
        })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    for (const id of [
      'drawer-section-source',
      'drawer-section-analysis',
      'drawer-section-transformation',
    ]) {
      const section = screen.getByTestId(id)
      expect(section.className).toContain('mb-4')
      expect(section.className).not.toContain('mb-6')
    }
    // OVERVIEW and standalone AI Reasoning are gone.
    expect(screen.queryByTestId('drawer-section-overview')).toBeNull()
    expect(screen.queryByTestId('drawer-section-ai-reasoning')).toBeNull()
  })
})

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
} = vi.hoisted(() => ({
  approveFieldMappingMock: vi.fn(),
  rejectFieldMappingMock: vi.fn(),
  createFieldMappingMock: vi.fn(),
  suggestMappingForTargetMock: vi.fn(),
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

  it('coverage-approved no-source row: footer is just [Un-approve] (INF-57 cleanup)', () => {
    // Pre-INF-57: target_acknowledged rows rendered AcknowledgedFooterButtons
    // with a sole [Un-acknowledge] button. INF-57 cleanup collapsed the kind
    // into kind='unmapped' with status='approved' — the new dispatch in
    // UnmappedFooterButtons (status='approved' branch) renders the renamed
    // [Un-approve] button alone, calling resetMappingStatus.
    render(
      <MappingDrawer row={targetAck()} isOpen={true} onClose={() => {}} />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-reject-button'),
    ).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-unapprove-button'),
    ).toBeInTheDocument()
  })

  it('unmapped row: footer is rendered with [Create mapping] + [Suggest with AI]; no Approve/Reject', () => {
    render(<MappingDrawer row={unmapped()} isOpen={true} onClose={() => {}} />)
    expect(screen.getByTestId('mapping-drawer-footer')).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-reject-button')).toBeNull()
  })

  // ── INF-57 cleanup — status-driven UnmappedFooterButtons (Option B) ────────
  //
  // Locked design decision 4: when an unmapped row's drawer is open, the
  // footer dispatches by row.status (inside UnmappedFooterButtons):
  //   needs_review/unmapped → Suggest with AI / Create mapping (form path)
  //   approved              → [Un-approve] (calls resetMappingStatus)
  //   rejected              → [Approve] (re-approves coverage row)
  //
  // The form-active sub-states (suggest pending / cancel / save) live
  // inside the form-driven branch and are unchanged — exercised by the
  // form tests below.

  it('unmapped + status=approved: footer renders ONLY [Un-approve] (Suggest/Create suppressed)', () => {
    // The status='approved' branch surfaces the un-approve verb alone —
    // Suggest with AI / Create mapping are gated to the form-entry path
    // (status='needs_review' / 'unmapped').
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-cov-1', status: 'approved' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
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
    // wrapper mapped/VA rejected rows use to un-reject).
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
    expect(
      screen.queryByTestId('mapping-drawer-unapprove-button'),
    ).toBeNull()
  })

  it('unmapped + status=needs_review: footer preserves the existing [Suggest with AI] / [Create mapping] form-entry path (no regression)', () => {
    // The needs_review branch is unchanged from the pre-INF-57 surface —
    // Option B layered the new approved/rejected dispatch on top without
    // disturbing the form-entry flow that drives the create-mapping path.
    render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-cov-3', status: 'needs_review' })}
        isOpen={true}
        onClose={() => {}}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-unapprove-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-approve-button'),
    ).toBeNull()
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
    // Pre-click sanity: header status dot reflects Needs Review.
    expect(
      screen.getByTestId('mapping-drawer-header-status-needs_review'),
    ).toBeInTheDocument()
    await user.click(screen.getByTestId('mapping-drawer-approve-button'))
    // While the promise is pending the optimistic overlay flips the
    // header dot to Approved (drawer redesign — status moved to
    // header line 2 dot).
    expect(
      screen.getByTestId('mapping-drawer-header-status-approved'),
    ).toBeInTheDocument()
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
    // Header status dot reverted to Needs Review.
    expect(
      screen.getByTestId('mapping-drawer-header-status-needs_review'),
    ).toBeInTheDocument()
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
    ...overrides,
  }
}

const SOURCE_FIELDS_FIXTURE: SourceFieldWithState[] = [
  makeSourceField({ id: 'sf-acc-1', name: 'ACCT_NO', ordinalPosition: 1 }),
  makeSourceField({ id: 'sf-acc-2', name: 'ACCT_TYPE', ordinalPosition: 2 }),
]

describe('MappingDrawer Phase 4a-2 — unmapped footer mode-switch', () => {
  it('renders [Create mapping] only when the form is inactive', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-form-cancel-button'),
    ).toBeNull()
    expect(screen.queryByTestId('mapping-drawer-form-save-button')).toBeNull()
  })

  it('clicking [Create mapping] morphs body to form + footer to [Cancel] [Save]', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    expect(
      screen.queryByTestId('drawer-unmapped-prose'),
    ).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-form-cancel-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-form-save-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-create-mapping-button'),
    ).toBeNull()
  })

  it('Save button starts disabled (no source selected) and enables after a selection', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    const save = screen.getByTestId(
      'mapping-drawer-form-save-button',
    ) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const fieldButtons = screen.getAllByTestId('source-field-picker-field')
    await user.click(fieldButtons[0])
    expect(save.disabled).toBe(false)
  })

  it('clicking Cancel on a clean form deactivates the form silently', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(screen.getByTestId('mapping-drawer-form-cancel-button'))
    expect(screen.queryByTestId('create-mapping-form')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    // No discard dialog should have surfaced for a clean form.
    expect(
      screen.queryByTestId('create-mapping-form-discard-dialog'),
    ).toBeNull()
  })
})

describe('MappingDrawer Phase 4a-2 — close-with-confirm intercepts (dirty form)', () => {
  it('Cancel button surfaces the discard dialog when dirty', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-cancel-button'))
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog'),
    ).toBeInTheDocument()
    // Form remains mounted while the dialog is open.
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
  })

  it('X button surfaces the discard dialog when dirty (no onClose call)', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={onClose}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-close'))
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog'),
    ).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clicking Discard in the dialog deactivates the form (no onClose)', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={onClose}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-cancel-button'))
    await user.click(screen.getByTestId('create-mapping-form-discard-confirm'))
    expect(screen.queryByTestId('create-mapping-form')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    // Founder decision §1-OQ-1: discard dialog dismisses dialog/form,
    // it does NOT bubble up to drawer-close.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Esc with the discard dialog open does NOT bubble to onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={onClose}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-cancel-button'))
    expect(
      screen.getByTestId('create-mapping-form-discard-dialog'),
    ).toBeInTheDocument()
    // Esc should dismiss the dialog only (Radix' AlertDialog wires its
    // own listener); the drawer's listener must skip onClose because
    // an [role=alertdialog] is mounted.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mousedown inside an open discard dialog does NOT bubble to onClose', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={onClose}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-cancel-button'))
    const dialog = screen.getByTestId('create-mapping-form-discard-dialog')
    fireEvent.mouseDown(dialog)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('MappingDrawer Phase 4a-2 — Save flow', () => {
  it('Save button calls createFieldMapping with the selected source + same-table combination', async () => {
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-new',
    })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped({
          targetField: targetField({
            id: 'tf-target',
            name: 'account_number',
          }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(createFieldMappingMock).toHaveBeenCalledTimes(1)
    expect(createFieldMappingMock.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p-1',
      targetFieldId: 'tf-target',
      sourceFieldIds: ['sf-acc-1'],
      combinationType: 'single',
    })
  })

  it('successful save invokes onSaveSuccess(newTfmId) and deactivates the form', async () => {
    createFieldMappingMock.mockResolvedValue({
      success: true,
      tfmId: 'tfm-new-id',
    })
    const onSaveSuccess = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
        onSaveSuccess={onSaveSuccess}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    await user.click(screen.getByTestId('mapping-drawer-form-save-button'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onSaveSuccess).toHaveBeenCalledWith('tfm-new-id', undefined)
    // Form deactivates so the body returns to the empty-state. (In
    // production, the parent page swaps the row to a mapped one in
    // parallel — this is not asserted here.)
    expect(screen.queryByTestId('create-mapping-form')).toBeNull()
  })
})

describe('MappingDrawer Phase 4a-2 — row switch resets form state silently', () => {
  it('switching to a different row clears the active form (no discard dialog)', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-A', targetField: targetField({ id: 'tf-A' }) })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(
      screen.getAllByTestId('source-field-picker-field')[0],
    )
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    // Founder decision §8-OQ-1: row-switch is the only silent path.
    rerender(
      <MappingDrawer
        row={unmapped({ id: 'unmapped::tf-B', targetField: targetField({ id: 'tf-B' }) })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    expect(screen.queryByTestId('create-mapping-form')).toBeNull()
    expect(
      screen.queryByTestId('create-mapping-form-discard-dialog'),
    ).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4a — restoreFormState + onFormDirtyChange contract.
// ─────────────────────────────────────────────────────────────────────────────
//
// The drawer relays its form's dirty-state snapshot up to the parent
// (`MappingContent`) via `onFormDirtyChange`, and threads a
// previously-captured snapshot back down via `restoreFormState`. The
// parent uses these props to power the row-switch-while-dirty Undo
// affordance. These tests pin the wiring contract:
//
//   • Threading a non-null `restoreFormState` whose `targetFieldId`
//     matches the open Rule 6 row auto-activates the form and
//     re-hydrates its source selection.
//   • The form invokes `onRestoreConsumed` exactly once after applying
//     the snapshot.
//   • `onFormDirtyChange` fires with the snapshot when the form
//     becomes dirty and with `null` when the form becomes clean (or
//     the user cancels).

describe('MappingDrawer Phase 4a-4a — restoreFormState + onFormDirtyChange', () => {
  it('auto-activates the form and hydrates selections when restoreFormState is threaded in', () => {
    const onRestoreConsumed = vi.fn()
    render(
      <MappingDrawer
        row={unmapped({
          id: 'unmapped::tf-A',
          targetField: targetField({ id: 'tf-A' }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
        restoreFormState={{
          targetFieldId: 'tf-A',
          selectedIds: ['sf-acc-1'],
          combinationType: 'concat_space',
          joinAnnotations: {},
        }}
        onRestoreConsumed={onRestoreConsumed}
      />,
    )
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    const chips = screen.getAllByTestId('source-field-picker-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].getAttribute('data-source-field-id')).toBe('sf-acc-1')
    expect(onRestoreConsumed).toHaveBeenCalledTimes(1)
  })

  it('does NOT auto-activate when restoreFormState targetFieldId does not match the open row', () => {
    const onRestoreConsumed = vi.fn()
    render(
      <MappingDrawer
        row={unmapped({
          id: 'unmapped::tf-A',
          targetField: targetField({ id: 'tf-A' }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
        restoreFormState={{
          targetFieldId: 'tf-OTHER',
          selectedIds: ['sf-acc-1'],
          combinationType: 'concat_space',
          joinAnnotations: {},
        }}
        onRestoreConsumed={onRestoreConsumed}
      />,
    )
    expect(screen.queryByTestId('create-mapping-form')).toBeNull()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    expect(onRestoreConsumed).not.toHaveBeenCalled()
  })

  it('fires onFormDirtyChange with a snapshot when the form becomes dirty and null when cleaned', async () => {
    const user = userEvent.setup()
    const onFormDirtyChange = vi.fn()
    render(
      <MappingDrawer
        row={unmapped({
          id: 'unmapped::tf-A',
          targetField: targetField({ id: 'tf-A' }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
        onFormDirtyChange={onFormDirtyChange}
      />,
    )
    // Form not active yet — drawer should have published null.
    expect(onFormDirtyChange).toHaveBeenCalledWith(null)
    onFormDirtyChange.mockClear()

    await user.click(screen.getByTestId('mapping-drawer-create-mapping-button'))
    await user.click(screen.getAllByTestId('source-field-picker-field')[0])
    // Latest call has a non-null snapshot for this targetFieldId.
    const lastCall = onFormDirtyChange.mock.calls.at(-1)?.[0] as
      | {
          targetFieldId: string
          selectedIds: string[]
          combinationType: string
        }
      | null
    expect(lastCall).not.toBeNull()
    expect(lastCall?.targetFieldId).toBe('tf-A')
    expect(lastCall?.selectedIds).toEqual(['sf-acc-1'])

    onFormDirtyChange.mockClear()
    // Unselect — form is clean again, snapshot should be null.
    await user.click(screen.getAllByTestId('source-field-picker-field')[0])
    expect(onFormDirtyChange).toHaveBeenLastCalledWith(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4b — AI Suggest footer mode-switch + auto-trigger plumbing.
// ─────────────────────────────────────────────────────────────────────────────
//
// Three-mode footer for unmapped rows (Block C of investigation §13):
//
//   • Inactive (no form active) — both [Suggest with AI] and [Create mapping]
//   • Active + Suggest pending  — single [Cancel suggestion]
//   • Active + not pending      — [Cancel] [Save mapping] (4a-2 shape)
//
// Plus the autoSuggest plumbing: clicking [Suggest with AI] from the
// inactive footer must mount the form with `autoSuggest=true` so it
// fires `invokeSuggest` on its first render. Cancel via the footer
// must reach the form's imperative `cancelSuggest` handle.

describe('MappingDrawer Phase 4a-4b — Suggest with AI footer auto-trigger', () => {
  it('inactive footer renders BOTH [Suggest with AI] and [Create mapping] for an unmapped row', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    // The pending [Cancel suggestion] button is NOT visible while the
    // drawer is in the inactive state.
    expect(
      screen.queryByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeNull()
  })

  it('click [Suggest with AI] mounts form with autoSuggest and invokes the wrapper exactly once', async () => {
    let resolveSuggest: ((value: unknown) => void) | undefined
    suggestMappingForTargetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuggest = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    // Form mounts and immediately fires the wrapper.
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    expect(suggestMappingForTargetMock).toHaveBeenCalledTimes(1)
    // Footer flips to the pending mode — single [Cancel suggestion]
    // button replaces the pair.
    expect(
      screen.getByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-form-cancel-button'),
    ).toBeNull()
    expect(
      screen.queryByTestId('mapping-drawer-form-save-button'),
    ).toBeNull()
    // Resolve the in-flight call so React doesn't warn about act().
    await act(async () => {
      resolveSuggest?.({
        success: true,
        suggestion: {
          sourceFieldIds: ['sf-acc-1'],
          combinationType: 'single',
          confidence: 80,
          rationale: 'High overlap',
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('successful suggest restores active+not-pending footer ([Cancel] [Save mapping])', async () => {
    suggestMappingForTargetMock.mockResolvedValue({
      success: true,
      suggestion: {
        sourceFieldIds: ['sf-acc-1'],
        combinationType: 'single',
        confidence: 80,
        rationale: 'Heritage rationale',
      },
    })
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    // Suggestion landed — pill is rendered and footer is back in
    // the [Cancel] [Save] shape.
    expect(
      screen.getByTestId('create-mapping-form-suggest-loaded'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-form-cancel-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-form-save-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeNull()
  })

  it('[Cancel suggestion] aborts the pending call and returns to active+empty footer', async () => {
    let resolveSuggest: ((value: unknown) => void) | undefined
    suggestMappingForTargetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuggest = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    expect(
      screen.getByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeInTheDocument()
    await user.click(
      screen.getByTestId('mapping-drawer-cancel-suggest-button'),
    )
    // After cancel: footer is back in the active+not-pending shape.
    // The form is still mounted (cancel never tears it down — it just
    // aborts the in-flight suggestion).
    expect(screen.getByTestId('create-mapping-form')).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-form-cancel-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-form-save-button'),
    ).toBeInTheDocument()
    // Late-arriving server response does not surface a loaded
    // suggestion (race resolution discarded it).
    await act(async () => {
      resolveSuggest?.({
        success: true,
        suggestion: {
          sourceFieldIds: ['sf-acc-1'],
          combinationType: 'single',
          confidence: 80,
          rationale: 'late',
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      screen.queryByTestId('create-mapping-form-suggest-loaded'),
    ).toBeNull()
  })

  it('row switch while a suggest is in flight resets autoSuggest + pending state on the next row', async () => {
    let resolveSuggest: ((value: unknown) => void) | undefined
    suggestMappingForTargetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuggest = resolve
        }),
    )
    const user = userEvent.setup()
    const { rerender } = render(
      <MappingDrawer
        row={unmapped({
          id: 'unmapped::tf-A',
          targetField: targetField({ id: 'tf-A' }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    await user.click(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    )
    expect(
      screen.getByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeInTheDocument()
    // Switch rows mid-flight — drawer must reset to inactive footer
    // for the new row, NOT carry the pending state across.
    rerender(
      <MappingDrawer
        row={unmapped({
          id: 'unmapped::tf-B',
          targetField: targetField({ id: 'tf-B' }),
        })}
        isOpen={true}
        onClose={() => {}}
        projectId="p-1"
        availableSourceFields={SOURCE_FIELDS_FIXTURE}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-suggest-with-ai-button'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('mapping-drawer-create-mapping-button'),
    ).toBeInTheDocument()
    expect(
      screen.queryByTestId('mapping-drawer-cancel-suggest-button'),
    ).toBeNull()
    // Drain the dangling promise from the unmounted form.
    await act(async () => {
      resolveSuggest?.({
        success: true,
        suggestion: {
          sourceFieldIds: ['sf-acc-1'],
          combinationType: 'single',
          confidence: 80,
          rationale: '',
        },
      })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('mapped/VA/coverage-approved-no-source rows do NOT render [Suggest with AI] (form-entry path is gated to unmapped+needs_review/unmapped)', () => {
    // INF-57 cleanup: targetAck() now produces kind='unmapped' with
    // status='approved', which renders the Un-approve button — not Suggest
    // with AI. Suggest with AI is gated to the form-entry branch
    // (unmapped + status ∈ {needs_review, unmapped}). Mapped/VA carry their
    // own ApproveRejectButtons footer which never surfaces Suggest with AI.
    const rows = [mapped(), valueAssignment(), targetAck()]
    for (const row of rows) {
      const { unmount } = render(
        <MappingDrawer row={row} isOpen={true} onClose={() => {}} />,
      )
      expect(
        screen.queryByTestId('mapping-drawer-suggest-with-ai-button'),
      ).toBeNull()
      unmount()
    }
  })
})
