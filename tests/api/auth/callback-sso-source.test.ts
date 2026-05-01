// @vitest-environment node
//
// Source-level invariant tests for the ?type=sso branch in
// `app/api/auth/callback/route.ts` and the cookie-set in
// `app/sso/start/route.ts`.
//
// Why source-level (not a runtime SSR/Supabase mock):
//   The established convention in this repo (see
//   `tests/actions/projects.test.ts`, `tests/actions/bulk-approve.test.ts`,
//   `tests/lib/url-params-guard.test.ts`) is `readFileSync` + scoped
//   regex against the source. End-to-end runtime behavior is verified
//   by the manual SSO test loop (sso-test-setup → Phase 7 SAML round-
//   trip → SQL inspection of sso_audit_events / sso_identity_links).
//
// What this file pins:
//   - The SSO branch dispatches off `type === 'sso'` and is gated on
//     a successful exchangeCodeForSession (no double-exchange).
//   - Every uncertain failure step calls supabase.auth.signOut() and
//     emits a sso.login.failure audit event with metadata.reason.
//   - The identity-link step is non-blocking (no signOut, falls through
//     to success).
//   - mark_identity_sso_linked is called with the Settle PK (sso_provider_pk),
//     not the GoTrue UUID.
//   - JIT is called with the provider's resolved org_id (post-validation),
//     not the user-supplied attempted_org_id.
//   - All six new ?reason= codes appear on /login redirects.
//   - All seven new metadata.reason values appear in audit emits.
//   - /sso/start sets the signed attempt-org cookie on the redirect to GoTrue.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')

const CALLBACK_SRC = readFileSync(
  resolve(REPO_ROOT, 'app/api/auth/callback/route.ts'),
  'utf8'
)
const START_SRC = readFileSync(
  resolve(REPO_ROOT, 'app/sso/start/route.ts'),
  'utf8'
)

// Slice the SSO callback handler from the start of handleSsoCallback
// through the end of file, so cross-branch matches (e.g., the
// signup branch's `signOut`-free success path) cannot satisfy these
// assertions.
function sliceFromTo(src: string, startMarker: string, endMarker: string | null): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  if (endMarker === null) return src.slice(a)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const SSO_BRANCH_SRC = sliceFromTo(
  CALLBACK_SRC,
  'async function handleSsoCallback(',
  null
)

// Strip line+block comments. We strip LINE comments first (and block
// comments second) so that `// /app/*` inside a line comment cannot
// confuse the block-comment regex into eating across an unrelated
// `*/` later in the file. The `[^:]` lookbehind on `//` keeps `://`
// URLs from matching as line-comment starts.
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const SSO_BRANCH_CODE = stripComments(SSO_BRANCH_SRC)
const CALLBACK_CODE = stripComments(CALLBACK_SRC)
const START_CODE = stripComments(START_SRC)

// ─────────────────────────────────────────────────────────────────────
// Dispatch + exchange semantics
// ─────────────────────────────────────────────────────────────────────

