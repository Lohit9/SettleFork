# PR phase3.1 — Agent decomposition design + RPC contracts (Phase A, read-only)

**Type:** Read-only investigation. The only artifact this phase produces is this document.

**Audience:** Phase B implementers (PR 3.2 loop, PR 3.3 RPCs, PR 3.4 first adopter) + Kaan for sign-off.

**Scope:** Lock the design for two load-bearing primitives that everything in 3.2–3.7 depends on:
- (A) The agent-loop primitive (`lib/ai/agent-loop.ts`)
- (B) RPC contracts for 3 data-scanning tools

**Out of scope:** Pipeline-specific designs (3.4 mapping voting, 3.5 transform dry-run, 3.6 validation row sampling, 3.7 SSE UX) — separate sub-investigations after this locks.

---

## DIVERGENCE callouts (load-bearing — read first)

1. **No pre-existing agent-loop scaffolding.** Grep for `agent[-_]loop`, `tool[_-]use[_-]loop`, `multi[_-]turn`, `tool_use_id` across `lib/` returned empty. PR 3.2 is greenfield.

2. **Existing `execute_readonly_query` (migration 004) is UNSAFE to expose to the model.** The RPC takes a `p_table_ids UUID[]` argument but **does not use it** to scope the query — it relies on SQL-keyword blocklisting (DDL/DML/system-catalog) + a 1000-row LIMIT. A model-emitted query could `SELECT FROM data_rows WHERE table_id = '<any-uuid>'` and read across projects since the RPC is `SECURITY DEFINER`. PR 3.3 must author NEW RPCs that scope by project_id + verify `auth.uid()` access via `user_has_project_role(p_project_id, 'viewer')` BEFORE executing. **DO NOT wrap `execute_readonly_query` as a model-facing tool.**

3. **`dq_field_issue_samples` (migration 055) is purpose-built, not generalizable.** It takes a `p_condition` enum (`null`/`non_iso_date`/`invalid_date`/etc.) — covers known DQ issue shapes only. Cannot be repurposed as the general `query_field_data` tool.

4. **Heritage gate is SHA-256 fingerprint equality** ([mappings-for-redesign-heritage.test.ts:101-174](../../tests/integration/mappings-for-redesign-heritage.test.ts)). Any deviation in the legacy non-agent callLLM path produces a fingerprint mismatch and fails the test. Agent-loop must be entirely additive — the flag-OFF path through callLLM stays byte-identical, and the heritage gate proves it.

5. **`callLLMStreaming` already accepts `tool` parameter (PR 12.1 §9.1 probe + PR 12.3).** The agent loop does NOT need to bypass the wrapper for streaming. PR 3.2 wraps `callLLM` for the loop's per-iteration calls; existing streaming surface stays as-is.

---

## LOCKED DECISIONS (post-review)

A's review of this investigation resolved 4 open questions. Embedded verbatim below; PR 3.2 implementation must reflect each lock exactly.

