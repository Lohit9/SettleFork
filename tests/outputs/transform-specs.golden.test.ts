/**
 * Golden-output test for `buildTransformSpecsLines`.
 *
 * Coverage:
 *   - Header block (Project / Generated / Total transforms)
 *   - T-1: NOT applied (status='saved' → ○ Draft mark via legacy ternary;
 *                        byte-preserved intentionally — see translator comment)
 *   - T-2..T-8: applied (status='applied' → ○ Draft mark again; preserved
 *                         byte-for-byte with legacy — the status-mark
 *                         mislabelling is a known caveat NOT fixed in 3c)
 *   - T-4: value-assignment transform (no source field → '[Value Assignment]'
 *           label in the header comment)
 *
 * Regenerate via:
 *   UPDATE_FIXTURES=1 npx vitest tests/outputs/transform-specs.golden.test.ts
 */

import { describe, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  buildTransformSpecsLines,
  type TranslatorField,
  type TranslatorTable,
} from '@/lib/actions/_outputs-translators'
import { assertMatchesFixture } from './_fixture-assert'

describe('buildTransformSpecsLines — transform-specs golden', () => {
  it('renders byte-stable SQL spec output for the fixture', () => {
    const fieldsById = new Map<string, TranslatorField>(
      fixture.fields.map((f) => [
        f.id,
        {
          id: f.id,
          table_id: f.table_id,
          name: f.name,
          data_type: f.data_type,
          ordinal_position: f.ordinal_position,
        },
      ]),
    )
    const tablesById = new Map<string, TranslatorTable>(
      fixture.tables.map((t) => [t.id, { id: t.id, dataset_id: t.dataset_id, name: t.name, row_count: t.row_count }]),
    )

    const lines = buildTransformSpecsLines({
      projectName: 'Fixture Project',
      generatedAt: 'Wed, 15 Jan 2026 12:00:00 GMT',
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById,
      tablesById,
    })

    assertMatchesFixture(lines.join('\n') + '\n', 'transform-specs.expected.sql')
  })
})
