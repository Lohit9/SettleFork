/**
 * @file Phase 3 Gap 11a — `useSidebarState` hook tests.
 *
 * Verifies the sidebar persistence contract:
 *   - Reads from localStorage on mount; defaults are 'collapsed' / 'unmapped'
 *   - Setters write to localStorage
 *   - Returns isHydrated=true after the post-mount reconciliation
 *   - SSR-safe / resilient to localStorage exceptions
 *   - Invalid persisted values fall back to defaults rather than coerce
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  __INTERNAL_FOR_TESTS,
  useSidebarState,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/useSidebarState'

const { STORAGE_KEY_STATE, STORAGE_KEY_FILTER } = __INTERNAL_FOR_TESTS

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

// ─── Defaults & first render contract ──────────────────────────────────────

describe('useSidebarState — defaults', () => {
  it('returns "collapsed" / "unmapped" on first render (before hydration)', () => {
    const { result } = renderHook(() => useSidebarState())
    // Note: `renderHook` flushes effects synchronously by default, so
    // `result.current` reflects the post-mount values. To test the
    // pre-hydration contract we look at the persisted values when
    // localStorage is empty — they must equal the documented defaults.
    expect(result.current.state).toBe('collapsed')
    expect(result.current.filter).toBe('unmapped')
    expect(result.current.isHydrated).toBe(true)
  })

  it('defaults to "collapsed" if localStorage has no state key', () => {
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.state).toBe('collapsed')
  })

  it('defaults to "unmapped" if localStorage has no filter key', () => {
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.filter).toBe('unmapped')
  })
})

// ─── Reads from localStorage ───────────────────────────────────────────────

describe('useSidebarState — reads', () => {
  it('reads "expanded" from localStorage on mount', () => {
    window.localStorage.setItem(STORAGE_KEY_STATE, 'expanded')
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.state).toBe('expanded')
  })

  it('reads "mapped" from localStorage on mount', () => {
    window.localStorage.setItem(STORAGE_KEY_FILTER, 'mapped')
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.filter).toBe('mapped')
  })

  it('falls back to defaults when persisted values are not in the union', () => {
    window.localStorage.setItem(STORAGE_KEY_STATE, 'gibberish')
    window.localStorage.setItem(STORAGE_KEY_FILTER, 'archived')
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.state).toBe('collapsed')
    expect(result.current.filter).toBe('unmapped')
  })

  it('isHydrated transitions to true after mount', () => {
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.isHydrated).toBe(true)
  })
})

// ─── Setters write to localStorage ─────────────────────────────────────────

describe('useSidebarState — writes', () => {
  it('setSidebarState writes to localStorage', () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.setSidebarState('expanded'))
    expect(result.current.state).toBe('expanded')
    expect(window.localStorage.getItem(STORAGE_KEY_STATE)).toBe('expanded')
  })

  it('setSidebarFilter writes to localStorage', () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.setSidebarFilter('mapped'))
    expect(result.current.filter).toBe('mapped')
    expect(window.localStorage.getItem(STORAGE_KEY_FILTER)).toBe('mapped')
  })

  it('multiple writes update both state and storage', () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.setSidebarState('expanded'))
    act(() => result.current.setSidebarState('collapsed'))
    expect(result.current.state).toBe('collapsed')
    expect(window.localStorage.getItem(STORAGE_KEY_STATE)).toBe('collapsed')
  })

  it('setting filter does NOT touch the state key (and vice versa)', () => {
    const { result } = renderHook(() => useSidebarState())
    act(() => result.current.setSidebarFilter('all'))
    expect(window.localStorage.getItem(STORAGE_KEY_STATE)).toBeNull()
    act(() => result.current.setSidebarState('expanded'))
    expect(window.localStorage.getItem(STORAGE_KEY_FILTER)).toBe('all')
  })
})

// ─── Resilience ────────────────────────────────────────────────────────────

describe('useSidebarState — resilience', () => {
  it('does not crash if localStorage.getItem throws (e.g. sandboxed iframe)', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })
    const { result } = renderHook(() => useSidebarState())
    expect(result.current.state).toBe('collapsed')
    expect(result.current.filter).toBe('unmapped')
    spy.mockRestore()
  })

  it('does not crash if localStorage.setItem throws (e.g. quota exceeded)', () => {
    const spy = vi
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    const { result } = renderHook(() => useSidebarState())
    // The setter still updates React state even though persistence fails.
    act(() => result.current.setSidebarState('expanded'))
    expect(result.current.state).toBe('expanded')
    spy.mockRestore()
  })
})
