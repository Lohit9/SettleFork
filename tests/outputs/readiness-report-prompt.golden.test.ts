/**
 * Test 9 — Golden test for the readiness-report LLM prompt.
 *
 * Feeds the hand-constructed fixture through `buildReadinessReportPrompt`
 * and pins BOTH the `userMessage` body AND the derived metrics that are
 * surfaced to `generateReadinessReport` (approvedSourceFieldsMapped,
 * approvedTargetFieldsMapped, sourceCoveragePct, avgConfidence,
 * rejectedMappingsCount, …).
 *
 * The metrics are pinned in a separate `.params.json` fixture because
 * they also flow into the customer-visible DOCX header — any drift
 * there surfaces in production reports without touching the LLM prompt.
 *
 * Pinned files:
 *   - readiness-report-prompt.expected.md
 *     The full `userMessage` with `<ISO_TIMESTAMP>` redaction applied.
 *   - readiness-report-prompt.params.json
 *     { systemPrompt, maxTokens, …derived metrics }.
 */

import { describe, it, expect } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import { buildReadinessReportPrompt } from '@/lib/actions/_outputs-translators'
import { assertMatchesFixture, assertMatchesJsonFixture } from './_fixture-assert'

function buildInput() {
  return {
    projectName: 'Heritage Core Migration',
    srcDatasetName: fixture.datasets.find((d) => d.role === 'source')!.name,
    tgtDatasetName: fixture.datasets.find((d) => d.role === 'target')!.name,
    srcTableCount: fixture.tables.filter((t) => t.dataset_id === fixture.ids.datasetSource).length,
    tgtTableCount: fixture.tables.filter((t) => t.dataset_id === fixture.ids.datasetTarget).length,
    totalSourceRows: fixture.tables
      .filter((t) => t.dataset_id === fixture.ids.datasetSource)
      .reduce((s, t) => s + (t.row_count ?? 0), 0),
    totalSourceFields: fixture.fields.filter((f) =>
      fixture.tables.some((t) => t.id === f.table_id && t.dataset_id === fixture.ids.datasetSource),
    ).length,
    readinessScore: 82,
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
  }
}

describe('Test 9 — buildReadinessReportPrompt golden', () => {
  it('userMessage matches the golden fixture', () => {
    const bundle = buildReadinessReportPrompt(buildInput())
    assertMatchesFixture(bundle.userMessage, 'readiness-report-prompt.expected.md')
  })

  it('systemPrompt + maxTokens + derived metrics match the golden params fixture', () => {
    const bundle = buildReadinessReportPrompt(buildInput())

    assertMatchesJsonFixture(
      {
        systemPrompt: bundle.systemPrompt,
        maxTokens: bundle.maxTokens,
        approvedSourceFieldsMapped: bundle.approvedSourceFieldsMapped,
        approvedTargetFieldsMapped: bundle.approvedTargetFieldsMapped,
        sourceCoveragePct: bundle.sourceCoveragePct,
        unmappedSourceFieldsCount: bundle.unmappedSourceFieldsCount,
        approvedTableMappingsCount: bundle.approvedTableMappingsCount,
        rejectedMappingsCount: bundle.rejectedMappingsCount,
        avgConfidence: bundle.avgConfidence,
        openBlocking: bundle.openBlocking,
        openWarnings: bundle.openWarnings,
        savedTransformsCount: bundle.savedTransformsCount,
      },
      'readiness-report-prompt.params.json',
    )
  })

  it('rejectedMappingsCount = 1 (TFM-9) and does not leak the rejected target name into userMessage', () => {
    const bundle = buildReadinessReportPrompt(buildInput())
    expect(bundle.rejectedMappingsCount).toBe(1)
    expect(bundle.userMessage).not.toContain('t_deprecated_flag')
    expect(bundle.userMessage).not.toContain('s_legacy_flag')
  })
})
