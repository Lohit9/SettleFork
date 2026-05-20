// @vitest-environment node
//
// PR A2 — "Clear AI reasoning on mapping edit".
//
// When a user edits a mapped row, the AI-generated `ai_reasoning` narrative
// on the TFM describes a source→target pairing that no longer exists. This
// PR clears `ai_reasoning` to null on every user-initiated edit path.
//
// Strategy mirrors `edit-mapping-sources.test.ts` / `mappings-flat-view.test.ts`:
// the write paths touch Supabase auth, the permission check, the maintenance
// gate, and several RPCs that are hostile to mocking — so we read the action
// source files and assert the call-site shape locks the decision in place.
//
// Scope locked here as regression guards:
//
//   A.  updateMappingSourceField — source swap clears TFM.ai_reasoning in
//       the same UPDATE as the status flip. The no-op short-circuit
//       (source unchanged) does NOT clear — an affirmation is not an edit.
//   B.  updateMappingTargetField — plain swap (incl. bare-ack fall-through)
//       clears TFM.ai_reasoning. The no-op short-circuit does NOT clear.
//   C.  editMappingSources clears the TFM-level `ai_reasoning` to null on
//       every drawer source-set edit — superseding the 4a-4b
//       provenance-laundering rule for the column (PR A2 founder-decision
//       override; see edit-mapping-sources.test.ts E20/E21a). The merge-
//       survivor path (mergeTargetFieldMappings → editMappingSources) is
//       cleared for free.
//   D.  Transform-edit actions — updateTransformSQL / autoSaveTransform
//       clear the parent TFM's stale `ai_reasoning` via the shared
//       best-effort helper. saveTransformation (status-only flip) does NOT.
//   E.  approveFieldMapping does NOT clear `ai_reasoning` — a status
//       change leaves mapping content untouched (regression guard).
//
// `confidence` is intentionally NOT cleared (trigger-derived from
// MIN(mapping_sources.confidence), migration 074) — see the PR description.

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
// A — updateMappingSourceField (source swap)
// ─────────────────────────────────────────────────────────────────────

const SRC_FIELD_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function updateMappingSourceField(',
  '// ─── 5.2 updateMappingTargetField',
)

