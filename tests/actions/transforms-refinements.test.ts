import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for the Prompt-3b rewrite of
 * `lib/actions/transformations.ts` and `lib/actions/fk-cascade.ts`.
 *
 * Each test pins a decision from Gate 2:
 *
 *   R1  resolveTfmId — Option 2-narrow: helper lives in transformations.ts,
 *       is NOT exported, handles both bare and composite (`tfm::ms`) ids.
 *       fk-cascade.ts does NOT import from `lib/compat/mapping-shim`.
 *   R2  Apply RPC wiring — mapped TFMs route through
 *       `dq_apply_field_transform_joined`; VAs fall back to the legacy
 *       `dq_apply_field_transform` looped over every TM matching the
 *       target table (Gate 2 G-a).
 *   R3  Cascade RPC — `cascadeTransformToFKs` uses
 *       `dq_apply_field_transform_joined` exclusively (Gate 2 G-a note).
 *   R4  `needs_transformation` — the flag lives on `target_field_mappings`
 *       (migration 075) and is updated through the new table, never via
 *       the legacy `field_mappings` column.
 *   R5  FK dependent filtering — `findFKDependents` excludes VAs
 *       (`combination_type !== 'custom_sql'`), rejected TFMs, and
 *       acknowledged TFMs; includes an EXISTS-mapping_sources defensive
 *       filter (Gate 2 Precision P1).
 *   R6  Single-transformation invariant is documented in the file header
 *       (Gate 2 Q3 3a).
 *   R7  `resolveTfmId` uses the `[transformations]` namespace-tag logging
 *       convention (Gate 2 Precision P2).
 *
 * These tests are source-text based for the same reason as
 * `mappings-refinements.test.ts`: mocking Supabase's chainable query
 * builder is strictly worse than grepping the source for the exact call
 * patterns we care about. See `docs/prompt-3a-remaining-work.md` §Test
 * coverage debt.
 */

const TRANSFORMS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const FK_CASCADE_PATH = resolve(__dirname, '../../lib/actions/fk-cascade.ts')

const TRANSFORMS_SRC = readFileSync(TRANSFORMS_PATH, 'utf8')
const FK_CASCADE_SRC = readFileSync(FK_CASCADE_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─── R1: resolveTfmId semantics ──────────────────────────────────────────────

describe('[transforms refinements] R1 — resolveTfmId (Option 2-narrow)', () => {
  it('resolveTfmId is defined in transformations.ts and is NOT exported', () => {
    expect(TRANSFORMS_SRC).toMatch(/function\s+resolveTfmId\s*\(/)
    expect(TRANSFORMS_SRC).not.toMatch(/export\s+function\s+resolveTfmId\b/)
    expect(TRANSFORMS_SRC).not.toMatch(/export\s*\{[^}]*resolveTfmId/)
  })

  it('resolveTfmId recognises both bare UUID and composite tfm::ms shapes', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'function resolveTfmId(',
      '// ─── TFM context resolver',
    )
    expect(body).toContain("kind: 'primary'")
    expect(body).toContain("kind: 'contributor'")
    expect(body).toContain('SHIMMED_ID_SEPARATOR')
    expect(body).toMatch(/UUID_REGEX/)
  })

  it('fk-cascade.ts does NOT import from lib/compat/mapping-shim', () => {
    expect(FK_CASCADE_SRC).not.toMatch(/from\s+['"]@\/lib\/compat\/mapping-shim['"]/)
    // The file declares its OWN literal separator and documents the link.
    expect(FK_CASCADE_SRC).toContain("SHIMMED_ID_SEPARATOR_LITERAL = '::'")
  })
})

// ─── R2: Apply RPC wiring ────────────────────────────────────────────────────

describe('[transforms refinements] R2 — applyTransform RPC wiring (mapped vs VA)', () => {
  it('applyTransform calls dq_apply_field_transform_joined for mapped TFMs', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function applyTransform(',
      'export async function revertTransform(',
    )
    expect(body).toContain("'dq_apply_field_transform_joined'")
    // The mapped branch passes the TFM id directly and leaves join_spec null.
    expect(body).toMatch(/p_target_field_mapping_id:\s*ctx\.tfm\.id/)
    expect(body).toMatch(/p_join_spec:\s*null/)
  })

  it('applyTransform falls back to dq_apply_field_transform for VAs', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function applyTransform(',
      'export async function revertTransform(',
    )
    expect(body).toContain("'dq_apply_field_transform'")
    // VAs loop every TM sharing the target_table_id (global per target table).
    expect(body).toMatch(/isValueAssignment/)
  })
})

