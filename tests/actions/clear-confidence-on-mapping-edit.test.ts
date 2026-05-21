// @vitest-environment node
//
// "Clear confidence on all user mapping edits".
//
// Locked product model: a user edit clears both `ai_reasoning` AND
// `confidence`. An AI confidence number ("92%") describes the AI's confidence
// in its original proposal, not the user's edited version — so every edit
// path clears it. Approve does NOT clear (it preserves AI commentary as
// documentation of endorsed work).
//
// `target_field_mappings.confidence` is trigger-derived from
// MIN(mapping_sources.confidence) (migration 074) for non-custom_sql,
// non-acknowledged TFMs. The implementation works WITH the trigger:
//   • mapped TFMs   → null every mapping_sources row; the trigger recomputes
//                     TFM.confidence = MIN(all-null) = null.
//   • custom_sql VA → the trigger skips it; write target_field_mappings
//                     .confidence = null directly.
//
// Strategy mirrors clear-ai-reasoning-on-mapping-edit.test.ts: the write
// paths touch Supabase auth, the permission check, the maintenance gate, and
// several RPCs hostile to mocking — so we read the action source files and
// assert the call-site shape locks the decision in place.
//
// Scope locked here as regression guards:
//   A.  Source swap (updateMappingSourceField) — clears confidence.
//   B.  Target swap (updateMappingTargetField, non-merge) — clears confidence.
//   C.  Target swap merge case (mergeTargetFieldMappings) — survivor cleared
//       via editMappingSources.
//   D.  editMappingSources — clears confidence deterministically regardless
//       of source composition.
//   E.  updateTransformSQL — clears confidence.
//   F.  autoSaveTransform — clears confidence.
//   G.  saveTransformation — does NOT clear confidence (status-only flip).
//   H.  approveFieldMapping — does NOT clear confidence (locked product
//       decision: approve preserves AI commentary).
//   I.  bulkApproveFieldMappingsForTargetTable — does NOT clear confidence.
//   J.  The branch-by-combination_type helpers.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REDESIGN_SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/mappings-for-redesign.ts'),
  'utf8',
)
const TRANSFORMS_SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/transformations.ts'),
  'utf8',
)

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// Sliced action bodies
// ─────────────────────────────────────────────────────────────────────

const CONFIDENCE_HELPER = sliceBetween(
  REDESIGN_SRC,
  'async function clearMappingConfidenceForEdit(',
  '// ─── 5.1 updateMappingSourceField',
)
const SRC_FIELD_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function updateMappingSourceField(',
  '// ─── 5.2 updateMappingTargetField',
)
const TGT_FIELD_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function updateMappingTargetField(',
  'async function getTfmSourceFieldRefs(',
)
const MERGE_BODY = sliceBetween(
  REDESIGN_SRC,
  'async function mergeTargetFieldMappings(',
  '// ─── 5.3 createMappingFromUnmapped',
)
const EDIT_SOURCES_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function editMappingSources(',
  'export async function updateMappingCombination(',
)
const APPROVE_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function approveFieldMapping(',
  'export async function rejectFieldMapping(',
)
const BULK_APPROVE_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function bulkApproveFieldMappingsForTargetTable(',
  'export async function approveHighConfidenceMappings(',
)

const TX_HELPER_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'async function clearStaleAiMetadataForTransformEdit(',
  '// ─── updateTransformSQL',
)
const TX_SQL_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function updateTransformSQL(',
  'export async function ensureValueAssignment(',
)
const AUTO_SAVE_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function autoSaveTransform(',
  'export async function runFullTransformTest(',
)
const SAVE_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function saveTransformation(',
  'export async function autoGenerateAllTransforms(',
)

