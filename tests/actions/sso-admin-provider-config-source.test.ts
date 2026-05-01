// @vitest-environment node
//
// Source-level invariant tests for `lib/actions/sso-admin-provider-config.ts`
// (B-2-c-iii commit 2). Mirrors the pattern from
// `tests/actions/sso-admin-mutations-source.test.ts` (B-2-c-ii) byte-for-byte
// where the patterns apply.
//
// Why source-level (in addition to runtime tests)
// -----------------------------------------------
// Runtime tests prove the behavior on well-formed inputs. They cannot prove
// the *position* of the auth gate or feature flag check in the source — a
// future refactor could move either past a `.from(...)` call and the
// runtime suite would still pass against successful inputs (the rejection
// still happens before the response is built). Source-level invariants
// catch regressions at the file-shape level: if a future commit silently
// moves the flag check past the auth gate, this test fails BEFORE the
// runtime suite even loads.
//
// What's pinned (per Mini-D session 2026-04-29):
//
//   File-level imports:
//     - requireOrgAdmin from '@/lib/auth/require-org-role'
//     - isMetadataUploadEnabledForOrg from
//       '@/lib/sso/admin-metadata-upload-allowlist'
//     - parseSamlMetadata from '@/lib/sso/parse-saml-metadata'
//     - safeFetchMetadata from '@/lib/security/safe-fetch'
//     - emitSsoAuditEvent from '@/lib/actions/sso-audit'
//     - checkRateLimit from '@/lib/rate-limit/upstash'
//
//   Per public action (configureOrgSsoProviderFromXml,
//   configureOrgSsoProviderFromUrl):
//     1. `isMetadataUploadEnabledForOrg(orgId)` is the FIRST textual
//        statement, BEFORE any `await`. (Mini-D11 + Mini-D14: forged
//        POSTs return NOT_AVAILABLE without any DB roundtrip.)
//     2. Returns `errorCode: 'NOT_AVAILABLE'` on flag-off path.
//     3. `requireOrgAdmin(orgId)` is the FIRST `await` in the body.
//     4. Auth gate runs BEFORE any `.from(...)`, `.rpc(...)`,
//        `gotrueAdminRequest(...)`, `safeFetchMetadata(...)`,
//        `parseSamlMetadata(...)`, or `checkRateLimit(...)` call.
//     5. Early-return shape matches B-2-c-ii's mutations:
//        `if (!auth.ok) return { ok: false, error: auth.error,
//        errorCode: 'NOT_AUTHORIZED' }`.
//     6. Function signature does NOT accept any spoofable identity
//        parameter (`actor_user_id`, `userId`, `actorUserId`,
//        `as_user_id`).
//
//   URL action specifically:
//     7. `checkRateLimit(...)` is invoked with `kind: 'sso-config-fetch'`,
//        `limit: 5`, `window: '60 s'`.
//     8. Rate-limit identifier is `${orgId}:${auth.userId}` — both
//        dimensions present (single-dimension would let one compromised
//        admin exhaust the limit for legitimate admins).
//     9. Rate limit check happens AFTER auth gate but BEFORE
//        `safeFetchMetadata`.
//
//   replaceProvider helper:
//    10. UPDATE includes both `.eq('org_id', orgId)` AND
//        `.eq('supabase_provider_id', existing.supabase_provider_id)` —
//        the second is the CAS guard against TOCTOU races.
//
//   Audit emit shape (Mini-D13):
//    11. Every audit emit's `actorUserId` is sourced from `auth.userId`
//        or the internal `actorUserId` parameter — never a literal,
//        never `null` (audit row supports null for pre-auth events but
//        configure actions always have a verified user).
//    12. `source` discriminator field present on every emit.
//    13. NO bare `metadata_url:` field appears as audit metadata
//        (only `has_metadata_url:` boolean, per Mini-D13's "no URL
//        value persisted" rule).
//
//   Allowlist helper:
//    14. `isMetadataUploadEnabledForOrg` is exported as a SYNCHRONOUS
//        function — async would break the "first await is
//        requireOrgAdmin" invariant.
//    15. References both env var names (NEXT_PUBLIC_*_ENABLED and
//        *_ORGS).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const ACTION_SRC = readFileSync(
  resolve(REPO_ROOT, 'lib/actions/sso-admin-provider-config.ts'),
  'utf8',
)
const ALLOWLIST_SRC = readFileSync(
  resolve(REPO_ROOT, 'lib/sso/admin-metadata-upload-allowlist.ts'),
  'utf8',
)

