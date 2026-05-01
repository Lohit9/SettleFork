// @vitest-environment node
//
// Source-level invariant tests for the rate-limit wiring in
// `app/sso/start/route.ts` (B-2-a-i).
//
// Why source-level (not runtime SSR mocks): repo convention. See
// `tests/api/auth/callback-sso-source.test.ts` and
// `tests/actions/projects.test.ts`. End-to-end behavior is verified
// by the manual SSO test loop (sso-test-setup → Phase 7 round-trip).
//
// What this file pins:
//   - Imports for getClientIp/hashIp + checkRateLimit are present
//   - Composite key is `${ip}:${orgSlug}` (not just IP, not just org)
//   - kind is 'sso-start', limit is 10, window is '60 s'
//   - Sliding window choice is enforced via the abstraction (no
//     manual fixed-window code in the route)
//   - Rate-limit block lives AFTER orgSlug regex validation and
//     BEFORE the org DB lookup
//   - Fail-closed null-IP path: redirect to sso_rate_limited, no audit
//   - Rate-limit hit path: emits sso.login.failure with reason='rate_limited'
//   - Rate-limit hit path: redirects to /login?reason=sso_rate_limited

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const START_SRC = readFileSync(
  resolve(REPO_ROOT, 'app/sso/start/route.ts'),
  'utf8'
)

// Strip line+block comments so prose like '/* prevents */' or
// '// rate limit hit' inside a comment cannot satisfy assertions.
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}
const START_CODE = stripComments(START_SRC)

// ─────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────

