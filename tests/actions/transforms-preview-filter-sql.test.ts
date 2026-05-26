import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for PR Ω.3.3 — preview path honors
 * `table_mappings.filter_sql`.
 *
 * Companion to `transforms-apply-filter-sql.test.ts` (PR Ω.2). Same source-
 * grep strategy: pin the call patterns so a future refactor can't drop the
 * filter plumbing or invert the conditional-spread semantics.
 *
 * Behavioral end-to-end coverage lives in the env-gated integration test
 * tier (deferred — see `tests/integration/preview-filter-sql.test.ts` to be
 * added when a synthetic-JWT harness for permission-gated RPCs lands).
 *
 * Pinned invariants:
 *
 *   FP1 All 3 preview actions read `ctx.tableMapping?.filter_sql`.
 *   FP2 `assertNoDml(rawFilter)` runs before wrapping in all 3.
 *   FP3 Wrapping uses `wrapFieldRefsInJsonb` with the same arg shape transform
 *       SQL uses: cross-table → fieldMap + alias-strip; same-table → fieldNames.
 *       (testTransformation has the cross-table branch; the other two are
 *       same-table only.)
 *   FP4 Conditional spread for `p_filter_sql` at every `.rpc()` call:
 *       1 in testTransformation (consolidated from 3 ternary branches in
 *       pre-Ω.3.3), 1 in runFullTransformTest, 1 in previewTransformDistinct.
 *   FP5 No literal `p_filter_sql: null` in any rpc-args object initializer.
 *       Defends against Supabase JS treating `{x: null}` differently from
 *       `{}` in some RPC versions. Mirrors Ω.2's F9 invariant.
 *   FP6 Heritage RPC call shape preserved — every initializer carries the
 *       existing params regardless of filter state.
 *   FP7 Migration 113 DROPs the 4 old signatures + CREATEs with new 5-arg
 *       form.
 *   FP8 Migration 113 wraps the dynamic-SQL sites in BEGIN/EXCEPTION with
 *       filter-aware re-attribution.
 */

const TRANSFORMS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const TRANSFORMS_SRC = readFileSync(TRANSFORMS_PATH, 'utf8')

