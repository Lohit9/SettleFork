// Shared helpers for the SSO-admin cross-tenant isolation suite
// (`tests/integration/sso-admin-isolation.test.ts`).
//
// Why these constants live in their own file
// ------------------------------------------
// The setup script (`scripts/sso-test-setup-isolation.ts`) and the
// test file both reference the same org slug + user email. Drifting
// either side silently breaks the suite — the test would pass against
// a non-existent org or fixate on a stale slug. Keeping the strings
// in one place lets a future commit (e.g. follow-up Okta App 2 wiring)
// rename without playing whack-a-mole.
//
// Why no test-running cookie / sign-in helper
// -------------------------------------------
// The original B-2-c-i scaffold of this file's parent imagined a real
// `signInWithPassword`-then-cookie flow for User 2. We took a simpler
// path (Mini-D session 2026-04-28, hybrid): the isolation tests use
// `vi.mock('@/lib/supabase/server', ...)` to stand in as User 2 — the
// same pattern as the Heritage integration suite at
// `tests/integration/bulk-approve-heritage.test.ts:64-82`.
//
// Mocking is sufficient because the gate under test
// (`requireOrgAdmin` at `lib/auth/require-org-role.ts`) only reads
// `auth.getUser()` and `org_memberships` — both of which the mock
// satisfies (the former by returning User 2's UUID, the latter by
// passing through to `supabaseAdmin` against the real DB).
//
// The full real-cookie-session path (Okta App 2 + password flow) is
// recorded as a follow-up in `docs/outstanding-items.md`. It is the
// right next step when we need end-to-end SAML round-trip tests for
// a second tenant — but it is not load-bearing for cross-tenant
// authorization gate tests.

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Fixture-shape constants ──────────────────────────────────────────
//
// Kept in lockstep with `scripts/sso-test-setup-isolation.ts` and
// `scripts/sso-test-cleanup-isolation.ts`. If any of these strings
// change, change them in all three places.

export const ISO_ORG_SLUG = 'sso-isolation-test'
export const ISO_USER_EMAIL = 'kaandincer1+ssoisolation@gmail.com'

// The primary SSO Test org — created by `scripts/sso-test-setup.ts`.
// User 1 (kaan@usesettle.ai) is the owner; User 2 must NOT be a
// member. Cross-tenant rejection tests target this org_id from
// User 2's session.
export const PRIMARY_ORG_SLUG = 'sso-test'

// ─── Runtime ID resolution ────────────────────────────────────────────

export interface IsolationFixtureIds {
  /** User 2's auth.users.id — never a member of `primaryOrgId`. */
  isolationUserId: string
  /** User 2's own org. Used as the positive-control target. */
  isolationOrgId: string
  /** User 1's primary org. Used as the cross-tenant rejection target. */
  primaryOrgId: string
}

/**
 * Resolves the three IDs the isolation suite needs from the fixture
 * provisioned by `npm run sso:test:setup:isolation`.
 *
 * Throws with a clear "run setup script" message when any artifact is
 * missing so the operator's first failure mode is self-diagnosing,
 * not a downstream null-deref.
 */
export async function resolveIsolationFixtureIds(
  admin: SupabaseClient,
): Promise<IsolationFixtureIds> {
  const { data: foundUsers, error: userErr } = await admin.rpc(
    'find_auth_user_by_email',
    { p_email: ISO_USER_EMAIL },
  )
  if (userErr) {
    throw new Error(
      `[isolation-fixture] auth.users lookup failed: ${userErr.message}`,
    )
  }
  if (!foundUsers || foundUsers.length === 0) {
    throw new Error(
      `[isolation-fixture] User ${ISO_USER_EMAIL} not found. Run:\n` +
        `  npm run sso:test:setup:isolation`,
    )
  }
  const isolationUserId: string = foundUsers[0].id

  const { data: isoOrg, error: isoOrgErr } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', ISO_ORG_SLUG)
    .maybeSingle()
  if (isoOrgErr) {
    throw new Error(
      `[isolation-fixture] iso org lookup failed: ${isoOrgErr.message}`,
    )
  }
  if (!isoOrg) {
    throw new Error(
      `[isolation-fixture] Org ${ISO_ORG_SLUG} not found. Run:\n` +
        `  npm run sso:test:setup:isolation`,
    )
  }

  const { data: primaryOrg, error: primaryOrgErr } = await admin
    .from('organizations')
    .select('id')
    .eq('slug', PRIMARY_ORG_SLUG)
    .maybeSingle()
  if (primaryOrgErr) {
    throw new Error(
      `[isolation-fixture] primary org lookup failed: ${primaryOrgErr.message}`,
    )
  }
  if (!primaryOrg) {
    throw new Error(
      `[isolation-fixture] Primary org ${PRIMARY_ORG_SLUG} not found. Run:\n` +
        `  npm run sso:test:setup`,
    )
  }

  return {
    isolationUserId,
    isolationOrgId: primaryOrg.id === isoOrg.id
      ? (() => {
          throw new Error(
            `[isolation-fixture] iso org and primary org are the same. Re-provision: ` +
              `npm run sso:test:cleanup:isolation && npm run sso:test:setup:isolation`,
          )
        })()
      : isoOrg.id,
    primaryOrgId: primaryOrg.id,
  }
}
