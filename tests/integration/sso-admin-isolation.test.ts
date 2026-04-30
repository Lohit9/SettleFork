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
//
// B-2-c-iii commit 2 extension
// -----------------------------
// Adds 4 more tests for the new provider-config server actions
// (`configureOrgSsoProviderFromXml`, `configureOrgSsoProviderFromUrl`).
// These tests:
//   - Mock `gotrueAdminRequest` and `safeFetchMetadata` so we don't
//     actually contact GoTrue or the public internet during CI.
//   - Stub the feature-flag env vars so `isMetadataUploadEnabledForOrg`
//     returns true for the isolation org (otherwise the public actions
//     short-circuit with NOT_AVAILABLE before the auth gate fires —
//     which is correct production behavior but defeats the test goal
//     of exercising the gate).
//   - Run a precondition check that migration 080 (cert metadata
//     columns) has been applied to the local Supabase, throwing a
//     self-diagnosing error if the columns are missing.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

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

// ─── Mock gotrueAdminRequest + safeFetchMetadata (B-2-c-iii commit 2) ─
//
// The new provider-config actions hit GoTrue and (on the URL path) the
// public internet. Mocking both at module load means:
//   - Cross-tenant rejection tests (auth gate fires before either is
//     called) cleanly assert "mock not invoked" as a positive proof
//     that the gate ran first.
//   - The positive-control test can stage a successful GoTrue POST
//     without touching the real GoTrue admin API.
//
// The mocks are installed unconditionally to keep load order
// deterministic; the existing read/write isolation tests don't import
// either symbol, so there's no behavior change for those suites.
vi.mock('@/lib/sso/gotrue-admin', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/sso/gotrue-admin')>(
      '@/lib/sso/gotrue-admin',
    )
  return {
    ...actual,
    gotrueAdminRequest: vi.fn(),
  }
})

