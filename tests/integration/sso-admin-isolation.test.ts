// @vitest-environment node
//
// Cross-org isolation tests for `lib/actions/sso-admin.ts` (B-2-c-i,
// Mini-D8) — wired up against a real second-tenant fixture in
// B-2-c-ii (commit 1).
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
// proves end-to-end: with two real users in two real orgs, User 2's
// session cannot pull Org 1's payloads.
//
// ─────────────────────────────────────────────────────────────────────
// Status (B-2-c-ii commit 1): EXECUTING (was SCAFFOLD)
// ─────────────────────────────────────────────────────────────────────
// The 5 cross-org tests below now execute end-to-end when
// `SETTLE_SSO_ADMIN_ISOLATION_TEST=1` is set AND the fixture has been
// provisioned via `npm run sso:test:setup:isolation`.
//
// How "act as User 2" works without a real cookie session
// -------------------------------------------------------
// Server actions read `cookies()` via `lib/supabase/server.ts`'s
// `createClient()`. Reproducing a real cookie session in a Node-only
// test environment is awkward (no Next.js request scope, no PKCE
// round-trip). Instead, this file uses the same `vi.mock` pattern
// that the Heritage integration suite already established at
// `tests/integration/bulk-approve-heritage.test.ts:64-82`:
//   - `vi.mock('@/lib/supabase/server', ...)` replaces `createClient`
//     with a service-role-backed shim whose `auth.getUser()` returns
//     User 2's UUID.
//   - Membership lookups in `requireOrgAdmin` fall through to
//     `supabaseAdmin.from('org_memberships')` which queries the real
//     DB. So the gate's behavior is *identical* to a real session —
//     we've just replaced "where does the auth.uid come from?" with
//     "the test fixture's User 2 UUID."
//
// What we did NOT do, and why (Mini-D session 2026-04-28, hybrid path)
// --------------------------------------------------------------------
// We did not provision a second Okta SAML app, a second Okta user, or
// the password sign-in flow originally imagined in the B-2-c-i
// scaffold. None of that machinery is needed to test the
// authorization gate — only `auth.users` row existence and
// `org_memberships` row absence/presence are load-bearing for
// `requireOrgAdmin`. The end-to-end SAML round-trip path for a second
// tenant is recorded as a follow-up item in
// `docs/outstanding-items.md` — appropriate when we need to test the
// IdP boundary itself, not before.
//
// Forward-compatibility for B-2-c-ii commit 2
// -------------------------------------------
// Commit 2 of B-2-c-ii adds three executing tests for the new write
// actions (`addOrgSsoDomain`, `removeOrgSsoDomain`,
// `setOrgEnforcementMode`) plus a positive-control write. Those
// tests reuse this file's `vi.mock` and fixture-resolution helpers
// without modification.

import { describe, it, expect, vi, beforeAll } from 'vitest'

// ─── Env gate ────────────────────────────────────────────────────────

const RUN_ISOLATION = process.env.SETTLE_SSO_ADMIN_ISOLATION_TEST === '1'

const HAS_BASE_ENV =
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const HAS_ENV = RUN_ISOLATION && HAS_BASE_ENV

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Mock the SSR client to impersonate User 2 ───────────────────────
//
// vi.mock is hoisted to the top of the file and runs once at module
// load. The factory closure caches User 2's UUID after the first
// `auth.getUser()` invocation so the membership lookups inside
// `requireOrgAdmin` see a consistent identity throughout the test
// run.
//
// The mock is installed unconditionally, but it has zero effect on
// the always-runs sanity invariants below: those tests only call
// `readFileSync` and never invoke any server action. The
// User-2-resolution DB call inside `auth.getUser()` only fires when
// a server action is actually invoked — i.e. inside the env-gated
// describe block.

vi.mock('@/lib/supabase/server', async () => {
  const adminMod =
    await vi.importActual<typeof import('@/lib/supabase/admin')>(
      '@/lib/supabase/admin',
    )
  const { supabaseAdmin } = adminMod

  // Inline copy of `ISO_USER_EMAIL` from
  // `tests/integration/sso-admin-isolation-helpers.ts`. We can't
  // import the helper file inside this hoisted factory because the
  // import would race with vi.mock's own evaluation order; literal
  // duplication here is the safer pattern. If the email changes,
  // update both places (the helper file's docstring flags this).
  const ISO_USER_EMAIL = 'kaandincer1+ssoisolation@gmail.com'

  let cachedUser2Id: string | null = null

  async function resolveUser2Id(): Promise<string> {
    if (cachedUser2Id) return cachedUser2Id
    const { data, error } = await supabaseAdmin.rpc(
      'find_auth_user_by_email',
      { p_email: ISO_USER_EMAIL },
    )
    if (error) {
      throw new Error(
        `[isolation-mock] resolve User 2 failed: ${error.message}. ` +
          `Run: npm run sso:test:setup:isolation`,
      )
    }
    if (!data || data.length === 0) {
      throw new Error(
        `[isolation-mock] User ${ISO_USER_EMAIL} not found. Run: ` +
          `npm run sso:test:setup:isolation`,
      )
    }
    cachedUser2Id = data[0].id as string
    return cachedUser2Id
  }

  return {
    createClient: async () => ({
      auth: {
        getUser: async () => {
          const id = await resolveUser2Id()
          return { data: { user: { id } }, error: null }
        },
      },
      from: supabaseAdmin.from.bind(supabaseAdmin),
      rpc: supabaseAdmin.rpc.bind(supabaseAdmin),
    }),
  }
})

