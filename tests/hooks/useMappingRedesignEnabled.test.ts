import { describe, it, expect } from 'vitest'
import { useMappingRedesignEnabled } from '@/lib/hooks/useMappingRedesignEnabled'

// The hook is pure — we can call it directly without renderHook.
// That's intentional: no useState/useEffect, nothing to reconcile.
//
// PR 2a (Apr 2026): the hook's input shrunk from `ProjectInfo | undefined
// | null` to `boolean | undefined | null`. The strict-`=== true` semantics
// are unchanged; the dispatch itself moved from this hook (called inside
// the legacy MappingContent) to the server page (mapping/page.tsx).

describe('useMappingRedesignEnabled', () => {
  it('returns false when flag is undefined (back-compat default)', () => {
    expect(useMappingRedesignEnabled(undefined)).toBe(false)
  })

  it('returns false when flag is explicitly false', () => {
    expect(useMappingRedesignEnabled(false)).toBe(false)
  })

  it('returns true when flag is true', () => {
    expect(useMappingRedesignEnabled(true)).toBe(true)
  })

  it('returns false when flag is null', () => {
    expect(useMappingRedesignEnabled(null)).toBe(false)
  })

  it('does not coerce truthy non-boolean values (strict === true check)', () => {
    // Guards against silent data-shape drift (e.g. Supabase returning "1" as a
    // string from some edge case). The hook must only accept literal `true`.
    expect(useMappingRedesignEnabled(1 as unknown as boolean)).toBe(false)
  })
})
