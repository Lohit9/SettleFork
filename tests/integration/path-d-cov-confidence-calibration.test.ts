// @vitest-environment node
//
// PR γ.1 Stop 1 — Coverage confidence calibration spot-check.
//
// Calls Path D against either an eval fixture OR a real Supabase
// project, captures the response, and analyses the per-coverage-row
// confidence emission added by the Stop 1 prompt + parser change.
//
// NOT default vitest. NOT CI. Env-gated; opt-in only.
//
// Cost per run: ~$0.30-0.80 per fixture/project (Opus 4.7, ~30k input).
//
// Env required:
//   RUN_PATH_D_COV_CALIBRATION=1
//   ANTHROPIC_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL          (for project-id mode + best-effort
//   SUPABASE_SERVICE_ROLE_KEY          llm_calls write)
//
// Mode selection (mutually exclusive):
//   PATH_D_COV_FIXTURE=<fixture-name>   (use one of the 4 eval fixtures)
//   PATH_D_COV_PROJECT_ID=<uuid>        (use a real project from Supabase)
//
// Optional:
//   PATH_D_COV_CSV_OUT=<path>           (dump per-row CSV to this path)
//
// Usage examples:
//   RUN_PATH_D_COV_CALIBRATION=1 \
//     PATH_D_COV_FIXTURE=manufacturing-products-with-policies \
//     pnpm test:integration path-d-cov-confidence-calibration
//
//   RUN_PATH_D_COV_CALIBRATION=1 \
//     PATH_D_COV_PROJECT_ID=e441baa5-bf49-4f8e-88d1-9c7f16b8ed11 \
//     PATH_D_COV_CSV_OUT=/tmp/cov-calibration-e441baa5.csv \
//     pnpm test:integration path-d-cov-confidence-calibration

import { describe, it, expect } from 'vitest'
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const RUN = process.env.RUN_PATH_D_COV_CALIBRATION === '1'
const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY)
const describeIf = RUN && HAS_API_KEY ? describe : describe.skip

interface CoverageRow {
  target_field_id: string
  coverage_status: string
  ai_reasoning?: string
  default_value_recommendation?: unknown
  confidence?: number
}

const FIVE_TIER_BUCKETS = [
  { name: '0.95-1.00', min: 0.95, max: 1.0 },
  { name: '0.85-0.95', min: 0.85, max: 0.95 },
  { name: '0.70-0.85', min: 0.7, max: 0.85 },
  { name: '0.50-0.70', min: 0.5, max: 0.7 },
  { name: '0.00-0.50', min: 0.0, max: 0.5 },
] as const

const NO_SOURCE_STATUSES = new Set(['gap', 'optional', 'out_of_scope', 'partial'])

