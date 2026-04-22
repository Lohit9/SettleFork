/**
 * Golden-output test for `buildMappingJsonGroups`.
 *
 * Scope: asserts that the JSON-mode mapping-file export from the fixture
 * is byte-stable. Same coverage matrix as the CSV golden plus dataset-name
 * resolution (the JSON embeds `source.dataset` / `target.dataset`).
 *
 * Regenerate via:
 *   UPDATE_FIXTURES=1 npx vitest tests/outputs/mapping-file.json.golden.test.ts
 */

import { describe, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  buildMappingJsonGroups,
  type TranslatorDataset,
  type TranslatorField,
  type TranslatorTable,
} from '@/lib/actions/_outputs-translators'
import { assertMatchesFixture } from './_fixture-assert'

describe('buildMappingJsonGroups — mapping-file.json golden', () => {
  it('renders byte-stable JSON groups for the fixture', () => {
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
    const datasetsById = new Map<string, TranslatorDataset>(
      fixture.datasets.map((d) => [d.id, { id: d.id, name: d.name, role: d.role }]),
    )

    const groups = buildMappingJsonGroups({
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById,
      tablesById,
      datasetsById,
    })

    const payload = {
      project: 'Fixture Project',
      version: '1.0',
      table_mappings: groups,
    }

    assertMatchesFixture(JSON.stringify(payload, null, 2) + '\n', 'mapping-file.json.expected.json')
  })
})
