import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  parseCollapsedParam,
  serializeCollapsedSet,
  useCollapsedGroups,
} from '@/lib/hooks/useCollapsedGroups'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4-polish-2 — useCollapsedGroups hook tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the read/write contract for `?collapsed=` group-collapsibility URL
// state. The hook is the only API for reading and writing this state; the
// rendering surface (TargetTableGroup, MappingContent) consumes it without
// touching `URLSearchParams` directly. These tests therefore guard the
// shape that downstream components depend on.
//
// Mock strategy: `next/navigation`'s `useRouter` / `usePathname` /
// `useSearchParams` are stubbed so we can drive the URL state in-test
// without mounting a Next.js router. The `currentSearch` module-level
// variable is the source of truth — toggling the hook updates it via
// the mocked `router.replace`, and subsequent re-renders read the new
// value back through the mocked `useSearchParams`.

// ── Mocks (hoisted) ──────────────────────────────────────────────────────────

const replaceMock = vi.fn<(url: string, options?: { scroll?: boolean }) => void>()
const pushMock = vi.fn()
let currentSearch = ''
let currentPath = '/app/projects/p1/mapping'

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => currentPath,
}))

beforeEach(() => {
  currentSearch = ''
  currentPath = '/app/projects/p1/mapping'
  replaceMock.mockReset()
  pushMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── parseCollapsedParam ─────────────────────────────────────────────────────

describe('parseCollapsedParam', () => {
  it('returns an empty Set for empty input', () => {
    expect(parseCollapsedParam('')).toEqual(new Set())
  })

  it('returns an empty Set when the comma-string is just commas', () => {
    expect(parseCollapsedParam(',,,')).toEqual(new Set())
  })

  it('parses a single-name list', () => {
    expect(parseCollapsedParam('accounts')).toEqual(new Set(['accounts']))
  })

  it('parses a multi-name list', () => {
    expect(parseCollapsedParam('accounts,customers,loans')).toEqual(
      new Set(['accounts', 'customers', 'loans']),
    )
  })

  it('decodes URL-encoded names', () => {
    expect(parseCollapsedParam('foo%2Fbar,Loan-Master')).toEqual(
      new Set(['foo/bar', 'Loan-Master']),
    )
  })

  it('drops empty segments without breaking other names', () => {
    expect(parseCollapsedParam('foo,,bar,')).toEqual(new Set(['foo', 'bar']))
  })

  it('skips malformed %xx sequences instead of throwing', () => {
    // `%E0%A4` is an incomplete UTF-8 sequence — `decodeURIComponent`
    // throws on it. The parser must catch and skip rather than crash
    // the whole hook (the URL is user-provided / shareable).
    expect(parseCollapsedParam('foo,%E0%A4,bar')).toEqual(new Set(['foo', 'bar']))
  })
})

// ── serializeCollapsedSet ───────────────────────────────────────────────────

describe('serializeCollapsedSet', () => {
  it('produces an empty string for an empty set', () => {
    expect(serializeCollapsedSet(new Set())).toBe('')
  })

  it('joins names with commas', () => {
    expect(serializeCollapsedSet(new Set(['a', 'b']))).toBe('a,b')
  })

  it('encodes special characters', () => {
    expect(serializeCollapsedSet(new Set(['foo/bar', 'baz qux']))).toBe(
      'foo%2Fbar,baz%20qux',
    )
  })

  it('round-trips with parseCollapsedParam', () => {
    const original = new Set(['accounts', 'customer_data_v2', 'Loan-Master'])
    const serialized = serializeCollapsedSet(original)
    expect(parseCollapsedParam(serialized)).toEqual(original)
  })
})

// ── useCollapsedGroups (read path) ──────────────────────────────────────────

describe('useCollapsedGroups — read path', () => {
  it('returns an empty Set when ?collapsed= is absent', () => {
    currentSearch = ''
    const { result } = renderHook(() => useCollapsedGroups())
    expect(result.current.collapsedGroups).toEqual(new Set())
    expect(result.current.isCollapsed('anything')).toBe(false)
  })

  it('parses ?collapsed=foo,bar into a Set with foo and bar', () => {
    currentSearch = 'collapsed=foo,bar'
    const { result } = renderHook(() => useCollapsedGroups())
    expect(result.current.collapsedGroups).toEqual(new Set(['foo', 'bar']))
    expect(result.current.isCollapsed('foo')).toBe(true)
    expect(result.current.isCollapsed('bar')).toBe(true)
    expect(result.current.isCollapsed('baz')).toBe(false)
  })

  it('decodes URL-encoded names in ?collapsed=', () => {
    currentSearch = 'collapsed=foo%2Fbar,baz'
    const { result } = renderHook(() => useCollapsedGroups())
    expect(result.current.collapsedGroups).toEqual(new Set(['foo/bar', 'baz']))
  })

  it('coexists with other URL params (filters, drawer)', () => {
    currentSearch =
      'q=test&status=needs_review&collapsed=accounts,customers&drawer=tfm-1'
    const { result } = renderHook(() => useCollapsedGroups())
    expect(result.current.collapsedGroups).toEqual(
      new Set(['accounts', 'customers']),
    )
  })

  it('does not throw when ?collapsed= contains malformed %xx sequences', () => {
    // `URLSearchParams.get` itself replaces malformed UTF-8 bytes
    // with U+FFFD before our parser sees them, so the hook does not
    // need to defend against `decodeURIComponent` errors at the
    // integration layer — but we pin the no-throw behaviour because
    // a future Next.js / Node change could surface raw `%xx` to
    // `parseCollapsedParam` instead. The parser-level robustness is
    // covered by the dedicated `parseCollapsedParam` test above.
    currentSearch = 'collapsed=%E0%A4'
    expect(() => renderHook(() => useCollapsedGroups())).not.toThrow()
  })
})

// ── useCollapsedGroups (write path) ─────────────────────────────────────────

describe('useCollapsedGroups — write path', () => {
  it('toggleCollapsed adds a new name when not present', () => {
    currentSearch = ''
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping?collapsed=accounts',
      { scroll: false },
    )
  })

  it('toggleCollapsed removes a name when already present', () => {
    currentSearch = 'collapsed=accounts'
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    expect(replaceMock).toHaveBeenCalledTimes(1)
    // ?collapsed= should be DROPPED entirely from the URL when the set
    // becomes empty — not kept as `?collapsed=`.
    expect(replaceMock).toHaveBeenCalledWith('/app/projects/p1/mapping', {
      scroll: false,
    })
  })

  it('toggleCollapsed preserves co-existing URL params (filters, drawer)', () => {
    currentSearch = 'q=test&status=needs_review&drawer=tfm-1'
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    expect(replaceMock).toHaveBeenCalledTimes(1)
    const [target] = replaceMock.mock.calls[0]
    expect(target).toContain('q=test')
    expect(target).toContain('status=needs_review')
    expect(target).toContain('drawer=tfm-1')
    expect(target).toContain('collapsed=accounts')
  })

  it('toggleCollapsed encodes special characters in names', () => {
    currentSearch = ''
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('foo/bar')
    })
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/projects/p1/mapping?collapsed=foo%2Fbar',
      { scroll: false },
    )
  })

  it('toggleCollapsed accumulates names across multiple calls (read URL each time)', () => {
    currentSearch = ''
    const { result, rerender } = renderHook(() => useCollapsedGroups())

    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    // Simulate the URL update by reading the most recent replace target
    // back into `currentSearch` so the next render sees the new state.
    const firstCall = replaceMock.mock.calls[0][0]
    currentSearch = new URL(firstCall, 'http://x').search.replace(/^\?/, '')
    rerender()

    act(() => {
      result.current.toggleCollapsed('customers')
    })
    const secondCall = replaceMock.mock.calls[1][0]
    // Names are joined with a literal comma — we intentionally bypass
    // `URLSearchParams.toString` for our param so the URL stays
    // human-readable rather than `collapsed=foo%2Cbar`.
    expect(secondCall).toContain('collapsed=accounts,customers')
  })

  it('expandAll clears ?collapsed= entirely', () => {
    currentSearch = 'collapsed=accounts,customers,loans'
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.expandAll()
    })
    expect(replaceMock).toHaveBeenCalledTimes(1)
    expect(replaceMock).toHaveBeenCalledWith('/app/projects/p1/mapping', {
      scroll: false,
    })
  })

  it('expandAll preserves co-existing URL params', () => {
    currentSearch = 'q=test&collapsed=accounts&drawer=tfm-1'
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.expandAll()
    })
    const [target] = replaceMock.mock.calls[0]
    expect(target).toContain('q=test')
    expect(target).toContain('drawer=tfm-1')
    expect(target).not.toContain('collapsed=')
  })

  it('expandAll is a no-op when no groups are collapsed', () => {
    currentSearch = 'q=test'
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.expandAll()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('uses router.replace, NOT router.push (history hygiene)', () => {
    currentSearch = ''
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    expect(pushMock).not.toHaveBeenCalled()
    expect(replaceMock).toHaveBeenCalledTimes(1)
  })

  it('passes { scroll: false } to router.replace (no viewport jump)', () => {
    currentSearch = ''
    const { result } = renderHook(() => useCollapsedGroups())
    act(() => {
      result.current.toggleCollapsed('accounts')
    })
    const [, options] = replaceMock.mock.calls[0]
    expect(options).toEqual({ scroll: false })
  })
})
