// @vitest-environment node
//
// Flat (spreadsheet) Mapping view — regression guards for the 4 new
// server actions in `lib/actions/mappings-for-redesign.ts`:
//
//   - updateMappingSourceField   (5.1)
//   - updateMappingTargetField   (5.2)
//   - createMappingFromUnmapped  (5.3)
//   - setUnmappedRowRejected     (5.4)
//
// Strategy mirrors `edit-mapping-sources.test.ts`: read the action
// source file and assert call-site shape locks the founder-locked
// decisions in place (Q1-Q6, see
// notes/spreadsheet-view-server-investigation.md §11).
//
// Open-question resolutions captured here as regression guards:
//
//   Q1  Confidence: post clear-confidence PR the edited source's
//       confidence is cleared to null (a user edit clears confidence);
//       TFM-aggregate left to the MIN trigger. We assert the confidence
//       write hits `mapping_sources`, never a TFM-wide override.
//   Q2  Status revert on contributor reject: existing rejectFieldMapping
//       behavior preserved (this test file does NOT touch that path —
//       its invariants are already locked by `edit-mapping-sources` and
//       `mappings-for-redesign-phase-4a-actions`).
//   Q3  createMappingFromUnmapped DELETEs the source_field_acknowledgments
//       row when present.
//   Q4  Activity log: reuse mapping_sources_changed + mapping_approved
//       (with metadata.surface='flat_view'). Single new action_type:
//       source_field_rejected.
//   Q5  TARGET_CONFLICT on VA-at-new-target — refuse, do not auto-delete.
//   Q6  B's UI uses the existing shim id format.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(
  __dirname,
  '../../lib/actions/mappings-for-redesign.ts',
)
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

const ACTIVITY_LOG_PATH = resolve(
  __dirname,
  '../../lib/actions/activity-log.ts',
)
const ACTIVITY_LOG_SRC = readFileSync(ACTIVITY_LOG_PATH, 'utf8')

