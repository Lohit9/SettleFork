import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineSourcePicker } from '@/app/app/projects/[projectId]/mapping/redesign/components/InlineSourcePicker'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// InlineSourcePicker — Phase 4-polish-3 Block A + Phase A refit unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked behavior:
//   • Wraps `SourceFieldPicker` in a portal anchored to a row cell.
//   • Explicit Save / Cancel footer (replaces the original commit-on-
//     close model). Save fires `onCommit` and closes the picker on
//     success; on failure the picker stays open so the user can retry.
//   • Esc, click-outside, and Cancel all close the picker WITHOUT
//     committing.
//   • Empty selection disables Save (with a tooltip hint) but never
//     blocks Cancel — the dedicated reject (✗) row button handles
//     "remove this mapping".
//   • In-flight save shows a spinner; Cancel is disabled and Esc /
//     click-outside are ignored to prevent racing the wrapper.
//
// The picker body itself (`SourceFieldPicker`) has its own dedicated
// test file; here we exercise the inline wrapper's specific contract.

// ── Fixtures ────────────────────────────────────────────────────────────────

function field(overrides: Partial<SourceFieldWithState> = {}): SourceFieldWithState {
  return {
    id: 'sf-1',
    name: 'COL_A',
    dataType: 'VARCHAR(50)',
    ordinalPosition: 1,
    sourceTable: { id: 'st-1', name: 'ACCT_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: [],
    isAcknowledged: false,
    isRejected: false,
    aiReasoning: null,
    confidence: null,
    ...overrides,
  }
}

const FIELDS: SourceFieldWithState[] = [
  field({ id: 'sf-1', name: 'COL_A', ordinalPosition: 1 }),
  field({ id: 'sf-2', name: 'COL_B', ordinalPosition: 2 }),
  field({ id: 'sf-3', name: 'COL_C', ordinalPosition: 3 }),
]

// ── Anchor harness ──────────────────────────────────────────────────────────

interface HarnessProps {
  initialIds: string[]
  onCommit: (ids: string[]) => Promise<{ success: boolean }>
  onClose: () => void
  fields?: SourceFieldWithState[]
}

function Harness({ initialIds, onCommit, onClose, fields = FIELDS }: HarnessProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div>
      <button ref={anchorRef} type="button" data-testid="anchor">
        anchor
      </button>
      <InlineSourcePicker
        anchorRef={anchorRef}
        initialSourceFieldIds={initialIds}
        availableSourceFields={fields}
        onCommit={onCommit}
        onClose={onClose}
      />
    </div>
  )
}

