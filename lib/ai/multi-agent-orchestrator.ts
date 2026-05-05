/**
 * PR 3.4cd commit 2 — Multi-agent mapping pipeline orchestrator (SHELL).
 *
 * Pipeline per Phase A §E1:
 *   T0: 3× Generator (parallel, voted)        → aggregate candidate votes
 *   T1: Cross-Table + Cardinality (parallel)  → resolve cross-table + cardinality
 *   T2: 3× Critic (parallel, voted)           → aggregate critique votes
 *   T3: Generator refinement (single-shot)    → final EMIT_TABLE_MAPPINGS_TOOL output
 *   T4: caller persists via existing path     → unchanged from PR 3.4b
 *
 * THIS COMMIT (commit 2/4) ships the SHELL of the pipeline:
 *   - All 4 agent-call shapes (Generator / Cross-Table / Cardinality / Critic).
 *   - Sequential T0 → T1 → T2 → T3 with the locked per-agent settings
 *     (Opus 4.7 + adaptive thinking + max effort + temperature 0.6 on
 *     voted agents).
 *   - Parallel-3 invocation for Generator + Critic via Promise.all.
 *   - Refinement step (T3) delegates to runSingleAgentMappingLoop with
 *     a critique-augmented user message.
 *   - Per-agent abort handling per Phase A §E2 (skip pair on hard fail;
 *     LOCK #5 schema_error fallback; absorb specialist failures by
 *     passing-through unresolved candidates to Critic).
 *
 * COMMIT 3 (next session) replaces the SHELL aggregators with the
 * proper voting algorithm (Jaccard-similarity critique matching,
 * confidence calibration, controversial-bucket detection,
 * SELECT-poll-then-UPDATE telemetry on `vote_outcome`).
 *
 * Spec: docs/investigations/pr3.4cd-multi-agent-mapping.md §B / §C / §E.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { callLLM, type CallLLMResult, type LLMFeature } from '@/lib/ai/llm-client'
import { runAgentLoop, type AgentLoopResult } from '@/lib/ai/agent-loop'
import {
  makeQueryFieldDataHandler,
  makeCountDistinctPatternsHandler,
  makeCrossFieldCorrelationHandler,
} from '@/lib/ai/agent-tools'
import {
  EMIT_TABLE_MAPPINGS_TOOL,
  EMIT_MAPPING_CANDIDATES_TOOL,
  EMIT_CROSS_TABLE_RESOLUTIONS_TOOL,
  EMIT_CARDINALITY_RESOLUTIONS_TOOL,
  EMIT_CRITIQUE_TOOL,
  QUERY_FIELD_DATA_TOOL,
  COUNT_DISTINCT_PATTERNS_TOOL,
  CROSS_FIELD_CORRELATION_TOOL,
} from '@/lib/ai/tool-schemas'
import {
  GENERATOR_SYSTEM_PROMPT,
  CROSS_TABLE_SPECIALIST_SYSTEM_PROMPT,
  CARDINALITY_SPECIALIST_SYSTEM_PROMPT,
  CRITIC_SYSTEM_PROMPT,
} from '@/lib/ai/multi-agent-prompts'
import {
  buildAgentUserMessage,
  MAPPING_GENERATION_AGENT_SYSTEM_PROMPT,
} from '@/lib/ai/mapping-engine'
import type {
  CandidateMapping,
  CrossTableResolution,
  CardinalityResolution,
  Critique,
  AggregatedCandidates,
  AggregatedCritiques,
  MultiAgentVoteSummary,
  MultiAgentMappingResult,
} from '@/lib/ai/multi-agent-types'

// ─── Locked configuration (Phase A §B + §C + LOCK list) ─────────────────────

/** Voting concurrency for Generator + Critic (PR 3.4d). */
const VOTE_COUNT = 3
/** Locked sampling temperature for the 3-vote variance source (Phase A D-3). */
const VOTE_TEMPERATURE = 0.6
/** Per-agent maxIterations (Phase A R4 / OQ2). */
const PER_AGENT_MAX_ITERATIONS = 6
/** Per-agent maxCostUsd (Phase A R4 / OQ2). Generator with 3 votes → up to $4.50. */
const PER_AGENT_MAX_COST_USD = 1.5
/** Aggregate per-pair cap (Phase A R4). Hard-fail the pair if exceeded. */
const PER_PAIR_MAX_COST_USD = 15.0

// ─── Public API ─────────────────────────────────────────────────────────────

export interface RunMultiAgentMappingPipelineArgs {
  supabase: SupabaseClient
  projectId: string
  userId: string
  /** LLMFeature tag (overridden for eval runs). */
  feature: LLMFeature
  /** Per-pair user message (already built by the caller). */
  baseUserMessage: string
  schemaOverviewBlock: string
  businessContext: string | null
  /** Per-batch token cap (16000 today). */
  maxTokens: number
  /** Per-batch metadata threaded into every llm_calls row. */
  baseMetadata: Record<string, unknown>
  /** BULK callsite: true. Single-pair callsite: false. */
  cacheControl: boolean
  /** List of unmapped target field names — surfaced to Critic. */
  unmappedTargetFields: string[]
}

/**
 * Discriminated result mirroring `SingleAgentResult` so the gate at each
 * callsite can dispatch uniformly between single-agent and multi-agent
 * paths. The success path returns a CallLLMResult shape (the Refiner's
 * EMIT_TABLE_MAPPINGS_TOOL output, adapted via synthesizeToolUseResult)
 * + the multi-agent telemetry payload.
 */
export type MultiAgentResult =
  | { kind: 'ok'; result: CallLLMResult; telemetry: MultiAgentMappingResult }
  | { kind: 'pair_aborted'; reason: string; message: string }

// ─── Pipeline entry ─────────────────────────────────────────────────────────

/**
 * Run the 4-agent pipeline for ONE (source_table, target_table) pair.
 * Caller threads the per-pair context (cached prefix, base user message,
 * unmapped target list) and gets back a CallLLMResult-shaped final
 * answer + telemetry. Caller's downstream persistence path is unchanged.
 *
 * COMMIT 2 STATUS — SHELL: this function lays out the T0-T3 sequencing
 * and the per-agent invocation shapes. The vote aggregators (commit 3)
 * are stubbed to first-vote-wins for now so the shell is testable in
 * isolation; commit 3 replaces them with proper aggregation + telemetry
 * + confidence calibration. The refinement call (T3) is fully wired
 * via `runSingleAgentMappingLoop`.
 */