// ─── R2c: Cross-table apply transparency (Phase 4a-3) ───────────────────────

describe('[transforms refinements] R2c — applyTransform cross-table guard', () => {
  it('TransformWriteErrorCode union includes CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED', () => {
    expect(TRANSFORMS_SRC).toMatch(/CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED/)
    // Must appear in the union, not just a stray string.
    expect(TRANSFORMS_SRC).toMatch(/export\s+type\s+TransformWriteErrorCode[\s\S]*?CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED/)
  })

  it('isCrossTableTfm helper is defined and queries mapping_sources by source_table_id', () => {
    expect(TRANSFORMS_SRC).toMatch(/async\s+function\s+isCrossTableTfm\s*\(/)
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'async function isCrossTableTfm(',
      '// ─── applyTransform',
    )
    expect(body).toMatch(/from\(['"]mapping_sources['"]\)/)
    expect(body).toMatch(/select\(['"]source_table_id['"]\)/)
    expect(body).toMatch(/eq\(['"]target_field_mapping_id['"]/)
    // Distinct count > 1 logic.
    expect(body).toMatch(/Set/)
    expect(body).toMatch(/distinct\.size\s*>\s*1/)
  })

  it('applyTransform short-circuits with CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED for cross-table TFMs', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function applyTransform(',
      'export async function revertTransform(',
    )
    expect(body).toMatch(/isCrossTableTfm\s*\(\s*ctx\.tfm\.id\s*\)/)
    expect(body).toMatch(/errorCode:\s*['"]CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED['"]/)
    // Guard fires only for mapped TFMs (not VAs).
    expect(body).toMatch(/!isValueAssignment[\s\S]{0,200}isCrossTableTfm/)
  })
})

// ─── R3: Cascade RPC is joined-only ──────────────────────────────────────────

describe('[transforms refinements] R3 — cascadeTransformToFKs is joined-only', () => {
  it('cascadeTransformToFKs uses dq_apply_field_transform_joined', () => {
    const body = sliceBetween(
      FK_CASCADE_SRC,
      'export async function cascadeTransformToFKs(',
      'export async function resetFKDependentTransforms(',
    )
    expect(body).toContain("'dq_apply_field_transform_joined'")
  })

  it('cascadeTransformToFKs never calls the legacy dq_apply_field_transform RPC', () => {
    const body = sliceBetween(
      FK_CASCADE_SRC,
      'export async function cascadeTransformToFKs(',
      'export async function resetFKDependentTransforms(',
    )
    // Substring check — `dq_apply_field_transform_joined` also contains
    // the legacy name, so we assert the VA-only RPC token is absent.
    expect(body).not.toMatch(/['"]dq_apply_field_transform['"]/)
  })
})

// ─── R4: needs_transformation lives on target_field_mappings ────────────────

describe('[transforms refinements] R4 — needs_transformation on target_field_mappings', () => {
  it('dismissTransformNeeded updates target_field_mappings.needs_transformation', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function dismissTransformNeeded(',
      'export async function reinstateTransformNeeded(',
    )
    expect(body).toContain("from('target_field_mappings')")
    expect(body).toMatch(/needs_transformation:\s*false/)
  })

  it('reinstateTransformNeeded updates target_field_mappings.needs_transformation', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function reinstateTransformNeeded(',
      'export async function resetFieldTransform(',
    )
    expect(body).toContain("from('target_field_mappings')")
    expect(body).toMatch(/needs_transformation:\s*true/)
  })

  it('cascadeTransformToFKs flags the FK TFM via target_field_mappings.needs_transformation', () => {
    const body = sliceBetween(
      FK_CASCADE_SRC,
      'export async function cascadeTransformToFKs(',
      'export async function resetFKDependentTransforms(',
    )
    expect(body).toContain("from('target_field_mappings')")
    expect(body).toMatch(/needs_transformation:\s*true/)
  })

  it('fk-cascade.ts never writes the legacy field_mappings.needs_transformation column', () => {
    // Defense against rebase accidents: the legacy column was dropped in
    // migration 074 and its replacement lives on target_field_mappings.
    expect(FK_CASCADE_SRC).not.toMatch(/from\(['"]field_mappings['"]\)[\s\S]{0,120}needs_transformation/)
  })
})

// ─── R5: findFKDependents filtering ──────────────────────────────────────────

describe('[transforms refinements] R5 — findFKDependents filters (Gate 2 P1)', () => {
  const BODY = sliceBetween(
    FK_CASCADE_SRC,
    'export async function findFKDependents(',
    'export async function cascadeTransformToFKs(',
  )

  it('queries target_field_mappings (new model) and excludes rejected/acknowledged', () => {
    expect(BODY).toContain("from('target_field_mappings')")
    expect(BODY).toMatch(/\.neq\(['"]status['"],\s*['"]rejected['"]\)/)
    expect(BODY).toMatch(/\.eq\(['"]is_acknowledged['"],\s*false\)/)
  })

  it('excludes Value Assignment TFMs (combination_type === custom_sql)', () => {
    expect(BODY).toMatch(/combination_type\s*!==\s*['"]custom_sql['"]/)
  })

  it('defensively drops TFMs with no mapping_sources rows', () => {
    expect(BODY).toContain("from('mapping_sources')")
    expect(BODY).toMatch(/liveTfmIds/)
  })

  it('existing transformations lookup keys on target_field_mapping_id', () => {
    expect(BODY).toContain("from('transformations')")
    expect(BODY).toMatch(/target_field_mapping_id/)
    // Legacy column name must be absent from this slice.
    expect(BODY).not.toMatch(/\bfield_mapping_id\b/)
  })
})

// ─── R6: Single-transformation invariant documented in header ────────────────

describe('[transforms refinements] R6 — single-transformation invariant header', () => {
  it('transformations.ts header documents the COUNT ≤ 1 per TFM invariant', () => {
    // The header comment block must explain that there is at most one
    // transformation per target_field_mapping_id. This pairs with the
    // env-gated invariant test in
    // `tests/integration/transformations-unique-invariant.test.ts`.
    const head = TRANSFORMS_SRC.slice(0, 5000)
    expect(head).toMatch(/COUNT[\s\S]{0,120}target_field_mapping_id[\s\S]{0,80}≤\s*1/)
  })
})

// ─── R7: logging convention ──────────────────────────────────────────────────

describe('[transforms refinements] R7 — resolveTfmId uses [transformations] tag', () => {
  it('warn paths include the [transformations] namespace tag', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'function resolveTfmId(',
      '// ─── TFM context resolver',
    )
    expect(body).toMatch(/console\.warn\(['"]?\[transformations\]/)
  })
})

// ─── Re-export sanity ────────────────────────────────────────────────────────

describe('[transforms refinements] public API sanity', () => {
  it('re-exports fieldNeedsTransform and wrapFieldRefsInJsonb for legacy callers', () => {
    expect(TRANSFORMS_SRC).toMatch(/export\s*\{\s*fieldNeedsTransform,\s*wrapFieldRefsInJsonb\s*\}/)
  })

  it('resetFieldTransform accepts the skipFKCascade option', () => {
    const body = sliceBetween(
      TRANSFORMS_SRC,
      'export async function resetFieldTransform(',
      'export async function checkFieldMappingHasTransform(',
    )
    expect(body).toMatch(/skipFKCascade\?:\s*boolean/)
    expect(body).toMatch(/skipFKCascade/)
  })
})
