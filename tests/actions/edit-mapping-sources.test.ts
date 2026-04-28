// @vitest-environment node
//
// Phase 4b-1 — source-level invariant tests for the
// `editMappingSources` server action.
//
// Same testing strategy as `mappings-for-redesign-phase-4a-actions.test.ts`
// (Gap 9 / Phase 4a-1): the wrapper touches Supabase auth, the project
// permission check, the maintenance gate, the
// `dq_replace_mapping_sources` RPC, the staged-data invalidation path
// via `resetFieldTransform`, and the activity log. Spinning up a full
// mocking harness for every codepath is expensive; we read the source
// file and assert the call-site shape locks the founder-locked
// decisions in place.
//
// Founder-locked decisions captured here as regression guards (E1-E25
// per the Phase 4b-1 task list):
//
//   E1.  Wrapper exports `editMappingSources` with the documented input
//        shape and return discriminated union.
//   E2.  `EditMappingErrorCode` union exposes all 9 error paths.
//   E3.  Validation rejects empty tfmId / empty sourceFieldIds /
//        custom_sql / single-with-≠1-sources / non-single-with-<2 /
//        duplicate sourceFieldIds with VALIDATION.
//   E4.  Auth gate via `supabase.auth.getUser()` returns
//        PERMISSION_DENIED on missing user.
//   E5.  TFM identity read via `target_field_mappings` returns
//        NOT_FOUND on missing row.
//   E6.  `requireProjectPermission(projectId, 'editor')` is invoked.
//   E7.  Defensive `TFM_REJECTED` guard on `status === 'rejected'`.
//   E8.  Defensive `TFM_ACKNOWLEDGED` guard on `is_acknowledged`.
//   E9.  Maintenance-mode gate via `assertMappingWritesEnabled`
//        returns MAINTENANCE_MODE on the maintenance error.
//  E10.  Source field identity reads + project ownership verification
//        return VALIDATION when a source field belongs to a different
//        project.
//  E11.  Existing `mapping_sources` are read for dominant-table swap
//        detection AND provenance laundering (ai_reasoning column
//        included in the SELECT).
//  E12.  Dominant-table swap returns `DOMINANT_TABLE_CHANGED` when the
//        new first source's table differs from the original ordinal-0
//        source's table.
//  E13.  Cross-table FK precheck — single candidate → success without
//        needing joinAnnotations override.
//  E14.  Cross-table FK precheck — zero candidates → CROSS_TABLE_AMBIGUOUS
//        with empty candidateFkFields.
//  E15.  Cross-table FK precheck — multiple candidates without override
//        → CROSS_TABLE_AMBIGUOUS with the candidate list.
//  E16.  Cross-table FK precheck — invalid override → VALIDATION.
//  E17.  Persisted join_spec is written ONLY for user-disambiguated
//        joined sources (parallel to createFieldMapping).
//  E18.  Set-diff drives `sourcesChanged` AND ordering changes count
//        as a source change (dominant defines join anchor).
//  E19.  RPC `dq_replace_mapping_sources` invocation with `p_tfm_id`
//        + `p_sources`.
//  E20.  Provenance laundering: zero original AI sources retained →
//        TFM-level ai_reasoning collapses to 'Mapping edited via
//        redesign UI'.
//  E21.  Provenance laundering: ≥1 original AI source retained →
//        TFM-level ai_reasoning preserved (or fallback). Per-source
//        marker preserved on retained AI rows; new rows always carry
//        manual marker.
//  E22.  Status revert to `needs_review` on every successful edit
//        regardless of prior status.
//  E23.  `resetFieldTransform` invoked when `sourcesChanged` is true,
//        skipped otherwise. Soft-fail behavior on failure.
//  E24.  Activity log emits `mapping_sources_changed` AND
//        `transformation_reset` with `{ reason: 'mapping_edited' }`
//        when applicable.
//  E25.  `revalidatePath` for /mapping AND /transform; success result
//        carries `transformReset`, `stagedRowsReverted`,
//        `sourcesChanged`.

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
  'export async function editMappingSources(',
  'export async function updateMappingCombination(',
)

