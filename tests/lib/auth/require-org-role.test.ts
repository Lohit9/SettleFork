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
//   - The role allow-list is honored exactly. Allow-list semantics
//     (vs. hierarchical comparison) are deliberately preserved so
//     that adding new OrgRole variants in the future requires
//     explicit caller opt-in, not implicit inheritance.
//   - DB errors fail closed (returned as `not_member`, not surfaced).
//   - The convenience `requireOrgAdmin` calls through with the
//     correct allow-list (`['owner']` post-migration 079).
//
// Post-079 OrgRole model (see `lib/types/organizations.ts:17` and
// `supabase/migrations/079_project_rbac_strict_membership.sql §B`):
// `OrgRole = 'owner' | 'member'`. The legacy `'admin'`/`'editor'`/
// `'viewer'` org-role values were unified into `'owner'`/`'member'`
// at the data layer; the database CHECK constraint now structurally
// rejects the old values, so tests that mock them would simulate
// states that cannot occur at runtime.
//
// The Supabase SSR client is mocked at the module level so we can
// drive `auth.getUser()` and the `org_memberships` lookup
// deterministically without touching a real DB.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
    const result = await requireOrgRole('org-1', ['owner'])
    expect(result).toEqual({
      ok: false,
      error: 'Not authenticated',
      code: 'unauthenticated',
    })
  })

  it('does NOT query org_memberships when the session is missing', async () => {
    setSessionUser(null)
    const { requireOrgRole } = await importHelpers()
    await requireOrgRole('org-1', ['owner'])
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
    const result = await requireOrgRole('org-1', ['owner'])
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
    const result = await requireOrgRole('org-1', ['owner'])

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
  it('returns code=insufficient_role for a member when owner required', async () => {
    setSessionUser('user-1')
    setMembershipRow('member')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner'])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('insufficient_role')
      // The message includes the actual role and the requirement —
      // useful for ops triage but never echoes attacker-controlled
      // input.
      expect(result.error).toContain("'member'")
      expect(result.error).toMatch(/owner/)
    }
  })

  it('returns ok=true for an owner', async () => {
    setSessionUser('user-1')
    setMembershipRow('owner')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner'])
    expect(result).toEqual({
      ok: true,
      userId: 'user-1',
      role: 'owner',
    })
  })

  it('honors a broader allow-list (owner-or-member)', async () => {
    // Documents the escape hatch: callers that legitimately need
    // both roles to pass can opt in explicitly without a new helper.
    // No production caller does this today (every gate is owner-only
    // post-079), but the surface is intentionally available for
    // future "any-member" reads (e.g. a future read-only SSO config
    // view for non-owners).
    setSessionUser('user-1')
    setMembershipRow('member')
    const { requireOrgRole } = await importHelpers()
    const result = await requireOrgRole('org-1', ['owner', 'member'])
    expect(result).toEqual({
      ok: true,
      userId: 'user-1',
      role: 'member',
    })
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

  it('rejects member (the JIT-provisioned default per migration 079 §B)', async () => {
    // Critical: JIT-provisioned users land with role='member' (the
    // default after migration 079 §B set `org_memberships.role
    // DEFAULT 'member'`). This test pins that they cannot access
    // any org-admin-gated action.
    setSessionUser('user-1')
    setMembershipRow('member')
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

// ─────────────────────────────────────────────────────────────────────
// Post-079 contract pinning (source-level)
// ─────────────────────────────────────────────────────────────────────
//
// Mirrors the source-level pin pattern established by
// `tests/actions/organizations-rbac.test.ts` and
// `tests/actions/org-invites-fanout.test.ts` (added by the
// project-rbac PR). A regression that re-introduces the legacy
// `['owner', 'admin']` allow-list — e.g. a well-meaning revert
// during a future refactor — fails CI before any runtime behavior
// is exercised.

describe('post-079 contract pinning (source-level)', () => {
  it("requireOrgAdmin's allow-list is owner-only (no legacy 'admin' org-role)", () => {
    const src = readFileSync(
      resolve(__dirname, '../../../lib/auth/require-org-role.ts'),
      'utf8',
    )
    expect(src).not.toMatch(
      /requireOrgRole\(\s*orgId\s*,\s*\['owner'\s*,\s*'admin'\]/,
    )
    expect(src).toMatch(/requireOrgRole\(\s*orgId\s*,\s*\['owner'\]\s*\)/)
  })
})
