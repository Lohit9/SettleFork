/**
 * Unified Anthropic API wrapper with built-in observability.
 *
 * Replaces direct `callClaude` / `callClaudeStreaming` invocations
 * (still in `lib/ai/claude.ts`) for callsites that have been migrated
 * to log every call to the `llm_calls` table (PR 6: cluster 1; PR 7:
 * remaining 20 callsites).
 *
 * Logging philosophy: fire-and-forget. Mirrors `lib/actions/activity-log.ts`
 * — log-write failure NEVER blocks the AI call. The user sees their
 * AI feature work even if the `llm_calls` table is unreachable.
 *
 * No `'use server'` directive — this module is below the action layer
 * and exports both async functions and types.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import { randomUUID, createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeCostUsd } from '@/lib/ai/pricing'

// ─── Feature taxonomy (locked enum; matches Phase 0b investigation §1) ────────

export type LLMFeature =
  // Cluster 1 — PR 6
  | 'mapping_generate' // ID 1: engine primary
  | 'mapping_generate_repair' // ID 2: engine JSON-repair retry
  | 'mapping_generate_legacy_pair' // ID 3: legacy regenerate primary
  | 'mapping_generate_legacy_pair_repair' // ID 4: legacy regenerate JSON-repair retry
  | 'mapping_suggest' // ID 5: per-target suggest
  // Cluster 2+ — PR 7
  | 'mapping_suggest_legacy_bulk'
  | 'transform_generate'
  | 'transform_describe'
  | 'outputs_execution_package_monolithic'
  | 'outputs_execution_package_compartmentalized'
  | 'outputs_execution_package_fallback'
  | 'nl_to_sql'
  | 'nl_to_sql_retry'
  | 'nl_suggest_queries'
  | 'outputs_readiness_report'
  | 'outputs_migration_runbook'
  | 'schema_enrichment'
  | 'schema_merge_ai_match'
  | 'migration_intelligence'
  | 'manual_fix'
  | 'validation_rule_from_nl'
  | 'quality_detection_ai'
  | 'ddl_parsing'
  | 'ddl_conversion'
  | 'quality_fix_options'

// ─── Public option + result shapes ────────────────────────────────────────────

export interface CallLLMOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  projectId: string
  userId: string
  /** Defaults to `claude-sonnet-4-20250514` (matches `lib/ai/claude.ts`). */
  model?: string
  /** Defaults to 4096 (single-shot) or 32000 (streaming). */
  maxTokens?: number
  /** Free-form short tag (e.g. 'mapping-v1'). Aids prompt-evolution analysis. */
  promptVersion?: string
  /** Self-FK for retry/fallback chains. */
  parentCallId?: string
  /** Pass-through to Anthropic API `metadata.user_id` for abuse correlation. */
  abuseUserId?: string
  /** Arbitrary structured context. Stored as `llm_calls.metadata` JSONB. */
  metadata?: Record<string, unknown>
}

export interface CallLLMResult {
  text: string
  /** PK of the inserted llm_calls row — caller stores for `parentCallId` chaining. */
  callId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
  anthropicRequestId: string | null
}

// ─── Module-private constants + singletons ────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_STREAMING_MAX_TOKENS = 32000
const ERROR_MESSAGE_MAX_CHARS = 1000

// CRITICAL: This file is server-side only. Never import in client components.
// `lib/ai/claude.ts` instantiates Anthropic too — both will share env-var
// state but each has its own client instance. Acceptable; both modules are
// server-only and the singleton overhead is negligible.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

function shortHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
}

// ─── Error classification ─────────────────────────────────────────────────────

type ErrorType =
  | 'auth_401'
  | 'rate_limit_429'
  | 'sdk_network'
  | 'timeout'
  | 'parse_no_text_block'
  | 'other'

function classifyError(err: unknown): ErrorType {
  if (err instanceof AuthenticationError) return 'auth_401'
  if (err instanceof RateLimitError) return 'rate_limit_429'
  if (err instanceof APIConnectionTimeoutError) return 'timeout'
  if (err instanceof APIConnectionError) return 'sdk_network'
  if (err instanceof Error) {
    if (err.message === 'No text response from Claude') return 'parse_no_text_block'
    if (/timeout/i.test(err.message)) return 'timeout'
  }
  return 'other'
}

// ─── Async log-write (fire-and-forget) ────────────────────────────────────────
//
// Mirrors lib/actions/activity-log.ts:92-111 — never throws to the caller.
// Errors are caught and `console.error`-ed. The AI call's success/failure is
// independent of the log write's success/failure.

interface LlmCallRow {
  id: string
  project_id: string
  user_id: string
  feature: LLMFeature
  prompt_version: string | null
  model: string
  is_streaming: boolean
  max_tokens: number
  system_prompt: string
  user_message: string
  response_text: string | null
  system_prompt_hash: string
  user_message_hash: string
  anthropic_request_id: string | null
  stop_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  latency_ms: number
  cost_usd: number | null
  succeeded: boolean
  error_type: string | null
  error_message: string | null
  parent_call_id: string | null
  abuse_user_id: string | null
  metadata: Record<string, unknown>
}

async function writeLogAsync(row: LlmCallRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('llm_calls').insert(row)
    if (error) {
      console.error(
        `[llm-client] log write failed for call_id=${row.id} feature=${row.feature}: ${error.message}`,
      )
    }
  } catch (err) {
    console.error(
      `[llm-client] log write threw for call_id=${row.id} feature=${row.feature}:`,
      err,
    )
  }
}

