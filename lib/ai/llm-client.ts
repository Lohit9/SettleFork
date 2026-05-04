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
import type { TextBlockParam, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
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
  // Phase 1 — eval harness (PR 10+).
  // Production AI entry points may receive a feature override at the
  // edge so that calls originating from the eval runner write to
  // llm_calls with an eval_* feature, keeping production cost reports
  // clean. PR 10.1 adds the enum values; PR 10.4 wires the override.
  | 'eval_mapping'
  | 'eval_validation_rule'
  | 'eval_mapping_suggestion' // wired in Path 2 PR 1
  | 'eval_quality_issues' // reserved — wired in Path 2 PR 2 B-2
  | 'eval_extracted_patterns' // reserved — wired in Path 2 PR 2 B-2
  | 'eval_fix_options' // reserved — wired in Path 2 PR 2 B-2
  | 'eval_transform' // reserved — wired in PR 11
  | 'eval_nl_to_sql' // reserved — wired in PR 11

// ─── Public option + result shapes ────────────────────────────────────────────

export interface CallLLMOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  projectId: string
  userId: string
  /**
   * Defaults to `claude-sonnet-4-6` (or `claude-opus-4-7` when
   * `AI_PHASE_2_ENABLED=1`). Override per-call to use a different
   * model for cost-sensitive features.
   *
   * The reference to `lib/ai/claude.ts` from a prior version of this
   * comment is stale; that file was deleted in PR 7.
   */
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
  /**
   * PR 12: optional tool definition. When provided, the request includes
   * this as the only available tool and `tool_choice` forces the model
   * to call it. The response shape becomes
   * `{ kind: 'toolUse', toolUse: { name, input } }` — the `input` has
   * already been schema-validated by Anthropic's API, so callers do not
   * need to JSON-parse or fence-strip prose output.
   *
   * When omitted, the request is text-only (legacy behavior). The
   * response shape is `{ kind: 'text', text }`.
   *
   * Settle's convention: every PR 12 callsite passes EXACTLY ONE tool.
   * Multi-tool flows are reserved for Phase 3+ agentic features.
   *
   * The single-tool + forced-`tool_choice` posture is also why callers
   * never need to inspect the returned `toolUse.name` — it can only be
   * the tool we passed in.
   */
  tool?: Tool
  /**
   * PR 13.1: opt into Anthropic prompt caching. When true, sets
   * `cache_control: { type: 'ephemeral' }` on the system prompt
   * (transformed into content-block array form) and on the tool
   * definition (when present). Cache reads/writes are recorded
   * automatically via the existing `cache_read_tokens` /
   * `cache_creation_tokens` columns in `llm_calls`.
   *
   * Defaults to false. Enable per-callsite based on the cache-fit
   * audit (docs/investigations/pr13-prompt-caching.md §3). Anthropic's
   * 5-minute ephemeral TTL means caching only pays off for features
   * with invocation locality within that window — break-even is at a
   * 25% read-to-write hit rate (cache writes cost 1.25× input;
   * reads cost 0.10×).
   *
   * Editing the system prompt or tool schema for a cached feature
   * forces a cache rewrite on the next deploy — expect a 1-day cost
   * spike that recovers as cache rewarms.
   */
  cacheControl?: boolean
  /**
   * PR 3.2: optional multi-tool registration for agent-loop callsites.
   * When provided (non-empty array), the request includes ALL listed
   * tools and `tool_choice: { type: 'auto' }` — the model picks which
   * tool to invoke per iteration, OR emits a text response.
   *
   * Mutually exclusive with `tool` (singular). The wrapper throws if
   * both are set — a single call cannot mix forced-by-name and auto
   * choice.
   *
   * Single-tool callsites (PR 12.x cohort) continue to use the
   * existing `tool?: Tool` field with forced-by-name `tool_choice` —
   * byte-identical to today.
   *
   * Cache control: when `cacheControl: true`, every tool in the array
   * gets `cache_control: { type: 'ephemeral' }` applied via
   * `applyToolCache`.
   */
  tools?: Tool[]
}

interface CallLLMResultCommon {
  /** PK of the inserted llm_calls row — caller stores for `parentCallId` chaining. */
  callId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
  anthropicRequestId: string | null
}

