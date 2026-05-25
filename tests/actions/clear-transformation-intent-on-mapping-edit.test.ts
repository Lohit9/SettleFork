// @vitest-environment node
//
// "Clear transformation_intent on all user mapping edits".
//
// Locked product model: a user edit clears the AI commentary on the TFM.
// `target_field_mappings.transformation_intent` is the Path D mapping-pass
// recipe (migration 093) — free-form AI prose describing the AI's intended
// transformation for the original pairing. Once the user edits the mapping
// (source/target swap, source-set edit) or hand-edits the transform SQL, that
// recipe no longer describes the live mapping, so every edit path clears it.
// Approve does NOT clear (it preserves AI commentary as documentation of
// endorsed work) — same locked decision as `ai_reasoning` (PR A2) and
// `confidence`.
//
// Unlike `ai_reasoning` (frozen in `original_ai_reasoning`, migration 083)
// there is no `original_transformation_intent` column — the clear is
// destructive of the mapping-phase recipe by design (investigation found no
// provenance-preservation use case; see
// notes/clear-transformation-prose-on-edit-investigation.md).
//
// Strategy mirrors clear-ai-reasoning-on-mapping-edit.test.ts /
// clear-confidence-on-mapping-edit.test.ts: the write paths touch Supabase
// auth, the permission check, the maintenance gate, and several RPCs hostile
// to mocking — so we read the action source files and assert the call-site
// shape locks the decision in place.
//
// Scope locked here as regression guards:
//   A.  Source swap (updateMappingSourceField) — clears transformation_intent
//       in the same UPDATE as the status flip. No-op short-circuit does NOT.
//   B.  Target swap (updateMappingTargetField, plain + bare-ack) — clears.
//       No-op short-circuit does NOT.
//   C.  Target swap merge case (mergeTargetFieldMappings) — survivor cleared
//       via editMappingSources; the merge executor adds no separate write.
//   D.  editMappingSources — clears in the Step-13 TFM update.
//   E.  updateTransformSQL — clears via clearStaleAiMetadataForTransformEdit.
//   F.  autoSaveTransform — clears via the same helper.
//   G.  saveTransformation — does NOT clear (status-only flip).
//   H.  approveFieldMapping — does NOT clear (locked: approve preserves AI
//       commentary).
//   I.  bulkApproveFieldMappingsForTargetTable — does NOT clear.
//   J.  The shared transform-edit helper — guarded clear + best-effort.

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
// J — shared transform-edit helper
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] J — clearStaleAiMetadataForTransformEdit', () => {
  it('J1: accepts currentTransformationIntent and clears the TFM column under a non-null guard', () => {
    // The arg is threaded so the guard can short-circuit a debounced re-save
    // (mirrors the currentReasoning guard).
    expect(TX_HELPER_BODY).toMatch(/currentTransformationIntent:\s*string\s*\|\s*null/)
    expect(TX_HELPER_BODY).toMatch(
      /args\.currentTransformationIntent\s*!==\s*null/,
    )
    expect(TX_HELPER_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{\s*transformation_intent:\s*null/,
    )
  })

  it('J2: the clear is best-effort and emits a transformation_intent provenance entry', () => {
    expect(TX_HELPER_BODY).toMatch(/console\.warn/)
    expect(TX_HELPER_BODY).not.toMatch(/success:\s*false/)
    expect(TX_HELPER_BODY).toMatch(/fieldPath:\s*['"]transformation_intent['"]/)
    expect(TX_HELPER_BODY).toMatch(/entityType:\s*['"]target_field_mapping['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// A — source swap
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] A — updateMappingSourceField', () => {
  it('A1: clears transformation_intent in the same TFM UPDATE as the status flip', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,200}status:\s*['"]approved['"],\s*ai_reasoning:\s*null,\s*transformation_intent:\s*null/,
    )
  })

  it('A2: the no-op short-circuit (source unchanged) does NOT clear transformation_intent', () => {
    // Affirmation is not an edit — the heritage no-op path must stay inert.
    const noop = sliceBetween(
      SRC_FIELD_BODY,
      'currentSourceFieldId === newSourceFieldId',
      'Step 10',
    )
    expect(noop).not.toMatch(/transformation_intent/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B — target swap (non-merge)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] B — updateMappingTargetField (plain swap)', () => {
  it('B1: plain swap clears transformation_intent in the same UPDATE as the target swap', () => {
    expect(TGT_FIELD_BODY).toMatch(
      /\.update\(\{[\s\S]{0,200}target_field_id:\s*newTargetFieldId,\s*status:\s*['"]approved['"],\s*ai_reasoning:\s*null,\s*transformation_intent:\s*null/,
    )
  })

  it('B2: the no-op short-circuit (target unchanged) does NOT clear transformation_intent', () => {
    const noop = sliceBetween(
      TGT_FIELD_BODY,
      'tfm.target_field_id === newTargetFieldId',
      'Step 9',
    )
    expect(noop).not.toMatch(/transformation_intent/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// C — target swap merge case
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] C — mergeTargetFieldMappings survivor', () => {
  it('C1: merge folds sources via editMappingSources, so the survivor is cleared for free', () => {
    // The survivor gains the folded sources through editMappingSources,
    // which clears transformation_intent (D1). The merge executor adds no
    // separate transformation_intent write of its own.
    expect(MERGE_BODY).toMatch(/editMappingSources\(/)
    expect(MERGE_BODY).not.toMatch(/transformation_intent/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D — editMappingSources
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] D — editMappingSources', () => {
  it('D1: the Step-13 TFM update writes transformation_intent: null', () => {
    expect(EDIT_SOURCES_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,260}transformation_intent:\s*null/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E / F — transform-edit actions
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] E/F — transform-edit actions', () => {
  it('E1: updateTransformSQL reads transformation_intent and passes it to the clear helper', () => {
    expect(TX_SQL_BODY).toMatch(
      /select\(['"]project_id,\s*ai_reasoning,\s*transformation_intent,\s*combination_type['"]\)/,
    )
    expect(TX_SQL_BODY).toMatch(
      /clearStaleAiMetadataForTransformEdit\(\{[\s\S]{0,260}currentTransformationIntent:\s*tfmRow\.transformation_intent/,
    )
  })

  it('F1: autoSaveTransform reads transformation_intent and passes it to the clear helper', () => {
    expect(AUTO_SAVE_BODY).toMatch(
      /select\(['"]project_id,\s*ai_reasoning,\s*transformation_intent,\s*combination_type['"]\)/,
    )
    expect(AUTO_SAVE_BODY).toMatch(
      /clearStaleAiMetadataForTransformEdit\(\{[\s\S]{0,260}currentTransformationIntent:\s*tfmRow\.transformation_intent/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// G — saveTransformation excluded (status-only flip)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] G — saveTransformation (regression)', () => {
  it('G1: saveTransformation does NOT clear transformation_intent — status-only flip', () => {
    expect(SAVE_BODY).not.toMatch(/clearStaleAiMetadataForTransformEdit/)
    expect(SAVE_BODY).not.toMatch(/transformation_intent/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// H / I — approve paths unaffected (locked product decision)
// ─────────────────────────────────────────────────────────────────────

describe('[clear-transformation-intent] H/I — approve paths (regression guards)', () => {
  it('H1: approveFieldMapping does NOT clear transformation_intent — approve preserves AI commentary', () => {
    expect(APPROVE_BODY).not.toMatch(/transformation_intent/)
  })

  it('I1: bulkApproveFieldMappingsForTargetTable does NOT clear transformation_intent', () => {
    expect(BULK_APPROVE_BODY).not.toMatch(/transformation_intent/)
  })
})
