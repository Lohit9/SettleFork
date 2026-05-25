import { describe, it, expect } from 'vitest'
import {
  assertNoDml,
  fieldNeedsTransform,
  stripSqlLiterals,
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

  it('PR ζ.1: throws on quoted-with-dot ref pointing to a field not in scope (catches routing-mismatch silent-degrade)', () => {
    // The AI emitted "Products.ProductName" but apply routed to the
    // same-table branch (because buildJoinSpec returned null spec).
    // Previously this token silently passed through and Postgres
    // crashed with "column does not exist"; the throw makes the
    // routing mismatch visible with an actionable message.
    expect(() =>
      wrapFieldRefsInJsonb(`COALESCE("Products.ProductName", "STATUS")`, ['STATUS']),
    ).toThrow(/Field "ProductName" from table "Products" is not part of this same-table TFM's source fields/)
  })
})

// ─── wrapFieldRefsInJsonb — cross-table overload ─────────────────────────────
//
// Phase 4a-6 §4-OQ-A: cross-table TFMs SHOULD use table-qualified field
// references (Table.Field). The overload accepts a Map keyed by table
// name with `{ alias, fieldNames }` entries, and:
//   • rewrites quoted "Table.Field" and the 2-token "Table"."Field" form
//     to `(<alias>.row_data->>'Field')`
//   • PR ζ: auto-qualifies bare/single-quoted refs whose name appears in
//     EXACTLY ONE source table (restores apply-time robustness when the
//     AI emits bare names under the legacy prompt)
//   • errors on bare refs whose name collides across 2+ tables (a silent
//     rewrite would bind to whichever table happens to win)
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

  it('auto-qualifies a bare reference when its name appears in exactly one source table', () => {
    // PR ζ — restores apply-time robustness when the AI emits bare names
    // under the legacy prompt. CIF_TYPE is unique to CIF_MASTER, so the
    // helper resolves it to that table's alias rather than throwing.
    const out = wrapFieldRefsInJsonb(`UPPER(CIF_TYPE)`, fieldMap)
    expect(out).toBe(`UPPER((j0.row_data->>'CIF_TYPE'))`)
  })

  it('auto-qualifies a quoted unqualified reference too ("CIF_TYPE")', () => {
    const out = wrapFieldRefsInJsonb(`UPPER("CIF_TYPE")`, fieldMap)
    expect(out).toBe(`UPPER((j0.row_data->>'CIF_TYPE'))`)
  })

  it('auto-qualifies multiple distinct bare refs in the same expression (COALESCE shape)', () => {
    // CIF_NAME → CIF_MASTER (j0); LOAN_TYPE → LOAN_MASTER (d). Both are
    // unique across the map; both auto-resolve.
    const out = wrapFieldRefsInJsonb(
      `COALESCE(NULLIF(TRIM(CIF_NAME), ''), TRIM(LOAN_TYPE))`,
      fieldMap,
    )
    expect(out).toBe(
      `COALESCE(NULLIF(TRIM((j0.row_data->>'CIF_NAME')), ''), TRIM((d.row_data->>'LOAN_TYPE')))`,
    )
  })

  it('throws on a bare reference whose name collides across multiple source tables (ambiguous)', () => {
    // STATUS is in both tables — auto-qualification cannot pick one
    // without guessing. The strict throw remains, and the message names
    // the colliding tables so the operator can fix the AI output.
    const ambiguousMap = buildFieldMap([
      ['LOAN_MASTER', { alias: 'd', fieldNames: ['STATUS'] }],
      ['CIF_MASTER', { alias: 'j0', fieldNames: ['STATUS'] }],
    ])
    expect(() => wrapFieldRefsInJsonb(`UPPER(STATUS)`, ambiguousMap)).toThrow(
      /table-qualified field references/i,
    )
    // Extended message must surface both colliding tables.
    expect(() => wrapFieldRefsInJsonb(`UPPER(STATUS)`, ambiguousMap)).toThrow(
      /LOAN_MASTER, CIF_MASTER/,
    )
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

  it('Rootstock-shape: qualified "Source Table.Field" refs with spaces (Item Description shape)', () => {
    // The Rootstock POC's failing TFMs use field names with spaces
    // (Assy Desc, Assy Item) and source table names with spaces
    // (Engineering BOM Masters). Exercise the COALESCE shape that the
    // updated prompt teaches the AI to emit.
    const rootstockMap = buildFieldMap([
      [
        'Engineering BOM Masters',
        { alias: 'd', fieldNames: ['Assy Item', 'Assy Desc', 'Part #'] },
      ],
      ['Products', { alias: 'j0', fieldNames: ['ProductName', 'ProductSKU'] }],
    ])
    const out = wrapFieldRefsInJsonb(
      `CASE WHEN "Engineering BOM Masters.Assy Desc" IS NULL OR TRIM("Engineering BOM Masters.Assy Desc"::text) = '' THEN NULL ELSE COALESCE(NULLIF(TRIM("Products.ProductName"), ''), TRIM("Engineering BOM Masters.Assy Desc")) END`,
      rootstockMap,
    )
    expect(out).toBe(
      `CASE WHEN (d.row_data->>'Assy Desc') IS NULL OR TRIM((d.row_data->>'Assy Desc')::text) = '' THEN NULL ELSE COALESCE(NULLIF(TRIM((j0.row_data->>'ProductName')), ''), TRIM((d.row_data->>'Assy Desc'))) END`,
    )
  })

  it('PR ζ.1: auto-qualifies a quoted-with-dot ref whose table prefix is unknown but field name is unique to a known table', () => {
    // PR ζ.1 smoke failure (Defect 1, Path A): the AI emitted
    // "Products.ProductName" but Pass 1's prefix lookup missed (e.g.
    // because the loader stored the table under a different name, or
    // the field appeared via a renamed projection). Fall-through to
    // the bare-field auto-qualifier must rescue when the field is
    // unique across the map.
    const out = wrapFieldRefsInJsonb(
      `"WrongTable.ProductName" || "Engineering BOM Masters.Assy Desc"`,
      buildFieldMap([
        ['Engineering BOM Masters', { alias: 'd', fieldNames: ['Assy Desc', 'Assy Item'] }],
        ['Products', { alias: 'j0', fieldNames: ['ProductName'] }],
      ]),
    )
    expect(out).toBe(
      `(j0.row_data->>'ProductName') || (d.row_data->>'Assy Desc')`,
    )
  })

  it('PR ζ.1: throws on quoted-with-dot ref whose bare field name collides across multiple tables', () => {
    // When Pass 1's prefix lookup misses AND the bare field name is
    // ambiguous, the fall-through must throw with the colliding
    // tables named — same message shape as the bare-ref ambiguity
    // throw at the bottom of the cross-table overload.
    const ambiguousMap = buildFieldMap([
      ['T1', { alias: 'd', fieldNames: ['STATUS'] }],
      ['T2', { alias: 'j0', fieldNames: ['STATUS'] }],
    ])
    expect(() => wrapFieldRefsInJsonb(`UPPER("WrongTable.STATUS")`, ambiguousMap)).toThrow(
      /table-qualified field references/i,
    )
    expect(() => wrapFieldRefsInJsonb(`UPPER("WrongTable.STATUS")`, ambiguousMap)).toThrow(
      /T1, T2/,
    )
  })

  it('PR ζ.1: leaves unknown qualifier.unknown-field alone (e.g. schema-qualified function refs unchanged)', () => {
    // Regression guard: if neither the prefix nor the bare field name
    // match, the token must pass through unchanged. Protects existing
    // schema-qualified function references like "some_schema.helper".
    const fmap = buildFieldMap([['T1', { alias: 'd', fieldNames: ['STATUS'] }]])
    const out = wrapFieldRefsInJsonb(
      `"some_schema.unknown_helper" || "T1.STATUS"`,
      fmap,
    )
    expect(out).toBe(
      `"some_schema.unknown_helper" || (d.row_data->>'STATUS')`,
    )
  })

  it('Rootstock-shape: bare refs auto-qualify when distinct across tables (heritage AI output)', () => {
    // When the AI emits the legacy bare-name form (rule-6 pre-PR-ζ) and
    // both names happen to be unique across the cross-table map, the
    // auto-qualifier silently rewrites — apply succeeds instead of
    // bouncing back to the user with the qualification error.
    const rootstockMap = buildFieldMap([
      [
        'Engineering BOM Masters',
        { alias: 'd', fieldNames: ['Assy Item', 'Assy Desc'] },
      ],
      ['Products', { alias: 'j0', fieldNames: ['ProductName'] }],
    ])
    const out = wrapFieldRefsInJsonb(
      `COALESCE(NULLIF(TRIM("ProductName"), ''), TRIM("Assy Desc"))`,
      rootstockMap,
    )
    expect(out).toBe(
      `COALESCE(NULLIF(TRIM((j0.row_data->>'ProductName')), ''), TRIM((d.row_data->>'Assy Desc')))`,
    )
  })
})

