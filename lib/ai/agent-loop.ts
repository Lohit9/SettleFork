/**
 * PR 3.2 — Agent loop primitive.
 *
 * Implements the design at docs/investigations/pr-phase3.1-agent-design.md
 * §A1-A9. Wraps `callLLM` for per-iteration LLM invocations; never
 * bypasses the wrapper. All telemetry flows through the existing
 * `llm_calls` table (one row per iteration, chained via parent_call_id
 * heads-to-tails per LOCK #3).
 *
 * Heritage preservation: this module's IMPORTS produce zero runtime
 * side effects. When `AI_PHASE_3_ENABLED !== '1'`, no callsite invokes
 * `runAgentLoop` and the entire module is dead code at runtime. The
 * heritage flag-OFF byte-identical gate remains satisfied.
 *
 * NOT in scope for PR 3.2:
 *   - Callsite migration (PR 3.4 ships mapping_generate as first adopter)
 *   - Data-scanning tool schemas + RPCs (PR 3.3)
 *   - Streaming variant (existing single streaming callsite stays
 *     non-agent for now; design §C2 defers streaming to PR 13.2+)
 */

import { randomUUID } from 'node:crypto'
import type { Tool } from '@anthropic-ai/sdk/resources/messages'

import { callLLM, type CallLLMOptions, type CallLLMResult, type LLMFeature } from '@/lib/ai/llm-client'

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Function the loop calls when the model invokes a data-scanning tool.
 * Receives the tool_use input (already strict-mode-validated by Anthropic);
 * returns a stringified result for the model + optional structured
 * telemetry.
 *
 * `fatal: true` aborts the loop with `reason: 'tool_error'`. Non-fatal
 * errors should return a human-readable error string in `result` so
 * the model can retry with adjusted args.
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<{
  /** Stringified result fed back to the model as a tool_result block. */
  result: string
  /** Optional structured form for downstream consumers. */
  metadata?: Record<string, unknown>
  /** When true, signals an unrecoverable error — the loop terminates. */
  fatal?: boolean
}>

/**
 * Mock responder shape for `dryRun` mode (LOCK #4). Receives the same
 * iteration context the loop would send to `callLLM`; returns the
 * shape `callLLM` would return — minus the telemetry fields, since
 * dryRun bypasses the wrapper entirely. The optional `costUsd` field
 * lets unit tests drive the `max_cost` termination path (the soft
 * ceiling); production iterations get this from the wrapper's
 * cost computation.
 */
export type DryRunMockResponse =
  | { kind: 'text'; text: string; costUsd?: number }
  | { kind: 'toolUse'; toolUse: { name: string; input: Record<string, unknown> }; costUsd?: number }

export type DryRunResponder = (req: {
  iteration: number
  systemPrompt: string
  userMessage: string
  tools: Tool[]
}) => Promise<DryRunMockResponse>

export interface RunAgentLoopOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  /** Tool registrations. The "answer" tool has NO handler — when the model picks it, the loop returns `kind: 'final'`. */
  tools: Array<{ tool: Tool; handler?: ToolHandler }>
  projectId: string
  userId: string
  /** Hard cap on loop iterations. Default 8 (LOCK §A2). */
  maxIterations?: number
  /** Hard cap on aggregate cost in USD across all iterations. Default 1.00. */
  maxCostUsd?: number
  /** Hard cap on wall-clock ms across all iterations. Default 120_000 (2 min; well under cache TTL). */
  maxWallClockMs?: number
  /**
   * Per-call options forwarded to `callLLM` (model, maxTokens, etc.).
   * PR 3.4a widening: `thinking` + `output_config` for agent adopters.
   * PR 3.4cd widening: `temperature` for self-consistency voting.
   */
  llmOptions?: Pick<
    CallLLMOptions,
    | 'model'
    | 'maxTokens'
    | 'promptVersion'
    | 'abuseUserId'
    | 'cacheControl'
    | 'metadata'
    | 'thinking'
    | 'output_config'
    | 'temperature'
  >
  /**
   * LOCK #4: opt-in dry-run mode for unit tests. When set, the loop
   * dispatches each iteration to `dryRun.mockResponder` instead of
   * calling `callLLM`. Telemetry rows are NOT written under dryRun
   * (no llm_calls inserts; synthetic UUIDs populate `callIds`).
   */
  dryRun?: { mockResponder: DryRunResponder }
}

export type AgentLoopResult =
  | {
      kind: 'final'
      /** Final tool_use block from the model — the "answer" tool. */
      finalToolUse: { name: string; input: Record<string, unknown> }
      iterations: number
      totalCostUsd: number | null
      callIds: string[]
    }
  | {
      kind: 'aborted'
      reason:
        | 'max_iterations'
        | 'max_cost'
        | 'max_wall_clock'
        | 'tool_error'
        | 'model_error'
        | 'schema_error'
      message: string
      iterations: number
      totalCostUsd: number | null
      callIds: string[]
    }

// ─── Defaults (LOCK §A2) ─────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_MAX_COST_USD = 1.0
const DEFAULT_MAX_WALL_CLOCK_MS = 120_000

