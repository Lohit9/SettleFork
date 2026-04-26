import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Phase 4a-6 cross-table apply path.
 *
 * Sister file to `transforms-refinements.test.ts`. Same source-text
 * strategy: mocking Supabase's chainable client + the LATERAL-emitting
 * RPC is strictly worse than grepping for the call patterns we care
 * about. Behaviour-level coverage of the actual apply path lives in
 * `tests/integration/transform-apply-cross-table-heritage.test.ts`
 * (run on demand against Heritage).
 *
 * Pinned invariants (paired with the user-locked decisions):
 *
 *   X1  applyTransform calls `buildJoinSpec` BEFORE invoking the RPC,
 *       and propagates `CROSS_TABLE_FK_INFERENCE_FAILED` as
 *       `errorCode` when the helper returns `ok:false`. (Decisions
 *       1-OQ-A + the new error code.)
 *
 *   X2  applyTransform routes mapped TFMs to
 *       `dq_apply_field_transform_joined` with the four-arg payload
 *       (tfmId, target_name, transform_sql, p_join_spec). The
 *       `p_join_spec` is the spec returned by `buildJoinSpec` for
 *       cross-table TFMs and `null` for same-table TFMs. (Decision
 *       1-OQ-A + 5-OQ-B.)
 *
 *   X3  applyTransform uses the cross-table-aware
 *       `wrapFieldRefsInJsonb` overload (Map → CrossTableFieldEntry)
 *       only on the cross-table branch; same-table calls keep the
 *       byte-for-byte `string[]` overload. (Decision 4-OQ-B.)
 *
 *   X4  Phase 4a-3 transparency stack is fully retired —
 *       `CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED`, `isCrossTableTfm`,
 *       and `projectHasCrossTableMappings` are no longer in the
 *       source. (Decision 6-OQ-A + 6-OQ-B.)
 *
 *   X5  testTransformation MIRRORS the same buildJoinSpec routing so
 *       FK ambiguity surfaces consistently across Apply and Test, and
 *       cross-table SQL is qualified before being collapsed for the
 *       single-partition `execute_transform_test` RPC. (Decision —
 *       same routing logic as applyTransform, deferred parity.)
 *
 *   X6  TransformWriteErrorCode union includes the new
 *       `CROSS_TABLE_FK_INFERENCE_FAILED` member.
 */