// ─── stripSqlLiterals ────────────────────────────────────────────────────────
//
// PR ζ.1 hot-fix support — strips single-quoted SQL string literals so
// downstream blocklist checks (assertNoDml below) don't false-positive on
// data values containing DML keywords (e.g. `'2_RCB-APPAREL-DROP'`).

describe('stripSqlLiterals', () => {
  it('removes single-quoted strings, preserves surrounding structure', () => {
    expect(stripSqlLiterals(`'foo' || 'bar'`)).toBe(`'' || ''`)
  })

  it("collapses SQL '' escape inside a single-quoted literal", () => {
    // `'a''b'` is a single SQL literal whose value is `a'b`. The TOKEN_RE
    // greedy `'(?:[^']|'')*'` consumes the whole token; strip replaces
    // it with an empty literal.
    expect(stripSqlLiterals(`'a''b'`)).toBe(`''`)
  })

  it('leaves bare identifiers and double-quoted identifiers untouched', () => {
    expect(stripSqlLiterals(`UPPER("Field") = 'x'`)).toBe(`UPPER("Field") = ''`)
  })
})

// ─── assertNoDml ─────────────────────────────────────────────────────────────
//
// PR ζ.1 client-side hot-fix — see lib/utils/transform-helpers.ts for the
// rationale + the deferred PR ζ.2 migration that adds the same
// literal-stripping to all five RPC bodies.