// ─────────────────────────────────────────────────────────────────────
// E1-E2 — Module-level shape: exports + error union
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] wrapper shape', () => {
  it('E1: exports editMappingSources as an async function with the documented input shape', () => {
    expect(SRC).toMatch(/export async function editMappingSources\(input: \{/)
    expect(SRC).toMatch(/tfmId:\s*string/)
    expect(SRC).toMatch(/sourceFieldIds:\s*string\[\]/)
    expect(SRC).toMatch(
      /combinationType:\s*CreateFieldMappingCombinationType\s*\|\s*['"]custom_sql['"]/,
    )
    expect(SRC).toMatch(/joinAnnotations\?:\s*Record<string,\s*string>/)
  })

  it('E1: returns the documented discriminated union with success metadata', () => {
    expect(SRC).toMatch(/export type EditMappingResult/)
    const resultUnion = sliceBetween(SRC, 'export type EditMappingResult', '\n\nexport type UpdateCombination')
    expect(resultUnion).toMatch(/transformReset:\s*boolean/)
    expect(resultUnion).toMatch(/stagedRowsReverted:\s*number/)
    expect(resultUnion).toMatch(/sourcesChanged:\s*boolean/)
    expect(resultUnion).toMatch(/errorCode:\s*EditMappingErrorCode/)
  })

  it('E2 (Cycle 1): EditMappingErrorCode exposes the 7 retained error paths; CROSS_TABLE_AMBIGUOUS + DOMINANT_TABLE_CHANGED were removed', () => {
    const union = sliceBetween(
      SRC,
      'export type EditMappingErrorCode',
      'export type EditMappingResult',
    )
    expect(union).toContain("'PERMISSION_DENIED'")
    expect(union).toContain("'NOT_FOUND'")
    expect(union).toContain("'VALIDATION'")
    expect(union).toContain("'MAINTENANCE_MODE'")
    expect(union).toContain("'INTERNAL'")
    expect(union).toContain("'TFM_REJECTED'")
    expect(union).toContain("'TFM_ACKNOWLEDGED'")
    // Cycle 1 — locked decision §2 hygiene cleanup. The cross-table FK
    // precheck and dominant-swap guard were wholesale-deleted from the
    // server, and the corresponding error codes were removed from the
    // union. Multi-candidate ambiguity now surfaces at Transform-tab
    // apply time as `CROSS_TABLE_FK_INFERENCE_FAILED`.
    expect(union).not.toContain("'CROSS_TABLE_AMBIGUOUS'")
    expect(union).not.toContain("'DOMINANT_TABLE_CHANGED'")
  })
})

// ─────────────────────────────────────────────────────────────────────
// E3 — Validation block
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] validation', () => {
  it('E3a: rejects empty tfmId with VALIDATION', () => {
    expect(BODY).toMatch(/!tfmId[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/)
  })

  it('E3b: rejects empty sourceFieldIds with VALIDATION', () => {
    expect(BODY).toMatch(
      /sourceFieldIds\.length\s*===\s*0[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it("E3c: rejects combinationType === 'custom_sql' at the wrapper boundary", () => {
    expect(BODY).toMatch(/combinationType\s*===\s*['"]custom_sql['"]/)
    expect(BODY).toMatch(
      /custom_sql[\s\S]{0,300}errorCode:\s*['"]VALIDATION['"]/,
    )
    expect(BODY).toMatch(/Transform tab/)
  })

  it("E3d: requires exactly one source for combinationType === 'single'", () => {
    expect(BODY).toMatch(
      /combinationType\s*===\s*['"]single['"]\s*&&\s*sourceFieldIds\.length\s*!==\s*1/,
    )
  })

  it('E3e: requires 2+ sources for non-single combination types', () => {
    expect(BODY).toMatch(
      /combinationType\s*!==\s*['"]single['"]\s*&&\s*sourceFieldIds\.length\s*<\s*2/,
    )
  })

  it('E3f: rejects duplicate sourceFieldIds (defense-in-depth against picker bugs)', () => {
    expect(BODY).toMatch(
      /new Set\(sourceFieldIds\)\.size\s*!==\s*sourceFieldIds\.length/,
    )
    expect(BODY).toMatch(/Duplicate source fields[\s\S]{0,200}VALIDATION/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E4-E9 — Auth, identity, permission, defensive guards, maintenance
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] auth + permission + state guards', () => {
  it('E4: checks auth via supabase.auth.getUser() and returns PERMISSION_DENIED on missing user', () => {
    expect(BODY).toMatch(/supabase\.auth\.getUser\(\)/)
    expect(BODY).toMatch(
      /if\s*\(\s*!user\s*\)[\s\S]{0,200}errorCode:\s*['"]PERMISSION_DENIED['"]/,
    )
  })

  it('E5: reads the TFM identity (project_id + target_field_id + status + is_acknowledged + ai_reasoning + combination_type) and returns NOT_FOUND when missing', () => {
    expect(BODY).toMatch(/from\(['"]target_field_mappings['"]\)/)
    expect(BODY).toMatch(
      /\.select\(\s*['"][^'"]*project_id[^'"]*target_field_id[^'"]*status[^'"]*is_acknowledged[^'"]*ai_reasoning[^'"]*combination_type[^'"]*['"]/,
    )
    expect(BODY).toMatch(
      /if\s*\(\s*!tfm\s*\)[\s\S]{0,200}errorCode:\s*['"]NOT_FOUND['"]/,
    )
  })

  it('E6: enforces editor permission via requireProjectPermission(projectId, "editor")', () => {
    expect(BODY).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]editor['"]\s*\)/,
    )
    expect(BODY).toMatch(/!perm\.allowed[\s\S]{0,200}PERMISSION_DENIED/)
  })

  it('E7: refuses to mutate TFMs with status === "rejected" → TFM_REJECTED', () => {
    expect(BODY).toMatch(/tfm\.status\s*===\s*['"]rejected['"]/)
    expect(BODY).toMatch(
      /rejected['"][\s\S]{0,400}errorCode:\s*['"]TFM_REJECTED['"]/,
    )
  })

  it('E8: refuses to mutate TFMs with is_acknowledged === true → TFM_ACKNOWLEDGED', () => {
    expect(BODY).toMatch(/tfm\.is_acknowledged/)
    expect(BODY).toMatch(
      /is_acknowledged[\s\S]{0,400}errorCode:\s*['"]TFM_ACKNOWLEDGED['"]/,
    )
  })

  it('E9: runs assertMappingWritesEnabled and surfaces MAINTENANCE_MODE on the maintenance message', () => {
    expect(BODY).toMatch(/assertMappingWritesEnabled\(\s*projectId\s*\)/)
    expect(BODY).toMatch(/Mapping writes are temporarily disabled/)
    expect(BODY).toMatch(
      /Mapping writes[\s\S]{0,400}errorCode:\s*['"]MAINTENANCE_MODE['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E10 — Source field identity reads and project ownership
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] source field identity', () => {
  it('E10a: reads source fields with table+dataset join for project ownership verification', () => {
    expect(BODY).toMatch(/from\(['"]fields['"]\)/)
    expect(BODY).toMatch(
      /tables!inner\(datasets!inner\(project_id\)\)/,
    )
    expect(BODY).toMatch(/\.in\(\s*['"]id['"]\s*,\s*sourceFieldIds\s*\)/)
  })

  it('E10b: returns VALIDATION when any source field belongs to a different project', () => {
    expect(BODY).toMatch(/sfProject\s*!==\s*projectId/)
    expect(BODY).toMatch(
      /do not belong to this project[\s\S]{0,200}errorCode:\s*['"]VALIDATION['"]/,
    )
  })

  it('E10c: returns NOT_FOUND when fewer source fields are returned than requested', () => {
    expect(BODY).toMatch(
      /sourceFields\.length\s*!==\s*sourceFieldIds\.length/,
    )
    expect(BODY).toMatch(
      /sourceFields\.length\s*!==\s*sourceFieldIds\.length[\s\S]{0,400}errorCode:\s*['"]NOT_FOUND['"]/,
    )
  })

  it('E10d: re-orders source fields by input order so dominant = ordinal 0', () => {
    expect(BODY).toMatch(/sourceFieldIds\.map\(\(id\)\s*=>\s*sourceFieldsById\.get\(id\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E11 — Existing mapping_sources read shape
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] existing-sources read', () => {
  it('E11a: reads mapping_sources with source_field_id + source_table_id + ai_reasoning + ordinal', () => {
    expect(BODY).toMatch(/from\(['"]mapping_sources['"]\)/)
    expect(BODY).toMatch(
      /\.select\(\s*['"]source_field_id,\s*source_table_id,\s*ai_reasoning,\s*ordinal['"]/,
    )
  })

  it('E11b: orders existing sources by ordinal ASC so existingSources[0] is the original dominant', () => {
    expect(BODY).toMatch(
      /\.order\(\s*['"]ordinal['"]\s*,\s*\{\s*ascending:\s*true\s*\}/,
    )
  })

  it('E11c: tags AI-suggested rows by ai_reasoning startsWith \'AI-suggested:\' (matches createFieldMapping marker)', () => {
    expect(BODY).toMatch(/ai_reasoning\.startsWith\(\s*['"]AI-suggested:['"]\s*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E12 — Dominant-table swap detection (REMOVED in Cycle 1)
// E13-E17 — Cross-table FK precheck (REMOVED in Cycle 1)
//
// Cycle 1 wholesale-deleted both server-side surfaces (locked
// decisions §1, §2). Inline cross-table source edits — including
// dominant-table swaps and 0/multi-FK-candidate situations — are
// now permitted. The persisted `mapping_sources.join_spec` is
// always-null on the write path; the read path re-derives the FK
// annotation each render via `inferFkCandidates`. Multi-candidate
// ambiguity surfaces only at Transform-tab apply time as
// `CROSS_TABLE_FK_INFERENCE_FAILED` (existing code path).
//
// The regression guards below lock the deletion in place by
// confirming none of the deleted constructs reappear in
// `editMappingSources`.
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] dominant-table swap removed (Cycle 1)', () => {
  it('E12 (Cycle 1): editMappingSources no longer emits DOMINANT_TABLE_CHANGED nor compares newDominantTableId !== originalDominantTableId', () => {
    expect(BODY).not.toMatch(/newDominantTableId/)
    expect(BODY).not.toMatch(/originalDominantTableId/)
    expect(BODY).not.toMatch(/DOMINANT_TABLE_CHANGED/)
    expect(BODY).not.toMatch(/Changing the first source's table/)
  })
})

describe('[edit-mapping-sources] cross-table FK precheck removed (Cycle 1)', () => {
  it('E13-E17 (Cycle 1): editMappingSources no longer runs the cross-table FK precheck (no CROSS_TABLE_AMBIGUOUS, no needsPersistedSpec, no isCrossTable branch, no candidates inspection)', () => {
    expect(BODY).not.toMatch(/CROSS_TABLE_AMBIGUOUS/)
    expect(BODY).not.toMatch(/needsPersistedSpec/)
    expect(BODY).not.toMatch(/if\s*\(isCrossTable\)/)
    expect(BODY).not.toMatch(/joinSpecBySourceFieldId\.set/)
    expect(BODY).not.toMatch(/candidateFkFields:/)
    expect(BODY).not.toMatch(/ambiguousJoinedTableId:/)
    expect(BODY).not.toMatch(/ambiguousJoinedTableName:/)
  })

  it('E13-E17 (Cycle 1): inferFkCandidates and joinSpecBySourceFieldId STAY at module/file scope (read-path re-derivation is unaffected; consumed by _mappings-for-redesign-core.ts and transform-cross-table.ts)', () => {
    // `inferFkCandidates` is still imported (consumed by the read
    // path / transform-cross-table.ts). The wrapper body simply
    // doesn't call it for the precheck anymore.
    expect(SRC).toMatch(/inferFkCandidates/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E18 — Set-diff drives sourcesChanged (incl. ordering)
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] set-diff', () => {
  it('E18a: size difference between new and existing source sets sets sourcesChanged=true', () => {
    expect(BODY).toMatch(
      /newSourceIdsSet\.size\s*!==\s*existingSourceFieldIds\.size[\s\S]{0,200}sourcesChanged\s*=\s*true/,
    )
  })

  it('E18b: any id in new set not in existing set sets sourcesChanged=true', () => {
    expect(BODY).toMatch(/!existingSourceFieldIds\.has\(id\)/)
  })

  it('E18c: ordinal change (re-ordering without add/remove) ALSO counts as a source change', () => {
    expect(BODY).toMatch(
      /existingSources\[i\]\.source_field_id\s*!==\s*sourceFieldIds\[i\]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E19 — RPC dq_replace_mapping_sources
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] dq_replace_mapping_sources RPC', () => {
  it('E19a: invokes dq_replace_mapping_sources with p_tfm_id + p_sources', () => {
    expect(BODY).toMatch(/supabase\.rpc\(\s*['"]dq_replace_mapping_sources['"]/)
    expect(BODY).toMatch(/p_tfm_id:\s*tfm\.id/)
    expect(BODY).toMatch(/p_sources:\s*rpcSources/)
  })

  it('E19b (Cycle 1): rpcSources entries carry source_field_id, source_table_id, ordinal, ai_reasoning, and an always-null join_spec on the write path', () => {
    expect(BODY).toMatch(/source_field_id:\s*sf\.id/)
    expect(BODY).toMatch(/source_table_id:\s*sf\.table_id/)
    expect(BODY).toMatch(/ordinal:\s*idx/)
    expect(BODY).toMatch(/ai_reasoning:\s*isRetainedAi/)
    // Cycle 1 — `join_spec` is always written as `null`. The read
    // path re-derives the FK annotation each render via
    // `inferFkCandidates`. The previous `joinSpecBySourceFieldId`
    // map plumbing has been removed entirely.
    expect(BODY).toMatch(/join_spec:\s*null/)
    expect(BODY).not.toMatch(/joinSpecBySourceFieldId/)
  })

  it('E19c: maps INTERNAL on RPC error', () => {
    expect(BODY).toMatch(
      /rpcErr[\s\S]{0,200}errorCode:\s*['"]INTERNAL['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E20-E21 — Provenance laundering (§1f)
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] provenance laundering', () => {
  it('E20: zero original AI sources retained → TFM-level ai_reasoning collapses to manual marker', () => {
    expect(BODY).toMatch(/retainedAiSourceIds/)
    expect(BODY).toMatch(/stillHasOriginalAi\s*=\s*retainedAiSourceIds\.size\s*>\s*0/)
    expect(BODY).toMatch(/['"]Mapping edited via redesign UI['"]/)
  })

  it('E21a: ≥1 original AI source retained → TFM-level ai_reasoning preserved (or AI fallback)', () => {
    expect(BODY).toMatch(/stillHasOriginalAi[\s\S]{0,200}tfm\.ai_reasoning/)
    expect(BODY).toMatch(/['"]AI-suggested via per-row Suggest['"]/)
  })

  it('E21b: per-source marker preserved on retained AI rows; new rows always carry manual marker', () => {
    expect(BODY).toMatch(/isRetainedAi\s*=\s*retainedAiSourceIds\.has\(sf\.id\)/)
    expect(BODY).toMatch(
      /isRetainedAi[\s\S]{0,400}['"]Manually selected by user['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E22 — Status revert
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] status revert', () => {
  it('E22: every successful edit UPDATEs status to needs_review', () => {
    expect(BODY).toMatch(/from\(['"]target_field_mappings['"]\)\s*\.update\(\{[\s\S]{0,300}status:\s*['"]needs_review['"]/)
  })

  it('E22b: combinationType + ai_reasoning + updated_at threaded through the same UPDATE', () => {
    expect(BODY).toMatch(/combination_type:\s*combinationType/)
    expect(BODY).toMatch(/ai_reasoning:\s*newTfmAiReasoning/)
    expect(BODY).toMatch(/updated_at:\s*new Date\(\)\.toISOString\(\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// E23 — resetFieldTransform invocation
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] transform reset', () => {
  it('E23a: calls resetFieldTransform ONLY when sourcesChanged is true', () => {
    expect(BODY).toMatch(/if\s*\(\s*sourcesChanged\s*\)\s*\{[\s\S]{0,400}resetFieldTransform/)
  })

  it('E23b: imports resetFieldTransform dynamically from @/lib/actions/transformations', () => {
    expect(BODY).toMatch(
      /import\(\s*['"]@\/lib\/actions\/transformations['"]\s*\)/,
    )
  })

  it('E23c: success path threads hadTransform → transformReset and rowsReverted → stagedRowsReverted', () => {
    expect(BODY).toMatch(/transformReset\s*=\s*reset\.hadTransform/)
    expect(BODY).toMatch(/stagedRowsReverted\s*=\s*reset\.rowsReverted/)
  })

  it('E23d: soft-fail on resetFieldTransform error — does NOT roll back source replacement', () => {
    expect(BODY).toMatch(
      /\[editMappingSources\]\s*resetFieldTransform failed/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// E24-E25 — Activity log + revalidate + result shape
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-sources] activity log + result', () => {
  it('E24a: emits mapping_sources_changed activity with cross_table + sources_changed + transform_reset metadata', () => {
    expect(BODY).toMatch(
      /logActivity\(\s*projectId\s*,\s*['"]mapping_sources_changed['"]/,
    )
    expect(BODY).toMatch(/cross_table:\s*isCrossTable/)
    expect(BODY).toMatch(/sources_changed:\s*sourcesChanged/)
    expect(BODY).toMatch(/transform_reset:\s*transformReset/)
  })

  it('E24b: emits transformation_reset activity with reason: "mapping_edited" when transform was reset', () => {
    expect(BODY).toMatch(/if\s*\(transformReset\)/)
    expect(BODY).toMatch(
      /logActivity\([\s\S]{0,400}['"]transformation_reset['"]/,
    )
    expect(BODY).toMatch(/reason:\s*['"]mapping_edited['"]/)
  })

  it('E25a: revalidates both /mapping AND /transform after the edit', () => {
    expect(BODY).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/mapping`/,
    )
    expect(BODY).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/transform`/,
    )
  })

  it('E25b: returns success result with tfmId + transformReset + stagedRowsReverted + sourcesChanged', () => {
    expect(BODY).toMatch(
      /return\s*\{\s*success:\s*true,\s*tfmId:\s*tfm\.id,\s*transformReset,\s*stagedRowsReverted,\s*sourcesChanged,/,
    )
  })

  it('E25c: recomputes table_mappings status for the dominant→target pair after the edit', () => {
    expect(BODY).toMatch(/recomputeTableMappingStatus\(\s*supabase\s*,/)
  })
})
