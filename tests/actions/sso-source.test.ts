// @vitest-environment node
//
// Source-level invariant tests for `lib/actions/sso.ts:checkSSOEnabledForEmail`.
//
// Coverage spans BOTH B-2-a-i (rate-limit + return-shape narrowing)
// and B-2-b (broadening orgSlug for hybrid/optional orgs).
//
// What this file pins:
//   - getClientIp/hashIp/checkRateLimit + createHash imports present
//   - Limiter is invoked with kind: 'sso-check', limit: 10, window: '60 s'
//   - Composite key is `${ip}:${domainHash}` — domain-level (not
//     per-email) granularity
//   - Domain hash is 16-char SHA-256 hex (matches hashEmail / hashIp)
//   - Rate-limit check happens BEFORE the lookup_sso_provider_for_domain
//     RPC call (shields the DB from enumeration)
//   - Return shape: rate-limit hit returns { required: false }
//     (indistinguishable from "no SSO" — does not signal limit state)
//   - Function signature returns `{ required: boolean; orgSlug?: string }`
//     — orgId, providerId, enforcementMode are NOT returned
//   - Success path computes `required` from `enforcement_mode === 'strict'`
//     ONLY — hybrid + optional return required=false (B-2-b)
//   - Success path returns `orgSlug` whenever a provider row matches,
//     regardless of mode (hybrid/optional get the slug too — B-2-b)
//   - Audit on rate-limit hit emits sso.login.failure with reason='rate_limited'
//   - Raw IP is never echoed into audit metadata

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const SSO_SRC = readFileSync(
  resolve(REPO_ROOT, 'lib/actions/sso.ts'),
  'utf8'
)

function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}
const SSO_CODE = stripComments(SSO_SRC)

// Slice just the checkSSOEnabledForEmail body so cross-action matches
// (other actions in this file) cannot satisfy assertions.
function sliceFunction(src: string, signaturePrefix: string): string {
  const a = src.indexOf(signaturePrefix)
  if (a < 0) throw new Error(`signature not found: ${signaturePrefix}`)
  // Heuristic: stop at the next top-level `export async function` or the
  // section comment for the next action. This is fine for our purposes
  // since we're matching strings within a single ~80-line function.
  const stopMarkers = [
    'export async function getProviderConfigForOrg',
    '// Action 8:',
  ]
  let b = src.length
  for (const marker of stopMarkers) {
    const idx = src.indexOf(marker, a + signaturePrefix.length)
    if (idx >= 0 && idx < b) b = idx
  }
  return src.slice(a, b)
}

const CHECK_FN_CODE = sliceFunction(
  SSO_CODE,
  'export async function checkSSOEnabledForEmail'
)

// ─────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────