describeIf('Path D coverage confidence calibration spot-check', () => {
  it('runs Path D, samples coverage confidence emission, surfaces distribution + correlation', async () => {
    const fixtureName = process.env.PATH_D_COV_FIXTURE
    const projectId = process.env.PATH_D_COV_PROJECT_ID
    if (!fixtureName && !projectId) {
      throw new Error(
        'Set either PATH_D_COV_FIXTURE=<name> or PATH_D_COV_PROJECT_ID=<uuid>',
      )
    }
    if (fixtureName && projectId) {
      throw new Error('Set only one of PATH_D_COV_FIXTURE / PATH_D_COV_PROJECT_ID')
    }

    const { callLLMStreaming } = await import('@/lib/ai/llm-client')
    const { parsePathDOutput } = await import('@/lib/ai/path-d-parser')
    const {
      buildPathDSystemPrompt,
      buildPathDUserMessage,
    } = await import('@/lib/ai/path-d-system-prompt')

    let ctx: import('@/lib/ai/context-builder').ProjectAIContext
    let label: string
    let expectedCoverage: Map<string, string> | null = null

    if (fixtureName) {
      const fixturesRoot = resolve(
        process.cwd(),
        'tests/fixtures/path-d-eval',
      )
      const fixtureDir = resolve(fixturesRoot, fixtureName)
      if (!existsSync(fixtureDir)) {
        const available = readdirSync(fixturesRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
        throw new Error(
          `Fixture '${fixtureName}' not found. Available: ${available.join(', ')}`,
        )
      }
      const sourceSchema = JSON.parse(
        readFileSync(resolve(fixtureDir, 'source-schema.json'), 'utf-8'),
      )
      const targetSchema = JSON.parse(
        readFileSync(resolve(fixtureDir, 'target-schema.json'), 'utf-8'),
      )
      const sampleData = existsSync(resolve(fixtureDir, 'sample-data.json'))
        ? JSON.parse(readFileSync(resolve(fixtureDir, 'sample-data.json'), 'utf-8'))
        : {}
      const businessContext = readFileSync(
        resolve(fixtureDir, 'business-context.md'),
        'utf-8',
      )
      const intelligenceContext = existsSync(
        resolve(fixtureDir, 'intelligence-context.md'),
      )
        ? readFileSync(resolve(fixtureDir, 'intelligence-context.md'), 'utf-8')
        : ''
      const expectedRaw = JSON.parse(
        readFileSync(resolve(fixtureDir, 'expected-output.json'), 'utf-8'),
      )

      // Build fixture context — same shape as the eval runner.
      const buildFields = (
        table: { id: string; name: string; fields: Array<unknown> },
        role: 'source' | 'target',
      ) =>
        table.fields.map((rawField) => {
          const f = rawField as {
            id: string
            name: string
            data_type: string
            is_nullable?: boolean
            is_primary_key?: boolean
            is_foreign_key?: boolean
            fk_reference?: string
            description?: string
          }
          const dist = (sampleData[f.id] ?? []) as Array<{ value: string; count: number }>
          return {
            field_id: f.id,
            name: f.name,
            data_type: f.data_type,
            inferred_type: null,
            is_nullable: f.is_nullable ?? true,
            is_primary_key: f.is_primary_key ?? false,
            is_foreign_key: f.is_foreign_key ?? false,
            fk_reference: f.fk_reference ?? null,
            check_constraint: null,
            schema_source: 'manual' as const,
            default_value: null,
            description: f.description ?? null,
            null_percentage: 0,
            cardinality: dist.length,
            unique_percentage: 0,
            format_issues_count: 0,
            min_value: null,
            max_value: null,
            value_distribution: dist,
            sample_values: dist.map((v) => v.value),
          }
        })

      ctx = {
        project_id: '00000000-0000-4000-9000-cal100000000',
        project_name: `cal:${fixtureName}`,
        source_tables: sourceSchema.tables.map((t: { id: string; name: string; fields: Array<unknown> }) => ({
          table_id: t.id,
          table_name: t.name,
          dataset_name: 'source',
          role: 'source' as const,
          row_count: 0,
          fields: buildFields(t, 'source'),
        })),
        target_tables: targetSchema.tables.map((t: { id: string; name: string; fields: Array<unknown> }) => ({
          table_id: t.id,
          table_name: t.name,
          dataset_name: 'target',
          role: 'target' as const,
          row_count: 0,
          fields: buildFields(t, 'target'),
        })),
        documents: {
          source_documents: [],
          target_documents: [],
          business_context_documents: [
            { filename: 'business-context.md', text: businessContext },
          ],
        },
        intelligence_context: intelligenceContext,
      }
      label = `fixture:${fixtureName}`

      // Gold standard for correlation analysis (fixtures only)
      expectedCoverage = new Map<string, string>()
      for (const c of expectedRaw.coverage ?? []) {
        expectedCoverage.set(c.target_field_id, c.coverage_status)
      }
    } else {
      const { supabaseAdmin } = await import('@/lib/supabase/admin')
      const { buildAIContext } = await import('@/lib/ai/context-builder')
      ctx = await buildAIContext(projectId!, {}, undefined, supabaseAdmin)
      label = `project:${projectId}`
    }

    const systemPrompt = buildPathDSystemPrompt({
      promptVersion: 'cov-confidence-calibration',
    })
    const userMessage = buildPathDUserMessage({
      ctx,
      intelligenceCtx: ctx.intelligence_context ?? '',
    })

    const t0 = Date.now()
    const result = await callLLMStreaming({
      // Reuse the eval_path_d feature — this calibration trial is an
      // eval-shaped Path D run with no persistence; same llm_calls
      // semantics as the eval runner.
      feature: 'eval_path_d',
      systemPrompt,
      userMessage,
      projectId: '00000000-0000-4000-9000-cal100000000',
      userId: '00000000-0000-4000-9000-cal100000001',
      promptVersion: 'cov-confidence-calibration',
      model: 'claude-opus-4-7',
      maxTokens: 48000,
      metadata: {
        calibration_target: label,
        run_id: randomUUID(),
      },
    })
    const durationMs = Date.now() - t0

    if (result.kind !== 'text') {
      throw new Error(`Expected text response, got kind='${result.kind}'`)
    }

    const parsed = parsePathDOutput(result.text)
    const coverage =
      parsed.coverage.status === 'parsed_ok'
        ? (parsed.coverage.data as CoverageRow[])
        : []

    if (parsed.coverage.status !== 'parsed_ok') {
      throw new Error(
        `Coverage section parse failed: ${parsed.coverage.status === 'parse_error' ? parsed.coverage.error : 'missing'}`,
      )
    }

    const totalRows = coverage.length
    const rowsWithConfidence = coverage.filter(
      (c) => typeof c.confidence === 'number',
    )
    const noSourceRows = coverage.filter((c) => NO_SOURCE_STATUSES.has(c.coverage_status))
    const noSourceWithConfidence = noSourceRows.filter(
      (c) => typeof c.confidence === 'number',
    )

    const confidences = rowsWithConfidence.map((c) => c.confidence!)
    const mean =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0
    const sorted = [...confidences].sort((a, b) => a - b)
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0
    const min = confidences.length > 0 ? Math.min(...confidences) : 0
    const max = confidences.length > 0 ? Math.max(...confidences) : 0
    const sigma =
      confidences.length > 1
        ? Math.sqrt(
            confidences.reduce((s, c) => s + (c - mean) ** 2, 0) /
              confidences.length,
          )
        : 0

    const distribution = FIVE_TIER_BUCKETS.map((bucket) => ({
      bucket: bucket.name,
      count: confidences.filter(
        (c) =>
          c >= bucket.min &&
          (bucket.name === '0.95-1.00' ? c <= bucket.max : c < bucket.max),
      ).length,
    }))

    // Per-status mean (does the model anchor confidence on covered rows
    // vs. spread across the no-source statuses?)
    const perStatus: Record<string, { count: number; mean: number; min: number; max: number }> = {}
    for (const status of [
      'covered',
      'partial',
      'gap',
      'optional',
      'out_of_scope',
    ]) {
      const rows = coverage.filter(
        (c) => c.coverage_status === status && typeof c.confidence === 'number',
      )
      if (rows.length === 0) continue
      const vals = rows.map((c) => c.confidence!)
      perStatus[status] = {
        count: rows.length,
        mean: vals.reduce((a, b) => a + b, 0) / vals.length,
        min: Math.min(...vals),
        max: Math.max(...vals),
      }
    }

    // Fixture-only: correlation against gold-standard verdicts. For
    // each row where the model emitted confidence + the gold has a
    // verdict, count agreement.
    let correlation: {
      sampled: number
      agreed: number
      disagreed: number
      meanAgreedConf: number
      meanDisagreedConf: number
    } | null = null
    if (expectedCoverage) {
      let agreed = 0
      let disagreed = 0
      const agreedConfs: number[] = []
      const disagreedConfs: number[] = []
      for (const row of rowsWithConfidence) {
        const expectedStatus = expectedCoverage.get(row.target_field_id)
        if (!expectedStatus) continue
        if (expectedStatus === row.coverage_status) {
          agreed++
          agreedConfs.push(row.confidence!)
        } else {
          disagreed++
          disagreedConfs.push(row.confidence!)
        }
      }
      correlation = {
        sampled: agreed + disagreed,
        agreed,
        disagreed,
        meanAgreedConf:
          agreedConfs.length > 0
            ? agreedConfs.reduce((a, b) => a + b, 0) / agreedConfs.length
            : 0,
        meanDisagreedConf:
          disagreedConfs.length > 0
            ? disagreedConfs.reduce((a, b) => a + b, 0) / disagreedConfs.length
            : 0,
      }
    }

    const lines: string[] = []
    lines.push('')
    lines.push(`Coverage confidence calibration — ${label}`)
    lines.push(`  duration: ${(durationMs / 1000).toFixed(1)}s   cost: $${(result.costUsd ?? 0).toFixed(2)}`)
    lines.push('')
    lines.push(
      `  Coverage rows total:                     ${totalRows}`,
    )
    lines.push(
      `  Rows emitting confidence:                ${rowsWithConfidence.length} (${totalRows > 0 ? ((rowsWithConfidence.length / totalRows) * 100).toFixed(0) : 0}%)`,
    )
    lines.push(
      `  No-source rows (gap/opt/oos/partial):    ${noSourceRows.length}`,
    )
    lines.push(
      `  No-source rows w/ confidence:            ${noSourceWithConfidence.length} (${noSourceRows.length > 0 ? ((noSourceWithConfidence.length / noSourceRows.length) * 100).toFixed(0) : 0}%)`,
    )
    lines.push('')
    lines.push(
      `  Distribution stats:  mean=${mean.toFixed(3)}  median=${median.toFixed(3)}  σ=${sigma.toFixed(3)}  min=${min.toFixed(3)}  max=${max.toFixed(3)}`,
    )
    lines.push('')
    lines.push('  Five-tier histogram:')
    for (const b of distribution) {
      const bar = '█'.repeat(b.count)
      lines.push(`    ${b.bucket}    ${b.count.toString().padStart(3)}  ${bar}`)
    }
    lines.push('')
    lines.push('  Per-status mean confidence:')
    for (const [status, stats] of Object.entries(perStatus)) {
      lines.push(
        `    ${status.padEnd(14)} n=${stats.count.toString().padStart(3)}   mean=${stats.mean.toFixed(3)}  min=${stats.min.toFixed(3)}  max=${stats.max.toFixed(3)}`,
      )
    }
    if (correlation) {
      lines.push('')
      lines.push('  Correlation against gold-standard expected_output.json:')
      lines.push(
        `    sampled  ${correlation.sampled}    agreed ${correlation.agreed}   disagreed ${correlation.disagreed}`,
      )
      lines.push(
        `    mean confidence on AGREED verdicts:    ${correlation.meanAgreedConf.toFixed(3)}`,
      )
      lines.push(
        `    mean confidence on DISAGREED verdicts: ${correlation.meanDisagreedConf.toFixed(3)}`,
      )
      const lift = correlation.meanAgreedConf - correlation.meanDisagreedConf
      lines.push(
        `    LIFT (agreed - disagreed):             ${lift > 0 ? '+' : ''}${lift.toFixed(3)}`,
      )
      lines.push(
        '    (positive lift = high-confidence rows are MORE likely to be correct;',
      )
      lines.push(
        '     negative lift = model is anti-calibrated; near-zero = no correlation)',
      )
    }
    lines.push('')

    // CSV dump of per-row data for manual inspection (especially
    // important for project mode where there's no gold standard —
    // user pairs against their own RAIDQ doc).
    const csvOut = process.env.PATH_D_COV_CSV_OUT
    if (csvOut) {
      const header = 'target_field_id,coverage_status,confidence,ai_reasoning'
      const csvRows = coverage.map((c) => {
        const reasoning = (c.ai_reasoning ?? '')
          .replace(/"/g, '""')
          .replace(/\n/g, ' ')
        return `${c.target_field_id},${c.coverage_status},${c.confidence ?? ''},"${reasoning}"`
      })
      writeFileSync(csvOut, [header, ...csvRows].join('\n'))
      lines.push(`  per-row CSV: ${csvOut}`)
    }

    // eslint-disable-next-line no-console
    console.log(lines.join('\n'))

    // Sanity assertions — calibration is meaningful only when the
    // model emits confidence. If <50% of rows carry confidence, the
    // prompt mechanic is not landing.
    expect(coverage.length).toBeGreaterThan(0)
    expect(rowsWithConfidence.length).toBeGreaterThanOrEqual(
      Math.floor(totalRows * 0.5),
    )
  }, 30 * 60 * 1000)
})
