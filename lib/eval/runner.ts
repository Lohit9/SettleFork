/**
 * Phase 1 PR 10.4 — eval runner.
 *
 * Orchestrates one `pnpm eval` invocation:
 *
 *   pre-flight (sweep prior orphans + create/teardown sanity cycle)
 *   → load dataset(s)
 *   → for each example:
 *       buildSyntheticMappingContext → call production AI entry point
 *       → score → tear down synthetic project → accumulate cost
 *   → final cleanup invariant (must end with zero orphan synthetic projects)
 *
 * Cost cap is enforced after each example: if accumulated cost exceeds
 * the limit, the runner aborts mid-sequence and runs final cleanup.
 *
 * PR 10.4 covers the `mapping` task only. `validation-rule` examples
 * are skipped with a warning — wired in PR 11 once
 * `addValidationRuleFromNL` accepts an optional (supabase, userId)
 * parameter pair.
 *
 * No concurrency in PR 10.4 (sequential per example). PR 11 adds the
 * 3-concurrent semaphore once the sequential path is proven.
 *
 * No cache in PR 10.4 (Option C from the architectural decision in
 * PR 10.4 §4 stop-and-report). PR 11 adds Option B (push cache into
 * `callLLM` itself with a `cacheReadEnabled` flag).
 */

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  EVAL_PROJECT_PREFIX,
  createSyntheticProject,
  teardownSyntheticProject,
  sweepOrphans,
} from '@/lib/eval/scratch-context'
import { loadDataset, listDatasets } from '@/lib/eval/loader'
import { buildSyntheticMappingContext } from '@/lib/eval/synthetic-context-builder'
import {
  scoreMappingFieldPair,
  type ProposedMapping,
  type GoldMapping,
} from '@/lib/eval/scorers/mapping'
import {
  scoreValidationRuleStructural,
  type ProposedValidationRule,
  type GoldValidationRule,
} from '@/lib/eval/scorers/validation-rule'
import {
  scoreMappingSuggestion,
  type ProposedMappingSuggestion,
  type GoldMappingSuggestion,
} from '@/lib/eval/scorers/mapping-suggestion'
import {
  scoreQualityIssueDetection,
  type GoldQualityIssues,
} from '@/lib/eval/scorers/quality-issues'
import {
  scoreExtractedPatterns,
  type GoldExtractedPatterns,
} from '@/lib/eval/scorers/extracted-patterns'
import {
  scoreFixOptions,
  type GoldFixOptions,
} from '@/lib/eval/scorers/fix-options'
import { runMappingGenerationForPair } from '@/lib/actions/mappings'
import { addValidationRuleFromNL } from '@/lib/actions/validation-rules'
import { runMappingSuggestion } from '@/lib/ai/mapping-engine'
import { runAIAugmentedChecks } from '@/lib/actions/ai-quality-detection'
import { extractMigrationIntelligence } from '@/lib/actions/migration-intelligence'
import { generateFixSuggestions } from '@/lib/quality/fix-engine'
import { resolveDefaultModel } from '@/lib/ai/llm-client'
import { signSyntheticJwt } from '@/lib/eval/synthetic-jwt'
import type {
  EvalExample,
  EvalRunOutput,
  DatasetMetrics,
  ScoreSummary,
} from '@/lib/eval/types'

// ─── Public option / output shapes ────────────────────────────────────────────

export interface RunOptions {
  /**
   * Task filter. Path 2 PR 1 wires 'validation-rule' and
   * 'mapping-suggestion' alongside the original 'mapping'. 'all' runs
   * every wired task. The remaining EvalTask values ('transform',
   * 'nl-to-sql') are reserved enum values not yet wired.
   */
  task?:
    | 'mapping'
    | 'validation-rule'
    | 'mapping-suggestion'
    | 'quality-issues'
    | 'extracted-patterns'
    | 'fix-options'
    | 'all'
  /** Specific dataset directory under tests/eval/datasets/. */
  dataset?: string
  /**
   * Smoke run: 1 example per task per dataset instead of the full
   * example set. Used by CI and by the PR 10.4 verification step.
   */
  smoke?: boolean
  /** Dollar cap per invocation. Defaults to 20. */
  maxCostUsd?: number
  /**
   * Single-example debug mode. Format: `<dataset>/<task>/<exampleId>`,
   * e.g. `_fixture/mapping/001-fixture`. When set, all other filters
   * (task, dataset, smoke) are ignored.
   */
  example?: string
}