function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

const ACTION_CODE = stripComments(ACTION_SRC)

// Slice the body of an exported async function by name. We start at
// the function signature, then walk the brace stack from the body's
// opening `{` to its matching closing `}`. Mirrors the helper from
// `sso-admin-mutations-source.test.ts:74-94`.
function sliceFunctionBody(src: string, name: string): string {
  const sigPrefix = `export async function ${name}(`
  const sigStart = src.indexOf(sigPrefix)
  if (sigStart < 0) throw new Error(`signature not found: ${name}`)
  const colonIdx = src.indexOf('): ', sigStart)
  const bodyStart = src.indexOf('{', colonIdx)
  if (bodyStart < 0) throw new Error(`body open not found: ${name}`)
  let depth = 1
  let i = bodyStart + 1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(bodyStart, i + 1)
}

// Slice an internal (non-exported) async function body — same walker
// without the `export` prefix. Used for `replaceProvider` etc.
function sliceInternalFunctionBody(src: string, name: string): string {
  const sigPrefix = `async function ${name}(`
  const sigStart = src.indexOf(sigPrefix)
  if (sigStart < 0) throw new Error(`signature not found: ${name}`)
  const colonIdx = src.indexOf('): ', sigStart)
  const bodyStart = src.indexOf('{', colonIdx)
  if (bodyStart < 0) throw new Error(`body open not found: ${name}`)
  let depth = 1
  let i = bodyStart + 1
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  return src.slice(bodyStart, i + 1)
}

function sliceFunctionSignature(src: string, name: string): string {
  const sigPrefix = `export async function ${name}(`
  const sigStart = src.indexOf(sigPrefix)
  if (sigStart < 0) throw new Error(`signature not found: ${name}`)
  const colonIdx = src.indexOf('): ', sigStart)
  const bodyStart = src.indexOf('{', colonIdx)
  return src.slice(sigStart, bodyStart)
}

const XML_BODY = sliceFunctionBody(ACTION_CODE, 'configureOrgSsoProviderFromXml')
const URL_BODY = sliceFunctionBody(ACTION_CODE, 'configureOrgSsoProviderFromUrl')
const REPLACE_BODY = sliceInternalFunctionBody(ACTION_CODE, 'replaceProvider')

const XML_SIG = sliceFunctionSignature(
  ACTION_CODE,
  'configureOrgSsoProviderFromXml',
)
const URL_SIG = sliceFunctionSignature(
  ACTION_CODE,
  'configureOrgSsoProviderFromUrl',
)

const PUBLIC_ACTIONS: ReadonlyArray<{ name: string; body: string; sig: string }> = [
  { name: 'configureOrgSsoProviderFromXml', body: XML_BODY, sig: XML_SIG },
  { name: 'configureOrgSsoProviderFromUrl', body: URL_BODY, sig: URL_SIG },
]

