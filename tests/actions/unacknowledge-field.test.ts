// @vitest-environment node
//
// Phase 4b-2 — source-level invariant tests for the `unacknowledgeField`
// server action (W4 surface).
//
// Same source-level testing strategy as `edit-mapping-sources.test.ts`
// and `update-mapping-combination.test.ts`: read the action source as
// a string and pin the contract via regex. These tests catch
// architectural drift (missing auth gate, wrong error code, missing
// activity log) without requiring a Supabase fixture, while the
// integration test in `tests/integration/edit-mapping-heritage.test.ts`
// pins the end-to-end behavior against real Heritage data.
//
// Seven invariants per the Phase 4b-2 task list (U1-U7):
//
//   U1.  Auth: `supabase.auth.getUser()` is called BEFORE any DB
//        write; missing user → PERMISSION_DENIED.
//   U2.  Permission: `requireProjectPermission(projectId, 'editor')`
//        gate; not editor → PERMISSION_DENIED.
//   U3.  Maintenance gate via `assertMappingWritesEnabled(projectId)`
//        translates "scheduled maintenance" message → MAINTENANCE_MODE.
//   U4.  Identity read on `(project_id, target_field_id)` returns
//        NOT_FOUND when no TFM is present.
//   U5.  State guard: TFM exists but `is_acknowledged=false` →
//        VALIDATION (the user should reach `editMappingSources` for
//        non-acknowledged TFMs).
//   U6.  Delegation: invokes `removeAcknowledgment(projectId,
//        targetFieldId)` to actually delete the row.
//   U7.  Emits an `acknowledgment_removed` activity-log entry with
//        metadata { tfm_id, target_field_id, ... } and revalidates
//        /mapping.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