export async function runMultiAgentMappingPipeline(
  args: RunMultiAgentMappingPipelineArgs,
): Promise<MultiAgentResult> {
  const { supabase, projectId, userId, feature, baseUserMessage, schemaOverviewBlock, businessContext, maxTokens, baseMetadata, cacheControl, unmappedTargetFields } = args

  // Cached prefix (business_context + schema_overview) — reused as the
  // user-message base for every agent. Each agent appends its own
  // per-call payload via inter-agent comms (D2-D5).
  const cachedPrefixUserMessage = buildAgentUserMessage({
    baseUserMessage,
    schemaOverview: schemaOverviewBlock,
    businessContext,
  })

  let totalCostUsd = 0
  const callIds: string[] = []
  let totalIterations = 0

  // PR 3.4cd commit 3: capture pipeline-start ISO so the post-aggregation
  // telemetry helper (`applyVoteOutcomeMetadata`) can scope its
  // SELECT-poll-then-UPDATE to llm_calls rows from THIS pair only.
  const pipelineStartedAtIso = new Date().toISOString()

  // ─── T0: Generator (3 votes parallel) ────────────────────────────────────
  const generatorVotes: GeneratorAgentResult[] = await Promise.all(
    Array.from({ length: VOTE_COUNT }, (_, i) =>
      runGeneratorAgent({
        supabase,
        projectId,
        userId,
        feature,
        userMessage: cachedPrefixUserMessage,
        maxTokens,
        baseMetadata: { ...baseMetadata, vote_role: 'generator', vote_index: i + 1 },
        cacheControl,
        voteIndex: i + 1,
      }),
    ),
  )

  // Collect telemetry from all 3 generator runs.
  for (const v of generatorVotes) {
    if (v.kind === 'ok') {
      totalCostUsd += v.costUsd ?? 0
      totalIterations += v.iterations
      callIds.push(...v.callIds)
    }
  }

  // Phase A §E2 failure handling: all 3 votes aborted → hard-fail the pair.
  const okGeneratorVotes = generatorVotes.filter((v) => v.kind === 'ok') as Array<
    GeneratorAgentResult & { kind: 'ok' }
  >
  if (okGeneratorVotes.length === 0) {
    return {
      kind: 'pair_aborted',
      reason: 'generator_all_voted_aborted',
      message: `All 3 Generator votes failed: ${generatorVotes.map((v) => (v.kind === 'aborted' ? v.message : 'ok')).join('; ')}`,
    }
  }

  // PR 3.4cd commit 3: proper joint-key vote aggregation with
  // unanimous/majority/controversial classification and confidence
  // calibration (95/67/50). See `aggregateCandidates` below.
  const aggregatedCandidates: AggregatedCandidates = aggregateCandidates(
    okGeneratorVotes.map((v) => v.candidates),
  )

  // Best-effort post-aggregation telemetry: attach `vote_outcome` to
  // each Generator llm_calls row. Only meaningful when at least one of
  // {unanimous, majority, controversial} is non-empty; for a stage with
  // mixed outcomes we tag with the dominant one.
  void applyVoteOutcomeMetadata({
    supabase,
    projectId,
    voteRole: 'generator',
    voteOutcome: pickDominantOutcome(aggregatedCandidates.summary),
    sinceIso: pipelineStartedAtIso,
    expectedCount: okGeneratorVotes.length,
  })

  // Cost cap check — abort early if Generator alone blew the budget.
  if (totalCostUsd > PER_PAIR_MAX_COST_USD) {
    return {
      kind: 'pair_aborted',
      reason: 'pair_cost_cap',
      message: `Pair cost cap exceeded after Generator: $${totalCostUsd.toFixed(4)} > $${PER_PAIR_MAX_COST_USD}`,
    }
  }

  // ─── T1: Cross-Table + Cardinality (parallel, single-shot each) ──────────
  const crossTableInputCandidates = aggregatedCandidates.unanimous
    .concat(aggregatedCandidates.majority)
    .filter((c) => c.tag === 'cross_table' || c.tag === 'uncertain')

  const cardinalityInputCandidates = aggregatedCandidates.unanimous
    .concat(aggregatedCandidates.majority)
    .filter(
      (c) => c.tag === 'many_to_one' || c.tag === 'one_to_many' || c.tag === 'uncertain',
    )

  const [crossTableResult, cardinalityResult] = await Promise.all([
    crossTableInputCandidates.length > 0
      ? runCrossTableSpecialistAgent({
          supabase,
          projectId,
          userId,
          feature,
          userMessage: cachedPrefixUserMessage,
          candidates: crossTableInputCandidates,
          maxTokens,
          baseMetadata: { ...baseMetadata, vote_role: 'cross_table_specialist' },
          cacheControl,
        })
      : Promise.resolve<SpecialistAgentResult<CrossTableResolution>>({
          kind: 'ok',
          resolutions: [],
          costUsd: 0,
          iterations: 0,
          callIds: [],
        }),
    cardinalityInputCandidates.length > 0
      ? runCardinalitySpecialistAgent({
          supabase,
          projectId,
          userId,
          feature,
          userMessage: cachedPrefixUserMessage,
          candidates: cardinalityInputCandidates,
          maxTokens,
          baseMetadata: { ...baseMetadata, vote_role: 'cardinality_specialist' },
          cacheControl,
        })
      : Promise.resolve<SpecialistAgentResult<CardinalityResolution>>({
          kind: 'ok',
          resolutions: [],
          costUsd: 0,
          iterations: 0,
          callIds: [],
        }),
  ])

  if (crossTableResult.kind === 'ok') {
    totalCostUsd += crossTableResult.costUsd ?? 0
    totalIterations += crossTableResult.iterations
    callIds.push(...crossTableResult.callIds)
  }
  if (cardinalityResult.kind === 'ok') {
    totalCostUsd += cardinalityResult.costUsd ?? 0
    totalIterations += cardinalityResult.iterations
    callIds.push(...cardinalityResult.callIds)
  }

  if (totalCostUsd > PER_PAIR_MAX_COST_USD) {
    return {
      kind: 'pair_aborted',
      reason: 'pair_cost_cap',
      message: `Pair cost cap exceeded after specialists: $${totalCostUsd.toFixed(4)} > $${PER_PAIR_MAX_COST_USD}`,
    }
  }

  // Merge specialist outputs into the confirmed mapping set.
  const confirmedMappings = mergeSpecialistResolutions({
    aggregated: aggregatedCandidates,
    crossTableResolutions:
      crossTableResult.kind === 'ok' ? crossTableResult.resolutions : [],
    cardinalityResolutions:
      cardinalityResult.kind === 'ok' ? cardinalityResult.resolutions : [],
    crossTableInputCandidates,
    cardinalityInputCandidates,
  })

  // ─── T2: Critic (3 votes parallel) ───────────────────────────────────────
  const criticVotes: CriticAgentResult[] = await Promise.all(
    Array.from({ length: VOTE_COUNT }, (_, i) =>
      runCriticAgent({
        supabase,
        projectId,
        userId,
        feature,
        userMessage: cachedPrefixUserMessage,
        confirmedMappings,
        unmappedTargetFields,
        maxTokens,
        baseMetadata: { ...baseMetadata, vote_role: 'critic', vote_index: i + 1 },
        cacheControl,
        voteIndex: i + 1,
      }),
    ),
  )

  for (const v of criticVotes) {
    if (v.kind === 'ok') {
      totalCostUsd += v.costUsd ?? 0
      totalIterations += v.iterations
      callIds.push(...v.callIds)
    }
  }

  // Phase A §E2: Critic all-aborted → recommended is "skip critique +
  // persist confirmed mappings without refinement". The pipeline still
  // produces a valid output; just no critique-driven refinement.
  const okCriticVotes = criticVotes.filter((v) => v.kind === 'ok') as Array<
    CriticAgentResult & { kind: 'ok' }
  >

  // PR 3.4cd commit 3: proper Jaccard-similarity critique aggregation.
  const aggregatedCritiques: AggregatedCritiques = aggregateCritiques(
    okCriticVotes.map((v) => v.critiques),
  )

  void applyVoteOutcomeMetadata({
    supabase,
    projectId,
    voteRole: 'critic',
    voteOutcome: pickDominantOutcome(aggregatedCritiques.summary),
    sinceIso: pipelineStartedAtIso,
    expectedCount: okCriticVotes.length,
  })

  if (totalCostUsd > PER_PAIR_MAX_COST_USD) {
    return {
      kind: 'pair_aborted',
      reason: 'pair_cost_cap',
      message: `Pair cost cap exceeded after Critic: $${totalCostUsd.toFixed(4)} > $${PER_PAIR_MAX_COST_USD}`,
    }
  }

  // ─── T3: Generator refinement (single-shot, no voting) ───────────────────
  // Refinement uses the legacy MAPPING_GENERATION_AGENT_SYSTEM_PROMPT
  // and EMIT_TABLE_MAPPINGS_TOOL — final output goes through the
  // existing persistence path (synthesizeToolUseResult adapter).
  const refinementUserMessage = buildRefinementUserMessage({
    baseUserMessage,
    confirmedMappings,
    aggregatedCritiques,
  })

  // Direct call (not via runSingleAgentMappingLoop) because the refinement
  // is a single-shot, no schema_error fallback — the agent saw the full
  // pipeline context already and either produces a valid answer or fails.
  let refinementResult: AgentLoopResult
  try {
    refinementResult = await runAgentLoop({
      feature,
      systemPrompt: MAPPING_GENERATION_AGENT_SYSTEM_PROMPT,
      userMessage: buildAgentUserMessage({
        baseUserMessage: refinementUserMessage,
        schemaOverview: schemaOverviewBlock,
        businessContext,
      }),
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase, projectId, userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase, projectId, userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase, projectId, userId }) },
        { tool: EMIT_TABLE_MAPPINGS_TOOL },
      ],
      projectId,
      userId,
      maxIterations: PER_AGENT_MAX_ITERATIONS,
      maxCostUsd: PER_AGENT_MAX_COST_USD,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens,
        promptVersion: 'mapping-v3-refinement',
        ...(cacheControl ? { cacheControl: true } : {}),
        abuseUserId: userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        // Refinement is single-shot — temperature 0 (deterministic given
        // the constrained user message) is appropriate; voting is not
        // needed at this stage.
        metadata: {
          ...baseMetadata,
          vote_role: 'refiner',
          agent_loop: true,
        },
      },
    })
  } catch (err) {
    return {
      kind: 'pair_aborted',
      reason: 'refinement_threw',
      message: err instanceof Error ? err.message : 'Refinement threw',
    }
  }

  if (refinementResult.kind !== 'final') {
    return {
      kind: 'pair_aborted',
      reason: 'refinement_aborted',
      message: `Refinement aborted: ${refinementResult.reason} — ${refinementResult.message}`,
    }
  }

  totalCostUsd += refinementResult.totalCostUsd ?? 0
  totalIterations += refinementResult.iterations
  callIds.push(...refinementResult.callIds)

  // ─── T4: Build final result for caller ───────────────────────────────────
  const finalResult: CallLLMResult = synthesizeRefinementResult(refinementResult)

  const telemetry: MultiAgentMappingResult = {
    confirmed_mappings: confirmedMappings,
    generator_vote_summary: aggregatedCandidates.summary,
    critic_vote_summary: aggregatedCritiques.summary,
    critiques: aggregatedCritiques,
    total_cost_usd: totalCostUsd,
    total_iterations: totalIterations,
    call_ids: callIds,
  }

  return { kind: 'ok', result: finalResult, telemetry }
}

