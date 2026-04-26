// @vitest-environment node
//
// Phase 4c-1 — source-level invariant tests for the bulk-approve
// wrapper surface in `lib/actions/mappings-for-redesign.ts`:
//
//   - bulkApproveFieldMappingsForTargetTable(input)
//   - approveHighConfidenceMappings(input)
//   - previewBulkApprove(input)
//
// Same source-level testing strategy as `unacknowledge-field.test.ts`:
// read the action source as a string and pin the contract via regex.
// Catches architectural drift (missing auth gate, wrong scope filter,
// missing activity log) without requiring a Supabase fixture; the
// integration test in `tests/integration/bulk-approve-heritage.test.ts`
// pins the end-to-end behavior against real Heritage data.
//
// Invariants per the Phase 4c-1 task list:
//
//   B1.  Auth: `supabase.auth.getUser()` BEFORE any DB write; missing
//        user → PERMISSION_DENIED.
//   B2.  Permission: `requireProjectPermission(projectId, 'editor')`.
//   B3.  Maintenance gate via `assertMappingWritesEnabled(projectId)`.
//   B4.  Hard-coded scope: status='needs_review' AND
//        is_acknowledged=false. NO confidence threshold on the
//        per-table path. NO auto-acknowledge side effect.
//   B5.  Single bulk `.update().in()` write — NOT a per-row loop.
//   B6.  Single `mapping_bulk_approved` activity-log entry with
//        `tfm_ids` array + scope discriminator metadata.
//
//   HC1. approveHighConfidenceMappings adds `.gte('confidence', threshold)`
//        on top of the same scope filter.
//   HC2. Default threshold = 85 when omitted.
//   HC3. Threshold validation rejects values outside [0, 100] →
//        VALIDATION.
//   HC4. Activity-log scope discriminator = 'project_high_confidence'.
//
// Plus a recompute invariant (BR1) and a preview invariant (BP1-BP2).

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

const BULK_PER_TABLE_START = 'export async function bulkApproveFieldMappingsForTargetTable('
const HC_START = 'export async function approveHighConfidenceMappings('
const PREVIEW_START = 'export async function previewBulkApprove('

const BODY_BULK = sliceFromTo(SRC, BULK_PER_TABLE_START, HC_START)
// `approveHighConfidenceMappings` is the last function in the file
// (4c-1 ships at the bottom). Slice to end-of-file so any trailing
// docstring / future block doesn't break the regex.
const BODY_HC = SRC.slice(SRC.indexOf(HC_START))
// Preview body slices up to the JSDoc preceding the per-table function;
// stopping at the function start would also pull in the function's
// docblock (which mentions `.update().in()` and would false-positive
// the read-only invariants). The `* Bulk-approve every needs-review`
// sentinel is stable text inside that docblock.
const BODY_PREVIEW = sliceFromTo(
  SRC,
  PREVIEW_START,
  '* Bulk-approve every needs-review TFM',
)

