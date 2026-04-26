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

describe('SourceFieldPicker — same-table constraint', () => {
  it('hides cross-table groups once a field is selected', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const groups = screen.getAllByTestId('source-field-picker-group')
    expect(groups).toHaveLength(1)
    expect(groups[0].getAttribute('data-source-table-name')).toBe('CIF_MASTER')
  })

  it('renders the muted footer note when constraint hides groups', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    const note = screen.getByTestId('source-field-picker-constraint-note')
    expect(note.textContent).toContain('Cross-table mappings ship in Phase 4a-3')
    expect(note.textContent).toContain(
      'Fields from other source tables are hidden',
    )
  })

  it('does NOT render the constraint note when nothing selected', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('source-field-picker-constraint-note'),
    ).toBeNull()
  })

  it('does NOT render constraint note when all fields share a single table', () => {
    render(
      <SourceFieldPicker
        availableSourceFields={cifFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    expect(
      screen.queryByTestId('source-field-picker-constraint-note'),
    ).toBeNull()
  })

  it('releases constraint instantly when last chip removed (controlled re-render)', () => {
    const { rerender } = render(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={['sf-cif-1']}
        onSelectedChange={() => {}}
      />,
    )
    expect(screen.getAllByTestId('source-field-picker-group')).toHaveLength(1)
    rerender(
      <SourceFieldPicker
        availableSourceFields={allFields}
        selectedIds={[]}
        onSelectedChange={() => {}}
      />,
    )
    expect(screen.getAllByTestId('source-field-picker-group')).toHaveLength(2)
    expect(
      screen.queryByTestId('source-field-picker-constraint-note'),
    ).toBeNull()
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
