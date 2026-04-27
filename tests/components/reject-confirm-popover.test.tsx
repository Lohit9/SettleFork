import { describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RejectConfirmPopover } from '@/app/app/projects/[projectId]/mapping/redesign/components/RejectConfirmPopover'

// ─────────────────────────────────────────────────────────────────────────────
// RejectConfirmPopover — Phase 4-polish-3 Block B unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// The popover is a bespoke portal-based confirm built atop the
// `FieldPicker` portal pattern. The unit tests pin the locked copy,
// the dismiss-on-Esc / click-outside contract, and the focus-on-mount
// behavior (Cancel takes initial focus so a stray Enter dismisses
// rather than confirms).
//
// The integration with `FieldMappingRow` (anchor under the inline ✗
// button) is exercised separately at the row test layer — these
// tests render the popover in isolation against a synthetic anchor.

// ── Anchor harness ──────────────────────────────────────────────────────────
//
// Helper that mounts an anchor button + the popover so the popover's
// `anchorRef` resolves to a live DOM node. Hooks-only — keeps the
// test setup minimal.

interface HarnessProps {
  onConfirm: () => void
  onCancel: () => void
}

function Harness({ onConfirm, onCancel }: HarnessProps) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div>
      <button ref={anchorRef} type="button" data-testid="anchor">
        anchor
      </button>
      <RejectConfirmPopover
        anchorRef={anchorRef}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  )
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RejectConfirmPopover — render + locked copy', () => {
  it('renders the locked title and Cancel/Reject buttons', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    // Title — locked copy.
    expect(await screen.findByText('Reject this mapping?')).toBeInTheDocument()
    // Both buttons render via testids; the role+name pattern is also a
    // valid surface but the testids let us assert specifically which
    // button (cancel vs confirm) without ambiguity.
    expect(
      screen.getByTestId('reject-confirm-popover-cancel'),
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('reject-confirm-popover-confirm'),
    ).toBeInTheDocument()
  })

  it('uses role="dialog" and an aria-label that mirrors the title', async () => {
    render(<Harness onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const popover = await screen.findByTestId('reject-confirm-popover')
    expect(popover.getAttribute('role')).toBe('dialog')
    expect(popover.getAttribute('aria-label')).toBe('Reject this mapping?')
  })

  it('confirm button is destructive (red) — class signature pinned', async () => {
    render(<Harness onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const confirmBtn = await screen.findByTestId(
      'reject-confirm-popover-confirm',
    )
    // Mirrors the founder-locked destructive treatment for inline
    // reject. If a future refactor moves the confirm button to a
    // non-destructive (e.g. slate) treatment, that's a regression
    // worth tripping CI over.
    expect(confirmBtn.className).toContain('bg-red-600')
  })
})

describe('RejectConfirmPopover — focus management', () => {
  it('moves focus to the Cancel button after mount (defense vs. stray Enter)', async () => {
    render(<Harness onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const cancelBtn = await screen.findByTestId(
      'reject-confirm-popover-cancel',
    )
    // The component schedules focus via setTimeout(50ms). Spin via a
    // waitFor-style retry — `findByX` already retries to 1000ms by
    // default; we re-query via `expect.poll` so the flakiness budget
    // matches the 50ms setTimeout without depending on real timers.
    await expect
      .poll(() => document.activeElement === cancelBtn, { timeout: 500 })
      .toBe(true)
  })
})

describe('RejectConfirmPopover — dismiss contracts', () => {
  it('Esc fires onCancel (and NOT onConfirm)', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await screen.findByTestId('reject-confirm-popover')
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('click-outside (mousedown on document) fires onCancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await screen.findByTestId('reject-confirm-popover')
    // Dispatch a mousedown event on document.body to simulate a click
    // outside the popover and outside the anchor. The component
    // listens via `document.addEventListener('mousedown', ...)`.
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('clicking INSIDE the popover does NOT fire onCancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    const popover = await screen.findByTestId('reject-confirm-popover')
    act(() => {
      fireEvent.mouseDown(popover)
    })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('clicking the anchor does NOT fire onCancel (parent owns re-open semantics)', async () => {
    // The popover excludes the anchor from its click-outside handler so
    // a click on the trigger (e.g. tapping ✗ a second time) doesn't
    // immediately re-fire cancel and stack with the parent's
    // re-open handler. Pin this so a refactor that drops the
    // anchor-contains check shows up in CI.
    const onCancel = vi.fn()
    render(<Harness onConfirm={vi.fn()} onCancel={onCancel} />)
    await screen.findByTestId('reject-confirm-popover')
    const anchor = screen.getByTestId('anchor')
    act(() => {
      fireEvent.mouseDown(anchor)
    })
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('RejectConfirmPopover — confirm + cancel button wiring', () => {
  it('Cancel button click fires onCancel', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await user.click(
      await screen.findByTestId('reject-confirm-popover-cancel'),
    )
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Reject button click fires onConfirm', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<Harness onConfirm={onConfirm} onCancel={onCancel} />)
    await user.click(
      await screen.findByTestId('reject-confirm-popover-confirm'),
    )
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('RejectConfirmPopover — portal hosting', () => {
  it('renders into document.body (not the parent container)', async () => {
    const { container } = render(
      <Harness onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    const popover = await screen.findByTestId('reject-confirm-popover')
    // Defense-in-depth: the popover must be portalled OUT of the
    // calling component tree so its z-index + position-fixed layout
    // can paint above the row scroll container without a stacking-
    // context fight. If a future refactor removes the portal, this
    // assertion catches it.
    expect(container.contains(popover)).toBe(false)
    expect(document.body.contains(popover)).toBe(true)
  })
})