// ─── Per-agent helpers ──────────────────────────────────────────────────────

interface GeneratorAgentArgs {
  supabase: SupabaseClient
  projectId: string
  userId: string
  feature: LLMFeature
  userMessage: string
  maxTokens: number
  baseMetadata: Record<string, unknown>
  cacheControl: boolean
  voteIndex: number
}

type GeneratorAgentResult =
  | { kind: 'ok'; candidates: CandidateMapping[]; costUsd: number | null; iterations: number; callIds: string[] }
  | { kind: 'aborted'; reason: string; message: string }

async function runGeneratorAgent(args: GeneratorAgentArgs): Promise<GeneratorAgentResult> {
  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      feature: args.feature,
      systemPrompt: GENERATOR_SYSTEM_PROMPT,
      userMessage: args.userMessage,
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: EMIT_MAPPING_CANDIDATES_TOOL },
      ],
      projectId: args.projectId,
      userId: args.userId,
      maxIterations: PER_AGENT_MAX_ITERATIONS,
      maxCostUsd: PER_AGENT_MAX_COST_USD,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens: args.maxTokens,
        promptVersion: 'mapping-v3-generator',
        ...(args.cacheControl ? { cacheControl: true } : {}),
        abuseUserId: args.userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        temperature: VOTE_TEMPERATURE,
        metadata: { ...args.baseMetadata, agent_loop: true },
      },
    })
  } catch (err) {
    return { kind: 'aborted', reason: 'threw', message: err instanceof Error ? err.message : String(err) }
  }
  if (result.kind !== 'final') {
    return { kind: 'aborted', reason: result.reason, message: result.message }
  }
  const input = result.finalToolUse.input as { candidates?: CandidateMapping[] }
  return {
    kind: 'ok',
    candidates: input.candidates ?? [],
    costUsd: result.totalCostUsd,
    iterations: result.iterations,
    callIds: result.callIds,
  }
}

