'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Toast — Phase 4a-4a primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Inline custom toast component. No new dependencies (per Phase 4a-4a
// constraints): no react-hot-toast, no sonner, no @radix-ui/react-toast,
// no tailwindcss-animate plugin. Animation runs through a custom
// keyframe in `app/globals.css` (`@keyframes toast-slide-in-up`).
//
// PUBLIC SURFACE
//
//   - `Toast`             — single toast presentation component. Pure;
//                           consumes already-resolved options. Provider
//                           in `lib/contexts/ToastContext.tsx` owns the
//                           queue + lifecycle.
//   - `ToastContainer`    — fixed-position queue renderer (bottom-right).
//                           Consumed only by `ToastProvider`.
//   - `ToastVariant`      — discriminated string union.
//   - `ToastOptions`      — input shape for `pushToast(...)`.
//   - `ToastInternal`     — internal queue item shape (extends options
//                           with a resolved id + push timestamp).
//
// A11Y
//
//   - `role="status"` on info + success (announce-once when polite).
//   - `role="alert"`  on error (interrupts).
//   - `aria-live="polite"` on the container so screen readers announce
//     newly inserted children without stealing focus.
//   - Action button auto-focuses on mount when present (per founder
//     decision §1-OQ-1 for 4a-4a — keep the user one keystroke away
//     from Undo).
//
// VISUAL CONTRACT
//
//   Slate-900 background, white text. Bottom-right placement is owned
//   by `ToastContainer`. Single toast renders as a self-contained card
//   with optional action label + close X.

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export type ToastVariant = 'success' | 'error' | 'info'

export interface ToastOptions {
  /**
   * Optional stable id. When provided, `pushToast` replaces any existing
   * toast with the same id rather than enqueuing a new one ("rolling
   * latest" pattern; see founder decision §11-OQ-2). Auto-generated
   * when omitted.
   */
  id?: string
  variant: ToastVariant
  message: string
  /**
   * Optional action affordance (e.g. "Undo"). When set, the action
   * button auto-focuses on mount. Clicking the action runs `onAction`
   * THEN dismisses the toast.
   */
  actionLabel?: string
  onAction?: () => void
  /**
   * Override `TOAST_AUTO_DISMISS_MS` for this specific toast. Set to
   * `0` to opt out of auto-dismiss (manual close only).
   */
  durationMs?: number
}

export interface ToastInternal extends ToastOptions {
  /** Resolved id (auto-generated when caller didn't pass one). */
  id: string
  /**
   * Monotonic timestamp captured at push. Used for stable sort order
   * when the queue renders (oldest at the top of the stack, newest at
   * the bottom — matches macOS / Linear / Vercel conventions).
   */
  pushedAt: number
}

interface ToastProps {
  toast: ToastInternal
  onDismiss: (id: string) => void
}

/**
 * Single-toast presentation. Pure component — consumes resolved options
 * and a dismiss callback; lifecycle (auto-dismiss timer, queue eviction)
 * is the provider's concern.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const actionButtonRef = useRef<HTMLButtonElement | null>(null)

  // Auto-focus the action button so keyboard users are one keystroke
  // away from the affordance (Enter triggers action). Skip when no
  // action — focus would steal from whatever the user was doing.
  useEffect(() => {
    if (toast.actionLabel && actionButtonRef.current) {
      actionButtonRef.current.focus()
    }
  }, [toast.actionLabel])

  const isError = toast.variant === 'error'

  return (
    <div
      role={isError ? 'alert' : 'status'}
      data-testid="toast"
      data-toast-id={toast.id}
      data-toast-variant={toast.variant}
      className={cn(
        'toast-enter pointer-events-auto flex w-80 max-w-[calc(100vw-3rem)] items-start gap-3 rounded-md bg-slate-900 px-4 py-3 text-sm text-white shadow-lg',
        // Subtle variant accent on the left edge — color-codes without
        // sacrificing the slate-900 readability of the body.
        toast.variant === 'success' && 'border-l-2 border-green-400',
        toast.variant === 'error' && 'border-l-2 border-red-400',
        toast.variant === 'info' && 'border-l-2 border-blue-400',
      )}
    >
      <span className="flex-1 leading-snug">{toast.message}</span>
      {toast.actionLabel ? (
        <button
          ref={actionButtonRef}
          type="button"
          data-testid="toast-action"
          onClick={() => {
            toast.onAction?.()
            onDismiss(toast.id)
          }}
          className={cn(
            'flex-shrink-0 rounded text-xs font-medium underline-offset-2 hover:underline',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
            toast.variant === 'success' && 'text-green-300',
            toast.variant === 'error' && 'text-red-300',
            toast.variant === 'info' && 'text-blue-300',
          )}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss notification"
        data-testid="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        className={cn(
          'flex-shrink-0 rounded text-slate-400 hover:text-white',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
        )}
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

interface ToastContainerProps {
  toasts: ToastInternal[]
  onDismiss: (id: string) => void
}

/**
 * Fixed-position queue renderer. Owns ONLY positioning + spacing; each
 * toast presentation lives in `<Toast>`. Consumed by `ToastProvider`.
 *
 * The container itself is `aria-live="polite"` so newly inserted toasts
 * announce automatically without stealing focus. We intentionally do
 * NOT use `aria-atomic` — re-announcing the entire stack on every
 * change would be loud.
 */
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      data-testid="toast-container"
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}
