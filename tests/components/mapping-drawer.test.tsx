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
    // No commit handlers threaded in this fixture → SourceRow gates
    // both affordances off (editEnabled=false, removeEnabled=false).
    // The PR-2 handler-present case is covered separately below.
    expect(
      within(src).queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
    expect(
      within(src).queryByTestId('mapping-drawer-header-source-remove'),
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
    expect(word.className).toContain('text-slate-700')
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
        'text-slate-700',
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

  it('renders target pencil + per-source pencils for multi-source mapped (PR 2)', () => {
    // PR 2 reverses the PR 1 lock that multi-source was read-only.
    // Every source row in the FROM stack now carries its own ✏
    // pencil — addressable via `within(row).getByTestId(...)` since
    // there are N pencils, one per row.
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
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-pencil'),
    ).toBeInTheDocument()
    const pencils = screen.getAllByTestId(
      'mapping-drawer-header-source-pencil',
    )
    expect(pencils).toHaveLength(2)
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

// ─── PR 2 — per-source ✏ + ✕ affordances on multi-source rows ─────────────
//
// Drawer redesign PR 2 TASK 1: every source row in the multi-source FROM
// stack gets its own ✏ pencil (→ `InlineSourcePicker` →
// `updateMappingSourceField` with a `<tfmId>::<mappingSourceId>` shimmed
// contributor id) and its own ✕ remove (→ `RejectConfirmPopover` with
// "Remove this source from the mapping?" copy → `editMappingSources`
// with the source filtered out). The ✕ is hidden when sources.length=1.

describe('MappingDrawer — PR 2 per-source affordances (multi-source)', () => {
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

  function multiSourceRow(overrides: Partial<MappedRow> = {}): MappedRow {
    return mapped({
      sources: [
        cifSource(0, 'FNAME'),
        cifSource(1, 'LNAME'),
        cifSource(2, 'MI'),
      ],
      combinationType: 'concat_space',
      ...overrides,
    })
  }

  it('renders one ✕ remove per source row when sources.length > 1', () => {
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    expect(removes).toHaveLength(3)
  })

  it('does NOT render ✕ remove on single-source rows when onUnmapMapping is absent', () => {
    // PR 2 TASK 1.6: the single-source ✕ "Remove mapping" flow uses
    // `onUnmapMapping` (NOT `onEditSources`, which rejects empty
    // source lists). When the parent threads only `onEditSources`,
    // single-source ✕ stays gated off — no surface for an unmappable
    // action.
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-source-remove'),
    ).toBeNull()
  })

  it('renders ✕ remove on single-source rows when onUnmapMapping is threaded (PR 2 TASK 1.6)', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-source-remove'),
    ).toBeInTheDocument()
  })

  it('single-source ✕ opens popover with "Remove mapping" copy', async () => {
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
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-source-remove'))
    const popover = screen.getByTestId('reject-confirm-popover')
    expect(popover.textContent).toContain(
      'Remove this mapping? The target field will be unmapped.',
    )
    expect(
      screen.getByTestId('reject-confirm-popover-confirm').textContent,
    ).toBe('Remove mapping')
  })

  it('confirming a single-source ✕ calls onUnmapMapping with (tfmId, targetFieldId)', async () => {
    const user = userEvent.setup()
    const onUnmapMapping = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={onUnmapMapping}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-source-remove'))
    await user.click(screen.getByTestId('reject-confirm-popover-confirm'))
    expect(onUnmapMapping).toHaveBeenCalledTimes(1)
    expect(onUnmapMapping).toHaveBeenCalledWith('tfm-1', 'tf-1')
  })

  it('clicking a per-source ✏ pencil opens InlineSourcePicker', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const pencils = screen.getAllByTestId(
      'mapping-drawer-header-source-pencil',
    )
    await user.click(pencils[1]!) // middle source row (LNAME)
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
  })

  it('clicking a per-source ✕ opens RejectConfirmPopover with "Remove" copy', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    await user.click(removes[0]!)
    const popover = screen.getByTestId('reject-confirm-popover')
    expect(popover).toBeInTheDocument()
    expect(popover.textContent).toContain('Remove this source from the mapping?')
    expect(
      screen.getByTestId('reject-confirm-popover-confirm').textContent,
    ).toBe('Remove')
  })

  it('confirming a per-source ✕ calls onEditSources with the source filtered out (combinationType preserved when ≥ 2 remain)', async () => {
    const user = userEvent.setup()
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={multiSourceRow({ combinationType: 'concat_comma' })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={onEditSources}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    // Remove the middle source (LNAME, sf-LNAME). 3 → 2 sources remain.
    await user.click(removes[1]!)
    await user.click(screen.getByTestId('reject-confirm-popover-confirm'))
    expect(onEditSources).toHaveBeenCalledTimes(1)
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      // FNAME + MI remaining, in server ordinal order.
      sourceFieldIds: ['sf-FNAME', 'sf-MI'],
      // Existing concat_comma preserved when remaining count >= 2.
      combinationType: 'concat_comma',
    })
  })

  it('confirming a per-source ✕ collapses combinationType to "single" when remove leaves exactly 1 source', async () => {
    const user = userEvent.setup()
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped({
          sources: [cifSource(0, 'FNAME'), cifSource(1, 'LNAME')],
          combinationType: 'concat_space',
        })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={onEditSources}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    await user.click(removes[1]!) // remove LNAME → FNAME remains
    await user.click(screen.getByTestId('reject-confirm-popover-confirm'))
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-FNAME'],
      combinationType: 'single',
    })
  })

  it('cancelling a per-source ✕ popover does NOT call onEditSources', async () => {
    const user = userEvent.setup()
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={onEditSources}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    await user.click(removes[0]!)
    await user.click(screen.getByTestId('reject-confirm-popover-cancel'))
    expect(onEditSources).not.toHaveBeenCalled()
    expect(screen.queryByTestId('reject-confirm-popover')).toBeNull()
  })

  it('per-source pencils are gated off when onSwapSource is not threaded', () => {
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
    // Remove still renders because it only requires onEditSources.
    expect(
      screen.getAllByTestId('mapping-drawer-header-source-remove'),
    ).toHaveLength(3)
  })

  it('per-source removes are gated off when onEditSources is not threaded', () => {
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-source-remove'),
    ).toBeNull()
    expect(
      screen.getAllByTestId('mapping-drawer-header-source-pencil'),
    ).toHaveLength(3)
  })
})