/**
 * Discriminated-union return type. The `kind` discriminator is the
 * forcing function for the PR 12 migration: callers that want the raw
 * text must explicitly check `result.kind === 'text'`; callers that
 * want the schema-validated tool input must check
 * `result.kind === 'toolUse'`. The compiler walks every callsite the
 * first time the union is introduced; that is intentional.
 *
 * Flag-conditional callsites (PR 12 H1 design) use the form:
 *
 *   const tool = phase2Enabled ? EMIT_X_TOOL : undefined
 *   const result = await callLLM({ ..., tool })
 *   if (result.kind === 'toolUse') {
 *     parsed = result.toolUse.input as Shape
 *   } else {
 *     // legacy JSON.parse path preserved for flag-OFF
 *     parsed = JSON.parse(result.text)
 *   }
 */
export type CallLLMResult =
  | (CallLLMResultCommon & { kind: 'text'; text: string })
  | (CallLLMResultCommon & {
      kind: 'toolUse'
      toolUse: { name: string; input: Record<string, unknown> }
    })

// ─── Module-private constants + singletons ────────────────────────────────────

const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_STREAMING_MAX_TOKENS = 32000
const ERROR_MESSAGE_MAX_CHARS = 1000

// ─── Phase 2 model + effort resolution (PR 11) ────────────────────────────────

/**
 * Resolves the default model to use for a callLLM/callLLMStreaming call,
 * honoring the AI_PHASE_2_ENABLED feature flag.
 *
 *   AI_PHASE_2_ENABLED=1 → 'claude-opus-4-7'  (Phase 2 quality upgrade)
 *   else                 → 'claude-sonnet-4-6' (current Sonnet, off the
 *                          'claude-sonnet-4-20250514' deprecation track
 *                          that retires 2026-06-15)
 *
 * Read per-request, not at module load, so the flag can be flipped
 * without redeploying.
 *
 * Per-call overrides via opts.model take precedence over this default.
 */
export function resolveDefaultModel(): string {
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  return phase2Enabled ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
}

/**
 * Features that opt OUT of effort='high' when AI_PHASE_2_ENABLED=1.
 *
 * Default behavior under Phase 2 is effort='high' for all reasoning +
 * synthesis tasks. The exception list captures features that produce
 * purely documentary output where extended thinking adds latency
 * without quality gain.
 *
 * Adding a new LLMFeature: assume it should NOT be on this list (i.e.,
 * it gets effort='high' by default). Only add a feature here if its
 * output is genuinely documentary, not synthesis or reasoning.
 */
const LOW_EFFORT_FEATURES: ReadonlySet<LLMFeature> = new Set<LLMFeature>([
  'transform_describe', // narrates an existing transform; no synthesis
  'nl_suggest_queries', // generates starter query suggestions
])

/**
 * Resolves the `effort` parameter to send on the Anthropic API call,
 * honoring AI_PHASE_2_ENABLED + the LOW_EFFORT_FEATURES exception list.
 *
 * Returns:
 *   'high'    when flag is ON and the feature is NOT in the low-effort list
 *   undefined when flag is OFF (preserves Sonnet 4.6 default behavior)
 *   undefined when the feature IS in the low-effort list (uses Anthropic's
 *             default effort for that model)
 *
 * Read per-request to support flag flipping without redeploy.
 */
export function resolveEffort(feature: LLMFeature): 'high' | undefined {
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  if (!phase2Enabled) return undefined
  if (LOW_EFFORT_FEATURES.has(feature)) return undefined
  return 'high'
}

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

// ─── Prompt-caching helpers (PR 13.1) ─────────────────────────────────────────

/**
 * Build the `system` parameter for an Anthropic request.
 *
 *   cacheControl=false (default) → returns the prompt as a plain string,
 *     byte-identical to the pre-PR-13.1 wrapper output.
 *   cacheControl=true            → returns a single TextBlockParam content
 *     block carrying `cache_control: { type: 'ephemeral' }`. Anthropic
 *     caches the prefix up to (and including) this block.
 *
 * Pure function — no I/O, no env reads. Exported for unit testing.
 */
export function buildSystemParam(
  systemPrompt: string,
  cacheControl: boolean | undefined,
): string | TextBlockParam[] {
  if (!cacheControl) return systemPrompt
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ]
}