interface SpecialistAgentArgs<TCandidate> {
  supabase: SupabaseClient
  projectId: string
  userId: string
  feature: LLMFeature
  userMessage: string
  candidates: TCandidate[]
  maxTokens: number
  baseMetadata: Record<string, unknown>
  cacheControl: boolean
}

type SpecialistAgentResult<TResolution> =
  | { kind: 'ok'; resolutions: TResolution[]; costUsd: number | null; iterations: number; callIds: string[] }
  | { kind: 'aborted'; reason: string; message: string }

async function runCrossTableSpecialistAgent(
  args: SpecialistAgentArgs<CandidateMapping>,
): Promise<SpecialistAgentResult<CrossTableResolution>> {
  const candidatesPayload = `\n<generator_candidates_to_resolve>\n${JSON.stringify(args.candidates, null, 2)}\n</generator_candidates_to_resolve>\n\nFor each candidate above, confirm or reject the cross-table mapping. If confirming, populate join_spec.`
  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      feature: args.feature,
      systemPrompt: CROSS_TABLE_SPECIALIST_SYSTEM_PROMPT,
      userMessage: args.userMessage + candidatesPayload,
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: EMIT_CROSS_TABLE_RESOLUTIONS_TOOL },
      ],
      projectId: args.projectId,
      userId: args.userId,
      maxIterations: PER_AGENT_MAX_ITERATIONS,
      maxCostUsd: PER_AGENT_MAX_COST_USD,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens: args.maxTokens,
        promptVersion: 'mapping-v3-cross-table',
        ...(args.cacheControl ? { cacheControl: true } : {}),
        abuseUserId: args.userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        metadata: { ...args.baseMetadata, agent_loop: true },
      },
    })
  } catch (err) {
    return { kind: 'aborted', reason: 'threw', message: err instanceof Error ? err.message : String(err) }
  }
  if (result.kind !== 'final') {
    return { kind: 'aborted', reason: result.reason, message: result.message }
  }
  const input = result.finalToolUse.input as { resolutions?: CrossTableResolution[] }
  return {
    kind: 'ok',
    resolutions: input.resolutions ?? [],
    costUsd: result.totalCostUsd,
    iterations: result.iterations,
    callIds: result.callIds,
  }
}

async function runCardinalitySpecialistAgent(
  args: SpecialistAgentArgs<CandidateMapping>,
): Promise<SpecialistAgentResult<CardinalityResolution>> {
  const candidatesPayload = `\n<generator_candidates_to_classify>\n${JSON.stringify(args.candidates, null, 2)}\n</generator_candidates_to_classify>\n\nFor each candidate above, confirm cardinality and emit a transformation_pattern, OR reclassify if the data does not support the proposed cardinality.`
  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      feature: args.feature,
      systemPrompt: CARDINALITY_SPECIALIST_SYSTEM_PROMPT,
      userMessage: args.userMessage + candidatesPayload,
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: EMIT_CARDINALITY_RESOLUTIONS_TOOL },
      ],
      projectId: args.projectId,
      userId: args.userId,
      maxIterations: PER_AGENT_MAX_ITERATIONS,
      maxCostUsd: PER_AGENT_MAX_COST_USD,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens: args.maxTokens,
        promptVersion: 'mapping-v3-cardinality',
        ...(args.cacheControl ? { cacheControl: true } : {}),
        abuseUserId: args.userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        metadata: { ...args.baseMetadata, agent_loop: true },
      },
    })
  } catch (err) {
    return { kind: 'aborted', reason: 'threw', message: err instanceof Error ? err.message : String(err) }
  }
  if (result.kind !== 'final') {
    return { kind: 'aborted', reason: result.reason, message: result.message }
  }
  const input = result.finalToolUse.input as { resolutions?: CardinalityResolution[] }
  return {
    kind: 'ok',
    resolutions: input.resolutions ?? [],
    costUsd: result.totalCostUsd,
    iterations: result.iterations,
    callIds: result.callIds,
  }
}

interface CriticAgentArgs {
  supabase: SupabaseClient
  projectId: string
  userId: string
  feature: LLMFeature
  userMessage: string
  confirmedMappings: CandidateMapping[]
  unmappedTargetFields: string[]
  maxTokens: number
  baseMetadata: Record<string, unknown>
  cacheControl: boolean
  voteIndex: number
}

type CriticAgentResult =
  | { kind: 'ok'; critiques: Critique[]; costUsd: number | null; iterations: number; callIds: string[] }
  | { kind: 'aborted'; reason: string; message: string }

