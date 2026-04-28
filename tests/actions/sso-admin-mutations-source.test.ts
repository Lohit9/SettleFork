// @vitest-environment node
//
// Source-level invariant tests for `lib/actions/sso-admin-mutations.ts`
// (B-2-c-ii commit 2). These pin the structural properties of the
// four write actions that runtime tests CANNOT see — most importantly,
// that the `requireOrgAdmin` gate runs BEFORE any database access in
// every action, and that the audit emit runs AFTER the DB write
// succeeds.
//
// Why source-level (in addition to runtime tests)
// -----------------------------------------------
// Runtime tests (in `tests/integration/sso-admin-isolation.test.ts`)
// prove the gate REJECTS cross-tenant calls. They cannot prove the
// gate is actually positioned before the DB read in the source —
// a future refactor could move it after a `.from(...)` call and the
// runtime tests would still pass against well-formed inputs (the
// rejection still happens before the response is built).
//
// Source-level invariants catch regressions at the file-shape level:
// if a future commit silently moves the gate after a DB call, this
// test fails BEFORE the runtime suite even loads.
//
// What's pinned (per Mini-D session 2026-04-28, Step 2.4):
//
// Per action (4 actions):
//   1. `requireOrgAdmin(orgId)` is the FIRST `await` in the function
//   2. `requireOrgAdmin(orgId)` runs BEFORE any `.from(/.rpc(/.insert(
//      /.update(/.delete(/supabaseAdmin.` reference inside the body
//   3. Early-return shape: `if (!auth.ok) return { ok: false, error:
//      auth.error ... }` — exactly
//   4. No `actor_user_id`, `userId`, `actorUserId`, or `as_user_id`
//      parameter in the function signature
//
// For writes (add, remove, setMode):
//   5. `emitSsoAuditEvent` is called AFTER the DB write succeeds
//      (textual ordering inside the body)
//   6. `actorUserId: auth.userId` (no null, no string literal)
//
// For setMode:
//   7. `if (previousMode !== mode)` (or equivalent) gates the audit
//   8. Both branches return ok:true with was_no_op set appropriately
//
// For add:
//   9. `validateDomain(...)` is called before any DB read/write
//  10. Cross-org hijack error does NOT include `conflictingOrgId`,
//      `conflicting_org_id`, or any spelling variant
//  11. Server-side log of the hijack via `console.warn` IS present
//
// For remove:
//  12. The `was_last_domain` count query happens BEFORE the delete
//  13. The delete uses both `.eq('org_id', orgId)` AND
//      `.eq('domain', normalized)` — never delete by domain alone

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../..')
const MUTATIONS_SRC = readFileSync(
  resolve(REPO_ROOT, 'lib/actions/sso-admin-mutations.ts'),
  'utf8',
)

function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}
const MUTATIONS_CODE = stripComments(MUTATIONS_SRC)