describe('[clear-ai-reasoning] A — updateMappingSourceField', () => {
  it('A1: clears ai_reasoning in the same TFM UPDATE as the status flip', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,160}status:\s*['"]approved['"],\s*ai_reasoning:\s*null/,
    )
  })

  it('A2: the no-op short-circuit (source unchanged) does NOT clear ai_reasoning', () => {
    const noop = sliceBetween(
      SRC_FIELD_BODY,
      'currentSourceFieldId === newSourceFieldId',
      'Step 10',
    )
    expect(noop).not.toMatch(/ai_reasoning/)
  })

  it('A3: does NOT clear confidence — left to the MIN-of-sources trigger', () => {
    const allTfmUpdates = [
      ...SRC_FIELD_BODY.matchAll(
        /from\(['"]target_field_mappings['"]\)\s*\.update\(\{([\s\S]{0,300})\}\)/g,
      ),
    ]
    for (const m of allTfmUpdates) expect(m[1]).not.toMatch(/confidence:/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// B — updateMappingTargetField (target swap)
// ─────────────────────────────────────────────────────────────────────

const TGT_FIELD_PROPER = sliceBetween(
  REDESIGN_SRC,
  'export async function updateMappingTargetField(',
  'async function getTfmSourceFieldRefs(',
)
const MERGE_BODY = sliceBetween(
  REDESIGN_SRC,
  'async function mergeTargetFieldMappings(',
  '// ─── 5.3 createMappingFromUnmapped',
)

describe('[clear-ai-reasoning] B — updateMappingTargetField', () => {
  it('B1: plain swap clears ai_reasoning in the same UPDATE as the target swap', () => {
    expect(TGT_FIELD_PROPER).toMatch(
      /\.update\(\{[\s\S]{0,200}target_field_id:\s*newTargetFieldId,\s*status:\s*['"]approved['"],\s*ai_reasoning:\s*null/,
    )
  })

  it('B2: the no-op short-circuit (target unchanged) does NOT clear ai_reasoning', () => {
    const noop = sliceBetween(
      TGT_FIELD_PROPER,
      'tfm.target_field_id === newTargetFieldId',
      'Step 9',
    )
    expect(noop).not.toMatch(/ai_reasoning/)
  })

})

// ─────────────────────────────────────────────────────────────────────
// C — editMappingSources left untouched (deferral guard)
// ─────────────────────────────────────────────────────────────────────

const EDIT_SOURCES_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function editMappingSources(',
  'export async function updateMappingCombination(',
)

describe('[clear-ai-reasoning] C — editMappingSources + merge survivor', () => {
  it('C1: editMappingSources clears the TFM-level ai_reasoning to null on every edit', () => {
    // PR A2 override of the 4a-4b provenance-laundering rule — see
    // edit-mapping-sources.test.ts E20/E21a and the PR description.
    expect(EDIT_SOURCES_BODY).toMatch(/ai_reasoning:\s*null/)
    expect(EDIT_SOURCES_BODY).not.toMatch(/newTfmAiReasoning/)
  })

  it('C2: the merge survivor is cleared for free — mergeTargetFieldMappings routes through editMappingSources', () => {
    // The survivor gains the folded sources via editMappingSources, so its
    // ai_reasoning is cleared by C1. The merge executor adds no separate
    // ai_reasoning write of its own.
    expect(MERGE_BODY).toMatch(/editMappingSources\(/)
    expect(MERGE_BODY).not.toMatch(/ai_reasoning/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D — transform-edit actions
// ─────────────────────────────────────────────────────────────────────

const HELPER_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'async function clearStaleAiReasoningForTransformEdit(',
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

describe('[clear-ai-reasoning] D — transform-edit actions', () => {
  it('D1: the shared helper guards on non-null, clears the column, and is best-effort', () => {
    // Non-null guard — a debounced re-save neither re-writes nor re-audits.
    expect(HELPER_BODY).toMatch(
      /args\.currentReasoning\s*===\s*null[\s\S]{0,20}return/,
    )
    // Clears the TFM-level narrative.
    expect(HELPER_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.update\(\{\s*ai_reasoning:\s*null/,
    )
    // Best-effort: a clear failure is logged, never surfaced as a failure
    // (the caller's primary SQL write has already committed).
    expect(HELPER_BODY).toMatch(/console\.warn/)
    expect(HELPER_BODY).not.toMatch(/success:\s*false/)
    // Provenance entry targets the TFM, field `ai_reasoning`.
    expect(HELPER_BODY).toMatch(/entityType:\s*['"]target_field_mapping['"]/)
    expect(HELPER_BODY).toMatch(/fieldPath:\s*['"]ai_reasoning['"]/)
  })

  it('D2: updateTransformSQL reads ai_reasoning and invokes the clear helper', () => {
    expect(TX_SQL_BODY).toMatch(/select\(['"]project_id,\s*ai_reasoning['"]\)/)
    expect(TX_SQL_BODY).toMatch(/clearStaleAiReasoningForTransformEdit\(\{/)
  })

  it('D3: autoSaveTransform reads ai_reasoning and invokes the clear helper', () => {
    expect(AUTO_SAVE_BODY).toMatch(/select\(['"]project_id,\s*ai_reasoning['"]\)/)
    expect(AUTO_SAVE_BODY).toMatch(/clearStaleAiReasoningForTransformEdit\(\{/)
  })

  it('D4: saveTransformation (status-only flip) does NOT clear ai_reasoning', () => {
    // Structurally identical to approveFieldMapping — the user accepts the
    // existing value; mapping/transform content is untouched.
    expect(SAVE_BODY).not.toMatch(/ai_reasoning/)
    expect(SAVE_BODY).not.toMatch(/clearStaleAiReasoningForTransformEdit/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E — approveFieldMapping unaffected (regression guard)
// ─────────────────────────────────────────────────────────────────────

const APPROVE_BODY = sliceBetween(
  REDESIGN_SRC,
  'export async function approveFieldMapping(',
  'export async function rejectFieldMapping(',
)

describe('[clear-ai-reasoning] E — approveFieldMapping (regression)', () => {
  it('E1: approve is a status change only — it does NOT clear ai_reasoning', () => {
    expect(APPROVE_BODY).not.toMatch(/ai_reasoning/)
  })
})
