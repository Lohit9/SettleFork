/**
 * Test 7 — Golden test for the monolithic execution-package LLM prompt.
 *
 * Feeds the hand-constructed fixture (`tests/fixtures/outputs/seed.ts`) into
 * the pure prompt assembler and pins the resulting `{ userMessage,
 * systemPrompt, maxTokens }` bundle against three checked-in fixtures:
 *
 *   - execution-package-prompt.monolithic.expected.md    (userMessage)
 *   - execution-package-prompt.monolithic.params.json    ({ systemPrompt, maxTokens })
 *
 * Variable content in the userMessage (specifically the ISO timestamp on the
 * "Generated:" line, line 4) is normalized by `redactVariableContent` before
 * comparison so the fixture is byte-stable across CI runs. See
 * `_fixture-assert.ts` for the complete redaction list.
 *
 * What this test catches:
 *   - Drift in mapping-section output against the new data model
 *     (target_field_mappings + mapping_sources): a concat_space TFM should
 *     still produce primary + contributor lines.
 *   - Accidental removal of the rejected-TFM exclusion rule (TFM-9 must not
 *     appear anywhere).
 *   - Accidental inclusion of target-acknowledged TFMs (TFM-5 must not
 *     appear anywhere).
 *   - Accidental inclusion of source-acknowledged fields in the source-table
 *     field listing.
 *   - Drift in system-prompt text (EXECUTION_PACKAGE_SYSTEM_PROMPT +
 *     dialect instructions).
 */

import { describe, it, expect } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import { assembleMonolithicPrompt } from '@/lib/actions/_execution-package-prompt'
import type { ExecutionPackageContext } from '@/lib/actions/_execution-package-prompt'
import { assertMatchesFixture, assertMatchesJsonFixture } from './_fixture-assert'

function buildCtx(): ExecutionPackageContext {
  return {
    projectName: 'Heritage Core Migration',
    sourceDatasetName: fixture.datasets.find((d) => d.role === 'source')!.name,
    targetDatasetName: fixture.datasets.find((d) => d.role === 'target')!.name,
    sourceTables: fixture.tables
      .filter((t) => t.dataset_id === fixture.ids.datasetSource)
      .map((t) => ({ id: t.id, dataset_id: t.dataset_id, name: t.name, row_count: t.row_count })),
    targetTables: fixture.tables
      .filter((t) => t.dataset_id === fixture.ids.datasetTarget)
      .map((t) => ({ id: t.id, dataset_id: t.dataset_id, name: t.name, row_count: t.row_count })),
    sourceFields: fixture.fields
      .filter((f) =>
        fixture.tables.some((t) => t.id === f.table_id && t.dataset_id === fixture.ids.datasetSource),
      )
      .map((f) => ({
        id: f.id,
        table_id: f.table_id,
        name: f.name,
        data_type: f.data_type,
        inferred_type: f.inferred_type,
        ordinal_position: f.ordinal_position,
      })),
    targetFields: fixture.fields
      .filter((f) =>
        fixture.tables.some((t) => t.id === f.table_id && t.dataset_id === fixture.ids.datasetTarget),
      )
      .map((f) => ({
        id: f.id,
        table_id: f.table_id,
        name: f.name,
        data_type: f.data_type,
        is_nullable: f.is_nullable,
        is_primary_key: f.is_primary_key,
        is_foreign_key: f.is_foreign_key,
        fk_reference: f.fk_reference,
        check_constraint: null,
        ordinal_position: f.ordinal_position,
      })),
    tableMappings: fixture.tableMappings.map((tm) => ({
      id: tm.id,
      source_table_id: tm.source_table_id,
      target_table_id: tm.target_table_id,
    })),
    targetFieldMappings: [...fixture.targetFieldMappings],
    mappingSources: [...fixture.mappingSources],
    transformations: [...fixture.transformations],
    qualityIssues: [],
    validationRules: [],
    schemaDocs: [],
    generatedAt: '2026-04-22T00:00:00.000Z',
  }
}

describe('Test 7 — generateExecutionPackage monolithic prompt', () => {
  it('assembled userMessage matches the golden fixture', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    assertMatchesFixture(
      bundle.userMessage,
      'execution-package-prompt.monolithic.expected.md',
    )
  })

  it('assembled systemPrompt + maxTokens match the golden params fixture', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    assertMatchesJsonFixture(
      {
        systemPrompt: bundle.systemPrompt,
        maxTokens: bundle.maxTokens,
      },
      'execution-package-prompt.monolithic.params.json',
    )
  })

  it('excludes rejected TFM-9 from mapping sections', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    // TFM-9 targets t_deprecated_flag with source s_legacy_flag. The target
    // COLUMN t_deprecated_flag legitimately appears in the ## Target Schema
    // block because that block describes the schema (projection-independent).
    // What must NEVER appear is a MAPPING line inside ## Approved Mappings
    // that references t_deprecated_flag as a target. (Flag 2, 2026-04-22:
    // TFM-9 relocated from t_orphan so it's actually owned by tmCust.)
    const mappingsIdx = bundle.userMessage.indexOf('## Approved Mappings')
    const qualityIdx = bundle.userMessage.indexOf('## Data Quality Summary')
    const mappingsBlock = bundle.userMessage.slice(mappingsIdx, qualityIdx)
    expect(mappingsBlock).not.toContain('t_deprecated_flag')
  })

  it('excludes acknowledged TFM-5 (t_notes) from mapping sections', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    // TFM-5 is a bare target acknowledgment. It must not appear in the
    // ## Approved Mappings section. t_notes DOES appear in the ## Target
    // Schema block (that's by design — the schema lists every column),
    // so we assert absence from mapping-specific lines, not the full prompt.
    const mappingsIdx = bundle.userMessage.indexOf('## Approved Mappings')
    const qualityIdx = bundle.userMessage.indexOf('## Data Quality Summary')
    const mappingsBlock = bundle.userMessage.slice(mappingsIdx, qualityIdx)
    expect(mappingsBlock).not.toContain('t_notes')
  })

  it('contains the multi-source (TFM-2 concat_space) primary + contributor lines', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    // Primary line
    expect(bundle.userMessage).toContain('s_first_name (text) → t_full_name (text)')
    // Contributor line — same target, different source, no transform block
    expect(bundle.userMessage).toContain('s_last_name (text) → t_full_name (text)')
  })

  it('surfaces the value-assignment (TFM-4) marker for t_tenant_id', () => {
    const ctx = buildCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    // VA primary line
    expect(bundle.userMessage).toContain('[Value Assignment] → t_tenant_id (uuid)')
    // VA has an applied transform (T-4), so the "No value expression defined yet"
    // marker should be absent and the Transform SQL should be present.
    expect(bundle.userMessage).toContain('00000000-0000-0000-0000-000000000001')
  })
})