const MIGRATION_PATH = resolve(
  __dirname,
  '../../supabase/migrations/113_preview_path_filter_sql.sql',
)
const MIGRATION_SRC = readFileSync(MIGRATION_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const FULL_TEST_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function runFullTransformTest(',
  '// ─── testTransformation',
)
const TEST_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function testTransformation(',
  '// ─── saveTransformation',
)
const PREVIEW_DISTINCT_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function previewTransformDistinct(',
  '// ─── suggestTransformDescription',
)

// ─── FP1 — All 3 actions read ctx.tableMapping?.filter_sql ──────────────────

describe('[preview-filter-sql] FP1 — each action reads ctx.tableMapping?.filter_sql', () => {
  for (const [name, body] of [
    ['testTransformation', TEST_BODY],
    ['runFullTransformTest', FULL_TEST_BODY],
    ['previewTransformDistinct', PREVIEW_DISTINCT_BODY],
  ] as const) {
    it(`${name} reads ctx.tableMapping?.filter_sql with ?? null fallback`, () => {
      expect(body).toMatch(/ctx\.tableMapping\?\.filter_sql\s*\?\?\s*null/)
    })
  }
})

// ─── FP2 — assertNoDml(rawFilter) runs before wrapping ──────────────────────

describe('[preview-filter-sql] FP2 — assertNoDml(rawFilter) before wrapping', () => {
  for (const [name, body] of [
    ['testTransformation', TEST_BODY],
    ['runFullTransformTest', FULL_TEST_BODY],
    ['previewTransformDistinct', PREVIEW_DISTINCT_BODY],
  ] as const) {
    it(`${name} calls assertNoDml(rawFilter) inside an if (rawFilter) guard`, () => {
      expect(body).toMatch(/if\s*\(\s*rawFilter\s*\)\s*\{[\s\S]*?assertNoDml\(\s*rawFilter\s*\)/)
    })

    it(`${name}: assertNoDml call precedes wrapFieldRefsInJsonb(rawFilter, …)`, () => {
      const assertIdx = body.indexOf('assertNoDml(\n      rawFilter')
      // Fallback to less-tight match
      const fallbackAssertIdx = body.indexOf('assertNoDml(rawFilter)')
      const finalAssertIdx = assertIdx >= 0 ? assertIdx : fallbackAssertIdx
      const wrapIdx = body.indexOf('wrapFieldRefsInJsonb(rawFilter')
      expect(finalAssertIdx).toBeGreaterThan(0)
      expect(wrapIdx).toBeGreaterThan(0)
      expect(finalAssertIdx).toBeLessThan(wrapIdx)
    })
  }
})

// ─── FP3 — Wrapping shape matches transform SQL ─────────────────────────────

describe('[preview-filter-sql] FP3 — wrapping arg shape matches transform SQL', () => {
  it('testTransformation: cross-table branch wraps filter with crossTableJoinSpec.fieldMap + alias strip', () => {
    // Cross-table branch in testTransformation: wrapFieldRefsInJsonb(rawFilter, crossTableJoinSpec.fieldMap)
    expect(TEST_BODY).toMatch(
      /wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*crossTableJoinSpec\.fieldMap\s*\)/,
    )
    // Same alias-strip regex used for transform SQL also applied to filter.
    const aliasStripMatches = TEST_BODY.match(
      /wrappedFilter\s*=\s*wrappedFilter\.replace\(\s*\/\\b\[A-Za-z_\]\[A-Za-z0-9_\]\*\\\.row_data->>'/g,
    )
    expect(aliasStripMatches).not.toBeNull()
  })

  it('testTransformation: same-table else branch wraps filter with fieldNames', () => {
    expect(TEST_BODY).toMatch(/wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*fieldNames\s*\)/)
  })

  it('runFullTransformTest: same-table wrap only (no buildJoinSpec usage)', () => {
    expect(FULL_TEST_BODY).toMatch(/wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*fieldNames\s*\)/)
    // Sanity: function doesn't call buildJoinSpec
    expect(FULL_TEST_BODY).not.toContain('buildJoinSpec(')
  })

  it('previewTransformDistinct: same-table wrap only (no buildJoinSpec usage)', () => {
    expect(PREVIEW_DISTINCT_BODY).toMatch(
      /wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*fieldNames\s*\)/,
    )
    expect(PREVIEW_DISTINCT_BODY).not.toContain('buildJoinSpec(')
  })
})

// ─── FP4 — Conditional spread for p_filter_sql at each .rpc() call ─────────