// Builds the immutable parts of the log row (everything known before the
// SDK call) so that both success and error paths share the same base.
function buildBaseRow(
  callId: string,
  opts: CallLLMOptions,
  model: string,
  maxTokens: number,
  isStreaming: boolean,
): Pick<
  LlmCallRow,
  | 'id'
  | 'project_id'
  | 'user_id'
  | 'feature'
  | 'prompt_version'
  | 'model'
  | 'is_streaming'
  | 'max_tokens'
  | 'system_prompt'
  | 'user_message'
  | 'system_prompt_hash'
  | 'user_message_hash'
  | 'parent_call_id'
  | 'abuse_user_id'
  | 'metadata'
> {
  return {
    id: callId,
    project_id: opts.projectId,
    user_id: opts.userId,
    feature: opts.feature,
    prompt_version: opts.promptVersion ?? null,
    model,
    is_streaming: isStreaming,
    max_tokens: maxTokens,
    system_prompt: opts.systemPrompt,
    user_message: opts.userMessage,
    system_prompt_hash: shortHash(opts.systemPrompt),
    user_message_hash: shortHash(opts.userMessage),
    parent_call_id: opts.parentCallId ?? null,
    abuse_user_id: opts.abuseUserId ?? null,
    metadata: opts.metadata ?? {},
  }
}

// ─── Single-shot wrapper ──────────────────────────────────────────────────────

export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResult> {
  const callId = randomUUID()
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const startedAt = Date.now()
  const baseRow = buildBaseRow(callId, opts, model, maxTokens, false)

  try {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userMessage }],
    }
    if (opts.abuseUserId) {
      request.metadata = { user_id: opts.abuseUserId }
    }

    const response = await anthropic.messages.create(request)

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude')
    }

    const usage = {
      input_tokens: response.usage.input_tokens ?? 0,
      output_tokens: response.usage.output_tokens ?? 0,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
    }
    const costUsd = computeCostUsd(model, usage)
    const latencyMs = Date.now() - startedAt

    void writeLogAsync({
      ...baseRow,
      response_text: textBlock.text,
      anthropic_request_id: response.id ?? null,
      stop_reason: response.stop_reason ?? null,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      latency_ms: latencyMs,
      cost_usd: costUsd,
      succeeded: true,
      error_type: null,
      error_message: null,
    })

    return {
      text: textBlock.text,
      callId,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheCreationTokens: usage.cache_creation_tokens,
      costUsd,
      anthropicRequestId: response.id ?? null,
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const errorType = classifyError(err)
    const errorMessage =
      err instanceof Error
        ? err.message.slice(0, ERROR_MESSAGE_MAX_CHARS)
        : String(err).slice(0, ERROR_MESSAGE_MAX_CHARS)

    void writeLogAsync({
      ...baseRow,
      response_text: null,
      anthropic_request_id: null,
      stop_reason: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      latency_ms: latencyMs,
      cost_usd: null,
      succeeded: false,
      error_type: errorType,
      error_message: errorMessage,
    })

    throw err
  }
}

// ─── Streaming wrapper ────────────────────────────────────────────────────────

export async function callLLMStreaming(
  opts: CallLLMOptions,
): Promise<CallLLMResult> {
  const callId = randomUUID()
  const model = opts.model ?? DEFAULT_MODEL
  const maxTokens = opts.maxTokens ?? DEFAULT_STREAMING_MAX_TOKENS
  const startedAt = Date.now()
  const baseRow = buildBaseRow(callId, opts, model, maxTokens, true)

  try {
    const request: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userMessage }],
      stream: true,
    }
    if (opts.abuseUserId) {
      request.metadata = { user_id: opts.abuseUserId }
    }

    const stream = await anthropic.messages.stream(request)
    const message = await stream.finalMessage()

    const textBlock = message.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude')
    }

    const usage = {
      input_tokens: message.usage.input_tokens ?? 0,
      output_tokens: message.usage.output_tokens ?? 0,
      cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: message.usage.cache_creation_input_tokens ?? 0,
    }
    const costUsd = computeCostUsd(model, usage)
    const latencyMs = Date.now() - startedAt

    void writeLogAsync({
      ...baseRow,
      response_text: textBlock.text,
      anthropic_request_id: message.id ?? null,
      stop_reason: message.stop_reason ?? null,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      latency_ms: latencyMs,
      cost_usd: costUsd,
      succeeded: true,
      error_type: null,
      error_message: null,
    })

    return {
      text: textBlock.text,
      callId,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_tokens,
      cacheCreationTokens: usage.cache_creation_tokens,
      costUsd,
      anthropicRequestId: message.id ?? null,
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const errorType = classifyError(err)
    const errorMessage =
      err instanceof Error
        ? err.message.slice(0, ERROR_MESSAGE_MAX_CHARS)
        : String(err).slice(0, ERROR_MESSAGE_MAX_CHARS)

    void writeLogAsync({
      ...baseRow,
      response_text: null,
      anthropic_request_id: null,
      stop_reason: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      latency_ms: latencyMs,
      cost_usd: null,
      succeeded: false,
      error_type: errorType,
      error_message: errorMessage,
    })

    throw err
  }
}