// ─────────────────────────────────────────────────────────────────────
// 1. File-level imports
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin-provider-config / imports]', () => {
  it('imports requireOrgAdmin from the canonical helper path', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\brequireOrgAdmin\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/require-org-role['"]/,
    )
  })

  it('imports isMetadataUploadEnabledForOrg from the allowlist module', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bisMetadataUploadEnabledForOrg\b[^}]*\}\s+from\s+['"]@\/lib\/sso\/admin-metadata-upload-allowlist['"]/,
    )
  })

  it('imports parseSamlMetadata from the canonical security primitives module', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bparseSamlMetadata\b[^}]*\}\s+from\s+['"]@\/lib\/sso\/parse-saml-metadata['"]/,
    )
  })

  it('imports safeFetchMetadata from the canonical SSRF-defended fetch module', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bsafeFetchMetadata\b[^}]*\}\s+from\s+['"]@\/lib\/security\/safe-fetch['"]/,
    )
  })

  it('imports emitSsoAuditEvent from the canonical audit module', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bemitSsoAuditEvent\b[^}]*\}\s+from\s+['"]@\/lib\/actions\/sso-audit['"]/,
    )
  })

  it('imports checkRateLimit from the canonical rate-limit module', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bcheckRateLimit\b[^}]*\}\s+from\s+['"]@\/lib\/rate-limit\/upstash['"]/,
    )
  })

  it('imports getSPUrls from lib/actions/sso (single source of truth for SP URLs)', () => {
    expect(ACTION_CODE).toMatch(
      /import\s+\{[^}]*\bgetSPUrls\b[^}]*\}\s+from\s+['"]@\/lib\/actions\/sso['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. Per public action — gate ordering, no spoofable identity
// ─────────────────────────────────────────────────────────────────────

describe.each(PUBLIC_ACTIONS)(
  '[$name] feature flag + auth gate placement',
  ({ name, body, sig }) => {
    it(`${name}: feature-flag check (isMetadataUploadEnabledForOrg) appears BEFORE the first await`, () => {
      const flagCheck = body.indexOf('isMetadataUploadEnabledForOrg(orgId)')
      const firstAwait = body.indexOf('await ')
      expect(flagCheck).toBeGreaterThan(-1)
      expect(firstAwait).toBeGreaterThan(-1)
      expect(
        flagCheck,
        `${name}: flag check must run before any await; otherwise flag-off requests still pay the auth roundtrip`,
      ).toBeLessThan(firstAwait)
    })

    it(`${name}: returns errorCode: 'NOT_AVAILABLE' on flag-off path`, () => {
      // Pin the exact early-return shape on the flag-off branch.
      expect(body).toMatch(/errorCode:\s*['"]NOT_AVAILABLE['"]/)
    })

    it(`${name}: requireOrgAdmin(orgId) is the FIRST await`, () => {
      const firstAwaitIdx = body.indexOf('await ')
      const gateIdx = body.indexOf('await requireOrgAdmin(orgId)')
      expect(firstAwaitIdx).toBeGreaterThan(-1)
      expect(gateIdx).toBeGreaterThan(-1)
      expect(
        gateIdx,
        `${name}: requireOrgAdmin must be the first await; found something else first`,
      ).toBe(firstAwaitIdx)
    })

    it(`${name}: gate runs before any DB / GoTrue / fetch / parser / internal-orchestrator call`, () => {
      const gateIdx = body.indexOf('await requireOrgAdmin(orgId)')
      // Find the earliest external-touching or delegating call. The
      // XML action delegates to `configureProviderInternal` immediately
      // after the gate (no direct DB call in its body); the URL action
      // calls `checkRateLimit` first. Either way the gate must precede.
      const externalRegex =
        /\.(from|rpc)\(|\bsupabaseAdmin\.|\bgotrueAdminRequest\(|\bsafeFetchMetadata\(|\bparseSamlMetadata\(|\bcheckRateLimit\(|\bconfigureProviderInternal\(/g
      let earliestExt = -1
      let m: RegExpExecArray | null
      while ((m = externalRegex.exec(body)) !== null) {
        if (earliestExt === -1 || m.index < earliestExt) earliestExt = m.index
      }
      expect(
        earliestExt,
        `${name}: body must invoke at least one external/delegating call past the gate`,
      ).toBeGreaterThan(-1)
      expect(gateIdx).toBeLessThan(earliestExt)
    })

    it(`${name}: early-return shape uses ok:false + error: auth.error + errorCode: 'NOT_AUTHORIZED'`, () => {
      expect(body).toMatch(
        /if\s*\(\s*!auth\.ok\s*\)\s*\{?\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*auth\.error\s*,\s*errorCode:\s*['"]NOT_AUTHORIZED['"]\s*\}/,
      )
    })

    it(`${name}: signature does NOT accept actor_user_id / userId / actorUserId / as_user_id parameters`, () => {
      expect(sig).not.toMatch(/\bactor_user_id\b/)
      expect(sig).not.toMatch(/\bactorUserId\b/)
      expect(sig).not.toMatch(/\bas_user_id\b/)
      expect(sig).not.toMatch(/\basUserId\b/)
      // userId would be a foot-gun parameter name; the action sources
      // it only from auth.userId.
      expect(sig).not.toMatch(/\(\s*orgId:\s*string\s*,\s*[^)]*\buserId\b\s*:/)
    })
  },
)

// ─────────────────────────────────────────────────────────────────────
// 3. URL action specifically — rate limiting
// ─────────────────────────────────────────────────────────────────────

describe('[configureOrgSsoProviderFromUrl] rate limiting', () => {
  it('checkRateLimit is invoked with kind: "sso-config-fetch"', () => {
    expect(URL_BODY).toMatch(/kind:\s*['"]sso-config-fetch['"]/)
  })

  it('checkRateLimit uses limit: 5 and window: "60 s"', () => {
    expect(URL_BODY).toMatch(/limit:\s*5\b/)
    expect(URL_BODY).toMatch(/window:\s*['"]60 s['"]/)
  })

  it('rate-limit identifier is composite (orgId AND auth.userId)', () => {
    // Pin the exact template literal — single-dimension would let
    // one compromised admin exhaust the limit globally.
    expect(URL_BODY).toMatch(
      /checkRateLimit\(\s*`\$\{orgId\}:\$\{auth\.userId\}`/,
    )
  })

  it('rate-limit check happens AFTER requireOrgAdmin but BEFORE safeFetchMetadata', () => {
    const gateIdx = URL_BODY.indexOf('await requireOrgAdmin(orgId)')
    const rateIdx = URL_BODY.indexOf('checkRateLimit(')
    const fetchIdx = URL_BODY.indexOf('safeFetchMetadata(')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(rateIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(gateIdx).toBeLessThan(rateIdx)
    expect(rateIdx).toBeLessThan(fetchIdx)
  })

  it('rate-limit hit returns errorCode: "RATE_LIMITED" with reset_at in details', () => {
    // Slice from the !rateLimit.allowed branch — must carry both the
    // errorCode and the rate_limit_reset_at hint for the UI to show
    // a "try again at <time>" message.
    const branchIdx = URL_BODY.indexOf('!rateLimit.allowed')
    expect(branchIdx).toBeGreaterThan(-1)
    const branch = URL_BODY.slice(branchIdx, branchIdx + 600)
    expect(branch).toMatch(/errorCode:\s*['"]RATE_LIMITED['"]/)
    expect(branch).toMatch(/rate_limit_reset_at:\s*rateLimit\.resetAt/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. replaceProvider — CAS-guarded swap
// ─────────────────────────────────────────────────────────────────────

describe('[replaceProvider] CAS-guarded swap', () => {
  it('UPDATE chain includes BOTH .eq("org_id", orgId) AND .eq("supabase_provider_id", existing.supabase_provider_id)', () => {
    // The CAS clause is the load-bearing race-condition defense. If a
    // future refactor drops the `.eq('supabase_provider_id', ...)`
    // call, two concurrent admin tabs both hitting the replace path
    // would silently overwrite each other.
    const updateIdx = REPLACE_BODY.indexOf('.update(')
    expect(updateIdx).toBeGreaterThan(-1)
    const updateChain = REPLACE_BODY.slice(updateIdx, updateIdx + 2000)
    expect(updateChain).toMatch(/\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
    expect(updateChain).toMatch(
      /\.eq\(\s*['"]supabase_provider_id['"]\s*,\s*existing\.supabase_provider_id\s*\)/,
    )
  })

  it('rollback DELETE is invoked when the CAS swap fails', () => {
    // Ordering: .update(...) → if (swapErr || !swapped) → DELETE.
    const updateIdx = REPLACE_BODY.indexOf('.update(')
    const guardIdx = REPLACE_BODY.indexOf('swapErr || !swapped')
    const rollbackIdx = REPLACE_BODY.indexOf("'DELETE'")
    expect(updateIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(-1)
    expect(rollbackIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeLessThan(guardIdx)
    expect(guardIdx).toBeLessThan(rollbackIdx)
  })

  it('audit emit on replace path includes action: "replaced"', () => {
    expect(REPLACE_BODY).toMatch(/action:\s*['"]replaced['"]/)
  })

  it('audit emit on replace path includes previous_* correlation fields', () => {
    expect(REPLACE_BODY).toMatch(/previous_idp_type:\s*existing\.idp_type/)
    expect(REPLACE_BODY).toMatch(/previous_entity_id:\s*existing\.entity_id/)
    expect(REPLACE_BODY).toMatch(
      /previous_cert_fingerprint_sha256:\s*existing\.cert_fingerprint_sha256/,
    )
    expect(REPLACE_BODY).toMatch(
      /previous_supabase_provider_id:\s*existing\.supabase_provider_id/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. Audit emit shape — Mini-D13 (no raw URL, source discriminator)
// ─────────────────────────────────────────────────────────────────────

describe('[audit emit / Mini-D13] no raw URL, source discriminator', () => {
  it('every emitSsoAuditEvent call has a source: field nearby (within 800 chars)', () => {
    // Find every emit call. Each must be paired with a source: field
    // in its metadata block. We allow 800 chars of slack for nested
    // metadata literals.
    const emitRegex = /emitSsoAuditEvent\(/g
    let m: RegExpExecArray | null
    let emitCount = 0
    while ((m = emitRegex.exec(ACTION_CODE)) !== null) {
      const slice = ACTION_CODE.slice(m.index, m.index + 800)
      expect(
        slice,
        `audit emit at offset ${m.index} must include source: discriminator`,
      ).toMatch(/source\s*[:,]/)
      emitCount++
    }
    // Sanity: we should have at least 4 emit calls (created, updated_in_place,
    // replaced, plus partial_failure variants).
    expect(emitCount).toBeGreaterThanOrEqual(4)
  })

  it('every emit metadata block includes has_metadata_url boolean', () => {
    const emitRegex = /emitSsoAuditEvent\(/g
    let m: RegExpExecArray | null
    while ((m = emitRegex.exec(ACTION_CODE)) !== null) {
      const slice = ACTION_CODE.slice(m.index, m.index + 800)
      expect(
        slice,
        `audit emit at offset ${m.index} must include has_metadata_url`,
      ).toMatch(/has_metadata_url:/)
    }
  })

  it('NO audit metadata block emits a bare metadata_url: <variable> (only has_metadata_url)', () => {
    // Mini-D13: URLs may carry tenant tokens or pre-signed query
    // params. Only `has_metadata_url:` boolean is permitted in the
    // audit row. We scan for any `metadata_url: <expr>` occurrence
    // INSIDE an emitSsoAuditEvent call's metadata block.
    const emitRegex = /emitSsoAuditEvent\(/g
    let m: RegExpExecArray | null
    while ((m = emitRegex.exec(ACTION_CODE)) !== null) {
      const slice = ACTION_CODE.slice(m.index, m.index + 1200)
      expect(
        slice,
        `audit emit at offset ${m.index} must NOT include bare metadata_url field`,
      ).not.toMatch(/[^_]metadata_url:/)
    }
  })

  it('every emit sources actorUserId from auth.userId or actorUserId param (never null/literal)', () => {
    const emitRegex = /emitSsoAuditEvent\(/g
    let m: RegExpExecArray | null
    while ((m = emitRegex.exec(ACTION_CODE)) !== null) {
      const slice = ACTION_CODE.slice(m.index, m.index + 600)
      // Accept both `actorUserId: <expr>` and the object-property
      // shorthand `actorUserId,` (which is equivalent to
      // `actorUserId: actorUserId`). The shorthand is used inside the
      // internal helpers where the local variable is already named
      // `actorUserId` and matches the field name.
      expect(
        slice,
        `audit emit at offset ${m.index} must source actorUserId from auth.userId or the actorUserId param (or shorthand)`,
      ).toMatch(/actorUserId\s*[,:]\s*(auth\.userId|actorUserId|\n|\r)/)
      // Defense: never null, never a string literal in the explicit
      // `actorUserId: <value>` form.
      expect(slice).not.toMatch(/actorUserId:\s*null\b/)
      expect(slice).not.toMatch(/actorUserId:\s*['"][^'"]*['"]/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. Allowlist helper — synchronous + env var presence
// ─────────────────────────────────────────────────────────────────────

describe('[admin-metadata-upload-allowlist / synchronous helper]', () => {
  it('isMetadataUploadEnabledForOrg is exported as SYNCHRONOUS (not async)', () => {
    // Async would break the "first await is requireOrgAdmin" invariant
    // on the consuming server actions.
    expect(ALLOWLIST_SRC).not.toMatch(
      /export\s+async\s+function\s+isMetadataUploadEnabledForOrg/,
    )
    expect(ALLOWLIST_SRC).toMatch(
      /export\s+function\s+isMetadataUploadEnabledForOrg\(/,
    )
  })

  it('reads NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED master flag', () => {
    expect(ALLOWLIST_SRC).toMatch(
      /process\.env\.NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED/,
    )
  })

  it('reads SSO_ADMIN_METADATA_UPLOAD_ORGS allowlist', () => {
    expect(ALLOWLIST_SRC).toMatch(/process\.env\.SSO_ADMIN_METADATA_UPLOAD_ORGS/)
  })

  it('uses strict equality with "true" (defense against truthy regression)', () => {
    expect(ALLOWLIST_SRC).toMatch(
      /NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED\s*!==\s*['"]true['"]/,
    )
  })
})
