/**
 * Path D — orchestrator (`runPathDMapping`).
 *
 * Wires the foundation from Sub-PR 4a (parser + persistence + experiment-runs
 * helpers + cost-ceiling errors) together with the system prompt from this
 * Sub-PR 4b. Single-call comprehensive Opus 4.7 streaming mapping pipeline.
 *
 * ── Flow ────────────────────────────────────────────────────────────────────
 *   1. Mint runId
 *   2. Fetch project context via `buildAIContext`
 *   3. Build system prompt + user message
 *   4. Pre-call cost gate — predict cost from estimated input tokens + max
 *      output budget; throw `CostCeilingExceededError` if predicted > ceiling
 *   5. Open `anthropic.messages.stream(...)`; iterate events
 *   6. On each text delta: feed `createPathDStreamParser`, accumulate text,
 *      sample mid-stream output-token estimate every N deltas, abort via
 *      `stream.controller.abort()` if cumulative cost exceeds ceiling
 *   7. Finish parser; pass parsed output to `persistPathDOutput`
 *   8. Write `llm_calls` row (fire-and-forget) carrying
 *      `pathDExperimentMetadata(runId)` so `mapping_experiments` view
 *      groups Path D rows
 *   9. Emit one `logAIEdit` row per inserted TFM at the orchestrator
 *      boundary — resolves the `persistMappings` allow-list deferral
 *      from Sub-PR 4a (audit invariant scans this function and finds
 *      `logAIEdit(...)` here)
 *
 * ── Why a Path-D-specific streaming helper instead of `callLLMStreaming` ────
 * The shared streaming wrapper at `lib/ai/llm-client.ts:757` blocks on
 * `await stream.finalMessage()`, which precludes mid-stream cost-ceiling
 * abort. Path D iterates the raw `for await (const event of stream)` so it
 * can read `usage.output_tokens` deltas (and char-based estimates between
 * those events) and call `stream.controller.abort()` when the rolling cost
 * exceeds `PER_PROJECT_MAX_COST_USD`. Cost duplication of ~30 LOC of
 * llm_calls log writing is intentional — Phase C can extract a shared
 * helper if iteration adopts it.
 *
 * ── Cost arithmetic ─────────────────────────────────────────────────────────
 * Opus 4.7 pricing (per `lib/ai/pricing.ts`): $5/M input, $25/M output.
 * Pre-call: predicted = (estInputTokens * 5 + PATH_D_MAX_OUTPUT_TOKENS * 25) / 1_000_000.
 * Mid-stream: rolling = (inputTokens * 5 + estOutputTokens * 25) / 1_000_000,
 * where estOutputTokens = chars / TOKEN_ESTIMATE_CHARS_PER_TOKEN.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID, createHash } from 'node:crypto'

import { supabaseAdmin } from '@/lib/supabase/admin'
import { buildAIContext } from '@/lib/ai/context-builder'
import { computeCostUsd } from '@/lib/ai/pricing'
import {
  PATH_D_MAX_OUTPUT_TOKENS,
  PER_PROJECT_MAX_COST_USD,
  CostCeilingExceededError,
} from '@/lib/ai/path-d-config'
import {
  mintExperimentRunId,
  pathDExperimentMetadata,
} from '@/lib/ai/experiment-runs'
import {
  buildPathDSystemPrompt,
  buildPathDUserMessage,
} from '@/lib/ai/path-d-system-prompt'
import { createPathDStreamParser } from '@/lib/ai/path-d-parser'
import {
  persistPathDOutput,
  type PathDPersistResult,
} from '@/lib/ai/path-d-persistence'
import { redactForLog } from '@/lib/ai/redact'
import type {
  PathDEvent,
  PathDSectionName,
} from '@/lib/types/path-d-events'

// ── Tunables ────────────────────────────────────────────────────────────────

const PATH_D_MODEL = 'claude-opus-4-7'

// Opus 4.7 pricing (USD per million tokens). Mirrors `lib/ai/pricing.ts`.
// Inlined here so the cost-gate math doesn't require a runtime lookup against
// the PRICING table (the math is hot inside the streaming loop).
const OPUS_4_7_INPUT_PRICE_PER_M = 5
const OPUS_4_7_OUTPUT_PRICE_PER_M = 25

// Heuristic tokens-per-character for English-language JSON-heavy text.
// 3.5 chars/token is the typical English ratio; JSON with structural
// punctuation runs slightly denser, but the heuristic is close enough for
// pre-call estimation and mid-stream sampling. Authoritative usage from
// `message_delta` events overrides the estimate when available.
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.5

// Mid-stream cost check cadence. Every N text-delta events; 50 gives
// sub-second cadence at typical streaming rates without thrashing the
// cost computation inside the hot loop.
const COST_CHECK_INTERVAL_DELTAS = 50

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Minimal structural type of the streaming entry-point we depend on.
 * Lets test mocks satisfy the contract without re-implementing the full
 * `Anthropic.Messages` class. The real SDK's
 * `anthropic.messages.stream(...)` is structurally compatible (its return
 * type is an `AsyncIterable` plus a `controller` with an `abort` method).
 */