export interface RunOutput extends EvalRunOutput {
  task: string
  preflightPassed: boolean
  cleanupOk: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const EVAL_USER_ID = process.env.EVAL_USER_ID ?? 'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'
const DEFAULT_MAX_COST_USD = 20

// Phase 2 PR 11: replaced the local `DEFAULT_MODEL` constant with a
// per-call lookup against `resolveDefaultModel()`. The runner used to
// hardcode 'claude-sonnet-4-20250514' as the metadata label, which
// would have misreported the model in eval-output JSON regardless of
// what the underlying API call actually used. Calling
// resolveDefaultModel() at the moment the runner builds RunOutput
// captures the true model the call will use (Sonnet 4.6 with flag
// OFF; Opus 4.7 with flag ON). Each of the three call sites below
// reflects the runner's "one model per run" architecture.

/**
 * Build a Supabase client whose Authorization header carries a JWT
 * signed for EVAL_USER_ID. Used to call code paths that gate on
 * `auth.uid()` — `supabaseAdmin` bypasses RLS but doesn't impersonate
 * any user, so RPCs like `dq_create_target_field_mapping` (which
 * checks user_has_project_role via auth.uid()) reject service-role
 * callers.
 */
function buildUserAuthedClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      '[eval/runner] NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set for the user-authed eval client.',
    )
  }
  const jwt = signSyntheticJwt()
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ─── Public entry ─────────────────────────────────────────────────────────────

