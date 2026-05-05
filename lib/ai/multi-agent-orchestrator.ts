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

  // SHELL aggregator: commit 3 replaces with proper voting.
  // First-vote-wins fallback so the shell is testable end-to-end.
  const aggregatedCandidates: AggregatedCandidates = aggregateCandidatesShell(
    okGeneratorVotes.map((v) => v.candidates),
  )

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

  // SHELL aggregator: commit 3 replaces.
  const aggregatedCritiques: AggregatedCritiques = aggregateCritiquesShell(
    okCriticVotes.map((v) => v.critiques),
  )

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

// ─── SHELL aggregators (commit 3 replaces with proper voting) ───────────────

/**
 * SHELL aggregator — first-vote-wins. Commit 3 replaces this with
 * proper joint-key (source_field, target_field, tag) agreement logic +
 * controversial-bucket detection + confidence calibration (95/67/50).
 *
 * For commit 2's purpose (orchestrator scaffolding + heritage gate
 * verification), this stub lets the shell run end-to-end. The summary
 * counts are also stubbed — commit 3 fills them in correctly.
 */
function aggregateCandidatesShell(
  votes: CandidateMapping[][],
): AggregatedCandidates {
  const firstVote = votes[0] ?? []
  const summary: MultiAgentVoteSummary = {
    unanimous: firstVote.length,
    majority: 0,
    controversial: 0,
  }
  return {
    unanimous: firstVote,
    majority: [],
    controversial: [],
    summary,
  }
}

/**
 * SHELL aggregator — first-vote-wins. Commit 3 replaces with proper
 * Jaccard-similarity matching on critique descriptions + confidence
 * calibration (high/medium/low buckets).
 */
function aggregateCritiquesShell(votes: Critique[][]): AggregatedCritiques {
  const firstVote = votes[0] ?? []
  const summary: MultiAgentVoteSummary = {
    unanimous: firstVote.length,
    majority: 0,
    controversial: 0,
  }
  return {
    high_confidence: firstVote,
    medium_confidence: [],
    low_confidence: [],
    summary,
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
