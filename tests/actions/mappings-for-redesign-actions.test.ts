// @vitest-environment node
//
// Phase 3 Gap 9 — source-level invariant tests for the redesign-side
// `approveFieldMapping` and `rejectFieldMapping` wrappers.
//
// These wrappers are thin and delegate to the legacy actions
// (`updateFieldMappingStatus` and `deleteFieldMapping`) plus emit a
// `mapping_rejected` activity-log entry on the reject path. Because
// the underlying actions touch Supabase (auth, permission checks,
// guardWrites, DB UPDATE/DELETE, transform reset, FK cascade, table-
// mapping coverage recompute), full integration tests would require a
// substantial Supabase mocking harness.
//
// Instead we use the source-level invariant pattern (matching
// `tests/actions/mappings-refinements.test.ts`): read the source file,
// assert the call-site shape locks the founder-locked decisions in
// place. A future refactor that silently drops a refinement cannot
// land without breaking CI.
//
// The 5 founder decisions captured here as regression guards:
//
//   1. WRAPPER ACTIONS exist in the redesign-side action surface.
//   2. UNMAPPED SENTINEL is rejected by both wrappers.
//   3. ACKNOWLEDGED ROWS are defended at the action layer (belt-and-
//      suspenders alongside the UI's disabled-state matrix).
//   4. RACE CONDITION on reject is handled gracefully — `alreadyDeleted`
//      success path, no log call when project_id is unrecoverable.
//   5. ACTIVITY LOG PAYLOAD format on reject matches the legacy
//      `updateFieldMappingStatus` reject branch verbatim
//      (`Mapping rejected: <src> → <tgt>`).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// 1. Wrapper actions exist
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign actions] wrapper exports', () => {
  it('exports approveFieldMapping as an async function', () => {
    expect(SRC).toMatch(/export async function approveFieldMapping\(/)
  })

  it('exports rejectFieldMapping as an async function', () => {
    expect(SRC).toMatch(/export async function rejectFieldMapping\(/)
  })

  it("file is marked 'use server'", () => {
    expect(SRC.trimStart().startsWith("'use server'")).toBe(true)
  })

  it('imports the legacy actions it delegates to', () => {
    expect(SRC).toContain("from '@/lib/actions/mappings'")
    expect(SRC).toMatch(/deleteFieldMapping/)
    expect(SRC).toMatch(/updateFieldMappingStatus/)
  })

  it('imports logActivity for the reject activity-log entry', () => {
    expect(SRC).toContain("from '@/lib/actions/activity-log'")
    expect(SRC).toMatch(/logActivity/)
  })

  it('imports decodeShimmedRowId for id-shape gating', () => {
    expect(SRC).toContain("from '@/lib/compat/mapping-shim'")
    expect(SRC).toMatch(/decodeShimmedRowId/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. approveFieldMapping — sentinel + ack defense + delegation
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign actions] approveFieldMapping', () => {
  const body = sliceBetween(
    SRC,
    'export async function approveFieldMapping(',
    'export async function rejectFieldMapping(',
  )

  it("routes 'unmapped::' rows to the no-source coverage write path (PR α₀)", () => {
    // PR α₀ extended approve to accept the synthetic `unmapped::<uuid>`
    // id format that the read translator emits for kind='unmapped'
    // rows. The action now writes target_field_coverage.status='approved'
    // independent of any TFM (the TFM doesn't exist for these rows).
    // The branch is gated on the prefix constant, then routes to the
    // shared `setCoverageStatus` helper.
    expect(body).toMatch(/rowId\.startsWith\(UNMAPPED_ID_PREFIX\)/)
    expect(body).toContain("setCoverageStatus(")
    expect(body).toMatch(/['"]approved['"]/)
  })

  it('queries is_acknowledged before delegating (defensive against legacy bare-ack TFMs)', () => {
    // Legacy bare-ack TFMs (is_acknowledged=true) surface as kind='unmapped'
    // post-INF-57 via dual-recognition off the migration-098-backfilled
    // coverage row. Without this defense, an UPDATE on the bare-ack TFM's
    // .status would silently no-op the user-visible coverage state. See
    // file header.
    expect(body).toContain("from('target_field_mappings')")
    expect(body).toContain('is_acknowledged')
  })

  it('returns VALIDATION when the row is acknowledged (does not delegate)', () => {
    expect(body).toMatch(/is_acknowledged[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/)
  })

  it("delegates to updateFieldMappingStatus(rowId, 'approved')", () => {
    expect(body).toMatch(/return\s+updateFieldMappingStatus\(\s*rowId\s*,\s*['"]approved['"]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. rejectFieldMapping — sentinel + identity snapshot + race + log
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign actions] rejectFieldMapping', () => {
  const body = sliceBetween(
    SRC,
    'export async function rejectFieldMapping(',
    // End-of-file sentinel — the wrapper is the last function in the
    // module today, so we slice to EOF.
    '\n}\n',
  ) + '\n}\n' // re-attach the closing brace eaten by sliceBetween

  it("routes 'unmapped::' rows to the no-source coverage write path (PR α₀)", () => {
    // PR α₀ extended reject to accept the synthetic `unmapped::<uuid>`
    // id format. The action writes target_field_coverage.status='rejected'
    // — same coverage helper as the approve branch, different status.
    expect(body).toMatch(/rowId\.startsWith\(UNMAPPED_ID_PREFIX\)/)
    expect(body).toContain("setCoverageStatus(")
    expect(body).toMatch(/['"]rejected['"]/)
  })

  it('rejects ids that do not decode to a tfm-primary or tfm-contributor', () => {
    expect(body).toMatch(/decodeShimmedRowId/)
    expect(body).toMatch(/errorCode:\s*['"]NOT_FOUND['"]/)
  })

  it('queries the TFM identity (project_id, target_field name, is_acknowledged) BEFORE delete', () => {
    // The legacy deleteFieldMapping removes the row before we could
    // look up source/target names for the activity-log payload, so
    // the snapshot must happen first.
    const lookup = sliceBetween(
      body,
      "from('target_field_mappings')",
      'deleteFieldMapping(',
    )
    expect(lookup).toContain('project_id')
    expect(lookup).toContain('target_field_id')
    expect(lookup).toContain('is_acknowledged')
    // Must include the field-name join for the activity log.
    expect(lookup).toMatch(/fields:target_field_id\(name\)/)
  })

  it('returns VALIDATION when the row is acknowledged (does not delete)', () => {
    expect(body).toMatch(/is_acknowledged[\s\S]{0,300}errorCode:\s*['"]VALIDATION['"]/)
  })

  it('handles the race-condition path (TFM already gone) by returning alreadyDeleted: true', () => {
    expect(body).toContain('alreadyDeleted: true')
    // Race path returns success without invoking deleteFieldMapping.
    // The control flow shape: if (!tfmLookup) { return ... } MUST
    // appear BEFORE the deleteFieldMapping call.
    const tfmLookupGuardIdx = body.indexOf('alreadyDeleted: true')
    const deleteCallIdx = body.indexOf('deleteFieldMapping(')
    expect(tfmLookupGuardIdx).toBeGreaterThan(0)
    expect(deleteCallIdx).toBeGreaterThan(tfmLookupGuardIdx)
  })

  it('queries the primary mapping_source for the activity-log payload', () => {
    expect(body).toContain("from('mapping_sources')")
    expect(body).toContain('source_field_id')
    expect(body).toMatch(/order\(['"]ordinal['"],\s*\{\s*ascending:\s*true\s*\}\)/)
    expect(body).toContain('.limit(1)')
  })

  it('delegates the actual delete to the legacy deleteFieldMapping', () => {
    expect(body).toMatch(/await\s+deleteFieldMapping\(\s*rowId\s*\)/)
  })

  it("emits a 'mapping_rejected' activity log entry AFTER successful delete", () => {
    // Order constraint: log ONLY after delete success. PR α₀ added a
    // separate logActivity call in the no-source unmapped:: branch
    // (which does NOT call deleteFieldMapping); pin the order
    // constraint on the LATER log call (the post-delete one) by
    // searching from the deleteFieldMapping index forward.
    const deleteIdx = body.indexOf('deleteFieldMapping(')
    expect(deleteIdx).toBeGreaterThan(0)
    const postDeleteLogIdx = body.indexOf('logActivity(', deleteIdx)
    expect(postDeleteLogIdx).toBeGreaterThan(deleteIdx)
    expect(body).toMatch(/['"]mapping_rejected['"]/)
    expect(body).toMatch(/['"]mapping['"]/)
  })

  it('payload format matches the legacy reject branch (`Mapping rejected: <src> → <tgt>`)', () => {
    // Founder decision 3 — match legacy verbatim. Falls back to
    // `[value]` for src and `?` for tgt when names are unrecoverable.
    expect(body).toMatch(/Mapping rejected:/)
    expect(body).toMatch(/\[value\]/)
    expect(body).toMatch(/srcName\s*\?\?\s*['"]\[value\]['"]/)
    expect(body).toMatch(/tgtName\s*\?\?\s*['"]\?['"]/)
  })

  it('exposes alreadyDeleted on the result type so the UI can branch on it', () => {
    expect(SRC).toMatch(/alreadyDeleted\?:\s*boolean/)
  })

  it('post-delete write target_field_coverage.status=rejected (PR α₀ — keeps the row read as rejected)', () => {
    // PR α₀: after a successful TFM delete, the wrapper UPSERTs a
    // coverage row with status='rejected'. Without this write, the
    // read translator's resolution-priority falls back to a
    // synthesized 'needs_review' on next read (no TFM, no coverage
    // row, orphan target_only case) — and the user's reject click
    // would not stick.
    const deleteIdx = body.indexOf('deleteFieldMapping(')
    const coverageWriteIdx = body.indexOf('setCoverageStatus(', deleteIdx)
    expect(coverageWriteIdx).toBeGreaterThan(deleteIdx)
    // The write uses the TFM lookup's project_id + target_field_id and
    // 'rejected' as the third arg.
    const coverageBody = body.slice(coverageWriteIdx, coverageWriteIdx + 500)
    expect(coverageBody).toContain('tfmLookup.project_id')
    expect(coverageBody).toContain('tfmLookup.target_field_id')
    expect(coverageBody).toMatch(/['"]rejected['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. PR α₀ — no-source approve/reject path (target_field_coverage)
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign actions] PR α₀ no-source helpers', () => {
  it('declares UNMAPPED_ID_PREFIX as the synthetic id sentinel', () => {
    expect(SRC).toMatch(/const\s+UNMAPPED_ID_PREFIX\s*=\s*['"]unmapped::['"]/)
  })

  it('declares a UUID_REGEX guard so malformed unmapped:: ids return VALIDATION', () => {
    // Defense-in-depth: the slice after `unmapped::` must be a valid
    // UUID before the action looks up the field. Without this, an
    // attacker-supplied id could probe the fields table.
    expect(SRC).toMatch(/const\s+UUID_REGEX\s*=\s*\/\^\[0-9a-f\]/)
    expect(SRC).toMatch(/UUID_REGEX\.test\(/)
  })

  it('declares resolveFieldOwnership — walks fields → tables → datasets → project_id', () => {
    expect(SRC).toMatch(/async function resolveFieldOwnership\(/)
    // The single round-trip uses the standard ownership-chain join
    // (matches the pattern at lib/actions/fields.ts:81).
    expect(SRC).toMatch(/tables!inner\(datasets!inner\(project_id\)\)/)
  })

  it('declares setCoverageStatus — UPDATE-then-INSERT with coverage_status="gap" default', () => {
    // The helper avoids `.upsert()` because Supabase's upsert does a
    // full row replace on conflict, which would clobber Path D's
    // coverage_status. Instead: try UPDATE first (preserves
    // coverage_status); if no row matched, INSERT a synthesized row
    // with coverage_status='gap'.
    expect(SRC).toMatch(/async function setCoverageStatus\(/)
    expect(SRC).toContain("from('target_field_coverage')")
    // The UPDATE branch matches by (project_id, target_field_id) and
    // sets only status, status_set_by, updated_at.
    expect(SRC).toMatch(/\.update\(\s*\{[^}]*status[^}]*status_set_by:\s*['"]user['"]/)
    // The fallback INSERT carries the 'gap' default for
    // coverage_status (NOT NULL by migration 093 CHECK constraint).
    expect(SRC).toMatch(/coverage_status:\s*['"]gap['"]/)
    // status_set_by is hard-coded 'user' on both branches (the helper
    // is the user-driven write path).
    const helperBody = sliceBetween(
      SRC,
      'async function setCoverageStatus(',
      'async function gateNoSourceWrite(',
    )
    expect(helperBody).not.toMatch(/status_set_by:\s*['"]ai_auto['"]/)
    expect(helperBody).not.toMatch(/status_set_by:\s*['"]system_default['"]/)
  })

  it('declares gateNoSourceWrite — auth + role + maintenance-mode gate shared by approve/reject', () => {
    expect(SRC).toMatch(/async function gateNoSourceWrite\(/)
    // Gate sequence: auth → requireProjectPermission('editor') →
    // assertMappingWritesEnabled. Mirrors the inline pattern in
    // createFieldMapping.
    const gateBody = sliceBetween(
      SRC,
      'async function gateNoSourceWrite(',
      'export async function approveFieldMapping(',
    )
    expect(gateBody).toContain('createClient(')
    expect(gateBody).toContain("requireProjectPermission(projectId, 'editor')")
    expect(gateBody).toContain('assertMappingWritesEnabled')
    expect(gateBody).toMatch(/errorCode:\s*['"]MAINTENANCE_MODE['"]/)
  })

  it('approve no-source path: validates id, gates auth, writes coverage, logs activity, revalidates', () => {
    const approveBody = sliceBetween(
      SRC,
      'export async function approveFieldMapping(',
      'export async function rejectFieldMapping(',
    )
    // The unmapped:: branch (early in the function body) hits each
    // step in order: id validation → field ownership → gate → coverage
    // write → activity log → revalidatePath.
    const noSourceBranch = sliceBetween(
      approveBody,
      'rowId.startsWith(UNMAPPED_ID_PREFIX)',
      'const decoded = decodeShimmedRowId(rowId)',
    )
    expect(noSourceBranch).toContain('UUID_REGEX.test(')
    expect(noSourceBranch).toContain('resolveFieldOwnership(')
    expect(noSourceBranch).toContain('gateNoSourceWrite(')
    expect(noSourceBranch).toContain("setCoverageStatus(")
    expect(noSourceBranch).toMatch(/['"]approved['"]/)
    expect(noSourceBranch).toContain("logActivity(")
    expect(noSourceBranch).toContain("'mapping_approved'")
    expect(noSourceBranch).toContain('revalidatePath(')
  })

  it('reject no-source path: validates id, gates auth, writes coverage, logs activity, revalidates', () => {
    const rejectBody = sliceBetween(
      SRC,
      'export async function rejectFieldMapping(',
      'const decoded = decodeShimmedRowId(rowId)',
    )
    expect(rejectBody).toContain('UUID_REGEX.test(')
    expect(rejectBody).toContain('resolveFieldOwnership(')
    expect(rejectBody).toContain('gateNoSourceWrite(')
    expect(rejectBody).toContain("setCoverageStatus(")
    expect(rejectBody).toMatch(/['"]rejected['"]/)
    expect(rejectBody).toContain("logActivity(")
    expect(rejectBody).toContain("'mapping_rejected'")
    expect(rejectBody).toContain('revalidatePath(')
  })

  it('activity-log payload tags the no-source path with no_source: true metadata', () => {
    // Both no-source branches emit `no_source: true` in the metadata
    // payload so the audit trail can distinguish "user approved/
    // rejected a no-source row" from a regular TFM-backed action.
    expect(SRC.match(/no_source:\s*true/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('activity-log message format for no-source: "Mapping {action}: [no source] → <field>"', () => {
    // Distinguishes from the TFM-backed format which uses `[value]`
    // for VA fallback. `[no source]` makes it explicit that the row
    // had no TFM to begin with — not a VA whose source name was
    // unrecoverable.
    expect(SRC).toMatch(/Mapping approved: \[no source\]/)
    expect(SRC).toMatch(/Mapping rejected: \[no source\]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. Cross-cutting — generic error copy boundary
// ─────────────────────────────────────────────────────────────────────

describe('[mappings-for-redesign actions] result-type boundary', () => {
  it('exports MappingActionResult and RejectMappingResult', () => {
    expect(SRC).toMatch(/export\s+interface\s+MappingActionResult/)
    expect(SRC).toMatch(/export\s+interface\s+RejectMappingResult/)
  })

  it('threads MappingWriteErrorCode from the legacy module (single source of truth)', () => {
    expect(SRC).toContain('MappingWriteErrorCode')
    expect(SRC).toContain("from '@/lib/actions/mappings'")
  })
})
