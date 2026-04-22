/**
 * Golden-output test for `buildMappingCsvRows`.
 *
 * Scope: asserts that rendering the CSV rows from the hand-constructed
 * fixture in `tests/fixtures/outputs/seed.ts` produces byte-stable output
 * matching `tests/fixtures/outputs/mapping-file.csv.expected.csv`.
 *
 * Coverage (per seed.ts coverage matrix):
 *   - Case 1  1:1 with transform (TFM-1, TFM-8)
 *   - Case 2  concat_space multi-source (TFM-2: primary + contributor row)
 *   - Case 3  value assignment (TFM-4 → source_field='[Value Assignment]')
 *   - Case 4  target acknowledgment — EXCLUDED (TFM-5 is bare ack)
 *   - Case 9  rejected TFM (TFM-9) — INCLUDED in CSV (audit trail)
 *
 * Regenerate after intentional changes via:
 *   UPDATE_FIXTURES=1 npx vitest tests/outputs/mapping-file.csv.golden.test.ts
 */

import { describe, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  buildMappingCsvRows,
  MAPPING_CSV_HEADERS,
  type TranslatorField,
  type TranslatorTable,
} from '@/lib/actions/_outputs-translators'
import { assertMatchesFixture } from './_fixture-assert'

function buildCSV(headers: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }
  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n')
}

describe('buildMappingCsvRows — mapping-file.csv golden', () => {
  it('renders a byte-stable CSV for the fixture', () => {
    const fieldsById = new Map<string, TranslatorField>(
      fixture.fields.map((f) => [
        f.id,
        {
          id: f.id,
          table_id: f.table_id,
          name: f.name,
          data_type: f.data_type,
          inferred_type: f.inferred_type,
          is_nullable: f.is_nullable,
          is_primary_key: f.is_primary_key,
          is_foreign_key: f.is_foreign_key,
          fk_reference: f.fk_reference,
          ordinal_position: f.ordinal_position,
        },
      ]),
    )
    const tablesById = new Map<string, TranslatorTable>(
      fixture.tables.map((t) => [t.id, { id: t.id, dataset_id: t.dataset_id, name: t.name, row_count: t.row_count }]),
    )

    const rows = buildMappingCsvRows({
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById,
      tablesById,
    })

    const csv = buildCSV(MAPPING_CSV_HEADERS, rows as unknown as Record<string, unknown>[])
    assertMatchesFixture(csv + '\n', 'mapping-file.csv.expected.csv')
  })
})