// ─── Internal: one assistant turn (tool_use or text) + matching user reply ───

interface AssistantTurn {
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolResultText: string
}

// ─── Public entry ────────────────────────────────────────────────────────────

/**
 * Run an agent loop end-to-end. See design doc for invariants and
 * termination semantics. Heritage preservation: when no callsite
 * invokes this function (default Phase 3 OFF), it is dead code.
 */
export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD
  const maxWallClockMs = opts.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS
  const startedAt = Date.now()

  // Index handlers by tool name for O(1) dispatch. Tools without a
  // registered handler are "answer" tools — picking one terminates.
  const handlerByName = new Map<string, ToolHandler>()
  for (const t of opts.tools) {
    if (t.handler) handlerByName.set(t.tool.name, t.handler)
  }
  const allTools = opts.tools.map((t) => t.tool)

  const callIds: string[] = []
  const turns: AssistantTurn[] = []
  let totalCostUsd: number | null = 0
  let parentCallId: string | undefined = undefined

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Termination: wall clock (checked at start of each iteration so a
    // long tool handler in the previous iteration short-circuits the
    // next LLM call).
    if (Date.now() - startedAt > maxWallClockMs) {
      return aborted('max_wall_clock', `Wall-clock exceeded ${maxWallClockMs}ms`, iteration - 1, totalCostUsd, callIds)
    }
    // Termination: cost cap (computed across prior iterations).
    if (totalCostUsd !== null && totalCostUsd > maxCostUsd) {
      return aborted('max_cost', `Aggregate cost ${totalCostUsd.toFixed(4)} exceeded cap ${maxCostUsd.toFixed(2)}`, iteration - 1, totalCostUsd, callIds)
    }

    // Build the user message for this iteration: original prompt +
    // accumulated tool_use/tool_result pairs from prior iterations.
    // Anthropic's protocol: alternating user/assistant turns, with the
    // assistant's tool_use blocks in assistant turns and tool_result
    // blocks in user turns. The initial iteration sends just the user
    // message; subsequent iterations append the prior assistant's
    // tool_use + the user's tool_result on top.
    //
    // For dryRun, we hand the responder a simplified projection (the
    // current iteration index + the original prompts + the tools) so
    // the test doesn't need to reconstruct Anthropic's wire format.
    if (opts.dryRun) {
      let response: DryRunMockResponse
      try {
        response = await opts.dryRun.mockResponder({
          iteration,
          systemPrompt: opts.systemPrompt,
          userMessage: opts.userMessage,
          tools: allTools,
        })
      } catch (err) {
        return aborted('model_error', err instanceof Error ? err.message : String(err), iteration, totalCostUsd, callIds)
      }
      // dryRun mode: synthetic call id; no llm_calls insert. Optional
      // costUsd on the mock response accumulates into totalCostUsd so
      // the max_cost soft-ceiling termination path is testable.
      const syntheticCallId = randomUUID()
      callIds.push(syntheticCallId)
      parentCallId = syntheticCallId
      if (response.costUsd !== undefined && totalCostUsd !== null) {
        totalCostUsd += response.costUsd
      }

      const dispatch = await dispatchResponse(response, handlerByName)
      if (dispatch.kind === 'final') {
        return finalResult(dispatch.toolUse, iteration, totalCostUsd, callIds)
      }
      if (dispatch.kind === 'abort') {
        return aborted(dispatch.reason, dispatch.message, iteration, totalCostUsd, callIds)
      }
      turns.push(dispatch.turn)
      continue
    }

    // Real LLM iteration. Build the conversation history from
    // accumulated turns; send via callLLM with multi-tool registration.
    const conversationUserMessage = buildConversationUserMessage(opts.userMessage, turns)

    let llmResult: CallLLMResult
    try {
      llmResult = await callLLM({
        feature: opts.feature,
        systemPrompt: opts.systemPrompt,
        userMessage: conversationUserMessage,
        projectId: opts.projectId,
        userId: opts.userId,
        tools: allTools,
        ...(parentCallId ? { parentCallId } : {}),
        ...(opts.llmOptions ?? {}),
      })
    } catch (err) {
      return aborted('model_error', err instanceof Error ? err.message : String(err), iteration, totalCostUsd, callIds)
    }

    callIds.push(llmResult.callId)
    parentCallId = llmResult.callId
    if (llmResult.costUsd !== null && totalCostUsd !== null) {
      totalCostUsd += llmResult.costUsd
    } else if (llmResult.costUsd === null) {
      // Cost reporting failed for this iteration — surface as null so
      // downstream consumers know totals are unreliable.
      totalCostUsd = null
    }

    const response: DryRunMockResponse =
      llmResult.kind === 'toolUse'
        ? { kind: 'toolUse', toolUse: llmResult.toolUse }
        : { kind: 'text', text: llmResult.text }

    const dispatch = await dispatchResponse(response, handlerByName)
    if (dispatch.kind === 'final') {
      return finalResult(dispatch.toolUse, iteration, totalCostUsd, callIds)
    }
    if (dispatch.kind === 'abort') {
      return aborted(dispatch.reason, dispatch.message, iteration, totalCostUsd, callIds)
    }
    turns.push(dispatch.turn)
  }

  // Loop fell through without final answer.
  return aborted('max_iterations', `Loop exhausted ${maxIterations} iterations without final answer`, maxIterations, totalCostUsd, callIds)
}