describe('[preview-filter-sql] FP4 — conditional-spread p_filter_sql', () => {
  it('testTransformation: 1 .rpc(execute_transform_test) call (consolidated)', () => {
    const matches = TEST_BODY.match(/supabaseAdmin\.rpc\(\s*'execute_transform_test'/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('testTransformation: conditional spread before the consolidated .rpc() call', () => {
    expect(TEST_BODY).toMatch(
      /if\s*\(\s*wrappedFilter\s*!==\s*null\s*\)\s+rpcArgs\.p_filter_sql\s*=\s*wrappedFilter/,
    )
  })

  it('runFullTransformTest: conditional spread before .rpc(execute_transform_full_test)', () => {
    expect(FULL_TEST_BODY).toMatch(
      /if\s*\(\s*wrappedFilter\s*!==\s*null\s*\)\s+rpcArgs\.p_filter_sql\s*=\s*wrappedFilter/,
    )
    expect(FULL_TEST_BODY).toMatch(/supabaseAdmin\.rpc\(\s*\n?\s*'execute_transform_full_test'/)
  })

  it('previewTransformDistinct: conditional spread before .rpc(execute_transform_test_distinct)', () => {
    expect(PREVIEW_DISTINCT_BODY).toMatch(
      /if\s*\(\s*wrappedFilter\s*!==\s*null\s*\)\s+rpcArgs\.p_filter_sql\s*=\s*wrappedFilter/,
    )
    expect(PREVIEW_DISTINCT_BODY).toMatch(
      /supabaseAdmin\.rpc\(\s*\n?\s*'execute_transform_test_distinct'/,
    )
  })
})

// ─── FP5 — No literal p_filter_sql: null in any rpc-args object ────────────

describe('[preview-filter-sql] FP5 — no literal p_filter_sql: null in args initializer', () => {
  for (const [name, body] of [
    ['testTransformation', TEST_BODY],
    ['runFullTransformTest', FULL_TEST_BODY],
    ['previewTransformDistinct', PREVIEW_DISTINCT_BODY],
  ] as const) {
    it(`${name}: no inline p_filter_sql key in the initializer; only the conditional spread`, () => {
      // The only occurrences of "p_filter_sql" should be inside the
      // conditional spread (rpcArgs.p_filter_sql = wrappedFilter). Specifically:
      // no `p_filter_sql:` key inside the rpcArgs object literal.
      const initMatch = body.match(
        /rpcArgs:\s*Record<string,\s*unknown>\s*=\s*\{([\s\S]*?)\n\s*\}\s*\n/,
      )
      const initBlock = initMatch ? initMatch[1] : ''
      expect(initBlock).not.toMatch(/p_filter_sql/)
    })
  }
})

// ─── FP6 — Heritage RPC call shape preserved ────────────────────────────────

describe('[preview-filter-sql] FP6 — heritage RPC param names preserved', () => {
  it('testTransformation: rpcArgs carries p_expression + p_table_id + (p_source_field or p_source_fields) + p_limit', () => {
    expect(TEST_BODY).toMatch(/p_expression:\s*wrappedSql/)
    expect(TEST_BODY).toMatch(/p_table_id:\s*sourceTableId/)
    expect(TEST_BODY).toMatch(/p_source_fields:\s*sourceFieldNames/)
    expect(TEST_BODY).toMatch(/p_source_field:\s*sourceFieldNames\[0\]/)
    expect(TEST_BODY).toMatch(/p_source_field:\s*'_none_'/)
    expect(TEST_BODY).toMatch(/p_limit:\s*20/)
    expect(TEST_BODY).toMatch(/p_limit:\s*10/)
  })

  it('runFullTransformTest: rpcArgs carries the 3 heritage params (p_expression, p_table_id, p_source_field)', () => {
    expect(FULL_TEST_BODY).toMatch(/p_expression:\s*wrappedSql/)
    expect(FULL_TEST_BODY).toMatch(/p_table_id:\s*sourceTableId/)
    expect(FULL_TEST_BODY).toMatch(/p_source_field:\s*srcField\?\.name\s*\?\?\s*'_none_'/)
  })

  it('previewTransformDistinct: rpcArgs carries the 4 heritage params', () => {
    expect(PREVIEW_DISTINCT_BODY).toMatch(/p_table_id:\s*sourceTableId/)
    expect(PREVIEW_DISTINCT_BODY).toMatch(/p_source_fields:\s*sourceFields/)
    expect(PREVIEW_DISTINCT_BODY).toMatch(/p_transform_sql:\s*wrappedSql/)
    expect(PREVIEW_DISTINCT_BODY).toMatch(/p_limit:\s*200/)
  })
})

// ─── FP7 — Migration 113 DROPs old signatures + CREATEs new 5-arg ──────────

describe('[preview-filter-sql] FP7 — migration 113 structure', () => {
  it('DROPs 4 old signatures', () => {
    expect(MIGRATION_SRC).toMatch(
      /DROP FUNCTION IF EXISTS public\.execute_transform_test\(TEXT,\s*UUID,\s*TEXT,\s*INT\)/,
    )
    expect(MIGRATION_SRC).toMatch(
      /DROP FUNCTION IF EXISTS public\.execute_transform_test\(TEXT,\s*UUID,\s*TEXT\[\],\s*INT\)/,
    )
    expect(MIGRATION_SRC).toMatch(
      /DROP FUNCTION IF EXISTS public\.execute_transform_full_test\(TEXT,\s*UUID,\s*TEXT\)/,
    )
    expect(MIGRATION_SRC).toMatch(
      /DROP FUNCTION IF EXISTS public\.execute_transform_test_distinct\(UUID,\s*TEXT\[\],\s*TEXT,\s*INT\)/,
    )
  })

  it('CREATEs 4 new signatures with p_filter_sql TEXT DEFAULT NULL', () => {
    const createBlocks = MIGRATION_SRC.match(
      /CREATE OR REPLACE FUNCTION public\.(execute_transform_test|execute_transform_full_test|execute_transform_test_distinct)\(/g,
    )
    expect(createBlocks?.length).toBe(4)
    // Each function body declares p_filter_sql with DEFAULT NULL. Filter to
    // lines that don't start with `--` (excludes the migration header's
    // documentation reference to the param name).
    const declLines = MIGRATION_SRC.split('\n').filter(
      (l) => /^\s+p_filter_sql\s+TEXT\s+DEFAULT\s+NULL/.test(l),
    )
    expect(declLines.length).toBe(4)
  })

  it('does NOT touch the single-field distinct wrapper (035:100-127)', () => {
    // Wrapper signature: execute_transform_test_distinct(UUID, TEXT, TEXT, INT)
    // Migration 113 should NOT drop or recreate it.
    expect(MIGRATION_SRC).not.toMatch(
      /DROP FUNCTION IF EXISTS public\.execute_transform_test_distinct\(UUID,\s*TEXT,\s*TEXT,\s*INT\)/,
    )
  })
})

// ─── FP8 — Migration 113 BEGIN/EXCEPTION wrapper with filter re-attribution ─

describe('[preview-filter-sql] FP8 — BEGIN/EXCEPTION with filter re-attribution', () => {
  it('has at least 6 BEGIN blocks with EXCEPTION WHEN OTHERS (one per dynamic SQL site, plus the COUNT INTO conversion in 043)', () => {
    const exceptionBlocks = MIGRATION_SRC.match(/EXCEPTION\s+WHEN\s+OTHERS\s+THEN/g) ?? []
    expect(exceptionBlocks.length).toBeGreaterThanOrEqual(6)
  })

  it('every exception block re-raises filter errors with "Partition filter SQL failed:" prefix', () => {
    const matches =
      MIGRATION_SRC.match(/RAISE EXCEPTION 'Partition filter SQL failed: %', SQLERRM/g) ?? []
    // 6 sites in dynamic SQL — each re-attributes when p_filter_sql IS NOT NULL.
    expect(matches.length).toBeGreaterThanOrEqual(6)
  })

  it('preserves heritage error paths for the non-filter case', () => {
    // Each EXCEPTION WHEN OTHERS handler should have an ELSE branch that
    // either RAISEs verbatim or preserves heritage behavior (e.g.
    // execute_transform_test_distinct surfaces error as a row).
    const elseRaiseCount = (MIGRATION_SRC.match(/ELSE\s+RAISE\s*;/g) ?? []).length
    const elseSwallowCount = (MIGRATION_SRC.match(/-- Heritage behavior/g) ?? []).length
    // Conservative: at least 4 ELSE-RAISE (single-field test, multi-field test,
    // COUNT INTO, FOR-loop init) + 2 documented swallow/surface-as-row.
    expect(elseRaiseCount + elseSwallowCount).toBeGreaterThanOrEqual(6)
  })

  it('filter validation block (DML/system-table/semicolon) appears in all 4 RPC bodies', () => {
    const dmlChecks =
      MIGRATION_SRC.match(/Partition filter SQL cannot contain data modification statements/g) ?? []
    const systemTableChecks =
      MIGRATION_SRC.match(/Partition filter SQL cannot access system tables/g) ?? []
    const semicolonChecks =
      MIGRATION_SRC.match(/Partition filter SQL cannot contain semicolons/g) ?? []
    expect(dmlChecks.length).toBe(4)
    expect(systemTableChecks.length).toBe(4)
    expect(semicolonChecks.length).toBe(4)
  })
})