// ─── Always-runs sanity invariants ───────────────────────────────────
//
// The unit tests at `tests/lib/auth/require-org-role.test.ts` already
// cover the unauthenticated/not_member/insufficient_role branches of
// `requireOrgAdmin` against a fully mocked SSR client. THIS suite's
// always-runs block does two source-shape checks that catch
// gate-removal regressions even when the env-gated suite is skipped:
// they read the action file as text and assert that every action
// imports and (textually) uses `requireOrgAdmin`.
//
// Source-shape duplication of the auth-gate placement check in
// `tests/actions/sso-admin-source.test.ts` is intentional — when
// the runtime suite below lights up under env gating, the same
// invariant must still hold even though the runtime test is the
// load-bearing one.

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

// ─── Cross-org isolation suite (env-gated, EXECUTING) ────────────────

describeFn('SSO admin actions — cross-org isolation (read actions)', () => {
  // Resolved at suite startup from the fixture provisioned by
  // `npm run sso:test:setup:isolation`. If the fixture is missing,
  // beforeAll throws a self-diagnosing error.
  let primaryOrgId: string
  let isolationOrgId: string

  beforeAll(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { resolveIsolationFixtureIds } = await import(
      './sso-admin-isolation-helpers'
    )
    const ids = await resolveIsolationFixtureIds(supabaseAdmin)
    primaryOrgId = ids.primaryOrgId
    isolationOrgId = ids.isolationOrgId
  })

  it('getOrgSsoOverview rejects cross-org access (User 2 → primary org)', async () => {
    const { getOrgSsoOverview } = await import('@/lib/actions/sso-admin')
    const result = await getOrgSsoOverview(primaryOrgId)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The rejection must come from the auth gate
      // (`requireOrgAdmin` returning `not_member`), not a downstream
      // DB error. The gate's user-facing error string starts with
      // "Not a member" / "Role" — a "Failed" prefix would mean we
      // reached a service-role read past the gate, which is the
      // exact regression this test is here to catch.
      expect(result.error).not.toMatch(/^Failed/)
    }
  })

  it('listOrgSsoDomains rejects cross-org access (User 2 → primary org)', async () => {
    const { listOrgSsoDomains } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoDomains(primaryOrgId)
    expect(result.ok).toBe(false)
  })

  it('listOrgSsoLinkedUsers rejects cross-org access (User 2 → primary org)', async () => {
    const { listOrgSsoLinkedUsers } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoLinkedUsers(primaryOrgId)
    expect(result.ok).toBe(false)
    // CRITICAL: this action uses `supabaseAdmin` (RLS bypass) for
    // the actual data read. The gate is the only thing standing
    // between User 2 and the primary org's user list. If this
    // assertion ever fails, every linked-user list in the system
    // is exposed cross-tenant.
  })

  it('listOrgSsoAuditEvents rejects cross-org access (User 2 → primary org)', async () => {
    const { listOrgSsoAuditEvents } = await import('@/lib/actions/sso-admin')
    const result = await listOrgSsoAuditEvents(primaryOrgId)
    expect(result.ok).toBe(false)
    // Same critical posture as linked-users — bypass via service
    // role makes the gate load-bearing.
  })

  // Positive control: User 2 IS an admin of the isolation org, so
  // calling getOrgSsoOverview against User 2's own org should
  // succeed. Without this, a regression where `requireOrgAdmin`
  // rejected EVERY call would still pass the four rejection tests
  // above. Pinning the positive path keeps the suite honest.
  it('User 2 can read User 2 own org (positive control)', async () => {
    const { getOrgSsoOverview } = await import('@/lib/actions/sso-admin')
    const result = await getOrgSsoOverview(isolationOrgId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The iso org has sso_enabled=false (no provider/domain
      // attached) — confirm the action returns the expected
      // disabled-but-readable shape.
      expect(result.sso_enabled).toBe(false)
    }
  })
})

// ─── Cross-org isolation suite — write actions (B-2-c-ii commit 2) ───
//
// These tests prove that `requireOrgAdmin` rejects cross-tenant write
// attempts. The negative paths NEVER touch the DB (the gate rejects
// before any insert/update/delete + before any audit emit), so no
// cleanup is needed for them.
//
// The combined positive control DOES write to the real DB — it adds
// a synthetic domain to User 2's iso org, then removes it, then
// touches the enforcement-mode setter. Each step cleans up after
// itself; if a step throws midway, the next test run's cleanup
// fixture (`npm run sso:test:cleanup:isolation`) tears the iso org
// down entirely.