async function runCriticAgent(args: CriticAgentArgs): Promise<CriticAgentResult> {
  const payload = `\n<confirmed_mappings>\n${JSON.stringify(args.confirmedMappings, null, 2)}\n</confirmed_mappings>\n\n<unmapped_target_fields>\n${args.unmappedTargetFields.map((f) => `  - ${f}`).join('\n') || '  (none)'}\n</unmapped_target_fields>\n\nCritique the confirmed mappings. Surface contradictions, missed mappings, conservative mistakes, and aggressive mistakes. Use the data-scanning tools to verify hypotheses before flagging — false positives degrade refinement quality.`
  let result: AgentLoopResult
  try {
    result = await runAgentLoop({
      feature: args.feature,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      userMessage: args.userMessage + payload,
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase: args.supabase, projectId: args.projectId, userId: args.userId }) },
        { tool: EMIT_CRITIQUE_TOOL },
      ],
      projectId: args.projectId,
      userId: args.userId,
      maxIterations: PER_AGENT_MAX_ITERATIONS,
      maxCostUsd: PER_AGENT_MAX_COST_USD,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens: args.maxTokens,
        promptVersion: 'mapping-v3-critic',
        ...(args.cacheControl ? { cacheControl: true } : {}),
        abuseUserId: args.userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        temperature: VOTE_TEMPERATURE,
        metadata: { ...args.baseMetadata, agent_loop: true },
      },
    })
  } catch (err) {
    return { kind: 'aborted', reason: 'threw', message: err instanceof Error ? err.message : String(err) }
  }
  if (result.kind !== 'final') {
    return { kind: 'aborted', reason: result.reason, message: result.message }
  }
  const input = result.finalToolUse.input as { critiques?: Critique[] }
  return {
    kind: 'ok',
    critiques: input.critiques ?? [],
    costUsd: result.totalCostUsd,
    iterations: result.iterations,
    callIds: result.callIds,
  }
}

// ─── Vote aggregators (PR 3.4cd commit 3) ───────────────────────────────────

/** Confidence persistence values per Phase A §C4. */
export const CONFIDENCE_UNANIMOUS = 95
export const CONFIDENCE_MAJORITY = 67
export const CONFIDENCE_CONTROVERSIAL = 50

/**
 * Aggregate Generator votes per Phase A §C2.
 *
 * Joint key: `(source_field || target_field || tag)`. A candidate with
 * the same joint key across N votes counts as N-way agreement.
 * Different tags on the same `(source_field, target_field)` count as
 * disagreement (the tag IS the resolution-routing decision).
 *
 * Output classification (3 votes assumed):
 *   - 3/3 → unanimous (confidence 95). Agent's pre-vote `confidence`
 *     overwritten with the locked unanimous value; the candidate from
 *     vote 1 is the canonical instance (deterministic for downstream
 *     ordering).
 *   - 2/3 → majority (confidence 67). The minority's tag is captured
 *     in `minority_tag` if it exists for the same field-pair (i.e., a
 *     vote produced the same source/target pair but a different tag).
 *   - 1/1/1 → controversial (confidence 50). All three voters disagreed
 *     on the joint key. Returned as `Array<CandidateMapping[]>` —
 *     each inner array is the set of distinct interpretations from
 *     the three voters for one ambiguous (source_field, target_field).
 *     Routed to Critic via the `unmappedTargetFields` mechanism (see
 *     `runMultiAgentMappingPipeline`) and surfaced low-confidence to
 *     the existing mapping UI review flow.
 *
 * Pure function. Exported for unit testing.
 */
export function aggregateCandidates(
  votes: CandidateMapping[][],
): AggregatedCandidates {
  const totalVotes = votes.length

  // Build joint-key index: jointKey → Map<voteIndex, CandidateMapping>.
  // A vote contributing the same joint key to multiple candidates
  // (shouldn't happen, but defensive) keeps only the first occurrence.
  const byJointKey = new Map<string, Map<number, CandidateMapping>>()
  for (let voteIdx = 0; voteIdx < votes.length; voteIdx++) {
    const seenInThisVote = new Set<string>()
    for (const candidate of votes[voteIdx] ?? []) {
      const key = candidateJointKey(candidate)
      if (seenInThisVote.has(key)) continue
      seenInThisVote.add(key)
      let voteMap = byJointKey.get(key)
      if (!voteMap) {
        voteMap = new Map()
        byJointKey.set(key, voteMap)
      }
      voteMap.set(voteIdx, candidate)
    }
  }

  // Also build a (source_field, target_field) → array-of-(voteIdx,
  // candidate) index so we can detect "same field-pair, different
  // tag" — that's a controversial set, not three independent
  // candidates. Used to compute minority_tag on majority outcomes
  // and to bucket 1/1/1 disagreement.
  const byFieldPair = new Map<string, Array<{ voteIdx: number; candidate: CandidateMapping }>>()
  for (let voteIdx = 0; voteIdx < votes.length; voteIdx++) {
    const seenInThisVote = new Set<string>()
    for (const candidate of votes[voteIdx] ?? []) {
      const fieldPairKey = `${candidate.source_field}||${candidate.target_field}`
      if (seenInThisVote.has(fieldPairKey)) continue
      seenInThisVote.add(fieldPairKey)
      const arr = byFieldPair.get(fieldPairKey) ?? []
      arr.push({ voteIdx, candidate })
      byFieldPair.set(fieldPairKey, arr)
    }
  }

  // Track which field pairs have been claimed by unanimous/majority
  // so we don't double-bucket them as controversial.
  const claimedFieldPairs = new Set<string>()

  const unanimous: CandidateMapping[] = []
  const majority: AggregatedCandidates['majority'] = []

  for (const [jointKey, voteMap] of byJointKey) {
    const agreementCount = voteMap.size
    if (agreementCount < 2) continue // controversial; handled below

    // First vote's instance is canonical (deterministic ordering).
    const sortedVoteIdxs = [...voteMap.keys()].sort((a, b) => a - b)
    const canonical = voteMap.get(sortedVoteIdxs[0]!)!

    if (agreementCount === totalVotes) {
      unanimous.push({ ...canonical, confidence: CONFIDENCE_UNANIMOUS })
      claimedFieldPairs.add(`${canonical.source_field}||${canonical.target_field}`)
    } else {
      // 2/3 majority. Find the minority's tag for the same field pair
      // (if any vote produced the same source/target with a different tag).
      const fieldPairKey = `${canonical.source_field}||${canonical.target_field}`
      const peers = byFieldPair.get(fieldPairKey) ?? []
      const minorityTags = new Set<CandidateMapping['tag']>()
      for (const p of peers) {
        if (p.candidate.tag !== canonical.tag) minorityTags.add(p.candidate.tag)
      }
      const minorityTag = minorityTags.size > 0 ? [...minorityTags][0]! : undefined
      majority.push({
        ...canonical,
        confidence: CONFIDENCE_MAJORITY,
        ...(minorityTag !== undefined ? { minority_tag: minorityTag } : {}),
      })
      claimedFieldPairs.add(fieldPairKey)
    }
  }

  // Controversial: field pairs with 1/1/1 distinct interpretations
  // (≥ 2 distinct joint keys for the same field pair, none agreed-on).
  // Each entry is the array of distinct CandidateMappings for that field
  // pair — the orchestrator surfaces them low-confidence to the UI.
  const controversial: AggregatedCandidates['controversial'] = []
  for (const [fieldPairKey, peers] of byFieldPair) {
    if (claimedFieldPairs.has(fieldPairKey)) continue
    // Distinct joint keys count
    const jointKeys = new Set(peers.map((p) => candidateJointKey(p.candidate)))
    if (jointKeys.size < 2) continue // shouldn't happen if not in byJointKey 2+, but defensive
    controversial.push(
      peers.map((p) => ({ ...p.candidate, confidence: CONFIDENCE_CONTROVERSIAL })),
    )
  }

  const summary: MultiAgentVoteSummary = {
    unanimous: unanimous.length,
    majority: majority.length,
    controversial: controversial.length,
  }
  return { unanimous, majority, controversial, summary }
}