export type PathDAnthropicStream = AsyncIterable<unknown> & {
  controller: { abort: () => void }
}

export interface PathDAnthropicClient {
  messages: {
    stream(
      request: Anthropic.MessageCreateParamsStreaming,
    ): PathDAnthropicStream
  }
}

export interface RunPathDMappingArgs {
  projectId: string
  userId: string
  sourceTableIds: string[]
  targetTableIds: string[]
  /**
   * Test-only injection. Production callers (the `generateMappings` server
   * action) pass `undefined`; the orchestrator falls back to the module-level
   * `anthropic` instance.
   */
  anthropicClient?: PathDAnthropicClient
  /**
   * Test-only injection. Production callers pass `undefined`; the orchestrator
   * falls back to `supabaseAdmin`.
   */
  admin?: SupabaseClient
  /**
   * Optional progress observer. When provided, the orchestrator emits
   * `PathDEvent` instances at the lifecycle hook points (parser
   * close-tags, cost samples, persistence outcomes, terminal error/done).
   * The SSE route (Sub-PR 5) passes a callback that enqueues each event
   * onto its ReadableStream. Production server-action callsite
   * (`generateMappings`) passes nothing — orchestrator runs identically
   * to its pre-Sub-PR-5 behaviour. Errors thrown from the callback are
   * swallowed so a misbehaving observer cannot fail the run.
   */
  onEvent?: (event: PathDEvent) => void
  /**
   * Optional external abort signal. When fired, the orchestrator aborts
   * the Anthropic stream and follows the existing partial-state-persist
   * path. Used by the SSE route to bridge Next.js
   * `Request.signal` (which fires on client disconnect) into the
   * orchestrator's existing internal AbortController.
   */
  abortSignal?: AbortSignal
}

export type PathDErrorCode = 'COST_CEILING' | 'PARSE_ERROR' | 'INTERNAL'

export type PathDMappingResult =
  | {
      success: true
      runId: string
      summary: PathDPersistResult
      tfmCount: number
    }
  | {
      success: false
      error: string
      errorCode: PathDErrorCode
      runId?: string
    }