/**
 * Apply prompt-caching to a Tool definition.
 *
 *   cacheControl=false (default) → returns the tool object unchanged.
 *   cacheControl=true            → returns a shallow copy with
 *     `cache_control: { type: 'ephemeral' }` attached. Anthropic caches
 *     the tool definition (description + input_schema).
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function applyToolCache(
  tool: Tool,
  cacheControl: boolean | undefined,
): Tool {
  if (!cacheControl) return tool
  return { ...tool, cache_control: { type: 'ephemeral' } }
}

// ─── Multi-tool resolution helpers (PR 3.2) ──────────────────────────────────

/**
 * Resolve the `tools` array to send to Anthropic, applying optional
 * cache_control to each entry. Throws on mutual exclusivity violation.
 *
 *   neither tool nor tools set → returns undefined (no tools block sent)
 *   tool set (single-tool legacy) → returns [applyToolCache(tool, ...)]
 *   tools set (multi-tool, PR 3.2 agent-loop) → returns tools.map(applyToolCache)
 *   BOTH set → throws (a single call cannot mix forced + auto tool_choice)
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function resolveToolsParam(
  tool: Tool | undefined,
  tools: Tool[] | undefined,
  cacheControl: boolean | undefined,
): Tool[] | undefined {
  if (tool && tools && tools.length > 0) {
    throw new Error(
      'callLLM: opts.tool and opts.tools are mutually exclusive — a single call cannot mix forced-by-name and auto tool_choice',
    )
  }
  if (tool) return [applyToolCache(tool, cacheControl)]
  if (tools && tools.length > 0) return tools.map((t) => applyToolCache(t, cacheControl))
  return undefined
}

/**
 * Resolve the `tool_choice` field for an Anthropic request based on
 * which tool surface (single vs multi) is in use.
 *
 *   neither tool nor tools set → returns undefined (no tool_choice sent)
 *   tool set (single, legacy)  → forced-by-name (byte-identical to today)
 *   tools set (multi, PR 3.2)  → { type: 'auto' } per LOCK #2
 *
 * `disable_parallel_tool_use: true` is set in BOTH single and multi
 * cases — Settle's convention is one tool per call. The agent-loop
 * primitive iterates serially; multi-tool here just means the MODEL
 * chooses which one to invoke per iteration, not that multiple tools
 * are dispatched in parallel.
 *
 * Pure function — no I/O. Exported for unit testing.
 */
export function resolveToolChoice(
  tool: Tool | undefined,
  tools: Tool[] | undefined,
):
  | { type: 'tool'; name: string; disable_parallel_tool_use: true }
  | { type: 'auto'; disable_parallel_tool_use: true }
  | undefined {
  if (tool && tools && tools.length > 0) {
    throw new Error(
      'callLLM: opts.tool and opts.tools are mutually exclusive',
    )
  }
  if (tool) {
    return { type: 'tool', name: tool.name, disable_parallel_tool_use: true }
  }
  if (tools && tools.length > 0) {
    return { type: 'auto', disable_parallel_tool_use: true }
  }
  return undefined
}

// ─── Single-shot wrapper ──────────────────────────────────────────────────────