// ─────────────────────────────────────────────────────────────────────
// J — branch-by-combination_type helpers
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] J — helpers branch by combination_type', () => {
  it('J1: clearMappingConfidenceForEdit — custom_sql writes TFM.confidence directly, else nulls mapping_sources', () => {
    // custom_sql (value assignment) branch — trigger skips it; direct write.
    expect(CONFIDENCE_HELPER).toMatch(
      /combinationType\s*===\s*['"]custom_sql['"]/,
    )
    expect(CONFIDENCE_HELPER).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{\s*confidence:\s*null/,
    )
    // mapped branch — null every mapping_sources row, let the trigger recompute.
    expect(CONFIDENCE_HELPER).toMatch(
      /from\(['"]mapping_sources['"]\)\s*\.update\(\{\s*confidence:\s*null\s*\}\)\s*\.eq\(['"]target_field_mapping_id['"]/,
    )
  })

  it('J2: clearStaleAiMetadataForTransformEdit branches the same way', () => {
    expect(TX_HELPER_BODY).toMatch(
      /combinationType\s*===\s*['"]custom_sql['"]/,
    )
    expect(TX_HELPER_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{\s*confidence:\s*null/,
    )
    expect(TX_HELPER_BODY).toMatch(
      /from\(['"]mapping_sources['"]\)\s*\.update\(\{\s*confidence:\s*null\s*\}\)\s*\.eq\(['"]target_field_mapping_id['"]/,
    )
    // Best-effort: failures are logged, never surfaced as action failures.
    expect(TX_HELPER_BODY).toMatch(/console\.warn/)
    expect(TX_HELPER_BODY).not.toMatch(/success:\s*false/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// A — source swap
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] A — updateMappingSourceField', () => {
  it('A1: the swapped mapping_sources row is written with confidence: null', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /source_field_id:\s*newSourceFieldId,[\s\S]{0,160}confidence:\s*null/,
    )
  })

  it('A2: the legacy "100" / FLAT_VIEW_USER_CONFIDENCE confidence write is gone', () => {
    expect(SRC_FIELD_BODY).not.toMatch(/confidence:\s*newConfidence/)
    expect(SRC_FIELD_BODY).not.toMatch(/FLAT_VIEW_USER_CONFIDENCE/)
    // The now-meaningless `newConfidence` input parameter is removed.
    expect(SRC_FIELD_BODY).not.toMatch(/newConfidence/)
  })

  it('A3: invokes clearMappingConfidenceForEdit so multi-source TFMs clear deterministically', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /clearMappingConfidenceForEdit\(\s*tfm\.id,\s*tfm\.combination_type/,
    )
  })

  it('A4: the no-op short-circuit (source unchanged) does NOT clear confidence', () => {
    const noop = sliceBetween(
      SRC_FIELD_BODY,
      'currentSourceFieldId === newSourceFieldId',
      'Step 10',
    )
    expect(noop).not.toMatch(/confidence/)
    expect(noop).not.toMatch(/clearMappingConfidenceForEdit/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B — target swap (non-merge)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] B — updateMappingTargetField (plain swap)', () => {
  it('B1: plain swap invokes clearMappingConfidenceForEdit after the TFM update', () => {
    expect(TGT_FIELD_BODY).toMatch(
      /clearMappingConfidenceForEdit\(\s*tfm\.id,\s*tfm\.combination_type/,
    )
  })

  it('B2: the no-op short-circuit (target unchanged) does NOT clear confidence', () => {
    const noop = sliceBetween(
      TGT_FIELD_BODY,
      'tfm.target_field_id === newTargetFieldId',
      'Step 9',
    )
    expect(noop).not.toMatch(/clearMappingConfidenceForEdit/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// C — target swap merge case
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] C — mergeTargetFieldMappings survivor', () => {
  it('C1: merge folds sources via editMappingSources, so the survivor is cleared for free', () => {
    // The survivor gains the folded sources through editMappingSources,
    // which clears confidence (D1/D2). The merge executor adds no separate
    // confidence write of its own.
    expect(MERGE_BODY).toMatch(/editMappingSources\(/)
    expect(MERGE_BODY).not.toMatch(/confidence:\s*null/)
    expect(MERGE_BODY).not.toMatch(/clearMappingConfidenceForEdit/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D — editMappingSources
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] D — editMappingSources', () => {
  it('D1: every replacement mapping_sources row is written with confidence: null', () => {
    expect(EDIT_SOURCES_BODY).toMatch(/confidence:\s*null\s+as\s+number\s*\|\s*null/)
    // The legacy hardcoded 100 is gone.
    expect(EDIT_SOURCES_BODY).not.toMatch(/confidence:\s*100/)
  })

  it('D2: the Step-13 TFM update also writes confidence: null (covers VA→mapped conversion)', () => {
    // For a normal mapped→mapped edit the trigger handles it; the direct
    // write additionally covers the custom_sql→single conversion, where the
    // trigger skips the TFM during the source-replacement RPC.
    expect(EDIT_SOURCES_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,200}confidence:\s*null/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E / F — transform-edit actions
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] E/F — transform-edit actions', () => {
  it('E1: updateTransformSQL reads combination_type and passes it to the clear helper', () => {
    expect(TX_SQL_BODY).toMatch(
      /select\(['"]project_id,\s*ai_reasoning,\s*combination_type['"]\)/,
    )
    expect(TX_SQL_BODY).toMatch(
      /clearStaleAiMetadataForTransformEdit\(\{[\s\S]{0,200}combinationType:\s*tfmRow\.combination_type/,
    )
  })

  it('F1: autoSaveTransform reads combination_type and passes it to the clear helper', () => {
    expect(AUTO_SAVE_BODY).toMatch(
      /select\(['"]project_id,\s*ai_reasoning,\s*combination_type['"]\)/,
    )
    expect(AUTO_SAVE_BODY).toMatch(
      /clearStaleAiMetadataForTransformEdit\(\{[\s\S]{0,200}combinationType:\s*tfmRow\.combination_type/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// G — saveTransformation excluded (status-only flip)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] G — saveTransformation (regression)', () => {
  it('G1: saveTransformation does NOT clear confidence — status-only flip', () => {
    expect(SAVE_BODY).not.toMatch(/clearStaleAiMetadataForTransformEdit/)
    expect(SAVE_BODY).not.toMatch(/confidence:\s*null/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// H / I — approve paths unaffected (locked product decision)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-confidence] H/I — approve paths (regression guards)', () => {
  it('H1: approveFieldMapping does NOT clear confidence — approve preserves AI commentary', () => {
    expect(APPROVE_BODY).not.toMatch(/clearMappingConfidenceForEdit/)
    expect(APPROVE_BODY).not.toMatch(/confidence:\s*null/)
    expect(APPROVE_BODY).not.toMatch(
      /from\(['"]mapping_sources['"]\)\s*\.update/,
    )
  })

  it('I1: bulkApproveFieldMappingsForTargetTable does NOT clear confidence', () => {
    expect(BULK_APPROVE_BODY).not.toMatch(/clearMappingConfidenceForEdit/)
    expect(BULK_APPROVE_BODY).not.toMatch(/confidence:\s*null/)
    // Approve is a TFM-status-only write — it never touches mapping_sources.
    expect(BULK_APPROVE_BODY).not.toMatch(
      /from\(['"]mapping_sources['"]\)\s*\.update/,
    )
  })
})
