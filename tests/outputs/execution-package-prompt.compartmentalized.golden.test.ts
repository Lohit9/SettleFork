/**
 * Test 8 — Golden test for the compartmentalized execution-package LLM prompts.
 *
 * Feeds the hand-constructed fixture into `assembleCompartmentalizedPrompt`
 * and pins BOTH the primary bundle AND the precomputed monolithic fallback
 * bundle. The fallback bundle fires when dialect validation rejects Claude's
 * compartmentalized JSON output — its content is fully determined at
 * prompt-assembly time, so it belongs in the golden fixture.
 *
 * Pinned files:
 *   - execution-package-prompt.compartmentalized.expected.md
 *     Contains the primary userMessage followed by a `---FALLBACK---` marker
 *     and the fallback userMessage, concatenated so one fixture diff covers
 *     both paths.
 *   - execution-package-prompt.compartmentalized.params.json
 *     { systemPrompt, maxTokens, fallbackSystemPrompt, fallbackMaxTokens }
 */

import { describe, it, expect } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import { assembleCompartmentalizedPrompt } from '@/lib/actions/_execution-package-prompt'
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

describe('Test 8 — generateCompartmentalizedPackage prompt', () => {
  it('primary + fallback userMessages match the golden fixture', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'tsql')

    const combined =
      bundle.userMessage +
      '\n\n---FALLBACK---\n\n' +
      bundle.fallbackUserMessage

    assertMatchesFixture(
      combined,
      'execution-package-prompt.compartmentalized.expected.md',
    )
  })

  it('systemPrompt + fallbackSystemPrompt + maxTokens match the golden params fixture', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'tsql')

    assertMatchesJsonFixture(
      {
        systemPrompt: bundle.systemPrompt,
        maxTokens: bundle.maxTokens,
        fallbackSystemPrompt: bundle.fallbackSystemPrompt,
        fallbackMaxTokens: bundle.fallbackMaxTokens,
      },
      'execution-package-prompt.compartmentalized.params.json',
    )
  })

  it('dialect label + identifier style propagate into the userMessage (tsql case)', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'tsql')

    expect(bundle.userMessage).toContain('T-SQL (MS SQL Server)')
    expect(bundle.userMessage).toContain('[bracket] identifiers')
  })

  it('dialect label + identifier style propagate into the userMessage (mysql case)', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'mysql')

    expect(bundle.userMessage).toContain('MySQL')
    expect(bundle.userMessage).toContain('backtick identifiers')
  })

  it('excludes rejected TFM-9 and acknowledged TFM-5 from approved-mappings block', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'postgresql')

    // t_deprecated_flag and t_notes legitimately appear in ## Target Schema —
    // the exclusion rule is that they must not appear as targets of ANY line
    // in ## Approved Mappings. (Flag 2: TFM-9 was relocated from t_orphan to
    // t_deprecated_flag on 2026-04-22 to ensure it's actually owned by tmCust
    // and not silently dropped by the grouping pipeline.)
    const mappingsIdx = bundle.userMessage.indexOf('## Approved Mappings')
    const qualityIdx = bundle.userMessage.indexOf('## Data Quality Summary')
    const mappingsBlock = bundle.userMessage.slice(mappingsIdx, qualityIdx)
    expect(mappingsBlock).not.toContain('t_deprecated_flag')
    expect(mappingsBlock).not.toContain('t_notes')
  })
})