describeFn('SSO admin actions — cross-org isolation (write actions)', () => {
  let primaryOrgId: string
  let isolationOrgId: string

  beforeAll(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { resolveIsolationFixtureIds } = await import(
      './sso-admin-isolation-helpers'
    )
    const ids = await resolveIsolationFixtureIds(supabaseAdmin)
    primaryOrgId = ids.primaryOrgId
    isolationOrgId = ids.isolationOrgId
  })

  it('addOrgSsoDomain rejects cross-org write (User 2 → primary org)', async () => {
    const { addOrgSsoDomain } = await import('@/lib/actions/sso-admin-mutations')
    const result = await addOrgSsoDomain(primaryOrgId, 'iso-attempt.example')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('NOT_AUTHORIZED')
      // Never the validation-failure or DB-error path — those would
      // mean the action made it past the gate.
      expect(result.errorCode).not.toBe('VALIDATION')
      expect(result.errorCode).not.toBe('DB_ERROR')
      expect(result.errorCode).not.toBe('DOMAIN_ALREADY_MAPPED')
    }
    // CRITICAL: the action must NOT have emitted an audit event for
    // this rejection (auditing is post-success only). We can't
    // observe sso_audit_events here without an extra query, but the
    // source-level test
    // `tests/actions/sso-admin-mutations-source.test.ts` pins
    // emit-after-write ordering — combined with this rejection, the
    // emit could only fire on a write that never happened.
  })

  it('removeOrgSsoDomain rejects cross-org write (User 2 → primary org)', async () => {
    const { removeOrgSsoDomain } = await import('@/lib/actions/sso-admin-mutations')
    // The primary org has `gmail.com` attached. If the gate failed,
    // this delete would silently succeed and break the primary
    // fixture. Belt-and-suspenders: the runtime rejection gate plus
    // the source-level ordering invariant make this unreachable.
    const result = await removeOrgSsoDomain(primaryOrgId, 'gmail.com')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('NOT_AUTHORIZED')
    }
  })

  it('setOrgEnforcementMode rejects cross-org write (User 2 → primary org)', async () => {
    const { setOrgEnforcementMode } = await import(
      '@/lib/actions/sso-admin-mutations'
    )
    const result = await setOrgEnforcementMode(primaryOrgId, 'strict')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('NOT_AUTHORIZED')
    }
  })

  // Positive control — full round-trip on User 2's OWN org. Verifies
  // the gate's positive branch + the audit emits actually fire when
  // the caller is authorized. Each step cleans up after itself.
  it('User 2 can perform write round-trip on User 2 own org (positive control)', async () => {
    const {
      addOrgSsoDomain,
      removeOrgSsoDomain,
      setOrgEnforcementMode,
    } = await import('@/lib/actions/sso-admin-mutations')

    const SYNTHETIC_DOMAIN = 'sso-iso-rt.example.invalid'

    // ADD
    const addResult = await addOrgSsoDomain(isolationOrgId, SYNTHETIC_DOMAIN)
    expect(addResult.ok).toBe(true)
    try {
      if (addResult.ok) {
        expect(addResult.domain.domain).toBe(SYNTHETIC_DOMAIN)
      }

      // REMOVE — also serves as cleanup for the ADD above.
      const remResult = await removeOrgSsoDomain(isolationOrgId, SYNTHETIC_DOMAIN)
      expect(remResult.ok).toBe(true)
      if (remResult.ok) {
        // The iso org had ONE domain (the one we just added), so
        // was_last_domain must be true.
        expect(remResult.was_last_domain).toBe(true)
      }

      // SET MODE — read the iso org's current mode first, then call
      // the setter with that same value to force a no-op. We avoid
      // hard-coding the default ('optional' today, but migration
      // history could change it) by querying first. The action must
      // report ok:true with was_no_op:true, proving the gate passes
      // AND the no-op path returns success.
      const { supabaseAdmin } = await import('@/lib/supabase/admin')
      const { data: orgRow } = await supabaseAdmin
        .from('organizations')
        .select('enforcement_mode')
        .eq('id', isolationOrgId)
        .single()
      const currentMode = orgRow?.enforcement_mode as
        | 'strict'
        | 'hybrid'
        | 'optional'
        | undefined
      expect(currentMode).toBeDefined()
      const setResult = await setOrgEnforcementMode(isolationOrgId, currentMode!)
      expect(setResult.ok).toBe(true)
      if (setResult.ok) {
        expect(setResult.was_no_op).toBe(true)
        expect(setResult.new_mode).toBe(currentMode)
      }
    } finally {
      // Defensive cleanup: if any earlier step threw, ensure the
      // synthetic domain is gone before the next test run. The
      // remove action is idempotent so a no-op delete is fine.
      await removeOrgSsoDomain(isolationOrgId, SYNTHETIC_DOMAIN)
    }
  })
})
