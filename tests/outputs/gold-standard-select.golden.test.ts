/**
 * Golden-output + regression tests for `buildGoldStandardSelectSQL`.
 *
 * TESTS IN THIS FILE:
 *
 *   T5   Golden comparison for the fixture's `t_customers` and `t_orders`
 *        TMs (covers 1:1, transform-attached, VA-with-transform, skipped-VA,
 *        skipped bare-ack, skipped rejected TFM paths).
 *
 *   T9   D1 regression: a concat_space TFM WITHOUT an attached transformation
 *        must emit a structured warning and NO column (not a duplicate alias
 *        pair as the legacy did). This is the canonical bug described in the
 *        translator's module header § D1.
 *
 * Regenerate goldens via:
 *   UPDATE_FIXTURES=1 npx vitest tests/outputs/gold-standard-select.golden.test.ts
 */

import { describe, expect, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  buildGoldStandardSelectSQL,
  type TranslatorField,
} from '@/lib/actions/_outputs-translators'
import type {
  MappingSourceRow,
  TargetFieldMappingRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import { assertMatchesFixture } from './_fixture-assert'

function buildFieldsById(): Map<string, TranslatorField> {
  return new Map(
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
}

describe('buildGoldStandardSelectSQL — golden (T5)', () => {
  it('renders byte-stable SELECT for t_customers', () => {
    const tmCust = fixture.tableMappings.find((tm) => tm.id === fixture.ids.tmCust)!
    const allSourceFieldNames = fixture.fields
      .filter((f) => f.table_id === tmCust.source_table_id)
      .map((f) => f.name)

    const result = buildGoldStandardSelectSQL({
      tableMapping: tmCust,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      allSourceFieldNames,
    })

    const payload =
      `-- warnings:\n${result.warnings.map((w) => `-- ${w}`).join('\n') || '-- (none)'}\n\n` +
      `-- target field names (order):\n-- ${result.targetFieldNames.join(', ') || '(none)'}\n\n` +
      `${result.selectSQL}\n`

    assertMatchesFixture(payload, 'gold-standard-select.t-customers.expected.sql')
  })

  it('renders byte-stable SELECT for t_orders', () => {
    const tmOrd = fixture.tableMappings.find((tm) => tm.id === fixture.ids.tmOrd)!
    const allSourceFieldNames = fixture.fields
      .filter((f) => f.table_id === tmOrd.source_table_id)
      .map((f) => f.name)

    const result = buildGoldStandardSelectSQL({
      tableMapping: tmOrd,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      allSourceFieldNames,
    })

    const payload =
      `-- warnings:\n${result.warnings.map((w) => `-- ${w}`).join('\n') || '-- (none)'}\n\n` +
      `-- target field names (order):\n-- ${result.targetFieldNames.join(', ') || '(none)'}\n\n` +
      `${result.selectSQL}\n`

    assertMatchesFixture(payload, 'gold-standard-select.t-orders.expected.sql')
  })
})

describe('buildGoldStandardSelectSQL — D1 regression (T9)', () => {
  it('skips + warns on a concat_space TFM that has no attached transformation', () => {
    // Construct an ad-hoc slice: TFM-2 (concat_space) with its transformation
    // REMOVED. Expect exactly one warning naming the target column, and the
    // target_field_names list to exclude t_full_name.
    const tfmsSansConcatTransform: TargetFieldMappingRow[] = fixture.targetFieldMappings
    const transformsSansConcat: TransformationRow[] = fixture.transformations.filter(
      (t) => t.target_field_mapping_id !== fixture.ids.tfm2,
    )

    const tmCust = fixture.tableMappings.find((tm) => tm.id === fixture.ids.tmCust)!
    const allSourceFieldNames = fixture.fields
      .filter((f) => f.table_id === tmCust.source_table_id)
      .map((f) => f.name)

    const result = buildGoldStandardSelectSQL({
      tableMapping: tmCust,
      targetFieldMappings: tfmsSansConcatTransform,
      mappingSources: fixture.mappingSources as readonly MappingSourceRow[],
      transformations: transformsSansConcat,
      fieldsById: buildFieldsById(),
      allSourceFieldNames,
    })

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('t_full_name')
    expect(result.warnings[0]).toContain('concat_space')
    expect(result.targetFieldNames).not.toContain('t_full_name')

    // The emitted SELECT must not contain two "t_full_name" aliases — that
    // would be the legacy duplicate-alias bug. (This specifically guards
    // against a regression that reintroduces the contributor fallback.)
    const aliasMatches = result.selectSQL.match(/"t_full_name"/g)
    expect(aliasMatches).toBeNull()
  })
})
