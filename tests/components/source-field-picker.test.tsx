import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SourceFieldPicker } from '@/app/app/projects/[projectId]/mapping/redesign/components/SourceFieldPicker'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — `SourceFieldPicker` component tests.
// ─────────────────────────────────────────────────────────────────────────────

function field(overrides: Partial<SourceFieldWithState> = {}): SourceFieldWithState {
  return {
    id: 'sf-default',
    name: 'FIELD_A',
    dataType: 'VARCHAR',
    ordinalPosition: 0,
    sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: ['alpha', 'bravo'],
    isAcknowledged: false,
    isRejected: false,
    aiReasoning: null,
    confidence: null,
    ...overrides,
  }
}

const cifFields: SourceFieldWithState[] = [
  field({ id: 'sf-cif-1', name: 'FIRST_NAME', ordinalPosition: 0 }),
  field({ id: 'sf-cif-2', name: 'LAST_NAME', ordinalPosition: 1 }),
  field({ id: 'sf-cif-3', name: 'CIF_NO', ordinalPosition: 2, mappingStatus: 'mapped' }),
]

const acctFields: SourceFieldWithState[] = [
  field({
    id: 'sf-acct-1',
    name: 'ACCT_NO',
    ordinalPosition: 0,
    sourceTable: { id: 'st-acct', name: 'ACCT_MASTER' },
  }),
  field({
    id: 'sf-acct-2',
    name: 'BALANCE',
    ordinalPosition: 1,
    sourceTable: { id: 'st-acct', name: 'ACCT_MASTER' },
  }),
]

const allFields: SourceFieldWithState[] = [...cifFields, ...acctFields]

describe('SourceFieldPicker — empty state', () => {
  it('renders no-schema empty state when availableSourceFields is empty', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={[]}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(
      screen.getByTestId('source-field-picker-empty-no-schema'),
    ).toBeInTheDocument()
  })

  it('shows "No source fields selected yet." when nothing chosen', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(
      screen.getByTestId('source-field-picker-chips-empty'),
    ).toBeInTheDocument()
  })
})

describe('SourceFieldPicker — group rendering', () => {
  it('renders a group per source table in server order', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('source-field-picker-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute('data-source-table-name')).toBe('CIF_MASTER')
    expect(groups[1].getAttribute('data-source-table-name')).toBe('ACCT_MASTER')
  })

  it('renders all fields within a group in server order', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('source-field-picker-group')
    const cifNames = within(groups[0])
      .getAllByTestId('source-field-picker-field')
      .map((el) => within(el).getByText(/FIRST_NAME|LAST_NAME|CIF_NO/).textContent)
    expect(cifNames).toEqual(['FIRST_NAME', 'LAST_NAME', 'CIF_NO'])
  })

  it('renders selection indicator with isSelected=false initially', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    for (const f of fields) {
      expect(f.getAttribute('aria-pressed')).toBe('false')
      expect(f.getAttribute('data-is-selected')).toBe('false')
    }
  })
})

describe('SourceFieldPicker — selection toggle', () => {
  it('clicking an unselected field calls onSelectedChange with id appended', async () => {
    const onSelectedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={onSelectedChange}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    const firstName = fields.find(
      (f) => f.getAttribute('data-source-field-id') === 'sf-cif-1',
    )!
    await user.click(firstName)
    expect(onSelectedChange).toHaveBeenCalledWith(['sf-cif-1'])
  })

  it('clicking a selected field calls onSelectedChange with id removed', async () => {
    const onSelectedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-cif-2']}
        onSelectedChange={onSelectedChange}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    const firstName = fields.find(
      (f) => f.getAttribute('data-source-field-id') === 'sf-cif-1',
    )!
    await user.click(firstName)
    expect(onSelectedChange).toHaveBeenCalledWith(['sf-cif-2'])
  })

  it('appending preserves selection order (first-picked = ordinal 0)', async () => {
    const onSelectedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-2']}
        onSelectedChange={onSelectedChange}
      />,
    )
    const firstName = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(firstName)
    expect(onSelectedChange).toHaveBeenCalledWith(['sf-cif-2', 'sf-cif-1'])
  })

  it('selected field renders aria-pressed=true and selected styling', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const fields = screen.getAllByTestId('source-field-picker-field')
    const firstName = fields.find(
      (f) => f.getAttribute('data-source-field-id') === 'sf-cif-1',
    )!
    expect(firstName.getAttribute('aria-pressed')).toBe('true')
    expect(firstName.getAttribute('data-is-selected')).toBe('true')
    expect(firstName.className).toContain('bg-blue-50')
  })
})

