// @vitest-environment node
//
// Unit tests for `lib/auth/require-org-role.ts`.
//
// This is the load-bearing security gate for B-2-c (admin SSO UI). A
// single bug here = cross-tenant data leak across every action that
// uses it. We test exhaustively:
//
//   - Every code path returns a discriminated `{ ok }` value.
//   - The `code` discriminator is correct for each failure mode.
//   - The role allow-list is honored exactly (no off-by-one on the
//     hierarchy: `editor` is NOT admin even though it sits above
//     `viewer`).
//   - DB errors fail closed (returned as `not_member`, not surfaced).
//   - The convenience `requireOrgAdmin` calls through with the
//     correct allow-list (`['owner', 'admin']`).
//
// The Supabase SSR client is mocked at the module level so we can
// drive `auth.getUser()` and the `org_memberships` lookup
// deterministically without touching a real DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────
// vi.hoisted mocks
// ─────────────────────────────────────────────────────────────────────

const { getUserMock, maybeSingleMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: getUserMock,
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: maybeSingleMock,
          }),
        }),
      }),
    }),
  }),
}))

beforeEach(() => {
  getUserMock.mockReset()
  maybeSingleMock.mockReset()
})

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function setSessionUser(userId: string | null) {
  getUserMock.mockResolvedValueOnce({
    data: { user: userId === null ? null : { id: userId } },
  })
}

function setMembershipRow(role: string | null, error: { message: string } | null = null) {
  maybeSingleMock.mockResolvedValueOnce({
    data: role === null ? null : { role },
    error,
  })
}

// Lazy-import after mocks are set up. Each test imports fresh to
// avoid module-level caching surprises.
async function importHelpers() {
  return await import('@/lib/auth/require-org-role')
}

// ─────────────────────────────────────────────────────────────────────
// Authentication branch
// ─────────────────────────────────────────────────────────────────────

describe('requireOrgRole — authentication', () => {
  it('returns code=unauthenticated when no session user', async () => {
    setSessionUser(null)
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result).toEqual({
      ok: false,
      error: 'Not authenticated',
      code: 'unauthenticated',
    })
  })

  it('does NOT query org_memberships when the session is missing', async () => {
    setSessionUser(null)
    const { requireOrgRole } = await importHelpers()
    await requireOrgRole('org-1', ['owner', 'admin'])
    // The membership lookup must be short-circuited; otherwise an
    // unauthenticated path could leak info via timing or RLS error
    // messages.
    expect(maybeSingleMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Membership branch
// ─────────────────────────────────────────────────────────────────────

describe('requireOrgRole — membership', () => {
  it('returns code=not_member when no membership row exists', async () => {
    setSessionUser('user-1')
    setMembershipRow(null)
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result).toEqual({
      ok: false,
      error: 'Not a member of this organization',
      code: 'not_member',
    })
  })

  it('returns code=not_member when the DB query errors (fail-closed)', async () => {
    // Suppress the helper's console.error so the test output stays
    // clean; we still assert on the structured return value.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    setSessionUser('user-1')
    setMembershipRow(null, { message: 'connection reset' })
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])

    expect(result).toEqual({
      ok: false,
      error: 'Not a member of this organization',
      code: 'not_member',
    })
    // Critical: the user-facing error must NOT echo the DB error
    // message (would be a partial-disclosure side channel).
    if (!result.ok) {
      expect(result.error).not.toMatch(/connection reset/)
    }
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Role allow-list
// ─────────────────────────────────────────────────────────────────────

describe('requireOrgRole — role allow-list', () => {
  it('returns code=insufficient_role for a viewer when admin/owner required', async () => {
    setSessionUser('user-1')
    setMembershipRow('viewer')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('insufficient_role')
      // The message includes the actual role and the requirement —
      // useful for ops triage but never echoes attacker-controlled
      // input.
      expect(result.error).toContain("'viewer'")
      expect(result.error).toMatch(/owner.*admin/)
    }
  })

  it("returns code=insufficient_role for editor (the trap role above 'viewer' but below 'admin')", async () => {
    // Defense-in-depth: the role hierarchy at
    // `lib/types/organizations.ts:3-8` numbers editor=2, admin=3.
    // A buggy implementation that compared `role >= 'admin'` could
    // accidentally pass editors. Allow-list semantics catch this.
    setSessionUser('user-1')
    setMembershipRow('editor')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('insufficient_role')
    }
  })

  it('returns ok=true for an admin', async () => {
    setSessionUser('user-1')
    setMembershipRow('admin')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result).toEqual({
      ok: true,
      userId: 'user-1',
      role: 'admin',
    })
  })

  it('returns ok=true for an owner', async () => {
    setSessionUser('user-1')
    setMembershipRow('owner')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'admin'])
    expect(result).toEqual({
      ok: true,
      userId: 'user-1',
      role: 'owner',
    })
  })

  it('honors a narrower allow-list (owner-only)', async () => {
    setSessionUser('user-1')
    setMembershipRow('admin')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner'])
    // admin is in the owner-or-admin allow-list elsewhere, but for
    // owner-only it must be rejected.
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('insufficient_role')
  })
})

// ─────────────────────────────────────────────────────────────────────
// requireOrgAdmin convenience wrapper
// ─────────────────────────────────────────────────────────────────────

describe('requireOrgAdmin — convenience wrapper', () => {
  it('passes for owner', async () => {
    setSessionUser('user-1')
    setMembershipRow('owner')
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result).toEqual({ ok: true, userId: 'user-1', role: 'owner' })
  })

  it('passes for admin', async () => {
    setSessionUser('user-1')
    setMembershipRow('admin')
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result).toEqual({ ok: true, userId: 'user-1', role: 'admin' })
  })

  it('rejects editor', async () => {
    setSessionUser('user-1')
    setMembershipRow('editor')
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('insufficient_role')
  })

  it('rejects viewer (the JIT-provisioned default — see migration 070:409-413)', async () => {
    // Critical: JIT-provisioned users from B-2-a-ii get role='viewer'.
    // This test pins that they cannot access B-2-c-i admin reads.
    setSessionUser('user-1')
    setMembershipRow('viewer')
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('insufficient_role')
  })

  it('rejects unauthenticated (no session)', async () => {
    setSessionUser(null)
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unauthenticated')
  })

  it('rejects non-member (no membership row for that org)', async () => {
    setSessionUser('user-1')
    setMembershipRow(null)
    const { requireOrgAdmin } = await importHelpers()
    const result = await requireOrgAdmin('org-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not_member')
  })
})