export async function runEval(opts: RunOptions = {}): Promise<RunOutput> {
  const runId = new Date().toISOString()
  const branch = safeGitOutput('git rev-parse --abbrev-ref HEAD')
  const commitSha = safeGitOutput('git rev-parse --short HEAD')

  const orgId = process.env.EVAL_ORG_ID
  if (!orgId || orgId.length === 0) {
    throw new Error(
      '[eval/runner] EVAL_ORG_ID is not set. Add it to .env.local before running the eval CLI.',
    )
  }

  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD
  const taskFilter = opts.task ?? 'all'
  const startedAt = Date.now()
  const datasets: DatasetMetrics[] = []
  let totalCostUsd = 0
  let totalCachedCount = 0
  let cleanupOk = false

  // Pre-flight integration test — $0; no LLM calls. Verifies the
  // create/teardown cycle works against the real DB before we spend
  // any money.
  const preflightPassed = await preflight(orgId)
  if (!preflightPassed) {
    return {
      runId,
      branch,
      commitSha,
      model: resolveDefaultModel(),
      smoke: opts.smoke ?? false,
      task: taskFilter,
      datasets,
      totalCostUsd,
      totalDurationMs: Date.now() - startedAt,
      totalCachedCount,
      preflightPassed: false,
      cleanupOk: false,
    }
  }

  // Cost-cap of zero is a recognized "pre-flight only" mode used by
  // verification step 5 — do the sweep + create/teardown sanity cycle
  // and exit cleanly without running examples.
  if (maxCostUsd === 0) {
    cleanupOk = await finalCleanupCheck()
    return {
      runId,
      branch,
      commitSha,
      model: resolveDefaultModel(),
      smoke: opts.smoke ?? false,
      task: taskFilter,
      datasets,
      totalCostUsd,
      totalDurationMs: Date.now() - startedAt,
      totalCachedCount,
      preflightPassed: true,
      cleanupOk,
    }
  }

  try {
    // Resolve which datasets / examples to run.
    const work = resolveWork(opts)

    for (const item of work) {
      const datasetMetricKey = `${item.datasetName}::${item.example.task}`
      let dm = datasets.find((d) => `${d.dataset}::${d.task}` === datasetMetricKey)
      if (!dm) {
        dm = {
          dataset: item.datasetName,
          task: item.example.task,
          examples: 0,
          scorers: {},
          costUsd: 0,
          durationMs: 0,
          cachedCount: 0,
        }
        datasets.push(dm)
      }

      // Path 2 PR 2 B-2: dispatch on task. The reserved EvalTask values
      // 'transform' and 'nl-to-sql' aren't wired here yet — they're
      // skipped with a warning. The 6 wired tasks (mapping,
      // validation-rule, mapping-suggestion, quality-issues,
      // extracted-patterns, fix-options) all use the same per-example
      // bookkeeping pattern.
      if (
        item.example.task !== 'mapping' &&
        item.example.task !== 'validation-rule' &&
        item.example.task !== 'mapping-suggestion' &&
        item.example.task !== 'quality-issues' &&
        item.example.task !== 'extracted-patterns' &&
        item.example.task !== 'fix-options'
      ) {
        console.warn(
          `[eval/runner] Skipping example "${item.example.id}" — task "${item.example.task}" not yet wired.`,
        )
        continue
      }

      const exStart = Date.now()
      let exResult: { score: number; costUsd: number; errored: boolean; errorMessage?: string }
      let scorerName: string
      if (item.example.task === 'mapping') {
        exResult = await runOneMappingExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreMappingFieldPair'
      } else if (item.example.task === 'validation-rule') {
        exResult = await runOneValidationRuleExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreValidationRuleStructural'
      } else if (item.example.task === 'mapping-suggestion') {
        exResult = await runOneMappingSuggestionExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreMappingSuggestion'
      } else if (item.example.task === 'quality-issues') {
        exResult = await runOneQualityIssuesExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreQualityIssueDetection'
      } else if (item.example.task === 'extracted-patterns') {
        exResult = await runOneExtractedPatternsExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreExtractedPatterns'
      } else {
        // 'fix-options'
        exResult = await runOneFixOptionsExample({
          datasetName: item.datasetName,
          schema: item.schema,
          example: item.example,
          orgId,
        })
        scorerName = 'scoreFixOptions'
      }

      dm.examples++
      dm.costUsd += exResult.costUsd
      dm.durationMs += Date.now() - exStart
      dm.cachedCount += 0 // PR 10.4 has no cache

      const summary = dm.scorers[scorerName] ?? {
        mean: 0,
        count: 0,
        min: 1,
        max: 0,
        errorCount: 0,
      }
      if (exResult.errored) {
        summary.errorCount++
        console.error(
          `[eval/runner] Example "${item.example.id}" errored: ${exResult.errorMessage ?? '(no message)'}`,
        )
      } else {
        const prev = summary.mean * summary.count
        summary.count++
        summary.mean = (prev + exResult.score) / summary.count
        summary.min = Math.min(summary.min, exResult.score)
        summary.max = Math.max(summary.max, exResult.score)
      }
      dm.scorers[scorerName] = summary

      totalCostUsd += exResult.costUsd

      if (totalCostUsd > maxCostUsd) {
        console.error(
          `[eval/runner] Cost cap exceeded: $${totalCostUsd.toFixed(4)} > $${maxCostUsd.toFixed(2)}. Aborting.`,
        )
        break
      }
    }
  } finally {
    // Cleanup invariant: every invocation must end with zero
    // eval-synthetic projects in the DB. try/finally so this runs
    // even on thrown exception or cost-cap break.
    cleanupOk = await finalCleanupCheck()
  }

  return {
    runId,
    branch,
    commitSha,
    model: resolveDefaultModel(),
    smoke: opts.smoke ?? false,
    task: taskFilter,
    datasets,
    totalCostUsd,
    totalDurationMs: Date.now() - startedAt,
    totalCachedCount,
    preflightPassed: true,
    cleanupOk,
  }
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** Resolve which (dataset, example) pairs to run given the options. */
function resolveWork(opts: RunOptions): Array<{
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
}> {
  // Single-example mode short-circuits everything else.
  if (opts.example) {
    const parts = opts.example.split('/')
    if (parts.length < 3) {
      throw new Error(
        `[eval/runner] --example must be <dataset>/<task>/<exampleId>; got: ${opts.example}`,
      )
    }
    const [datasetName] = parts
    const ds = loadDataset(datasetName!)
    const allExamples = [
      ...ds.examples.mapping,
      ...ds.examples.transform,
      ...ds.examples['nl-to-sql'],
      ...ds.examples['validation-rule'],
      ...ds.examples['mapping-suggestion'],
      ...ds.examples['quality-issues'],
      ...ds.examples['extracted-patterns'],
      ...ds.examples['fix-options'],
    ]
    const ex = allExamples.find((e) => e.id === opts.example)
    if (!ex) {
      throw new Error(`[eval/runner] No example with id "${opts.example}" in dataset "${datasetName}"`)
    }
    return [{ datasetName: datasetName!, schema: ds.schema, example: ex }]
  }

  const datasetNames = opts.dataset ? [opts.dataset] : listDatasets()
  const work: Array<{
    datasetName: string
    schema: ReturnType<typeof loadDataset>['schema']
    example: EvalExample
  }> = []

  for (const datasetName of datasetNames) {
    const ds = loadDataset(datasetName)

    // Tasks to include. Path 2 PR 2 B-2: wired tasks are 'mapping',
    // 'validation-rule', 'mapping-suggestion', 'quality-issues',
    // 'extracted-patterns', 'fix-options'. Other EvalTask values
    // ('transform', 'nl-to-sql') are reserved enum values; their
    // examples are filtered out by the runner's per-task dispatch.
    const tasks: Array<keyof typeof ds.examples> =
      opts.task === 'mapping'
        ? ['mapping']
        : opts.task === 'validation-rule'
          ? ['validation-rule']
          : opts.task === 'mapping-suggestion'
            ? ['mapping-suggestion']
            : opts.task === 'quality-issues'
              ? ['quality-issues']
              : opts.task === 'extracted-patterns'
                ? ['extracted-patterns']
                : opts.task === 'fix-options'
                  ? ['fix-options']
                  : [
                      'mapping',
                      'validation-rule',
                      'mapping-suggestion',
                      'quality-issues',
                      'extracted-patterns',
                      'fix-options',
                    ]

    for (const task of tasks) {
      const examples = ds.examples[task]
      const slice = opts.smoke ? examples.slice(0, 1) : examples
      for (const ex of slice) {
        work.push({ datasetName, schema: ds.schema, example: ex })
      }
    }
  }

  return work
}

/** Run one mapping example end-to-end. Owns project lifecycle. */
async function runOneMappingExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as { source_table: string; target_table: string }
    if (!input.source_table || !input.target_table) {
      return { score: 0, costUsd: 0, errored: true, errorMessage: 'example.input missing source_table/target_table' }
    }

    // PR 3.4b — propagate fixture metadata.business_context to the
    // synthetic project row. Used by agent-mode mapping prompts under
    // AI_PHASE_3_ENABLED=1; backward-compatible when absent.
    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
      ...(args.example.metadata.business_context
        ? { businessContext: args.example.metadata.business_context }
        : {}),
    })

    // Capture the start time so we can attribute llm_calls cost back
    // to THIS example (no concurrent eval examples per the sequential
    // contract; the time-window approach is unambiguous here).
    const callsBefore = Date.now()

    // Production AI entry point — same code path used by
    // `regenerateFieldMappings`. Tag with `eval_mapping` so the daily
    // cost report excludes this row.
    //
    // Pass the user-authed client (built around a synthetic JWT with
    // sub=EVAL_USER_ID) so internal RPCs that gate on `auth.uid()`
    // (e.g. dq_create_target_field_mapping → user_has_project_role)
    // see the correct user identity. createSyntheticProject (PR 10.4)
    // adds a project_members row granting EVAL_USER_ID admin role,
    // which satisfies that check.
    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await runMappingGenerationForPair({
      supabase: supabaseUserAuth as unknown as Parameters<typeof runMappingGenerationForPair>[0]['supabase'],
      userId: EVAL_USER_ID,
      projectId,
      tableMappingId: ctx.tableMappingId,
      sourceTableId: ctx.sourceTableId,
      targetTableId: ctx.targetTableId,
      featureOverride: 'eval_mapping',
    })

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000, // small grace window for clock skew
    })

    if (aiResult.error) {
      return { score: 0, costUsd, errored: true, errorMessage: aiResult.error }
    }

    // Read back the proposed mappings the AI just inserted, translate
    // back to (source_field_name, target_field_name) for scoring.
    const proposed = await readProposedMappings({ projectId, ctx })
    const gold = translateGoldMappings({ example: args.example, ctx })
    const scored = scoreMappingFieldPair(proposed, gold)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Run one validation-rule example end-to-end.
 *
 * Path 2 PR 1: dispatches to `addValidationRuleFromNL` with an
 * evalContext object that injects the user-authed Supabase client +
 * EVAL_USER_ID + featureOverride='eval_validation_rule'. The function
 * INSERTS into `validation_rules` keyed on the synthetic project, and
 * the project teardown cascades the row away.
 *
 * Field selection: the fixture's `input.field_name` + `input.field_side`
 * names a field on either the source or target table; we look up the
 * synthetic UUID via the BuiltMappingContext maps and pass it as
 * `fieldId`. The scorer compares the proposal's field_id against the
 * SAME UUID at score time (so the gold's effective field_id is
 * "the field we asked the AI to write a rule for").
 */