describe('assertNoDml', () => {
  it('accepts a CASE whose output literal contains "DROP" (iccomcod regression)', () => {
    // The iccomcod TFM emits this exact shape. RPC-side blocklist
    // false-positives on \ydrop\y inside the literal value; the
    // client-side guard strips literals first and lets it through.
    expect(() =>
      assertNoDml(`CASE WHEN x = 'y' THEN '2_RCB-APPAREL-DROP' ELSE NULL END`),
    ).not.toThrow()
  })

  it('rejects a bare DROP keyword in expression position', () => {
    expect(() => assertNoDml(`DROP TABLE x`)).toThrow(/DML keyword.*DROP/)
  })

  it('accepts UPDATE inside a literal, rejects UPDATE in expression position', () => {
    expect(() => assertNoDml(`'UPDATE me' || 'now'`)).not.toThrow()
    expect(() => assertNoDml(`UPDATE x SET y = 'z'`)).toThrow(/DML keyword.*UPDATE/)
  })

  it("handles SQL '' escape inside a literal containing DROP", () => {
    expect(() => assertNoDml(`'don''t DROP' || 'me'`)).not.toThrow()
  })

  it('passes a no-op same-table transform expression', () => {
    expect(() =>
      assertNoDml(`COALESCE(NULLIF(TRIM(row_data->>'STATUS'), ''), 'UNKNOWN')`),
    ).not.toThrow()
  })
})