describe('SourceFieldPicker — chips strip', () => {
  it('renders one chip per selected field in selection order', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-2', 'sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const chips = screen.getAllByTestId('source-field-picker-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].getAttribute('data-source-field-id')).toBe('sf-cif-2')
    expect(chips[1].getAttribute('data-source-field-id')).toBe('sf-cif-1')
  })

  it('clicking chip ✕ calls onSelectedChange with that id removed', async () => {
    const onSelectedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-cif-2']}
        onSelectedChange={onSelectedChange}
      />,
    )
    const removeButtons = screen.getAllByTestId('source-field-picker-chip-remove')
    await user.click(removeButtons[0])
    expect(onSelectedChange).toHaveBeenCalledWith(['sf-cif-2'])
  })

  it('chip remove button has aria-label "Remove <fieldName>"', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const remove = screen.getByTestId('source-field-picker-chip-remove')
    expect(remove.getAttribute('aria-label')).toBe('Remove FIRST_NAME')
  })
})

describe('SourceFieldPicker — cross-table support (Phase 4a-3)', () => {
  it('keeps every source-table group visible after a field is selected (no hiding)', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('source-field-picker-group')
    expect(groups).toHaveLength(2)
    expect(groups[0].getAttribute('data-source-table-name')).toBe('CIF_MASTER')
    expect(groups[1].getAttribute('data-source-table-name')).toBe('ACCT_MASTER')
  })

  it('does NOT render the same-table-constraint footer note (removed in 4a-3)', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('source-field-picker-constraint-note'),
    ).toBeNull()
  })

  it('selecting a field from a non-dominant table is allowed and produces a cross-table chip layout', () => {
    const onSelectedChange = vi.fn()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={onSelectedChange}
      />,
    )
    // Pick a field from a different source table.
    const acctField = screen
      .getAllByTestId('source-field-picker-field')
      .find((el) => el.getAttribute('data-source-field-id') === 'sf-acct-1')!
    fireEvent.click(acctField)
    expect(onSelectedChange).toHaveBeenCalledWith(['sf-cif-1', 'sf-acct-1'])
  })
})

