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

  it("rejects rows whose id begins with 'unmapped::' (no TFM to approve)", () => {
    expect(body).toMatch(/rowId\.startsWith\(['"]unmapped::['"]\)/)
    expect(body).toMatch(/errorCode:\s*['"]VALIDATION['"]/)
  })

  it('queries is_acknowledged before delegating (defensive against the redesign id-encoding gotcha)', () => {
    // The redesign's TargetAcknowledgedRow uses the bare TFM UUID as
    // its id, which decodes as `tfm-primary` — the legacy short-circuit
    // for `target-ack` does NOT fire. Without this defense, an
    // acknowledged row's TFM.status would be UPDATEd. See file header.
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

  it("rejects rows whose id begins with 'unmapped::' (no TFM to delete)", () => {
    expect(body).toMatch(/rowId\.startsWith\(['"]unmapped::['"]\)/)
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
    // Order constraint: log ONLY after delete success.
    const deleteIdx = body.indexOf('deleteFieldMapping(')
    const logIdx = body.indexOf('logActivity(')
    expect(deleteIdx).toBeGreaterThan(0)
    expect(logIdx).toBeGreaterThan(deleteIdx)
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
})

// ─────────────────────────────────────────────────────────────────────
// 4. Cross-cutting — generic error copy boundary
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