describe('[start / imports] rate-limit helpers are imported', () => {
  it('imports getClientIp and hashIp from @/lib/auth/get-client-ip', () => {
    expect(START_CODE).toMatch(
      /import\s*\{\s*getClientIp\s*,\s*hashIp\s*\}\s*from\s*['"]@\/lib\/auth\/get-client-ip['"]/
    )
  })

  it('imports checkRateLimit from @/lib/rate-limit/upstash', () => {
    expect(START_CODE).toMatch(
      /import\s*\{\s*checkRateLimit\s*\}\s*from\s*['"]@\/lib\/rate-limit\/upstash['"]/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Limiter shape
// ─────────────────────────────────────────────────────────────────────

describe('[start / limiter shape] kind, limit, window pinned', () => {
  it('uses kind: \'sso-start\'', () => {
    expect(START_CODE).toMatch(/kind:\s*['"]sso-start['"]/)
  })

  it('uses limit: 10', () => {
    expect(START_CODE).toMatch(/limit:\s*10\b/)
  })

  it('uses window: \'60 s\' (sliding window provided by abstraction)', () => {
    expect(START_CODE).toMatch(/window:\s*['"]60 s['"]/)
  })

  it('does NOT roll its own fixed-window counter (must use abstraction)', () => {
    // No raw Map/Date.now-based counter logic should appear in the
    // route handler — the limiter abstraction owns that concern.
    expect(START_CODE).not.toMatch(/new\s+Map\s*<[\s\S]{0,80}RateLimit/)
    expect(START_CODE).not.toMatch(/setInterval/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Composite key: ${ip}:${orgSlug}
// ─────────────────────────────────────────────────────────────────────

describe('[start / composite key] (ip, orgSlug) tuple', () => {
  it('builds the bucket key from BOTH ip and orgSlug', () => {
    // Template literal must include both. Single-key (just ip OR just
    // orgSlug) is wrong: per-IP-only lets one IP exhaust limits for
    // legitimate users; per-org-only lets a single attacker drain the
    // bucket for legitimate users targeting the same org.
    expect(START_CODE).toMatch(
      /checkRateLimit\(\s*`\$\{ip\}:\$\{orgSlug\}`/
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Ordering: AFTER slug regex, BEFORE org lookup
// ─────────────────────────────────────────────────────────────────────

describe('[start / ordering] rate-limit block placement', () => {
  it('rate-limit block runs AFTER the orgSlug regex validation', () => {
    const slugRegexIdx = START_CODE.indexOf('/^[a-z0-9]')
    const rlIdx = START_CODE.indexOf('checkRateLimit(')
    expect(slugRegexIdx).toBeGreaterThan(-1)
    expect(rlIdx).toBeGreaterThan(-1)
    expect(slugRegexIdx).toBeLessThan(rlIdx)
  })

  it('rate-limit block runs BEFORE the organizations DB lookup', () => {
    const rlIdx = START_CODE.indexOf('checkRateLimit(')
    const orgLookupIdx = START_CODE.indexOf("from('organizations')")
    expect(rlIdx).toBeGreaterThan(-1)
    expect(orgLookupIdx).toBeGreaterThan(-1)
    expect(rlIdx).toBeLessThan(orgLookupIdx)
  })

  it('rate-limit block runs BEFORE the unknown_org audit emit', () => {
    // Critical: prior to B-2-a-i the unknown_org branch wrote an
    // sso_audit_events row for every probe of an unknown slug. The
    // limiter must shield that path.
    const rlIdx = START_CODE.indexOf('checkRateLimit(')
    const unknownOrgIdx = START_CODE.indexOf("'unknown_org'")
    expect(rlIdx).toBeGreaterThan(-1)
    expect(unknownOrgIdx).toBeGreaterThan(-1)
    expect(rlIdx).toBeLessThan(unknownOrgIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Fail-closed null-IP path
// ─────────────────────────────────────────────────────────────────────

describe('[start / null-ip] fail-closed when getClientIp returns null', () => {
  it('checks for null IP via `if (!ip)`', () => {
    expect(START_CODE).toMatch(/const\s+ip\s*=\s*await\s+getClientIp\(\)/)
    expect(START_CODE).toMatch(/if\s*\(\s*!\s*ip\s*\)/)
  })

  it('null IP path redirects to /login?reason=sso_rate_limited', () => {
    // Find the null-ip branch — the first sso_rate_limited redirect
    // must come before the rate-limit-hit branch (which is gated on
    // !rlResult.allowed).
    const nullIpRedirectIdx = START_CODE.indexOf(
      "'/login?reason=sso_rate_limited'"
    )
    const rlAllowedIdx = START_CODE.indexOf('!rlResult.allowed')
    expect(nullIpRedirectIdx).toBeGreaterThan(-1)
    expect(rlAllowedIdx).toBeGreaterThan(-1)
    expect(nullIpRedirectIdx).toBeLessThan(rlAllowedIdx)
  })

  it('null IP path does NOT emit an audit event (no orgId attribution)', () => {
    // Slice from `if (!ip)` to the closing `}` (heuristic: until the
    // next `await checkRateLimit` call). emitSsoAuditEvent must NOT
    // appear in that range.
    const ipBranchStart = START_CODE.indexOf('if (!ip)')
    const rlCallIdx = START_CODE.indexOf('checkRateLimit(', ipBranchStart)
    expect(ipBranchStart).toBeGreaterThan(-1)
    expect(rlCallIdx).toBeGreaterThan(ipBranchStart)
    const ipBranch = START_CODE.slice(ipBranchStart, rlCallIdx)
    expect(ipBranch).not.toMatch(/emitSsoAuditEvent/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Rate-limit hit audit shape
// ─────────────────────────────────────────────────────────────────────

describe('[start / rate-limit hit] audit + redirect', () => {
  it('emits sso.login.failure with reason: \'rate_limited\'', () => {
    expect(START_CODE).toMatch(
      /emitSsoAuditEvent\(\s*['"]sso\.login\.failure['"]/
    )
    expect(START_CODE).toMatch(/reason:\s*['"]rate_limited['"]/)
  })

  it('audit metadata includes key_kind, ip_hash, target_hash', () => {
    expect(START_CODE).toMatch(/key_kind:\s*['"]sso-start['"]/)
    expect(START_CODE).toMatch(/ip_hash:\s*hashIp\(\s*ip\s*\)/)
    expect(START_CODE).toMatch(/target_hash:\s*orgSlug/)
  })

  it('audit metadata never includes the raw IP', () => {
    // The string `ip:` (assignment, not in a template literal) should
    // never appear inside an emitSsoAuditEvent metadata block. Use a
    // narrow slice around the rate-limit emit to assert.
    const emitIdx = START_CODE.indexOf('emitSsoAuditEvent')
    expect(emitIdx).toBeGreaterThan(-1)
    // Slice the emit's argument list (200 chars is enough for the call).
    const emitBlock = START_CODE.slice(emitIdx, emitIdx + 800)
    // The literal field name `ip:` should not appear inside the
    // metadata block — only ip_hash. (Template literal `${ip}` is in
    // a different part of the file, used in the bucket key.)
    expect(emitBlock).not.toMatch(/\bip:\s*ip\b/)
    expect(emitBlock).not.toMatch(/\braw_ip:/)
  })

  it('rate-limit hit path redirects to /login?reason=sso_rate_limited', () => {
    // At least one occurrence; the ordering test above asserts that
    // the null-ip occurrence comes first.
    const matches = START_CODE.match(/sso_rate_limited/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})
