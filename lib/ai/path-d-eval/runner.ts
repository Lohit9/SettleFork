/**
 * Path D eval runner — orchestrates fixture loading + Path D LLM call +
 * scoring + report generation.
 *
 * Sub-PR 6's runner deliberately does NOT route through the production
 * orchestrator (`runPathDMapping`). Reasons:
 *
 *   1. Persistence side-effects: the orchestrator writes TFMs, coverage
 *      rows, llm_calls, ai_edit_history, etc. against a real project ID.
 *      Eval trials shouldn't leave database residue per run.
 *   2. RLS surface: the orchestrator's gate-then-admin contract requires
 *      a real project + editor permission. Synthetic eval projects would
 *      add scratch-context overhead.
 *   3. The eval question is "does the prompt produce comprehensive,
 *      parseable output?" — not "does persistence work?" Persistence is
 *      already covered by `path-d-persistence.test.ts` and the happy-path
 *      integration test. Decoupling here keeps the eval focused on
 *      prompt quality, the actual Phase C iteration target.
 *
 * The runner DOES use the canonical `callLLMStreaming` wrapper so eval
 * calls land in `llm_calls` with `feature: 'eval_path_d'`, keeping cost
 * tracking + audit posture intact.
 *
 * ── Public surface ──────────────────────────────────────────────────────────
 *
 *   loadFixtures(filter?)             — load fixture directories from disk
 *   runEvalSuite(opts)                 — full eval; returns EvalRunReport
 *   formatReportStdout(report)         — pretty console output
 *
 * Phase C consumers will call `runEvalSuite` with their candidate
 * `weights` override and capture the resulting `EvalRunReport.overallMean`
 * to compare against the v0 baseline.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { callLLMStreaming } from '@/lib/ai/llm-client'
import { parsePathDOutput } from '@/lib/ai/path-d-parser'
import {
  buildPathDSystemPrompt,
  buildPathDUserMessage,
} from '@/lib/ai/path-d-system-prompt'
import type { ProjectAIContext, TableContext } from '@/lib/ai/context-builder'
import { scorePathDOutput } from '@/lib/ai/path-d-eval/scorer'
import {
  DEFAULT_WEIGHTS,
  type EvalDimensionKey,
  type EvalFixture,
  type EvalRunReport,
  type EvalWeights,
  type ExpectedPathDOutput,
  type FixtureSummary,
  type TrialResult,
} from '@/lib/ai/path-d-eval/types'

// Synthetic UUIDs used as `projectId` and `userId` on the eval llm_calls
// rows. Real `projects.id` foreign-key constraint means the llm_calls
// INSERT will silently fail with the FK error (writeLogAsync swallows it
// per the canonical wrapper). The actual AI call still completes and the
// scorer gets its parsed output. Cost tracking via the llm_calls write
// is "best effort" for v0 — Phase C can wire a real eval-only synthetic
// project if cost reporting matters.
const EVAL_SYNTHETIC_PROJECT_ID = '00000000-0000-4000-9000-eva100000000'
const EVAL_SYNTHETIC_USER_ID = '00000000-0000-4000-9000-eva100000001'

const FIXTURES_ROOT = resolve(__dirname, '../../../tests/fixtures/path-d-eval')

// ── Fixture loading ───────────────────────────────────────────────────────

/**
 * Load fixtures from disk. Each fixture is a directory under
 * `tests/fixtures/path-d-eval/` containing 5 files: `source-schema.json`,
 * `target-schema.json`, `sample-data.json`, `business-context.md`,
 * `expected-output.json`.
 *
 * @param filter Optional fixture-name filter (matches the directory
 *               name exactly). When provided, only that fixture loads.
 */
export function loadFixtures(filter?: string): EvalFixture[] {
  if (!existsSync(FIXTURES_ROOT)) {
    throw new Error(`Path D eval fixtures directory not found: ${FIXTURES_ROOT}`)
  }
  const dirs = readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const selected = filter ? dirs.filter((d) => d === filter) : dirs
  if (filter && selected.length === 0) {
    throw new Error(
      `Path D eval fixture '${filter}' not found in ${FIXTURES_ROOT}. Available: ${dirs.join(', ')}`,
    )
  }

  return selected.map((name) => loadFixture(name))
}