async function runOneValidationRuleExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as {
      source_table: string
      target_table: string
      field_name: string
      field_side: 'source' | 'target'
      natural_language_rule: string
    }
    if (
      !input.source_table ||
      !input.target_table ||
      !input.field_name ||
      !input.field_side ||
      !input.natural_language_rule
    ) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage:
          'validation-rule example.input missing required keys (source_table, target_table, field_name, field_side, natural_language_rule)',
      }
    }

    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
    })

    const fieldsByName =
      input.field_side === 'source' ? ctx.sourceFieldsByName : ctx.targetFieldsByName
    const fieldId = fieldsByName.get(input.field_name)
    if (!fieldId) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage: `validation-rule example references unknown ${input.field_side} field "${input.field_name}"`,
      }
    }

    const callsBefore = Date.now()

    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await addValidationRuleFromNL(
      projectId,
      fieldId,
      input.natural_language_rule,
      undefined,
      {
        supabase: supabaseUserAuth,
        userId: EVAL_USER_ID,
        featureOverride: 'eval_validation_rule',
      },
    )

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000,
    })

    if (!aiResult.success || !aiResult.rule) {
      return {
        score: 0,
        costUsd,
        errored: true,
        errorMessage: aiResult.error ?? 'addValidationRuleFromNL returned no rule',
      }
    }

    // Translate the proposal into the scorer's input shape. The
    // production row carries the columns the scorer needs verbatim.
    const proposed: ProposedValidationRule = {
      rule_type: aiResult.rule.rule_type as string,
      rule_config: aiResult.rule.rule_config as Record<string, unknown>,
      field_id: aiResult.rule.field_id as string,
      severity: aiResult.rule.severity as 'blocking' | 'warning',
      name: aiResult.rule.name as string,
    }

    // Build the gold for scoring. The fixture's gold carries
    // rule_type + rule_config + severity + (optional) name; the
    // scorer needs field_id too — we resolve it to the synthetic UUID
    // we just passed to the AI, so a successful call gives a
    // fieldMatch=true axis.
    const goldRaw = args.example.gold as Record<string, unknown>
    const gold: GoldValidationRule = {
      rule_type: String(goldRaw.rule_type ?? ''),
      rule_config: (goldRaw.rule_config as Record<string, unknown>) ?? {},
      field_id: fieldId,
      severity: (goldRaw.severity as 'blocking' | 'warning') ?? 'warning',
      name: typeof goldRaw.name === 'string' ? goldRaw.name : undefined,
    }
    const scored = scoreValidationRuleStructural(proposed, gold)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Run one mapping-suggestion example end-to-end.
 *
 * Path 2 PR 1: dispatches to `runMappingSuggestion` with the user-authed
 * Supabase client + featureOverride='eval_mapping_suggestion'. The
 * function does NOT write to the DB — it returns the suggestion
 * in-memory — so cleanup is just the project teardown.
 *
 * Target-field selection: the fixture's `input.target_field_name`
 * names a target field; we look up the synthetic UUID from
 * `BuiltMappingContext.targetFieldsByName`.
 */
