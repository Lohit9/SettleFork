import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  computeOrphanedTfmsForTmDelete,
  type DeleteTmCandidateTfmInput,
  type DeleteTmSiblingTmInput,
} from '@/lib/mappings/tm-ownership'

/**
 * Source-level invariants for the four Prompt-3a refinements the founder
 * locked in at Gate 2:
 *
 *   1. Contributor INSERT path (`addManualFieldMapping(isContributing=true)`)
 *      uses a direct `from('mapping_sources').insert(...)` with `ordinal = max+1`
 *      — NOT `dq_replace_mapping_sources`.
 *   2. Target-conflict on `editFieldMapping` target_field_id change returns
 *      `errorCode: 'TARGET_CONFLICT'` instead of merging.
 *   3. `approveAllFieldMappings` filters unmapped source/target ids against
 *      existing acknowledgments before upserting to avoid clobbering
 *      user-authored reasons.
 *   4. The shim (see `tests/compat/mapping-shim.test.ts` Case 17) throws
 *      INVARIANT when a TFM has is_acknowledged=true AND combination_type
 *      != NULL. (Covered in the shim test suite, but we re-assert the
 *      inverse invariant here: the translator's is_acknowledged branch
 *      must check combination_type and throw.)
 *
 * These tests read the source file and verify specific call-site patterns
 * so that a future refactor that silently drops a refinement cannot land
 * without breaking CI.
 */

const MAPPINGS_PATH = resolve(__dirname, '../../lib/actions/mappings.ts')
const SHIM_PATH = resolve(__dirname, '../../lib/compat/mapping-shim.ts')

const MAPPINGS_SRC = readFileSync(MAPPINGS_PATH, 'utf8')
const SHIM_SRC = readFileSync(SHIM_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

describe('[mappings refinements] Refinement 1 — contributor direct INSERT (not dq_replace_mapping_sources)', () => {
  it('addManualFieldMapping contributor branch inserts into mapping_sources directly', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function addManualFieldMapping(',
      'async function getNextOrdinal(',
    )
    // Direct INSERT into mapping_sources must be present.
    expect(body).toMatch(/from\('mapping_sources'\)\s*\.insert\(/)
    // Must NOT use dq_replace_mapping_sources inside this function.
    expect(body).not.toContain('dq_replace_mapping_sources')
    // Ordinal must be computed via getNextOrdinal helper (max+1 semantics).
    expect(body).toContain('getNextOrdinal(')
  })

  it('getNextOrdinal queries max ordinal and returns max+1', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'async function getNextOrdinal(',
      '// ─── addManualTableMapping',
    )
    expect(body).toContain("order('ordinal', { ascending: false })")
    expect(body).toContain('.limit(1)')
    expect(body).toContain('max + 1')
  })
})

describe('[mappings refinements] Refinement 2 — TARGET_CONFLICT on editFieldMapping target change', () => {
  it('editFieldMapping returns TARGET_CONFLICT errorCode when non-VA TFM exists at new target', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function editFieldMapping(',
      'export async function addManualFieldMapping(',
    )
    expect(body).toContain("errorCode: 'TARGET_CONFLICT'")
    // Must also still allow VA→mapping replacement (deletes VA first).
    expect(body).toContain("existing.combination_type === 'custom_sql'")
    // Explicit conflict message for the UI to surface.
    expect(body).toMatch(/Target field already has a mapping/)
  })
})