describe('SourceFieldPicker — selected chip grouping (Cycle 1)', () => {
  it('flat single-row chip strip when all chips share one source table', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-cif-2']}
        onSelectedChange={() => {}}
      />,
    )
    const wrapper = screen.getByTestId('source-field-picker-chips')
    expect(wrapper.getAttribute('data-cross-table')).toBe('false')
    // No per-table group containers in the single-table case.
    expect(
      screen.queryByTestId('source-field-picker-chips-group'),
    ).toBeNull()
    // No legacy DOMINANT/JOINED testids — Cycle 1 removed the primacy
    // distinction.
    expect(
      screen.queryByTestId('source-field-picker-chips-dominant'),
    ).toBeNull()
    expect(
      screen.queryByTestId('source-field-picker-chips-joined'),
    ).toBeNull()
  })

  it('groups chips under per-source-table headers when 2+ source tables present', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-acct-1']}
        onSelectedChange={() => {}}
      />,
    )
    const wrapper = screen.getByTestId('source-field-picker-chips')
    expect(wrapper.getAttribute('data-cross-table')).toBe('true')

    // Cycle 1 — no DOMINANT / JOINED testids; replaced by a single
    // per-table group testid keyed on `data-source-table-id`.
    expect(
      screen.queryByTestId('source-field-picker-chips-dominant'),
    ).toBeNull()
    expect(
      screen.queryByTestId('source-field-picker-chips-joined'),
    ).toBeNull()

    const groups = screen.getAllByTestId('source-field-picker-chips-group')
    expect(groups).toHaveLength(2)

    const acctGroup = groups.find(
      (g) => g.getAttribute('data-source-table-id') === 'st-acct',
    )!
    expect(acctGroup.textContent).toMatch(/ACCT_MASTER/)
    const acctChips = within(acctGroup).getAllByTestId(
      'source-field-picker-chip',
    )
    expect(acctChips.map((c) => c.getAttribute('data-source-field-id'))).toEqual(
      ['sf-acct-1'],
    )

    const cifGroup = groups.find(
      (g) => g.getAttribute('data-source-table-id') === 'st-cif',
    )!
    expect(cifGroup.textContent).toMatch(/CIF_MASTER/)
    const cifChips = within(cifGroup).getAllByTestId(
      'source-field-picker-chip',
    )
    expect(cifChips.map((c) => c.getAttribute('data-source-field-id'))).toEqual(
      ['sf-cif-1'],
    )
  })

  it('group order is alphabetical by source-table name regardless of selection order', () => {
    // Selection order: CIF first, then ACCT — ACCT should still
    // appear first because alphabetical order comes from
    // availableSourceFields (server canonical order).
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-acct-1', 'sf-cif-2']}
        onSelectedChange={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('source-field-picker-chips-group')
    const orderedTableIds = groups.map((g) =>
      g.getAttribute('data-source-table-id'),
    )
    // availableSourceFields lists CIF fields first (cifFields ordered
    // before acctFields). Server canonical order — verify that's what
    // drives header ordering, NOT the selection order.
    expect(orderedTableIds).toEqual(['st-cif', 'st-acct'])
  })

  it('within each table group, chips preserve selection order', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-acct-2', 'sf-acct-1']}
        onSelectedChange={() => {}}
      />,
    )
    const acctGroup = screen
      .getAllByTestId('source-field-picker-chips-group')
      .find((g) => g.getAttribute('data-source-table-id') === 'st-acct')!
    const ids = within(acctGroup)
      .getAllByTestId('source-field-picker-chip')
      .map((c) => c.getAttribute('data-source-field-id'))
    // Selection order preserved within the group: BALANCE before ACCT_NO.
    expect(ids).toEqual(['sf-acct-2', 'sf-acct-1'])
  })

  it('chips expose data-source-table-id for downstream styling/testing', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1', 'sf-acct-1']}
        onSelectedChange={() => {}}
      />,
    )
    const chips = screen.getAllByTestId('source-field-picker-chip')
    const tableIds = chips.map((c) => c.getAttribute('data-source-table-id'))
    // Group order is alphabetical by table name — CIF before ACCT
    // would naturally surface as ['st-cif', 'st-acct'] when the
    // server canonical order has CIF fields first; sort to make the
    // assertion order-independent for this surface check.
    expect(tableIds.sort()).toEqual(['st-acct', 'st-cif'])
  })
})