function candidateJointKey(c: CandidateMapping): string {
  return `${c.source_field}||${c.target_field}||${c.tag}`
}

/**
 * Aggregate Critic votes per Phase A §C3.
 *
 * Two-stage matching:
 *   1. Coarse key: `(category, affected_mapping_index || affected_target_field)`.
 *      Two critiques in different votes that share this key are
 *      candidates for "same critique".
 *   2. Fine match: Jaccard similarity on description tokens ≥ 0.5.
 *      If two critiques share the coarse key AND have similar
 *      descriptions, they count as the same critique.
 *
 * Output:
 *   - 3/3 + 2/3 agreement → high_confidence (refinement MUST address)
 *   - 1/1/1 disagreement → low_confidence (refinement may; surface in
 *     final mapping rationale)
 *
 * Pure function. Exported for unit testing.
 */
export function aggregateCritiques(votes: Critique[][]): AggregatedCritiques {
  // Within a single vote, dedupe critiques on the coarse key (a vote
  // shouldn't produce two critiques for the same (category, affected)
  // — but if it does, the first wins).
  const dedupedVotes: Critique[][] = votes.map((vote) => {
    const seen = new Set<string>()
    const out: Critique[] = []
    for (const c of vote ?? []) {
      const key = critiqueCoarseKey(c)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
    }
    return out
  })

  // Build groups: each group is a set of critiques (one per vote at most)
  // that share the coarse key + Jaccard ≥ 0.5 on description.
  // Greedy grouping: walk vote 1, find matches in vote 2 + vote 3.
  const groups: Critique[][] = []
  const usedPerVote: Set<number>[] = dedupedVotes.map(() => new Set())

  for (let i = 0; i < dedupedVotes.length; i++) {
    for (let j = 0; j < dedupedVotes[i]!.length; j++) {
      if (usedPerVote[i]!.has(j)) continue
      const seed = dedupedVotes[i]![j]!
      const group: Critique[] = [seed]
      usedPerVote[i]!.add(j)

      for (let other = i + 1; other < dedupedVotes.length; other++) {
        for (let k = 0; k < dedupedVotes[other]!.length; k++) {
          if (usedPerVote[other]!.has(k)) continue
          const candidate = dedupedVotes[other]![k]!
          if (
            critiqueCoarseKey(candidate) === critiqueCoarseKey(seed) &&
            jaccardSimilarity(seed.description, candidate.description) >= 0.5
          ) {
            group.push(candidate)
            usedPerVote[other]!.add(k)
            break // one match per vote
          }
        }
      }
      groups.push(group)
    }
  }

  const high_confidence: Critique[] = []   // 3/3 agreement
  const medium_confidence: Critique[] = [] // 2/3 agreement
  const low_confidence: Critique[][] = []  // 1/1/1 disagreement (singleton group)
  for (const group of groups) {
    if (group.length === votes.length) {
      // 3/3 — refinement MUST address. Keep first vote's instance as canonical.
      high_confidence.push(group[0]!)
    } else if (group.length >= 2) {
      // 2/3 — refinement SHOULD address.
      medium_confidence.push(group[0]!)
    } else {
      // 1/1/1 (singleton): isolated critique. Surfaces low-confidence
      // with the full critique payload in case the rationale matters.
      low_confidence.push(group)
    }
  }

  const summary: MultiAgentVoteSummary = {
    unanimous: high_confidence.length,
    majority: medium_confidence.length,
    controversial: low_confidence.length,
  }
  return { high_confidence, medium_confidence, low_confidence, summary }
}

/**
 * Pick the dominant vote outcome from a summary for `vote_outcome`
 * telemetry tagging. Used to label all 3 llm_calls rows in a voted
 * stage with a single tag. Tie-breaking: unanimous > majority >
 * controversial (most-confident wins on ties).
 */
function pickDominantOutcome(
  summary: MultiAgentVoteSummary,
): 'unanimous' | 'majority' | 'controversial' {
  const counts = [
    { name: 'unanimous' as const, count: summary.unanimous },
    { name: 'majority' as const, count: summary.majority },
    { name: 'controversial' as const, count: summary.controversial },
  ]
  // Sort by count desc; on tie, prefer the higher-confidence outcome
  // (unanimous beats majority beats controversial, which is the
  // declaration order above — stable sort preserves it on ties).
  counts.sort((a, b) => b.count - a.count)
  return counts[0]!.name
}