describe('[mappings refinements] Refinement 3 — approveAllFieldMappings preserves existing acks', () => {
  it('filters unmappedTargetIds against existing is_acknowledged TFMs before upsert', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function approveAllFieldMappings(',
      'export async function rejectAllFieldMappings(',
    )
    expect(body).toContain('existingTargetAckIds')
    expect(body).toMatch(/unmappedTargetIds\.filter\(/)
  })

  it('filters unmappedSourceIds against existing source_field_acknowledgments before upsert', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function approveAllFieldMappings(',
      'export async function rejectAllFieldMappings(',
    )
    expect(body).toContain('existingSrcAckIds')
    expect(body).toContain("from('source_field_acknowledgments')")
    expect(body).toMatch(/unmappedSourceIds\.filter\(/)
  })

  it('uses the approve_all reason constant (detectable for later cleanup)', () => {
    // APPROVE_ALL_REASON moved to lib/constants/approve-all-reason.ts —
    // a 'use server' file may only export async functions, so the
    // shared sentinel cannot live in this module. mappings.ts imports
    // it; bulk acks stay distinguishable from manual ones.
    expect(MAPPINGS_SRC).toMatch(
      /import \{ APPROVE_ALL_REASON \} from ['"]@\/lib\/constants\/approve-all-reason['"]/,
    )
    expect(MAPPINGS_SRC).toMatch(/acknowledgment_reason: APPROVE_ALL_REASON/)
  })
})

describe('[mappings refinements] createValueAssignment emits NULL combination_sql (intentional lifecycle)', () => {
  it('createValueAssignment RPC payload sets sql: null and the header doc explains why', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function createValueAssignment(',
      'export async function regenerateFieldMappings(',
    )
    // The RPC's `p_combination` payload must explicitly include `sql: null`
    // so the TFM row materialises with combination_sql = NULL. The shim's
    // VA branch (Case 14/14b) depends on this contract.
    expect(body).toMatch(/sql:\s*null/)
    expect(body).toContain("type: 'custom_sql'")
  })

  it('createValueAssignment header doc calls out the NULL lifecycle explicitly', () => {
    // The doc string must warn future editors that NULL is intentional —
    // otherwise a "helpful" refactor that defaults combination_sql to '' or
    // a placeholder would desync the shim from transformations.generated_sql.
    const header = sliceBetween(
      MAPPINGS_SRC,
      '// ─── createValueAssignment',
      'export async function createValueAssignment(',
    )
    expect(header).toMatch(/INTENTIONAL LIFECYCLE/i)
    expect(header).toContain('transformations.generated_sql')
  })
})

