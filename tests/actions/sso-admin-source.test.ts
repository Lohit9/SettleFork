// @vitest-environment node
//
// Source-level invariant tests for `lib/actions/sso-admin.ts`.
//
// `sso-admin.ts` is the data plane for the org-admin SSO settings
// page (B-2-c-i). Two of its four actions use `supabaseAdmin`
// (service role) to bypass RLS on `sso_identity_links` and
// `sso_audit_events`, with `requireOrgAdmin(orgId)` as the ONLY
// boundary preventing cross-tenant leakage. That makes the auth-
// gate placement load-bearing: a single bug — the gate AFTER the
// query, the gate calling the wrong helper, an action accepting
// `actor_user_id` from the caller — leaks any org's data.
//
// Source-level invariants (read the file as text and assert via
// regex) catch this class of bug at refactor time, complementing the
// behavior tests on the helper itself
// (`tests/lib/auth/require-org-role.test.ts`).
//
// Pattern mirrors `tests/actions/sso-source.test.ts` and
// `tests/lib/auth/login-reason-codes-source.test.ts` — read the
// file once, run regexes per action, fail with a focused message.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const SRC = readFileSync(
  resolve(REPO_ROOT, 'lib/actions/sso-admin.ts'),
  'utf8',
)

const ACTIONS = [
  'getOrgSsoOverview',
  'listOrgSsoDomains',
  'listOrgSsoLinkedUsers',
  'listOrgSsoAuditEvents',
] as const

type ActionName = (typeof ACTIONS)[number]

/**
 * Extract the body of a single exported `async function <name>(...)`
 * declaration up to its matching closing brace at column 0. Naïve
 * but sufficient given the file's flat shape — every top-level
 * `async function` here ends at a column-0 `}`.
 *
 * Returns the raw body text (with comments stripped) so regex
 * checks aren't fooled by example code in JSDoc.
 */
function extractFunctionBody(name: ActionName): string {
  const start = SRC.indexOf(`export async function ${name}(`)
  if (start === -1) {
    throw new Error(`Could not find export of ${name}`)
  }
  // Walk forward to the first `{` then balance braces.
  let i = SRC.indexOf('{', start)
  if (i === -1) throw new Error(`No opening brace for ${name}`)
  let depth = 0
  const bodyStart = i
  for (; i < SRC.length; i++) {
    const ch = SRC[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const body = SRC.slice(bodyStart, i + 1)
        return stripComments(body)
      }
    }
  }
  throw new Error(`Unterminated function ${name}`)
}