function loadFixture(name: string): EvalFixture {
  const dir = resolve(FIXTURES_ROOT, name)
  const sourceSchema = JSON.parse(readFileSync(resolve(dir, 'source-schema.json'), 'utf-8'))
  const targetSchema = JSON.parse(readFileSync(resolve(dir, 'target-schema.json'), 'utf-8'))
  const sampleData = existsSync(resolve(dir, 'sample-data.json'))
    ? JSON.parse(readFileSync(resolve(dir, 'sample-data.json'), 'utf-8'))
    : {}
  const businessContext = readFileSync(resolve(dir, 'business-context.md'), 'utf-8')
  // INF-41: optional intelligence-context.md per fixture. Pre-formatted
  // (matches `buildIntelligenceContext` output shape from
  // `lib/ai/context-builder.ts`) so the runner can drop it directly onto
  // `ctx.intelligence_context`. Empty string when absent — preserves
  // intelligence-OFF (v0) baseline for legacy fixtures and keeps the
  // delta attributable to fixture content alone.
  const intelligenceContext = existsSync(resolve(dir, 'intelligence-context.md'))
    ? readFileSync(resolve(dir, 'intelligence-context.md'), 'utf-8')
    : ''
  const expectedRaw = JSON.parse(
    readFileSync(resolve(dir, 'expected-output.json'), 'utf-8'),
  ) as ExpectedPathDOutput & { _authoring_notes?: string }
  // Strip the documentation-only `_authoring_notes` field (the scorer
  // doesn't read it; including it on the typed object would noise up
  // diagnostic dumps).
  const { _authoring_notes: _ignored, ...expected } = expectedRaw
  void _ignored

  return {
    name,
    description: businessContext.split('\n')[0]?.replace(/^#+\s*/, '') ?? name,
    source: sourceSchema,
    target: targetSchema,
    sample_data: sampleData,
    business_context: businessContext,
    intelligence_context: intelligenceContext,
    expected,
  }
}

// ── Fixture → ProjectAIContext shaper ─────────────────────────────────────

/**
 * Convert a fixture's hand-authored schemas into the `ProjectAIContext`
 * shape `buildPathDUserMessage` expects. The conversion is mechanical:
 * each fixture table → TableContext, each field → FieldContext.
 *
 * Sample-data values land on `value_distribution`. Free-text business
 * context flows through `documents.business_context_documents` as a
 * single synthetic doc.
 */
function fixtureToContext(fixture: EvalFixture): ProjectAIContext {
  const sourceTables: TableContext[] = fixture.source.tables.map((t) =>
    buildTableContext(t, 'source', fixture.sample_data),
  )
  const targetTables: TableContext[] = fixture.target.tables.map((t) =>
    buildTableContext(t, 'target', fixture.sample_data),
  )
  return {
    project_id: EVAL_SYNTHETIC_PROJECT_ID,
    project_name: `eval:${fixture.name}`,
    source_tables: sourceTables,
    target_tables: targetTables,
    documents: {
      source_documents: [],
      target_documents: [],
      business_context_documents: [
        { filename: 'business-context.md', text: fixture.business_context },
      ],
      // POC answer key — always null in eval fixtures (the eval harness
      // measures heritage Path D output against gold standards; injecting
      // a POC override would defeat that). Sunset: INF-73.
      poc_answer_key: null,
    },
    // INF-41: forward the fixture's optional intelligence_context onto
    // ctx so the runner's call to buildPathDUserMessage can pass it
    // through to the Path D prompt. Empty string when the fixture has
    // no intelligence-context.md (preserves v0 baseline shape).
    intelligence_context: fixture.intelligence_context,
    // POC template — eval fixtures run flag-off. Sunset: INF-73.
    poc_template: null,
  }
}

function buildTableContext(
  table: { id: string; name: string; fields: Array<unknown> },
  role: 'source' | 'target',
  sampleData: Record<string, Array<{ value: string; count: number }>>,
): TableContext {
  const fields = table.fields.map((rawField) => {
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
    const dist = sampleData[f.id] ?? []
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
  return {
    table_id: table.id,
    table_name: table.name,
    dataset_name: role === 'source' ? 'source' : 'target',
    role,
    row_count: 0,
    fields,
  }
}

// ── Trial runner ──────────────────────────────────────────────────────────

/**
 * Run one trial against one fixture. Calls the real LLM via
 * `callLLMStreaming`; the streaming wrapper handles llm_calls logging,
 * cost computation, error classification.
 *
 * Returns a TrialResult with the per-dimension score + aggregate. Errors
 * (LLM failure, parse-error, scorer-throw) are caught and reported as
 * `errored: true` with all dimensions = 0 and aggregate = 0 — this lets
 * the run continue to other trials/fixtures even if one breaks.
 */
async function runTrial(args: {
  fixture: EvalFixture
  trialIndex: number
  weights: EvalWeights
}): Promise<TrialResult> {
  const { fixture, trialIndex, weights } = args
  const runId = randomUUID()
  const startedAt = Date.now()

  try {
    const ctx = fixtureToContext(fixture)
    const systemPrompt = buildPathDSystemPrompt({ promptVersion: 'eval-path-d-v0' })
    // INF-41: forward ctx.intelligence_context as intelligenceCtx so
    // the eval prompt exercises the intelligence-ON path. The pre-INF-41
    // call shape (`{ ctx }` only) silently dropped the intelligence
    // block — same bug as path-d-mapping.ts:251 (production), fixed
    // there in this PR. Empty intelligence_context flows through as
    // an empty string and the builder short-circuits the prepend, so
    // legacy intelligence-OFF fixtures stay byte-identical.
    const userMessage = buildPathDUserMessage({
      ctx,
      intelligenceCtx: ctx.intelligence_context,
    })

    const result = await callLLMStreaming({
      feature: 'eval_path_d',
      systemPrompt,
      userMessage,
      projectId: EVAL_SYNTHETIC_PROJECT_ID,
      userId: EVAL_SYNTHETIC_USER_ID,
      promptVersion: 'eval-path-d-v0',
      // Path D is an Opus-4.7-specific pipeline (the orchestrator at
      // lib/ai/path-d-mapping.ts hard-codes the same model). Eval must
      // measure the same model to be a meaningful proxy for production
      // behaviour — defaulting to Sonnet 4.6 here would measure a
      // different model entirely.
      model: 'claude-opus-4-7',
      maxTokens: 48000,
      metadata: {
        eval_fixture: fixture.name,
        eval_trial_index: trialIndex,
        eval_run_id: runId,
      },
    })

    if (result.kind !== 'text') {
      throw new Error(
        `Expected text response from LLM, got kind='${result.kind}' (eval doesn't use tool surface)`,
      )
    }

    const parsed = parsePathDOutput(result.text)

    // Optional diagnostic: dump raw response when any section parse_errors,
    // gated on PATH_D_EVAL_DUMP_RESPONSE=1. Lets Phase C iteration inspect
    // exactly what the model emitted when scores look anomalous.
    if (process.env.PATH_D_EVAL_DUMP_RESPONSE === '1') {
      try {
        const { writeFileSync } = await import('node:fs')
        const sectionStatuses = Object.entries(parsed)
          .map(([k, v]) => `${k}=${(v as { status: string }).status}`)
          .join(' ')
        writeFileSync(
          `/tmp/path-d-eval-${fixture.name}-trial${trialIndex}.txt`,
          `runId: ${runId}\n` +
            `sectionStatuses: ${sectionStatuses}\n` +
            `responseTextLength: ${result.text.length}\n\n` +
            `── RESPONSE TEXT ──\n${result.text}\n`,
        )
      } catch {}
    }

    const score = scorePathDOutput(parsed, fixture.expected, weights)
    const durationMs = Date.now() - startedAt

    return {
      fixtureName: fixture.name,
      trialIndex,
      runId,
      costUsd: result.costUsd,
      durationMs,
      score,
      errored: false,
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    return {
      fixtureName: fixture.name,
      trialIndex,
      runId,
      costUsd: null,
      durationMs,
      score: zeroScore(weights),
      errored: true,
      errorMessage: (err as Error).message,
    }
  }
}

function zeroScore(weights: EvalWeights) {
  const dims = (Object.keys(DEFAULT_WEIGHTS) as EvalDimensionKey[]).reduce(
    (acc, k) => {
      acc[k] = { score: 0, details: { errored: true } }
      return acc
    },
    {} as Record<EvalDimensionKey, { score: number; details: Record<string, unknown> }>,
  )
  return { dimensions: dims, aggregate: 0, weights: { ...weights } }
}

// ── Suite runner ──────────────────────────────────────────────────────────

export interface RunEvalSuiteArgs {
  /** N trials per fixture. Defaults to 1 (PATH_D_EVAL_TRIALS env override). */
  trialsPerFixture?: number
  /** When set, run only this single fixture (PATH_D_EVAL_FIXTURE env override). */
  fixtureFilter?: string
  /** Caller-provided weights override; defaults to DEFAULT_WEIGHTS. */
  weights?: EvalWeights
}

export async function runEvalSuite(
  args: RunEvalSuiteArgs = {},
): Promise<EvalRunReport> {
  const trialsPerFixture = args.trialsPerFixture ?? 1
  const weights = args.weights ?? { ...DEFAULT_WEIGHTS }
  const fixtures = loadFixtures(args.fixtureFilter)
  const startedAt = new Date().toISOString()
  const t0 = Date.now()

  const fixtureSummaries: FixtureSummary[] = []
  for (const fixture of fixtures) {
    const trials: TrialResult[] = []
    for (let i = 0; i < trialsPerFixture; i++) {
      const trial = await runTrial({ fixture, trialIndex: i, weights })
      trials.push(trial)
    }
    fixtureSummaries.push(summariseFixture(fixture.name, trials, weights))
  }

  const overallMean =
    fixtureSummaries.length === 0
      ? 0
      : fixtureSummaries.reduce((s, fs) => s + fs.aggregateMean, 0) /
        fixtureSummaries.length

  const totalCostUsd = fixtureSummaries.some((fs) => fs.totalCostUsd === null)
    ? null
    : fixtureSummaries.reduce((s, fs) => s + (fs.totalCostUsd ?? 0), 0)

  return {
    startedAt,
    trialsPerFixture,
    fixtureSummaries,
    overallMean,
    totalCostUsd,
    totalDurationMs: Date.now() - t0,
    weights: { ...weights },
  }
}

function summariseFixture(
  fixtureName: string,
  trials: TrialResult[],
  weights: EvalWeights,
): FixtureSummary {
  const aggregates = trials.map((t) => t.score.aggregate)
  const aggregateMean =
    aggregates.length === 0 ? 0 : aggregates.reduce((a, b) => a + b, 0) / aggregates.length
  const aggregateMin = aggregates.length === 0 ? 0 : Math.min(...aggregates)
  const aggregateMax = aggregates.length === 0 ? 0 : Math.max(...aggregates)
  const aggregateStddev =
    aggregates.length <= 1
      ? 0
      : Math.sqrt(
          aggregates.reduce((s, a) => s + (a - aggregateMean) ** 2, 0) /
            aggregates.length,
        )

  const dimensionKeys = Object.keys(weights) as EvalDimensionKey[]
  const perDimensionMean = dimensionKeys.reduce(
    (acc, k) => {
      const vals = trials.map((t) => t.score.dimensions[k]?.score ?? 0)
      acc[k] = vals.length === 0 ? 0 : vals.reduce((a, b) => a + b, 0) / vals.length
      return acc
    },
    {} as Record<EvalDimensionKey, number>,
  )

  const totalCostUsd = trials.some((t) => t.costUsd === null)
    ? null
    : trials.reduce((s, t) => s + (t.costUsd ?? 0), 0)

  return {
    fixtureName,
    trials,
    aggregateMean,
    aggregateMin,
    aggregateMax,
    aggregateStddev,
    perDimensionMean,
    totalCostUsd,
  }
}

// ── Reporter ──────────────────────────────────────────────────────────────

/**
 * Format the EvalRunReport as a console-friendly multi-line string.
 * Used by the integration test to emit a readable summary into stdout
 * for trend tracking; also handy for ad-hoc CLI invocations.
 */
export function formatReportStdout(report: EvalRunReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push(
    `Path D eval — ${report.fixtureSummaries.length} fixture(s) × ${report.trialsPerFixture} trial(s)`,
  )
  lines.push('')

  for (const fs of report.fixtureSummaries) {
    lines.push(`  ${fs.fixtureName}`)
    const dimKeys = Object.keys(report.weights) as EvalDimensionKey[]
    for (const k of dimKeys) {
      const score = fs.perDimensionMean[k]
      const w = report.weights[k]
      lines.push(
        `    ${k.padEnd(28)} ${score.toFixed(3).padStart(6)}    weight ${w.toFixed(2)}`,
      )
    }
    const variance =
      fs.trials.length > 1 ? `  (min=${fs.aggregateMin.toFixed(3)} max=${fs.aggregateMax.toFixed(3)} σ=${fs.aggregateStddev.toFixed(3)})` : ''
    lines.push(`    ─────────────────────────────────────────────`)
    lines.push(`    AGGREGATE                    ${fs.aggregateMean.toFixed(3).padStart(6)}${variance}`)
    const cost =
      fs.totalCostUsd === null ? 'cost: n/a' : `cost: $${fs.totalCostUsd.toFixed(2)}`
    const dur = fs.trials.reduce((s, t) => s + t.durationMs, 0)
    lines.push(`    ${cost}   duration: ${(dur / 1000).toFixed(1)}s`)
    if (fs.trials.some((t) => t.errored)) {
      const erroredTrials = fs.trials.filter((t) => t.errored)
      lines.push(`    ⚠ ${erroredTrials.length} trial(s) errored:`)
      for (const t of erroredTrials) {
        lines.push(`      [trial ${t.trialIndex}] ${t.errorMessage ?? '(no message)'}`)
      }
    }
    lines.push('')
  }

  const totalCost =
    report.totalCostUsd === null ? 'n/a' : `$${report.totalCostUsd.toFixed(2)}`
  lines.push(
    `OVERALL — mean aggregate: ${report.overallMean.toFixed(3)}  cost: ${totalCost}  duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`,
  )
  lines.push('')
  return lines.join('\n')
}