const MIGRATION_PATH = resolve(
  __dirname,
  '../../supabase/migrations/103_source_field_rejection.sql',
)
const MIGRATION_SRC = readFileSync(MIGRATION_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// Migration 103 — schema shape
// ─────────────────────────────────────────────────────────────────────

describe('[flat-view] migration 103', () => {
  it('adds a `decision` column on source_field_acknowledgments with the expected CHECK constraint', () => {
    expect(MIGRATION_SRC).toMatch(/ALTER TABLE public\.source_field_acknowledgments/)
    expect(MIGRATION_SRC).toMatch(
      /ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'acknowledged'/,
    )
    expect(MIGRATION_SRC).toMatch(
      /CHECK \(decision IN \('acknowledged', 'rejected'\)\)/,
    )
  })

  it('relaxes the reason NOT NULL constraint so flat-view rejection can omit it', () => {
    expect(MIGRATION_SRC).toMatch(/ALTER COLUMN reason DROP NOT NULL/)
    expect(MIGRATION_SRC).toMatch(/ALTER COLUMN reason SET DEFAULT ''/)
  })

  it('creates a (project_id, decision) index for flat-view filtering', () => {
    expect(MIGRATION_SRC).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_source_field_acknowledgments_decision[\s\S]+ON public\.source_field_acknowledgments \(project_id, decision\)/,
    )
  })

  it('documents the sticky-rollback caveat in the header comment', () => {
    expect(MIGRATION_SRC).toMatch(/Rollback requires/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// activity-log.ts — new action_type
// ─────────────────────────────────────────────────────────────────────

describe('[flat-view] activity-log action_type', () => {
  it("adds 'source_field_rejected' to the ActionType union", () => {
    expect(ACTIVITY_LOG_SRC).toMatch(/'source_field_rejected'/)
  })

  it('does NOT introduce other flat-view-only action_types (Q4 — reuse existing)', () => {
    expect(ACTIVITY_LOG_SRC).not.toMatch(/'mapping_inline_edited'/)
    expect(ACTIVITY_LOG_SRC).not.toMatch(/'mapping_target_changed'/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5.1 updateMappingSourceField
// ─────────────────────────────────────────────────────────────────────

const SRC_FIELD_BODY = sliceBetween(
  SRC,
  'export async function updateMappingSourceField(',
  '// ─── 5.2 updateMappingTargetField',
)

describe('[flat-view] updateMappingSourceField — shape', () => {
  it('exports updateMappingSourceField as an async function with the documented input', () => {
    expect(SRC).toMatch(/export async function updateMappingSourceField\(input: \{/)
    expect(SRC_FIELD_BODY).toMatch(/rowId:\s*string/)
    expect(SRC_FIELD_BODY).toMatch(/newSourceFieldId:\s*string/)
    // `newConfidence` was removed by the clear-confidence PR: a user edit
    // clears confidence (→ null) rather than recording a user-supplied
    // number, so the parameter is no longer meaningful.
    expect(SRC_FIELD_BODY).not.toMatch(/newConfidence/)
  })

  it('returns a discriminated union with tfmId / mappingSourceId / transformReset / stagedRowsReverted', () => {
    const union = sliceBetween(
      SRC,
      'export type UpdateMappingSourceFieldResult',
      'export async function updateMappingSourceField',
    )
    expect(union).toMatch(/tfmId:\s*string/)
    expect(union).toMatch(/mappingSourceId:\s*string/)
    expect(union).toMatch(/transformReset:\s*boolean/)
    expect(union).toMatch(/stagedRowsReverted:\s*number/)
    expect(union).toMatch(/errorCode:\s*UpdateSourceFieldErrorCode/)
  })

  it('UpdateSourceFieldErrorCode exposes the 6 expected codes including DUPLICATE_SOURCE', () => {
    const union = sliceBetween(
      SRC,
      'export type UpdateSourceFieldErrorCode',
      'export type UpdateMappingSourceFieldResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'DUPLICATE_SOURCE'")
    expect(union).toContain("'INTERNAL'")
  })
})

describe('[flat-view] updateMappingSourceField — input validation + decode', () => {
  it('rejects empty rowId with VALIDATION', () => {
    expect(SRC_FIELD_BODY).toMatch(/!rowId[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/)
  })

  it('rejects empty newSourceFieldId with VALIDATION', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /!newSourceFieldId[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it('decodes the shim id and rejects non-TFM kinds with NOT_FOUND', () => {
    expect(SRC_FIELD_BODY).toMatch(/decodeShimmedRowId\(\s*rowId\s*\)/)
    expect(SRC_FIELD_BODY).toMatch(
      /decoded\.kind\s*!==\s*['"]tfm-primary['"]\s*&&\s*decoded\.kind\s*!==\s*['"]tfm-contributor['"]/,
    )
  })
})

describe('[flat-view] updateMappingSourceField — auth + permission + guards', () => {
  it('checks Supabase auth and returns PERMISSION_DENIED on missing user', () => {
    expect(SRC_FIELD_BODY).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(SRC_FIELD_BODY).toMatch(
      /if\s*\(\s*!user\s*\)[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })

  it('reads the TFM identity and returns NOT_FOUND when missing', () => {
    expect(SRC_FIELD_BODY).toMatch(/from\(['"]target_field_mappings['"]\)/)
    expect(SRC_FIELD_BODY).toMatch(
      /if\s*\(\s*!tfm\s*\)[\s\S]{0,400}errorCode:\s*['"]NOT_FOUND['"]/,
    )
  })

  it('enforces editor permission via requireProjectPermission(projectId, "editor")', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
  })

  it('refuses acknowledged TFMs with VALIDATION', () => {
    expect(SRC_FIELD_BODY).toMatch(/tfm\.is_acknowledged/)
    expect(SRC_FIELD_BODY).toMatch(
      /is_acknowledged[\s\S]{0,400}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it('refuses status=rejected TFMs with VALIDATION', () => {
    expect(SRC_FIELD_BODY).toMatch(/tfm\.status\s*===\s*['"]rejected['"]/)
  })

  it('runs assertMappingWritesEnabled and surfaces MAINTENANCE_MODE', () => {
    expect(SRC_FIELD_BODY).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    expect(SRC_FIELD_BODY).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })
})

describe('[flat-view] updateMappingSourceField — source identity + duplicate guard', () => {
  it('reads the new source field with table+dataset join for project ownership', () => {
    expect(SRC_FIELD_BODY).toMatch(/from\(['"]fields['"]\)/)
    expect(SRC_FIELD_BODY).toMatch(
      /tables!inner\(datasets!inner\(project_id\)\)/,
    )
  })

  it('refuses source fields from a different project with VALIDATION', () => {
    expect(SRC_FIELD_BODY).toMatch(/ndDatasets|nsDatasets\?\.project_id\s*!==\s*projectId/)
  })

  it('checks for an existing mapping_source on this TFM with the same source_field_id → DUPLICATE_SOURCE', () => {
    expect(SRC_FIELD_BODY).toMatch(/DUPLICATE_SOURCE/)
    expect(SRC_FIELD_BODY).toMatch(/from\(['"]mapping_sources['"]\)[\s\S]{0,400}eq\(\s*['"]source_field_id['"],\s*newSourceFieldId\s*\)/)
  })
})

describe('[flat-view] updateMappingSourceField — write semantics (Q1)', () => {
  it('resolves the mapping_source row via ordinal=0 for tfm-primary, by decoded id for tfm-contributor', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /decoded\.kind\s*===\s*['"]tfm-primary['"][\s\S]{0,800}eq\(\s*['"]ordinal['"],\s*0\s*\)/,
    )
    expect(SRC_FIELD_BODY).toMatch(/decoded\.mappingSourceId/)
  })

  it('resets the field transformation BEFORE the source update (source change invalidates SQL)', () => {
    expect(SRC_FIELD_BODY).toMatch(/resetFieldTransform\(\s*tfm\.id\s*\)/)
  })

  it('Q1: UPDATE writes confidence to the edited mapping_source row, NOT a TFM-wide override', () => {
    // Post clear-confidence PR: the edited mapping_source row is written
    // with `confidence: null` (a user edit clears confidence). The write
    // still hits `mapping_sources`, never a direct TFM-wide override —
    // TFM.confidence is recomputed by the MIN-of-sources trigger.
    expect(SRC_FIELD_BODY).toMatch(
      /from\(['"]mapping_sources['"]\)[\s\S]{0,800}\.update\(\{[\s\S]{0,800}confidence:\s*null/,
    )
    // And the TFM update does NOT write confidence — only status + updated_at.
    const tfmUpdateMatch = SRC_FIELD_BODY.match(
      /from\(['"]target_field_mappings['"]\)[\s\S]{0,800}\.update\(\{([\s\S]{0,400})\}\)\s*\.eq\(\s*['"]id['"],\s*tfm\.id\s*\)/,
    )
    expect(tfmUpdateMatch).toBeTruthy()
    // The match groups every TFM update body in the function; assert none
    // includes 'confidence:'.
    const allTfmUpdates = [
      ...SRC_FIELD_BODY.matchAll(
        /from\(['"]target_field_mappings['"]\)[\s\S]{0,200}\.update\(\{([\s\S]{0,300})\}\)/g,
      ),
    ]
    for (const m of allTfmUpdates) {
      expect(m[1]).not.toMatch(/confidence:/)
    }
  })

  it('flips TFM.status to "approved" (flat-view affirmation cascade)', () => {
    expect(SRC_FIELD_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)[\s\S]{0,200}\.update\(\{[\s\S]{0,200}status:\s*['"]approved['"]/,
    )
  })

  it('has a no-op short-circuit: source unchanged still flips status to approved, skips writes', () => {
    expect(SRC_FIELD_BODY).toMatch(/currentSourceFieldId\s*===\s*newSourceFieldId/)
  })
})

describe('[flat-view] updateMappingSourceField — recompute + revalidate + log', () => {
  it('fans out recomputeTableMappingStatus across new + previous source tables', () => {
    expect(SRC_FIELD_BODY).toMatch(/recomputeTableMappingStatus\(supabase,/)
    expect(SRC_FIELD_BODY).toMatch(/findOrCreateTableMapping\(/)
  })

  it('revalidates /mapping AND /transform AND /app/projects', () => {
    expect(SRC_FIELD_BODY).toMatch(/revalidatePath\(`\/app\/projects\/\$\{projectId\}\/mapping`\)/)
    expect(SRC_FIELD_BODY).toMatch(/revalidatePath\(`\/app\/projects\/\$\{projectId\}\/transform`\)/)
    expect(SRC_FIELD_BODY).toMatch(/revalidatePath\(['"]\/app\/projects['"]\)/)
  })

  it('emits mapping_sources_changed + mapping_approved with surface=flat_view metadata (Q4)', () => {
    expect(SRC_FIELD_BODY).toMatch(/logActivity\([\s\S]{0,80}['"]mapping_sources_changed['"]/)
    expect(SRC_FIELD_BODY).toMatch(/logActivity\([\s\S]{0,80}['"]mapping_approved['"]/)
    expect(SRC_FIELD_BODY).toMatch(/surface:\s*['"]flat_view['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5.2 updateMappingTargetField
// ─────────────────────────────────────────────────────────────────────

const TGT_FIELD_BODY = sliceBetween(
  SRC,
  'export async function updateMappingTargetField(',
  '// ─── 5.3 createMappingFromUnmapped',
)

describe('[flat-view] updateMappingTargetField — shape', () => {
  it('exports updateMappingTargetField with the documented input', () => {
    expect(SRC).toMatch(/export async function updateMappingTargetField\(input: \{/)
    expect(TGT_FIELD_BODY).toMatch(/tfmId:\s*string/)
    expect(TGT_FIELD_BODY).toMatch(/newTargetFieldId:\s*string/)
  })

  it('UpdateTargetFieldErrorCode is the hard-error set — no TARGET_CONFLICT (swap now merges)', () => {
    const union = sliceBetween(
      SRC,
      'export type UpdateTargetFieldErrorCode',
      'export interface TargetMergePreview',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
    // Swap-into-occupied-target is a MERGE, not a hard error — the old
    // TARGET_CONFLICT refuse-and-reject behaviour is gone.
    expect(union).not.toContain("'TARGET_CONFLICT'")
  })

  it('UpdateMappingTargetFieldResult carries a MERGE_REQUIRED member with a merge preview', () => {
    const resultType = sliceBetween(
      SRC,
      'export type UpdateMappingTargetFieldResult',
      'export async function updateMappingTargetField(',
    )
    expect(resultType).toContain("errorCode: 'MERGE_REQUIRED'")
    expect(resultType).toContain('merge: TargetMergePreview')
    // The success member exposes `merged` so callers can tell a plain
    // swap from a conflict-resolving merge.
    expect(resultType).toMatch(/merged:\s*boolean/)
  })
})

describe('[flat-view] updateMappingTargetField — validation + state guards', () => {
  it('rejects non-UUID tfmId / newTargetFieldId with VALIDATION', () => {
    expect(TGT_FIELD_BODY).toMatch(/!UUID_REGEX\.test\(tfmId\)/)
    expect(TGT_FIELD_BODY).toMatch(/!UUID_REGEX\.test\(newTargetFieldId\)/)
  })

  it('refuses acknowledged / rejected TFMs with VALIDATION', () => {
    expect(TGT_FIELD_BODY).toMatch(/tfm\.is_acknowledged/)
    expect(TGT_FIELD_BODY).toMatch(/tfm\.status\s*===\s*['"]rejected['"]/)
  })

  it('routes a conflicting live TFM at the new target to the MERGE path (two-phase)', () => {
    expect(TGT_FIELD_BODY).toMatch(
      /existing\.id\s*!==\s*tfm\.id\s*&&\s*existing\.status\s*!==\s*['"]rejected['"]/,
    )
    // Phase 1 (no confirmMerge) returns a MERGE_REQUIRED preview;
    // phase 2 (confirmMerge) delegates to the merge executor.
    expect(TGT_FIELD_BODY).toMatch(/if\s*\(!confirmMerge\)/)
    expect(TGT_FIELD_BODY).toContain("errorCode: 'MERGE_REQUIRED'")
    expect(TGT_FIELD_BODY).toContain('mergeTargetFieldMappings(')
    // Swap is a MERGE, never a Replace — the existing mapping's sources
    // are preserved, not auto-deleted.
    expect(TGT_FIELD_BODY).not.toMatch(/replaceValueAssignment/)
  })

  it('treats a static-provider bare-ack at the new target as Path 1 — clears it, no dialog/error', () => {
    // Bug fix: a bare-ack TFM (`combination_type IS NULL`, not the
    // approve-all sentinel) is a machine-generated rationale carrier,
    // not a user decision — it must NOT block the swap. The check
    // discriminates on `combination_type === null` and deletes the
    // bare-ack so the plain swap proceeds.
    expect(TGT_FIELD_BODY).toMatch(
      /const isAckCarrier =\s*existing\.combination_type === null/,
    )
    // Path 1 deletes the bare-ack off target_field_mappings.
    expect(TGT_FIELD_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)\s*\.delete\(\)/,
    )
    expect(TGT_FIELD_BODY).toContain('clearedBareAckTfmId = existing.id')
    // The conflict select carries acknowledgment_reason for the
    // discriminator.
    expect(TGT_FIELD_BODY).toMatch(
      /\.select\(\s*['"][^'"]*acknowledgment_reason[^'"]*['"]\s*\)/,
    )
  })

  it('refuses VALIDATION only for a genuine user "approve all" acknowledgment (Path 3)', () => {
    // The VALIDATION case now fires ONLY when the ack-carrier TFM was
    // written by the user-driven bulk approve-all (APPROVE_ALL_REASON),
    // never for a static-provider bare-ack.
    expect(TGT_FIELD_BODY).toMatch(
      /isAckCarrier && existing\.acknowledgment_reason === APPROVE_ALL_REASON[\s\S]{0,400}errorCode:\s*['"]VALIDATION['"]/,
    )
    // The over-firing bare `is_acknowledged` gate from PR A1 is gone.
    expect(TGT_FIELD_BODY).not.toMatch(
      /if\s*\(existing\.is_acknowledged\)\s*\{/,
    )
  })

  it('records the bare-ack clear in the swap audit log, not as a merge event', () => {
    // Path 1 is a swap, not a merge — no `mapping_merged`; the cleared
    // bare-ack id rides on the existing `mapping_sources_changed` entry.
    expect(TGT_FIELD_BODY).toMatch(/bare_ack_cleared:\s*clearedBareAckTfmId/)
    // Scope the no-merge assertion to updateMappingTargetField proper —
    // the `mergeTargetFieldMappings` helper (also in TGT_FIELD_BODY's
    // span) legitimately emits `mapping_merged`.
    const updateProper = sliceBetween(
      SRC,
      'export async function updateMappingTargetField(',
      'async function getTfmSourceFieldRefs(',
    )
    expect(updateProper).not.toContain("'mapping_merged'")
  })

  it('has a no-op short-circuit when target_field_id unchanged', () => {
    expect(TGT_FIELD_BODY).toMatch(/tfm\.target_field_id\s*===\s*newTargetFieldId/)
  })
})

describe('[flat-view] updateMappingTargetField — write semantics', () => {
  it('resets the field transformation BEFORE the target_field_id update', () => {
    expect(TGT_FIELD_BODY).toMatch(/resetFieldTransform\(\s*tfm\.id\s*\)/)
  })

  it('UPDATE writes target_field_id + status=approved + updated_at', () => {
    expect(TGT_FIELD_BODY).toMatch(
      /\.update\(\{[\s\S]{0,400}target_field_id:\s*newTargetFieldId[\s\S]{0,400}status:\s*['"]approved['"]/,
    )
  })

  it('Q1: does NOT touch TFM.confidence — only status + target_field_id + updated_at', () => {
    const allTfmUpdates = [
      ...TGT_FIELD_BODY.matchAll(
        /from\(['"]target_field_mappings['"]\)[\s\S]{0,200}\.update\(\{([\s\S]{0,400})\}\)/g,
      ),
    ]
    for (const m of allTfmUpdates) {
      expect(m[1]).not.toMatch(/confidence:/)
    }
  })

  it('resets coverage status on the new target so stale rejected coverage does not leak through', () => {
    expect(TGT_FIELD_BODY).toMatch(
      /setCoverageStatus\(\s*projectId\s*,\s*newTargetFieldId\s*,\s*['"]needs_review['"]/,
    )
  })

  it('recomputes TMs for old + new target tables', () => {
    expect(TGT_FIELD_BODY).toMatch(/targetTablesAffected/)
    expect(TGT_FIELD_BODY).toMatch(/recomputeTableMappingStatus\(/)
  })

  it('logs mapping_sources_changed with kind=target_changed + mapping_approved (Q4)', () => {
    expect(TGT_FIELD_BODY).toMatch(/['"]mapping_sources_changed['"]/)
    expect(TGT_FIELD_BODY).toMatch(/kind:\s*['"]target_changed['"]/)
    expect(TGT_FIELD_BODY).toMatch(/['"]mapping_approved['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5.2b mergeTargetFieldMappings — confirmed target-swap MERGE executor
// ─────────────────────────────────────────────────────────────────────

const MERGE_BODY = sliceBetween(
  SRC,
  'async function mergeTargetFieldMappings(',
  '// ─── 5.3 createMappingFromUnmapped',
)

describe('[flat-view] mergeTargetFieldMappings — confirmed merge', () => {
  it('folds the deduped union of both source sets into the surviving TFM', () => {
    expect(MERGE_BODY).toMatch(/new Set\(\[/)
    expect(MERGE_BODY).toMatch(/existingSourceFieldIds/)
    expect(MERGE_BODY).toMatch(/incomingSourceFieldIds/)
    // The survivor gains the sources via editMappingSources — which also
    // flips it to needs_review and resets its transform SQL.
    expect(MERGE_BODY).toMatch(/editMappingSources\(\{/)
  })

  it('promotes the survivor to a multi-source combinator when the union is multi', () => {
    expect(MERGE_BODY).toMatch(/unionSourceFieldIds\.length\s*>\s*1/)
    expect(MERGE_BODY).toMatch(/['"]concat_space['"]/)
    expect(MERGE_BODY).toMatch(/['"]single['"]/)
  })

  it('deletes the swapping TFM after the sources land on the survivor', () => {
    const editIdx = MERGE_BODY.indexOf('editMappingSources({')
    const deleteIdx = MERGE_BODY.indexOf('deleteFieldMapping(')
    expect(editIdx).toBeGreaterThan(0)
    expect(deleteIdx).toBeGreaterThan(editIdx)
  })

  it('neutralizes the swapping TFM old target so it reverts to a neutral unmapped row', () => {
    expect(MERGE_BODY).toMatch(
      /neutralizeCoverageForReject\(\s*projectId\s*,\s*swappingTfm\.targetFieldId/,
    )
  })

  it('emits a mapping_merged activity-log entry for the swapped-away TFM', () => {
    expect(MERGE_BODY).toMatch(/['"]mapping_merged['"]/)
    expect(MERGE_BODY).toMatch(/kind:\s*['"]target_merge['"]/)
  })

  it('returns the surviving TFM id with merged=true', () => {
    expect(MERGE_BODY).toMatch(/tfmId:\s*survivingTfm\.id/)
    expect(MERGE_BODY).toMatch(/merged:\s*true/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5.3 createMappingFromUnmapped
// ─────────────────────────────────────────────────────────────────────

const CREATE_BODY = sliceBetween(
  SRC,
  'export async function createMappingFromUnmapped(',
  '// ─── 5.4 setUnmappedRowRejected',
)

describe('[flat-view] createMappingFromUnmapped — shape', () => {
  it('exports createMappingFromUnmapped with projectId / sourceFieldId / targetFieldId', () => {
    expect(SRC).toMatch(/export async function createMappingFromUnmapped\(input: \{/)
    expect(CREATE_BODY).toMatch(/projectId:\s*string/)
    expect(CREATE_BODY).toMatch(/sourceFieldId:\s*string/)
    expect(CREATE_BODY).toMatch(/targetFieldId:\s*string/)
  })

  it('returns resolvedCase ∈ unmapped_target | unmapped_source | both | neither', () => {
    const union = sliceBetween(
      SRC,
      'export type CreateMappingFromUnmappedResult',
      'export async function createMappingFromUnmapped',
    )
    expect(union).toMatch(/resolvedCase:\s*['"]unmapped_target['"]\s*\|\s*['"]unmapped_source['"]\s*\|\s*['"]both['"]\s*\|\s*['"]neither['"]/)
  })
})

describe('[flat-view] createMappingFromUnmapped — case detection + delegation', () => {
  it('detects unmapped target case via target_field_mappings lookup', () => {
    expect(CREATE_BODY).toMatch(/from\(['"]target_field_mappings['"]\)/)
    expect(CREATE_BODY).toMatch(/targetIsUnmapped/)
  })

  it('detects unmapped source case via source_field_acknowledgments lookup', () => {
    expect(CREATE_BODY).toMatch(/from\(['"]source_field_acknowledgments['"]\)/)
    expect(CREATE_BODY).toMatch(/sourceIsUnmapped/)
  })

  it('returns TARGET_CONFLICT when a live non-bare-ack TFM exists at the target', () => {
    expect(CREATE_BODY).toMatch(/TARGET_CONFLICT/)
  })

  it('delegates the actual create to createFieldMapping with combination=single + confidence=100', () => {
    expect(CREATE_BODY).toMatch(/createFieldMapping\(\{/)
    expect(CREATE_BODY).toMatch(/combinationType:\s*['"]single['"]/)
    expect(CREATE_BODY).toMatch(/confidence:\s*FLAT_VIEW_USER_CONFIDENCE/)
  })

  it('flips the created TFM status to approved (flat-view affirmation cascade)', () => {
    expect(CREATE_BODY).toMatch(
      /from\(['"]target_field_mappings['"]\)[\s\S]{0,300}\.update\(\{[\s\S]{0,300}status:\s*['"]approved['"][\s\S]{0,300}\.eq\(\s*['"]id['"],\s*createResult\.tfmId/,
    )
  })

  it('clears stale rejected coverage on unmapped-target case', () => {
    expect(CREATE_BODY).toMatch(
      /setCoverageStatus\(\s*projectId\s*,\s*targetFieldId\s*,\s*['"]needs_review['"]/,
    )
  })

  it('Q3: DELETEs the source_field_acknowledgments row on unmapped-source case', () => {
    expect(CREATE_BODY).toMatch(
      /from\(['"]source_field_acknowledgments['"]\)[\s\S]{0,200}\.delete\(\)/,
    )
    expect(CREATE_BODY).toMatch(/sourceIsUnmapped\s*&&\s*existingAck/)
  })

  it('does NOT emit additional activity-log entries (createFieldMapping already logs mapping_created)', () => {
    // No `logActivity(...)` call sites in createMappingFromUnmapped's body
    // (createFieldMapping owns the emit).
    expect(CREATE_BODY).not.toMatch(/logActivity\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5.4 setUnmappedRowRejected
// ─────────────────────────────────────────────────────────────────────

// This action is the LAST function in the file — slice from the marker
// to end-of-file.
const REJECT_IDX = SRC.indexOf('export async function setUnmappedRowRejected(')
expect(REJECT_IDX).toBeGreaterThan(0)
const REJECT_BODY = SRC.slice(REJECT_IDX)

describe('[flat-view] setUnmappedRowRejected — shape', () => {
  it('exports setUnmappedRowRejected with projectId + targetFieldId? + sourceFieldId?', () => {
    expect(SRC).toMatch(/export async function setUnmappedRowRejected\(input: \{/)
    expect(REJECT_BODY).toMatch(/targetFieldId\?:\s*string/)
    expect(REJECT_BODY).toMatch(/sourceFieldId\?:\s*string/)
  })

  it('returns side: target | source on success', () => {
    const union = sliceBetween(
      SRC,
      'export type SetUnmappedRowRejectedResult',
      'export async function setUnmappedRowRejected',
    )
    expect(union).toMatch(/side:\s*['"]target['"]\s*\|\s*['"]source['"]/)
  })
})

describe('[flat-view] setUnmappedRowRejected — XOR validation', () => {
  it('refuses when both targetFieldId AND sourceFieldId are supplied', () => {
    expect(REJECT_BODY).toMatch(
      /\(targetFieldId\s*&&\s*sourceFieldId\)\s*\|\|\s*\(!targetFieldId\s*&&\s*!sourceFieldId\)/,
    )
    expect(REJECT_BODY).toMatch(
      /Exactly one of targetFieldId or sourceFieldId/,
    )
  })

  it('validates UUID shape on both fields', () => {
    expect(REJECT_BODY).toMatch(/!UUID_REGEX\.test\(targetFieldId\)/)
    expect(REJECT_BODY).toMatch(/!UUID_REGEX\.test\(sourceFieldId\)/)
  })
})

describe('[flat-view] setUnmappedRowRejected — target branch', () => {
  it('refuses if a live TFM covers the target', () => {
    expect(REJECT_BODY).toMatch(/liveTfm\s*&&\s*liveTfm\.status\s*!==\s*['"]rejected['"]/)
    expect(REJECT_BODY).toMatch(/Use Reject on the mapped row instead/)
  })

  it('neutralizes the coverage row via neutralizeCoverageForReject (Reject = reset)', () => {
    // Both reject entry points now land the same neutral grey end state:
    // the flat-view ✗ neutralizes the coverage row (status →
    // needs_review, ai_reasoning → null) exactly like the drawer-side
    // rejectFieldMapping unmapped-target branch — no distinct
    // `coverage.status='rejected'` (red) row from the flat view.
    expect(REJECT_BODY).toMatch(
      /neutralizeCoverageForReject\(\s*projectId\s*,\s*targetFieldId\s*,?\s*\)/,
    )
    // The branch must NOT persist a `rejected` coverage status.
    expect(REJECT_BODY).not.toMatch(
      /setCoverageStatus\([^)]*['"]rejected['"]/,
    )
  })

  it('logs mapping_rejected with no_source=true (parity with existing unmapped-target reject)', () => {
    expect(REJECT_BODY).toMatch(/['"]mapping_rejected['"]/)
    expect(REJECT_BODY).toMatch(/no_source:\s*true/)
  })
})

describe('[flat-view] setUnmappedRowRejected — source branch', () => {
  it('UPSERTs source_field_acknowledgments with decision=rejected and reason=""', () => {
    expect(REJECT_BODY).toMatch(/from\(['"]source_field_acknowledgments['"]\)/)
    expect(REJECT_BODY).toMatch(/\.upsert\(/)
    expect(REJECT_BODY).toMatch(/decision:\s*['"]rejected['"]/)
    expect(REJECT_BODY).toMatch(/reason:\s*['"]{2}/)
  })

  it("uses onConflict: 'project_id,source_field_id' so an existing ack flips cleanly", () => {
    expect(REJECT_BODY).toMatch(
      /onConflict:\s*['"]project_id,source_field_id['"]/,
    )
  })

  it('recomputes TMs whose source_table_id matches the source field parent table', () => {
    expect(REJECT_BODY).toMatch(/source_table_id/)
    expect(REJECT_BODY).toMatch(/recomputeTableMappingStatus\(/)
  })

  it('Q4: emits source_field_rejected (new action_type)', () => {
    expect(REJECT_BODY).toMatch(/['"]source_field_rejected['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Read translator — decision='rejected' surfaces as isRejected
// ─────────────────────────────────────────────────────────────────────

describe('[flat-view] read translator changes', () => {
  const ENGINE_PATH = resolve(__dirname, '../../lib/ai/mapping-engine.ts')
  const ENGINE_SRC = readFileSync(ENGINE_PATH, 'utf8')

  it('fetches the decision column on source_field_acknowledgments', () => {
    expect(ENGINE_SRC).toMatch(
      /from\(['"]source_field_acknowledgments['"]\)[\s\S]{0,200}\.select\(\s*['"][^'"]*decision[^'"]*['"]/,
    )
  })

  it('coerces unknown decision values to "acknowledged" defensively in the summary projection', () => {
    expect(ENGINE_SRC).toMatch(/decision:\s*a\.decision\s*===\s*['"]rejected['"]\s*\?\s*['"]rejected['"]\s*:\s*['"]acknowledged['"]/)
  })

  it('splits the acknowledged + rejected source-field id sets by decision', () => {
    expect(ENGINE_SRC).toMatch(/acknowledgedSourceFieldIds/)
    expect(ENGINE_SRC).toMatch(/rejectedSourceFieldIds/)
    expect(ENGINE_SRC).toMatch(/a\.decision\s*===\s*['"]rejected['"]/)
  })

  it('emits SourceFieldWithState.isRejected from the rejected set', () => {
    // The verdict is bound to a local `const isRejected` so the same
    // value can both populate the wire field and gate the static-
    // rationale suppression below.
    expect(ENGINE_SRC).toMatch(
      /const isRejected = rejectedSourceFieldIds\.has\(field\.id\)/,
    )
    expect(ENGINE_SRC).toMatch(/\n\s*isRejected,/)
  })

  it('suppresses aiReasoning + confidence for rejected source fields (Reject = reset)', () => {
    // A rejected source field carries no preserved AI commentary — the
    // static-config rationale lookup is skipped when isRejected is true.
    expect(ENGINE_SRC).toMatch(
      /const rationale = isRejected\s*\n?\s*\?\s*undefined\s*\n?\s*:\s*staticSourceRationale\.get\(field\.id\)/,
    )
    expect(ENGINE_SRC).toMatch(/aiReasoning:\s*rationale\?\.explanation\s*\?\?\s*null/)
    expect(ENGINE_SRC).toMatch(/confidence:\s*rationale\?\.confidence\s*\?\?\s*null/)
  })
})
