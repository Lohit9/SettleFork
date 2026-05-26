import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level invariants for PR Ω.2 — apply path honors
 * `table_mappings.filter_sql`.
 *
 * Companion to `transforms-cross-table-apply.test.ts`. Same source-grep
 * strategy: pin the call patterns so a future refactor can't accidentally
 * drop the filter plumbing or invert the conditional-spread semantics.
 *
 * Behavioral end-to-end coverage (apply a TFM with a non-NULL filter and
 * verify `staged_data_rows` row count) lives in the env-gated integration
 * test layer (deferred to PR Ω.3, when the partition-creation UI ships
 * and we can seed projects with non-NULL filter_sql).
 *
 * Pinned invariants:
 *
 *   F1  TfmContext.tableMapping carries `filter_sql: string | null`.
 *   F2  loadTfmContext SELECTs `filter_sql` from `table_mappings`.
 *   F3  applyTransform's mapped branch reads `ctx.tableMapping?.filter_sql`.
 *   F4  applyTransform's mapped branch passes the filter through
 *       `assertNoDml` BEFORE wrapping.
 *   F5  applyTransform's mapped branch wraps filter via the same
 *       `wrapFieldRefsInJsonb` overload (Map or string[]) used for the
 *       transform SQL — preserving cross-table vs same-table parity.
 *   F6  applyTransform's mapped branch uses conditional-spread to add
 *       `p_filter_sql` to the RPC args ONLY when the wrapped filter is
 *       non-null — preserves backward-compat with the pre-Ω.2 4-arg RPC.
 *   F7  applyTransform's VA loop SELECTs `filter_sql` on `tms` and bulk-
 *       fetches source field names for filtered TMs in a single round-trip.
 *   F8  applyTransform's VA loop passes the per-TM filter through
 *       `assertNoDml` and `wrapFieldRefsInJsonb` before the conditional
 *       spread to the VA RPC.
 *   F9  Neither branch passes `p_filter_sql: null` literal — both use the
 *       conditional-spread to omit the key entirely when filter is null.
 *       (Pinning F9 separately because Supabase JS treats `{ x: null }`
 *       differently from `{}` in some RPC versions.)
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

const LOAD_CTX_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function loadTfmContext(',
  '// ─── loadProjectContextBlocks',
)

const MAPPED_BRANCH = sliceBetween(
  APPLY_BODY,
  '// ── Mapped TFM',
  '// ── Value-assignment TFM',
)

const VA_BRANCH = sliceBetween(
  APPLY_BODY,
  '// ── Value-assignment TFM',
  '// Mark the transformation as applied.',
)

// ─── F1 — TfmContext shape ──────────────────────────────────────────────────

describe('[transforms-apply-filter-sql] F1 — TfmContext.tableMapping.filter_sql', () => {
  it('TfmContext.tableMapping declares filter_sql as string | null', () => {
    const ctxIfaceSlice = sliceBetween(
      TRANSFORMS_SRC,
      'tableMapping: {',
      '} | null',
    )
    expect(ctxIfaceSlice).toContain('filter_sql: string | null')
  })
})

// ─── F2 — loadTfmContext SELECT ─────────────────────────────────────────────

