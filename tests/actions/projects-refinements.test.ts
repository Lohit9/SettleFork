import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3d (Step 3D-11) rewrite of
 * `getProjectsWithStats`.
 *
 * File-location note (Prompt 3d, Step 3D-14 Path A refactor):
 * The aggregation body was moved from `lib/actions/projects.ts` into
 * `lib/actions/_projects-core.ts :: getProjectsWithStatsInternal`
 * so Heritage integration tests can call it outside a Next.js
 * request scope (the wrapper's `createClient()` transitively reads
 * `cookies()` which is request-only). The invariants below test the
 * CORE file — the wrapper is a one-liner and has no source-level
 * shape to assert.
 *
 * Scope (per Gate 2 §1.11):
 *   - Site 199 (ack counting): `field_acknowledgments` query replaced
 *     with `source_field_acknowledgments` + bare-ack TFM union, matching
 *     the Q5 pattern formalized in `lib/quality/readiness-score.ts`.
 *   - Site 213 (mapping rollup): `field_mappings` query replaced with
 *     `target_field_mappings` (+ nested `mapping_sources`), scoped
 *     directly by `project_id` (no TM hop).
 *   - Sites 227-234 (transformations): column rename
 *     `field_mapping_id` → `target_field_mapping_id`.
 *
 * Aggregation-loop semantics (per directive):
 *   - `mappedFieldCount`   = non-rejected, non-bare-ack TFMs
 *   - `primaryMappingCount` = non-bare-ack TFMs (collapses is_contributing)
 *   - `allPrimaryApproved` = all non-bare-ack TFMs have status='approved'
 *   - `mappedSourceFieldIds` = union of every MS.source_field_id on
 *     non-rejected TFMs (primary + contributor — same union as legacy)
 *   - `mappedTargetFieldIds` = TFM.target_field_id for non-rejected,
 *     non-bare-ack TFMs
 *   - `acknowledgedFieldIds` = source_field_acknowledgments.source_field_id
 *     UNION bare-ack TFM.target_field_id (Q5)
 *   - `needsTransformIds` / `coveredTransformIds`: TFM.needs_transformation
 *     gated on status='approved'; transformations keyed by
 *     target_field_mapping_id.
 *
 * Phase bucketing logic (Ingestion/Mapping/Transform/Validate/Output)
 * is UNCHANGED — just sourced from the new bucket shape.
 *
 * Guard wiring: NONE. `getProjectsWithStats` is read-only; other
 * mutating functions in this file target `projects` / `datasets` /
 * `activity_log`, not mapping shape.
 */

const PATH = resolve(__dirname, '../../lib/actions/_projects-core.ts')
const SRC = readFileSync(PATH, 'utf8')

// Thin-wrapper invariant (projects.ts side): the server-action
// wrapper must delegate to the core function without inlining the
// aggregation. If this path drifts, the `cookies()-outside-request-
// scope` hazard that prompted the Path A split will resurface.
const WRAPPER_PATH = resolve(__dirname, '../../lib/actions/projects.ts')
const WRAPPER_SRC = readFileSync(WRAPPER_PATH, 'utf8')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function statsBody(): string {
  // Core file is single-function: everything from the module-level
  // docblock through EOF IS the function + its surrounding
  // documentation. Returning the whole file preserves the semantics
  // of the legacy slicer (header docs + body) after the Path A
  // split collapsed the file to a single unit.
  return SRC
}

function round2Slice(): string {
  const start = SRC.indexOf('const DUMMY_ID')
  const end = SRC.indexOf('// Round 3:', start)
  if (start < 0 || end < 0) throw new Error('round 2 slice markers not found')
  return SRC.slice(start, end)
}

function round3Slice(): string {
  const start = SRC.indexOf('// Round 3:')
  const end = SRC.indexOf('// Round 4:', start)
  if (start < 0 || end < 0) throw new Error('round 3 slice markers not found')
  return SRC.slice(start, end)
}

function round4Slice(): string {
  const start = SRC.indexOf('// Round 4:')
  const end = SRC.indexOf('// Build lookup maps', start)
  if (start < 0 || end < 0) throw new Error('round 4 slice markers not found')
  return SRC.slice(start, end)
}

function tfmRollupSlice(): string {
  const start = SRC.indexOf('// ── TFM rollup')
  const end = SRC.indexOf(';(qualityIssues', start)
  if (start < 0 || end < 0) throw new Error('TFM rollup slice markers not found')
  return SRC.slice(start, end)
}