// ─────────────────────────────────────────────────────────────────────
// B0 — Wrapper exports + types
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] wrapper shape', () => {
  it('B0a: exports BulkApproveErrorCode union with all 5 documented codes', () => {
    expect(SRC).toMatch(/export type BulkApproveErrorCode/)
    const union = sliceFromTo(
      SRC,
      'export type BulkApproveErrorCode',
      'export type BulkApproveResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
  })

  it('B0b: BulkApproveResult is a discriminated union with rowsAffected + tfmIds on success', () => {
    expect(SRC).toMatch(/export type BulkApproveResult/)
    expect(SRC).toMatch(/success:\s*true[\s\S]{0,200}rowsAffected:\s*number/)
    expect(SRC).toMatch(/tfmIds:\s*string\[\]/)
    expect(SRC).toMatch(/errorCode:\s*BulkApproveErrorCode/)
  })

  it('B0c: exports the three documented async functions', () => {
    expect(SRC).toMatch(BULK_PER_TABLE_START)
    expect(SRC).toMatch(HC_START)
    expect(SRC).toMatch(PREVIEW_START)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B1 — Auth gate (per-table + high-confidence)
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B1 auth', () => {
  it('B1a: per-table wrapper calls supabase.auth.getUser() and returns PERMISSION_DENIED on missing user', () => {
    expect(BODY_BULK).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(BODY_BULK).toMatch(
      /!user[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })

  it('B1b: high-confidence wrapper calls supabase.auth.getUser() with same PERMISSION_DENIED contract', () => {
    expect(BODY_HC).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(BODY_HC).toMatch(
      /!user[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// B2 — Permission gate (editor)
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B2 permission', () => {
  it('B2a: per-table wrapper enforces editor permission', () => {
    expect(BODY_BULK).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
    expect(BODY_BULK).toMatch(/!perm\.allowed[\s\S]{0,200}PERMISSION_DENIED/)
  })

  it('B2b: high-confidence wrapper enforces editor permission', () => {
    expect(BODY_HC).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// B3 — Maintenance gate
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B3 maintenance', () => {
  it('B3a: per-table wrapper calls assertMappingWritesEnabled and maps maintenance message → MAINTENANCE_MODE', () => {
    expect(BODY_BULK).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    expect(BODY_BULK).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })

  it('B3b: high-confidence wrapper has the same gate', () => {
    expect(BODY_HC).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    expect(BODY_HC).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// B4 — Hard-coded scope (no auto-ack, no live-filter influence)
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B4 hard-coded scope', () => {
  it("B4a: per-table wrapper filters by status='needs_review'", () => {
    expect(BODY_BULK).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]needs_review['"]\s*\)/)
  })

  it('B4b: per-table wrapper filters by is_acknowledged=false', () => {
    expect(BODY_BULK).toMatch(/\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/)
  })

  it('B4c: per-table wrapper does NOT auto-acknowledge unmapped fields (no upsert into target_field_mappings with is_acknowledged=true)', () => {
    expect(BODY_BULK).not.toMatch(/is_acknowledged:\s*true/)
    expect(BODY_BULK).not.toMatch(
      /\.upsert\([\s\S]{0,300}is_acknowledged/,
    )
  })

  it('B4d: per-table wrapper does NOT consult any user-filter-state argument (signature is { projectId, targetTableId })', () => {
    // The signature accepts only projectId + targetTableId. No filter
    // shape is read.
    expect(BODY_BULK).not.toMatch(/filters\./)
    expect(BODY_BULK).not.toMatch(/MappingFilterState/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B5 — Single bulk SQL UPDATE (NOT a per-row loop)
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B5 single bulk update', () => {
  it('B5a: per-table wrapper uses .update({ status: \'approved\' }).in(\'id\', tfmIds)', () => {
    expect(BODY_BULK).toMatch(
      /\.update\(\s*\{\s*status:\s*['"]approved['"]\s*\}\s*\)[\s\S]{0,200}\.in\(\s*['"]id['"]\s*,\s*tfmIds\s*\)/,
    )
  })

  it('B5b: high-confidence wrapper uses .update({ status: \'approved\' }) with .gte and chained eq filters', () => {
    expect(BODY_HC).toMatch(
      /\.update\(\s*\{\s*status:\s*['"]approved['"]\s*\}\s*\)/,
    )
    expect(BODY_HC).toMatch(/\.gte\(\s*['"]confidence['"]\s*,\s*threshold\s*\)/)
  })

  it('B5c: per-table wrapper does NOT iterate calling per-row updateFieldMappingStatus', () => {
    expect(BODY_BULK).not.toMatch(/for\s*\([\s\S]{0,200}updateFieldMappingStatus/)
    expect(BODY_BULK).not.toMatch(/await Promise\.all\([\s\S]{0,400}updateFieldMappingStatus/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B6 — Single bulk activity log entry
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] B6 activity log', () => {
  it('B6a: per-table wrapper emits exactly one mapping_bulk_approved entry', () => {
    expect(BODY_BULK).toMatch(
      /logActivity\([\s\S]{0,400}['"]mapping_bulk_approved['"]/,
    )
    // Only one logActivity call inside the body — guard against accidental N+1.
    const matches = BODY_BULK.match(/logActivity\(/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('B6b: per-table activity-log metadata carries scope, count, tfm_ids, target_table_id', () => {
    expect(BODY_BULK).toMatch(/scope:\s*['"]target_table_needs_review['"]/)
    expect(BODY_BULK).toMatch(/count:\s*tfmRows\.length/)
    expect(BODY_BULK).toMatch(/tfm_ids:\s*tfmIds/)
    expect(BODY_BULK).toMatch(/target_table_id:\s*targetTableId/)
  })

  it('B6c: per-table wrapper revalidates /mapping after the write', () => {
    expect(BODY_BULK).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/mapping`/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// BR1 — TM recompute pass
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] BR1 TM recompute', () => {
  it('BR1a: per-table wrapper calls recomputeTableMappingStatus after the bulk update', () => {
    expect(BODY_BULK).toMatch(/recomputeTableMappingStatus\(/)
  })

  it('BR1b: high-confidence wrapper also recomputes (multiple target tables possible)', () => {
    expect(BODY_HC).toMatch(/recomputeTableMappingStatus\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// HC1-HC4 — High-confidence specifics
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] HC1 confidence filter', () => {
  it('HC1a: high-confidence wrapper adds .gte(confidence, threshold) on top of the standard scope', () => {
    expect(BODY_HC).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]needs_review['"]\s*\)/)
    expect(BODY_HC).toMatch(/\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/)
    expect(BODY_HC).toMatch(/\.gte\(\s*['"]confidence['"]\s*,\s*threshold\s*\)/)
  })
})

describe('[bulk-approve] HC2 default threshold', () => {
  it('HC2a: threshold defaults to 85 when omitted', () => {
    expect(BODY_HC).toMatch(/threshold\s*=\s*input\.threshold\s*\?\?\s*85/)
  })
})

describe('[bulk-approve] HC3 threshold validation', () => {
  it('HC3a: rejects threshold outside [0, 100] with VALIDATION', () => {
    expect(BODY_HC).toMatch(
      /threshold\s*<\s*0\s*\|\|\s*threshold\s*>\s*100[\s\S]{0,300}errorCode:\s*['"]VALIDATION['"]/,
    )
  })
})

describe('[bulk-approve] HC4 activity log scope', () => {
  it('HC4a: emits mapping_bulk_approved with scope=project_high_confidence and threshold metadata', () => {
    expect(BODY_HC).toMatch(
      /logActivity\([\s\S]{0,400}['"]mapping_bulk_approved['"]/,
    )
    expect(BODY_HC).toMatch(/scope:\s*['"]project_high_confidence['"]/)
    expect(BODY_HC).toMatch(/threshold/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// BP1-BP2 — Preview helper
// ─────────────────────────────────────────────────────────────────────

describe('[bulk-approve] BP1 preview helper scope', () => {
  it('BP1a: previewBulkApprove uses the same hard-coded scope filters as the writer', () => {
    expect(BODY_PREVIEW).toMatch(
      /\.eq\(\s*['"]status['"]\s*,\s*['"]needs_review['"]\s*\)/,
    )
    expect(BODY_PREVIEW).toMatch(
      /\.eq\(\s*['"]is_acknowledged['"]\s*,\s*false\s*\)/,
    )
  })

  it('BP1b: previewBulkApprove caps the preview list at 5 rows', () => {
    expect(BODY_PREVIEW).toMatch(/\.slice\(0\s*,\s*5\)/)
  })
})

describe('[bulk-approve] BP2 preview helper is read-only', () => {
  it('BP2a: previewBulkApprove does NOT call .update / .delete / .insert / logActivity / revalidatePath', () => {
    expect(BODY_PREVIEW).not.toMatch(/\.update\(/)
    expect(BODY_PREVIEW).not.toMatch(/\.delete\(/)
    expect(BODY_PREVIEW).not.toMatch(/\.insert\(/)
    expect(BODY_PREVIEW).not.toMatch(/logActivity\(/)
    expect(BODY_PREVIEW).not.toMatch(/revalidatePath\(/)
  })

  it('BP2b: previewBulkApprove uses viewer-level permission (read-only)', () => {
    expect(BODY_PREVIEW).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]viewer['"]\s*\)/,
    )
  })
})
