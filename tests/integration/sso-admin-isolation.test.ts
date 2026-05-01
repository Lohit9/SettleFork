// @vitest-environment node
//
// Cross-org isolation tests for `lib/actions/sso-admin.ts` (B-2-c-i,
// Mini-D8).
//
// Why this file exists
// --------------------
// The four `sso-admin` actions use `supabaseAdmin` for two of their
// reads (`sso_identity_links`, `sso_audit_events`), bypassing RLS.
// `requireOrgAdmin(orgId)` is the single boundary preventing User A
// in Org A from reading Org B's data. The unit tests for the helper
// (`tests/lib/auth/require-org-role.test.ts`) cover the gate's
// behavior in isolation; the source-level tests
// (`tests/actions/sso-admin-source.test.ts`) verify the gate runs
// before any DB access. THIS file is the integration backstop that
// proves end-to-end: with two real users in two real orgs, User A's
// session cannot pull Org B's payloads.
//
// ─────────────────────────────────────────────────────────────────────
// Status (B-2-c-i first commit): SCAFFOLD
// ─────────────────────────────────────────────────────────────────────
// The `it.skip` markers below ship the test pattern but do not run
// the assertions. They document EXACTLY what subsequent commits will
// flip to `it(...)` once the second-user fixture is in place.
//
// What's missing for a runnable suite
// -----------------------------------
// `scripts/sso-test-setup.ts` provisions ONE test user
// (`alice-sso-test@example.com`) in ONE org (`SSO Test`). The
// isolation tests need a SECOND user in a SECOND org. The right
// follow-up is to extend that script with a second `(user, org)`
// pair — call it `OUTSIDER` — and add a teardown helper that removes
// both. A separate commit (likely under B-2-c-ii's domain editor
// work, where the same fixture is useful) will:
//
//   1. Add `OUTSIDER_EMAIL`, `OUTSIDER_ORG_NAME`, etc. constants to
//      `scripts/sso-test-setup.ts` mirroring the existing constants.
//   2. Provision a second user/org pair with a non-overlapping
//      domain (e.g. `outsider.example`) and minimal SSO state so
//      `listOrgSsoLinkedUsers` and `listOrgSsoAuditEvents` return
//      non-empty data when queried by the outsider's own admin —
//      i.e. there IS data in Org B, and Alice (Org A admin) must
//      not see it.
//   3. Add a sign-in helper that mints a session cookie for the
//      desired user (the existing setup script signs Alice in via
//      `supabase.auth.signInWithPassword`; we replicate for the
//      outsider).
//   4. Flip every `it.skip` below to `it`.
//   5. Document in `docs/outstanding-items.md` that B-2-c-ii (or
//      whichever sub-prompt runs the flip) re-enables this suite.
//
// Why we ship the scaffold now
// ----------------------------
// The cross-org isolation pattern is itself a deliverable of
// B-2-c-i. Future sub-prompts (`-ii` adds domain mutations, `-iii`
// uploads IdP metadata, `-iv` runs test-connection, `-v` rotates
// certs) all add server actions that read or mutate org-scoped data.
// Each must add a corresponding skipped test here at landing time so
// the gate is visible in the diff. By the time the second-user
// fixture lands, this file should already document every action's
// expected isolation behavior, not just B-2-c-i's four.

import { describe, it, expect } from 'vitest'

// ─── Env gate ────────────────────────────────────────────────────────

const RUN_ISOLATION =
  process.env.SETTLE_SSO_ADMIN_ISOLATION_TEST === '1'

const HAS_BASE_ENV =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const HAS_ENV = RUN_ISOLATION && HAS_BASE_ENV

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Sanity invariants that run in any environment ───────────────────
//
// The unit tests at `tests/lib/auth/require-org-role.test.ts` already
// cover the unauthenticated/not_member/insufficient_role branches of
// `requireOrgAdmin` against a fully mocked SSR client. We can't
// faithfully repeat that here without mocking — the helper uses
// `next/headers#cookies()`, which throws outside a request scope,
// so a "real" call from a Node-only test environment can't reach
// the auth-rejection branch.
//
// Instead, this suite does two source-shape checks that ARE safe
// in any environment: they read the action file as text and assert
// that every action imports and (textually) uses `requireOrgAdmin`.
// Source-shape duplication of the auth-gate placement check in
// `tests/actions/sso-admin-source.test.ts` is intentional — when
// this file lights up under env gating, the same invariant must
// still hold even though the runtime test is the load-bearing one.
//
// If a future commit removes the import or stops calling the gate,
// these always-runs tests fail at every CI run — well before the
// env-gated suite even loads.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SSO_ADMIN_SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/sso-admin.ts'),
  'utf8',
)

