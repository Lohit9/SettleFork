/**
 * schema_source priority cascade.
 *
 * Every field row carries a `schema_source` label identifying where its
 * structural metadata came from. When multiple write paths want to update
 * the same field, the higher-authority source wins and the lower one is
 * skipped. The ordering encodes our trust model:
 *
 *   inferred             — CSV header + value sampling. Heuristic, noisy.
 *   cross_table_inferred — Name match + value-overlap verification across
 *                          sibling tables. Higher than `inferred` because
 *                          it's corroborated by actual data.
 *   doc_enriched         — AI enrichment reading uploaded documentation.
 *                          Higher than inference because a human wrote the
 *                          doc; lower than DDL because AI still has to
 *                          interpret it.
 *   ddl_parsed           — Parsed from an uploaded DDL or live
 *                          `information_schema` introspection. The engineer
 *                          who authored the DDL is the authority on the
 *                          schema shape.
 *   manual               — User explicitly edited the field in the UI.
 *                          Always wins.
 *
 * The order is preserved in the array below. Adding a new label:
 *   1. Insert at the correct priority slot (not just the end).
 *   2. Update migration 063 (or add a new migration) so the CHECK
 *      constraint accepts the value.
 *   3. Update `FieldSchemaSource` in lib/types/database.ts.
 */

export const SCHEMA_SOURCE_PRIORITY = [
  'inferred',
  'cross_table_inferred',
  'doc_enriched',
  'ddl_parsed',
  'manual',
] as const

export type SchemaSource = typeof SCHEMA_SOURCE_PRIORITY[number]

/**
 * Returns true if `newSource` has equal or higher priority than
 * `existingSource`, i.e. it's safe to overwrite. Equal priority is allowed
 * so a source can refresh its own output on a re-run (e.g. re-enrichment
 * after the user uploads a new doc).
 *
 * Unknown `existingSource` strings are treated as overridable — this lets
 * callers guard against legacy rows or DB values that predate a rename,
 * without needing to branch on whether the value is in the union.
 *
 * @param existingSource  The `schema_source` currently on the field row.
 * @param newSource       The label the writer wants to stamp.
 */
export function canOverride(
  existingSource: SchemaSource | string,
  newSource: SchemaSource
): boolean {
  const existingIdx = SCHEMA_SOURCE_PRIORITY.indexOf(existingSource as SchemaSource)
  const newIdx = SCHEMA_SOURCE_PRIORITY.indexOf(newSource)
  if (existingIdx === -1) return true
  return newIdx >= existingIdx
}
