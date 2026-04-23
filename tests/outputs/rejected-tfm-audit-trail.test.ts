/**
 * Test 11 — Rejected-TFM audit-trail contract.
 *
 * Asserts that TFM-9 (status='rejected', source=s_legacy_flag,
 * target=t_deprecated_flag, owned by tmCust after the 2026-04-22 Flag 2
 * relocation) is INCLUDED in the two customer-facing audit-trail exports
 * (mapping-file CSV, mapping-file JSON) and EXCLUDED from every execution
 * artifact that drives actual data movement (transform-specs,
 * gold-standard SELECT, SQL load inserts, readiness-report prompt, both
 * execution-package prompt variants).
 *
 * Eight assertions total (2 inclusion + 6 exclusion). See
 * `tests/fixtures/outputs/seed.ts` ▸ TFM-9 comment for the fixture
 * rationale, and `docs/prompt-3a-remaining-work.md` ▸ Bugs fixed in
 * Prompt 3c for the broader design constraint.
 *
 * IMPORTANT — why this test is scoped to translators (not outputs.ts
 * server actions): the translators are pure; their rejection handling is
 * the single authoritative filter point. If the outputs.ts orchestrators
 * add a second filter they'd double-filter (harmless) or skip the
 * translator filter (harmful). This test pins the translator contract.
 */

import { describe, expect, it } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  buildGoldStandardSelectSQL,
  buildMappingCsvRows,
  buildMappingJsonGroups,
  buildReadinessReportPrompt,
  buildSqlLoadScriptInserts,
  buildTransformSpecsLines,
  type TranslatorDataset,
  type TranslatorField,
  type TranslatorTable,
} from '@/lib/actions/_outputs-translators'
import {
  assembleCompartmentalizedPrompt,
  assembleMonolithicPrompt,
  type ExecutionPackageContext,
} from '@/lib/actions/_execution-package-prompt'

const REJECTED_TARGET = 't_deprecated_flag'
const REJECTED_SOURCE = 's_legacy_flag'

