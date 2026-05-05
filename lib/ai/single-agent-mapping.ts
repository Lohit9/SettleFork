/**
 * PR 3.4cd commit 2 — Extracted single-agent mapping loop.
 *
 * Pulls the inline PR 3.4b agent body out of both production callsites
 * (`runMappingGeneration` BULK + `runMappingGenerationForPair` single-pair)
 * into a shared helper. Behavior is byte-equivalent to the inline 3.4b
 * code: same agent invocation args, same schema_error → fallback chain,
 * same metadata shape (with the same `agent_loop: true` and
 * `agent_fallback: true` markers), same systemPrompt selection.
 *
 * Heritage byte-identical (Capture B in the PR 3.4cd Phase A doc):
 * under AI_PHASE_3_ENABLED=1 + AI_PHASE_3_MULTI_AGENT_ENABLED=0, the
 * persisted-row read fingerprint must match the pre-3.4cd baseline.
 * That is asserted by the heritage test on this branch; the only
 * "drift" allowed in this commit is the file location of the body.
 *
 * The two callsites differ in:
 *   - feature taxonomy ('mapping_generate' vs 'mapping_generate_legacy_pair'
 *     plus optional featureOverride for the eval runner)
 *   - per-batch metadata (source_table_id + batch_index for BULK;
 *     source_table_id + target_table_id + table_mapping_id for single-pair)
 *   - cacheControl posture (true on BULK per PR 13.1 cohort; false on
 *     single-pair per PR 3.4b LOCK #4 — the existing audit decision)
 *   - error-handling shape (BULK `continue`s; single-pair `return`s)
 *
 * The helper accepts these as parameters so both callers can dispatch
 * to it without behavioral drift.
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
  QUERY_FIELD_DATA_TOOL,
  COUNT_DISTINCT_PATTERNS_TOOL,
  CROSS_FIELD_CORRELATION_TOOL,
} from '@/lib/ai/tool-schemas'
import {
  MAPPING_GENERATION_AGENT_SYSTEM_PROMPT,
  MAPPING_GENERATION_SYSTEM_PROMPT,
  buildAgentUserMessage,
  synthesizeToolUseResult,
} from '@/lib/ai/mapping-engine'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'

// ─── Public types ────────────────────────────────────────────────────────────

export interface RunSingleAgentMappingLoopArgs {
  supabase: SupabaseClient
  projectId: string
  userId: string
  /** LLMFeature tag for the per-iteration callLLM. Pass through featureOverride if applicable. */
  feature: LLMFeature
  /**
   * The base user message (built from formatSchemaForPrompt + docBlock +
   * intelligenceCtx + optionally otherSourcesBlock by the caller). The
   * helper prepends business_context + schema_overview via
   * `buildAgentUserMessage`.
   */
  baseUserMessage: string
  schemaOverviewBlock: string
  businessContext: string | null
  /** Per-batch token cap (PER_BATCH_MAX_TOKENS = 16000 at both callsites today). */
  maxTokens: number
  /**
   * Per-batch metadata to thread through every llm_calls row. The helper
   * adds `agent_loop: true` for the agent path and `agent_fallback: true`
   * for the schema_error fallback path.
   */
  baseMetadata: Record<string, unknown>
  /**
   * BULK callsite: true (PR 13.1 cohort decision). Single-pair: false
   * (LOCK #4 from PR 3.4b — the existing PR 13.1 audit decision applies).
   */
  cacheControl: boolean
}

/**
 * Discriminated result. The success path returns a `CallLLMResult` shaped
 * identically to today's inline code (kind: 'toolUse' from either the agent's
 * synthesized result OR the schema_error fallback's forced-tool-use callLLM).
 *
 * Failure paths return the original error so the caller can preserve its
 * existing log message + error-return semantics. The two callsites differ
 * in how they react (BULK `continue`s; single-pair `return`s with the
 * error message).
 */
export type SingleAgentResult =
  | { kind: 'ok'; result: CallLLMResult }
  | { kind: 'agent_threw'; error: unknown }
  | { kind: 'fallback_threw'; error: unknown }
  | { kind: 'aborted_other'; reason: string; message: string }

// ─── Public entry ────────────────────────────────────────────────────────────

/**
 * Single-agent mapping loop — Phase 3 single-agent path (PR 3.4b extracted).
 * Used directly when `AI_PHASE_3_MULTI_AGENT_ENABLED=0` (default rollout
 * state) and indirectly as the Generator-refinement step inside the
 * multi-agent orchestrator (PR 3.4cd commit 2+).
 */
export async function runSingleAgentMappingLoop(
  args: RunSingleAgentMappingLoopArgs,
): Promise<SingleAgentResult> {
  const {
    supabase,
    projectId,
    userId,
    feature,
    baseUserMessage,
    schemaOverviewBlock,
    businessContext,
    maxTokens,
    baseMetadata,
    cacheControl,
  } = args

  const agentBatchUserMessage = buildAgentUserMessage({
    baseUserMessage,
    schemaOverview: schemaOverviewBlock,
    businessContext,
  })

  let agentResult: AgentLoopResult
  try {
    agentResult = await runAgentLoop({
      feature,
      systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_AGENT_SYSTEM_PROMPT),
      userMessage: agentBatchUserMessage,
      tools: [
        { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler({ supabase, projectId, userId }) },
        { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler({ supabase, projectId, userId }) },
        { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler({ supabase, projectId, userId }) },
        { tool: EMIT_TABLE_MAPPINGS_TOOL },
      ],
      projectId,
      userId,
      llmOptions: {
        model: 'claude-opus-4-7',
        maxTokens,
        promptVersion: 'mapping-v2-agent',
        ...(cacheControl ? { cacheControl: true } : {}),
        abuseUserId: userId,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        metadata: { ...baseMetadata, agent_loop: true },
      },
    })
  } catch (err) {
    return { kind: 'agent_threw', error: err }
  }

  if (agentResult.kind === 'final') {
    return { kind: 'ok', result: synthesizeToolUseResult(agentResult) }
  }

  if (agentResult.reason === 'schema_error') {
    // LOCK #5 from PR 3.4b: schema_error fallback → single-shot retry with
    // EMIT_TABLE_MAPPINGS_TOOL forced + the legacy system prompt. Other
    // abort reasons hard-fail the batch (caller decides).
    try {
      const fallback = await callLLM({
        feature,
        systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_SYSTEM_PROMPT),
        userMessage: baseUserMessage,
        maxTokens,
        projectId,
        userId,
        promptVersion: 'mapping-v1',
        abuseUserId: userId,
        metadata: { ...baseMetadata, agent_fallback: true },
        tool: EMIT_TABLE_MAPPINGS_TOOL,
        ...(cacheControl ? { cacheControl: true } : {}),
      })
      return { kind: 'ok', result: fallback }
    } catch (err) {
      return { kind: 'fallback_threw', error: err }
    }
  }

  // Other abort reasons: max_iterations, max_cost, max_wall_clock,
  // model_error, tool_error. Caller's log message includes both the
  // reason and the message text from the agent loop.
  return {
    kind: 'aborted_other',
    reason: agentResult.reason,
    message: agentResult.message,
  }
}
