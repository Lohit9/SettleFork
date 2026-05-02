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
import { runMappingGenerationForPair } from '@/lib/actions/mappings'
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
   * 'mapping' (default for PR 10.4), 'validation-rule' (skipped with
   * warning until PR 11), or 'all' (currently equivalent to mapping
   * because that is the only end-to-end-wired task).
   */
  task?: 'mapping' | 'validation-rule' | 'all'
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
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

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
      model: DEFAULT_MODEL,
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
      model: DEFAULT_MODEL,
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

      // Validation-rule wiring is deferred to PR 11. Skip with a
      // warning so smoke runs over the _fixture dataset don't fail.
      if (item.example.task === 'validation-rule') {
        console.warn(
          `[eval/runner] Skipping validation-rule example "${item.example.id}" — end-to-end wiring deferred to PR 11.`,
        )
        continue
      }

      if (item.example.task !== 'mapping') {
        console.warn(
          `[eval/runner] Skipping example "${item.example.id}" — task "${item.example.task}" not yet wired.`,
        )
        continue
      }

      const exStart = Date.now()
      const exResult = await runOneMappingExample({
        datasetName: item.datasetName,
        schema: item.schema,
        example: item.example,
        orgId,
      })

      dm.examples++
      dm.costUsd += exResult.costUsd
      dm.durationMs += Date.now() - exStart
      dm.cachedCount += 0 // PR 10.4 has no cache

      // Aggregate the field-pair F1 scorer.
      const scorerName = 'scoreMappingFieldPair'
      const summary = dm.scorers[scorerName] ?? {
        mean: 0,
        count: 0,
        min: 1,
        max: 0,
        errorCount: 0,
      }
      if (exResult.errored) {
        summary.errorCount++
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
    model: DEFAULT_MODEL,
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

    // Tasks to include.
    const tasks: Array<keyof typeof ds.examples> =
      opts.task === 'mapping'
        ? ['mapping']
        : opts.task === 'validation-rule'
          ? ['validation-rule']
          : ['mapping', 'validation-rule']

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

    const ctx = await buildSyntheticMappingContext({
      projectId,
      schema: args.schema,
      sourceTableName: input.source_table,
      targetTableName: input.target_table,
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