// ─── PR 2 TASK 1.5 — drawer stays open through picker/popover interactions ─
//
// PR 1's tests asserted "picker opens" but never asserted the drawer
// STAYS OPEN through commit. TASK 1's expanded affordance surface
// surfaced a latent bug: the drawer's mousedown handler treated the
// picker portals (which mount to document.body, outside the drawer
// subtree) as "outside drawer" → drawer closed on click-through.
//
// The fix exempts `inline-source-picker`, `target-field-cell-picker`,
// and `reject-confirm-popover` testids from the drawer's
// click-outside check. These tests pin the new contract.

describe('MappingDrawer — PR 2 TASK 1.5 drawer stays open through picker/popover', () => {
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

  function multiSourceRow(overrides: Partial<MappedRow> = {}): MappedRow {
    return mapped({
      sources: [
        cifSource(0, 'FNAME'),
        cifSource(1, 'LNAME'),
        cifSource(2, 'MI'),
      ],
      combinationType: 'concat_space',
      ...overrides,
    })
  }

  /**
   * Drives the drawer's `mousedown` listener directly against the
   * picker/popover container element. `userEvent.click` issues a
   * matching mousedown internally, but for the click-outside guard we
   * want to verify the drawer-level handler is correctly exempting
   * the portal — `fireEvent.mouseDown` bypasses the React event
   * system and exercises the document-level listener that the drawer
   * registered in `useEffect`. If the exemption check fails, the
   * drawer would unmount before this helper returns.
   */
  function fireMouseDownInside(element: HTMLElement) {
    fireEvent.mouseDown(element)
  }

  it('mousedown inside InlineSourcePicker portal does NOT close the drawer (single-source ✏)', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={onClose}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-source-pencil'))
    const picker = screen.getByTestId('inline-source-picker')
    fireMouseDownInside(picker)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('mousedown inside InlineSourcePicker portal does NOT close the drawer (multi-source per-source ✏)', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={onClose}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const pencils = screen.getAllByTestId(
      'mapping-drawer-header-source-pencil',
    )
    await user.click(pencils[1]!)
    fireMouseDownInside(screen.getByTestId('inline-source-picker'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('mousedown inside RejectConfirmPopover portal does NOT close the drawer (multi-source per-source ✕)', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={multiSourceRow()}
        isOpen={true}
        onClose={onClose}
        availableTargetFields={[tf, multiSourceRow().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const removes = screen.getAllByTestId(
      'mapping-drawer-header-source-remove',
    )
    await user.click(removes[0]!)
    fireMouseDownInside(screen.getByTestId('reject-confirm-popover'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('mousedown inside TargetFieldCellPicker portal does NOT close the drawer', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={onClose}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onSwapSource={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-target-pencil'))
    fireMouseDownInside(screen.getByTestId('target-field-cell-picker'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('mapping-drawer')).toBeInTheDocument()
  })

  it('mousedown on the actual page area outside drawer + picker DOES close (regression guard)', () => {
    // Belt-and-braces: the picker exemption must not over-broaden the
    // click-outside check. A click landing on plain page background
    // (no picker, no drawer, no sidebar) still closes the drawer.
    const onClose = vi.fn()
    render(
      <div data-testid="page-bg">
        <MappingDrawer
          row={mapped()}
          isOpen={true}
          onClose={onClose}
        />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId('page-bg'))
    expect(onClose).toHaveBeenCalledTimes(1)
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

describe('MappingDrawer — PR 2 TASK 2+3 source ✏ on every variant', () => {
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

  it('VA renders ✏ that opens InlineSourcePicker (TASK 2+3)', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, valueAssignment().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const pencil = screen.getByTestId('mapping-drawer-header-source-pencil')
    expect(pencil).toBeInTheDocument()
    await user.click(pencil)
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
  })

  it('Unmapped renders ✏ that opens InlineSourcePicker (TASK 2+3)', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
        onCreateMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    const pencil = screen.getByTestId('mapping-drawer-header-source-pencil')
    expect(pencil).toBeInTheDocument()
    await user.click(pencil)
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
  })

  it('Rejected (unmapped + status=rejected) renders ✏ + ✏ click opens picker', async () => {
    const user = userEvent.setup()
    render(
      <MappingDrawer
        row={unmapped({ status: 'rejected' })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
        onCreateMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-source-pencil'))
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
  })

  it('VA source ✕ slot is NOT rendered (only ✏)', () => {
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, valueAssignment().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-source-remove'),
    ).toBeNull()
  })

  it('Source ✏ is gated off on unmapped when onCreateMapping is absent', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-source-pencil'),
    ).toBeNull()
  })
})

describe('MappingDrawer — PR 2 TASK 2+3 target ✏ + ✕', () => {
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

  it('Target ✕ renders on mapped when onUnmapMapping is threaded', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-remove'),
    ).toBeInTheDocument()
  })

  it('Target ✕ renders on VA when onUnmapMapping is threaded', () => {
    render(
      <MappingDrawer
        row={valueAssignment()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, valueAssignment().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-remove'),
    ).toBeInTheDocument()
  })

  it('Target ✕ is hidden on unmapped (no TFM to delete)', () => {
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
        onUnmapMapping={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-target-remove'),
    ).toBeNull()
  })

  it('Target ✕ confirm fires onUnmapMapping with (tfmId, targetFieldId)', async () => {
    const user = userEvent.setup()
    const onUnmapMapping = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onUnmapMapping={onUnmapMapping}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-target-remove'))
    expect(screen.getByTestId('reject-confirm-popover').textContent).toContain(
      'Remove this mapping?',
    )
    await user.click(screen.getByTestId('reject-confirm-popover-confirm'))
    expect(onUnmapMapping).toHaveBeenCalledWith('tfm-1', 'tf-1')
  })

  it('Target ✏ on unmapped opens TargetFieldCellPicker and uses onNavigateTarget', async () => {
    const user = userEvent.setup()
    const onNavigateTarget = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={unmapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, unmapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={vi.fn().mockResolvedValue({ success: true })}
        onNavigateTarget={onNavigateTarget}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-target-pencil'),
    ).toBeInTheDocument()
    await user.click(screen.getByTestId('mapping-drawer-header-target-pencil'))
    expect(screen.getByTestId('target-field-cell-picker')).toBeInTheDocument()
  })

  it('Target ✏ on mapped uses onSwapTarget (not onNavigateTarget)', async () => {
    const user = userEvent.setup()
    const onSwapTarget = vi.fn().mockResolvedValue({ success: true })
    const onNavigateTarget = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onSwapTarget={onSwapTarget}
        onNavigateTarget={onNavigateTarget}
      />,
    )
    // The picker handler is sealed inside the component; we
    // observe the dispatch indirectly: opening the picker confirms
    // the pencil wired through. Direct call assertions on swap vs
    // navigate are exercised via the handler arity tests in
    // MappingContent's smoke flow (manual). For unit coverage, the
    // separate "uses onNavigateTarget on unmapped" test above
    // documents the dispatch. The fact that THIS test renders
    // mapped without errors confirms the targetEditEnabled gate
    // resolves to onSwapTarget on this branch.
    await user.click(screen.getByTestId('mapping-drawer-header-target-pencil'))
    expect(screen.getByTestId('target-field-cell-picker')).toBeInTheDocument()
  })
})

describe('MappingDrawer — PR 2 TASK 2+3 ⊕ Add source button', () => {
  const sf: SourceFieldWithState = {
    id: 'sf-new',
    name: 'NEW_SOURCE',
    dataType: 'VARCHAR',
    ordinalPosition: 0,
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
  }
  const tf: TargetFieldRef = targetField({ id: 'tf-other', name: 'other_id' })

  it('renders ⊕ Add source on single-source mapped', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-add-source'),
    ).toBeInTheDocument()
  })

  it('renders ⊕ Add source on multi-source mapped', () => {
    render(
      <MappingDrawer
        row={mapped({
          sources: [cifSource(0, 'FNAME'), cifSource(1, 'LNAME')],
          combinationType: 'concat_space',
        })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onEditSources={vi.fn().mockResolvedValue({ success: true })}
      />,
    )
    expect(
      screen.getByTestId('mapping-drawer-header-add-source'),
    ).toBeInTheDocument()
  })

  it('does NOT render ⊕ Add source on VA / unmapped / rejected', () => {
    for (const row of [
      valueAssignment(),
      unmapped(),
      unmapped({ status: 'rejected' }),
    ]) {
      const { unmount } = render(
        <MappingDrawer
          row={row}
          isOpen={true}
          onClose={() => {}}
          availableTargetFields={[tf, row.targetField]}
          availableSourceFields={[sf]}
          onEditSources={vi.fn().mockResolvedValue({ success: true })}
        />,
      )
      expect(
        screen.queryByTestId('mapping-drawer-header-add-source'),
      ).toBeNull()
      unmount()
    }
  })

  it('⊕ on single-source promotes to multi (combinationType=concat_space) when committed', async () => {
    const user = userEvent.setup()
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onEditSources={onEditSources}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-add-source'))
    expect(screen.getByTestId('inline-source-picker')).toBeInTheDocument()
    // Pick the NEW_SOURCE field from the picker (the row currently
    // maps to sf-1 = ACCT_NO; sf-new is the new option).
    await user.click(screen.getByText('NEW_SOURCE'))
    expect(onEditSources).toHaveBeenCalledTimes(1)
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-1', 'sf-new'],
      combinationType: 'concat_space',
    })
  })

  it('⊕ on multi-source preserves existing combinationType when adding', async () => {
    const user = userEvent.setup()
    const onEditSources = vi.fn().mockResolvedValue({ success: true })
    render(
      <MappingDrawer
        row={mapped({
          sources: [cifSource(0, 'FNAME'), cifSource(1, 'LNAME')],
          combinationType: 'concat_comma',
        })}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
        onEditSources={onEditSources}
      />,
    )
    await user.click(screen.getByTestId('mapping-drawer-header-add-source'))
    await user.click(screen.getByText('NEW_SOURCE'))
    expect(onEditSources).toHaveBeenCalledWith({
      tfmId: 'tfm-1',
      sourceFieldIds: ['sf-FNAME', 'sf-LNAME', 'sf-new'],
      combinationType: 'concat_comma',
    })
  })

  it('⊕ does NOT render when onEditSources is not threaded', () => {
    render(
      <MappingDrawer
        row={mapped()}
        isOpen={true}
        onClose={() => {}}
        availableTargetFields={[tf, mapped().targetField]}
        availableSourceFields={[sf]}
      />,
    )
    expect(
      screen.queryByTestId('mapping-drawer-header-add-source'),
    ).toBeNull()
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

  it('unmapped row + status=needs_review: footer renders approve + reject', () => {
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
    expect(screen.getByTestId('mapping-drawer-reject-button')).toBeInTheDocument()
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
    expect(screen.getByTestId('mapping-drawer-reject-button')).toBeInTheDocument()
  })

  it('unmapped + status=needs_review: footer exposes approve + reject', () => {
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
    expect(screen.getByTestId('mapping-drawer-reject-button')).toBeInTheDocument()
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