async function runOneMappingSuggestionExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as {
      source_table: string
      target_table: string
      target_field_name: string
    }
    if (!input.source_table || !input.target_table || !input.target_field_name) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage:
          'mapping-suggestion example.input missing required keys (source_table, target_table, target_field_name)',
      }
    }

    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
    })

    const targetFieldId = ctx.targetFieldsByName.get(input.target_field_name)
    if (!targetFieldId) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage: `mapping-suggestion example references unknown target field "${input.target_field_name}"`,
      }
    }

    const callsBefore = Date.now()

    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await runMappingSuggestion(
      supabaseUserAuth as unknown as Parameters<typeof runMappingSuggestion>[0],
      EVAL_USER_ID,
      projectId,
      targetFieldId,
      'eval_mapping_suggestion',
    )

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000,
    })

    if (!aiResult.success) {
      return {
        score: 0,
        costUsd,
        errored: true,
        errorMessage: aiResult.error,
      }
    }

    // The AI returns source_field IDS; translate to NAMES so the
    // scorer compares like-for-like with hand-authored gold names.
    const sourceIdToName = new Map<string, string>()
    for (const [name, id] of ctx.sourceFieldsByName) sourceIdToName.set(id, name)

    const proposedNames: string[] = []
    for (const id of aiResult.suggestion.sourceFieldIds) {
      const n = sourceIdToName.get(id)
      if (n) proposedNames.push(n)
    }

    const proposed: ProposedMappingSuggestion = {
      source_field_names: proposedNames,
      combination_type: aiResult.suggestion.combinationType,
      confidence: aiResult.suggestion.confidence,
      rationale: aiResult.suggestion.rationale,
    }

    const goldRaw = args.example.gold as Record<string, unknown>
    const gold: GoldMappingSuggestion = {
      expected_source_field_names: Array.isArray(goldRaw.expected_source_field_names)
        ? (goldRaw.expected_source_field_names as string[])
        : [],
      acceptable_alternatives: Array.isArray(goldRaw.acceptable_alternatives)
        ? (goldRaw.acceptable_alternatives as string[][])
        : undefined,
      expected_combination_type:
        (goldRaw.expected_combination_type as GoldMappingSuggestion['expected_combination_type']) ??
        'single',
    }
    const scored = scoreMappingSuggestion(proposed, gold)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Run one quality-issues example end-to-end.
 *
 * Path 2 PR 2 B-2: dispatches to `runAIAugmentedChecks` with an
 * evalContext using Posture A — `skipVerificationAndPersist: true`
 * so we score the raw AI proposals BEFORE the verification SQL loop
 * filters them by data survival. The synthetic source table is built
 * with `withFieldProfiles: true` so the AI sees realistic stats.
 */