describe('[shim] Refinement 4 — invariant check on is_acknowledged + combination_type', () => {
  it('shimToMappingsResult throws INVARIANT when is_acknowledged=true AND combination_type!=NULL', () => {
    // The translator performs this defence-in-depth check in TWO places:
    // (a) the acknowledgments collection step, (b) per-TFM translation.
    // Both must reference combination_type and emit ShimError('INVARIANT').
    expect(SHIM_SRC).toMatch(
      /combination_type != null[\s\S]{0,200}ShimError\([\s\S]{0,50}'INVARIANT'/,
    )
    expect(SHIM_SRC).toMatch(/is_acknowledged=true with non-null combination_type/)
  })
})

describe('[mappings] deleteTableMapping orphan cascade (Gate 3 Item 2)', () => {
  // Fixture IDs — deterministic so failure diagnostics are readable.
  const SRC_TABLE_A = 'src-a'
  const SRC_TABLE_B = 'src-b'
  const SRC_TABLE_C = 'src-c'
  const TGT_TABLE_X = 'tgt-x'
  const TGT_TABLE_Y = 'tgt-y'

  const TM_A: DeleteTmSiblingTmInput = {
    id: 'tm-a',
    source_table_id: SRC_TABLE_A,
    target_table_id: TGT_TABLE_X,
  }
  const TM_B: DeleteTmSiblingTmInput = {
    id: 'tm-b',
    source_table_id: SRC_TABLE_B,
    target_table_id: TGT_TABLE_X,
  }
  const TM_C_OTHER_TARGET: DeleteTmSiblingTmInput = {
    id: 'tm-c',
    source_table_id: SRC_TABLE_A,
    target_table_id: TGT_TABLE_Y,
  }

  it('deletes TFMs whose sources come from the deleted TM only; preserves TFMs still owned by a sibling TM; preserves VAs while any sibling targets the same table', () => {
    // Scenario: project has TM_A (src-a → tgt-x) and TM_B (src-b → tgt-x).
    // We delete TM_A. Expect:
    //   - tfm-from-A: mapped, sources = {src-a}        → orphaned (delete)
    //   - tfm-from-B: mapped, sources = {src-b}        → not owned by TM_A to begin with (preserve)
    //   - tfm-multi:  mapped, sources = {src-a, src-b} → owned by TM_A, but TM_B still owns it (preserve)
    //   - va-tfm:     VA,      sources = {}            → TM_B still targets tgt-x (preserve)
    const candidates: DeleteTmCandidateTfmInput[] = [
      { id: 'tfm-from-A', combination_type: 'single' },
      { id: 'tfm-from-B', combination_type: 'single' },
      { id: 'tfm-multi', combination_type: 'concat_space' },
      { id: 'va-tfm', combination_type: 'custom_sql' },
    ]
    const sourcesByTfm = new Map<string, Set<string>>([
      ['tfm-from-A', new Set([SRC_TABLE_A])],
      ['tfm-from-B', new Set([SRC_TABLE_B])],
      ['tfm-multi', new Set([SRC_TABLE_A, SRC_TABLE_B])],
      // va-tfm has no sources entry → treated as empty set.
    ])

    const orphaned = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: [TM_B],
      candidateTfms: candidates,
      sourcesByTfm,
    })

    expect(new Set(orphaned)).toEqual(new Set(['tfm-from-A']))
  })

  it('deletes VA TFMs when no sibling TM targets the same target table', () => {
    // Scenario: TM_A (src-a → tgt-x) is the ONLY TM targeting tgt-x.
    // TM_C targets tgt-y. Deleting TM_A should orphan VA TFMs in tgt-x.
    const candidates: DeleteTmCandidateTfmInput[] = [
      { id: 'va-tfm-1', combination_type: 'custom_sql' },
      { id: 'va-tfm-2', combination_type: 'custom_sql' },
    ]
    const orphaned = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: [TM_C_OTHER_TARGET],
      candidateTfms: candidates,
      sourcesByTfm: new Map(),
    })
    expect(new Set(orphaned)).toEqual(new Set(['va-tfm-1', 'va-tfm-2']))
  })

  it('deletes every candidate when the TM has no siblings at all', () => {
    const candidates: DeleteTmCandidateTfmInput[] = [
      { id: 'mapped', combination_type: 'single' },
      { id: 'va', combination_type: 'custom_sql' },
    ]
    const sourcesByTfm = new Map<string, Set<string>>([
      ['mapped', new Set([SRC_TABLE_A])],
    ])
    const orphaned = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: [],
      candidateTfms: candidates,
      sourcesByTfm,
    })
    expect(new Set(orphaned)).toEqual(new Set(['mapped', 'va']))
  })

  it('preserves mapped TFMs that were never in the deleted TM pairing (source_table mismatch)', () => {
    // A mapped TFM in tgt-x whose sole source is from src-c, while TM_A is
    // (src-a → tgt-x). TM_A never owned it; delete must not touch it.
    const candidates: DeleteTmCandidateTfmInput[] = [
      { id: 'stale-tfm', combination_type: 'single' },
    ]
    const sourcesByTfm = new Map<string, Set<string>>([
      ['stale-tfm', new Set([SRC_TABLE_C])],
    ])
    const orphaned = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: [],
      candidateTfms: candidates,
      sourcesByTfm,
    })
    expect(orphaned).toEqual([])
  })

  it('is a pure function — calling twice produces identical output and does not mutate inputs', () => {
    const candidates: DeleteTmCandidateTfmInput[] = [
      { id: 'a', combination_type: 'single' },
      { id: 'b', combination_type: 'custom_sql' },
    ]
    const sourcesByTfm = new Map<string, Set<string>>([['a', new Set([SRC_TABLE_A])]])
    const siblings = [TM_B]

    const r1 = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: siblings,
      candidateTfms: candidates,
      sourcesByTfm,
    })
    const r2 = computeOrphanedTfmsForTmDelete({
      targetTm: TM_A,
      siblingTms: siblings,
      candidateTfms: candidates,
      sourcesByTfm,
    })
    expect(r1).toEqual(r2)
    // Inputs unchanged.
    expect(sourcesByTfm.size).toBe(1)
    expect(sourcesByTfm.get('a')!.has(SRC_TABLE_A)).toBe(true)
    expect(siblings).toHaveLength(1)
  })
})

describe('[mappings refinements] locked invariants (Gate 2 § "EVERYTHING ELSE LOCKED")', () => {
  it('cleanupOrphanedContributors is a no-op stub (Design Call E)', () => {
    const body = sliceBetween(
      MAPPINGS_SRC,
      'export async function cleanupOrphanedContributors(',
      'export async function updateFieldMappingStatus(',
    )
    expect(body).toContain('return { promoted: 0, demoted: 0 }')
  })

  it('checkFieldMappingHasTransform is re-exported (Design Call D)', () => {
    expect(MAPPINGS_SRC).toMatch(/export\s*\{[\s\S]*checkFieldMappingHasTransform/)
  })

  it('SHIMMED_ID_SEPARATOR is exported from the shim as a constant', () => {
    expect(SHIM_SRC).toContain("export const SHIMMED_ID_SEPARATOR = '::'")
  })

  it('recomputeTableMappingStatus documents the cross-TM coverage rule verbatim', () => {
    // The comment block describing "TM-scoped for mapped coverage;
    // project-scoped for acknowledgments" must be present verbatim so
    // future edits preserve the semantics.
    expect(MAPPINGS_SRC).toMatch(/TM-scoped/i)
    expect(MAPPINGS_SRC).toMatch(/project-scoped/i)
    expect(MAPPINGS_SRC).toMatch(/COVERAGE MODEL/)
  })
})