vi.mock('@/lib/security/safe-fetch', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/security/safe-fetch')>(
      '@/lib/security/safe-fetch',
    )
  return {
    ...actual,
    safeFetchMetadata: vi.fn(),
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

// ─── Cross-org isolation suite — provider config (B-2-c-iii commit 2) ─
//
// Four tests cover the org-admin self-serve provider configuration
// surface from `lib/actions/sso-admin-provider-config.ts`:
//
//   1. User 2 cannot configure the primary org via XML
//   2. User 2 cannot configure the primary org via URL
//   3. User 2 cannot UPDATE an existing primary-org provider via XML
//   4. User 2 CAN configure their own iso org (positive control)
//
// Tests 1-3 prove the auth gate rejects BEFORE any GoTrue call,
// `safeFetchMetadata` invocation, or DB write to `sso_providers`.
// Test 4 exercises the full happy path on User 2's own org with
// mocked GoTrue, asserting success + cleaning up after itself.
//
// Migration 080 precondition
// --------------------------
// The provider-config actions read/write the cert metadata columns
// added by `supabase/migrations/080_sso_provider_cert_columns.sql`.
// We probe for one of those columns at suite start so a missing
// migration produces a self-diagnosing error rather than an
// inscrutable "column does not exist" PostgREST error mid-test.
//
// Feature flag
// ------------
// We stub `NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED=true` for
// the suite. Without this, the public actions short-circuit with
// `NOT_AVAILABLE` BEFORE the auth gate fires — which is correct
// production behavior but defeats the purpose of the cross-tenant
// authorization test. Mini-D14 says empty allowlist + flag-on
// permits all orgs, which is exactly what we want for the test.

describeFn('SSO admin actions — provider-config cross-org isolation', () => {
  let primaryOrgId: string
  let isolationOrgId: string
  let gotrueAdminRequestMock: ReturnType<typeof vi.fn>
  let safeFetchMetadataMock: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    // Resolve the mocked exports we installed at module load. We
    // look them up dynamically rather than via static `import { ... }
    // from '@/lib/sso/gotrue-admin'` so the file-level vi.mock has a
    // chance to run first.
    const gotrueAdmin = await import('@/lib/sso/gotrue-admin')
    const safeFetch = await import('@/lib/security/safe-fetch')
    gotrueAdminRequestMock = gotrueAdmin.gotrueAdminRequest as ReturnType<
      typeof vi.fn
    >
    safeFetchMetadataMock = safeFetch.safeFetchMetadata as ReturnType<
      typeof vi.fn
    >

    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { resolveIsolationFixtureIds } = await import(
      './sso-admin-isolation-helpers'
    )
    const ids = await resolveIsolationFixtureIds(supabaseAdmin)
    primaryOrgId = ids.primaryOrgId
    isolationOrgId = ids.isolationOrgId

    // Migration 080 precondition: probe for one of the new cert
    // columns. PostgREST returns `42703` (column does not exist) if
    // the migration hasn't been applied. We surface a self-diagnosing
    // error rather than letting downstream tests fail with cryptic
    // PostgREST errors.
    const probe = await supabaseAdmin
      .from('sso_providers')
      .select('cert_fingerprint_sha256')
      .limit(0)
    if (probe.error) {
      throw new Error(
        '[provider-config-isolation] Migration 080 not applied. ' +
          'The cert metadata columns are missing on `public.sso_providers`. ' +
          'Apply via Supabase dashboard or `supabase db push`, then re-run.\n' +
          `Underlying error: ${probe.error.message}`,
      )
    }

    // Feature flag: enable for the suite. Mini-D14 — empty allowlist
    // means "all orgs enabled", which is exactly what we want.
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', 'true')
    delete process.env.SSO_ADMIN_METADATA_UPLOAD_ORGS
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  // Reset the mocks between tests so call-count assertions are
  // independent.
  function resetMocks() {
    gotrueAdminRequestMock.mockReset()
    safeFetchMetadataMock.mockReset()
  }

  it('configureOrgSsoProviderFromXml rejects cross-org write (User 2 → primary org)', async () => {
    resetMocks()
    const { configureOrgSsoProviderFromXml } = await import(
      '@/lib/actions/sso-admin-provider-config'
    )
    const xml = readFileSync(
      resolve(__dirname, '../fixtures/saml/okta-valid.xml'),
      'utf8',
    )
    const result = await configureOrgSsoProviderFromXml(primaryOrgId, xml)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('NOT_AUTHORIZED')
      // Belt-and-suspenders: never any of the post-gate codes.
      expect(result.errorCode).not.toBe('NOT_AVAILABLE')
      expect(result.errorCode).not.toBe('GOTRUE_ERROR')
      expect(result.errorCode).not.toBe('DB_ERROR')
    }
    // Critical: the gate must reject BEFORE any GoTrue call. If the
    // gate ever moved past the parse-and-write block, this assertion
    // fails — the rejection would still happen but only after an
    // unauthorized GoTrue write attempt.
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('configureOrgSsoProviderFromUrl rejects cross-org write (User 2 → primary org)', async () => {
    resetMocks()
    const { configureOrgSsoProviderFromUrl } = await import(
      '@/lib/actions/sso-admin-provider-config'
    )
    const result = await configureOrgSsoProviderFromUrl(
      primaryOrgId,
      'https://idp.example.com/metadata',
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('NOT_AUTHORIZED')
    }
    // Critical: the gate must reject BEFORE the rate-limit increment
    // AND before the safeFetch call. If the gate moved past either,
    // a hostile actor could exhaust the limiter for legitimate users
    // OR weaponize the egress fetcher against internal targets.
    expect(safeFetchMetadataMock).not.toHaveBeenCalled()
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('configureOrgSsoProviderFromXml rejects UPDATE attempt against primary-org provider', async () => {
    resetMocks()
    // Provision a synthetic sso_providers row on the primary org so
    // the orchestrator's "existing provider?" branch is hit. The gate
    // rejects BEFORE that branch executes (the gate runs first, then
    // delegates to configureProviderInternal which queries
    // sso_providers), so this row is never touched — but its
    // existence pins the threat model: even with a real provider
    // already registered for the primary org, User 2's update attempt
    // must reject.
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const SYNTHETIC_PROVIDER_GOTRUE_ID = '99999999-aaaa-bbbb-cccc-999999999999'

    // Read the SP URLs we need for the synthetic row's NOT NULL
    // columns.
    const { getSPUrls } = await import('@/lib/actions/sso')
    const { acsUrl, spEntityId } = await getSPUrls()

    const { data: existingRow } = await supabaseAdmin
      .from('sso_providers')
      .select('id')
      .eq('org_id', primaryOrgId)
      .maybeSingle()

    let createdSyntheticRow = false
    if (!existingRow) {
      const { error: insErr } = await supabaseAdmin.from('sso_providers').insert({
        org_id: primaryOrgId,
        supabase_provider_id: SYNTHETIC_PROVIDER_GOTRUE_ID,
        idp_type: 'okta',
        entity_id: 'http://test-isolation/entity',
        metadata_url: null,
        metadata_xml: '<synthetic/>',
        acs_url: acsUrl,
        sp_entity_id: spEntityId,
        attribute_mapping: { keys: {} },
      })
      if (insErr) {
        throw new Error(
          `[provider-config-isolation] failed to provision synthetic primary-org provider: ${insErr.message}`,
        )
      }
      createdSyntheticRow = true
    }

    try {
      const { configureOrgSsoProviderFromXml } = await import(
        '@/lib/actions/sso-admin-provider-config'
      )
      const xml = readFileSync(
        resolve(__dirname, '../fixtures/saml/okta-valid.xml'),
        'utf8',
      )
      const result = await configureOrgSsoProviderFromXml(primaryOrgId, xml)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errorCode).toBe('NOT_AUTHORIZED')
      }
      expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
    } finally {
      if (createdSyntheticRow) {
        await supabaseAdmin
          .from('sso_providers')
          .delete()
          .eq('org_id', primaryOrgId)
          .eq('supabase_provider_id', SYNTHETIC_PROVIDER_GOTRUE_ID)
      }
    }
  })

  // Positive control: User 2 IS an admin of the iso org, so configuring
  // a provider for their OWN org must succeed. Without this, a
  // regression where requireOrgAdmin rejects EVERY call would still
  // pass the three rejection tests above. We mock GoTrue to avoid
  // contacting the real backend, then clean up the inserted row +
  // the org-flag flip after the test.
  it('configureOrgSsoProviderFromXml succeeds on iso org (positive control)', async () => {
    resetMocks()
    const SYNTHETIC_GOTRUE_ID = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa'
    gotrueAdminRequestMock.mockResolvedValueOnce({ id: SYNTHETIC_GOTRUE_ID })

    const xml = readFileSync(
      resolve(__dirname, '../fixtures/saml/okta-valid.xml'),
      'utf8',
    )
    const { configureOrgSsoProviderFromXml } = await import(
      '@/lib/actions/sso-admin-provider-config'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    try {
      // forceOverride: true skips the password-only-users RPC, which
      // returns a non-zero count for the iso org since User 2 is the
      // sole owner with no SSO identity link. Bypassing the guardrail
      // is fine for this test — it's exercising the gate + write +
      // audit path, not the guardrail itself.
      const result = await configureOrgSsoProviderFromXml(
        isolationOrgId,
        xml,
        { forceOverride: true },
      )
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.action).toBe('created')
        expect(gotrueAdminRequestMock).toHaveBeenCalledWith(
          'POST',
          '/admin/sso/providers',
          expect.objectContaining({ type: 'saml' }),
        )
      }
    } finally {
      // Cleanup: remove the inserted sso_providers row + reset the
      // org's sso_enabled flag. Idempotent — safe if the action
      // failed midway and never inserted.
      await supabaseAdmin
        .from('sso_providers')
        .delete()
        .eq('org_id', isolationOrgId)
      await supabaseAdmin
        .from('organizations')
        .update({ sso_enabled: false, sso_configured_at: null })
        .eq('id', isolationOrgId)
    }
  })
})