function transformationsLoopSlice(): string {
  const start = SRC.indexOf(';(transformations || []).forEach')
  const end = SRC.indexOf(';(outputs || []).forEach', start)
  if (start < 0 || end < 0) throw new Error('transformations loop markers not found')
  return SRC.slice(start, end)
}

function acksUnionSlice(): string {
  const start = SRC.indexOf('// ── Q5 acknowledgedFieldIds union')
  const end = SRC.indexOf('// ── TFM rollup', start)
  if (start < 0 || end < 0) throw new Error('acks union slice markers not found')
  return SRC.slice(start, end)
}

// ── Zero legacy refs ─────────────────────────────────────────────────────────

describe('[projects refinements] zero legacy refs', () => {
  it('no .from(field_mappings) calls anywhere in code', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls anywhere (replaced by source_field_acknowledgments)', () => {
    expect(stripComments(SRC)).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no legacy is_contributing column reference anywhere in code', () => {
    expect(stripComments(SRC)).not.toMatch(/\bis_contributing\b/)
  })

  it('no legacy field_mapping_id column reference in code (distinct from target_field_mapping_id)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/(?<!target_)field_mapping_id/)
  })

  it('no legacy fmToTM map variable remains (TFM→project is direct now)', () => {
    expect(stripComments(SRC)).not.toMatch(/\bfmToTM\b/)
  })

  it('no legacy fieldMappings variable / fieldMappingIds variable remain', () => {
    expect(stripComments(SRC)).not.toMatch(/\bfieldMappings\b/)
    expect(stripComments(SRC)).not.toMatch(/\bfieldMappingIds\b/)
  })

  it('no legacy fieldAcks variable remains (renamed to sourceFieldAcks)', () => {
    expect(stripComments(SRC)).not.toMatch(/\bfieldAcks\b/)
  })
})

// ── Round 2: source_field_acknowledgments ────────────────────────────────────