// Slice the body of an exported async function by name. We start at
// the function signature, then walk the brace stack from the body's
// opening `{` to its matching closing `}`.
function sliceFunctionBody(src: string, name: string): string {
  const sigPrefix = `export async function ${name}(`
  const sigStart = src.indexOf(sigPrefix)
  if (sigStart < 0) throw new Error(`signature not found: ${name}`)
  // Skip past the signature's `): ReturnType {` to the body's opening brace.
  // The first `{` after `): ` (return-type colon) is the body opener.
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

// Slice just the function signature (header + return type annotation,
// stopping at the body's opening brace). Used for parameter checks.
function sliceFunctionSignature(src: string, name: string): string {
  const sigPrefix = `export async function ${name}(`
  const sigStart = src.indexOf(sigPrefix)
  if (sigStart < 0) throw new Error(`signature not found: ${name}`)
  const colonIdx = src.indexOf('): ', sigStart)
  const bodyStart = src.indexOf('{', colonIdx)
  return src.slice(sigStart, bodyStart)
}

const ADD_BODY = sliceFunctionBody(MUTATIONS_CODE, 'addOrgSsoDomain')
const REMOVE_BODY = sliceFunctionBody(MUTATIONS_CODE, 'removeOrgSsoDomain')
const SET_MODE_BODY = sliceFunctionBody(MUTATIONS_CODE, 'setOrgEnforcementMode')
const PREVIEW_BODY = sliceFunctionBody(MUTATIONS_CODE, 'previewEnforcementChange')

const ADD_SIG = sliceFunctionSignature(MUTATIONS_CODE, 'addOrgSsoDomain')
const REMOVE_SIG = sliceFunctionSignature(MUTATIONS_CODE, 'removeOrgSsoDomain')
const SET_MODE_SIG = sliceFunctionSignature(MUTATIONS_CODE, 'setOrgEnforcementMode')
const PREVIEW_SIG = sliceFunctionSignature(MUTATIONS_CODE, 'previewEnforcementChange')

const ALL_BODIES: ReadonlyArray<{ name: string; body: string; sig: string }> = [
  { name: 'addOrgSsoDomain', body: ADD_BODY, sig: ADD_SIG },
  { name: 'removeOrgSsoDomain', body: REMOVE_BODY, sig: REMOVE_SIG },
  { name: 'setOrgEnforcementMode', body: SET_MODE_BODY, sig: SET_MODE_SIG },
  { name: 'previewEnforcementChange', body: PREVIEW_BODY, sig: PREVIEW_SIG },
]

const WRITE_BODIES: ReadonlyArray<{ name: string; body: string }> = [
  { name: 'addOrgSsoDomain', body: ADD_BODY },
  { name: 'removeOrgSsoDomain', body: REMOVE_BODY },
  { name: 'setOrgEnforcementMode', body: SET_MODE_BODY },
]

// ─────────────────────────────────────────────────────────────────────
// 1. Imports — required helpers present
// ─────────────────────────────────────────────────────────────────────

describe('[sso-admin-mutations / imports]', () => {
  it('imports requireOrgAdmin from the canonical helper path', () => {
    expect(MUTATIONS_CODE).toMatch(
      /import\s+\{[^}]*\brequireOrgAdmin\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/require-org-role['"]/,
    )
  })

  it('imports validateDomain + VALID_ENFORCEMENT_MODES from the shared module', () => {
    expect(MUTATIONS_CODE).toMatch(
      /from\s+['"]@\/lib\/sso\/domain-validation['"]/,
    )
    expect(MUTATIONS_CODE).toMatch(/\bvalidateDomain\b/)
    expect(MUTATIONS_CODE).toMatch(/\bVALID_ENFORCEMENT_MODES\b/)
  })

  it('imports emitSsoAuditEvent from the canonical audit module', () => {
    expect(MUTATIONS_CODE).toMatch(
      /import\s+\{[^}]*\bemitSsoAuditEvent\b[^}]*\}\s+from\s+['"]\.\/sso-audit['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. Per-action: gate is the first await; runs before any DB call;
//    early-return shape; no spoofable identity parameters
// ─────────────────────────────────────────────────────────────────────

describe.each(ALL_BODIES)(
  '[$name] requireOrgAdmin gate placement',
  ({ name, body, sig }) => {
    it(`${name}: requireOrgAdmin(orgId) is the first await`, () => {
      const firstAwaitIdx = body.indexOf('await ')
      const gateIdx = body.indexOf('await requireOrgAdmin(orgId)')
      expect(firstAwaitIdx).toBeGreaterThan(-1)
      expect(gateIdx).toBeGreaterThan(-1)
      expect(
        gateIdx,
        `${name}: requireOrgAdmin must be the first await; found something else first`,
      ).toBe(firstAwaitIdx)
    })

    it(`${name}: gate runs before any DB-touching call`, () => {
      const gateIdx = body.indexOf('await requireOrgAdmin(orgId)')
      // Find the earliest DB-touching reference. We exclude the
      // type-only `import` lines from the body slice (the body
      // starts at `{`, so the imports aren't here anyway).
      const dbProbeRegex =
        /\.(from|rpc|insert|update|delete)\(|\bsupabaseAdmin\./g
      let earliestDbIdx = -1
      let m: RegExpExecArray | null
      while ((m = dbProbeRegex.exec(body)) !== null) {
        if (earliestDbIdx === -1 || m.index < earliestDbIdx) earliestDbIdx = m.index
      }
      // Some actions (preview) reference supabaseAdmin only; that's
      // still a DB-touching reference, must come after the gate.
      if (earliestDbIdx >= 0) {
        expect(gateIdx).toBeLessThan(earliestDbIdx)
      } else {
        // If the body has no DB reference at all, that's a
        // surprising shape — flag it.
        throw new Error(
          `${name}: body has no DB reference; gate ordering not verifiable`,
        )
      }
    })

    it(`${name}: early-return shape uses ok:false + error: auth.error`, () => {
      // The three write actions add `errorCode: 'NOT_AUTHORIZED'`;
      // `previewEnforcementChange` deliberately omits errorCode (its
      // return type is the simpler `{ ok: false; error: string }` —
      // see the file-level exports). Both shapes start with the
      // same `ok: false, error: auth.error` prefix, which is the
      // load-bearing invariant: no spoof-ability via auth.error
      // substitution.
      expect(body).toMatch(
        /if\s*\(\s*!auth\.ok\s*\)\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*auth\.error\b/,
      )
    })

    if (name !== 'previewEnforcementChange') {
      it(`${name}: write actions also stamp errorCode: 'NOT_AUTHORIZED'`, () => {
        // Preview omits errorCode by design; the three writes must
        // include it so the client can differentiate authorization
        // failures from validation/DB errors.
        expect(body).toMatch(
          /if\s*\(\s*!auth\.ok\s*\)\s*return\s*\{\s*ok:\s*false\s*,\s*error:\s*auth\.error\s*,\s*errorCode:\s*['"]NOT_AUTHORIZED['"]\s*\}/,
        )
      })
    }

    it(`${name}: signature does NOT accept actor_user_id / userId / actorUserId / as_user_id parameters`, () => {
      // The signature slice is `export async function NAME(...)`
      // through the body's opening `{`. Any of these names appearing
      // as a param would be a security regression — the actor user
      // must come from the gate, not the caller.
      expect(sig).not.toMatch(/\bactor_user_id\b/)
      expect(sig).not.toMatch(/\buserId\b/)
      expect(sig).not.toMatch(/\bactorUserId\b/)
      expect(sig).not.toMatch(/\bas_user_id\b/)
    })
  },
)

// ─────────────────────────────────────────────────────────────────────
// 3. Writes only: emitSsoAuditEvent runs AFTER the DB write,
//    actorUserId is sourced from auth.userId
// ─────────────────────────────────────────────────────────────────────

describe.each(WRITE_BODIES)(
  '[$name] audit emit ordering',
  ({ name, body }) => {
    it(`${name}: emitSsoAuditEvent appears AFTER the first DB-write call`, () => {
      const writeIdx = (() => {
        // The mutations use insert/update/delete — find the earliest.
        const writeRegex = /\.(insert|update|delete)\(/g
        let earliest = -1
        let m: RegExpExecArray | null
        while ((m = writeRegex.exec(body)) !== null) {
          if (earliest === -1 || m.index < earliest) earliest = m.index
        }
        return earliest
      })()
      const auditIdx = body.indexOf('emitSsoAuditEvent(')
      expect(writeIdx, `${name}: must perform a DB write`).toBeGreaterThan(-1)
      expect(auditIdx, `${name}: must call emitSsoAuditEvent`).toBeGreaterThan(
        -1,
      )
      expect(
        auditIdx,
        `${name}: audit emit must run AFTER the DB write so failed writes do NOT log success`,
      ).toBeGreaterThan(writeIdx)
    })

    it(`${name}: emitSsoAuditEvent uses actorUserId: auth.userId (no null, no literal)`, () => {
      // Slice the audit-emit block and assert the specific shape.
      const emitIdx = body.indexOf('emitSsoAuditEvent(')
      const emitBlock = body.slice(emitIdx, emitIdx + 600)
      expect(emitBlock).toMatch(/actorUserId:\s*auth\.userId\b/)
      // Defense: catch the obvious wrong shapes that have leaked
      // into similar code in the past.
      expect(emitBlock).not.toMatch(/actorUserId:\s*null\b/)
      expect(emitBlock).not.toMatch(/actorUserId:\s*['"][^'"]*['"]/)
    })
  },
)

// ─────────────────────────────────────────────────────────────────────
// 4. setOrgEnforcementMode: no-op gate around the audit emit
// ─────────────────────────────────────────────────────────────────────

describe('[setOrgEnforcementMode / no-op semantics]', () => {
  it('audit emit is gated by previousMode !== mode (or wasNoOp negation)', () => {
    // Match either spelling: `if (previousMode !== mode)` or `if
    // (!wasNoOp)` (the current implementation uses the latter).
    const auditIdx = SET_MODE_BODY.indexOf('emitSsoAuditEvent(')
    expect(auditIdx).toBeGreaterThan(-1)
    const before = SET_MODE_BODY.slice(0, auditIdx)
    expect(before).toMatch(
      /if\s*\(\s*(!wasNoOp|previousMode\s*!==\s*mode)\s*\)/,
    )
  })

  it('the success return shape carries was_no_op (both branches reachable)', () => {
    expect(SET_MODE_BODY).toMatch(/was_no_op:\s*wasNoOp\b/)
    // Sanity: wasNoOp is computed from the prev/new comparison.
    expect(SET_MODE_BODY).toMatch(/wasNoOp\s*=\s*previousMode\s*===\s*mode/)
  })

  it('returns ok:true on success regardless of no-op (no early-return on no-op)', () => {
    // Walk the function body for the success-path return; ensure it
    // is reached by both wasNoOp=true and wasNoOp=false. Easiest
    // pin: the success return must carry `ok: true` and is not
    // wrapped in an `if (wasNoOp)` block.
    expect(SET_MODE_BODY).toMatch(
      /return\s*\{\s*ok:\s*true\s*,\s*previous_mode:\s*previousMode/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. addOrgSsoDomain: validation-before-DB; no conflictingOrgId leak;
//    server-side hijack log present
// ─────────────────────────────────────────────────────────────────────

describe('[addOrgSsoDomain / domain validation + hijack defense]', () => {
  it('validateDomain(...) is called before any DB read/write', () => {
    const validateIdx = ADD_BODY.indexOf('validateDomain(')
    expect(validateIdx).toBeGreaterThan(-1)
    // First DB-touching reference inside the body.
    const dbProbe = /\.(from|rpc|insert|update|delete)\(|\bsupabaseAdmin\./
    const dbMatch = dbProbe.exec(ADD_BODY)
    expect(dbMatch, 'addOrgSsoDomain must touch the DB').not.toBeNull()
    expect(validateIdx).toBeLessThan((dbMatch as RegExpExecArray).index)
  })

  it('does NOT leak conflictingOrgId / conflicting_org_id in any return', () => {
    // The platform-admin path does leak this; the org-admin path
    // must not. Pin every spelling variant we can think of.
    expect(ADD_BODY).not.toMatch(/conflictingOrgId\s*:/)
    expect(ADD_BODY).not.toMatch(/conflicting_org_id\s*:/)
    expect(ADD_BODY).not.toMatch(/conflictingOrg\s*:/)
    expect(ADD_BODY).not.toMatch(/conflict_org_id\s*:/)
    // And the literal that the platform-admin path returns —
    // never include the message that mentions another org's id.
    expect(ADD_BODY).not.toMatch(
      /['"]This domain is already mapped to another organization\./,
    )
  })

  it('logs the hijack attempt server-side via console.warn (so ops can triage)', () => {
    // The action must NOT silently drop the conflicting_org info —
    // the server log retains it for ops debugging even though the
    // client gets a generic message.
    expect(ADD_BODY).toMatch(
      /console\.warn\(\s*['"]\[sso-admin-mutations\] domain hijack[^'"]*['"]/,
    )
    // The log payload must include the conflicting_org for triage.
    expect(ADD_BODY).toMatch(/conflicting_org\s*:/)
  })

  it('uses errorCode DOMAIN_ALREADY_MAPPED for cross-org rejection', () => {
    expect(ADD_BODY).toMatch(/errorCode:\s*['"]DOMAIN_ALREADY_MAPPED['"]/)
  })

  it('uses errorCode ALREADY_ADDED for in-org duplicate', () => {
    expect(ADD_BODY).toMatch(/errorCode:\s*['"]ALREADY_ADDED['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. removeOrgSsoDomain: count-before-delete; defensive .eq composite
// ─────────────────────────────────────────────────────────────────────

describe('[removeOrgSsoDomain / count-before-delete + defensive eq]', () => {
  it('the was_last_domain count query happens BEFORE the delete', () => {
    const countIdx = REMOVE_BODY.indexOf("count: 'exact', head: true")
    const deleteIdx = REMOVE_BODY.indexOf('.delete()')
    expect(countIdx, 'remove must pre-count domains').toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(countIdx).toBeLessThan(deleteIdx)
  })

  it('the delete uses both .eq(\'org_id\', orgId) AND .eq(\'domain\', normalized)', () => {
    // Defensive: never delete by domain alone. A bug here would let
    // an admin in org A delete a domain row owned by org B if the
    // unique-domain row crossed orgs (it can't currently, but
    // belt-and-suspenders given the security blast radius).
    const deleteIdx = REMOVE_BODY.indexOf('.delete()')
    const deleteSlice = REMOVE_BODY.slice(deleteIdx, deleteIdx + 400)
    expect(deleteSlice).toMatch(/\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/)
    expect(deleteSlice).toMatch(
      /\.eq\(\s*['"]domain['"]\s*,\s*normalized\s*\)/,
    )
  })

  it('the audit metadata stamps was_last_domain', () => {
    const auditIdx = REMOVE_BODY.indexOf('emitSsoAuditEvent(')
    const emitBlock = REMOVE_BODY.slice(auditIdx, auditIdx + 400)
    expect(emitBlock).toMatch(/was_last_domain:\s*wasLastDomain\b/)
  })
})
