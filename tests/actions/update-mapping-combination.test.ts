// @vitest-environment node
//
// Phase 4b-1 — source-level invariant tests for the
// `updateMappingCombination` server action (W3 surface).
//
// Same source-level testing strategy as `edit-mapping-sources.test.ts`.
// Five invariants per the Phase 4b-1 task list (C1-C5):
//
//   C1.  Wrapper exports + error union shape.
//   C2.  Validation: tfmId required, custom_sql blocked, single↔count
//        sanity vs. existing source count.
//   C3.  Auth + permission + state guards (TFM_REJECTED, TFM_ACKNOWLEDGED,
//        MAINTENANCE_MODE).
//   C4.  Status revert to needs_review on every UPDATE; transform is
//        NOT reset (founder §1.3); no resetFieldTransform call in the
//        body.
//   C5.  Activity log emits `mapping_combination_changed` with
//        previous_combination_type + new combination_type; revalidates
//        /mapping AND /transform.

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
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const BODY = sliceBetween(
  SRC,
  'export async function updateMappingCombination(',
  'export async function previewEditInvalidation(',
)

// ─────────────────────────────────────────────────────────────────────
// C1 — Wrapper exports + error union
// ─────────────────────────────────────────────────────────────────────

describe('[update-mapping-combination] wrapper shape', () => {
  it('C1a: exports updateMappingCombination as an async function with documented signature', () => {
    expect(SRC).toMatch(
      /export async function updateMappingCombination\(\s*tfmId:\s*string\s*,\s*combinationType:\s*CreateFieldMappingCombinationType\s*\|\s*['"]custom_sql['"]/,
    )
  })

  it('C1b: returns the documented discriminated union', () => {
    expect(SRC).toMatch(/export type UpdateCombinationResult/)
    const resultUnion = sliceBetween(
      SRC,
      'export type UpdateCombinationResult',
      'export type PreviewEditInvalidation',
    )
    expect(resultUnion).toMatch(/success:\s*true;\s*tfmId:\s*string/)
    expect(resultUnion).toMatch(/errorCode:\s*UpdateCombinationErrorCode/)
  })

  it('C1c: UpdateCombinationErrorCode union exposes the documented error paths', () => {
    const union = sliceBetween(
      SRC,
      'export type UpdateCombinationErrorCode',
      'export type UpdateCombinationResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
    expect(union).toContain("'TFM_REJECTED'")
    expect(union).toContain("'TFM_ACKNOWLEDGED'")
  })
})

// ─────────────────────────────────────────────────────────────────────
// C2 — Validation
// ─────────────────────────────────────────────────────────────────────

describe('[update-mapping-combination] validation', () => {
  it('C2a: rejects empty tfmId with VALIDATION', () => {
    expect(BODY).toMatch(/!tfmId[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/)
  })

  it("C2b: blocks combinationType === 'custom_sql' at the wrapper boundary", () => {
    expect(BODY).toMatch(/combinationType\s*===\s*['"]custom_sql['"]/)
    expect(BODY).toMatch(
      /custom_sql[\s\S]{0,300}errorCode:\s*['"]VALIDATION['"]/,
    )
    expect(BODY).toMatch(/Transform tab/)
  })

  it("C2c: 'single' requires the existing TFM to have exactly one source", () => {
    expect(BODY).toMatch(/from\(['"]mapping_sources['"]\)/)
    expect(BODY).toMatch(/count:\s*['"]exact['"]/)
    expect(BODY).toMatch(
      /combinationType\s*===\s*['"]single['"]\s*&&\s*sourceCount\s*!==\s*1[\s\S]{0,400}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it("C2d: non-'single' requires the existing TFM to have at least two sources", () => {
    expect(BODY).toMatch(
      /combinationType\s*!==\s*['"]single['"]\s*&&\s*sourceCount\s*<\s*2[\s\S]{0,400}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it('C2e: no-op short-circuit when the new combination matches existing AND status already needs_review', () => {
    expect(BODY).toMatch(
      /tfm\.combination_type\s*===\s*combinationType\s*&&\s*tfm\.status\s*===\s*['"]needs_review['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// C3 — Auth + permission + state guards
// ─────────────────────────────────────────────────────────────────────

describe('[update-mapping-combination] auth + state guards', () => {
  it('C3a: checks auth via supabase.auth.getUser() → PERMISSION_DENIED on missing user', () => {
    expect(BODY).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(BODY).toMatch(
      /!user[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })

  it('C3b: reads target_field_mappings for project_id + status + is_acknowledged + combination_type and returns NOT_FOUND when missing', () => {
    expect(BODY).toMatch(/from\(['"]target_field_mappings['"]\)/)
    expect(BODY).toMatch(
      /\.select\(\s*['"][^'"]*project_id[^'"]*status[^'"]*is_acknowledged[^'"]*combination_type[^'"]*['"]/,
    )
    expect(BODY).toMatch(
      /!tfm[\s\S]{0,200}errorCode:\s*['"]NOT_FOUND['"]/,
    )
  })

  it('C3c: enforces editor permission via requireProjectPermission(tfm.project_id, "editor")', () => {
    expect(BODY).toMatch(
      /requireProjectPermission\(\s*tfm\.project_id\s*,\s*['"]editor['"]\s*\)/,
    )
    expect(BODY).toMatch(/!perm\.allowed[\s\S]{0,200}PERMISSION_DENIED/)
  })

  it('C3d: TFM_REJECTED + TFM_ACKNOWLEDGED guards in place', () => {
    expect(BODY).toMatch(/tfm\.status\s*===\s*['"]rejected['"]/)
    expect(BODY).toMatch(
      /['"]rejected['"][\s\S]{0,400}errorCode:\s*['"]TFM_REJECTED['"]/,
    )
    expect(BODY).toMatch(/tfm\.is_acknowledged/)
    expect(BODY).toMatch(
      /is_acknowledged[\s\S]{0,400}errorCode:\s*['"]TFM_ACKNOWLEDGED['"]/,
    )
  })

  it('C3e: maintenance gate via assertMappingWritesEnabled', () => {
    expect(BODY).toMatch(/assertMappingWritesEnabled\(\s*tfm\.project_id\s*\)/)
    expect(BODY).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// C4 — Status revert + transform NOT reset (founder §1.3)
// ─────────────────────────────────────────────────────────────────────

describe('[update-mapping-combination] status revert + no transform reset', () => {
  it('C4a: every successful update flips status back to needs_review', () => {
    expect(BODY).toMatch(/from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,300}status:\s*['"]needs_review['"]/)
  })

  it('C4b: combination_type + updated_at threaded through the same UPDATE', () => {
    expect(BODY).toMatch(/combination_type:\s*combinationType/)
    expect(BODY).toMatch(/updated_at:\s*new Date\(\)\.toISOString\(\)/)
  })

  it('C4c: founder §1.3 — does NOT call resetFieldTransform (combination-only changes leave transform SQL intact)', () => {
    expect(BODY).not.toMatch(/resetFieldTransform/)
  })

  it('C4d: founder §1.3 — does NOT call dq_replace_mapping_sources (no source change)', () => {
    expect(BODY).not.toMatch(/dq_replace_mapping_sources/)
  })

  it('C4e: maps INTERNAL on UPDATE error', () => {
    expect(BODY).toMatch(/updErr[\s\S]{0,200}errorCode:\s*['"]INTERNAL['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// C5 — Activity log + revalidate
// ─────────────────────────────────────────────────────────────────────

describe('[update-mapping-combination] activity log + revalidate', () => {
  it('C5a: emits mapping_combination_changed with previous_combination_type + combination_type metadata', () => {
    expect(BODY).toMatch(
      /logActivity\([\s\S]{0,400}['"]mapping_combination_changed['"]/,
    )
    expect(BODY).toMatch(/previous_combination_type:\s*tfm\.combination_type/)
    expect(BODY).toMatch(/combination_type:\s*combinationType/)
  })

  it('C5b: revalidates both /mapping AND /transform', () => {
    expect(BODY).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{tfm\.project_id\}\/mapping`/,
    )
    expect(BODY).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{tfm\.project_id\}\/transform`/,
    )
  })

  it('C5c: returns success result with the unchanged tfmId', () => {
    expect(BODY).toMatch(/return\s*\{\s*success:\s*true\s*,\s*tfmId:\s*tfm\.id\s*\}/)
  })
})