describe('[projects refinements] Round 2 — source_field_acknowledgments', () => {
  const body = round2Slice()
  const code = stripComments(body)

  it('fetches .from(source_field_acknowledgments) with project + source_field_id projection', () => {
    expect(code).toMatch(/\.from\(\s*['"]source_field_acknowledgments['"]\s*\)/)
    expect(code).toMatch(/\.select\(\s*['"]project_id,\s*source_field_id['"]\s*\)/)
    expect(code).toMatch(/\.in\(\s*['"]project_id['"]\s*,\s*projectIds\s*\)/)
  })

  it('destructures sourceFieldAcks (NOT legacy fieldAcks)', () => {
    expect(code).toMatch(/data:\s*sourceFieldAcks/)
  })

  it('documents the Q5 union intent at the fetch site', () => {
    expect(body).toMatch(/Q5 union part 1/)
  })
})

// ── Round 3: target_field_mappings + nested mapping_sources ──────────────────

describe('[projects refinements] Round 3 — TFM + mapping_sources fetch', () => {
  const body = round3Slice()
  const code = stripComments(body)

  it('fetches .from(target_field_mappings) (not field_mappings)', () => {
    expect(code).toMatch(/\.from\(\s*['"]target_field_mappings['"]\s*\)/)
  })

  it('scopes directly by project_id (TFMs are project-scoped, no TM hop)', () => {
    expect(code).toMatch(/\.in\(\s*['"]project_id['"]\s*,\s*projectIds\s*\)/)
  })

  it('does NOT scope by table_mapping_id (new-model TFMs have no such column)', () => {
    expect(code).not.toMatch(/\.in\(\s*['"]table_mapping_id['"]/)
  })

  it('selects TFM columns needed for rollup (id, project_id, target_field_id, status, is_acknowledged, combination_type, needs_transformation)', () => {
    expect(code).toMatch(
      /\.select\(\s*['"]id,\s*project_id,\s*target_field_id,\s*status,\s*is_acknowledged,\s*combination_type,\s*needs_transformation/
    )
  })

  it('nests mapping_sources(source_field_id, ordinal) for the source-field union', () => {
    expect(code).toMatch(/mapping_sources\(\s*source_field_id,\s*ordinal\s*\)/)
  })

  it('binds to tfmRows (not legacy fieldMappings)', () => {
    expect(code).toMatch(/data:\s*tfmRows/)
  })

  it('exposes tfms as TfmRollupRow[]', () => {
    expect(code).toMatch(/const\s+tfms\s*=.*TfmRollupRow\[\]/)
  })
})

// ── Round 4: transformations column rename ───────────────────────────────────

describe('[projects refinements] Round 4 — transformations column rename', () => {
  const body = round4Slice()
  const code = stripComments(body)

  it('selects target_field_mapping_id (NOT field_mapping_id)', () => {
    expect(code).toMatch(/\.select\(\s*['"]target_field_mapping_id,\s*status['"]\s*\)/)
  })

  it('filters by target_field_mapping_id (NOT field_mapping_id)', () => {
    expect(code).toMatch(/\.in\(\s*['"]target_field_mapping_id['"]\s*,\s*tfmIds\s*\)/)
  })

  it('guards on tfmIds.length > 0 (preserved zero-length skip)', () => {
    expect(code).toMatch(/tfmIds\.length\s*>\s*0/)
  })

  it('empty-data type annotation uses the new target_field_mapping_id column', () => {
    expect(code).toMatch(/target_field_mapping_id:\s*string;\s*status:\s*string/)
  })
})

// ── Lookup map rewire (tfmToProject replaces fmToTM) ─────────────────────────

describe('[projects refinements] lookup maps', () => {
  const body = statsBody()
  const code = stripComments(body)

  it('builds tfmToProject map keyed by TFM id (direct, no TM hop)', () => {
    expect(code).toMatch(/const\s+tfmToProject\s*=\s*new\s+Map<string,\s*string>\(\)/)
    expect(code).toMatch(/tfmToProject\.set\(\s*t\.id\s*,\s*t\.project_id\s*\)/)
  })

  it('documents that tfmToProject replaces the legacy two-hop fmToTM → tmToProject chain', () => {
    expect(body).toMatch(/two-hop|no TM hop/i)
  })
})

// ── Acknowledgments union (Q5 part 1) ────────────────────────────────────────

describe('[projects refinements] acknowledgedFieldIds — source-side union', () => {
  const body = acksUnionSlice()
  const code = stripComments(body)

  it('iterates sourceFieldAcks and adds a.source_field_id to buckets[a.project_id].acknowledgedFieldIds', () => {
    expect(code).toMatch(/sourceFieldAcks\s*\|\|\s*\[\]/)
    expect(code).toMatch(
      /b\.acknowledgedFieldIds\.add\(\s*a\.source_field_id\s*\)/
    )
  })

  it('documents that bare-ack TFMs are folded in by the TFM loop (single-walk optimization)', () => {
    expect(body).toMatch(/bare-ack/)
    expect(body).toMatch(/Q5/i)
  })
})

// ── TFM rollup (Q5 part 2 + mapping counts + source union) ───────────────────

describe('[projects refinements] TFM rollup loop', () => {
  const body = tfmRollupSlice()
  const code = stripComments(body)

  it('iterates tfms and derives project via tfm.project_id directly', () => {
    expect(code).toMatch(/tfms\.forEach/)
    expect(code).toMatch(/buckets\.get\(\s*tfm\.project_id\s*\)/)
  })

  it('identifies bare-ack TFMs as is_acknowledged && combination_type === null', () => {
    expect(code).toMatch(
      /isBareAck\s*=\s*tfm\.is_acknowledged\s*&&\s*tfm\.combination_type\s*===\s*null/
    )
  })

  it('bare-ack TFMs contribute target_field_id to acknowledgedFieldIds (Q5 part 2)', () => {
    expect(code).toMatch(
      /if\s*\(\s*isBareAck\s*\)\s*\{[\s\S]*?b\.acknowledgedFieldIds\.add\(\s*tfm\.target_field_id\s*\)[\s\S]*?return/
    )
  })

  it('bare-ack TFMs do NOT count toward primaryMappingCount or mappedFieldCount (readiness-score Q5 parity)', () => {
    // The early `return` inside the isBareAck branch ensures bare-acks
    // skip the mapping-count increments below.
    expect(code).toMatch(/if\s*\(\s*isBareAck\s*\)\s*\{[\s\S]*?return/)
  })

  it('primaryMappingCount increments for every non-bare-ack TFM (is_contributing collapsed)', () => {
    expect(code).toMatch(/b\.primaryMappingCount\+\+/)
  })

  it('allPrimaryApproved = false when any non-bare-ack TFM is not approved', () => {
    expect(code).toMatch(/if\s*\(\s*tfm\.status\s*!==\s*['"]approved['"]\s*\)\s*b\.allPrimaryApproved\s*=\s*false/)
  })

  it('mappedFieldCount increments only for non-rejected non-bare-ack TFMs', () => {
    expect(code).toMatch(
      /if\s*\(\s*tfm\.status\s*!==\s*['"]rejected['"]\s*\)\s*\{[\s\S]*?b\.mappedFieldCount\+\+/
    )
  })

  it('mappedTargetFieldIds includes TFM.target_field_id for non-rejected non-bare-ack TFMs', () => {
    expect(code).toMatch(
      /b\.mappedTargetFieldIds\.add\(\s*tfm\.target_field_id\s*\)/
    )
  })

  it('needsTransformIds tracks approved + needs_transformation TFM ids', () => {
    expect(code).toMatch(
      /tfm\.status\s*===\s*['"]approved['"]\s*&&\s*tfm\.needs_transformation/
    )
    expect(code).toMatch(/b\.needsTransformIds\.add\(\s*tfm\.id\s*\)/)
  })

  it('mappedSourceFieldIds iterates EVERY mapping_sources row (primary + contributor)', () => {
    expect(code).toMatch(/for\s*\(\s*const\s+ms\s+of\s+tfm\.mapping_sources/)
    expect(code).toMatch(/b\.mappedSourceFieldIds\.add\(\s*ms\.source_field_id\s*\)/)
  })

  it('mappedSourceFieldIds union skips rejected TFMs (preserves legacy `status !== rejected`)', () => {
    // The for-of over mapping_sources sits INSIDE an outer
    // `if (tfm.status !== 'rejected')` guard.
    expect(code).toMatch(
      /if\s*\(\s*tfm\.status\s*!==\s*['"]rejected['"]\s*\)\s*\{\s*for\s*\(\s*const\s+ms\s+of\s+tfm\.mapping_sources/
    )
  })

  it('documents the Q5 bare-ack convention inline (readiness-score alignment)', () => {
    expect(body).toMatch(/readiness-score\.ts|Q5/)
  })

  it('documents the is_contributing collapse inline', () => {
    expect(body).toMatch(/is_contributing/)
  })
})

// ── Transformations loop (column rename + direct TFM→project lookup) ─────────

describe('[projects refinements] transformations loop', () => {
  const body = transformationsLoopSlice()
  const code = stripComments(body)

  it('derives project via tfmToProject.get(t.target_field_mapping_id) (no FM→TM→project hop)', () => {
    expect(code).toMatch(
      /tfmToProject\.get\(\s*t\.target_field_mapping_id\s*\)/
    )
  })

  it('no reference to legacy fmToTM lookup or t.field_mapping_id', () => {
    expect(code).not.toMatch(/fmToTM/)
    expect(code).not.toMatch(/t\.field_mapping_id/)
  })

  it('needsTransformIds.has() keyed by t.target_field_mapping_id', () => {
    expect(code).toMatch(
      /b\.needsTransformIds\.has\(\s*t\.target_field_mapping_id\s*\)/
    )
  })

  it('coveredTransformIds.add() uses t.target_field_mapping_id', () => {
    expect(code).toMatch(
      /b\.coveredTransformIds\.add\(\s*t\.target_field_mapping_id\s*\)/
    )
  })

  it('preserves totalTransforms and savedTransforms increments (saved|applied)', () => {
    expect(code).toMatch(/b\.totalTransforms\+\+/)
    expect(code).toMatch(/t\.status\s*===\s*['"]saved['"]\s*\|\|\s*t\.status\s*===\s*['"]applied['"]/)
  })
})

// ── TfmRollupRow type shape ──────────────────────────────────────────────────

describe('[projects refinements] TfmRollupRow type', () => {
  it('declares project_id, target_field_id, status, is_acknowledged, combination_type, needs_transformation', () => {
    const code = stripComments(SRC)
    expect(code).toMatch(/type\s+TfmRollupRow\s*=\s*\{[\s\S]*?project_id:\s*string/)
    expect(code).toMatch(/target_field_id:\s*string/)
    expect(code).toMatch(/status:\s*string/)
    expect(code).toMatch(/is_acknowledged:\s*boolean/)
    expect(code).toMatch(/combination_type:\s*string\s*\|\s*null/)
    expect(code).toMatch(/needs_transformation:\s*boolean\s*\|\s*null/)
  })

  it('declares nested mapping_sources array with source_field_id + ordinal', () => {
    const code = stripComments(SRC)
    expect(code).toMatch(
      /mapping_sources:\s*Array<\{\s*source_field_id:\s*string\s*\|\s*null;\s*ordinal:\s*number\s*\}>/
    )
  })
})

// ── Phase bucketing logic unchanged ──────────────────────────────────────────

describe('[projects refinements] phase bucketing unchanged', () => {
  const body = statsBody()
  const code = stripComments(body)

  it('Phase 1 (Ingestion) still gated on hasSourceTables && hasTargetTables', () => {
    expect(code).toMatch(/ingestionDone\s*=\s*b\.hasSourceTables\s*&&\s*b\.hasTargetTables/)
  })

  it('Phase 2 (Mapping) still gated on hasMappings && allPrimaryApproved && addressed>=total', () => {
    expect(code).toMatch(
      /mappingDone\s*=\s*hasMappings\s*&&\s*b\.allPrimaryApproved\s*&&\s*totalFields\s*>\s*0\s*&&\s*addressedCount\s*>=\s*totalFields/
    )
  })

  it('Phase 3 (Transform) still gated on needsTransformIds coverage', () => {
    expect(code).toMatch(/b\.coveredTransformIds\.size\s*>=\s*b\.needsTransformIds\.size/)
  })

  it('Phase 4 (Validate) still gated on totalQualityIssues>0 && blockingIssueCount===0', () => {
    expect(code).toMatch(
      /validateDone\s*=\s*b\.totalQualityIssues\s*>\s*0\s*&&\s*b\.blockingIssueCount\s*===\s*0/
    )
  })

  it('Phase 5 (Output) still gated on outputCount > 0', () => {
    expect(code).toMatch(/b\.outputCount\s*>\s*0/)
  })

  it('preserves the Phase2 allMappedOrAckedIds union of source + target + acknowledged field ids', () => {
    expect(code).toMatch(
      /allMappedOrAckedIds\s*=\s*new\s+Set\(\s*\[\s*\.\.\.b\.mappedSourceFieldIds,\s*\.\.\.b\.mappedTargetFieldIds,\s*\.\.\.b\.acknowledgedFieldIds\s*\]\s*\)/
    )
  })
})

// ── Guard-wiring decision (NONE) ─────────────────────────────────────────────

describe('[projects refinements] guard-wiring decision', () => {
  it('no assertMappingWritesEnabled import or call in core (read-only function; other writers target non-mapping-shape tables)', () => {
    const code = stripComments(SRC)
    expect(code).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('no assertMappingWritesEnabled in the wrapper either (wrapper is one-line delegation)', () => {
    const wrapperCode = stripComments(WRAPPER_SRC)
    expect(wrapperCode).not.toMatch(/assertMappingWritesEnabled/)
  })

  it('documents the Guard-wiring decision in the core docblock', () => {
    // After the Path A split (3D-14), the decision lives in the
    // module-level JSDoc of `_projects-core.ts`, not a `// Guard-
    // wiring decision` line-comment above the function. The test
    // looks for the phrase anywhere in the core source.
    const start = SRC.indexOf('Guard-wiring decision')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = SRC.indexOf('export async function getProjectsWithStatsInternal')
    expect(end).toBeGreaterThan(start)
    const slice = SRC.slice(start, end)
    expect(slice).toMatch(/Guard-wiring decision/i)
    expect(slice).toMatch(/READ-ONLY/i)
    expect(slice).toMatch(/mapping-shape/i)
    expect(slice).toMatch(/Prompt 3d,?\s*Step 3D-11/)
  })
})

// ── NEW-MODEL NOTE header presence ───────────────────────────────────────────

describe('[projects refinements] NEW-MODEL NOTE header', () => {
  const body = statsBody()

  it('documents the three rewrite sites (acks / TFM / transformations column rename)', () => {
    expect(body).toMatch(/NEW-MODEL NOTE/i)
    expect(body).toMatch(/Step 3D-11/)
    expect(body).toMatch(/source_field_acknowledgments/)
    expect(body).toMatch(/target_field_mappings/)
    expect(body).toMatch(/target_field_mapping_id/)
  })

  it('documents the bare-ack bucket handling (Q5 parity)', () => {
    expect(body).toMatch(/bare-ack/)
    expect(body).toMatch(/acknowledgedFieldIds/)
    expect(body).toMatch(/mappedFieldCount|primaryMappingCount/)
  })

  it('documents the 3D-14 integration-test callout for owning-TM rule fallback', () => {
    expect(body).toMatch(/3D-14|owning-TM/i)
  })
})