async function runOneQualityIssuesExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as { source_table: string; target_table: string }
    if (!input.source_table || !input.target_table) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage:
          'quality-issues example.input missing required keys (source_table, target_table)',
      }
    }

    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
      withFieldProfiles: true,
    })

    const callsBefore = Date.now()

    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await runAIAugmentedChecks({
      projectId,
      tableId: ctx.sourceTableId,
      evalContext: {
        supabase: supabaseUserAuth,
        userId: EVAL_USER_ID,
        featureOverride: 'eval_quality_issues',
        skipVerificationAndPersist: true,
      },
    })

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000,
    })

    if (aiResult.error) {
      return { score: 0, costUsd, errored: true, errorMessage: aiResult.error }
    }

    const proposed = aiResult.rawProposals ?? []
    const gold = args.example.gold as unknown as GoldQualityIssues
    const scored = scoreQualityIssueDetection(proposed, gold, ctx.sourceTableId)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Run one extracted-patterns example end-to-end.
 *
 * Path 2 PR 2 B-2: dispatches to `extractMigrationIntelligence` with
 * `skipPersist: true` (locked C2 decision). migration_intelligence is
 * user-scoped (no project_id FK), so project teardown does NOT
 * cascade-delete its rows — skipPersist is load-bearing, not just an
 * optimization. The synthetic context is built with
 * `withFieldProfiles: true` AND a `seedQualityIssue` so the AI has
 * an approved table_mapping + 1 quality_issues row + field profiles
 * to reason from.
 */
async function runOneExtractedPatternsExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as {
      source_table: string
      target_table: string
      seed_issue?: {
        field_name: string
        severity: 'blocking' | 'warning'
        title: string
        description: string
      }
    }
    if (!input.source_table || !input.target_table) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage:
          'extracted-patterns example.input missing required keys (source_table, target_table)',
      }
    }

    await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
      withFieldProfiles: true,
      ...(input.seed_issue
        ? {
            seedQualityIssue: {
              fieldName: input.seed_issue.field_name,
              severity: input.seed_issue.severity,
              title: input.seed_issue.title,
              description: input.seed_issue.description,
            },
          }
        : {}),
    })

    const callsBefore = Date.now()

    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await extractMigrationIntelligence({
      projectId,
      evalContext: {
        supabase: supabaseUserAuth,
        userId: EVAL_USER_ID,
        featureOverride: 'eval_extracted_patterns',
        skipPersist: true,
      },
    })

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000,
    })

    if (!aiResult.success) {
      return {
        score: 0,
        costUsd,
        errored: true,
        errorMessage: aiResult.error ?? 'extractMigrationIntelligence returned !success',
      }
    }

    const proposed = aiResult.rawPatterns ?? []
    const gold = args.example.gold as unknown as GoldExtractedPatterns
    const scored = scoreExtractedPatterns(proposed, gold)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Run one fix-options example end-to-end.
 *
 * Path 2 PR 2 B-2: dispatches to `generateFixSuggestions` with
 * `skipPersist: true` so the scorer measures raw AI output and the
 * `quality_issues.ai_fix_options` UPDATE is skipped. The synthetic
 * context seeds a quality_issues row via `builder.seedQualityIssue`;
 * the runner passes the resulting `qualityIssueId` to the entry
 * function. Field profiles are required here because
 * generateFixSuggestions calls `buildAIContext` with
 * `includeProfilingStats + includeValueDistributions`.
 */