// ─── Internals ───────────────────────────────────────────────────────────────

type DispatchOutcome =
  | { kind: 'final'; toolUse: { name: string; input: Record<string, unknown> } }
  | { kind: 'continue'; turn: AssistantTurn }
  | { kind: 'abort'; reason: 'tool_error' | 'schema_error'; message: string }

async function dispatchResponse(
  response: DryRunMockResponse,
  handlerByName: Map<string, ToolHandler>,
): Promise<DispatchOutcome> {
  if (response.kind === 'text') {
    // Multi-tool with tool_choice 'auto' allows text. The agent loop
    // treats this as a schema_error per design §A2: the model failed
    // to pick a tool, including the answer tool. Adopting callsites
    // can fall back to a single-shot retry on aborted{schema_error}.
    return {
      kind: 'abort',
      reason: 'schema_error',
      message: 'Model emitted a text response instead of selecting a registered tool',
    }
  }

  const toolUse = response.toolUse
  const handler = handlerByName.get(toolUse.name)
  if (!handler) {
    // No handler = answer tool. Terminate with final.
    if (handlerByName.has(toolUse.name) === false) {
      // Distinguish "unknown tool" (not registered at all) from
      // "answer tool" (registered without a handler). The wrapper
      // already validated the name against registered tools, so any
      // name reaching here was registered. The handlerByName lookup
      // distinguishes the two: handler present = data tool;
      // handler absent (but name registered as a tool) = answer.
      // In code: if it's NOT in handlerByName, it's the answer tool.
      // (Schema-error path — name unregistered — is already filtered
      // by callLLM's allowed-names check before we get here.)
      return { kind: 'final', toolUse }
    }
  }

  if (!handler) {
    return { kind: 'final', toolUse }
  }

  // Data tool: invoke handler, accumulate turn, continue loop.
  let handlerResult: Awaited<ReturnType<ToolHandler>>
  try {
    handlerResult = await handler(toolUse.input)
  } catch (err) {
    return {
      kind: 'abort',
      reason: 'tool_error',
      message: `Handler for "${toolUse.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (handlerResult.fatal) {
    return {
      kind: 'abort',
      reason: 'tool_error',
      message: `Handler for "${toolUse.name}" returned fatal: ${handlerResult.result}`,
    }
  }

  return {
    kind: 'continue',
    turn: {
      toolUseId: randomUUID(), // synthetic id for the tool_result block
      toolName: toolUse.name,
      toolInput: toolUse.input,
      toolResultText: handlerResult.result,
    },
  }
}

/**
 * Reconstruct the user message for a follow-up iteration. The protocol
 * is alternating user/assistant turns, with tool_use in assistant turns
 * and tool_result in user turns. The Anthropic SDK's MessageParam
 * shape accepts content as a string OR a content-block array; for
 * agent loops we use the latter to pack tool_use + tool_result blocks.
 *
 * For now (PR 3.2) the simplest viable shape: append a textual summary
 * of prior tool calls + their results to the original user message.
 * This preserves Anthropic-protocol correctness without requiring
 * structured assistant-turn replay (which would need a richer
 * `messages` array sent through callLLM — out of scope; the wrapper
 * accepts a single user message today).
 *
 * The model receives: original question + a "Here's what we've learned
 * from the tools so far" appendix. This is functionally correct for
 * Settle's use cases (the model can decide whether to call another
 * tool or emit the answer based on accumulated info).
 *
 * Phase 3.5+ may upgrade `callLLM` to accept a full messages array
 * for richer agent flows. For now the textual-appendix approach
 * keeps PR 3.2 surgical.
 */
function buildConversationUserMessage(
  original: string,
  turns: AssistantTurn[],
): string {
  if (turns.length === 0) return original

  const summary = turns
    .map((t, i) => {
      const inputJson = JSON.stringify(t.toolInput)
      return `[Tool call ${i + 1}] ${t.toolName}(${inputJson})\n→ ${t.toolResultText}`
    })
    .join('\n\n')

  return `${original}\n\n<prior_tool_calls>\n${summary}\n</prior_tool_calls>`
}

function finalResult(
  toolUse: { name: string; input: Record<string, unknown> },
  iterations: number,
  totalCostUsd: number | null,
  callIds: string[],
): AgentLoopResult {
  return {
    kind: 'final',
    finalToolUse: toolUse,
    iterations,
    totalCostUsd,
    callIds,
  }
}

function aborted(
  reason:
    | 'max_iterations'
    | 'max_cost'
    | 'max_wall_clock'
    | 'tool_error'
    | 'model_error'
    | 'schema_error',
  message: string,
  iterations: number,
  totalCostUsd: number | null,
  callIds: string[],
): AgentLoopResult {
  return {
    kind: 'aborted',
    reason,
    message,
    iterations,
    totalCostUsd,
    callIds,
  }
}