function critiqueCoarseKey(c: Critique): string {
  // Prefer affected_mapping_index when present; otherwise affected_target_field.
  // Both populated → use index (more specific). Neither populated → fall back
  // to category + first-32-chars-of-description (shouldn't happen given the
  // tool schema's required fields but defensive).
  if (c.affected_mapping_index !== undefined) return `${c.category}||idx:${c.affected_mapping_index}`
  if (c.affected_target_field !== undefined) return `${c.category}||tgt:${c.affected_target_field}`
  return `${c.category}||desc:${c.description.slice(0, 32)}`
}

/**
 * Token-set Jaccard similarity. Lowercased, split on whitespace +
 * non-word chars, stop-words ignored. Used to detect "same critique
 * with slightly different wording" across the 3 critic votes.
 *
 * Pure function. Exported for unit testing.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'this', 'that', 'will'])
    const tokens = s
      .toLowerCase()
      .split(/[\s\W_]+/g)
      .filter((t) => t.length >= 2 && !stopWords.has(t))
    return new Set(tokens)
  }
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.size === 0 && B.size === 0) return 1
  if (A.size === 0 || B.size === 0) return 0
  let intersect = 0
  for (const t of A) if (B.has(t)) intersect++
  const union = A.size + B.size - intersect
  return intersect / union
}

// ─── Telemetry — SELECT-poll-then-UPDATE on llm_calls.metadata ──────────────

/**
 * Apply post-aggregation `vote_outcome` to the per-vote `llm_calls`
 * rows for one voted-agent stage (Generator or Critic).
 *
 * Implementation notes:
 *   - Polls SELECT id with backoff [100ms, 200ms, 500ms, 1s, 2s] until
 *     `expectedCount` rows materialize OR the 5s budget is exhausted.
 *     Necessary because callLLM's `writeLogAsync` is fire-and-forget;
 *     the row may not be committed by the time aggregation finishes
 *     on a fast pair.
 *   - Filters by `metadata->>'vote_role'` AND `metadata->>'vote_index'`
 *     IN ('1','2','3') AND `created_at >= sinceIso` to avoid touching
 *     unrelated rows.
 *   - UPDATEs metadata with `jsonb_set(metadata, '{vote_outcome}', ...)`.
 *   - Best-effort: a failed UPDATE logs and continues; vote_outcome
 *     is a downstream-analytics field, not load-bearing for the pipeline.
 *
 * Per Phase A §C5 + OQ9. Exported for unit testing.
 */
export async function applyVoteOutcomeMetadata(args: {
  supabase: SupabaseClient
  projectId: string
  voteRole: 'generator' | 'critic'
  voteOutcome: 'unanimous' | 'majority' | 'controversial'
  sinceIso: string
  expectedCount?: number
}): Promise<void> {
  const expectedCount = args.expectedCount ?? VOTE_COUNT
  const backoffMs = [100, 200, 500, 1000, 2000] // sums to 3.8s; abort budget 5s
  let foundIds: string[] = []
  for (const ms of backoffMs) {
    const { data } = await args.supabase
      .from('llm_calls')
      .select('id')
      .eq('project_id', args.projectId)
      .gte('created_at', args.sinceIso)
      .filter('metadata->>vote_role', 'eq', args.voteRole)
      .filter('metadata->>vote_index', 'in', '("1","2","3")')
      .order('created_at', { ascending: false })
      .limit(expectedCount)
    foundIds = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id)
    if (foundIds.length >= expectedCount) break
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  if (foundIds.length === 0) {
    console.warn(
      `[multi-agent] vote_outcome telemetry: 0 ${args.voteRole} llm_calls rows materialized after 3.8s — skipping UPDATE.`,
    )
    return
  }
  if (foundIds.length < expectedCount) {
    console.warn(
      `[multi-agent] vote_outcome telemetry: only ${foundIds.length}/${expectedCount} ${args.voteRole} rows materialized; updating partial.`,
    )
  }

  // Use the supabase client's RPC-free approach: read-modify-write via
  // an UPDATE on each row's metadata. PostgREST doesn't expose
  // jsonb_set directly, so we fetch metadata then write back the full
  // object. Three rows per voted stage — small payload.
  for (const id of foundIds) {
    const { data } = await args.supabase
      .from('llm_calls')
      .select('metadata')
      .eq('id', id)
      .maybeSingle()
    const metadata =
      ((data as { metadata?: Record<string, unknown> } | null)?.metadata ?? {}) as Record<string, unknown>
    const { error } = await args.supabase
      .from('llm_calls')
      .update({ metadata: { ...metadata, vote_outcome: args.voteOutcome } })
      .eq('id', id)
    if (error) {
      console.warn(
        `[multi-agent] vote_outcome UPDATE failed for ${id}: ${error.message}`,
      )
    }
  }
}

// ─── Specialist resolution merging ──────────────────────────────────────────

interface MergeSpecialistResolutionsArgs {
  aggregated: AggregatedCandidates
  crossTableResolutions: CrossTableResolution[]
  cardinalityResolutions: CardinalityResolution[]
  crossTableInputCandidates: CandidateMapping[]
  cardinalityInputCandidates: CandidateMapping[]
}

/**
 * Merge specialist outputs into the confirmed mapping set.
 *
 * Inputs:
 *   - All Generator candidates (after voting): unanimous + majority.
 *   - Cross-Table resolutions: confirm/reject + join_spec.
 *   - Cardinality resolutions: final cardinality + transformation_pattern.
 *
 * Output: confirmed CandidateMapping[] ready for the Critic stage. Rules:
 *   - one_to_one Generator candidates pass through untouched.
 *   - cross_table Generator candidates are KEPT iff Cross-Table confirmed
 *     them; rejected ones are dropped.
 *   - many_to_one / one_to_many Generator candidates have their tag
 *     overwritten by Cardinality's final_cardinality.
 *   - uncertain Generator candidates are RESOLVED by whichever specialist
 *     processed them (Cross-Table OR Cardinality). When both processed,
 *     Cross-Table's confirm/reject takes precedence; Cardinality refines.
 *   - When NEITHER specialist resolves an uncertain candidate (specialist
 *     aborted), the candidate is kept with tag='uncertain' so the Critic
 *     can flag it.
 */