export async function callLLM(opts: CallLLMOptions): Promise<CallLLMResult> {
  const callId = randomUUID()
  const model = opts.model ?? resolveDefaultModel()
  const effort = resolveEffort(opts.feature)
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const startedAt = Date.now()
  const baseRow = buildBaseRow(callId, opts, model, maxTokens, false)

  try {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      // PR 13.1: buildSystemParam returns plain string when
      // cacheControl is unset (byte-identical to pre-13.1 behavior),
      // or a TextBlockParam[] carrying cache_control when set.
      system: buildSystemParam(opts.systemPrompt, opts.cacheControl),
      messages: [{ role: 'user', content: opts.userMessage }],
      // PR 11: include `output_config.effort` only when defined.
      // The Anthropic SDK nests `effort` inside `OutputConfig`
      // (messages.d.ts:704-712); a bare top-level `effort` field is
      // rejected by the API as "Extra inputs are not permitted".
      // When the flag is OFF or the feature is in LOW_EFFORT_FEATURES,
      // no output_config is sent at all (preserves current behavior).
      ...(effort && { output_config: { effort } }),
      // PR 12: include `tools` + `tool_choice` only when a tool surface
      // is registered. `tool_choice` is a top-level request field
      // (NOT nested inside output_config like `effort`); see
      // SDK messages.d.ts:1081-1129 (ToolChoice union).
      // disable_parallel_tool_use=true matches Settle's "exactly one
      // tool per call" convention.
      // PR 13.1: applyToolCache attaches cache_control when
      // opts.cacheControl is set; otherwise the tool is unchanged.
      // PR 3.2: opts.tools (multi-tool) yields tool_choice 'auto';
      // opts.tool (single-tool legacy) yields forced-by-name. Mutually
      // exclusive — resolveToolsParam throws if both set.
      ...((() => {
        const resolvedTools = resolveToolsParam(opts.tool, opts.tools, opts.cacheControl)
        const resolvedChoice = resolveToolChoice(opts.tool, opts.tools)
        return resolvedTools && resolvedChoice
          ? { tools: resolvedTools, tool_choice: resolvedChoice }
          : {}
      })()),
    }
    if (opts.abuseUserId) {
      request.metadata = { user_id: opts.abuseUserId }
    }

    const response = await anthropic.messages.create(request)

    const usage = {
      input_tokens: response.usage.input_tokens ?? 0,
      output_tokens: response.usage.output_tokens ?? 0,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: response.usage.cache_creation_input_tokens ?? 0,
    }
    const costUsd = computeCostUsd(model, usage)
    const latencyMs = Date.now() - startedAt

    // PR 12: branch on whether a tool was forced. When `opts.tool` is
    // set, the response MUST contain a tool_use block matching the
    // forced tool name; otherwise it MUST contain a text block. The
    // §9.1 probe confirmed forced-tool responses do not carry a
    // text block alongside the tool_use; the §9.1 probe also showed
    // that thinking blocks may or may not appear depending on the
    // model's budget decision, so we never assume one is present.
    // PR 3.2: when `opts.tools` (multi) is set, the response MAY
    // contain a tool_use of any registered tool OR a text block (the
    // model decides per `tool_choice: 'auto'`). The wrapper validates
    // tool_use names against the registered set and falls through to
    // the text path when no tool_use is emitted.
    const isSingleTool = !!opts.tool
    const isMultiTool = !!(opts.tools && opts.tools.length > 0)
    if (isSingleTool || isMultiTool) {
      const toolUseBlock = response.content.find(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )
      if (toolUseBlock) {
        if (isSingleTool && toolUseBlock.name !== opts.tool!.name) {
          throw new Error(
            `Expected tool_use response for ${opts.tool!.name}; ` +
              `got blocks: ${response.content.map((b) => b.type).join(', ')}`,
          )
        }
        if (isMultiTool) {
          const allowedNames = new Set(opts.tools!.map((t) => t.name))
          if (!allowedNames.has(toolUseBlock.name)) {
            throw new Error(
              `Unexpected tool_use name "${toolUseBlock.name}"; expected one of: ${[...allowedNames].join(', ')}`,
            )
          }
        }

        // Persist a JSON-serialized form of the tool input as
        // `response_text` so the existing `llm_calls.response_text`
        // surface stays consistent across text- and tool-use calls.
        // Eval/audit consumers continue to read response_text uniformly.
        const responseText = JSON.stringify(toolUseBlock.input)

        void writeLogAsync({
          ...baseRow,
          response_text: responseText,
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
          kind: 'toolUse',
          toolUse: {
            name: toolUseBlock.name,
            input: toolUseBlock.input as Record<string, unknown>,
          },
          callId,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_tokens,
          cacheCreationTokens: usage.cache_creation_tokens,
          costUsd,
          anthropicRequestId: response.id ?? null,
        }
      }
      // No tool_use block:
      if (isSingleTool) {
        // Single-tool with forced choice MUST emit a tool_use; missing
        // one is a contract violation (byte-identical error to pre-3.2).
        throw new Error(
          `Expected tool_use response for ${opts.tool!.name}; ` +
            `got blocks: ${response.content.map((b) => b.type).join(', ')}`,
        )
      }
      // Multi-tool with auto choice: model chose to emit text — fall
      // through to the text path below. Agent-loop callsites treat
      // text responses as "no tool picked this iteration" (schema_error
      // termination per design §A2); other multi-tool callers can
      // handle them however they like.
    }

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude')
    }

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
      kind: 'text',
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
  const model = opts.model ?? resolveDefaultModel()
  const effort = resolveEffort(opts.feature)
  const maxTokens = opts.maxTokens ?? DEFAULT_STREAMING_MAX_TOKENS
  const startedAt = Date.now()
  const baseRow = buildBaseRow(callId, opts, model, maxTokens, true)

  try {
    const request: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      // PR 13.1: same buildSystemParam helper as callLLM. Streaming +
      // prompt caching is supported identically — cache_control is a
      // request-side marker and unaffected by streaming mode.
      system: buildSystemParam(opts.systemPrompt, opts.cacheControl),
      messages: [{ role: 'user', content: opts.userMessage }],
      stream: true,
      // PR 12 follow-up to PR 11: nest `effort` under `output_config`,
      // mirroring callLLM's correct placement at the non-streaming
      // wrapper. PR 11 fixed this in callLLM but missed the streaming
      // path; the §9.1 probe confirmed `output_config: { effort }` is
      // also the correct shape for streaming requests. Without this
      // fix, any streaming callsite (currently only
      // `outputs_execution_package_compartmentalized`) would 400 with
      // "Extra inputs are not permitted" the moment
      // AI_PHASE_2_ENABLED=1 puts that feature on effort='high'.
      ...(effort && { output_config: { effort } }),
      // PR 12: same tool plumbing as callLLM. Streaming + tool_use is
      // supported on SDK 0.78.0; `stream.finalMessage()` returns a
      // fully-assembled message whose `content` array contains the
      // tool_use block. The §9.1 probe verified this end-to-end.
      // PR 13.1: applyToolCache attaches cache_control when
      // opts.cacheControl is set; otherwise the tool is unchanged.
      // PR 3.2: opts.tools (multi-tool) yields tool_choice 'auto'; see
      // resolveToolsParam / resolveToolChoice helpers above.
      ...((() => {
        const resolvedTools = resolveToolsParam(opts.tool, opts.tools, opts.cacheControl)
        const resolvedChoice = resolveToolChoice(opts.tool, opts.tools)
        return resolvedTools && resolvedChoice
          ? { tools: resolvedTools, tool_choice: resolvedChoice }
          : {}
      })()),
    }
    if (opts.abuseUserId) {
      request.metadata = { user_id: opts.abuseUserId }
    }

    const stream = await anthropic.messages.stream(request)
    const message = await stream.finalMessage()

    const usage = {
      input_tokens: message.usage.input_tokens ?? 0,
      output_tokens: message.usage.output_tokens ?? 0,
      cache_read_tokens: message.usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: message.usage.cache_creation_input_tokens ?? 0,
    }
    const costUsd = computeCostUsd(model, usage)
    const latencyMs = Date.now() - startedAt

    // PR 3.2: same single-vs-multi-tool branching as callLLM. See the
    // comment block above the analogous branch in the non-streaming
    // wrapper for full design notes.
    const isSingleToolStream = !!opts.tool
    const isMultiToolStream = !!(opts.tools && opts.tools.length > 0)
    if (isSingleToolStream || isMultiToolStream) {
      const toolUseBlock = message.content.find(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      )
      if (toolUseBlock) {
        if (isSingleToolStream && toolUseBlock.name !== opts.tool!.name) {
          throw new Error(
            `Expected tool_use response for ${opts.tool!.name}; ` +
              `got blocks: ${message.content.map((b) => b.type).join(', ')}`,
          )
        }
        if (isMultiToolStream) {
          const allowedNames = new Set(opts.tools!.map((t) => t.name))
          if (!allowedNames.has(toolUseBlock.name)) {
            throw new Error(
              `Unexpected tool_use name "${toolUseBlock.name}"; expected one of: ${[...allowedNames].join(', ')}`,
            )
          }
        }

        const responseText = JSON.stringify(toolUseBlock.input)

        void writeLogAsync({
          ...baseRow,
          response_text: responseText,
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
          kind: 'toolUse',
          toolUse: {
            name: toolUseBlock.name,
            input: toolUseBlock.input as Record<string, unknown>,
          },
          callId,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_tokens,
          cacheCreationTokens: usage.cache_creation_tokens,
          costUsd,
          anthropicRequestId: message.id ?? null,
        }
      }
      // No tool_use block:
      if (isSingleToolStream) {
        throw new Error(
          `Expected tool_use response for ${opts.tool!.name}; ` +
            `got blocks: ${message.content.map((b) => b.type).join(', ')}`,
        )
      }
      // Multi-tool with auto choice: fall through to text path.
    }

    const textBlock = message.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from Claude')
    }

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
      kind: 'text',
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