// `SourceFieldPicker` renders each field row as a toggle button
// (`<button aria-pressed=…>`). Helper to grab a row by its
// `data-source-field-id` so the tests don't depend on accessible-name
// resolution (the row also carries a tooltip + selection indicator
// which can confuse `getByRole('checkbox', { name: … })`).
function getFieldRow(id: string): HTMLButtonElement {
  const el = document.querySelector(
    `[data-testid="source-field-picker-field"][data-source-field-id="${id}"]`,
  )
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Field row not found for id=${id}`)
  }
  return el
}

function getSaveButton(): HTMLButtonElement {
  return screen.getByTestId('inline-source-picker-save') as HTMLButtonElement
}

function getCancelButton(): HTMLButtonElement {
  return screen.getByTestId('inline-source-picker-cancel') as HTMLButtonElement
}

// Default success commit — the wrapper's happy path.
function commitSuccess(): Promise<{ success: boolean }> {
  return Promise.resolve({ success: true })
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InlineSourcePicker — render + portal hosting', () => {
  it('renders the picker portal under document.body (NOT inside the parent)', async () => {
    const { container } = render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    const picker = await screen.findByTestId('inline-source-picker')
    // Defense-in-depth: portal contract pins the picker outside the
    // calling tree so its z-index + position-fixed paint above the
    // row scroll container without a stacking-context fight.
    expect(container.contains(picker)).toBe(false)
    expect(document.body.contains(picker)).toBe(true)
  })

  it('uses role="dialog" and the locked aria-label', async () => {
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    const picker = await screen.findByTestId('inline-source-picker')
    expect(picker.getAttribute('role')).toBe('dialog')
    expect(picker.getAttribute('aria-label')).toBe('Edit source fields')
  })

  it('renders the Save / Cancel footer at the bottom of the popover', async () => {
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    expect(screen.getByTestId('inline-source-picker-footer')).toBeInTheDocument()
    expect(screen.getByTestId('inline-source-picker-save')).toBeInTheDocument()
    expect(screen.getByTestId('inline-source-picker-cancel')).toBeInTheDocument()
  })

  it('footer is anchored OUTSIDE the scrollable list wrapper so it stays put on scroll', async () => {
    // Sticky-footer contract: the list (and its parent scroll
    // wrapper) is a SIBLING of the footer, not an ancestor. If a
    // refactor accidentally nests the footer inside the scroll
    // container, scrolling the list would carry the footer along
    // with it and the user would lose access to Save/Cancel — the
    // exact bug Phase A's first canary surfaced. Use a many-field
    // fixture so even if the list extends past its `max-h-72`
    // internal scroll the assertion still pins structural
    // separation (not just initial visibility).
    const manyFields: SourceFieldWithState[] = Array.from(
      { length: 60 },
      (_, i) =>
        field({
          id: `sf-many-${i}`,
          name: `COL_${i}`,
          ordinalPosition: i,
        }),
    )
    render(
      <Harness
        initialIds={['sf-many-0']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
        fields={manyFields}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    const footer = screen.getByTestId('inline-source-picker-footer')
    const list = screen.getByTestId('source-field-picker-list')
    expect(footer).toBeInTheDocument()
    expect(list.contains(footer)).toBe(false)
    // Defense-in-depth: also assert the footer is NOT inside the
    // SourceFieldPicker root. The SourceFieldPicker subtree IS the
    // scrolling sibling — the footer must live one level above it.
    const pickerBody = screen.getByTestId('source-field-picker')
    expect(pickerBody.contains(footer)).toBe(false)
  })
})

describe('InlineSourcePicker — Save button states', () => {
  it('Save is disabled at mount when no changes are pending', async () => {
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    const save = getSaveButton()
    expect(save).toBeDisabled()
    // Tooltip hint surfaces via the title attribute.
    expect(save.getAttribute('title')).toBe('No changes to save')
    expect(save.textContent).toBe('Save')
  })

  it('Save is enabled with a count after the user toggles a row', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    const save = getSaveButton()
    expect(save).toBeEnabled()
    expect(save.textContent).toBe('Save (1 change)')
    expect(save.getAttribute('title')).toBeNull()
  })

  it('Save copy pluralises correctly: "Save (2 changes)"', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getFieldRow('sf-3'))
    expect(getSaveButton().textContent).toBe('Save (2 changes)')
  })

  it('Save count includes both ADDITIONS and REMOVALS (symmetric difference)', async () => {
    // Initial: [sf-1, sf-2]; after toggles: [sf-2, sf-3]
    //   removed sf-1 (1) + added sf-3 (1) = 2 changes
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1', 'sf-2']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1')) // -1
    await user.click(getFieldRow('sf-3')) // +1
    expect(getSaveButton().textContent).toBe('Save (2 changes)')
  })

  it('Save is disabled when the user reverts to the initial set', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2')) // adds
    expect(getSaveButton()).toBeEnabled()
    await user.click(getFieldRow('sf-2')) // removes — back to initial
    const save = getSaveButton()
    expect(save).toBeDisabled()
    expect(save.getAttribute('title')).toBe('No changes to save')
  })

  it('Save is disabled when the pending selection is empty (even though changes exist)', async () => {
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1')) // empties selection
    const save = getSaveButton()
    expect(save).toBeDisabled()
    // The empty-selection hint takes precedence over the
    // no-changes-to-save hint.
    expect(save.getAttribute('title')).toBe('Select at least one source field')
  })

  it('Save is disabled at mount when the row starts unmapped (initial empty)', async () => {
    render(
      <Harness initialIds={[]} onCommit={commitSuccess} onClose={vi.fn()} />,
    )
    await screen.findByTestId('inline-source-picker')
    const save = getSaveButton()
    expect(save).toBeDisabled()
    // Empty-selection hint takes precedence over the no-changes hint
    // — "select something" is the actionable next step regardless of
    // whether the user just opened the picker or just cleared it.
    expect(save.getAttribute('title')).toBe('Select at least one source field')
  })
})

describe('InlineSourcePicker — Save click commit flow', () => {
  it('Save click fires onCommit with the pending ids in pick order', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getSaveButton())
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    expect(onCommit).toHaveBeenCalledWith(['sf-1', 'sf-2'])
  })

  it('Save click that succeeds closes the picker via onClose', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getSaveButton())
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('Save click that fails leaves the picker open and does NOT call onClose', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: false })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getSaveButton())
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
    // Picker still mounted; onClose never fired.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('inline-source-picker')).toBeInTheDocument()
  })

  it('Save click while the wrapper is in flight shows the spinner and disables Cancel', async () => {
    let resolveCommit: ((r: { success: boolean }) => void) | null = null
    const onCommit = vi.fn().mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveCommit = resolve
        }),
    )
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getSaveButton())
    // Spinner is rendered; both buttons are disabled.
    await screen.findByTestId('inline-source-picker-save-spinner')
    expect(getSaveButton()).toBeDisabled()
    expect(getCancelButton()).toBeDisabled()
    // Resolve the wrapper to clean up the in-flight promise so the
    // test does not leak a pending microtask.
    act(() => {
      resolveCommit?.({ success: true })
    })
    await waitFor(() => {
      expect(
        screen.queryByTestId('inline-source-picker-save-spinner'),
      ).toBeNull()
    })
  })
})

describe('InlineSourcePicker — Cancel button', () => {
  it('Cancel click closes the picker without firing onCommit', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    // Pending changes do NOT trigger commit-on-cancel.
    await user.click(getFieldRow('sf-2'))
    await user.click(getCancelButton())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Cancel is enabled even when the pending selection is empty', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1')) // empties selection
    expect(getCancelButton()).toBeEnabled()
    await user.click(getCancelButton())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel is enabled at mount with no pending changes', async () => {
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    expect(getCancelButton()).toBeEnabled()
  })
})

describe('InlineSourcePicker — Esc + click-outside fire Cancel semantics', () => {
  it('Esc closes the picker WITHOUT committing pending changes', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2')) // dirty
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('click-outside closes the picker WITHOUT committing pending changes', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2')) // dirty
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Esc with empty selection ALSO cancels (no empty-error block)', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1')) // empties selection
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    // Vestigial empty-error must NOT render anywhere.
    expect(
      screen.queryByTestId('inline-source-picker-empty-error'),
    ).toBeNull()
  })

  it('click-outside with empty selection ALSO cancels (no empty-error block)', async () => {
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1'))
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
    expect(
      screen.queryByTestId('inline-source-picker-empty-error'),
    ).toBeNull()
  })

  it('Esc during an in-flight save is IGNORED (cannot race the wrapper)', async () => {
    let resolveCommit: ((r: { success: boolean }) => void) | null = null
    const onCommit = vi.fn().mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveCommit = resolve
        }),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-2'))
    await user.click(getSaveButton())
    await screen.findByTestId('inline-source-picker-save-spinner')
    // Esc fires during in-flight save — should NOT close.
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    // Resolve to clean up.
    act(() => {
      resolveCommit?.({ success: true })
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})

describe('InlineSourcePicker — initial selection lifecycle', () => {
  it('mounts with the supplied initial ids pre-selected (multi-source case)', async () => {
    render(
      <Harness
        initialIds={['sf-1', 'sf-3']}
        onCommit={commitSuccess}
        onClose={vi.fn()}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    // Each row is a toggle button; selection state is exposed via
    // both `aria-pressed` and the `data-is-selected` attribute. Pin
    // both surfaces so a refactor that drops one still trips CI.
    expect(getFieldRow('sf-1').getAttribute('aria-pressed')).toBe('true')
    expect(getFieldRow('sf-2').getAttribute('aria-pressed')).toBe('false')
    expect(getFieldRow('sf-3').getAttribute('aria-pressed')).toBe('true')
    expect(getFieldRow('sf-1').getAttribute('data-is-selected')).toBe('true')
    expect(getFieldRow('sf-2').getAttribute('data-is-selected')).toBe('false')
    expect(getFieldRow('sf-3').getAttribute('data-is-selected')).toBe('true')
  })

  it('mounts with EMPTY initial ids (unmapped → mapped flow)', async () => {
    render(
      <Harness initialIds={[]} onCommit={commitSuccess} onClose={vi.fn()} />,
    )
    await screen.findByTestId('inline-source-picker')
    // Save disabled (no changes); Cancel enabled.
    expect(getSaveButton()).toBeDisabled()
    expect(getCancelButton()).toBeEnabled()
  })
})

describe('InlineSourcePicker — clicking the anchor', () => {
  it('clicking the anchor does NOT fire onClose — parent owns re-open semantics', async () => {
    // Mirrors the RejectConfirmPopover anchor-contains contract: the
    // picker's click-outside handler explicitly excludes the anchor
    // so a click on the trigger doesn't immediately re-fire close
    // and stack with a parent re-open. Pin so a refactor that drops
    // the anchor-contains check shows up in CI.
    const onCommit = vi.fn().mockResolvedValue({ success: true })
    const onClose = vi.fn()
    render(
      <Harness
        initialIds={['sf-1']}
        onCommit={onCommit}
        onClose={onClose}
      />,
    )
    await screen.findByTestId('inline-source-picker')
    const anchor = screen.getByTestId('anchor')
    act(() => {
      fireEvent.mouseDown(anchor)
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
