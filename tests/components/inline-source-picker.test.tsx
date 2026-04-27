import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineSourcePicker } from '@/app/app/projects/[projectId]/mapping/redesign/components/InlineSourcePicker'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// InlineSourcePicker — Phase 4-polish-3 Block A unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked behavior:
//   • Wraps `SourceFieldPicker` in a portal anchored to a row cell.
//   • Commit-on-close: fires `onCommit` ONLY when selection changes
//     vs the initial set; always fires `onClose`.
//   • Empty-selection guard: blocks close + surfaces inline error.
//   • Esc + click-outside both attempt close (subject to guard).
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
  onCommit: (ids: string[]) => void
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InlineSourcePicker — render + portal hosting', () => {
  it('renders the picker portal under document.body (NOT inside the parent)', async () => {
    const { container } = render(
      <Harness
        initialIds={['sf-1']}
        onCommit={vi.fn()}
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
        onCommit={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const picker = await screen.findByTestId('inline-source-picker')
    expect(picker.getAttribute('role')).toBe('dialog')
    expect(picker.getAttribute('aria-label')).toBe('Edit source fields')
  })
})

describe('InlineSourcePicker — commit-on-close contract', () => {
  it('Esc with NO changes fires onClose only — onCommit is NOT called', async () => {
    const onCommit = vi.fn()
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
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Esc AFTER toggling a row fires onCommit with the new selection THEN onClose', async () => {
    const onCommit = vi.fn()
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
    // Add sf-2 by clicking its row (each row is a toggle button with
    // `aria-pressed`; we use the data-source-field-id selector so the
    // test does not depend on accessible-name resolution).
    await user.click(getFieldRow('sf-2'))
    await user.keyboard('{Escape}')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(['sf-1', 'sf-2'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('click-outside fires the same commit-on-close path as Esc', async () => {
    const onCommit = vi.fn()
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
    // Dispatch mousedown on document.body to simulate click-outside
    // (the picker listens via `document.addEventListener('mousedown', ...)`).
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(onCommit).toHaveBeenCalledWith(['sf-1', 'sf-2'])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggling a source ON and back OFF fires onClose only — selection matches initial', async () => {
    const onCommit = vi.fn()
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
    await user.click(getFieldRow('sf-2')) // adds sf-2
    await user.click(getFieldRow('sf-2')) // removes sf-2 — back to ['sf-1']
    await user.keyboard('{Escape}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('InlineSourcePicker — empty-selection guard', () => {
  it('Esc with empty selection blocks close AND surfaces the inline error', async () => {
    const onCommit = vi.fn()
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
    await user.click(getFieldRow('sf-1')) // remove the only source
    await user.keyboard('{Escape}')
    // Picker stays open; neither callback fires.
    expect(onClose).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    // Inline error surfaces with locked copy.
    const error = await screen.findByTestId(
      'inline-source-picker-empty-error',
    )
    expect(error.textContent).toBe('Select at least one source field')
    expect(error.getAttribute('role')).toBe('alert')
  })

  it('clearing the error: re-selecting a source dismisses the error message', async () => {
    const user = userEvent.setup()
    render(
      <Harness initialIds={['sf-1']} onCommit={vi.fn()} onClose={vi.fn()} />,
    )
    await screen.findByTestId('inline-source-picker')
    await user.click(getFieldRow('sf-1')) // empties selection
    await user.keyboard('{Escape}') // surfaces error
    await screen.findByTestId('inline-source-picker-empty-error')
    // Selecting a source clears the error.
    await user.click(getFieldRow('sf-2'))
    expect(
      screen.queryByTestId('inline-source-picker-empty-error'),
    ).toBeNull()
  })

  it('click-outside with empty selection ALSO blocks close', async () => {
    const onCommit = vi.fn()
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
    expect(onClose).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(
      screen.getByTestId('inline-source-picker-empty-error'),
    ).toBeInTheDocument()
  })
})

describe('InlineSourcePicker — initial selection lifecycle', () => {
  it('mounts with the supplied initial ids pre-selected (multi-source case)', async () => {
    render(
      <Harness
        initialIds={['sf-1', 'sf-3']}
        onCommit={vi.fn()}
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

  it('mounts with EMPTY initial ids (unmapped → mapped flow); the empty-error is NOT shown until close attempted', async () => {
    // The error is purely a "you tried to close empty" signal — it
    // should not pre-fire just because the initial state is empty.
    render(
      <Harness initialIds={[]} onCommit={vi.fn()} onClose={vi.fn()} />,
    )
    await screen.findByTestId('inline-source-picker')
    expect(
      screen.queryByTestId('inline-source-picker-empty-error'),
    ).toBeNull()
  })
})

describe('InlineSourcePicker — clicking the anchor', () => {
  it('clicking the anchor does NOT fire onCancel — parent owns re-open semantics', async () => {
    // Mirrors the RejectConfirmPopover anchor-contains contract: the
    // picker's click-outside handler explicitly excludes the anchor
    // so a click on the trigger doesn't immediately re-fire close
    // and stack with a parent re-open. Pin so a refactor that drops
    // the anchor-contains check shows up in CI.
    const onCommit = vi.fn()
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
