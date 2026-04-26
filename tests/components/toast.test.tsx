import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ToastProvider, useToast } from '@/lib/contexts/ToastContext'
import {
  TOAST_AUTO_DISMISS_MS,
  TOAST_MAX_VISIBLE,
} from '@/lib/constants/redesign-ui'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4a — Toast primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the public surface of `lib/contexts/ToastContext.tsx` and
// `components/ui/toast.tsx`:
//   - Provider mount + hook contract.
//   - Push / dismiss lifecycle.
//   - Auto-dismiss after TOAST_AUTO_DISMISS_MS.
//   - Action-callback fires + dismisses on click.
//   - Stacking (renders all queued toasts in DOM order).
//   - FIFO eviction past TOAST_MAX_VISIBLE.
//   - Replace-by-id (rolling latest pattern).
//   - A11y attributes (role + aria-live).
//   - Animation class present (toast-enter).

let lastApi: ReturnType<typeof useToast> | null = null

function HookProbe() {
  lastApi = useToast()
  return null
}

function renderProvider(extra?: React.ReactNode) {
  return render(
    <ToastProvider>
      <HookProbe />
      {extra}
    </ToastProvider>,
  )
}

describe('ToastProvider — hook + queue contract', () => {
  beforeEach(() => {
    lastApi = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('useToast() throws when used outside a provider', () => {
    // Suppress the React error boundary noise the throw produces.
    const originalError = console.error
    console.error = () => {}
    try {
      expect(() => render(<HookProbe />)).toThrow(/useToast/)
    } finally {
      console.error = originalError
    }
  })

  it('exposes pushToast + dismissToast via useToast()', () => {
    renderProvider()
    expect(lastApi).not.toBeNull()
    expect(typeof lastApi!.pushToast).toBe('function')
    expect(typeof lastApi!.dismissToast).toBe('function')
  })

  it('renders a pushed toast with the message and variant data attributes', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'hello' })
    })
    const toast = screen.getByTestId('toast')
    expect(toast.textContent).toContain('hello')
    expect(toast.getAttribute('data-toast-variant')).toBe('info')
  })

  it('returns the resolved id from pushToast', () => {
    renderProvider()
    let returnedId = ''
    act(() => {
      returnedId = lastApi!.pushToast({ variant: 'info', message: 'x' })
    })
    expect(typeof returnedId).toBe('string')
    expect(returnedId.length).toBeGreaterThan(0)
    const toast = screen.getByTestId('toast')
    expect(toast.getAttribute('data-toast-id')).toBe(returnedId)
  })

  it('dismissToast removes the toast by id', () => {
    renderProvider()
    let id = ''
    act(() => {
      id = lastApi!.pushToast({ variant: 'info', message: 'bye' })
    })
    expect(screen.queryByTestId('toast')).not.toBeNull()
    act(() => {
      lastApi!.dismissToast(id)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('auto-dismisses after TOAST_AUTO_DISMISS_MS', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'auto' })
    })
    expect(screen.getByTestId('toast')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1)
    })
    expect(screen.queryByTestId('toast')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('honors a custom durationMs override', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'fast', durationMs: 500 })
    })
    act(() => {
      vi.advanceTimersByTime(499)
    })
    expect(screen.queryByTestId('toast')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('does NOT auto-dismiss when durationMs === 0 (sticky toast)', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'sticky', durationMs: 0 })
    })
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 3)
    })
    expect(screen.queryByTestId('toast')).not.toBeNull()
  })

  it('renders an action button that fires onAction THEN dismisses', () => {
    const onAction = vi.fn()
    renderProvider()
    act(() => {
      lastApi!.pushToast({
        variant: 'info',
        message: 'm',
        actionLabel: 'Undo',
        onAction,
      })
    })
    const action = screen.getByTestId('toast-action')
    expect(action.textContent).toBe('Undo')
    act(() => {
      action.click()
    })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('manual close (X button) dismisses without invoking onAction', () => {
    const onAction = vi.fn()
    renderProvider()
    act(() => {
      lastApi!.pushToast({
        variant: 'info',
        message: 'm',
        actionLabel: 'Undo',
        onAction,
      })
    })
    const dismiss = screen.getByTestId('toast-dismiss')
    act(() => {
      dismiss.click()
    })
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('stacks multiple toasts in DOM (push order = render order)', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'a' })
      lastApi!.pushToast({ variant: 'success', message: 'b' })
      lastApi!.pushToast({ variant: 'error', message: 'c' })
    })
    const toasts = screen.getAllByTestId('toast')
    expect(toasts).toHaveLength(3)
    expect(toasts[0]!.textContent).toContain('a')
    expect(toasts[1]!.textContent).toContain('b')
    expect(toasts[2]!.textContent).toContain('c')
  })

  it('FIFO-evicts the oldest toast when queue exceeds TOAST_MAX_VISIBLE', () => {
    renderProvider()
    act(() => {
      for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i += 1) {
        lastApi!.pushToast({ variant: 'info', message: `t${i}` })
      }
    })
    const toasts = screen.getAllByTestId('toast')
    expect(toasts).toHaveLength(TOAST_MAX_VISIBLE)
    // Oldest (`t0`, `t1`) should be evicted; newest TOAST_MAX_VISIBLE
    // remain in order.
    expect(toasts[0]!.textContent).toContain('t2')
    expect(toasts[toasts.length - 1]!.textContent).toContain(
      `t${TOAST_MAX_VISIBLE + 1}`,
    )
  })

  it('replace-by-id swaps payload in place and does NOT consume a slot', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ id: 'rolling', variant: 'info', message: 'first' })
      lastApi!.pushToast({ variant: 'success', message: 'other' })
      lastApi!.pushToast({ id: 'rolling', variant: 'info', message: 'second' })
    })
    const toasts = screen.getAllByTestId('toast')
    expect(toasts).toHaveLength(2)
    // The 'rolling' toast retains its position (index 0); message
    // swapped to 'second'.
    expect(toasts[0]!.getAttribute('data-toast-id')).toBe('rolling')
    expect(toasts[0]!.textContent).toContain('second')
    expect(toasts[1]!.textContent).toContain('other')
  })

  it('replace-by-id resets the auto-dismiss timer', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ id: 'rolling', variant: 'info', message: 'first' })
    })
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100)
    })
    // Re-push with same id; timer should restart from 0.
    act(() => {
      lastApi!.pushToast({ id: 'rolling', variant: 'info', message: 'second' })
    })
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100)
    })
    expect(screen.queryByTestId('toast')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('error variant renders role="alert"; info/success render role="status"', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ id: 'a', variant: 'info', message: 'i' })
      lastApi!.pushToast({ id: 'b', variant: 'success', message: 's' })
      lastApi!.pushToast({ id: 'c', variant: 'error', message: 'e' })
    })
    const a = screen.getByTestId('toast-container').querySelector(
      '[data-toast-id="a"]',
    )
    const b = screen.getByTestId('toast-container').querySelector(
      '[data-toast-id="b"]',
    )
    const c = screen.getByTestId('toast-container').querySelector(
      '[data-toast-id="c"]',
    )
    expect(a?.getAttribute('role')).toBe('status')
    expect(b?.getAttribute('role')).toBe('status')
    expect(c?.getAttribute('role')).toBe('alert')
  })

  it('container exposes aria-live="polite" for screen-reader announcements', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'm' })
    })
    const container = screen.getByTestId('toast-container')
    expect(container.getAttribute('aria-live')).toBe('polite')
  })

  it('toast carries the toast-enter animation class for slide-in keyframe', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'm' })
    })
    const toast = screen.getByTestId('toast')
    expect(toast.className).toContain('toast-enter')
  })

  it('does not render the container when the queue is empty', () => {
    renderProvider()
    expect(screen.queryByTestId('toast-container')).toBeNull()
  })

  it('action button gets focus on mount when actionLabel is set', () => {
    renderProvider()
    act(() => {
      lastApi!.pushToast({
        variant: 'info',
        message: 'm',
        actionLabel: 'Undo',
        onAction: () => {},
      })
    })
    const action = screen.getByTestId('toast-action')
    expect(document.activeElement).toBe(action)
  })

  it('light-mode invariant — no dark: modifiers in toast tree', () => {
    const { container } = renderProvider()
    act(() => {
      lastApi!.pushToast({ variant: 'info', message: 'm' })
      lastApi!.pushToast({ variant: 'error', message: 'e', actionLabel: 'Try' })
    })
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
