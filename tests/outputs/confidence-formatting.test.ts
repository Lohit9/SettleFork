/**
 * Regression guard for the confidence-formatter bug fixed in Prompt 3c
 * (2026-04-22). Three sites historically computed `Math.round(c * 100)`
 * against a stored 0–100 integer, producing absurd values like
 * `[confidence: 9500%]`. See `docs/prompt-3a-remaining-work.md` ▸
 * Bugs fixed in Prompt 3c.
 *
 * This test asserts that every pure prompt-assembly path in scope for
 * Prompt 3c renders confidence in a realistic range (≤100%). Any
 * regression to the stray multiplier will produce a three-digit-plus
 * percentage somewhere and fail one of these assertions immediately.
 *
 * Assertions are deliberately paranoid:
 *   1. Exact string `9500%` (the value rendered by the old formula with
 *      the fixture's max-confidence row) must not appear.
 *   2. Nothing in the output matches `/\b\d{3,}%/` — three-or-more-digit
 *      percentages. 100% is allowed (boundary) but 101%+ is not.
 *   3. Every `[confidence: N%]` payload (the exact template used by the
 *      prompt assembler) must have N in [0, 100].
 */

import { describe, it, expect } from 'vitest'
import { fixture } from '../fixtures/outputs/seed'
import {
  assembleMonolithicPrompt,
  assembleCompartmentalizedPrompt,
} from '@/lib/actions/_execution-package-prompt'
import type { ExecutionPackageContext } from '@/lib/actions/_execution-package-prompt'

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

const THREE_PLUS_DIGIT_PERCENT = /\b\d{3,}%/g
const CONF_PAYLOAD = /\[confidence:\s*(\d+)%\]/g

function assertSaneConfidence(label: string, text: string): void {
  // Assertion 1: the specific legacy-bug value must not appear.
  expect(text, `${label}: legacy-bug value 9500% must not appear`).not.toContain('9500%')

  // Assertion 2: no three-or-more-digit percentages except exactly 100%.
  // Three-digit values other than 100 are evidence of the stray multiplier
  // (e.g. 4000%, 8800%, 9500%). 100% itself is a legitimate boundary.
  const matches = text.match(THREE_PLUS_DIGIT_PERCENT) ?? []
  const illegal = matches.filter((m) => m !== '100%')
  expect(illegal, `${label}: unexpected three-digit-plus percentages`).toEqual([])

  // Assertion 3: every rendered `[confidence: N%]` payload is in range.
  let m: RegExpExecArray | null
  const re = new RegExp(CONF_PAYLOAD.source, 'g')
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1])
    expect(n, `${label}: confidence value ${n} out of [0, 100]`).toBeGreaterThanOrEqual(0)
    expect(n, `${label}: confidence value ${n} out of [0, 100]`).toBeLessThanOrEqual(100)
  }
}

describe('confidence formatter — 0–100 integer semantics (no stray * 100)', () => {
  it('monolithic prompt renders realistic confidence values', () => {
    const ctx = buildCtx()
    const { systemPrompt, userMessage } = assembleMonolithicPrompt(ctx, 'postgresql')
    assertSaneConfidence('monolithic.userMessage', userMessage)
    assertSaneConfidence('monolithic.systemPrompt', systemPrompt)
  })

  it('compartmentalized primary and fallback prompts render realistic confidence values', () => {
    const ctx = buildCtx()
    const bundle = assembleCompartmentalizedPrompt(ctx, 'postgresql')
    assertSaneConfidence('compartmentalized.primary.userMessage', bundle.userMessage)
    assertSaneConfidence('compartmentalized.primary.systemPrompt', bundle.systemPrompt)
    // The fallback monolithic bundle is pre-assembled inside the same
    // helper call so the orchestrator can fire it without re-fetching
    // context. Regression-guard both paths.
    assertSaneConfidence('compartmentalized.fallback.userMessage', bundle.fallbackUserMessage)
    assertSaneConfidence('compartmentalized.fallback.systemPrompt', bundle.fallbackSystemPrompt)
  })

  it('fixture contains at least one confidence row in the realistic-but-not-boundary range', () => {
    // If the fixture ever drifts back to 0–1 fractions, the prompt
    // assembler's Math.round() will render values like 1%, which would
    // silently pass the bounds checks above. This guards that the
    // fixture itself continues to exercise realistic production values.
    const ctx = buildCtx()
    const { userMessage } = assembleMonolithicPrompt(ctx, 'postgresql')
    const numbers: number[] = []
    let m: RegExpExecArray | null
    const re = new RegExp(CONF_PAYLOAD.source, 'g')
    while ((m = re.exec(userMessage)) !== null) numbers.push(Number(m[1]))
    expect(numbers.length, 'fixture must emit at least one confidence payload').toBeGreaterThan(0)
    const realistic = numbers.filter((n) => n >= 40 && n <= 99)
    expect(
      realistic.length,
      `fixture must contain at least one confidence in [40, 99] to exercise the realistic range; saw ${JSON.stringify(numbers)}`,
    ).toBeGreaterThan(0)
  })
})
