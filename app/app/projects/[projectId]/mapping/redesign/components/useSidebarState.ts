'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3, Gap 11a — sidebar persistence hook.
// ─────────────────────────────────────────────────────────────────────────────
//
// Persists the `SourceSchemaSidebar` collapsed/expanded state and the
// internal filter selection (Gap 11b: 'all' | 'mapped' | 'unmapped') to
// localStorage so the user's preference survives page reloads.
//
// SHAPE OF STATE
//
//   `state`   — 'collapsed' | 'expanded'      (sidebar open/closed)
//   `filter`  — 'all' | 'mapped' | 'unmapped' (which fields are listed)
//
// The two values are coupled to the same UI surface but stored under
// distinct localStorage keys. `filter` is intentionally persisted even
// when the sidebar is collapsed so re-opening the sidebar restores the
// user's last filter selection without a one-time reset.
//
// DEFAULTS
//
//   state  → 'collapsed'  (don't surprise first-time users)
//   filter → 'unmapped'   (most actionable view when the sidebar opens)
//
// HYDRATION BEHAVIOR (known trade-off)
//
// localStorage is unavailable on the server. To stay SSR-safe and to
// avoid hydration-mismatch warnings the hook ALWAYS returns the
// defaults on first render — both server and client agree on the
// initial paint. After mount, a `useEffect` reads localStorage and
// updates state if the persisted values differ. For users who had the
// sidebar 'expanded' the visible result is a 150ms width transition
// from 28px → 200px on every navigation. We deliberately accept this
// "snap into the persisted state" feel because:
//
//   1. The default ('collapsed') is the most common state, so most
//      users never see the transition.
//   2. The transition is short (150ms) and purposeful-looking.
//   3. The alternative — `useLayoutEffect` — would eliminate the flash
//      but requires `'use client'` semantics that interact poorly with
//      React 18 concurrent rendering inside an app-router server tree.
//
// If real-world usage shows the flash to be visually janky we can
// revisit by switching to `useLayoutEffect` (no contract change).
//
// SSR / non-DOM SAFETY
//
// All localStorage reads/writes are guarded by a `typeof window`
// check so the hook does not crash if accidentally imported into a
// server module or run in an environment without `window` defined.

import { useCallback, useEffect, useState } from 'react'

// Storage keys — locked by founder decision 5 in the Gap 11a prompt.
// Hardcoded as constants (not configurable) to prevent drift between
// the hook and any future inspection tooling.
const STORAGE_KEY_STATE = 'mapping-sidebar-state'
const STORAGE_KEY_FILTER = 'mapping-sidebar-filter'

/** Sidebar open/closed state. */
export type SidebarState = 'collapsed' | 'expanded'

/** Sidebar field-list filter selection. Wired in Gap 11b. */
export type SidebarFilter = 'all' | 'mapped' | 'unmapped'

const DEFAULT_STATE: SidebarState = 'collapsed'
const DEFAULT_FILTER: SidebarFilter = 'unmapped'

/**
 * Narrow an arbitrary string into a `SidebarState`. Returns `null`
 * for any value that is not a recognized member of the union (we
 * treat that case as "no preference" so the hook falls back to the
 * default rather than a broken value).
 */
function asSidebarState(raw: string | null): SidebarState | null {
  return raw === 'collapsed' || raw === 'expanded' ? raw : null
}

function asSidebarFilter(raw: string | null): SidebarFilter | null {
  return raw === 'all' || raw === 'mapped' || raw === 'unmapped' ? raw : null
}

function readStateFromStorage(): SidebarState {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    return asSidebarState(window.localStorage.getItem(STORAGE_KEY_STATE)) ?? DEFAULT_STATE
  } catch {
    // localStorage can throw under restrictive privacy settings,
    // disabled storage quotas, or sandboxed iframes. Fall back to
    // the default rather than blowing up the page.
    return DEFAULT_STATE
  }
}

function readFilterFromStorage(): SidebarFilter {
  if (typeof window === 'undefined') return DEFAULT_FILTER
  try {
    return asSidebarFilter(window.localStorage.getItem(STORAGE_KEY_FILTER)) ?? DEFAULT_FILTER
  } catch {
    return DEFAULT_FILTER
  }
}

/**
 * Public return shape. Setters synchronously update React state AND
 * write through to localStorage. Reads are deferred until after mount
 * (see "Hydration behavior" in the file header).
 */
export interface UseSidebarStateResult {
  /** Current persisted sidebar state — 'collapsed' on first render. */
  state: SidebarState
  /** Current persisted filter — 'unmapped' on first render. */
  filter: SidebarFilter
  /** Update sidebar state + write to localStorage. */
  setSidebarState: (next: SidebarState) => void
  /** Update filter selection + write to localStorage. */
  setSidebarFilter: (next: SidebarFilter) => void
  /**
   * `true` once the post-mount effect has reconciled state with
   * localStorage. Consumers that need to suppress an initial visual
   * transition can gate animations on this flag. Most callers ignore
   * it (the 150ms width transition is the intended UX).
   */
  isHydrated: boolean
}

/**
 * Persist the source-schema sidebar state + filter to localStorage.
 *
 * - SSR-safe (defaults until mount; no `window` access on the server)
 * - Resilient to localStorage exceptions (sandboxed iframes, quota,
 *   privacy modes) — falls back to defaults
 * - Type-safe: arbitrary stored values that don't match the union are
 *   discarded rather than coerced
 */
export function useSidebarState(): UseSidebarStateResult {
  const [state, setStateInternal] = useState<SidebarState>(DEFAULT_STATE)
  const [filter, setFilterInternal] = useState<SidebarFilter>(DEFAULT_FILTER)
  const [isHydrated, setIsHydrated] = useState(false)

  // Post-mount: reconcile with localStorage. We split the read out of
  // useState's lazy initializer to keep first render identical on
  // server and client (no hydration mismatch).
  useEffect(() => {
    setStateInternal(readStateFromStorage())
    setFilterInternal(readFilterFromStorage())
    setIsHydrated(true)
  }, [])

  const setSidebarState = useCallback((next: SidebarState) => {
    setStateInternal(next)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY_STATE, next)
    } catch {
      // Persistence failure is non-fatal — the in-memory state is
      // authoritative for the current session.
    }
  }, [])

  const setSidebarFilter = useCallback((next: SidebarFilter) => {
    setFilterInternal(next)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY_FILTER, next)
    } catch {
      // see setSidebarState
    }
  }, [])

  return { state, filter, setSidebarState, setSidebarFilter, isHydrated }
}

// Test-only exports. Kept package-private (no re-export from a
// barrel) to discourage callers from depending on storage keys.
export const __INTERNAL_FOR_TESTS = {
  STORAGE_KEY_STATE,
  STORAGE_KEY_FILTER,
  DEFAULT_STATE,
  DEFAULT_FILTER,
}