function mergeSpecialistResolutions(args: MergeSpecialistResolutionsArgs): CandidateMapping[] {
  const allGeneratorCandidates: CandidateMapping[] = [
    ...args.aggregated.unanimous,
    ...args.aggregated.majority,
  ]

  // Index resolutions by candidate_index → input candidate.
  const crossTableByCandidate = new Map<CandidateMapping, CrossTableResolution>()
  for (const r of args.crossTableResolutions) {
    const c = args.crossTableInputCandidates[r.candidate_index]
    if (c) crossTableByCandidate.set(c, r)
  }
  const cardinalityByCandidate = new Map<CandidateMapping, CardinalityResolution>()
  for (const r of args.cardinalityResolutions) {
    const c = args.cardinalityInputCandidates[r.candidate_index]
    if (c) cardinalityByCandidate.set(c, r)
  }

  const confirmed: CandidateMapping[] = []
  for (const c of allGeneratorCandidates) {
    const ctRes = crossTableByCandidate.get(c)
    const cardRes = cardinalityByCandidate.get(c)

    // Cross-Table reject takes precedence — drop the candidate.
    if (ctRes?.decision === 'reject') {
      continue
    }

    // Cross-Table confirm: keep with tag='cross_table' + populate
    // join_spec context (folded into reasoning for now; commit 3 may
    // add a structured field to CandidateMapping).
    if (ctRes?.decision === 'confirm') {
      confirmed.push({
        ...c,
        tag: 'cross_table',
        reasoning: `${c.reasoning} [cross-table confirmed: ${ctRes.join_spec?.join_path ?? 'no join_spec'}]`,
      })
      continue
    }

    // Cardinality resolution: overwrite tag with final_cardinality.
    if (cardRes) {
      confirmed.push({
        ...c,
        tag: cardRes.final_cardinality,
        ...(cardRes.contributing_fields ? { contributing_source_fields: cardRes.contributing_fields } : {}),
      })
      continue
    }

    // No specialist resolution — pass through unchanged.
    confirmed.push(c)
  }

  return confirmed
}

// ─── Refinement helpers ─────────────────────────────────────────────────────

interface BuildRefinementUserMessageArgs {
  baseUserMessage: string
  confirmedMappings: CandidateMapping[]
  aggregatedCritiques: AggregatedCritiques
}

/**
 * Construct the user message for the Generator's refinement call (T3).
 * Uses the same `baseUserMessage` as the Generator stage but APPENDS
 * the confirmed mappings + critique payload organized by confidence.
 *
 * The refinement step calls runAgentLoop with the legacy
 * MAPPING_GENERATION_AGENT_SYSTEM_PROMPT (PR 3.4a) and the existing
 * EMIT_TABLE_MAPPINGS_TOOL — final output flows through the unchanged
 * persistence path.
 */
function buildRefinementUserMessage(args: BuildRefinementUserMessageArgs): string {
  const { baseUserMessage, confirmedMappings, aggregatedCritiques } = args
  const confirmedBlock = `\n<pipeline_confirmed_mappings>\n${JSON.stringify(confirmedMappings, null, 2)}\n</pipeline_confirmed_mappings>\n`

  const highBlock = aggregatedCritiques.high_confidence.length > 0
    ? `\n<high_confidence_critiques>\nThe critic agent flagged these issues with HIGH confidence (3/3 unanimous votes). Refinement MUST address each one.\n${JSON.stringify(aggregatedCritiques.high_confidence, null, 2)}\n</high_confidence_critiques>\n`
    : ''

  const mediumBlock = aggregatedCritiques.medium_confidence.length > 0
    ? `\n<medium_confidence_critiques>\nThe critic agent flagged these issues with MEDIUM confidence (2/3 majority votes). Refinement SHOULD address each one.\n${JSON.stringify(aggregatedCritiques.medium_confidence, null, 2)}\n</medium_confidence_critiques>\n`
    : ''

  const lowBlock = aggregatedCritiques.low_confidence.length > 0
    ? `\n<low_confidence_critiques>\nThe critic agent had 1/1/1 disagreement on these issues — they MAY flag real problems but use your judgment. Each entry is the full set of three differing critiques for that issue.\n${JSON.stringify(aggregatedCritiques.low_confidence, null, 2)}\n</low_confidence_critiques>\n`
    : ''

  const instructions = `\nProduce the FINAL set of source-to-target mappings via emit_table_mappings. Address the high-confidence critiques. Address the medium-confidence critiques unless you have specific reason to reject them. The low-confidence critiques are advisory — incorporate when they reveal a real issue, ignore when they are speculative.\n\nThe pipeline_confirmed_mappings above is your starting point. Output the FINAL shape (table_mappings → field_mappings) — this is what gets persisted.\n`

  return baseUserMessage + confirmedBlock + highBlock + mediumBlock + lowBlock + instructions
}

/**
 * Adapter for the refinement call's AgentLoopResult.kind === 'final'
 * → CallLLMResult shape. Mirrors `synthesizeToolUseResult` from
 * mapping-engine.ts but local to this module to avoid the circular
 * import (mapping-engine imports from this module via the gate
 * refactor in commit 2 step 4).
 */
function synthesizeRefinementResult(
  result: AgentLoopResult & { kind: 'final' },
): CallLLMResult {
  const callId = result.callIds[result.callIds.length - 1] ?? ''
  return {
    kind: 'toolUse',
    toolUse: {
      name: result.finalToolUse.name,
      input: result.finalToolUse.input,
    },
    callId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: result.totalCostUsd,
    anthropicRequestId: null,
  }
}

// Use callLLM in a way that prevents tree-shaking from dropping the
// import; the refinement could fall back to single-shot in commit 3.
// (No-op in commit 2; reference exists so the import isn't flagged
// as unused under strict TS settings.)
void callLLM
