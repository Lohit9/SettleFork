// @vitest-environment node
//
// Auth-guard tests for the SET-166 FE read contracts. Both reads must reject a
// caller without viewer permission BEFORE any service-role data fetch — these
// contracts previously called supabaseAdmin scoped only by project_id with no
// auth gate, so any authenticated user passing an arbitrary projectId could
// read another org's staged data + mapping spec.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/actions/role-resolution', () => ({
  requireProjectPermission: vi.fn(),
}))

import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { getMapTransformSpec } from '@/lib/actions/map-transform-spec'
import { getReadyToLoadView } from '@/lib/actions/ready-to-load'

const mockPerm = vi.mocked(requireProjectPermission)
const DENIED = { allowed: false, error: 'Insufficient permissions. Required role: viewer' }

describe('FE read contracts — viewer auth guard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getMapTransformSpec throws for a caller without viewer permission', async () => {
    mockPerm.mockResolvedValue(DENIED)
    await expect(getMapTransformSpec('proj-x')).rejects.toThrow(/permission/i)
    expect(mockPerm).toHaveBeenCalledWith('proj-x', 'viewer')
  })

  it('getReadyToLoadView throws for a caller without viewer permission (no fetch reached)', async () => {
    mockPerm.mockResolvedValue(DENIED)
    await expect(getReadyToLoadView('proj-x')).rejects.toThrow(/permission/i)
    expect(mockPerm).toHaveBeenCalledWith('proj-x', 'viewer')
  })
})
