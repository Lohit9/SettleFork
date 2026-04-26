import { describe, it, expect } from 'vitest'
import {
  fieldNeedsTransform,
  wrapFieldRefsInJsonb,
  type CrossTableFieldEntry,
} from '@/lib/utils/transform-helpers'

/**
 * Unit coverage for the `fieldNeedsTransform` heuristic.
 *
 * Pins the evaluation order mandated by migration 075:
 *   1. `needsTransformation === false` → return false (user dismissal wins).
 *   2. `hasTransformation` → return true.
 *   3. `needsTransformation === true` → return true.
 *   4. NULL + type-family fallback.
 *
 * The headline regression (regression-1 below) is the transform-toggle
 * persistence bug: before this fix, the defensive regex on `type_compatibility`
 * re-flagged user-dismissed fields whenever the AI's compatibility note
 * contained any of a long list of common words ("needs", "convert", "format",
 * etc.), silently reverting the toggle on page refresh.
 */

const BASE = {
  sourceDataType: 'DECIMAL(15,2)',
  targetDataType: 'DECIMAL(15,2)',
  sourceFieldName: 'ORIG_AMT',
  targetFieldName: 'original_amount',
  confidence: 95,
} as const

describe('fieldNeedsTransform — user dismissal semantics (migration 075)', () => {
  it('regression-1: dismissed field with AI compat text containing "needs conversion" stays dismissed', () => {
    // Pre-fix: the defensive regex matched "needs" / "conversion" in the
    // compatibility note and returned true, silently re-flagging the field
    // on every page load. Post-fix: explicit dismissal is authoritative.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL(15,2) → DECIMAL(15,2) — needs conversion to target precision',
        hasTransformation: false,
        needsTransformation: false,
      }),
    ).toBe(false)
  })

  it('regression-2: dismissal wins over a stale hasTransformation row', () => {
    // Ordering invariant: the dismissal check fires before the
    // hasTransformation short-circuit. Protects readiness-score and outputs
    // from counting dismissed fields whose transformation row was never
    // cleared.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL → DECIMAL — direct compatible',
        hasTransformation: true,
        needsTransformation: false,
      }),
    ).toBe(false)
  })

  it('reinstated field (needsTransformation === true) is flagged', () => {
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL → DECIMAL — direct compatible',
        hasTransformation: false,
        needsTransformation: true,
      }),
    ).toBe(true)
  })

  it('unassessed NULL + high-confidence same-type direct-compatible → skip', () => {
    // Preserves the existing passthrough carve-out for newly minted TFMs
    // that have never been assessed and trivially pass through.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'DECIMAL(15,2) → DECIMAL(15,2) — direct compatible',
        confidence: 95,
        hasTransformation: false,
        needsTransformation: null,
      }),
    ).toBe(false)
  })

  it('unassessed NULL default → flag it (safe default)', () => {
    // When the AI didn't assess and the passthrough carve-out doesn't apply,
    // the helper must default to "needs transform" so the field surfaces
    // for review. The user can still dismiss via the toggle.
    expect(
      fieldNeedsTransform({
        ...BASE,
        typeCompatibility: 'VARCHAR(40) → DECIMAL(15,2)',
        sourceDataType: 'VARCHAR(40)',
        targetDataType: 'DECIMAL(15,2)',
        confidence: 80,
        hasTransformation: false,
        needsTransformation: null,
      }),
    ).toBe(true)
  })
})

// ─── wrapFieldRefsInJsonb — same-table overload (string[]) ───────────────────
//
// Phase 4a-6 pins this BCC behavior: existing single-source TFMs and value
// assignments use the `string[]` signature and MUST continue to rewrite
// `Field` / `"Field"` / `"Table.Field"` to `(row_data->>'Field')` exactly
// as migration 074 expects. The cross-table overload is exercised below.

describe('wrapFieldRefsInJsonb — same-table overload', () => {
  it('rewrites bare, quoted, and "Table.Field" (single quoted-token) forms', () => {
    // The same-table overload supports the prefix form ONLY when the
    // dot is INSIDE the quotes (e.g. "T.STATUS"), not as two adjacent
    // quoted identifiers ("T"."STATUS"). The latter is a vanishingly
    // rare authoring pattern in transform SQL and is intentionally
    // out of scope for the same-table path.
    const out = wrapFieldRefsInJsonb(
      `CASE WHEN STATUS = 'Active' THEN "STATUS" ELSE "T.STATUS" END`,
      ['STATUS'],
    )
    expect(out).toBe(
      `CASE WHEN (row_data->>'STATUS') = 'Active' THEN (row_data->>'STATUS') ELSE (row_data->>'STATUS') END`,
    )
  })

  it("preserves single-quoted string literals untouched even when they contain field-name tokens", () => {
    const out = wrapFieldRefsInJsonb(
      `CASE WHEN STATUS = 'STATUS' THEN 'Active' ELSE 'STATUS' END`,
      ['STATUS'],
    )
    // The literal `'STATUS'` (with quotes) is data, not a column reference.
    expect(out).toBe(
      `CASE WHEN (row_data->>'STATUS') = 'STATUS' THEN 'Active' ELSE 'STATUS' END`,
    )
  })

  it('returns the original SQL when the field list is empty', () => {
    expect(wrapFieldRefsInJsonb(`SELECT 1`, [])).toBe(`SELECT 1`)
  })
})