// ── Anthropic client (module-level singleton) ──────────────────────────────
//
// Mirrors `lib/ai/llm-client.ts:291`. Server-only — never import this module
// from a client component. The two singletons share env-var state and each
// has its own connection pool; acceptable per the comment in `llm-client.ts`.

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
})

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Run the Path D monolithic mapping pipeline.
 *
 * **IMPORTANT — gate-then-admin contract.** This function uses the admin
 * (service-role) Supabase client and bypasses RLS for the duration of the
 * run. Callers MUST verify editor-or-higher permission via
 * `requireProjectPermission(projectId, 'editor')` BEFORE invocation. The
 * production callsite at `generateMappings` does this; any new caller
 * must do the same.
 *
 * Why service-role here: the orchestrator does many reads/writes across
 * 5+ tables (TFMs, coverage, decisions, lookup_tables, data_quality,
 * inferred_targets, outputs, llm_calls, ai_edit_history). Re-paying the
 * RLS cascade on every read inflated latency on Rootstock-POC-scale
 * projects, and the access check is already authoritative at the action
 * layer. `buildAIContext` follows the same pattern (its docstring
 * explicitly notes "supabaseAdmin injection bypasses the RLS access
 * check entirely").
 */
export async function runPathDMapping(
  args: RunPathDMappingArgs,
): Promise<PathDMappingResult> {
  const { projectId, userId, sourceTableIds, targetTableIds } = args
  const admin = args.admin ?? supabaseAdmin
  const client = args.anthropicClient ?? anthropic

  // ── Spec-load suppression (PR γ) ────────────────────────────────────────
  // Projects whose mappings + transformation intents come from an imported
  // spec (poc_template set) MUST NOT be overwritten by Path D. Check before
  // any expensive work — no context build, no Anthropic call, no llm_calls
  // row written. Returns success+tfmCount=0 so existing callers
  // (generateMappings, pathDSseStreamHandler) handle it as a no-op rather
  // than a 5xx-style error banner.
  const { data: projectGate, error: projectGateErr } = await admin
    .from('projects')
    .select('poc_template')
    .eq('id', projectId)
    .single()
  if (projectGateErr) {
    return {
      success: false,
      error: `Failed to read project (poc_template check): ${projectGateErr.message}`,
      errorCode: 'INTERNAL',
    }
  }
  if (projectGate?.poc_template) {
    console.log(
      `[path-d-mapping] suppressed: project ${projectId} has imported spec ` +
        `(poc_template='${projectGate.poc_template}'); Path D is a no-op for ` +
        `spec-loaded projects.`,
    )
    const skipped = {
      status: 'skipped' as const,
      reason: `spec_loaded:${projectGate.poc_template}`,
    }
    return {
      success: true,
      runId: randomUUID(),
      summary: {
        data_quality: skipped,
        mappings: skipped,
        mapping_sources: skipped,
        table_mappings: skipped,
        coverage: skipped,
        lookup_tables: skipped,
        inferred_targets: skipped,
        decisions: skipped,
        project_notes: skipped,
      },
      tfmCount: 0,
    }
  }

  // Wrapped event emitter — swallows observer errors so a misbehaving
  // callback can never fail the run. Production callsite passes no
  // observer; the wrapper is a no-op in that case.
  const emit = (event: PathDEvent): void => {
    if (!args.onEvent) return
    try {
      args.onEvent(event)
    } catch (err) {
      console.warn(
        `[path-d-mapping] onEvent observer threw on ${event.kind}; swallowing`,
        err,
      )
    }
  }

  const runId = mintExperimentRunId()
  const callId = randomUUID()
  const startedAt = Date.now()

  try {
    // 1. Fetch project context.
    //
    // Inject `admin` as the access-check client so `buildAIContext` does
    // not call `createClient()` (which reads `cookies()` from
    // `next/headers` and fails outside a Next request scope — i.e., the
    // happy-path integration test). Caller responsibility: the
    // `generateMappings` server action already runs `requireProjectPermission`
    // before calling this orchestrator, so the access check inside
    // `buildAIContext` is redundant. Per the documented contract on
    // `buildAIContext`, "supabaseAdmin injection bypasses the RLS access
    // check entirely."
    const ctx = await buildAIContext(
      projectId,
      { tableIds: [...sourceTableIds, ...targetTableIds] },
      userId,
      admin as unknown as Awaited<
        ReturnType<typeof import('@/lib/supabase/server').createClient>
      >,
    )

    // POC flag (INF-73 sunset): extract the answer key + template from
    // ctx. Both are NULL on every non-POC project, so the heritage
    // byte-identical baseline is preserved (buildPathDUserMessage emits
    // an empty pocBlock when pocAnswerKey is null; the llm_calls write
    // below falls through to the original 'path-d-v0' prompt_version).
    const pocAnswerKey = ctx.documents.poc_answer_key
    const pocTemplate = ctx.poc_template

    // 2. Build prompts.
    //
    // INF-41: forward ctx.intelligence_context as intelligenceCtx. Pre-
    // INF-41 the call shape was `buildPathDUserMessage({ ctx })`, which
    // silently dropped the intelligence block — buildAIContext fetches
    // and writes intelligence_context onto ctx (when userId is supplied,
    // as it is here at line 243), but the optional intelligenceCtx arg
    // on buildPathDUserMessage is the read path inside the builder. The
    // result was: every Path D run since #103 ran intelligence-OFF
    // regardless of the user's accumulated migration_intelligence rows.
    // Surfaced by the context-flow audit (PR #107). The eval runner has
    // the same bug pattern at runner.ts:235 — fixed in this PR too.
    const systemPrompt = buildPathDSystemPrompt({ promptVersion: 'path-d-v0' })
    const userMessage = buildPathDUserMessage({
      ctx,
      intelligenceCtx: ctx.intelligence_context,
      pocAnswerKey,
    })

    // 3. Pre-call cost gate.
    const estimatedInputTokens =
      estimateTokens(systemPrompt) + estimateTokens(userMessage)
    const predictedCostUsd =
      (estimatedInputTokens * OPUS_4_7_INPUT_PRICE_PER_M +
        PATH_D_MAX_OUTPUT_TOKENS * OPUS_4_7_OUTPUT_PRICE_PER_M) /
      1_000_000

    if (predictedCostUsd > PER_PROJECT_MAX_COST_USD) {
      const err = new CostCeilingExceededError(predictedCostUsd)
      // No `llm_calls` row written — we never opened the stream. The pre-call
      // gate's only side effect is the error message returned to the caller.
      return {
        success: false,
        error: err.message,
        errorCode: 'COST_CEILING',
        runId,
      }
    }

    // 4. Open the stream.
    const stream = client.messages.stream({
      model: PATH_D_MODEL,
      max_tokens: PATH_D_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      stream: true,
    })

    // Bridge the external abort signal (e.g., from a Next.js
    // `Request.signal` when the client closes the SSE connection) to the
    // Anthropic stream's internal controller. Any post-bridge writes by
    // the iterator throw, which is caught below and treated identically
    // to an internal cost-ceiling abort — partial state is persisted
    // and the orchestrator returns either a partial-success or
    // partial-failure as appropriate.
    const onExternalAbort = (): void => {
      stream.controller.abort()
    }
    if (args.abortSignal) {
      if (args.abortSignal.aborted) {
        stream.controller.abort()
      } else {
        args.abortSignal.addEventListener('abort', onExternalAbort, { once: true })
      }
    }

    // 5. Iterate events; track usage; sample cost; abort if ceiling exceeded.
    const parser = createPathDStreamParser()
    let accumulatedText = ''
    let deltaCount = 0
    let inputTokens = 0
    let outputTokensAuthoritative = 0
    let aborted = false
    let abortError: CostCeilingExceededError | null = null

    try {
      for await (const rawEvent of stream) {
        // The SDK yields `RawMessageStreamEvent` (a discriminated union of
        // ~7 event types). We only read 3 of them; treat the rest as
        // structural pass-through. Cast through a minimal shape so we
        // don't have to enumerate the entire SDK union here.
        const event = rawEvent as { type: string } & Record<string, unknown>

        if (event.type === 'message_start') {
          const message = event.message as
            | { usage?: { input_tokens?: number | null; output_tokens?: number | null } }
            | undefined
          inputTokens = message?.usage?.input_tokens ?? 0
          outputTokensAuthoritative = message?.usage?.output_tokens ?? 0
          continue
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta as { type?: string; text?: string } | undefined
          if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') continue
          accumulatedText += delta.text
          const feedResult = parser.feed(delta.text)
          // Emit one section_completed event per close tag detected in
          // this chunk. The parser dedups across chunks (each section
          // fires at most once per run).
          if (feedResult.completedSections.length > 0) {
            for (const section of feedResult.completedSections) {
              emit({ kind: 'section_completed', section: section as PathDSectionName })
            }
          }
          deltaCount++

          if (deltaCount % COST_CHECK_INTERVAL_DELTAS === 0) {
            const estOutputTokens = Math.ceil(
              accumulatedText.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN,
            )
            const runningCostUsd =
              (inputTokens * OPUS_4_7_INPUT_PRICE_PER_M +
                estOutputTokens * OPUS_4_7_OUTPUT_PRICE_PER_M) /
              1_000_000
            // Surface the cost sample to observers (SSE route uses this
            // to drive a live cost meter). Emitted at the same cadence
            // as the cost-ceiling check (every COST_CHECK_INTERVAL_DELTAS
            // deltas), which is sub-second at typical streaming rates.
            emit({
              kind: 'cost_update',
              outputTokens: estOutputTokens,
              estimatedCostUsd: runningCostUsd,
            })
            if (runningCostUsd > PER_PROJECT_MAX_COST_USD) {
              aborted = true
              abortError = new CostCeilingExceededError(
                runningCostUsd,
                PER_PROJECT_MAX_COST_USD,
                estOutputTokens,
              )
              stream.controller.abort()
              break
            }
          }
          continue
        }

        if (event.type === 'message_delta') {
          const usage = event.usage as { output_tokens?: number | null } | undefined
          if (usage?.output_tokens != null) {
            outputTokensAuthoritative = usage.output_tokens
          }
        }
      }
    } catch (streamErr) {
      // We may have triggered an AbortError ourselves (cost ceiling) OR
      // an external caller aborted via `args.abortSignal`. Both are
      // expected cases — swallow and continue to persistence with the
      // partial state. Anything else is a real failure → rethrow to
      // the outer catch (records 'INTERNAL' for the caller).
      const externalAbort = args.abortSignal?.aborted === true
      if (externalAbort) aborted = true
      if (!aborted) throw streamErr
    } finally {
      // Detach the external-abort listener regardless of how the loop
      // exited (success / cost-ceiling abort / external abort / throw).
      // Prevents a leak when the orchestrator is invoked many times in
      // a single process (e.g., the integration test's idempotency
      // re-run).
      if (args.abortSignal) {
        args.abortSignal.removeEventListener('abort', onExternalAbort)
      }
    }

    // 6. Parse the accumulated buffer.
    const parsed = parser.finish()

    // 7. Persist (per-section recovery — partial state is fine).
    const persistResult = await persistPathDOutput({
      supabaseAdmin: admin,
      projectId,
      userId,
      experimentRunId: runId,
      parsed,
    })

    // Emit a section_persisted event for each of the 7 sections.
    // Iterates in dependency-insert order (matches PathDPersistResult
    // key order: data_quality → mappings → coverage → lookup_tables →
    // inferred_targets → decisions → project_notes — see
    // path-d-persistence.ts for why).
    const sectionOrder: PathDSectionName[] = [
      'data_quality',
      'mappings',
      'coverage',
      'lookup_tables',
      'inferred_targets',
      'decisions',
      'project_notes',
    ]
    for (const section of sectionOrder) {
      const sectionResult = persistResult[section]
      if (sectionResult.status === 'inserted') {
        emit({
          kind: 'section_persisted',
          section,
          status: 'inserted',
          count: sectionResult.count,
        })
      } else if (sectionResult.status === 'errored') {
        emit({
          kind: 'section_persisted',
          section,
          status: 'errored',
          error: sectionResult.error,
        })
      } else {
        emit({ kind: 'section_persisted', section, status: 'skipped' })
      }
    }

    // 8. Compute final cost / output tokens for telemetry.
    let finalOutputTokens: number
    let finalCostUsd: number | null
    if (aborted) {
      finalOutputTokens = Math.ceil(
        accumulatedText.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN,
      )
      finalCostUsd =
        (inputTokens * OPUS_4_7_INPUT_PRICE_PER_M +
          finalOutputTokens * OPUS_4_7_OUTPUT_PRICE_PER_M) /
        1_000_000
    } else {
      finalOutputTokens = outputTokensAuthoritative
      finalCostUsd = computeCostUsd(PATH_D_MODEL, {
        input_tokens: inputTokens,
        output_tokens: outputTokensAuthoritative,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      })
    }

    // 9. Write llm_calls row. Diverges from Path B's fire-and-forget pattern
    //    (`lib/ai/llm-client.ts:writeLogAsync` uses `void`) because Path D's
    //    next step — emitPathDProvenance — inserts ai_edit_history rows
    //    whose `llm_call_id` FK references this exact `llm_calls` row.
    //    `void` here would race with the FK insert and abort the entire
    //    provenance batch on FK violation 23503 (verified end-to-end during
    //    Sub-PR 4b authoring). Awaiting keeps the ordering causal:
    //    llm_calls THEN ai_edit_history. `writePathDLlmCallLog` already
    //    swallows its own errors internally (try/catch + console.error),
    //    so awaiting can never fail the run.
    await writePathDLlmCallLog({
      admin,
      callId,
      projectId,
      userId,
      systemPrompt,
      userMessage,
      responseText: accumulatedText,
      inputTokens,
      outputTokens: finalOutputTokens,
      latencyMs: Date.now() - startedAt,
      costUsd: finalCostUsd,
      aborted,
      runId,
      pocTemplate,
      pocFlagEnabled: pocAnswerKey !== null,
    })

    // 10. Emit per-TFM provenance. Centralised at the orchestrator boundary
    //     so persistence stays clean (audit allow-list rationale) and the
    //     llm_call_id FK is satisfied (step 9 awaited above).
    if (persistResult.mappings.status === 'inserted') {
      await emitPathDProvenance({
        admin,
        projectId,
        userId,
        runId,
        callId,
      })
    }

    // 11. If we aborted on cost ceiling, surface the error to the caller —
    //     but persistence + telemetry already wrote what we did manage to
    //     get, so the run is partially observable.
    if (aborted && abortError) {
      emit({ kind: 'error', phase: 'cost_ceiling', message: abortError.message })
      return {
        success: false,
        error: abortError.message,
        errorCode: 'COST_CEILING',
        runId,
      }
    }

    const tfmCount =
      persistResult.mappings.status === 'inserted'
        ? persistResult.mappings.count
        : 0
    // Final terminal event for SSE consumers. Mirrors the success-return
    // shape; `summary` is the same `PathDPersistResult` the function
    // returns.
    emit({ kind: 'done', runId, summary: persistResult })
    return { success: true, runId, summary: persistResult, tfmCount }
  } catch (err) {
    const message = (err as Error).message
    // 'internal' is the catch-all phase for the orchestrator's outer
    // try/catch. Cost-ceiling errors are emitted from the success-path
    // branch above (they don't throw); persist errors fall here only
    // if persistPathDOutput itself throws (uncommon — most failures
    // surface as per-section 'errored' status, not exceptions).
    emit({ kind: 'error', phase: 'internal', message })
    return {
      success: false,
      error: message,
      errorCode: 'INTERNAL',
      runId,
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN)
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

interface WritePathDLlmCallLogArgs {
  admin: SupabaseClient
  callId: string
  projectId: string
  userId: string
  systemPrompt: string
  userMessage: string
  responseText: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  costUsd: number | null
  aborted: boolean
  runId: string
  /**
   * POC discriminator from `ctx.poc_template` — `null` on every heritage
   * run. Surfaced on `llm_calls.metadata.poc_template` so analyst queries
   * can group POC vs heritage cohorts. Sunset: INF-73.
   */
  pocTemplate: string | null
  /**
   * True when the run actually included an answer-key block in the user
   * message. Distinct from `pocTemplate !== null` because a project with
   * `poc_template='rootstock'` but no uploaded answer-key document still
   * runs the heritage prompt — this field tags the SHIPPED block, not
   * the configured intent. Surfaced on
   * `llm_calls.metadata.poc_flag_enabled`. Sunset: INF-73.
   */
  pocFlagEnabled: boolean
}

async function writePathDLlmCallLog(
  args: WritePathDLlmCallLogArgs,
): Promise<void> {
  try {
    const { error } = await args.admin.from('llm_calls').insert({
      id: args.callId,
      project_id: args.projectId,
      user_id: args.userId,
      // Reusing the existing 'mapping_generate' enum value to avoid expanding
      // `LLMFeature` for a Path B/D split — the `experiment_label` field in
      // metadata distinguishes Path B from Path D in the analyst views.
      feature: 'mapping_generate',
      // POC runs get a separate prompt_version so analyst views can
      // partition POC vs heritage cohorts cleanly. Sunset: INF-73.
      prompt_version: args.pocFlagEnabled ? 'path-d-poc-v0' : 'path-d-v0',
      model: PATH_D_MODEL,
      is_streaming: true,
      max_tokens: PATH_D_MAX_OUTPUT_TOKENS,
      system_prompt: args.systemPrompt,
      user_message: args.userMessage,
      response_text: args.responseText,
      system_prompt_hash: shortHash(args.systemPrompt),
      user_message_hash: shortHash(args.userMessage),
      anthropic_request_id: null,
      stop_reason: args.aborted ? 'aborted_cost_ceiling' : 'end_turn',
      input_tokens: args.inputTokens,
      output_tokens: args.outputTokens,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: args.latencyMs,
      cost_usd: args.costUsd,
      succeeded: !args.aborted,
      error_type: args.aborted ? 'cost_ceiling' : null,
      error_message: args.aborted
        ? 'Path D mid-stream cost ceiling exceeded'
        : null,
      parent_call_id: null,
      abuse_user_id: null,
      metadata: {
        ...pathDExperimentMetadata(args.runId),
        // POC tagging (INF-73 sunset). Both fields written on every Path
        // D run so analyst queries can use simple metadata->>'...' reads
        // without coalescing nulls. `poc_template` is `null` for heritage
        // runs; `poc_flag_enabled` is `false`.
        poc_template: args.pocTemplate,
        poc_flag_enabled: args.pocFlagEnabled,
      },
    })
    if (error) {
      console.error(
        `[path-d-mapping] llm_calls log failed for call_id=${args.callId} run_id=${args.runId}: ${error.message}`,
      )
    }
  } catch (err) {
    console.error(
      `[path-d-mapping] llm_calls log threw for call_id=${args.callId} run_id=${args.runId}:`,
      err,
    )
  }
}

interface EmitPathDProvenanceArgs {
  admin: SupabaseClient
  projectId: string
  userId: string
  runId: string
  callId: string
}

async function emitPathDProvenance(
  args: EmitPathDProvenanceArgs,
): Promise<void> {
  // Re-fetch the just-inserted TFMs by experiment_run_id (set by
  // `path-d-persistence.ts`'s upsert) so we have authoritative `id` +
  // `confidence` + `ai_reasoning` values matching what's actually in the
  // database.
  const { data: tfms, error: selErr } = await args.admin
    .from('target_field_mappings')
    .select('id, target_field_id, confidence, ai_reasoning')
    .eq('project_id', args.projectId)
    .eq('experiment_run_id', args.runId)
  if (selErr) {
    console.warn(
      `[path-d-mapping] emitPathDProvenance TFM select failed for run_id=${args.runId}: ${selErr.message}`,
    )
    return
  }

  if (!tfms || tfms.length === 0) return

  // Direct insert into `ai_edit_history`. We intentionally do NOT route
  // this through `logAIEdit` (the canonical helper from
  // `lib/actions/ai-edit-history.ts`):
  //
  //   1. logAIEdit is a `'use server'` action. Path B's call sites are
  //      themselves server actions, so the action-to-action transport
  //      Just Works. path-d-mapping.ts is a library module (not an
  //      action) — calling a 'use server' function from a non-action
  //      context inside a vitest worker writes nothing reliably. The
  //      first happy-path real-LLM run reproduced this: 27 TFMs
  //      persisted, 0 ai_edit_history rows.
  //   2. Inlining keeps Path D's bulk emission self-contained and
  //      atomic (Promise.all awaits all writes before returning).
  //   3. The audit invariant test (`ai-edit-emission-invariant.test.ts`)
  //      lists `emitPathDProvenance` in VIRTUAL_ANCHORS as a
  //      virtual-anchor function whose provenance write doesn't go
  //      through the function-name-detected `logAIEdit(` regex. The
  //      direct insert here is functionally identical to what logAIEdit
  //      would have written — same shape, same redaction step, same
  //      try/catch never-block contract.
  //
  // The shape mirrors `lib/actions/ai-edit-history.ts:logAIEdit` exactly
  // so a future PR can extract a shared helper. The only divergence:
  // we use `args.admin` (the orchestrator's already-injected client)
  // instead of `supabaseAdmin` from the proxy module, so the test seam
  // for admin injection extends through to provenance writes.
  const rows = tfms.map((tfm) => ({
    project_id: args.projectId,
    actor_id: args.userId,
    entity_type: 'target_field_mapping' as const,
    entity_id: tfm.id as string,
    field_path: 'confidence',
    old_value: null,
    new_value: redactForLog({
      confidence: tfm.confidence,
      ai_reasoning: tfm.ai_reasoning,
      target_field_id: tfm.target_field_id,
    }) ?? null,
    edit_kind: 'ai_proposed' as const,
    llm_call_id: args.callId,
    metadata: {
      experiment_label: 'path_d',
      experiment_run_id: args.runId,
      run_method: 'path_d_monolithic',
    },
  }))

  const { error: insErr } = await args.admin.from('ai_edit_history').insert(rows)
  if (insErr) {
    console.warn(
      `[path-d-mapping] emitPathDProvenance insert failed for run_id=${args.runId}: ${insErr.message}`,
    )
  }
}
