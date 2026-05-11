// @vitest-environment node
//
// Phase 4c-2 — source-level invariant tests for the bulk-reject
// wrapper surface in `lib/actions/mappings-for-redesign.ts`:
//
//   - bulkRejectFieldMappingsForTargetTable(input)
//   - previewBulkReject(input)
//
// Same source-level testing strategy as `bulk-approve.test.ts`: read
// the action source as a string and pin the contract via regex. The
// integration test in `tests/integration/bulk-reject-heritage.test.ts`
// pins end-to-end behavior against real Heritage data.
//
// Invariants (BR1-BR25) per the Phase 4c-2 task list:
//
//   BR1.  Auth: `supabase.auth.getUser()` BEFORE any DB write; missing
//         user → PERMISSION_DENIED.
//   BR2.  Permission: `requireProjectPermission(projectId, 'editor')`.
//   BR3.  Maintenance gate via `assertMappingWritesEnabled(projectId)`.
//   BR4.  Empty scope returns VALIDATION ("nothing to reject"). NOT a
//         silent success — the user-facing UX surfaces the error.
//   BR5.  Hard-coded scope: status='needs_review' AND
//         is_acknowledged=false. NO confidence threshold.
//   BR6.  Per-TFM `resetFieldTransform(tfmId)` loop — called for every
//         in-scope TFM (the helper is no-op-safe for TFMs without a
//         transformation row, so the wrapper does NOT pre-filter).
//   BR7.  Forward-progress on transform-reset failure: failed TFMs
//         excluded from rejectable set + collected in `failedTfmIds`.
//   BR8.  Single bulk `.delete().in()` write — NOT a per-row loop.
//   BR9.  TM recompute pass for affected table_mappings.
//   BR10. Single `mapping_bulk_rejected` activity-log entry with
//         `tfm_ids` array + scope discriminator metadata.
//   BR11. Activity log metadata is COMPLETE (all required keys).
//   BR12. `failed_tfm_ids` lands in metadata only on partial-success.
//   BR13. revalidatePath called on the /mapping path.
//   BR14. Wrapper signature + return type discriminated union.
//
//   BP1-BP5. previewBulkReject contract:
//     BP1. Read-only — `viewer` permission, NOT editor.
//     BP2. Same scope filter as the write wrapper.
//     BP3. Preview list capped at 5; full count returned.
//     BP4. `hasTransform` flag derived from a batched transformations
//          query.
//     BP5. NO `.update()` / `.delete()` calls anywhere.

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

const BULK_REJECT_START =
  'export async function bulkRejectFieldMappingsForTargetTable('
const PREVIEW_REJECT_START = 'export async function previewBulkReject('

// `bulkRejectFieldMappingsForTargetTable` was the last function in the
// file at 4c-2 ship time. The flat-view server actions appended after
// it in feat/spreadsheet-view-server-actions; slice to the boundary
// banner that opens that section so the assertions below stay scoped
// to the bulk-reject body.
const FLAT_VIEW_BANNER = '// ─── Flat (spreadsheet) view server actions'
const BODY_REJECT = sliceFromTo(SRC, BULK_REJECT_START, FLAT_VIEW_BANNER)
// Preview body slices up to the JSDoc preceding the write wrapper.
// The `* Bulk-reject every needs-review` sentinel is stable docblock text.
const BODY_PREVIEW = sliceFromTo(
  SRC,
  PREVIEW_REJECT_START,
  '* Bulk-reject every needs-review TFM',
)