describe('[callback / dispatch] type=sso routes to handleSsoCallback', () => {
  it('GET handler dispatches on type === \'sso\' before the signup/recovery branches', () => {
    // Guard order: the SSO branch must be checked at least as early
    // as the existing branches, so the fallback redirect cannot
    // accidentally swallow type=sso.
    const ssoCheck = CALLBACK_CODE.indexOf("type === 'sso'")
    const signupCheck = CALLBACK_CODE.indexOf("type === 'signup'")
    const recoveryCheck = CALLBACK_CODE.indexOf("type === 'recovery'")
    expect(ssoCheck).toBeGreaterThanOrEqual(0)
    expect(signupCheck).toBeGreaterThanOrEqual(0)
    expect(recoveryCheck).toBeGreaterThanOrEqual(0)
    expect(ssoCheck).toBeLessThan(signupCheck)
    expect(ssoCheck).toBeLessThan(recoveryCheck)
  })

  it('SSO branch is gated on a successful exchangeCodeForSession (shared with other branches)', () => {
    // exchangeCodeForSession appears EXACTLY once in the file. The
    // SSO branch reuses the existing call rather than exchanging
    // twice (which would re-consume the auth code and 400).
    const matches = CALLBACK_CODE.match(/exchangeCodeForSession\s*\(/g) ?? []
    expect(matches.length).toBe(1)
    // And the SSO dispatch happens AFTER the existing exchange call.
    const exchangeIdx = CALLBACK_CODE.indexOf('exchangeCodeForSession')
    const ssoCheckIdx = CALLBACK_CODE.indexOf("type === 'sso'")
    expect(exchangeIdx).toBeLessThan(ssoCheckIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Required imports
// ─────────────────────────────────────────────────────────────────────

describe('[callback / imports] SSO helpers are imported', () => {
  it('imports emitSsoAuditEvent from sso-audit', () => {
    expect(CALLBACK_CODE).toMatch(
      /import\s*\{\s*emitSsoAuditEvent\s*\}\s*from\s*['"]@\/lib\/actions\/sso-audit['"]/
    )
  })

  it('imports hashEmail from email-hash', () => {
    expect(CALLBACK_CODE).toMatch(
      /import\s*\{\s*hashEmail\s*\}\s*from\s*['"]@\/lib\/sso\/email-hash['"]/
    )
  })

  it('imports readAttemptOrgCookie and deleteAttemptOrgCookie from attempt-cookie', () => {
    expect(CALLBACK_CODE).toMatch(/readAttemptOrgCookie/)
    expect(CALLBACK_CODE).toMatch(/deleteAttemptOrgCookie/)
    expect(CALLBACK_CODE).toMatch(
      /from\s*['"]@\/lib\/sso\/attempt-cookie['"]/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// RPC contract — exact param shapes pinned
// ─────────────────────────────────────────────────────────────────────

describe('[callback / RPC params] each RPC is called with the right args', () => {
  it('calls get_auth_identity_providers with { p_user_id: userId } via supabaseAdmin', () => {
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]get_auth_identity_providers['"]\s*,\s*\{\s*p_user_id:\s*userId\s*\}\s*\)/
    )
  })

  it('looks up sso_providers row by supabase_provider_id (not by GoTrue UUID directly stored elsewhere)', () => {
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\s*\n?\s*\.from\(\s*['"]sso_providers['"]\s*\)[\s\S]*?\.eq\(\s*['"]supabase_provider_id['"]\s*,\s*supabaseProviderId\s*\)/
    )
  })

  it('calls lookup_sso_provider_for_domain with { p_email: userEmail }', () => {
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]lookup_sso_provider_for_domain['"]\s*,\s*\{\s*p_email:\s*userEmail\s*,?\s*\}\s*\)/
    )
  })

  it('calls provision_user_via_jit with the PROVIDER\'s resolved org_id (not attempted_org_id)', () => {
    // The validated provider org is what the membership is created
    // against. Using attempted_org_id here would defeat the cross-
    // tenant check (which equalizes them). We pin providerOrgId.
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]provision_user_via_jit['"]\s*,\s*\{[^}]*p_org_id:\s*providerOrgId/m
    )
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]provision_user_via_jit['"]\s*,\s*\{[^}]*p_email:\s*userEmail/m
    )
    expect(SSO_BRANCH_CODE).toMatch(
      /supabaseAdmin\.rpc\(\s*['"]provision_user_via_jit['"]\s*,\s*\{[^}]*p_user_id:\s*userId/m
    )
  })

  it('calls mark_identity_sso_linked with the Settle PK (ssoProviderPk), NOT the GoTrue UUID', () => {
    // CRITICAL: middle arg is sso_provider_id which is the Settle
    // sso_providers.id (PK), not supabaseProviderId (GoTrue UUID).
    // A regression here would write the wrong FK into
    // sso_identity_links and the FK CHECK would fail at insert time.
    const linkCallMatch = SSO_BRANCH_CODE.match(
      /supabaseAdmin\.rpc\(\s*['"]mark_identity_sso_linked['"]\s*,\s*\{[\s\S]*?\}\s*\)/
    )
    expect(linkCallMatch).not.toBeNull()
    const body = linkCallMatch![0]
    expect(body).toMatch(/p_user_id:\s*userId/)
    expect(body).toMatch(/p_sso_provider_id:\s*ssoProviderPk/)
    expect(body).toMatch(/p_org_id:\s*providerOrgId/)
    // And it must NOT pass supabaseProviderId in the middle slot —
    // that would silently break the FK.
    expect(body).not.toMatch(/p_sso_provider_id:\s*supabaseProviderId/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Fail-closed: every uncertain branch signs out + audits
// ─────────────────────────────────────────────────────────────────────

describe('[callback / fail-closed] hard failures signOut + audit + redirect', () => {
  // The `failAndAbort` helper centralizes signOut + audit + redirect.
  // We pin its presence and check that every hard-fail metadata.reason
  // value flows through it (vs. some bespoke path that might forget
  // a step).
  it('defines a failAndAbort helper that signs out, audits, and redirects', () => {
    expect(SSO_BRANCH_CODE).toMatch(/const\s+failAndAbort\s*=/)
    // Body of failAndAbort must contain signOut, emitSsoAuditEvent,
    // and a redirect.
    const helperMatch = SSO_BRANCH_CODE.match(
      /const\s+failAndAbort\s*=[\s\S]*?\n\s{0,4}\}\s*\n/
    )
    expect(helperMatch).not.toBeNull()
    const body = helperMatch![0]
    expect(body).toMatch(/supabase\.auth\.signOut\(\)/)
    expect(body).toMatch(/emitSsoAuditEvent\(\s*['"]sso\.login\.failure['"]/)
    expect(body).toMatch(/redirectAndConsume/)
  })

  it('every hard-fail metadata.reason flows through failAndAbort', () => {
    const HARD_FAIL_REASONS = [
      'attempted_org_missing',
      'provider_not_resolved',
      'cross_tenant',
      'domain_provider_mismatch',
      'duplicate_account',
      'jit_failed',
    ]
    for (const reason of HARD_FAIL_REASONS) {
      // Each reason appears as the first arg to failAndAbort.
      const re = new RegExp(`failAndAbort\\(\\s*['"\`]${reason}['"\`]`)
      expect(SSO_BRANCH_CODE).toMatch(re)
    }
  })

  it('every hard-fail redirect uses the matching ?reason= code', () => {
    const REDIRECT_REASONS = [
      'sso_attempted_org_missing',
      'sso_callback_error',
      'sso_cross_tenant',
      'sso_domain_mismatch',
      'sso_duplicate_account',
      'sso_jit_failed',
    ]
    for (const reason of REDIRECT_REASONS) {
      // Each reason appears as a string literal somewhere in the
      // SSO branch (passed to failAndAbort or in a final redirect).
      expect(SSO_BRANCH_CODE).toMatch(new RegExp(reason.replace(/_/g, '_')))
    }
  })

  it('every redirect inside the SSO branch consumes the attempt-org cookie', () => {
    // We pin TWO things:
    //   (a) `redirectAndConsume` is the only redirect helper used
    //       inside the SSO branch.
    //   (b) `failAndAbort` returns redirectAndConsume(...).
    // Together: every exit path deletes the cookie, regardless of
    // success/failure.
    expect(SSO_BRANCH_CODE).toMatch(/redirectAndConsume\(/)
    // Inside handleSsoCallback the only NextResponse.redirect call
    // sites are inside redirectAndConsume itself.
    const directRedirects =
      SSO_BRANCH_CODE.match(/NextResponse\.redirect\(/g) ?? []
    // One direct call inside redirectAndConsume's definition.
    expect(directRedirects.length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Identity-link is non-blocking
// ─────────────────────────────────────────────────────────────────────

describe('[callback / identity-link non-blocking]', () => {
  it('mark_identity_sso_linked failure does NOT call signOut and does NOT redirect to error', () => {
    // Anchor on the link RPC call, then take a small slice of code
    // following it (up to the success audit emit) and verify it
    // contains neither signOut nor a failAndAbort with identity_link_failed.
    const linkIdx = SSO_BRANCH_CODE.indexOf('mark_identity_sso_linked')
    expect(linkIdx).toBeGreaterThan(0)
    const successIdx = SSO_BRANCH_CODE.indexOf(
      "emitSsoAuditEvent('sso.login.success'",
      linkIdx
    )
    // Allow either single or double quotes around 'sso.login.success'.
    const altIdx = SSO_BRANCH_CODE.indexOf(
      'sso.login.success',
      linkIdx
    )
    const sliceEnd = successIdx > 0 ? successIdx : altIdx
    expect(sliceEnd).toBeGreaterThan(linkIdx)
    const between = SSO_BRANCH_CODE.slice(linkIdx, sliceEnd)
    expect(between).not.toMatch(/supabase\.auth\.signOut\(\)/)
    expect(between).not.toMatch(/failAndAbort\(\s*['"`]identity_link_failed/)
  })

  it('identity-link failure emits a sso.login.failure audit with reason=identity_link_failed and non_blocking=true', () => {
    // The non-blocking emit is its own branch, separate from
    // failAndAbort, since it must NOT signOut.
    expect(SSO_BRANCH_CODE).toMatch(
      /emitSsoAuditEvent\(\s*['"]sso\.login\.failure['"]\s*,\s*\{[\s\S]*?reason:\s*['"]identity_link_failed['"][\s\S]*?non_blocking:\s*true/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Success audit shape
// ─────────────────────────────────────────────────────────────────────

describe('[callback / success audit]', () => {
  it('emits sso.login.success with provider_id, email_hash, is_new_membership, assigned_role, identity_link_failed', () => {
    const successMatch = SSO_BRANCH_CODE.match(
      /emitSsoAuditEvent\(\s*['"]sso\.login\.success['"]\s*,\s*\{[\s\S]*?\}\s*\)/
    )
    expect(successMatch).not.toBeNull()
    const body = successMatch![0]
    expect(body).toMatch(/provider_id/)
    expect(body).toMatch(/email_hash/)
    expect(body).toMatch(/is_new_membership/)
    expect(body).toMatch(/assigned_role/)
    expect(body).toMatch(/identity_link_failed/)
    // orgId must be the validated providerOrgId, not the cookie value.
    expect(body).toMatch(/orgId:\s*providerOrgId/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Email hashing — never log raw emails as audit metadata
// ─────────────────────────────────────────────────────────────────────

describe('[callback / no raw PII in audit]', () => {
  it('every audit emit metadata that includes user identifiers passes through hashEmail', () => {
    // Heuristic: every emitSsoAuditEvent call inside the SSO branch
    // either has no email reference at all, or wraps it in
    // hashEmail(). A naive `email: userEmail` would leak PII.
    const emits =
      SSO_BRANCH_CODE.match(
        /emitSsoAuditEvent\([\s\S]*?\}\s*\)/g
      ) ?? []
    expect(emits.length).toBeGreaterThan(0)
    for (const emit of emits) {
      // If the emit references userEmail directly (not via hashEmail),
      // that's a leak.
      if (/userEmail/.test(emit)) {
        expect(emit).toMatch(/hashEmail\(\s*userEmail\s*\)/)
        // And no bare `email: userEmail` (only hashed forms allowed).
        expect(emit).not.toMatch(/[^_]email:\s*userEmail\b/)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// /sso/start cookie set
// ─────────────────────────────────────────────────────────────────────

describe('[/sso/start] sets the signed attempt-org cookie before redirecting to GoTrue', () => {
  it('imports setAttemptOrgCookie from attempt-cookie', () => {
    expect(START_CODE).toMatch(
      /import\s*\{\s*setAttemptOrgCookie\s*\}\s*from\s*['"]@\/lib\/sso\/attempt-cookie['"]/
    )
  })

  it('calls setAttemptOrgCookie(response, org.id) on the success-path redirect', () => {
    // The cookie set must use the validated `org.id` from the
    // sso_providers/organizations lookup, never any user-supplied
    // input. Pin that here.
    expect(START_CODE).toMatch(/setAttemptOrgCookie\(\s*\w+\s*,\s*org\.id\s*\)/)
  })

  it('does NOT set the attempt cookie on failure-redirect paths', () => {
    // Failure paths emit audit + redirect to /login?reason=... — they
    // must not leak an attempt cookie. Anchor: every setAttemptOrgCookie
    // call appears AFTER signInWithSSO returned data.url successfully.
    const setCalls = START_CODE.match(/setAttemptOrgCookie\(/g) ?? []
    // Exactly one call site, on the success path.
    expect(setCalls.length).toBe(1)
    const setIdx = START_CODE.indexOf('setAttemptOrgCookie(')
    const signInIdx = START_CODE.indexOf('signInWithSSO')
    expect(setIdx).toBeGreaterThan(signInIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// New audit reasons fit existing event_type taxonomy (no migration)
// ─────────────────────────────────────────────────────────────────────

describe('[audit taxonomy] no new event_type values needed', () => {
  it('SSO branch only uses sso.login.success and sso.login.failure event types', () => {
    const eventTypes =
      SSO_BRANCH_CODE.match(/emitSsoAuditEvent\(\s*['"]([^'"]+)['"]/g) ?? []
    expect(eventTypes.length).toBeGreaterThan(0)
    for (const e of eventTypes) {
      const m = e.match(/['"]([^'"]+)['"]/)
      expect(m).not.toBeNull()
      const eventType = m![1]
      expect(['sso.login.success', 'sso.login.failure']).toContain(eventType)
    }
  })
})