describe('[sso.ts / imports] rate-limit + IP helpers imported', () => {
  it('imports getClientIp and hashIp from @/lib/auth/get-client-ip', () => {
    expect(SSO_CODE).toMatch(
      /import\s*\{\s*getClientIp\s*,\s*hashIp\s*\}\s*from\s*['"]@\/lib\/auth\/get-client-ip['"]/
    )
  })

  it('imports checkRateLimit from @/lib/rate-limit/upstash', () => {
    expect(SSO_CODE).toMatch(
      /import\s*\{\s*checkRateLimit\s*\}\s*from\s*['"]@\/lib\/rate-limit\/upstash['"]/
    )
  })

  it('imports createHash from crypto (for domain-hashing)', () => {
    expect(SSO_CODE).toMatch(/import\s*\{\s*createHash\s*\}\s*from\s*['"]crypto['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Limiter shape
// ─────────────────────────────────────────────────────────────────────

describe('[checkSSOEnabledForEmail / limiter] kind, limit, window pinned', () => {
  it('uses kind: \'sso-check\' (NOT \'sso-start\' — distinct namespace)', () => {
    expect(CHECK_FN_CODE).toMatch(/kind:\s*['"]sso-check['"]/)
    // Ensure no accidental reuse of the start-route kind.
    expect(CHECK_FN_CODE).not.toMatch(/kind:\s*['"]sso-start['"]/)
  })

  it('uses limit: 10', () => {
    expect(CHECK_FN_CODE).toMatch(/limit:\s*10\b/)
  })

  it('uses window: \'60 s\'', () => {
    expect(CHECK_FN_CODE).toMatch(/window:\s*['"]60 s['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Composite key: ${ip}:${domainHash}
// ─────────────────────────────────────────────────────────────────────

describe('[checkSSOEnabledForEmail / composite key] (ip, domainHash) tuple', () => {
  it('builds bucket key from ip and domainHash (NOT raw email)', () => {
    expect(CHECK_FN_CODE).toMatch(
      /checkRateLimit\(\s*`\$\{ip\}:\$\{domainHash\}`/
    )
  })

  it('hashes the email DOMAIN (not the full email) for the bucket', () => {
    // The split('@')[1] pattern + createHash(...domain) confirms
    // domain-level granularity. Probing kaan@x.com and bob@x.com
    // share a bucket — that's the desired property: same answer for
    // both, attacker shouldn't get two probes for the price of one.
    expect(CHECK_FN_CODE).toMatch(/email\.split\(\s*['"]@['"]\s*\)\[1\]/)
    expect(CHECK_FN_CODE).toMatch(
      /createHash\(\s*['"]sha256['"]\s*\)[\s\S]{0,80}\.update\(\s*domain\s*\)/
    )
  })

  it('domain hash is truncated to 16 hex chars (matches hashEmail/hashIp shape)', () => {
    expect(CHECK_FN_CODE).toMatch(/\.slice\(\s*0\s*,\s*16\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Ordering: rate-limit BEFORE the RPC
// ─────────────────────────────────────────────────────────────────────

describe('[checkSSOEnabledForEmail / ordering] rate-limit guards the RPC', () => {
  it('checkRateLimit is awaited BEFORE the lookup_sso_provider_for_domain RPC', () => {
    const rlIdx = CHECK_FN_CODE.indexOf('checkRateLimit(')
    const rpcIdx = CHECK_FN_CODE.indexOf("'lookup_sso_provider_for_domain'")
    expect(rlIdx).toBeGreaterThan(-1)
    expect(rpcIdx).toBeGreaterThan(-1)
    expect(rlIdx).toBeLessThan(rpcIdx)
  })

  it('null-IP fail-closed branch comes before any RPC or limiter call', () => {
    const ipCheckIdx = CHECK_FN_CODE.indexOf('if (!ip)')
    const rlIdx = CHECK_FN_CODE.indexOf('checkRateLimit(')
    expect(ipCheckIdx).toBeGreaterThan(-1)
    expect(ipCheckIdx).toBeLessThan(rlIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Narrowed return shape
// ─────────────────────────────────────────────────────────────────────

describe('[checkSSOEnabledForEmail / return shape] narrowed (Mini-D3)', () => {
  it('declared return type is { required: boolean; orgSlug?: string }', () => {
    // Pin the function signature's return-type annotation (with
    // optional whitespace tolerance).
    expect(CHECK_FN_CODE).toMatch(
      /Promise<\s*\{\s*required:\s*boolean\s*;?\s*orgSlug\?\s*:\s*string\s*;?\s*\}\s*>/
    )
  })

  it('return type does NOT include orgId, providerId, or enforcementMode', () => {
    // Slice the function signature line + return-type annotation only
    // (stop at the opening `{` of the function body).
    const sigEnd = CHECK_FN_CODE.indexOf('{', CHECK_FN_CODE.indexOf('Promise<'))
    const sig = CHECK_FN_CODE.slice(0, sigEnd)
    expect(sig).not.toMatch(/orgId\?:/)
    expect(sig).not.toMatch(/providerId\?:/)
    expect(sig).not.toMatch(/enforcementMode\?:/)
  })

  it('on the success path returns { required, orgSlug } where orgSlug = row.org_slug', () => {
    // Broadened in B-2-b: `required` is now derived from
    // `enforcement_mode === 'strict'` (not hardcoded `true`).
    // orgSlug is returned for ANY mode that surfaced a row from the
    // RPC — strict, hybrid, AND optional all carry the slug.
    //
    // We assert the shape — `required` must be a computed boolean
    // bound to the enforcement_mode comparison — and that orgSlug
    // pulls from the same `row.org_slug` field.
    expect(CHECK_FN_CODE).toMatch(
      /return\s*\{\s*required\s*,?\s*orgSlug:\s*row\.org_slug\s*,?\s*\}/
    )
  })

  it('success path computes required from enforcement_mode === \'strict\' (NOT a hardcoded true)', () => {
    // Critical: hybrid and optional MUST NOT yield required=true. The
    // login page redirects to /sso/start ONLY for required=true; if
    // hybrid orgs were marked required they would lose the password
    // option entirely.
    expect(CHECK_FN_CODE).toMatch(
      /required\s*=\s*row\.enforcement_mode\s*===\s*['"]strict['"]/
    )
    // And the function must NOT emit a literal `required: true` in
    // the success-path return — that would short-circuit the
    // enforcement_mode check.
    const returnIdx = CHECK_FN_CODE.lastIndexOf('return {')
    expect(returnIdx).toBeGreaterThan(-1)
    const tailReturn = CHECK_FN_CODE.slice(returnIdx)
    expect(tailReturn).not.toMatch(/required:\s*true/)
  })

  it('success path surfaces orgSlug for ALL non-empty rows (broadened in B-2-b)', () => {
    // The defensive null-guard before the broadened return must NOT
    // re-narrow to strict-only. Slice from the rows.length check to
    // the closing brace and assert no enforcement_mode === 'strict'
    // gate gets in the way of returning orgSlug.
    const rowsCheckIdx = CHECK_FN_CODE.indexOf('if (rows.length === 0)')
    expect(rowsCheckIdx).toBeGreaterThan(-1)
    const tail = CHECK_FN_CODE.slice(rowsCheckIdx)
    // Must contain a single `return { required, orgSlug: row.org_slug }`
    // — proving orgSlug is included regardless of `required`'s value.
    expect(tail).toMatch(
      /return\s*\{\s*required\s*,?\s*orgSlug:\s*row\.org_slug\s*,?\s*\}/
    )
  })

  it('rate-limit hit returns { required: false } (indistinguishable from no-SSO)', () => {
    // Slice from the !rlResult.allowed branch to the next return —
    // must be `{ required: false }`, NOT a "rate_limited" sentinel.
    const branchIdx = CHECK_FN_CODE.indexOf('!rlResult.allowed')
    expect(branchIdx).toBeGreaterThan(-1)
    const branchSlice = CHECK_FN_CODE.slice(branchIdx, branchIdx + 1200)
    expect(branchSlice).toMatch(/return\s*\{\s*required:\s*false\s*\}/)
    // And the returned value must NOT carry a discriminator that
    // would let an attacker detect the rate-limit state.
    expect(branchSlice).not.toMatch(/rate_limited:\s*true/)
    expect(branchSlice).not.toMatch(/rateLimited:/)
    expect(branchSlice).not.toMatch(/error:\s*['"]rate/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Audit shape on rate-limit hit
// ─────────────────────────────────────────────────────────────────────

describe('[checkSSOEnabledForEmail / audit] rate-limit hit audit shape', () => {
  it('emits sso.login.failure with reason: \'rate_limited\'', () => {
    expect(CHECK_FN_CODE).toMatch(
      /emitSsoAuditEvent\(\s*['"]sso\.login\.failure['"]/
    )
    expect(CHECK_FN_CODE).toMatch(/reason:\s*['"]rate_limited['"]/)
  })

  it('audit metadata includes key_kind, ip_hash, target_hash, email_hash', () => {
    expect(CHECK_FN_CODE).toMatch(/key_kind:\s*['"]sso-check['"]/)
    expect(CHECK_FN_CODE).toMatch(/ip_hash:\s*hashIp\(\s*ip\s*\)/)
    expect(CHECK_FN_CODE).toMatch(/target_hash:\s*domainHash/)
    expect(CHECK_FN_CODE).toMatch(/email_hash:\s*emailHash/)
  })

  it('audit metadata never carries the raw IP, raw email, or raw domain', () => {
    // Slice the audit emit block and assert no raw-PII field appears.
    const emitIdx = CHECK_FN_CODE.indexOf('emitSsoAuditEvent')
    expect(emitIdx).toBeGreaterThan(-1)
    const emitBlock = CHECK_FN_CODE.slice(emitIdx, emitIdx + 1000)
    expect(emitBlock).not.toMatch(/\bip:\s*ip\b/)
    expect(emitBlock).not.toMatch(/\bemail:\s*email\b/)
    expect(emitBlock).not.toMatch(/\bdomain:\s*domain\b/)
  })
})
