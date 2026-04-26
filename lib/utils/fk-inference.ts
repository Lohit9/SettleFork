// ─────────────────────────────────────────────────────────────────────────────
// FK inference for the redesigned mapping path.
// ─────────────────────────────────────────────────────────────────────────────
//
// Used by:
//
//   • Read path  — `lib/actions/_mappings-for-redesign-core.ts` derives
//     `MappingSourceRef.joinAnnotation` for cross-table sources whose
//     stored `join_spec` is null. The rule: scan the dominant source
//     table for fields with `is_foreign_key=true` whose `fk_reference`
//     points at the joined source's table. If exactly one match, the
//     annotation is `(join: <field name>)`.
//
//   • Write path — `lib/actions/mappings-for-redesign.ts` precheck for
//     `createFieldMapping`. When sources span multiple source tables,
//     the wrapper resolves a join_spec for each non-dominant table
//     either via FK inference (one candidate → null join_spec, the
//     read path will re-derive the annotation) or via user
//     disambiguation (passed through as `joinAnnotations`).
//
// Both callers consume the same field shape (`FkInferenceField`); the
// helper is intentionally generic so the read path's `RawFieldRow` and
// the wrapper's narrower projection can both pass through.
//
// `fk_reference` is a free-form text annotation produced by schema
// ingestion. Documented shapes from production data:
//
//   • `"CustomerMaster.ContactID"`  — "table.field"  (Heritage uses this)
//   • `"CustomerMaster(ContactID)"` — "table(field)"
//   • `"CustomerMaster"`            — bare table name
//   • UUID string                   — direct table id reference
//
// Match by exact UUID OR by leading-token table name. When the
// fk_reference is ambiguous or uses an unrecognized shape, callers
// fall through to the structured `join_spec` JSONB (read path) or
// surface CROSS_TABLE_AMBIGUOUS with empty candidates (write path).

/**
 * Minimal field projection consumable by the FK inference helpers.
 * Both `RawFieldRow` (read path) and the wrapper's `(name,
 * is_foreign_key, fk_reference)` projection satisfy this shape.
 */
export interface FkInferenceField {
  name: string
  is_foreign_key: boolean | null
  fk_reference: string | null
}

/**
 * Minimal table projection used to resolve schema-qualified
 * `fk_reference` strings back to a table id when the leading token
 * doesn't match the joined table's bare name. Both `RawTableRow` and
 * `{ id, name }` satisfy this shape.
 */
export interface FkInferenceTable {
  id: string
  name: string
}

/**
 * Check whether an `fk_reference` string points at the given table.
 *
 * Match precedence:
 *   1. Direct UUID match (rare but unambiguous).
 *   2. Leading-token name match (`"<JoinedTable>.<col>"`,
 *      `"<JoinedTable>(<col>)"`, or bare `"<JoinedTable>"`).
 *   3. Defensive table-id resolution: if the leading token names a
 *      different table, look it up in `tablesById` and check that
 *      lookup's id against `joinedTableId`.
 *
 * Returns false for unrecognized shapes — callers fall through to
 * `join_spec` (read path) or treat as zero-candidate (write path).
 */
export function fkReferenceTargetsTable(
  fkReference: string,
  joinedTableId: string,
  joinedTableName: string,
  tablesById: Map<string, FkInferenceTable>,
): boolean {
  if (fkReference === joinedTableId) return true

  const leadingTableName = fkReference.split(/[.(\s]/, 1)[0]
  if (leadingTableName === joinedTableName) return true

  const byName = [...tablesById.values()].find(
    (t) => t.name === leadingTableName,
  )
  return byName !== undefined && byName.id === joinedTableId
}

/**
 * Return the FK field names in `dominantTableFields` whose
 * `fk_reference` resolves to `joinedTableId`. Order is preserved from
 * the input — callers control the surface order (e.g. by
 * `ordinal_position`).
 *
 * Branch interpretation:
 *   • `[]`                   — zero FKs found. Wrapper returns
 *     CROSS_TABLE_AMBIGUOUS with empty candidates; copy directs the
 *     user to add an FK or use the legacy Mapping page.
 *   • `[name]`               — exactly one FK. Wrapper stores
 *     `join_spec=null`; read path re-derives annotation via
 *     `fkReferenceTargetsTable`.
 *   • `[name1, name2, …]`    — multiple FKs. Wrapper returns
 *     CROSS_TABLE_AMBIGUOUS with the candidate list; form renders
 *     a disambiguation dropdown.
 */
export function inferFkCandidates(
  dominantTableFields: FkInferenceField[],
  joinedTableId: string,
  joinedTableName: string,
  tablesById: Map<string, FkInferenceTable>,
): string[] {
  const out: string[] = []
  for (const f of dominantTableFields) {
    if (f.is_foreign_key !== true) continue
    if (f.fk_reference === null) continue
    if (
      fkReferenceTargetsTable(
        f.fk_reference,
        joinedTableId,
        joinedTableName,
        tablesById,
      )
    ) {
      out.push(f.name)
    }
  }
  return out
}

/**
 * Parse the `toFkField` (joined table's referenced column) from a
 * `fk_reference` string. Heritage and most production schemas use the
 * `"TABLE.COLUMN"` shape, where COLUMN is the joined table's primary
 * key. Returns null when the shape doesn't expose a column.
 *
 * Used by the wrapper to populate `JoinSpec.toFkField` when persisting
 * a user-disambiguated cross-table mapping. Read path's
 * `deriveJoinAnnotation` does NOT consume `toFkField` (it parses
 * `viaFkField` only), so a null return is non-fatal — the wrapper
 * stores it as null and the editor UI from §9 Q3 will surface the
 * limitation when it lands.
 *
 * Recognized shapes:
 *   • `"Table.Column"`    → `"Column"`
 *   • `"Table(Column)"`   → `"Column"`
 *   • `"Table"`           → `null`
 *   • UUID                → `null`
 */
export function parseToFkFieldFromReference(
  fkReference: string,
): string | null {
  // "Table.Column" — split on first dot.
  const dotIdx = fkReference.indexOf('.')
  if (dotIdx > 0 && dotIdx < fkReference.length - 1) {
    const tail = fkReference.slice(dotIdx + 1).trim()
    if (tail.length > 0 && !tail.includes('.')) return tail
    if (tail.length > 0) return tail.split('.')[0] // schema-qualified safety
  }

  // "Table(Column)" — extract paren contents.
  const parenMatch = fkReference.match(/^[^(]+\(([^)]+)\)\s*$/)
  if (parenMatch) {
    const col = parenMatch[1].trim()
    if (col.length > 0) return col
  }

  return null
}