describe('[transforms-apply-filter-sql] F2 — loadTfmContext SELECTs filter_sql', () => {
  it("loadTfmContext's table_mappings .select includes filter_sql", () => {
    expect(LOAD_CTX_BODY).toMatch(
      /\.from\(\s*['"]table_mappings['"]\s*\)\s*\.select\(\s*['"][^'"]*\bfilter_sql\b/,
    )
  })

  it("loadTfmContext's typed result row carries filter_sql: string | null", () => {
    expect(LOAD_CTX_BODY).toContain('filter_sql: string | null')
  })
})

// ─── F3 — mapped branch reads filter_sql ────────────────────────────────────

describe('[transforms-apply-filter-sql] F3 — mapped branch reads ctx.tableMapping.filter_sql', () => {
  it('reads ctx.tableMapping?.filter_sql with ?? null fallback', () => {
    expect(MAPPED_BRANCH).toMatch(/ctx\.tableMapping\?\.filter_sql\s*\?\?\s*null/)
  })
})

// ─── F4 — mapped branch applies assertNoDml to the filter ───────────────────

describe('[transforms-apply-filter-sql] F4 — mapped branch DML-guards the filter', () => {
  it('calls assertNoDml on rawFilter inside an if (rawFilter) guard', () => {
    // The order matters: read filter → assertNoDml → wrap. Pin via positional
    // ordering (assertNoDml on filter comes BEFORE wrapFieldRefsInJsonb on filter).
    expect(MAPPED_BRANCH).toMatch(/if\s*\(\s*rawFilter\s*\)\s*\{[\s\S]*?assertNoDml\(\s*rawFilter\s*\)/)
  })
})

// ─── F5 — mapped branch wraps filter via wrapFieldRefsInJsonb ───────────────

describe('[transforms-apply-filter-sql] F5 — mapped branch wraps filter same as transform SQL', () => {
  it('cross-table branch wraps filter with okSpec.fieldMap (same as transform SQL)', () => {
    // Within cross-table branch (okSpec.spec && okSpec.fieldMap), filter wrap
    // uses the same fieldMap argument as transform SQL wrap.
    const crossTableSlice = sliceBetween(
      MAPPED_BRANCH,
      'if (okSpec.spec && okSpec.fieldMap)',
      'p_join_spec = okSpec.spec',
    )
    expect(crossTableSlice).toMatch(
      /wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*okSpec\.fieldMap\s*\)/,
    )
  })

  it('same-table branch wraps filter with fieldNames (same as transform SQL)', () => {
    // Same-table branch (else): filter wrap uses the same fieldNames array.
    // Locate by the closing brace of cross-table + the else marker.
    const sameTableSlice = sliceBetween(
      MAPPED_BRANCH,
      '// Same-table — preserve',
      '// Conditional spread',
    )
    expect(sameTableSlice).toMatch(/wrapFieldRefsInJsonb\(\s*rawFilter\s*,\s*fieldNames\s*\)/)
  })
})

// ─── F6 — conditional spread for p_filter_sql on joined RPC ─────────────────

describe('[transforms-apply-filter-sql] F6 — joined RPC uses conditional spread for p_filter_sql', () => {
  it('joinedRpcArgs is built as a Record then conditionally augmented', () => {
    expect(MAPPED_BRANCH).toContain('const joinedRpcArgs: Record<string, unknown> = {')
    expect(MAPPED_BRANCH).toMatch(
      /if\s*\(\s*wrappedFilter\s*!==\s*null\s*\)\s+joinedRpcArgs\.p_filter_sql\s*=\s*wrappedFilter/,
    )
  })

  it('the joined RPC call passes joinedRpcArgs (not an inline object literal)', () => {
    // Multi-line .rpc(...) call; allow optional trailing comma before the
    // closing paren (Prettier preserves trailing commas in TS).
    expect(MAPPED_BRANCH).toMatch(
      /supabase\.rpc\(\s*['"]dq_apply_field_transform_joined['"]\s*,\s*joinedRpcArgs\s*,?\s*\)/,
    )
  })
})

// ─── F7 — VA loop SELECTs filter_sql + bulk-fetches fields ──────────────────

describe('[transforms-apply-filter-sql] F7 — VA loop SELECTs filter_sql + bulk-fetches source fields', () => {
  it("VA loop's tms SELECT includes filter_sql", () => {
    expect(VA_BRANCH).toMatch(
      /\.from\(\s*['"]table_mappings['"]\s*\)\s*\.select\(\s*['"][^'"]*\bfilter_sql\b/,
    )
  })

  it('bulk-fetches source field names for distinct source_table_ids in one round-trip', () => {
    expect(VA_BRANCH).toContain('tmsWithFilter')
    expect(VA_BRANCH).toContain('sourceFieldsByTable')
    expect(VA_BRANCH).toMatch(/\.from\(\s*['"]fields['"]\s*\)[\s\S]*?\.in\(\s*['"]table_id['"]\s*,/)
  })

  it('skips the bulk-fetch when no TM carries a filter (perf protection)', () => {
    expect(VA_BRANCH).toMatch(/if\s*\(\s*tmsWithFilter\.length\s*>\s*0\s*\)/)
  })
})

// ─── F8 — VA loop DML-guards + wraps the per-TM filter ──────────────────────

describe('[transforms-apply-filter-sql] F8 — VA loop DML-guards + wraps per-TM filter', () => {
  it('per-TM block calls assertNoDml on tm.filter_sql inside an if (tm.filter_sql) guard', () => {
    expect(VA_BRANCH).toMatch(/if\s*\(\s*tm\.filter_sql\s*\)\s*\{[\s\S]*?assertNoDml\(\s*tm\.filter_sql\s*\)/)
  })

  it("per-TM block wraps filter via wrapFieldRefsInJsonb against the TM's source field names", () => {
    expect(VA_BRANCH).toMatch(
      /sourceFieldsByTable\.get\(\s*tm\.source_table_id\s*\)/,
    )
    expect(VA_BRANCH).toMatch(/wrapFieldRefsInJsonb\(\s*tm\.filter_sql\s*,\s*fieldNames\s*\)/)
  })
})

// ─── F9 — neither branch passes p_filter_sql: null literal ──────────────────

describe('[transforms-apply-filter-sql] F9 — no literal p_filter_sql: null in either RPC call', () => {
  it('mapped joinedRpcArgs object literal does not include a top-level p_filter_sql key', () => {
    // The initializer object should NOT contain p_filter_sql; it's added via
    // conditional assignment afterwards. Pin the initializer slice and
    // assert absence.
    const initSlice = sliceBetween(
      MAPPED_BRANCH,
      'const joinedRpcArgs: Record<string, unknown> = {',
      '}',
    )
    expect(initSlice).not.toMatch(/p_filter_sql/)
  })

  it('VA vaRpcArgs object literal does not include a top-level p_filter_sql key', () => {
    const initSlice = sliceBetween(
      VA_BRANCH,
      'const vaRpcArgs: Record<string, unknown> = {',
      '}',
    )
    expect(initSlice).not.toMatch(/p_filter_sql/)
  })
})

// ─── F10 — RPC call shape preserves the 4-arg / 6-arg backward-compat path ─

describe('[transforms-apply-filter-sql] F10 — heritage RPC call shape preserved', () => {
  it('joined RPC always passes the 4 heritage params (regardless of filter)', () => {
    const initSlice = sliceBetween(
      MAPPED_BRANCH,
      'const joinedRpcArgs: Record<string, unknown> = {',
      '}',
    )
    expect(initSlice).toMatch(/p_target_field_mapping_id\s*:/)
    expect(initSlice).toMatch(/p_target_field_name\s*:/)
    expect(initSlice).toMatch(/p_transform_sql\s*:/)
    expect(initSlice).toMatch(/p_join_spec\s*,?/)
  })

  it('VA RPC always passes the 6 heritage params (regardless of filter)', () => {
    const initSlice = sliceBetween(
      VA_BRANCH,
      'const vaRpcArgs: Record<string, unknown> = {',
      '}',
    )
    expect(initSlice).toMatch(/p_table_mapping_id\s*:/)
    expect(initSlice).toMatch(/p_source_table_id\s*:/)
    expect(initSlice).toMatch(/p_target_table_id\s*:/)
    expect(initSlice).toMatch(/p_target_field_name\s*:/)
    expect(initSlice).toMatch(/p_transform_sql\s*:/)
    expect(initSlice).toMatch(/p_has_existing_staged\s*:/)
  })
})