// ─── wrapFieldRefsInJsonb — cross-table overload ─────────────────────────────
//
// Phase 4a-6 §4-OQ-A: cross-table TFMs MUST use table-qualified field
// references (Table.Field). The new overload accepts a Map keyed by
// table name with `{ alias, fieldNames }` entries, and:
//   • rewrites quoted "Table.Field" and the 2-token "Table"."Field" form
//     to `(<alias>.row_data->>'Field')`
//   • errors on bare/unqualified field references (would otherwise be
//     ambiguous — two source tables can share a column name)
//   • leaves SQL string literals untouched
//   • leaves unknown identifiers (functions, keywords, custom names)
//     alone

function buildFieldMap(
  entries: Array<[string, { alias: string; fieldNames: string[] }]>,
): Map<string, CrossTableFieldEntry> {
  return new Map(
    entries.map(([table, { alias, fieldNames }]) => [
      table,
      { alias, fieldNames: new Set(fieldNames) },
    ]),
  )
}

describe('wrapFieldRefsInJsonb — cross-table overload', () => {
  const fieldMap = buildFieldMap([
    ['LOAN_MASTER', { alias: 'd', fieldNames: ['LOAN_TYPE', 'LOAN_NO'] }],
    ['CIF_MASTER', { alias: 'j0', fieldNames: ['CIF_TYPE', 'CIF_NAME'] }],
  ])

  it('rewrites quoted "Table.Field" using the table\'s alias', () => {
    const out = wrapFieldRefsInJsonb(
      `"LOAN_MASTER.LOAN_TYPE" || ' / ' || "CIF_MASTER.CIF_TYPE"`,
      fieldMap,
    )
    expect(out).toBe(
      `(d.row_data->>'LOAN_TYPE') || ' / ' || (j0.row_data->>'CIF_TYPE')`,
    )
  })

  it('rewrites the 2-token Table.Field form (whitespace around the dot tolerated)', () => {
    const out = wrapFieldRefsInJsonb(
      `LOAN_MASTER.LOAN_TYPE || CIF_MASTER . CIF_TYPE`,
      fieldMap,
    )
    expect(out).toBe(
      `(d.row_data->>'LOAN_TYPE') || (j0.row_data->>'CIF_TYPE')`,
    )
  })

  it('throws on bare/unqualified field reference (cross-table cannot disambiguate)', () => {
    // CIF_TYPE without a qualifier — could come from any joined table that
    // happens to have that column. The helper must refuse rather than
    // silently bind to the first match.
    expect(() => wrapFieldRefsInJsonb(`UPPER(CIF_TYPE)`, fieldMap)).toThrow(
      /table-qualified field references/i,
    )
  })

  it('throws on quoted unqualified reference too ("CIF_TYPE")', () => {
    expect(() =>
      wrapFieldRefsInJsonb(`UPPER("CIF_TYPE")`, fieldMap),
    ).toThrow(/table-qualified field references/i)
  })

  it("preserves single-quoted string literals untouched even when they contain field-name tokens", () => {
    const out = wrapFieldRefsInJsonb(
      `CASE WHEN "LOAN_MASTER.LOAN_TYPE" = 'CIF_TYPE' THEN 'CIF_TYPE' ELSE NULL END`,
      fieldMap,
    )
    // `'CIF_TYPE'` is a literal value, not a column reference.
    expect(out).toBe(
      `CASE WHEN (d.row_data->>'LOAN_TYPE') = 'CIF_TYPE' THEN 'CIF_TYPE' ELSE NULL END`,
    )
  })

  it('leaves unknown qualifier.column expressions alone (e.g. unrelated schema-qualified refs)', () => {
    // `pg_catalog.now` looks like Table.Field but neither token is in our
    // map — leave the expression untouched.
    const out = wrapFieldRefsInJsonb(
      `pg_catalog.now() AND LOAN_MASTER.LOAN_NO IS NOT NULL`,
      fieldMap,
    )
    expect(out).toBe(
      `pg_catalog.now() AND (d.row_data->>'LOAN_NO') IS NOT NULL`,
    )
  })

  it('returns the original SQL when the field map is empty', () => {
    expect(wrapFieldRefsInJsonb(`SELECT 1`, new Map())).toBe(`SELECT 1`)
  })

  it('does not throw for SQL keywords / function names that incidentally match no field', () => {
    // `COALESCE`, `NULLIF` are keywords. The helper must not raise just
    // because they're unknown identifiers.
    const out = wrapFieldRefsInJsonb(
      `COALESCE("LOAN_MASTER.LOAN_TYPE", NULLIF("CIF_MASTER.CIF_TYPE", ''))`,
      fieldMap,
    )
    expect(out).toBe(
      `COALESCE((d.row_data->>'LOAN_TYPE'), NULLIF((j0.row_data->>'CIF_TYPE'), ''))`,
    )
  })
})