1. **parent_call_id storage:** REUSE the existing `parent_call_id UUID REFERENCES public.llm_calls(id) ON DELETE SET NULL` column declared in [`082_llm_calls.sql:75-76`](../../supabase/migrations/082_llm_calls.sql#L75-L76) — already populated today by repair-retry chains (`mapping_generate_repair`, `nl_to_sql_retry`, `outputs_execution_package_fallback`). Agent-loop iterations chain via the SAME column, NOT JSONB metadata. PR 3.2 ships ONE small migration `084_index_parent_call_id_on_llm_calls.sql` (~10 LOC partial btree index: `CREATE INDEX IF NOT EXISTS idx_llm_calls_parent_call_id ON public.llm_calls(parent_call_id) WHERE parent_call_id IS NOT NULL;`). Rationale: the FK constraint doesn't auto-index in Postgres; the partial index makes chain-walking cheap and **retroactively benefits the existing repair-retry queries**, not just the new agent-loop telemetry.

2. **tool_choice: `'auto'`** (not `'required'`). Rationale: data-scanning tools provide multi-iteration reasoning surface; reasoning-text-before-answer-tool preserved. A/B test `'required'` at Phase 3.8 if eval lift undershoots target.

3. **parent_call_id chaining:** heads-to-tails (each iter N points at iter N-1). NOT all-iterations-to-iter-1. Rationale: matches existing repair-retry pattern; familiar shape for ops queries.

4. **dryRun mode:** included in PR 3.2. `RunAgentLoopOptions.dryRun?: boolean` — accepts a mock LLM responder; opt-in for unit tests. Rationale: makes the loop testable without SDK calls or env-gating; lowers PR 3.2's verification spend to near zero.

---

## TL;DR

- PR 3.2 ships the agent-loop primitive: `runAgentLoop({ feature, systemPrompt, userMessage, tools, maxIterations, maxCostUsd, projectId, userId })` returning a discriminated `AgentLoopResult`. Wraps `callLLM`. Per-iteration rows in `llm_calls`. Flag-gated under `AI_PHASE_3_ENABLED=1` (default OFF).
- PR 3.3 ships 3 NEW Postgres RPCs: `agent_query_field_data`, `agent_count_distinct_patterns`, `agent_cross_field_correlation`. All `SECURITY INVOKER` with explicit `user_has_project_role(p_project_id, 'viewer')` gate. Bounded row counts + statement timeouts.
- PR 3.4 (first adopter) migrates `mapping_generate` to optionally use the agent loop with the 3 data-scanning tools when `AI_PHASE_3_ENABLED=1`. Heritage flag-OFF byte-identical preserved. Eval `mapping` baseline: re-measure post-migration; expect lift on harder fixtures.
- 3 NEW tool schemas authored in `lib/ai/tool-schemas.ts` following the strict-mode catalog (additionalProperties: false, no oneOf, no min/max).
- Loop telemetry: each iteration writes a normal `llm_calls` row. Iterations chain via `parent_call_id`. The first iteration's `parent_call_id` is null; iterations 2..N point at iteration N-1. Aggregate cost = SUM(cost_usd) over the chain.
- Cache interaction: `cache_control` on system + tool definitions persists across loop iterations within Anthropic's 5-min ephemeral TTL. Read-to-write ratio shifts UP under agent loops because every iteration in a loop hits the same cached prefix.

---

## Section A — Agent loop primitive

### A1. Module signature and entry function

New file: `lib/ai/agent-loop.ts`. Exports a single async function plus types.

```typescript
import type { Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
import type { LLMFeature, CallLLMOptions } from '@/lib/ai/llm-client'

/**
 * Function the loop calls when the model invokes a tool. Receives the
 * model's tool_use block (already strict-mode-validated by Anthropic);
 * returns the JSON-stringified result the loop feeds back as the next
 * user message's tool_result block.
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<{
  /** Stringified result for the model. Must be valid JSON. */
  result: string
  /** Optional structured form for telemetry (stored in llm_calls.metadata). */
  metadata?: Record<string, unknown>
  /** When true, signals an unrecoverable error — the loop terminates. */
  fatal?: boolean
}>

export interface RunAgentLoopOptions {
  feature: LLMFeature
  systemPrompt: string
  userMessage: string
  tools: Array<{ tool: Tool; handler: ToolHandler }>
  projectId: string
  userId: string
  /** Hard cap on loop iterations. Default 8. */
  maxIterations?: number
  /** Hard cap on aggregate cost in USD across all iterations. Default 1.00. */
  maxCostUsd?: number
  /** Hard cap on wall-clock ms across all iterations. Default 120_000 (2 min). */
  maxWallClockMs?: number
  /** Per-call options forwarded to callLLM (model, maxTokens, etc.). */
  llmOptions?: Pick<CallLLMOptions, 'model' | 'maxTokens' | 'promptVersion' | 'abuseUserId' | 'cacheControl' | 'metadata'>
  /**
   * LOCK #4: opt-in dry-run mode for unit tests. When provided, the loop
   * dispatches each iteration to this mock responder instead of calling
   * `callLLM`. Lets unit tests assert request shapes + termination
   * conditions without burning real Anthropic spend or env-gating.
   */
  dryRun?: (iterationInput: {
    iteration: number
    systemPrompt: string
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
    tools: Tool[]
  }) => Promise<{ kind: 'text'; text: string } | { kind: 'toolUse'; toolUse: { name: string; input: Record<string, unknown> } }>
}

export type AgentLoopResult =
  | {
      kind: 'final'
      /** Final tool_use block from the model — the "answer" tool. */
      finalToolUse: { name: string; input: Record<string, unknown> }
      iterations: number
      totalCostUsd: number | null
      callIds: string[]  // PKs of every llm_calls row, in order
    }
  | {
      kind: 'aborted'
      reason: 'max_iterations' | 'max_cost' | 'max_wall_clock' | 'tool_error' | 'model_error' | 'schema_error'
      message: string
      iterations: number
      totalCostUsd: number | null
      callIds: string[]
    }

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<AgentLoopResult>
```

### A2. Loop invariant + termination conditions

The loop maintains the following invariant on every iteration:
- Iteration count ≤ `maxIterations`
- Aggregate cost (SUM of `cost_usd` from llm_calls rows logged so far) ≤ `maxCostUsd`
- `Date.now() - startedAt` ≤ `maxWallClockMs`

Each iteration:
1. Build the message list: original user message + accumulated tool_use/tool_result pairs from prior iterations.
2. Call `callLLM` with all registered tools (multi-tool) + `tool_choice: { type: 'auto' }` per **LOCK #2**. The model may emit a tool_use block OR a final text answer; the loop handles both. Phase 3.8 eval may A/B test `'required'` as a quality lever if lift undershoots target.
3. Inspect the response:
   - If `result.kind === 'toolUse'` AND tool name matches one of the data-scanning tools: invoke the registered handler, append tool_use + tool_result, continue loop.
   - If `result.kind === 'toolUse'` AND tool name matches the **terminal "answer" tool** (e.g., `emit_table_mappings`): return `{ kind: 'final', finalToolUse, ... }`.
   - If `result.kind === 'text'`: model didn't pick a tool. Treat as `schema_error` and abort.

**Termination conditions:**
| Condition | Reason field | Behavior |
|---|---|---|
| Final answer tool emitted | n/a | Returns `kind: 'final'` |
| `iterations >= maxIterations` | `'max_iterations'` | Returns `kind: 'aborted'` |
| `totalCost > maxCostUsd` | `'max_cost'` | Returns `kind: 'aborted'` |
| Wall-clock exceeded | `'max_wall_clock'` | Returns `kind: 'aborted'` |
| Tool handler returns `fatal: true` | `'tool_error'` | Returns `kind: 'aborted'` |
| `callLLM` throws | `'model_error'` | Returns `kind: 'aborted'` (error logged via existing wrapper) |
| Model emits a tool not in the registered set | `'schema_error'` | Returns `kind: 'aborted'` |

### A3. Tool dispatch

Tools are registered as `{ tool: Tool; handler: ToolHandler }` pairs. The loop:
1. Passes `tools.map(t => t.tool)` to `callLLM` via the existing `tool` parameter — **PROBLEM:** the wrapper currently accepts `tool?: Tool` (singular). PR 3.2 must extend it to `tool?: Tool | Tool[]` OR add a new `tools?: Tool[]` field. Recommend the latter to preserve backward-compat with existing single-tool callsites. Update `tool_choice` accordingly: `auto` when multi-tool; `forced-by-name` when single-tool (current behavior).
2. On response, looks up the matching handler by `toolUse.name`. If no handler, treat as final answer (the "answer tool" is the one without a registered handler).
3. Handler invocation is `await`ed serially. No parallelism within a loop iteration (Anthropic can emit only one `tool_use` block per iteration with `disable_parallel_tool_use: true`).

**Critical:** all 3 data-scanning tools register HANDLERS. The "answer" tool (e.g., `emit_table_mappings`) is registered WITHOUT a handler — when the model picks it, the loop terminates with `kind: 'final'`.

### A4. Telemetry

Each loop iteration produces ONE `llm_calls` row via the existing `callLLM` wrapper. The chain links via `parent_call_id` — a first-class column already declared in migration 082 and populated today by repair-retry chains (`mapping_generate_repair`, `nl_to_sql_retry`, `outputs_execution_package_fallback`). Per **LOCK #1**, PR 3.2 reuses this column and ships ONE small migration `084_index_parent_call_id_on_llm_calls.sql` adding a partial btree index (`WHERE parent_call_id IS NOT NULL`) for cheap chain-walking. Heads-to-tails chaining per **LOCK #3** (each iter N points at iter N-1, not all-iterations-to-iter-1):

| Iteration | parent_call_id | Notes |
|---|---|---|
| 1 (initial) | null | Same as today's single-shot calls |
| 2 | iter 1's callId | New chain link |
| ... | iter N-1's callId | |
| N (final) | iter N-1's callId | Final answer tool emitted |

`feature` is the same across all iterations (e.g., `mapping_generate`) — reusing the existing taxonomy. **No new LLMFeature enum values required.** Consumers querying `llm_calls` for a feature's cost can use:

```sql
SELECT SUM(cost_usd) FROM llm_calls WHERE feature = 'mapping_generate' AND project_id = ?
```

To distinguish single-shot vs loop, post-PR-3.2 queries use `parent_call_id IS NULL` (heads of chains) vs `IS NOT NULL` (continuations). Optionally, `metadata.agent_iteration: number` is set per iteration for direct introspection.

### A5. Caching interaction

When `cacheControl: true` is forwarded via `opts.llmOptions`, every iteration in the loop sets `cache_control: { type: 'ephemeral' }` on the system prompt + tool definitions. Anthropic's 5-min TTL means:

- **Iteration 1:** writes the cache (cache_creation_input_tokens > 0)
- **Iterations 2..N:** read the cache (cache_read_input_tokens > 0); the per-iteration system+tool prefix is identical across iterations within the loop.

This makes agent loops **structurally cache-friendly**: the read-to-write ratio for an N-iteration loop is `(N-1) / 1`. For a 4-iteration loop, ratio is 3:1 — far above the 0.28 break-even. Cache reads at 0.10× input cost mean per-iteration overhead is dominated by the variable user-message tail (tool_result blocks), not the static prefix.

Concrete cost shift expectation for a 4-iteration loop on `mapping_generate` (3000-token cached prefix, Sonnet 4.6):
- Today (single-shot): 3000 × $3.00/Mt = $0.009 prefix cost per call
- Agent loop with caching: $0.01125 (write, iter 1) + 3 × $0.0009 (reads, iter 2-4) = $0.01395 prefix cost across 4 calls
- Loop saves ~61% of prefix cost across the chain.

### A6. Error handling

- **Tool errors:** handler returns `{ result: 'error message', fatal: false }` → loop appends as a tool_result and continues; the model can retry with adjusted args. Handler returns `fatal: true` → loop aborts with `tool_error`.
- **Model errors (Anthropic 5xx):** existing `callLLM` throws on errors per [llm-client.ts:516](../../lib/ai/llm-client.ts#L516). Loop catches, returns `{ kind: 'aborted', reason: 'model_error' }`. The wrapper has already logged the error to `llm_calls`.
- **Schema validation failures:** model emits a tool_use whose input fails Anthropic's strict-mode validator → wrapper throws → caught as `model_error`. Anthropic's strict-mode boundary is the schema gate; the loop trusts it.
- **Infinite-loop guard:** `maxIterations` (default 8) is the hard ceiling. Cost cap (`maxCostUsd` default $1.00) is the soft ceiling that triggers earlier on expensive tool dispatches.
- **Unknown tool name:** handled in dispatch (§A3); returns `schema_error`.

### A7. Flag gating

New env var: `AI_PHASE_3_ENABLED` (default `'0'`, gate behavior identical to existing `AI_PHASE_2_ENABLED`).

Pattern at adopting callsites:

```typescript
const phase3Enabled = process.env.AI_PHASE_3_ENABLED === '1'
if (phase3Enabled) {
  const result = await runAgentLoop({ feature: 'mapping_generate', ... })
  // consume result
} else {
  // existing single-shot callLLM path — byte-identical
  const result = await callLLM({ feature: 'mapping_generate', ... })
}
```

Phase 3 is opt-in PER FEATURE. Adoption is gated at each callsite individually. Phase 3 default-OFF preserves heritage byte-identical (the heritage gate continues to run `AI_PHASE_2_ENABLED=0` AND `AI_PHASE_3_ENABLED=0`).

### A8. Heritage preservation

**Concrete proof:** when `AI_PHASE_3_ENABLED !== '1'`, NO code in `lib/ai/agent-loop.ts` is invoked. The flag-gated branch at each adopting callsite (per §A7) routes to the existing `callLLM` invocation, which is the SAME code that the heritage gate fingerprints today. The agent-loop module imports cause zero runtime side effects (pure type/function declarations).

The heritage integration test ([mappings-for-redesign-heritage.test.ts:101-174](../../tests/integration/mappings-for-redesign-heritage.test.ts)) computes a SHA-256 over normalized output rows. Byte-identical preserved as long as the flag stays OFF.

### A9. Test surface

**Unit tests** (in `tests/lib/agent-loop.test.ts`):
- Loop terminates on final answer tool (single-iteration smoke)
- Loop terminates on `maxIterations` cap (returns `'max_iterations'`)
- Loop terminates on `maxCostUsd` cap (mocked llm_calls cost)
- Loop terminates on `maxWallClockMs` cap (mocked clock)
- Tool handler `fatal: true` propagates as `tool_error`
- Unknown tool name in model output returns `schema_error`
- `parent_call_id` chain is correct across multi-iteration loops
- Mocked `callLLM` to avoid SDK calls — assert request shape per iteration

**Integration test** (env-gated, in `tests/integration/agent-loop-end-to-end.test.ts`):
- Real Anthropic call with 2-tool registration (1 data tool + 1 answer tool)
- Mocked tool handler (returns canned data)
- Verify `result.kind === 'final'` after ≤ 3 iterations
- Verify `llm_calls` rows are linked via `parent_call_id`
- Cost: ~$0.05–0.10 per run, env-gated under `RUN_LLM_CALLS_INTEGRATION=1`

**Heritage gate proof** (no new test; existing test must continue to pass with `AI_PHASE_3_ENABLED` unset): heritage byte-identical on `mappings-for-redesign-heritage.test.ts`.

---

## Section B — Data-scanning tool RPC contracts

Each tool exposes a question the model can ask of project data without writing arbitrary SQL. **All three RPCs are NEW.** Existing `execute_readonly_query` is unsafe (DIVERGENCE #2); `dq_field_issue_samples` is purpose-built (DIVERGENCE #3).

Common posture across all 3 RPCs:
- `LANGUAGE plpgsql SECURITY INVOKER` (NOT DEFINER — runs as the calling user, RLS applies)
- Each function's first executable statement: `IF NOT user_has_project_role(p_project_id, 'viewer') THEN RAISE EXCEPTION 'Access denied'; END IF;`
- `SET statement_timeout = '10s'` (each)
- `SET work_mem = '8MB'` (each)
- All operate on `public.data_rows` constrained by an explicit `table_id` UUID
- Verify table belongs to project via inner join: `data_rows d JOIN tables t ON d.table_id = t.id JOIN datasets ds ON t.dataset_id = ds.id WHERE ds.project_id = p_project_id`
- Return JSONB; errors raise SQL exceptions caught by the tool handler

### B1. `query_field_data` — sample N row values for one field

**Purpose:** "Show me 20 sample values from this field, optionally filtered, so I can decide what kind of validation rule to write."

**Tool schema (strict-mode compliant):**
```typescript
export const QUERY_FIELD_DATA_TOOL: Tool = {
  name: 'query_field_data',
  description:
    "Sample value(s) for a single field on the source table. Returns up to 50 row values; useful when the system prompt shows aggregate stats but the model needs to inspect individual values to decide on a rule, transformation, or quality check. The `where_filter` is optional; when supplied, it must be a single SQL fragment matching ONE column condition (e.g., \"row_data->>'status' IS NULL\"). Multiple conditions, joins, subqueries, and any DDL/DML are rejected.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: {
        type: 'string',
        description: 'UUID of the source table to sample from. Must match a table present in the system-prompt schema block.',
      },
      field_name: {
        type: 'string',
        description: 'Bare field name (no JSONB operators). The RPC extracts via row_data->>field_name internally.',
      },
      where_filter: {
        type: 'string',
        description: "Optional single-condition SQL fragment (e.g., \"row_data->>'status' IS NULL\"). Omit or pass empty string for unconditional sample. Keywords blocked: SELECT, INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE, BEGIN, COMMIT, JOIN, UNION, --, /*. Single condition only.",
      },
      limit: {
        type: 'number',
        description: 'Number of sample values to return. Server enforces ceiling of 50; values above 50 are clamped. Recommend 10-20 for general inspection, 5 for quick checks.',
      },
    },
    required: ['table_id', 'field_name'],
  },
}
```

**RPC signature:**
```sql
CREATE FUNCTION public.agent_query_field_data(
  p_project_id  UUID,
  p_table_id    UUID,
  p_field_name  TEXT,
  p_where_filter TEXT DEFAULT NULL,
  p_limit       INT  DEFAULT 20
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER
SET statement_timeout = '10s' SET work_mem = '8MB'
```

**Return shape:** `{ values: string[], total_returned: number, total_in_table_estimate: number }`. Values are field strings extracted via `row_data->>p_field_name`. `total_in_table_estimate` is `pg_class.reltuples`-based (cheap; no full COUNT).

**RLS posture:** `user_has_project_role(p_project_id, 'viewer')` gate. Inner-join via `tables` + `datasets` to enforce `p_table_id` belongs to `p_project_id`. RPC is `SECURITY INVOKER` — RLS on `data_rows` (if any) further constrains.

**Cost ceiling:**
- `p_limit` clamped to `LEAST(p_limit, 50)`
- `statement_timeout = 10s`
- `where_filter` parsed by a strict regex allowlist BEFORE EXECUTE: must match `^row_data\s*->>'[a-zA-Z_][a-zA-Z0-9_]*'\s*(IS NULL|IS NOT NULL|=|!=|<>|>|<|>=|<=)\s*('[^';]*'|[0-9]+(\.[0-9]+)?)\s*$` OR `NULL`/`empty string`. Anything else: `RAISE EXCEPTION 'Unsafe where_filter'`.

**Failure modes:**
- Invalid `p_table_id` not belonging to `p_project_id` → `RAISE EXCEPTION 'Table not in project'`
- `where_filter` doesn't match allowlist → `RAISE EXCEPTION 'Unsafe where_filter: <reason>'`
- Field doesn't exist in row_data JSONB → returns empty `values: []` (NOT an exception; field missing is information for the model)
- RLS denial → exception bubbles up; tool handler returns `fatal: true`
- Statement timeout → exception bubbles up

**Reuse vs new:** **NEW**. `dq_field_issue_samples` (migration 055) is condition-enum based, not generalizable. `execute_readonly_query` is unsafe (DIVERGENCE #2).

**Example invocation (model perspective):**
```json
{
  "type": "tool_use",
  "id": "toolu_01abc",
  "name": "query_field_data",
  "input": {
    "table_id": "...",
    "field_name": "status",
    "where_filter": "row_data->>'status' IS NULL",
    "limit": 10
  }
}
```
Tool result fed back: `{ "type": "tool_result", "tool_use_id": "toolu_01abc", "content": "{\"values\":[null,null,null,...],\"total_returned\":10,\"total_in_table_estimate\":4892}" }`.

### B2. `count_distinct_patterns` — group-by-distinct over a field

**Purpose:** "Show me the distinct values of this field with their frequencies so I can decide whether to write an enum rule, a regex, or treat as freeform."

**Tool schema:**
```typescript
export const COUNT_DISTINCT_PATTERNS_TOOL: Tool = {
  name: 'count_distinct_patterns',
  description:
    "For one field on the source table, return the most-frequent distinct values with row counts. Useful when deciding between an enum-style rule (small distinct set) and a regex/freeform rule (large distinct set). Returns up to 30 distinct values ordered by frequency desc; if the field has more than 30 distinct values, the response includes a `truncated: true` flag.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: { type: 'string', description: 'UUID of the source table.' },
      field_name: { type: 'string', description: 'Bare field name.' },
      limit: { type: 'number', description: 'Number of distinct values to return. Server clamps to 30. Recommend 10-15 for enum candidates.' },
    },
    required: ['table_id', 'field_name'],
  },
}
```

**RPC signature:**
```sql
CREATE FUNCTION public.agent_count_distinct_patterns(
  p_project_id  UUID,
  p_table_id    UUID,
  p_field_name  TEXT,
  p_limit       INT DEFAULT 15
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER
SET statement_timeout = '10s' SET work_mem = '8MB'
```

**Return shape:** `{ patterns: Array<{ value: string | null, count: number, percent: number }>, total_distinct: number, truncated: boolean }`. Percentages computed against the full table row count.

**RLS posture / cost ceiling:** identical to B1 (project-scoping gate, table-belongs-to-project join, statement_timeout=10s, p_limit clamped to LEAST(p_limit, 30)).

**Failure modes:**
- Unknown field name → returns `patterns: []` (informational, not exception)
- Statement timeout on very large tables → exception bubbles; tool handler reports timeout to model

**Reuse vs new:** **NEW**. No existing RPC does GROUP BY frequency on a JSONB field with project scoping. `execute_readonly_query` could in principle but is unsafe.

**Example invocation:**
```json
{
  "name": "count_distinct_patterns",
  "input": { "table_id": "...", "field_name": "country_code", "limit": 15 }
}
```
Tool result: `{"patterns":[{"value":"US","count":3421,"percent":0.69},{"value":"CA","count":612,"percent":0.12},...],"total_distinct":47,"truncated":true}`.

### B3. `cross_field_correlation` — co-occurrence stats between two fields

**Purpose:** "When field A has value X, what does field B usually look like? Helps decide cross-field validation rules (e.g., when status='Closed Won', amount must not be null)."

**Tool schema:**
```typescript
export const CROSS_FIELD_CORRELATION_TOOL: Tool = {
  name: 'cross_field_correlation',
  description:
    "For a SINGLE table, return joint-frequency stats for two fields A and B: how often does each (A_value, B_value) pair appear, and what's the conditional null rate of B given each value of A. Use this when deciding cross-field rules (e.g., \"when status='Closed Won', amount must not be NULL\"). Returns up to 25 (A, B) pairs ordered by joint frequency desc, plus conditional null rates for the top 10 A values.",
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      table_id: { type: 'string', description: 'UUID of the source table; both fields must reside on this table.' },
      field_a_name: { type: 'string', description: 'Bare name of the first field (the conditioning field).' },
      field_b_name: { type: 'string', description: 'Bare name of the second field (the conditioned field).' },
    },
    required: ['table_id', 'field_a_name', 'field_b_name'],
  },
}
```

**RPC signature:**
```sql
CREATE FUNCTION public.agent_cross_field_correlation(
  p_project_id   UUID,
  p_table_id     UUID,
  p_field_a_name TEXT,
  p_field_b_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER
SET statement_timeout = '15s' SET work_mem = '16MB'
```

**Return shape:**
```json
{
  "joint_top": [
    { "a": "Closed Won", "b": "12500", "count": 142 },
    { "a": "Closed Won", "b": null, "count": 8 },
    ...
  ],
  "conditional_null_rates": [
    { "a_value": "Closed Won", "a_count": 150, "b_null_count": 8, "b_null_rate": 0.053 },
    ...
  ]
}
```

**RLS posture:** identical project-scoping. Both fields verified to exist on the same table_id. `SECURITY INVOKER`.

**Cost ceiling:** `statement_timeout = 15s` (slightly higher than B1/B2 because GROUP BY two columns is more expensive). Result counts hard-clamped server-side: `joint_top` to 25 rows, `conditional_null_rates` to 10. Tables exceeding ~5M rows: rely on statement_timeout — if exceeded, exception.

**Failure modes:**
- Either field missing → empty arrays in the return shape
- Both fields refer to the same name → still valid (degenerate joint = field's own distribution); not blocked
- Timeout on large tables → exception

**Reuse vs new:** **NEW**. No existing RPC does joint frequency.

**Example invocation:**
```json
{ "name": "cross_field_correlation", "input": { "table_id": "...", "field_a_name": "stage", "field_b_name": "amount" } }
```

### B-summary: 3 NEW tool schemas + 3 NEW RPCs

Total Phase 3.3 surface:
- `lib/ai/tool-schemas.ts`: +3 exports (`QUERY_FIELD_DATA_TOOL`, `COUNT_DISTINCT_PATTERNS_TOOL`, `CROSS_FIELD_CORRELATION_TOOL`)
- New migration `085_agent_data_scanning_rpcs.sql`: +3 functions, all SECURITY INVOKER, all gated on `user_has_project_role(p_project_id, 'viewer')`
- New module `lib/ai/agent-tools.ts` (or similar): registers each tool with its RPC handler; exports the `[{tool, handler}]` array for `runAgentLoop` callers
- Tests: per-RPC unit tests + integration tests (env-gated; project + auth context required)

---

## Section C — Integration with existing callsites

### C1. `mapping_generate` as first adopter (PR 3.4)

The most natural first agent-loop adoption. Today's flow ([mapping-engine.ts:1500-1516](../../lib/ai/mapping-engine.ts#L1500-L1516)):
1. Build batched user message containing source-table schema + sample rows + target schema
2. Single `callLLM` with `EMIT_TABLE_MAPPINGS_TOOL`
3. Receive `result.toolUse.input.table_mappings`
4. Persist via existing pipeline

Phase 3 adoption sketch (NOT implementation):
```typescript
const phase3Enabled = process.env.AI_PHASE_3_ENABLED === '1'
if (phase3Enabled) {
  const result = await runAgentLoop({
    feature: 'mapping_generate',
    systemPrompt: MAPPING_GENERATION_SYSTEM_PROMPT,  // already cached per PR 13.1
    userMessage: batchUserMessage,
    tools: [
      { tool: QUERY_FIELD_DATA_TOOL, handler: makeQueryFieldDataHandler(projectId, userId) },
      { tool: COUNT_DISTINCT_PATTERNS_TOOL, handler: makeCountDistinctPatternsHandler(projectId, userId) },
      { tool: CROSS_FIELD_CORRELATION_TOOL, handler: makeCrossFieldCorrelationHandler(projectId, userId) },
      { tool: EMIT_TABLE_MAPPINGS_TOOL },  // no handler = answer tool
    ],
    projectId,
    userId,
    maxIterations: 6,
    maxCostUsd: 0.50,
    llmOptions: {
      maxTokens: PER_BATCH_MAX_TOKENS,
      promptVersion: 'mapping-v1-agent',
      cacheControl: true,  // PR 13.1
      metadata: { source_table_id: ..., batch_index: ..., agent_loop: true },
    },
  })
  if (result.kind === 'final') {
    primaryResult = { kind: 'toolUse', toolUse: result.finalToolUse, ... }
  } else {
    // aborted — fall through to a single-shot retry OR fail with reason
  }
} else {
  // existing single-shot path — heritage byte-identical
  primaryResult = await callLLM({ feature: 'mapping_generate', ... })
}
```

The agent loop's `EMIT_TABLE_MAPPINGS_TOOL` (the "answer" tool) is the same one used today. The 3 data-scanning tools are NEW. The model gets a richer toolkit but the final output shape is unchanged.

### C2. Callsites that stay non-agent (no benefit)

Per PR 13.1's cache-fit audit (12 High-fit + 5 Medium + 4 Low + 4 No), the following are NOT phase-3 candidates:
- All "stay-text" callsites: `outputs_readiness_report`, `outputs_execution_package_monolithic`, `outputs_execution_package_fallback`, `transform_describe`, `ddl_conversion` — single-shot prose output; no decision-loop benefit
- All JSON-repair retries: `mapping_generate_repair`, `mapping_generate_legacy_pair_repair`, `nl_to_sql_retry` — by design dead under tool-use
- `nl_suggest_queries` — generates 4 starter queries; no scanning needed

Likely Phase 3 adopters (post-3.4 first proof):
- `mapping_generate` (PR 3.4 first adopter)
- `quality_detection_ai` (PR 3.5 candidate — scan rows to confirm proposed issues)
- `validation_rule_from_nl` (PR 3.5 — scan field values to refine rule_config)
- `quality_fix_options` (PR 3.6 — scan to verify fix targets)
- `transform_generate` (PR 3.6 — scan to confirm column types/formats)

### C3. Eval coverage

Existing eval framework ([lib/eval/runner.ts](../../lib/eval/runner.ts), [types.ts](../../lib/eval/types.ts)) already supports per-feature scoring. For agent-loop adoption:
- **No new eval task type.** `mapping` task continues to use `scoreMappingFieldPair` — agent-loop output goes through the same persisted-row path.
- New fixture: `_fixture/mapping/002-with-data-scan.json` exercising a case where data scanning improves mapping (e.g., a source field with subtle format drift that requires `count_distinct_patterns` to detect).
- Re-baseline `_fixture/mapping/001-fixture` under `AI_PHASE_3_ENABLED=1` to measure cost + score lift. Expect: same score (1.000), higher cost (1.5-3× single-shot), much richer per-iteration telemetry.
- Phase 3 eval lift question: does agent-loop improve scoring on HARDER fixtures (002+) without regressing simple fixtures? Measured via cohort runs after 3.4 lands.

---

## Section D — Risks and open questions

### D1. Cache TTL vs loop wall-clock

**Risk:** Anthropic's 5-min ephemeral TTL is REFRESHED on each cache hit, so a multi-iteration loop generally keeps the cache warm throughout. But if a tool handler stalls (e.g., a 10s RPC × 30 iterations = 5min on tool work alone), the prefix could age out mid-loop.
**Mitigation:** `maxWallClockMs` defaults to 120_000 (2 min) — well under TTL. `maxIterations` of 8 × per-iteration ~10s = 80s typical; cap protects.
**Verification:** integration test asserts cache_read_input_tokens > 0 on iteration N for N > 1 within wall-clock budget.

### D2. Schema-grammar 503 risk on multi-tool registration

**Risk:** PR 12.2 B-2 cataloged Anthropic's grammar-compilation 503s on the LARGEST strict-mode schemas (`EMIT_EXTRACTED_PATTERNS_TOOL` and `EMIT_FIX_OPTIONS_TOOL`). Registering 4 tools (3 data tools + 1 answer tool) per loop call submits ALL 4 schemas to the grammar compiler simultaneously. Aggregate compilation cost MAY exceed any single schema's cost.
**Mitigation:** Keep the 3 data-scanning tools small (each <500 tokens of schema description per the schemas in §B). Avoid description-embedded canonical vocabularies (the trigger of the EMIT_EXTRACTED_PATTERNS 503).
**Verification:** PR 3.2's first integration test exercises the full 4-tool registration. If 503s recur, document per known-issues protocol; retry with backoff.

### D3. Cost model

**Single-shot baseline (today, mapping_generate):** $0.045 per call ([per PR 13.1 verification — Sonnet 4.6, no caching]).
**Agent loop (estimated, 4 iterations with caching):** $0.10–0.20 per call. Caching mitigates prefix overhead; output tokens (now 4× because of 4 iterations) dominate. **Net cost: ~3–4× single-shot.**
**Acceptable use:** background eval, batch operations, onboarding bursts. NOT acceptable for sync UI buttons that must return in <5s — those stay on the single-shot path.

### D4. Latency model

**Single-shot p50/p95:** ~5s / ~15s (mapping_generate).
**Agent loop p50/p95 estimate:** ~15s / ~60s (4 iterations × ~3s per LLM call + ~5s tool work + serial dispatch).
**UX implications:**
- Background eval: ✅ acceptable
- Onboarding "generate mappings" button: ⚠️ borderline; needs progress UI (PR 3.7 SSE territory)
- Sync UI single-issue actions: ❌ keep single-shot

### D5. Open questions (post-review)

1. **[RESOLVED — LOCK #2]** ~~Should the loop expose `tool_choice: 'auto'` OR `'required'`?~~ **Locked: `'auto'`.** Phase 3.8 eval may A/B test `'required'` if lift undershoots target.
2. **[RESOLVED — LOCK #3]** ~~Should `parent_call_id` chaining go heads-to-tails OR all-to-iter-1?~~ **Locked: heads-to-tails.** Each iter N points at iter N-1, matching existing repair-retry pattern.
3. **[OPEN]** Should tool handlers receive a stable session UUID for cross-iteration state? PR 3.2 ships handlers as stateless; if Phase 3.5+ needs cross-iteration state, revisit.
4. **[RESOLVED — LOCK #1]** ~~parent_call_id storage decision (JSONB metadata vs first-class column).~~ **Locked: REUSE existing first-class column on `llm_calls` (declared in 082, used today by repair-retry chains). PR 3.2 ships migration `084_index_parent_call_id_on_llm_calls.sql` adding a partial btree index for chain-walking performance — retroactively benefits both new agent-loop queries AND existing repair-retry queries.** (Note: original §D5 question #4 about `ai_edit_history` per-iteration is folded under "Single-source-of-truth for downstream audit — ONLY the final answer's persisted rows trigger `ai_edit_history`" as part of PR 3.2 implementation guidance.)
5. **[OPEN]** Should `where_filter` in `query_field_data` allow `IN (...)` lists? The strict allowlist regex in §B1 currently rejects IN. Adding it widens the safety perimeter; PR 3.3 should default to NO and revisit if the model complains.
6. **[OPEN]** Should `cross_field_correlation` accept >2 fields? Today: no (binary correlation). N-way correlation is exponentially more expensive; defer.
7. **[RESOLVED — LOCK #4]** ~~Does `runAgentLoop` need a `dryRun` mode for unit tests?~~ **Locked: yes.** PR 3.2 ships `RunAgentLoopOptions.dryRun?: boolean` accepting a mock LLM responder.

---

## Section E — Phase B implementation order and PR slicing

### E1. PR 3.2 — Loop infrastructure + tests (NO callsite migration)

**Scope:**
- New migration `084_index_parent_call_id_on_llm_calls.sql` (~10 LOC) per **LOCK #1**: partial btree index `CREATE INDEX IF NOT EXISTS idx_llm_calls_parent_call_id ON public.llm_calls(parent_call_id) WHERE parent_call_id IS NOT NULL;`. The column itself already exists (migration 082); this is a perf-only addition that benefits both new agent-loop chain-walking AND existing repair-retry chain queries.
- New file `lib/ai/agent-loop.ts` (~250 LOC) — `runAgentLoop` + types per §A1, including the `dryRun` opt-in (LOCK #4)
- Extend `CallLLMOptions` to accept `tools?: Tool[]` (alongside existing `tool?: Tool`); update wrapper to pass either to the SDK; force `tool_choice` for single-tool (current behavior), `tool_choice: { type: 'auto' }` for multi-tool per **LOCK #2**
- New unit tests `tests/lib/agent-loop.test.ts` (~200 LOC, exercises `dryRun` mock responder per LOCK #4 — no SDK calls)
- New env-gated integration test `tests/integration/agent-loop-end-to-end.test.ts` (~100 LOC)
- No callsite migration; no production behavior change
- Add `AI_PHASE_3_ENABLED` env documentation in CLAUDE.md
**Verification:** tsc + vitest + heritage byte-identical + 6 flag-OFF eval pre-flights + 5 flag-ON regressions.
**Spend:** ~$0.05–0.10 (1 integration smoke).
**LOC delta:** ~+560 / -10.

### E2. PR 3.3 — Data-scanning RPCs + tool registration + tests (NO callsite migration)

**Scope:**
- New migration `085_agent_data_scanning_rpcs.sql` (~150 LOC, 3 RPCs) — number bumped from 084 because PR 3.2's index migration takes 084
- New module `lib/ai/agent-tools.ts` (~200 LOC) — exports tool/handler factories
- 3 new tool schema exports in `lib/ai/tool-schemas.ts` (~150 LOC)
- Update `tests/lib/tool-schemas.test.ts` to expect 19 tools (16 + 3)
- New per-RPC unit tests `tests/lib/agent-tools.test.ts`
- New env-gated integration tests for each RPC `tests/integration/agent-rpcs.test.ts`
- No callsite migration
**Verification:** tsc + vitest + heritage + RPC-level RLS tests (each RPC denies cross-project access).
**Spend:** $0 (no LLM calls; integration tests hit Supabase only).
**LOC delta:** ~+650.

### E3. PR 3.4 — `mapping_generate` first adopter

**Scope:**
- Per §C1, gate the `runAgentLoop` path under `AI_PHASE_3_ENABLED` at the existing `mapping_generate` callsite ([mapping-engine.ts:1500](../../lib/ai/mapping-engine.ts#L1500))
- Wire `agent_iteration: true` into `metadata`
- New eval fixture `_fixture/mapping/002-with-data-scan.json` exercising agent-loop benefit
- Re-baseline existing `_fixture/mapping/001-fixture.json` under `AI_PHASE_3_ENABLED=1` (cost only; expect identical score)
**Verification:** tsc + vitest + heritage flag-OFF byte-identical (gate proves Phase 3 default-off preserves heritage) + flag-ON eval `mapping` regression + new fixture eval at `AI_PHASE_3_ENABLED=1`.
**Spend:** ~$0.20–0.30 (eval re-baselines + new fixture flag-ON).
**LOC delta:** ~+150.

### E4. Verification gate per PR (consolidated)

Every Phase 3 PR must pass:
1. `pnpm tsc --noEmit` clean
2. `pnpm vitest run` — full suite passing (baseline + new tests)
3. `pnpm test:integration tests/integration/mappings-for-redesign-heritage.test.ts` byte-identical to PR #23 baseline (heritage gate)
4. 6 flag-OFF eval pre-flights at $0
5. 5 flag-ON regression smokes (mapping/validation-rule/mapping-suggestion/fix-options/quality-issues) preserving baselines
6. Phase 3 path executed under `AI_PHASE_3_ENABLED=1` ONLY in PRs 3.4+; PR 3.2/3.3 ship infrastructure without callsite adoption

---

## Out of scope

- PR 3.4 implementation (Phase B work; separate prompt)
- Pipeline-specific designs (3.5 transform dry-run, 3.6 validation row sampling, 3.7 SSE UX) — separate sub-investigations
- Any LLM call (Phase A is read-only / chat-only)
- Phase 4+ (fine-tuning, embeddings, MCP, templates)

## DIVERGENCE summary (consolidated)

1. No pre-existing agent-loop scaffolding — PR 3.2 is greenfield (~550 LOC).
2. `execute_readonly_query` (migration 004) is unsafe to expose; new RPCs required (PR 3.3 ships 3).
3. `dq_field_issue_samples` (migration 055) is purpose-built; not generalizable.
4. Heritage gate is SHA-256 fingerprint equality; Phase 3 must remain entirely additive when flag is OFF.
5. `callLLMStreaming` already accepts `tool` parameter — agent loop wraps `callLLM` only; streaming surface is unchanged.

*End of PR phase3.1 — Agent decomposition design + RPC contracts (Phase A investigation).*
