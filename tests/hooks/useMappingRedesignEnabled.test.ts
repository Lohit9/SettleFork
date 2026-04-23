import { describe, it, expect } from 'vitest'
import { useMappingRedesignEnabled } from '@/lib/hooks/useMappingRedesignEnabled'
import type { ProjectInfo } from '@/components/app/ProjectInfoPopover'

// The hook is pure — we can call it directly without renderHook.
// That's intentional: no useState/useEffect, nothing to reconcile.

const baseProjectInfo: ProjectInfo = {
  projectName: 'Test Project',
  sourceSystem: 'src',
  targetSystem: 'tgt',
  createdAt: '2026-01-01T00:00:00Z',
}

describe('useMappingRedesignEnabled', () => {
  it('returns false when flag is undefined (back-compat default)', () => {
    expect(useMappingRedesignEnabled(baseProjectInfo)).toBe(false)
  })

  it('returns false when flag is explicitly false', () => {
    expect(
      useMappingRedesignEnabled({ ...baseProjectInfo, useMappingRedesign: false })
    ).toBe(false)
  })

  it('returns true when flag is true', () => {
    expect(
      useMappingRedesignEnabled({ ...baseProjectInfo, useMappingRedesign: true })
    ).toBe(true)
  })

  it('returns false when projectInfo is undefined', () => {
    expect(useMappingRedesignEnabled(undefined)).toBe(false)
  })

  it('returns false when projectInfo is null', () => {
    expect(useMappingRedesignEnabled(null)).toBe(false)
  })

  it('does not coerce truthy non-boolean values (strict === true check)', () => {
    // Guards against silent data-shape drift (e.g. Supabase returning "1" as a
    // string from some edge case). The hook must only accept literal `true`.
    const bad = { ...baseProjectInfo, useMappingRedesign: 1 as unknown as boolean }
    expect(useMappingRedesignEnabled(bad)).toBe(false)
  })
})