// ─────────────────────────────────────────────────────────────────────
// BR0 — Wrapper exports + types
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR0 wrapper shape', () => {
  it('BR0a: exports BulkRejectErrorCode union with all 5 documented codes', () => {
    expect(SRC).toMatch(/export type BulkRejectErrorCode/)
    const union = sliceFromTo(
      SRC,
      'export type BulkRejectErrorCode',
      'export type BulkRejectResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
  })

  it('BR0b: BulkRejectResult success variant carries rowsAffected, transformsReset, stagedRowsReverted, tfmIds, failedTfmIds?', () => {
    expect(SRC).toMatch(/export type BulkRejectResult/)
    const t = sliceFromTo(
      SRC,
      'export type BulkRejectResult',
      // The next exported function or type after the union.
      'export async function previewBulkReject(',
    )
    expect(t).toMatch(/success:\s*true/)
    expect(t).toMatch(/rowsAffected:\s*number/)
    expect(t).toMatch(/transformsReset:\s*number/)
    expect(t).toMatch(/stagedRowsReverted:\s*number/)
    expect(t).toMatch(/tfmIds:\s*string\[\]/)
    expect(t).toMatch(/failedTfmIds\?:\s*string\[\]/)
  })

  it('BR0c: BulkRejectResult failure variant carries error + errorCode', () => {
    const t = sliceFromTo(
      SRC,
      'export type BulkRejectResult',
      'export async function previewBulkReject(',
    )
    expect(t).toMatch(/success:\s*false/)
    expect(t).toMatch(/error:\s*string/)
    expect(t).toMatch(/errorCode:\s*BulkRejectErrorCode/)
  })

  it('BR0d: wrapper signature returns Promise<BulkRejectResult>', () => {
    expect(SRC).toMatch(
      /bulkRejectFieldMappingsForTargetTable\(input:[\s\S]{0,200}\)\s*:\s*Promise<BulkRejectResult>/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR1-BR4 — Auth, permission, maintenance, scope-empty gates
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR1-BR4 gates', () => {
  it('BR1: PERMISSION_DENIED when no auth user', () => {
    expect(BODY_REJECT).toMatch(/auth\.getUser\(\)/)
    expect(BODY_REJECT).toMatch(
      /if\s*\(\s*!user[\s\S]{0,200}errorCode:\s*'PERMISSION_DENIED'/,
    )
  })

  it('BR2: requireProjectPermission(projectId, "editor") gate', () => {
    expect(BODY_REJECT).toMatch(
      /requireProjectPermission\(projectId,\s*'editor'\)/,
    )
    expect(BODY_REJECT).toMatch(
      /if\s*\(\s*!perm\.allowed[\s\S]{0,250}errorCode:\s*'PERMISSION_DENIED'/,
    )
  })

  it('BR3: maintenance gate maps to MAINTENANCE_MODE error code', () => {
    expect(BODY_REJECT).toMatch(/assertMappingWritesEnabled\(projectId\)/)
    expect(BODY_REJECT).toMatch(/errorCode:\s*'MAINTENANCE_MODE'/)
  })

  it('BR4: empty in-scope set returns VALIDATION (not silent success)', () => {
    // Empty target-fields universe AND empty TFM identity read both
    // return VALIDATION with copy mentioning "needs-review" or
    // "nothing to reject".
    expect(BODY_REJECT).toMatch(/errorCode:\s*'VALIDATION'/)
    expect(BODY_REJECT).toMatch(/No needs-review mappings to reject/)
  })

  it('BR4b: input validation rejects empty projectId / targetTableId', () => {
    expect(BODY_REJECT).toMatch(/if\s*\(\s*!projectId\s*\)/)
    expect(BODY_REJECT).toMatch(/if\s*\(\s*!targetTableId\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR5 — Hard-coded scope filter
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR5 scope filter', () => {
  it("BR5a: identity read filters .eq('status', 'needs_review')", () => {
    expect(BODY_REJECT).toMatch(/\.eq\(\s*'status',\s*'needs_review'\s*\)/)
  })

  it("BR5b: identity read filters .eq('is_acknowledged', false)", () => {
    expect(BODY_REJECT).toMatch(/\.eq\(\s*'is_acknowledged',\s*false\s*\)/)
  })

  it("BR5c: identity read scopes .eq('project_id', projectId)", () => {
    expect(BODY_REJECT).toMatch(/\.eq\(\s*'project_id',\s*projectId\s*\)/)
  })

  it("BR5d: identity read scopes .in('target_field_id', targetFieldIds)", () => {
    expect(BODY_REJECT).toMatch(
      /\.in\(\s*'target_field_id',\s*targetFieldIds\s*\)/,
    )
  })

  it('BR5e: NO confidence threshold filter (per-table reject ignores confidence)', () => {
    // Defensive: the high-confidence path is approve-only. No
    // .gte('confidence', ...) should leak into the reject body.
    expect(BODY_REJECT).not.toMatch(/\.gte\(\s*'confidence'/)
  })

  it('BR5f: target table ownership pre-check (datasets.project_id matches)', () => {
    // Defends against cross-project drift — the targetTableId must
    // belong to a dataset within the input projectId.
    expect(BODY_REJECT).toMatch(
      /datasets\?\.project_id\s*!==\s*projectId[\s\S]{0,200}errorCode:\s*'NOT_FOUND'/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR6-BR7 — Transform-reset loop + partial-success forward-progress
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR6-BR7 transform reset loop', () => {
  it('BR6a: imports resetFieldTransform from transformations module', () => {
    expect(SRC).toMatch(
      /import\s*\{\s*resetFieldTransform\s*\}\s*from\s*['"]@\/lib\/actions\/transformations['"]/,
    )
  })

  it('BR6b: per-TFM loop calls resetFieldTransform(tfm.id)', () => {
    // The loop iterates `tfmRows` and awaits resetFieldTransform per row.
    expect(BODY_REJECT).toMatch(
      /for\s*\(\s*const\s+tfm\s+of\s+tfmRows\s*\)[\s\S]{0,400}await\s+resetFieldTransform\(tfm\.id\)/,
    )
  })

  it('BR6c: hadTransform increments transformsReset counter', () => {
    expect(BODY_REJECT).toMatch(/r\.hadTransform/)
    expect(BODY_REJECT).toMatch(/transformsReset\s*\+=\s*1/)
  })

  it('BR6d: rowsReverted accumulates into stagedRowsReverted', () => {
    expect(BODY_REJECT).toMatch(/stagedRowsReverted\s*\+=\s*r\.rowsReverted/)
  })

  it('BR7a: reset failure pushes onto failedTfmIds and continues (forward-progress)', () => {
    expect(BODY_REJECT).toMatch(
      /if\s*\(\s*!r\.success\s*\)\s*\{[\s\S]{0,200}failedTfmIds\.push\(tfm\.id\)[\s\S]{0,80}continue/,
    )
  })

  it('BR7b: rejectable set EXCLUDES failed TFMs (only successes pushed)', () => {
    // The push happens AFTER the !r.success early-return, so failed
    // TFMs never reach `rejectable`.
    expect(BODY_REJECT).toMatch(/rejectable\.push\(tfm\)/)
  })

  it('BR7c: empty rejectable set after all-fails returns INTERNAL (not VALIDATION)', () => {
    // Distinguishes "nothing to reject" (VALIDATION, hit before the
    // loop) from "transform reset failed for everything" (INTERNAL,
    // genuine system error).
    expect(BODY_REJECT).toMatch(
      /rejectable\.length\s*===\s*0[\s\S]{0,250}errorCode:\s*'INTERNAL'/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR8 — Single bulk DELETE
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR8 bulk delete', () => {
  it("BR8a: single .delete().in('id', rejectableIds) call against target_field_mappings", () => {
    expect(BODY_REJECT).toMatch(
      /from\(\s*'target_field_mappings'\s*\)[\s\S]{0,80}\.delete\(\s*\)[\s\S]{0,80}\.in\(\s*'id',\s*rejectableIds\s*\)/,
    )
  })

  it('BR8b: NO per-row delete loop over target_field_mappings', () => {
    // Defensive: ensure the wrapper does NOT degenerate into a per-row
    // loop. Only one `.delete()` call should appear in the body.
    const matches = BODY_REJECT.match(/\.delete\(\s*\)/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('BR8c: delete error returns INTERNAL', () => {
    expect(BODY_REJECT).toMatch(
      /deleteError[\s\S]{0,150}errorCode:\s*'INTERNAL'/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR9 — TM recompute pass
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR9 TM recompute', () => {
  it("BR9a: looks up table_mappings filtered by target_table_id + project_id", () => {
    expect(BODY_REJECT).toMatch(
      /from\(\s*'table_mappings'\s*\)[\s\S]{0,300}\.eq\(\s*'target_table_id',\s*targetTableId\s*\)/,
    )
  })

  it('BR9b: calls recomputeTableMappingStatus for each TM', () => {
    expect(BODY_REJECT).toMatch(/recomputeTableMappingStatus\(supabase,\s*tm\.id\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR10-BR12 — Activity log
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR10-BR12 activity log', () => {
  it('BR10a: single logActivity call with mapping_bulk_rejected action type', () => {
    expect(BODY_REJECT).toMatch(/logActivity\(/)
    expect(BODY_REJECT).toMatch(/'mapping_bulk_rejected'/)
    const matches = BODY_REJECT.match(/logActivity\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('BR11a: scope discriminator = target_table_needs_review', () => {
    expect(BODY_REJECT).toMatch(/scope:\s*'target_table_needs_review'/)
  })

  it('BR11b: metadata carries count, tfm_ids, fields_affected', () => {
    expect(BODY_REJECT).toMatch(/count:\s*rejectable\.length/)
    expect(BODY_REJECT).toMatch(/tfm_ids:\s*rejectableIds/)
    expect(BODY_REJECT).toMatch(/fields_affected:\s*fieldsAffected/)
  })

  it('BR11c: metadata carries target_table_id + target_table_name', () => {
    expect(BODY_REJECT).toMatch(/target_table_id:\s*targetTableId/)
    expect(BODY_REJECT).toMatch(/target_table_name:\s*targetTable\.name/)
  })

  it('BR11d: metadata carries transforms_reset count', () => {
    expect(BODY_REJECT).toMatch(/transforms_reset:\s*transformsReset/)
  })

  it('BR12a: failed_tfm_ids only present when failedTfmIds is non-empty', () => {
    // The `...(failedTfmIds.length > 0 ? { failed_tfm_ids: failedTfmIds } : {})`
    // spread keeps the key absent on full success. This is the
    // canonical pattern for optional metadata keys in this codebase.
    expect(BODY_REJECT).toMatch(
      /failedTfmIds\.length\s*>\s*0\s*\?\s*\{\s*failed_tfm_ids:\s*failedTfmIds\s*\}\s*:\s*\{\s*\}/,
    )
  })

  it('BR12b: success-result also conditionally includes failedTfmIds', () => {
    // Mirror invariant — same spread pattern on the success return.
    expect(BODY_REJECT).toMatch(
      /failedTfmIds\.length\s*>\s*0\s*\?\s*\{\s*failedTfmIds\s*\}\s*:\s*\{\s*\}/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR13 — revalidatePath
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR13 revalidatePath', () => {
  it('BR13a: revalidatePath called on /mapping path', () => {
    expect(BODY_REJECT).toMatch(
      /revalidatePath\(`\/app\/projects\/\$\{projectId\}\/mapping`\)/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR14 — Sequencing invariant: reset BEFORE delete
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BR14 sequencing', () => {
  it('BR14a: per-TFM reset loop runs BEFORE the bulk delete', () => {
    // Critical contract from §9: reset has to resolve names + revert
    // staged data with the right TFM context in scope; once the bulk
    // DELETE runs the FK rows are gone and reset would early-return.
    const resetIdx = BODY_REJECT.indexOf('await resetFieldTransform(')
    const deleteIdx = BODY_REJECT.search(
      /from\(\s*'target_field_mappings'\s*\)[\s\S]{0,80}\.delete\(\s*\)/,
    )
    expect(resetIdx).toBeGreaterThan(0)
    expect(deleteIdx).toBeGreaterThan(0)
    expect(resetIdx).toBeLessThan(deleteIdx)
  })

  it('BR14b: activity log runs AFTER the bulk delete (pure forward audit trail)', () => {
    const deleteIdx = BODY_REJECT.search(
      /from\(\s*'target_field_mappings'\s*\)[\s\S]{0,80}\.delete\(\s*\)/,
    )
    const logIdx = BODY_REJECT.indexOf("'mapping_bulk_rejected'")
    expect(deleteIdx).toBeLessThan(logIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BP1-BP5 — previewBulkReject contract
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-reject] BP previewBulkReject', () => {
  it('BP1: viewer-level permission (NOT editor)', () => {
    expect(BODY_PREVIEW).toMatch(
      /requireProjectPermission\(projectId,\s*'viewer'\)/,
    )
    expect(BODY_PREVIEW).not.toMatch(
      /requireProjectPermission\(projectId,\s*'editor'\)/,
    )
  })

  it('BP2a: same scope filter as the write wrapper (status=needs_review, is_acknowledged=false)', () => {
    expect(BODY_PREVIEW).toMatch(/\.eq\(\s*'status',\s*'needs_review'\s*\)/)
    expect(BODY_PREVIEW).toMatch(/\.eq\(\s*'is_acknowledged',\s*false\s*\)/)
  })

  it('BP3: preview list capped at 5; full count returned', () => {
    expect(BODY_PREVIEW).toMatch(/tfmRows\.slice\(0,\s*5\)/)
    expect(BODY_PREVIEW).toMatch(/const\s+count\s*=\s*tfmRows\.length/)
    expect(BODY_PREVIEW).toMatch(/return\s*\{\s*count\s*,/)
  })

  it('BP4a: hasTransform flag derived from a batched transformations query', () => {
    expect(BODY_PREVIEW).toMatch(
      /from\(\s*'transformations'\s*\)[\s\S]{0,200}\.in\(\s*'target_field_mapping_id',\s*previewTfmIds\s*\)/,
    )
    expect(BODY_PREVIEW).toMatch(/hasTransform:\s*hasTransformByTfmId\.has/)
  })

  it('BP4b: preview row shape includes tfmId, targetField, primarySource, hasTransform', () => {
    expect(BODY_PREVIEW).toMatch(/tfmId:\s*string/)
    expect(BODY_PREVIEW).toMatch(/targetField:\s*string/)
    expect(BODY_PREVIEW).toMatch(/primarySource:\s*string\s*\|\s*null/)
    expect(BODY_PREVIEW).toMatch(/hasTransform:\s*boolean/)
  })

  it('BP5a: NO .update() / .delete() in the preview body', () => {
    expect(BODY_PREVIEW).not.toMatch(/\.update\(/)
    expect(BODY_PREVIEW).not.toMatch(/\.delete\(/)
  })

  it('BP5b: NO logActivity / NO revalidatePath in the preview body', () => {
    expect(BODY_PREVIEW).not.toMatch(/logActivity\(/)
    expect(BODY_PREVIEW).not.toMatch(/revalidatePath\(/)
  })
})