function buildFieldsById(): Map<string, TranslatorField> {
  return new Map(
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
}

function buildTablesById(): Map<string, TranslatorTable> {
  return new Map(
    fixture.tables.map((t) => [t.id, { id: t.id, dataset_id: t.dataset_id, name: t.name, row_count: t.row_count }]),
  )
}

function buildDatasetsById(): Map<string, TranslatorDataset> {
  return new Map(fixture.datasets.map((d) => [d.id, { id: d.id, name: d.name, role: d.role }]))
}

function buildExecPackageCtx(): ExecutionPackageContext {
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

describe('Test 11 — rejected TFM audit-trail contract (TFM-9)', () => {
  it('INCLUDES TFM-9 in mapping-file CSV (assertion 1 of 8)', () => {
    const rows = buildMappingCsvRows({
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      tablesById: buildTablesById(),
    })

    const rejectedRow = rows.find(
      (r) => r.target_field === REJECTED_TARGET && r.source_field === REJECTED_SOURCE,
    )
    expect(rejectedRow, 'TFM-9 missing from mapping-file CSV audit trail').toBeDefined()
    expect(rejectedRow!.status).toBe('rejected')
  })

  it('INCLUDES TFM-9 in mapping-file JSON (assertion 2 of 8)', () => {
    const groups = buildMappingJsonGroups({
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      tablesById: buildTablesById(),
      datasetsById: buildDatasetsById(),
    })

    const custGroup = groups.find((g) => g.target.table === 't_customers')
    expect(custGroup, 'tmCust group missing from JSON export').toBeDefined()
    const rejectedFm = custGroup!.field_mappings.find(
      (fm) => fm.target_field === REJECTED_TARGET && fm.source_field === REJECTED_SOURCE,
    )
    expect(rejectedFm, 'TFM-9 missing from mapping-file JSON audit trail').toBeDefined()
    expect(rejectedFm!.status).toBe('rejected')
  })

  it('EXCLUDES TFM-9 from transform-specs (assertion 3 of 8)', () => {
    const lines = buildTransformSpecsLines({
      projectName: 'Heritage Core',
      generatedAt: '<UTC_TIMESTAMP>',
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      tablesById: buildTablesById(),
    })
    const body = lines.join('\n')
    expect(body).not.toContain(REJECTED_TARGET)
    expect(body).not.toContain(REJECTED_SOURCE)
  })

  it('EXCLUDES TFM-9 from gold-standard SELECT for t_customers (assertion 4 of 8)', () => {
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

    expect(result.targetFieldNames).not.toContain(REJECTED_TARGET)
    expect(result.selectSQL).not.toContain(REJECTED_TARGET)
  })

  it('EXCLUDES TFM-9 from SQL load inserts for t_customers (assertion 5 of 8)', () => {
    // SQL load inserts take targetFieldNames from the gold-standard SELECT
    // result. If gold-standard correctly excludes, inserts cannot reference
    // the rejected column. Pin this by composing both translators here.
    const tmCust = fixture.tableMappings.find((tm) => tm.id === fixture.ids.tmCust)!
    const allSourceFieldNames = fixture.fields
      .filter((f) => f.table_id === tmCust.source_table_id)
      .map((f) => f.name)

    const gs = buildGoldStandardSelectSQL({
      tableMapping: tmCust,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      transformations: fixture.transformations,
      fieldsById: buildFieldsById(),
      allSourceFieldNames,
    })

    const sql = buildSqlLoadScriptInserts({
      targetTableName: 't_customers',
      sourceTableName: 's_customers',
      sourceDatasetName: 'Legacy CRM',
      generatedAt: '<UTC_TIMESTAMP>',
      rows: [],
      targetFieldNames: gs.targetFieldNames,
    })

    expect(sql).not.toContain(REJECTED_TARGET)
    expect(gs.targetFieldNames).not.toContain(REJECTED_TARGET)
  })

  it('EXCLUDES TFM-9 from readiness-report prompt (assertion 6 of 8)', () => {
    const bundle = buildReadinessReportPrompt({
      projectName: 'Heritage Core',
      srcDatasetName: 'Legacy CRM',
      tgtDatasetName: 'Modern ERP',
      srcTableCount: 2,
      tgtTableCount: 2,
      totalSourceRows: 350,
      totalSourceFields: 9,
      readinessScore: 85,
      readinessLabel: 'Ready with Conditions',
      tableMappings: fixture.tableMappings,
      targetFieldMappings: fixture.targetFieldMappings,
      mappingSources: fixture.mappingSources,
      sourceFieldAcknowledgments: fixture.sourceFieldAcknowledgments,
      transformations: fixture.transformations,
      qualityIssues: [],
      fixHistory: [],
      validationRules: [],
      documentBlock: '',
    })

    // The rejected TFM's target field name must not appear anywhere in the
    // userMessage — the readiness report should never present a rejected
    // mapping to Claude as if it were part of the migration plan.
    expect(bundle.userMessage).not.toContain(REJECTED_TARGET)
    // rejectedMappingsCount should be 1 (TFM-9), proving TFM-9 is counted
    // in the aggregate rejection metric but not enumerated in the prompt
    // body.
    expect(bundle.rejectedMappingsCount).toBe(1)
  })

  it('EXCLUDES TFM-9 from the compartmentalized execution-package Approved Mappings block (assertion 7 of 8)', () => {
    const ctx = buildExecPackageCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'postgresql')

    const mappingsIdx = bundle.userMessage.indexOf('## Approved Mappings')
    const qualityIdx = bundle.userMessage.indexOf('## Data Quality Summary')
    expect(mappingsIdx, 'Approved Mappings section not found').toBeGreaterThan(-1)
    expect(qualityIdx, 'Data Quality Summary section not found').toBeGreaterThan(mappingsIdx)
    const mappingsBlock = bundle.userMessage.slice(mappingsIdx, qualityIdx)
    expect(mappingsBlock).not.toContain(REJECTED_TARGET)
    expect(mappingsBlock).not.toContain(REJECTED_SOURCE)
  })

  it('EXCLUDES TFM-9 from the monolithic execution-package Approved Mappings block (assertion 8 of 8)', () => {
    const ctx = buildExecPackageCtx()
    const bundle = assembleMonolithicPrompt(ctx, 'postgresql')

    const mappingsIdx = bundle.userMessage.indexOf('## Approved Mappings')
    const qualityIdx = bundle.userMessage.indexOf('## Data Quality Summary')
    expect(mappingsIdx).toBeGreaterThan(-1)
    expect(qualityIdx).toBeGreaterThan(mappingsIdx)
    const mappingsBlock = bundle.userMessage.slice(mappingsIdx, qualityIdx)
    expect(mappingsBlock).not.toContain(REJECTED_TARGET)
    expect(mappingsBlock).not.toContain(REJECTED_SOURCE)
  })
})