async function runOneFixOptionsExample(args: {
  datasetName: string
  schema: ReturnType<typeof loadDataset>['schema']
  example: EvalExample
  orgId: string
}): Promise<{ score: number; costUsd: number; errored: boolean; errorMessage?: string }> {
  const projectName = `${EVAL_PROJECT_PREFIX}${randomUUID()}`
  let projectId: string | null = null

  try {
    projectId = await createSyntheticProject({
      name: projectName,
      userId: EVAL_USER_ID,
      orgId: args.orgId,
    })

    const input = args.example.input as {
      source_table: string
      target_table: string
      seed_issue: {
        field_name: string
        severity: 'blocking' | 'warning'
        title: string
        description: string
      }
    }
    if (!input.source_table || !input.target_table || !input.seed_issue) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage:
          'fix-options example.input missing required keys (source_table, target_table, seed_issue)',
      }
    }

    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
      withFieldProfiles: true,
      seedQualityIssue: {
        fieldName: input.seed_issue.field_name,
        severity: input.seed_issue.severity,
        title: input.seed_issue.title,
        description: input.seed_issue.description,
      },
    })

    if (!ctx.qualityIssueId) {
      return {
        score: 0,
        costUsd: 0,
        errored: true,
        errorMessage: 'synthetic-context did not return qualityIssueId despite seedQualityIssue',
      }
    }

    const callsBefore = Date.now()

    const supabaseUserAuth = buildUserAuthedClient()
    const aiResult = await generateFixSuggestions({
      issueId: ctx.qualityIssueId,
      evalContext: {
        supabase: supabaseUserAuth,
        userId: EVAL_USER_ID,
        featureOverride: 'eval_fix_options',
        skipPersist: true,
      },
    })

    const costUsd = await sumLlmCallsCost({
      projectId,
      sinceMs: callsBefore - 5_000,
    })

    if (!aiResult.success) {
      return {
        score: 0,
        costUsd,
        errored: true,
        errorMessage: aiResult.error ?? 'generateFixSuggestions returned !success',
      }
    }

    const proposed = aiResult.rawFixOptions ?? []
    const gold = args.example.gold as unknown as GoldFixOptions
    const scored = scoreFixOptions(proposed, gold, ctx.sourceTableId)

    return { score: scored.score, costUsd, errored: false }
  } catch (err) {
    return {
      score: 0,
      costUsd: 0,
      errored: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (projectId) {
      try {
        await teardownSyntheticProject(projectId)
      } catch (cleanupErr) {
        console.error(
          `[eval/runner] Teardown of synthetic project ${projectId} failed:`,
          cleanupErr,
        )
      }
    }
  }
}

/**
 * Read the AI's proposed mappings out of `target_field_mappings` +
 * `mapping_sources` and shape them as the scorer expects (using
 * field NAMES — the runner translates IDs → names so the scorer
 * compares like-for-like with translated gold labels).
 *
 * Returns one ProposedMapping per (target_field_id × ordered
 * mapping_sources) pairing. Combination type comes from the parent
 * TFM.
 */
