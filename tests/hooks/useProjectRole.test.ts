import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { ProjectRole } from '@/lib/types/organizations'

// Mock the server action that the hook depends on. We control the resolved
// value per-test via `mockResolvedValueOnce` so each scenario gets a clean
// promise to await on. Default behavior (when a test doesn't override) is
// resolve(null) — the "no access" path — so the fail-closed defaults kick
// in unless a test explicitly sets a role.
vi.mock('@/lib/actions/role-resolution', () => ({
  getUserProjectRole: vi.fn(),
}))

import { getUserProjectRole } from '@/lib/actions/role-resolution'
import { useProjectRole } from '@/lib/hooks/useProjectRole'

const mockedGetRole = vi.mocked(getUserProjectRole)

describe('useProjectRole', () => {
  beforeEach(() => {
    mockedGetRole.mockReset()
  })

  // ── Exact-role booleans (mutually exclusive) ────────────────────────────

  it('isAdmin is true when role is admin; isEditor and isViewer are false', async () => {
    mockedGetRole.mockResolvedValueOnce('admin' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.role).toBe('admin')
    expect(result.current.isAdmin).toBe(true)
    expect(result.current.isEditor).toBe(false)
    expect(result.current.isViewer).toBe(false)
  })

  it('isEditor is true when role is editor; isAdmin and isViewer are false', async () => {
    mockedGetRole.mockResolvedValueOnce('editor' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.role).toBe('editor')
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.isEditor).toBe(true)
    expect(result.current.isViewer).toBe(false)
  })

  it('isViewer is true when role is viewer; isAdmin and isEditor are false', async () => {
    mockedGetRole.mockResolvedValueOnce('viewer' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.role).toBe('viewer')
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.isEditor).toBe(false)
    expect(result.current.isViewer).toBe(true)
  })

  it('all exact-role booleans are false when role is null (no access)', async () => {
    mockedGetRole.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.role).toBe(null)
    expect(result.current.isAdmin).toBe(false)
    expect(result.current.isEditor).toBe(false)
    expect(result.current.isViewer).toBe(false)
  })

  // ── isReady / isLoading inverse ─────────────────────────────────────────

  it('isReady is the inverse of isLoading', async () => {
    // Block the promise until we explicitly resolve it so we can observe the
    // loading state. Using a manual deferred lets us assert the in-flight
    // and resolved snapshots without races.
    let resolveRole: (r: ProjectRole | null) => void = () => {}
    mockedGetRole.mockReturnValueOnce(
      new Promise<ProjectRole | null>((resolve) => {
        resolveRole = resolve
      }),
    )
    const { result } = renderHook(() => useProjectRole('p1'))

    expect(result.current.isLoading).toBe(true)
    expect(result.current.isReady).toBe(false)

    await act(async () => {
      resolveRole('admin')
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.isLoading).toBe(false)
  })

  // ── can() hierarchical checks ───────────────────────────────────────────

  it("can('edit') is true for editor; can('manage') is false for editor", async () => {
    mockedGetRole.mockResolvedValueOnce('editor' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.can('view')).toBe(true)
    expect(result.current.can('edit')).toBe(true)
    expect(result.current.can('manage')).toBe(false)
  })

  it("can('manage') is true for admin; can('edit') is also true for admin", async () => {
    mockedGetRole.mockResolvedValueOnce('admin' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.can('view')).toBe(true)
    expect(result.current.can('edit')).toBe(true)
    expect(result.current.can('manage')).toBe(true)
  })

  it("can('view') is true for viewer; can('edit') is false for viewer", async () => {
    mockedGetRole.mockResolvedValueOnce('viewer' satisfies ProjectRole)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.can('view')).toBe(true)
    expect(result.current.can('edit')).toBe(false)
    expect(result.current.can('manage')).toBe(false)
  })

  it('all can() checks are false when role is null', async () => {
    mockedGetRole.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useProjectRole('p1'))
    await waitFor(() => expect(result.current.isReady).toBe(true))
    expect(result.current.can('view')).toBe(false)
    expect(result.current.can('edit')).toBe(false)
    expect(result.current.can('manage')).toBe(false)
  })
})