function stripComments(s: string): string {
  // Remove block /* ... */ and line // ... comments. Good enough for
  // a hand-written .ts file (no string literals containing `//`
  // followed by code we'd want to match).
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

// ─────────────────────────────────────────────────────────────────────
// File-level invariants
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin / file]', () => {
  it("declares 'use server' as the first non-empty line", () => {
    const firstLine = SRC.split('\n').find((l) => l.trim().length > 0)
    expect(firstLine).toBe("'use server'")
  })

  it('imports requireOrgAdmin from the canonical path', () => {
    expect(SRC).toMatch(
      /import\s+\{[^}]*\brequireOrgAdmin\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/require-org-role['"]/,
    )
  })

  it('imports getAuthEmailsByIds from the canonical path', () => {
    expect(SRC).toMatch(
      /import\s+\{[^}]*\bgetAuthEmailsByIds\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/users['"]/,
    )
  })

  it('imports both supabaseAdmin AND createClient (uses each for the appropriate tables)', () => {
    expect(SRC).toMatch(
      /import\s+\{\s*supabaseAdmin\s*\}\s+from\s+['"]@\/lib\/supabase\/admin['"]/,
    )
    expect(SRC).toMatch(
      /import\s+\{\s*createClient\s*\}\s+from\s+['"]@\/lib\/supabase\/server['"]/,
    )
  })

  it('exports exactly the four expected action functions', () => {
    for (const name of ACTIONS) {
      expect(SRC).toMatch(new RegExp(`export async function ${name}\\(`))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Per-action invariants (auth gate before any DB access)
// ─────────────────────────────────────────────────────────────────────

describe.each(ACTIONS)('[sso-admin / %s] auth gate placement', (name) => {
  const body = extractFunctionBody(name)

  it('calls requireOrgAdmin(orgId) before any supabase.from(...) or supabaseAdmin.from(...) or .rpc(...)', () => {
    const authMatch = body.match(/await\s+requireOrgAdmin\(\s*orgId\s*\)/)
    expect(
      authMatch,
      `${name} must call requireOrgAdmin(orgId) — found no match`,
    ).not.toBeNull()
    const authIdx = body.indexOf(authMatch![0])

    // First DB access — any of `.from(`, `.rpc(` on either client.
    // Tolerate prettier-style line breaks before `.from(`.
    const dbAccessIdx = (() => {
      let earliest = Infinity
      for (const re of [
        /\bsupabase\s*\.from\(/,
        /\bsupabaseAdmin\s*\.from\(/,
        /\.rpc\(/,
      ]) {
        const m = body.match(re)
        if (m) earliest = Math.min(earliest, body.indexOf(m[0]))
      }
      return earliest
    })()

    if (dbAccessIdx !== Infinity) {
      expect(
        authIdx,
        `${name}: requireOrgAdmin must run BEFORE the first DB access. ` +
          `auth at index ${authIdx}, first DB access at index ${dbAccessIdx}.`,
      ).toBeLessThan(dbAccessIdx)
    }
  })

  it('returns { ok: false, error: auth.error } when the auth gate rejects (no detail leak from gate)', () => {
    // Pin the exact early-return shape. Any deviation (e.g. spreading
    // `auth` into the response, or echoing `auth.code` to the client)
    // could leak the discriminator that distinguishes
    // unauthenticated / not_member / insufficient_role — useful for
    // ops, harmful for cross-tenant probing.
    expect(body).toMatch(
      /if\s*\(\s*!\s*auth\.ok\s*\)\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*auth\.error\s*\}/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Action signature invariants — no spoofable identity parameters
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin / signatures] no spoofable identity parameters', () => {
  it.each(ACTIONS)('%s does not accept an actor_user_id-style override', (name) => {
    const sigStart = SRC.indexOf(`export async function ${name}(`)
    const sigEnd = SRC.indexOf(')', sigStart)
    const sig = SRC.slice(sigStart, sigEnd + 1)
    // Common foot-gun names: `actor_user_id`, `actorUserId`,
    // `as_user_id`, `asUserId`, `user_id`, `userId`. None of these
    // are valid inputs — identity comes from `auth.getUser()` inside
    // `requireOrgAdmin`.
    for (const banned of [
      /\bactor_user_id\b/,
      /\bactorUserId\b/,
      /\bas_user_id\b/,
      /\basUserId\b/,
      /\buser_id\s*:/,
      /\buserId\s*:/,
    ]) {
      expect(sig, `${name} signature must not accept ${banned}`).not.toMatch(
        banned,
      )
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Client-selection invariants
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin / clients] correct client per RLS posture', () => {
  it('getOrgSsoOverview reads via the SSR client (RLS-bound, org admin allowed)', () => {
    const body = extractFunctionBody('getOrgSsoOverview')
    expect(body).toMatch(/createClient\(\)/)
    // Must NOT use service role for these tables.
    expect(body).not.toMatch(/supabaseAdmin\s*\.from\(\s*['"]organizations['"]/)
    expect(body).not.toMatch(/supabaseAdmin\s*\.from\(\s*['"]sso_providers['"]/)
  })

  it('listOrgSsoDomains reads via the SSR client (RLS-bound, org admin allowed)', () => {
    const body = extractFunctionBody('listOrgSsoDomains')
    expect(body).toMatch(/createClient\(\)/)
    expect(body).not.toMatch(/supabaseAdmin\s*\.from\(\s*['"]sso_domains['"]/)
  })

  it('listOrgSsoLinkedUsers uses supabaseAdmin (RLS denies org admin on sso_identity_links)', () => {
    const body = extractFunctionBody('listOrgSsoLinkedUsers')
    // Tolerate prettier's break before `.from(` — the source uses
    // multi-line method chains on the admin client.
    expect(body).toMatch(/supabaseAdmin\s*\.from\(\s*['"]sso_identity_links['"]/)
  })

  it('listOrgSsoAuditEvents uses supabaseAdmin (RLS denies org admin on sso_audit_events)', () => {
    const body = extractFunctionBody('listOrgSsoAuditEvents')
    expect(body).toMatch(/supabaseAdmin\s*\.from\(\s*['"]sso_audit_events['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Filter-by-org invariants — every query MUST scope to the supplied orgId
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin / filters] every DB query scopes to orgId', () => {
  it('getOrgSsoOverview filters organizations by id and sso_providers by org_id', () => {
    const body = extractFunctionBody('getOrgSsoOverview')
    // `organizations` has primary key `id`; the other tables use
    // `org_id`. Both must filter to the supplied orgId.
    expect(body).toMatch(/\.from\(\s*['"]organizations['"]\s*\)[\s\S]*?\.eq\(\s*['"]id['"]\s*,\s*orgId\s*\)/)
    expect(body).toMatch(/\.from\(\s*['"]sso_providers['"]\s*\)[\s\S]*?\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
  })

  it('listOrgSsoDomains filters by org_id', () => {
    const body = extractFunctionBody('listOrgSsoDomains')
    expect(body).toMatch(/\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
  })

  it('listOrgSsoLinkedUsers filters by org_id (via supabaseAdmin)', () => {
    const body = extractFunctionBody('listOrgSsoLinkedUsers')
    expect(body).toMatch(/\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
  })

  it('listOrgSsoAuditEvents filters by org_id (excludes null-org rate-limit rows by design)', () => {
    const body = extractFunctionBody('listOrgSsoAuditEvents')
    expect(body).toMatch(/\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Audit events: limit ceiling
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin / listOrgSsoAuditEvents] limit handling', () => {
  it('caps the caller-supplied limit (not blindly trusted)', () => {
    const body = extractFunctionBody('listOrgSsoAuditEvents')
    // We expect Math.min/Math.max around the passed `limit`, not a
    // bare `.limit(limit)` that lets a caller request 100k rows and
    // exhaust memory.
    expect(body).toMatch(/Math\.min\(\s*limit/)
  })
})