async function readProposedMappings(args: {
  projectId: string
  ctx: import('@/lib/eval/synthetic-context-builder').BuiltMappingContext
}): Promise<ProposedMapping[]> {
  const { data: tfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id, target_field_id, combination_type, confidence, ai_reasoning')
    .eq('project_id', args.projectId)

  if (!tfms || tfms.length === 0) return []

  const tfmIds = tfms.map((t) => t.id as string)
  const { data: sources } = await supabaseAdmin
    .from('mapping_sources')
    .select('target_field_mapping_id, source_field_id, ordinal')
    .in('target_field_mapping_id', tfmIds)
    .order('ordinal', { ascending: true })

  // Reverse the name→id lookups to id→name so we can render proposals
  // back as field names matching the gold labels.
  const sourceIdToName = new Map<string, string>()
  for (const [name, id] of args.ctx.sourceFieldsByName) sourceIdToName.set(id, name)
  const targetIdToName = new Map<string, string>()
  for (const [name, id] of args.ctx.targetFieldsByName) targetIdToName.set(id, name)

  const proposed: ProposedMapping[] = []
  for (const tfm of tfms) {
    const targetName = targetIdToName.get(tfm.target_field_id as string)
    if (!targetName) continue

    const childSources = (sources ?? []).filter(
      (s) => s.target_field_mapping_id === tfm.id,
    )
    if (childSources.length === 0) continue

    // The scorer keys on (source_field, target_field). For a
    // many-to-one TFM, emit one ProposedMapping per source. The
    // combination_type rides on each, identical across the children.
    for (const src of childSources) {
      const srcId = src.source_field_id as string | null
      if (!srcId) continue
      const srcName = sourceIdToName.get(srcId)
      if (!srcName) continue
      proposed.push({
        source_field_id: srcName, // intentional: scorer compares names here
        target_field_id: targetName,
        combination_type: (tfm.combination_type as ProposedMapping['combination_type']) ?? undefined,
        confidence: typeof tfm.confidence === 'number' ? tfm.confidence : undefined,
        reasoning: (tfm.ai_reasoning as string) ?? undefined,
      })
    }
  }
  return proposed
}

/**
 * Translate the gold mappings (which use field NAMES) into the same
 * shape the scorer compares — also field-name-keyed. The id-vs-name
 * decision lives here so a single translation pass produces a
 * symmetric proposed/gold view.
 */
function translateGoldMappings(args: {
  example: EvalExample
  ctx: import('@/lib/eval/synthetic-context-builder').BuiltMappingContext
}): GoldMapping[] {
  const goldRaw = args.example.gold as { mappings?: Array<Record<string, unknown>> }
  const items = goldRaw.mappings ?? []
  const out: GoldMapping[] = []
  for (const m of items) {
    const sourceName = m.source_field as string | undefined
    const targetName = m.target_field as string | undefined
    if (!sourceName || !targetName) continue
    out.push({
      source_field_id: sourceName,
      target_field_id: targetName,
      combination_type: m.combination_type as GoldMapping['combination_type'],
    })
  }
  return out
}

/** Sum cost_usd of llm_calls rows for this project since `sinceMs`. */
async function sumLlmCallsCost(args: { projectId: string; sinceMs: number }): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('llm_calls')
    .select('cost_usd')
    .eq('project_id', args.projectId)
    .gte('created_at', new Date(args.sinceMs).toISOString())

  if (error) {
    console.warn(`[eval/runner] sumLlmCallsCost query failed: ${error.message}`)
    return 0
  }
  return (data ?? []).reduce(
    (acc, r) => acc + Number((r as { cost_usd: number | null }).cost_usd ?? 0),
    0,
  )
}

// ─── Pre-flight + cleanup ─────────────────────────────────────────────────────

async function preflight(orgId: string): Promise<boolean> {
  try {
    // Sweep any orphans from prior crashed runs.
    const { swept } = await sweepOrphans()
    if (swept > 0) {
      console.warn(`[eval/runner] preflight: swept ${swept} prior orphan(s)`)
    }

    // Create + verify + teardown sanity cycle. Confirms the prefix
    // guard, the FK shape, and the cascade-on-delete all work.
    const sanityName = `${EVAL_PROJECT_PREFIX}preflight-${randomUUID()}`
    const id = await createSyntheticProject({
      name: sanityName,
      userId: EVAL_USER_ID,
      orgId,
    })

    const { data: verify } = await supabaseAdmin
      .from('projects')
      .select('id, name')
      .eq('id', id)
      .single()
    if (!verify) {
      console.error('[eval/runner] preflight: project did not appear after insert')
      return false
    }

    const tornDown = await teardownSyntheticProject(id)
    if (!tornDown) {
      console.error('[eval/runner] preflight: teardown reported "already gone" — unexpected')
      return false
    }

    const { data: stillThere } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('id', id)
      .maybeSingle()
    if (stillThere) {
      console.error('[eval/runner] preflight: project still exists after teardown')
      return false
    }

    return true
  } catch (err) {
    console.error('[eval/runner] preflight failed:', err)
    return false
  }
}

async function finalCleanupCheck(): Promise<boolean> {
  try {
    const { swept } = await sweepOrphans()
    const { data: remaining } = await supabaseAdmin
      .from('projects')
      .select('id, name')
      .like('name', `${EVAL_PROJECT_PREFIX}%`)
    const orphanCount = remaining?.length ?? 0
    if (orphanCount > 0) {
      console.error(
        `[eval/runner] cleanup invariant FAILED: ${orphanCount} orphan(s) remain after sweep:`,
        remaining,
      )
      return false
    }
    if (swept > 0) {
      console.warn(`[eval/runner] cleanup: swept ${swept} orphan(s) at end of run`)
    }
    return true
  } catch (err) {
    console.error('[eval/runner] cleanup invariant failed with exception:', err)
    return false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeGitOutput(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}