describe('SourceFieldPicker — search', () => {
  it('search input is debounced — filter applies after SEARCH_DEBOUNCE_MS', async () => {
    vi.useFakeTimers()
    try {
      render(
        <SourceFieldPicker
          availableSourceFields={allFields}
          selectedIds={[]}
          onSelectedChange={() => {}}
        />,
      )
      const input = screen.getByTestId('source-field-picker-search')
      fireEvent.change(input, { target: { value: 'BALANCE' } })
      expect(
        screen.queryAllByTestId('source-field-picker-field'),
      ).toHaveLength(allFields.length)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const remaining = screen.getAllByTestId('source-field-picker-field')
      expect(remaining).toHaveLength(1)
      expect(remaining[0].getAttribute('data-source-field-id')).toBe('sf-acct-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('search matches source table name (case-insensitive)', async () => {
    vi.useFakeTimers()
    try {
      render(
        <SourceFieldPicker
          availableSourceFields={allFields}
          selectedIds={[]}
          onSelectedChange={() => {}}
        />,
      )
      fireEvent.change(screen.getByTestId('source-field-picker-search'), {
        target: { value: 'acct' },
      })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      const visible = screen.getAllByTestId('source-field-picker-field')
      const ids = visible.map((el) => el.getAttribute('data-source-field-id'))
      expect(ids).toEqual(['sf-acct-1', 'sf-acct-2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('search empty results renders no-match state', async () => {
    vi.useFakeTimers()
    try {
      render(
        <SourceFieldPicker
          availableSourceFields={allFields}
          selectedIds={[]}
          onSelectedChange={() => {}}
        />,
      )
      fireEvent.change(screen.getByTestId('source-field-picker-search'), {
        target: { value: 'zzz_never_matches' },
      })
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(
        screen.getByTestId('source-field-picker-empty-no-match'),
      ).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SourceFieldPicker — disabled state', () => {
  it('disables all interactive elements when disabled=true', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
        disabled
      />,
    )
    expect(screen.getByTestId('source-field-picker-search')).toBeDisabled()
    for (const f of screen.getAllByTestId('source-field-picker-field')) {
      expect(f).toBeDisabled()
    }
    for (const r of screen.getAllByTestId('source-field-picker-chip-remove')) {
      expect(r).toBeDisabled()
    }
  })

  it('does not call onSelectedChange when clicked while disabled', async () => {
    const onSelectedChange = vi.fn()
    const user = userEvent.setup()
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={onSelectedChange}
        disabled
      />,
    )
    const fieldEl = screen
      .getAllByTestId('source-field-picker-field')
      .find((f) => f.getAttribute('data-source-field-id') === 'sf-cif-1')!
    await user.click(fieldEl)
    expect(onSelectedChange).not.toHaveBeenCalled()
  })
})

describe('SourceFieldPicker — tooltip + a11y', () => {
  it('field button is wired to its tooltip via aria-describedby', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={[
          field({ id: 'sf-x', name: 'EMAIL', dataType: 'VARCHAR(255)' }),
        ]}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    const fieldEl = screen.getByTestId('source-field-picker-field')
    const tooltipId = fieldEl.getAttribute('aria-describedby')!
    const tooltip = document.getElementById(tooltipId)
    expect(tooltip).not.toBeNull()
    expect(tooltip!.getAttribute('role')).toBe('tooltip')
    expect(tooltip!.textContent).toContain('VARCHAR(255)')
  })

  it('tooltip renders sample values when present', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={[
          field({
            id: 'sf-x',
            name: 'EMAIL',
            sampleValues: ['a@x.com', 'b@y.com'],
          }),
        ]}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(screen.getByText(/a@x\.com, b@y\.com/)).toBeInTheDocument()
  })

  it('tooltip renders "No sample values profiled" when array empty', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={[field({ id: 'sf-x', sampleValues: [] })]}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(screen.getByText('No sample values profiled')).toBeInTheDocument()
  })
})

describe('SourceFieldPicker — light-mode invariant', () => {
  it('rendered HTML contains no dark: tailwind modifiers', () => {
    const { container } = render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Phase A (post-Phase-3) — picker rows render an inline `[TABLE_NAME]` badge
// before the field name, mirroring the redesigned mapping page's row chrome.
// Section headers stay (Option α): the badge plus the header gives a per-row
// disambiguator that makes the picker readable even when the user has
// scrolled past the section boundary.
// ─────────────────────────────────────────────────────────────────────────────
describe('SourceFieldPicker — inline table badge on every row (Phase A)', () => {
  function getRow(id: string): HTMLButtonElement {
    const el = document.querySelector(
      `[data-testid="source-field-picker-field"][data-source-field-id="${id}"]`,
    )
    if (!(el instanceof HTMLButtonElement)) {
      throw new Error(`Row not found for id=${id}`)
    }
    return el
  }

  it('renders the source-table name as a TableBadge inside every field row', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    // CIF_MASTER fields: badge text matches sourceTable.name.
    const cifRow = getRow('sf-cif-1')
    expect(cifRow.textContent).toContain('CIF_MASTER')
    expect(cifRow.textContent).toContain('FIRST_NAME')
    // ACCT_MASTER fields: badge text matches sourceTable.name.
    const acctRow = getRow('sf-acct-1')
    expect(acctRow.textContent).toContain('ACCT_MASTER')
    expect(acctRow.textContent).toContain('ACCT_NO')
  })

  it('field-name span title exposes "<table> · <field>" for hover overflow disambiguation', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    // Two elements inside a row carry a `title`: the TableBadge
    // (table name only) and the truncated field-name span (table ·
    // field). Use `within().getByTitle` to assert the latter exists
    // without depending on which appears first in the DOM.
    const cifRow = getRow('sf-cif-1')
    expect(
      within(cifRow).getByTitle('CIF_MASTER · FIRST_NAME'),
    ).toBeInTheDocument()
  })

  it('badge appears even when the row is selected (badge is identity, not state)', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const row = getRow('sf-cif-1')
    expect(row.getAttribute('aria-pressed')).toBe('true')
    // The selected row still surfaces the table name in its body.
    expect(row.textContent).toContain('CIF_MASTER')
  })

  it('badge appears for EVERY row across all groups (no row left behind)', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    const rows = screen.getAllByTestId('source-field-picker-field')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const id = row.getAttribute('data-source-field-id')
      const expected = allFields.find((f) => f.id === id)?.sourceTable.name
      expect(expected).toBeDefined()
      expect(row.textContent).toContain(expected as string)
    }
  })
})