describe('SSO admin actions — sanity invariants (always runs)', () => {
  it('imports requireOrgAdmin from the canonical helper path', () => {
    expect(SSO_ADMIN_SRC).toMatch(
      /import\s+\{[^}]*\brequireOrgAdmin\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/require-org-role['"]/,
    )
  })

  it('every exported action calls requireOrgAdmin(orgId)', () => {
    const actions = [
      'getOrgSsoOverview',
      'listOrgSsoDomains',
      'listOrgSsoLinkedUsers',
      'listOrgSsoAuditEvents',
    ] as const
    for (const name of actions) {
      const start = SSO_ADMIN_SRC.indexOf(`export async function ${name}(`)
      expect(start, `${name} declaration not found`).toBeGreaterThan(-1)
      // Walk to the first matching closing brace at depth 0.
      let depth = 0
      let i = SSO_ADMIN_SRC.indexOf('{', start)
      const bodyStart = i
      for (; i < SSO_ADMIN_SRC.length; i++) {
        const ch = SSO_ADMIN_SRC[i]
        if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) break
      }
      const body = SSO_ADMIN_SRC.slice(bodyStart, i + 1)
      expect(body, `${name} must call requireOrgAdmin(orgId)`).toMatch(
        /\brequireOrgAdmin\(\s*orgId\s*\)/,
      )
    }
  })
})

// ─── Cross-org isolation suite (env-gated, currently skipped) ────────

describeFn('SSO admin actions — cross-org isolation', () => {
  // FIXTURE PRECONDITIONS (when un-skipped):
  //
  //   - Alice is signed in (session cookie present) and is an admin
  //     of `aliceOrg`.
  //   - `outsiderOrg` exists with at least one row in each of
  //     `sso_providers`, `sso_domains`, `sso_identity_links`,
  //     `sso_audit_events`. Alice MUST NOT be a member of
  //     `outsiderOrg`.
  //   - `aliceOrg.id !== outsiderOrg.id`.
  //
  // These IDs are placeholders — populated from env vars by the
  // follow-up commit that wires the fixture.
  const aliceOrgId =
    process.env.SSO_ISOLATION_ALICE_ORG_ID ??
    '00000000-0000-0000-0000-000000000001'
  const outsiderOrgId =
    process.env.SSO_ISOLATION_OUTSIDER_ORG_ID ??
    '00000000-0000-0000-0000-000000000002'

  it.skip('getOrgSsoOverview rejects cross-org access (Alice → outsiderOrg)', async () => {
    const { getOrgSsoOverview } = await import('@/lib/actions/sso-admin')
    const result = await getOrgSsoOverview(outsiderOrgId)
    expect(result.ok).toBe(false)
    // Either `not_member` (Alice has no membership in outsiderOrg)
    // or `insufficient_role` (a future change might give
    // cross-org viewer roles). Both must reject; ok=true is
    // catastrophic.
    if (!result.ok) {
      expect(result.error).not.toMatch(/Failed/) // rejection from
      // the auth gate, not a downstream DB error
    }
  })

  it.skip('listOrgSsoDomains rejects cross-org access (Alice → outsiderOrg)', async () => {
    const { listOrgSsoDomains } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoDomains(outsiderOrgId)
    expect(result.ok).toBe(false)
  })

  it.skip('listOrgSsoLinkedUsers rejects cross-org access (Alice → outsiderOrg)', async () => {
    const { listOrgSsoLinkedUsers } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoLinkedUsers(outsiderOrgId)
    expect(result.ok).toBe(false)
    // CRITICAL: this action uses `supabaseAdmin` (RLS bypass) for
    // the actual data read. The gate is the only thing standing
    // between Alice and outsider's user list. If this assertion
    // ever fails, every linked-user list in the system is exposed
    // cross-tenant.
  })

  it.skip('listOrgSsoAuditEvents rejects cross-org access (Alice → outsiderOrg)', async () => {
    const { listOrgSsoAuditEvents } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoAuditEvents(outsiderOrgId)
    expect(result.ok).toBe(false)
    // Same critical posture as linked-users — bypass via service
    // role makes the gate load-bearing.
  })

  // Positive control: Alice IS an admin of `aliceOrg`, so calling
  // her own org should succeed. Without this, a regression where
  // `requireOrgAdmin` rejected EVERY call would still pass the
  // four rejection tests above. Pinning the positive path keeps
  // the suite honest.
  it.skip('Alice can read her own org (positive control)', async () => {
    const { getOrgSsoOverview } = await import('@/lib/actions/sso-admin')
    const result = await getOrgSsoOverview(aliceOrgId)
    expect(result.ok).toBe(true)
  })
})
