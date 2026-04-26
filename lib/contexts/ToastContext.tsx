'use client'

// ─────────────────────────────────────────────────────────────────────────────
// ToastContext — Phase 4a-4a queue + lifecycle owner.
// ─────────────────────────────────────────────────────────────────────────────
//
// Owns the toast queue, auto-dismiss timers, FIFO eviction, and the
// "rolling latest" replace-by-id semantics required by the row-switch-
// while-dirty notification (Phase 4a-4a Block B). Presentation is
// delegated to `components/ui/toast.tsx` (`<ToastContainer>` +
// `<Toast>`).
//
// SCOPE (founder decision §1-OQ-1)
//
//   For Phase 4a-4 the provider is mounted inside `MappingContent` only.
//   Lift to the app shell when a future phase needs cross-page toasts.
//
// PUBLIC SURFACE
//
//   - `<ToastProvider>` — context provider. Renders `<ToastContainer>`
//     as a sibling of `children`.
//   - `useToast()`      — hook returning `{ pushToast, dismissToast }`.
//   - `pushToast(opts)` — enqueue a toast. When `opts.id` is set and
//     a toast with that id is already on the queue, the existing entry
//     is replaced in place (rolling latest; see §11-OQ-2). Returns the
//     resolved id of the toast actually pushed.
//   - `dismissToast(id)` — remove a toast by id (no-op if absent).
//
// QUEUE INVARIANTS
//
//   1. At most `TOAST_MAX_VISIBLE` toasts (3) on the queue at once.
//      When push exceeds, evict the OLDEST (FIFO), not the newest.
//   2. Replace-by-id does NOT consume an additional slot.
//   3. Auto-dismiss timers are tracked per toast id. Replace-by-id
//      cancels the prior timer and starts fresh.
//   4. Manual dismiss (`dismissToast` / X button / action button)
//      cancels the matching timer.
//
// SSR-SAFETY
//
//   `setTimeout` is node-friendly in test/SSR via the `'use client'`
//   directive at the top — the provider only mounts inside client
//   trees. We still use refs for timer handles so React 18 strict-mode
//   double-invocation doesn't leak timers.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ToastContainer,
  type ToastInternal,
  type ToastOptions,
} from '@/components/ui/toast'
import {
  TOAST_AUTO_DISMISS_MS,
  TOAST_MAX_VISIBLE,
} from '@/lib/constants/redesign-ui'

interface ToastContextValue {
  pushToast: (options: ToastOptions) => string
  dismissToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

interface ToastProviderProps {
  children: React.ReactNode
}

/**
 * Counter for auto-generated ids. Module-level so successive provider
 * remounts (rare; mainly tests) keep producing distinct ids without
 * collision risk against any caller-supplied ids.
 */
let nextAutoId = 0

function generateAutoId(): string {
  nextAutoId += 1
  return `toast-auto-${nextAutoId}`
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastInternal[]>([])

  // Per-id timer handles. Refs (not state) because mutating timers
  // shouldn't trigger re-renders.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  )

  const clearTimerFor = useCallback((id: string) => {
    const handle = timersRef.current.get(id)
    if (handle !== undefined) {
      clearTimeout(handle)
      timersRef.current.delete(id)
    }
  }, [])

  const dismissToast = useCallback(
    (id: string) => {
      clearTimerFor(id)
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
    [clearTimerFor],
  )

  const pushToast = useCallback(
    (options: ToastOptions): string => {
      const resolvedId = options.id ?? generateAutoId()
      const next: ToastInternal = {
        ...options,
        id: resolvedId,
        pushedAt: Date.now(),
      }

      // Cancel any existing timer for this id before re-arming.
      clearTimerFor(resolvedId)

      setToasts((prev) => {
        const existingIdx = prev.findIndex((t) => t.id === resolvedId)
        if (existingIdx >= 0) {
          // Replace-by-id: keep position stable but swap payload + bump
          // pushedAt. Does NOT consume an additional slot.
          const replaced = [...prev]
          replaced[existingIdx] = next
          return replaced
        }
        // New id. Append at the end. Evict oldest (head) if we exceed
        // the max-visible cap (FIFO).
        const appended = [...prev, next]
        if (appended.length > TOAST_MAX_VISIBLE) {
          const evicted = appended.slice(appended.length - TOAST_MAX_VISIBLE)
          // Clear timers for any toasts that just got evicted so we
          // don't leak.
          for (const t of appended.slice(0, appended.length - TOAST_MAX_VISIBLE)) {
            const handle = timersRef.current.get(t.id)
            if (handle !== undefined) {
              clearTimeout(handle)
              timersRef.current.delete(t.id)
            }
          }
          return evicted
        }
        return appended
      })

      // Arm auto-dismiss timer. `durationMs === 0` opts out (sticky
      // toast; manual close only).
      const duration = options.durationMs ?? TOAST_AUTO_DISMISS_MS
      if (duration > 0) {
        const handle = setTimeout(() => {
          dismissToast(resolvedId)
        }, duration)
        timersRef.current.set(resolvedId, handle)
      }

      return resolvedId
    },
    [clearTimerFor, dismissToast],
  )

  // Defensive cleanup on unmount: clear any outstanding timers so
  // tests + HMR don't leak handles.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const handle of timers.values()) {
        clearTimeout(handle)
      }
      timers.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ pushToast, dismissToast }),
    [pushToast, dismissToast],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  )
}

/**
 * Consumer hook. Throws when used outside `<ToastProvider>` so
 * forgotten provider mounts surface immediately rather than silently
 * no-oping in production.
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (ctx === null) {
    throw new Error(
      'useToast must be used within a <ToastProvider>. Mount one in the ' +
        'nearest client tree (e.g. inside MappingContent for Phase 4a-4a).',
    )
  }
  return ctx
}