function sliceFromTo(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// `unacknowledgeField` is the LAST exported function in the module
// (4b-2 ships at the bottom of the file). Slice to end of file via
// a sentinel marker that's stable for any future appended exports.
const UNACK_START = 'export async function unacknowledgeField('
const UNACK_END_GUESS = '\n// ─── Write path — Phase 4b-' // any future block
const HAS_FUTURE_BLOCK = SRC.indexOf(UNACK_END_GUESS, SRC.indexOf(UNACK_START)) > 0

const BODY = HAS_FUTURE_BLOCK
  ? sliceFromTo(SRC, UNACK_START, UNACK_END_GUESS)
  : SRC.slice(SRC.indexOf(UNACK_START))

// ─────────────────────────────────────────────────────────────────────
// U0 — Wrapper exports + types
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] wrapper shape', () => {
  it('U0a: exports unacknowledgeField as an async function with documented signature', () => {
    expect(SRC).toMatch(
      /export async function unacknowledgeField\(input:\s*\{\s*projectId:\s*string\s*[\s\S]{0,80}targetFieldId:\s*string/,
    )
  })

  it('U0b: returns the documented discriminated union', () => {
    expect(SRC).toMatch(/export type UnacknowledgeFieldResult/)
    expect(SRC).toMatch(/success:\s*true;\s*tfmId:\s*string/)
    expect(SRC).toMatch(/errorCode:\s*UnacknowledgeFieldErrorCode/)
  })

  it('U0c: UnacknowledgeFieldErrorCode union exposes the documented error paths', () => {
    expect(SRC).toMatch(/export type UnacknowledgeFieldErrorCode/)
    const union = sliceFromTo(
      SRC,
      'export type UnacknowledgeFieldErrorCode',
      'export type UnacknowledgeFieldResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
  })
})

// ─────────────────────────────────────────────────────────────────────
// U1 — Auth gate
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U1 auth', () => {
  it('U1a: calls supabase.auth.getUser() and returns PERMISSION_DENIED on missing user', () => {
    expect(BODY).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(BODY).toMatch(
      /!user[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// U2 — Permission gate
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U2 permission', () => {
  it("U2a: enforces editor permission via requireProjectPermission(projectId, 'editor')", () => {
    expect(BODY).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
    expect(BODY).toMatch(/!perm\.allowed[\s\S]{0,200}PERMISSION_DENIED/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// U3 — Maintenance gate
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U3 maintenance', () => {
  it('U3a: calls assertMappingWritesEnabled and maps the maintenance message → MAINTENANCE_MODE', () => {
    expect(BODY).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    expect(BODY).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// U4 — Identity read + NOT_FOUND
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U4 NOT_FOUND', () => {
  it('U4a: reads the TFM via (project_id, target_field_id) — NOT filtered by is_acknowledged so we can distinguish NOT_FOUND from VALIDATION', () => {
    expect(BODY).toMatch(/from\(['"]target_field_mappings['"]\)/)
    expect(BODY).toMatch(/\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/)
    expect(BODY).toMatch(
      /\.eq\(\s*['"]target_field_id['"]\s*,\s*targetFieldId\s*\)/,
    )
    // NOT filtered by is_acknowledged: that filter lives in the state
    // guard (U5) so the wrapper can distinguish the two cases.
    expect(BODY).not.toMatch(
      /\.eq\(\s*['"]is_acknowledged['"]\s*,\s*true\s*\)\s*\.maybeSingle/,
    )
  })

  it('U4b: returns NOT_FOUND when no TFM exists', () => {
    expect(BODY).toMatch(/!tfm[\s\S]{0,200}errorCode:\s*['"]NOT_FOUND['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// U5 — State guard for non-acknowledged TFMs
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U5 VALIDATION on non-ack TFM', () => {
  it('U5a: returns VALIDATION when the TFM exists but is_acknowledged=false', () => {
    expect(BODY).toMatch(/!tfm\.is_acknowledged/)
    expect(BODY).toMatch(
      /!tfm\.is_acknowledged[\s\S]{0,400}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it("U5b: VALIDATION copy directs the user to the right surface (Edit / Reject)", () => {
    expect(BODY).toMatch(/Edit or Reject/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// U6 — Delegates to removeAcknowledgment
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U6 delegation', () => {
  it('U6a: imports removeAcknowledgment from @/lib/actions/field-acknowledgments', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*removeAcknowledgment\s*\}\s*from\s*['"]@\/lib\/actions\/field-acknowledgments['"]/,
    )
  })

  it('U6b: calls removeAcknowledgment(projectId, targetFieldId) inside a try/catch', () => {
    expect(BODY).toMatch(
      /try\s*\{[\s\S]{0,300}removeAcknowledgment\(\s*projectId\s*,\s*targetFieldId\s*\)[\s\S]{0,300}\}\s*catch/,
    )
  })

  it('U6c: catch arm maps unexpected throws to INTERNAL', () => {
    expect(BODY).toMatch(/errorCode:\s*['"]INTERNAL['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// U7 — Activity log + revalidate
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U7 activity log + revalidate', () => {
  it('U7a: emits acknowledgment_removed entry with tfm_id + target_field_id metadata', () => {
    expect(BODY).toMatch(
      /logActivity\([\s\S]{0,400}['"]acknowledgment_removed['"]/,
    )
    expect(BODY).toMatch(/tfm_id:\s*tfm\.id/)
    expect(BODY).toMatch(/target_field_id:\s*targetFieldId/)
  })

  it('U7b: revalidates the /mapping path so the row morphs to Rule 6 unmapped', () => {
    expect(BODY).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/mapping`/,
    )
  })

  it('U7c: returns success result with the deleted TFM id', () => {
    expect(BODY).toMatch(/return\s*\{\s*success:\s*true\s*,\s*tfmId:\s*tfm\.id\s*\}/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// U8 — Sequencing: auth-before-permission-before-DB-read
// ─────────────────────────────────────────────────────────────────────

describe('[unacknowledge-field] U8 sequencing', () => {
  it('U8a: validates input BEFORE auth (cheap rejection of empty projectId / targetFieldId)', () => {
    const validateIdx = BODY.indexOf("errorCode: 'VALIDATION'")
    const authIdx = BODY.indexOf('supabase.auth.getUser()')
    expect(validateIdx).toBeGreaterThan(0)
    expect(authIdx).toBeGreaterThan(0)
    expect(validateIdx).toBeLessThan(authIdx)
  })

  it('U8b: auth happens BEFORE requireProjectPermission', () => {
    const authIdx = BODY.indexOf('supabase.auth.getUser()')
    const permIdx = BODY.indexOf('requireProjectPermission(')
    expect(authIdx).toBeGreaterThan(0)
    expect(permIdx).toBeGreaterThan(0)
    expect(authIdx).toBeLessThan(permIdx)
  })

  it('U8c: permission gate happens BEFORE the identity read (avoids leaking existence)', () => {
    const permIdx = BODY.indexOf('requireProjectPermission(')
    const readIdx = BODY.indexOf("from('target_field_mappings')")
    expect(permIdx).toBeGreaterThan(0)
    expect(readIdx).toBeGreaterThan(0)
    expect(permIdx).toBeLessThan(readIdx)
  })

  it('U8d: identity read happens BEFORE removeAcknowledgment delegation', () => {
    const readIdx = BODY.indexOf("from('target_field_mappings')")
    const delegateIdx = BODY.indexOf('removeAcknowledgment(')
    expect(readIdx).toBeGreaterThan(0)
    expect(delegateIdx).toBeGreaterThan(0)
    expect(readIdx).toBeLessThan(delegateIdx)
  })
})