const TRANSFORMS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const TRANSFORMS_SRC = readFileSync(TRANSFORMS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const APPLY_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function applyTransform(',
  'export async function revertTransform(',
)

const TEST_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function testTransformation(',
  'export async function applyTransform(',
)

// ─── X1 — buildJoinSpec gating ───────────────────────────────────────────────

describe('[transforms-cross-table-apply] X1 — buildJoinSpec gates the RPC call', () => {
  it('applyTransform calls buildJoinSpec before invoking the RPC', () => {
    const buildIdx = APPLY_BODY.indexOf('buildJoinSpec(')
    const rpcIdx = APPLY_BODY.indexOf("'dq_apply_field_transform_joined'")
    expect(buildIdx).toBeGreaterThan(0)
    expect(rpcIdx).toBeGreaterThan(0)
    expect(buildIdx).toBeLessThan(rpcIdx)
  })

  it('applyTransform propagates CROSS_TABLE_FK_INFERENCE_FAILED as errorCode', () => {
    // The helper returns `{ ok:false, errorCode: 'CROSS_TABLE_FK_INFERENCE_FAILED', error }`.
    // The action layer must surface BOTH `error` and `errorCode` so the UI
    // can render the user-facing copy and the caller can branch on the
    // structured code.
    expect(APPLY_BODY).toMatch(/errorCode:\s*joinSpec\.errorCode/)
    expect(APPLY_BODY).toMatch(/error:\s*joinSpec\.error/)
  })

  it('applyTransform skips buildJoinSpec entirely for value assignments', () => {
    // VAs have no source field; building a join spec would over-query.
    // Pin the `if (!isValueAssignment)` guard.
    expect(APPLY_BODY).toMatch(/if\s*\(\s*!isValueAssignment\s*\)\s*\{\s*[\s\S]*?buildJoinSpec\s*\(/)
  })
})

// ─── X2 — RPC payload shape ──────────────────────────────────────────────────

describe('[transforms-cross-table-apply] X2 — joined RPC payload', () => {
  it('mapped TFMs pass the four-key payload to dq_apply_field_transform_joined', () => {
    // The exact key set we pin is the same one migration 076 declares
    // in its function signature.
    expect(APPLY_BODY).toContain("'dq_apply_field_transform_joined'")
    expect(APPLY_BODY).toMatch(/p_target_field_mapping_id:\s*ctx\.tfm\.id/)
    expect(APPLY_BODY).toMatch(/p_target_field_name:\s*tgtField\.name/)
    expect(APPLY_BODY).toMatch(/p_transform_sql:\s*wrappedSql/)
    expect(APPLY_BODY).toMatch(/p_join_spec\b/)
  })

  it('same-table TFMs default p_join_spec to null', () => {
    // Migration 074 byte-for-byte semantics on the same-table branch
    // hinge on this default.
    expect(APPLY_BODY).toMatch(/let\s+p_join_spec[^=]*=\s*null/)
  })

  it('cross-table TFMs assign the buildJoinSpec result to p_join_spec', () => {
    // The assignment site lives inside the `okSpec.spec && okSpec.fieldMap`
    // branch — extract the surrounding scope to anchor it.
    const branch = sliceBetween(
      APPLY_BODY,
      'if (okSpec.spec && okSpec.fieldMap)',
      '} else {',
    )
    expect(branch).toMatch(/p_join_spec\s*=\s*okSpec\.spec/)
  })
})

// ─── X3 — wrapFieldRefsInJsonb overload routing ──────────────────────────────

describe('[transforms-cross-table-apply] X3 — wrapFieldRefsInJsonb overload routing', () => {
  it('cross-table branch passes the field map (Map<...>) to wrapFieldRefsInJsonb', () => {
    const branch = sliceBetween(
      APPLY_BODY,
      'if (okSpec.spec && okSpec.fieldMap)',
      '} else {',
    )
    expect(branch).toMatch(/wrapFieldRefsInJsonb\(\s*cleaned\s*,\s*okSpec\.fieldMap\s*\)/)
  })

  it('same-table branch keeps the string[] overload', () => {
    // Pinned so a future refactor that "unifies" the two paths into a
    // single Map-based call site shows up as a test failure. The
    // string[] signature is BCC for every existing same-table TFM.
    const branch = sliceBetween(APPLY_BODY, '} else {', 'const { data: rowsAffected')
    expect(branch).toMatch(/wrapFieldRefsInJsonb\(\s*cleaned\s*,\s*fieldNames\s*\)/)
  })

  it('cross-table wrap raises a structured error rather than throwing', () => {
    // The helper THROWS `Cross-table transforms must use table-qualified field references.`
    // The action layer must catch and convert to the standard
    // `{ success:false, error }` envelope.
    const branch = sliceBetween(
      APPLY_BODY,
      'if (okSpec.spec && okSpec.fieldMap)',
      '} else {',
    )
    expect(branch).toMatch(/try\s*\{[\s\S]*wrapFieldRefsInJsonb[\s\S]*\}\s*catch/)
    expect(branch).toMatch(/return\s*\{\s*success:\s*false[\s\S]*?error:/)
  })
})

// ─── X4 — Transparency stack is fully retired ────────────────────────────────

describe('[transforms-cross-table-apply] X4 — Phase 4a-3 transparency stack retirement', () => {
  it('TransformWriteErrorCode no longer includes CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED as a union member', () => {
    // The string still appears inside historical-narrative comments;
    // we only forbid it as a TYPE union literal. A UNION member shows
    // up as `| 'CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED'` (with the
    // pipe). We pin the absence of THAT shape.
    expect(TRANSFORMS_SRC).not.toMatch(/\|\s*['"]CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED['"]/)
  })

  it('isCrossTableTfm helper is gone', () => {
    expect(TRANSFORMS_SRC).not.toMatch(/(?:^|\s)function\s+isCrossTableTfm\b/)
    expect(TRANSFORMS_SRC).not.toMatch(/\bisCrossTableTfm\s*\(/)
  })

  it('projectHasCrossTableMappings helper is gone', () => {
    expect(TRANSFORMS_SRC).not.toMatch(/export\s+(async\s+)?function\s+projectHasCrossTableMappings\b/)
    expect(TRANSFORMS_SRC).not.toMatch(/\bprojectHasCrossTableMappings\s*\(/)
  })

  it('applyTransform no longer short-circuits with the legacy code', () => {
    expect(APPLY_BODY).not.toMatch(/CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED/)
  })
})

// ─── X5 — testTransformation mirrors apply routing ───────────────────────────

describe('[transforms-cross-table-apply] X5 — testTransformation routing parity', () => {
  it('testTransformation calls buildJoinSpec for non-VA TFMs', () => {
    expect(TEST_BODY).toMatch(/if\s*\(\s*!isValueAssignment\s*\)\s*\{\s*[\s\S]*?buildJoinSpec\s*\(/)
  })

  it('testTransformation surfaces CROSS_TABLE_FK_INFERENCE_FAILED', () => {
    expect(TEST_BODY).toMatch(/errorCode:\s*crossTableJoinSpec\.errorCode/)
  })

  it('testTransformation uses the cross-table wrap on the cross-table branch', () => {
    expect(TEST_BODY).toMatch(
      /wrapFieldRefsInJsonb\(\s*sql\.trim\(\)\s*,\s*crossTableJoinSpec\.fieldMap\s*\)/,
    )
  })

  it('testTransformation strips aliases before handing off to execute_transform_test', () => {
    // Pinned so a future refactor that switches to a JOIN-aware test
    // RPC removes this stripping intentionally rather than by
    // accident.  The execute_transform_test RPC operates on a single
    // `data_rows` partition and rejects multi-alias references.
    expect(TEST_BODY).toMatch(
      /\.replace\(\s*\/\\b\[A-Za-z_\]\[A-Za-z0-9_\]\*\\\.row_data->>'\/g\s*,\s*"row_data->>'"\s*\)/,
    )
  })
})

// ─── X6 — TransformWriteErrorCode union ──────────────────────────────────────

describe('[transforms-cross-table-apply] X6 — TransformWriteErrorCode union', () => {
  it("includes 'CROSS_TABLE_FK_INFERENCE_FAILED' as a union member", () => {
    expect(TRANSFORMS_SRC).toMatch(/\|\s*'CROSS_TABLE_FK_INFERENCE_FAILED'/)
  })
})
