// @vitest-environment node
//
/**
 * Unit tests for `lib/ai/path-d-mapping.ts` (Sub-PR 4b).
 *
 * Mocks: Anthropic SDK (fake stream factory), `buildAIContext`,
 * `persistPathDOutput`, `logAIEdit`, the path-d-config constants
 * (cost ceiling lowered so tests can drive both the pre-call and
 * mid-stream gates with realistic-sized fixture text).
 *
 * Real-DB integration of the cascade behaviour is covered by the
 * env-gated happy-path test (`tests/integration/path-d-happy-path.test.ts`).
 *
 * 7 tests:
 *   1. happy path  — full Path D run; assert llm_calls + provenance
 *   2. pre-call cost gate
 *   3. mid-stream cost ceiling abort
 *   4. parse_error in middle section — orchestrator surfaces success: true
 *      with per-section error in summary; downstream sections persist
 *   5. persistence error — orchestrator returns success: true with
 *      tfmCount=0; per-section error captured
 *   6. experiment metadata written into llm_calls.metadata
 *   7. logAIEdit emitted at orchestrator boundary with Path-D-specific shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mutable mock state (set per-test, read by mocks below) ─────────────────

interface MockableStrings {
  systemPrompt: string
  userMessage: string
}
const promptState: MockableStrings = {
  systemPrompt: 'TEST_SYSTEM_PROMPT',
  userMessage: 'TEST_USER_MESSAGE',
}

interface PersistResultLite {
  data_quality: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  mappings: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  coverage: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  lookup_tables: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  inferred_targets: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  decisions: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
  project_notes: { status: 'inserted' | 'skipped' | 'errored'; count?: number; reason?: string; error?: string }
}

const persistState: { result: PersistResultLite } = {
  result: {
    data_quality: { status: 'inserted', count: 1 },
    mappings: { status: 'inserted', count: 2 },
    coverage: { status: 'inserted', count: 3 },
    lookup_tables: { status: 'inserted', count: 1 },
    inferred_targets: { status: 'inserted', count: 1 },
    decisions: { status: 'inserted', count: 1 },
    project_notes: { status: 'inserted', count: 1 },
  },
}

const persistCalls: Array<unknown> = []

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/ai/path-d-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/ai/path-d-config')>()
  return {
    ...actual,
    // Lowered so realistic test fixture text triggers the ceiling. Real
    // production values ($25 / 48000) are out of reach in a unit test
    // without 5M-char fixtures.
    PER_PROJECT_MAX_COST_USD: 0.01,
    PATH_D_MAX_OUTPUT_TOKENS: 100,
  }
})

vi.mock('@/lib/ai/path-d-system-prompt', () => ({
  buildPathDSystemPrompt: vi.fn(() => promptState.systemPrompt),
  // INF-41: vi.fn() so tests can inspect the args passed in (the
  // intelligence-context forwarding regression guard at the bottom of
  // this file relies on `expect(buildPathDUserMessage).toHaveBeenCalledWith
  // (...)`). Pre-INF-41 this was `() => promptState.userMessage` — a
  // static stub. The conversion is byte-equivalent for existing tests
  // (the function still returns promptState.userMessage); only test-
  // surface (.mock.calls) becomes inspectable.
  buildPathDUserMessage: vi.fn(() => promptState.userMessage),
  PATH_D_SYSTEM_PROMPT: '',
}))

vi.mock('@/lib/ai/context-builder', () => ({
  buildAIContext: vi.fn(async () => ({
    project: { id: 'p1', name: 'test' },
    source_tables: [],
    target_tables: [],
    documents: { source_documents: [], target_documents: [], business_context_documents: [] },
  })),
  // The real module also exports `formatSchemaForPrompt` etc., but with
  // path-d-system-prompt mocked the orchestrator never calls them.
  formatSchemaForPrompt: () => '',
  formatDocumentsForPrompt: () => '',
  formatSchemaOverviewBlock: () => '',
}))

vi.mock('@/lib/ai/path-d-persistence', () => ({
  persistPathDOutput: vi.fn(async (args) => {
    persistCalls.push(args)
    return persistState.result
  }),
}))

// Note: lib/actions/ai-edit-history (logAIEdit) is intentionally NOT mocked.
// The orchestrator no longer routes through it — see emitPathDProvenance's
// docstring for the rationale. Provenance writes go directly through the
// injected admin's `from('ai_edit_history').insert(...)` chain, so we
// assert on the chain-tracker's recorded calls instead.

// supabase admin singleton — used as the default `admin` when args.admin is
// not supplied. The orchestrator passes through to either the real or
// injected admin; we always inject in tests so this mock is mostly an
// import-path safety net.
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {} as Record<string, unknown>,
}))

// ── Anthropic fake stream factory ──────────────────────────────────────────

interface MockEvent {
  type: 'message_start' | 'content_block_delta' | 'message_delta' | 'content_block_stop' | 'message_stop'
  message?: { usage: { input_tokens: number; output_tokens: number } }
  delta?: { type: 'text_delta'; text: string } | { type: 'other' }
  usage?: { output_tokens: number }
}

function makeFakeStream(events: MockEvent[]) {
  const abortSpy = vi.fn()
  return {
    controller: { abort: abortSpy },
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        yield e
      }
    },
  }
}

function makeFakeAnthropic(stream: ReturnType<typeof makeFakeStream>) {
  const streamSpy = vi.fn(() => stream)
  return {
    client: {
      messages: { stream: streamSpy as unknown as (req: unknown) => typeof stream },
    },
    streamSpy,
  }
}

// ── Mock supabase admin chain (track inserts; provide TFM read for provenance) ──

interface ChainCall {
  table: string
  method: string
  args: unknown[]
}

function makeMockAdmin(opts: {
  // What the TFM read in emitPathDProvenance returns
  tfmReadRows?: Array<{ id: string; target_field_id: string; confidence: number; ai_reasoning: string }>
  // Whether the llm_calls insert returns an error
  llmCallsInsertError?: { message: string }
} = {}) {
  const calls: ChainCall[] = []
  const tfmRows = opts.tfmReadRows ?? []

  const buildSelectChain = (table: string) => {
    const chain: Record<string, unknown> = {}
    const noopMethods = ['eq', 'is', 'in', 'order', 'limit']
    for (const m of noopMethods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: `select.${m}`, args })
        return chain
      }
    }
    chain.then = (onResolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: tfmRows, error: null }).then(onResolve)
    return chain
  }

  const buildInsertChain = (table: string) => {
    return Promise.resolve({
      data: null,
      error: opts.llmCallsInsertError ?? null,
    })
  }

  return {
    admin: {
      from: (table: string) => ({
        insert: (rows: unknown) => {
          calls.push({ table, method: 'insert', args: [rows] })
          return buildInsertChain(table)
        },
        select: (...args: unknown[]) => {
          calls.push({ table, method: 'select', args })
          return buildSelectChain(table)
        },
      }),
    },
    calls,
  }
}

// ── Helpers for building event sequences ───────────────────────────────────

function eventsForText(text: string, opts: { inputTokens?: number; chunks?: number } = {}): MockEvent[] {
  const inputTokens = opts.inputTokens ?? 100
  const chunks = opts.chunks ?? 4
  const chunkSize = Math.ceil(text.length / chunks)
  const evts: MockEvent[] = [
    { type: 'message_start', message: { usage: { input_tokens: inputTokens, output_tokens: 0 } } },
  ]
  for (let i = 0; i < chunks; i++) {
    const piece = text.slice(i * chunkSize, (i + 1) * chunkSize)
    if (piece.length > 0) {
      evts.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: piece } })
    }
  }
  evts.push({ type: 'message_delta', usage: { output_tokens: Math.ceil(text.length / 3.5) } })
  evts.push({ type: 'message_stop' })
  return evts
}

const HAPPY_FIXTURE = `<mappings>[{"target_field_id":"00000000-0000-4000-8000-000000000001","source_field_ids":["00000000-0000-4000-8000-000000000010"],"combination_type":"single","ai_reasoning":"r","transformation_intent":"t","mapping_cardinality":"1:1","data_quality_flag_indices":[],"confidence":0.9,"status":"needs_review"}]</mappings>
<coverage>[]</coverage>
<decisions>[]</decisions>
<lookup_tables>[]</lookup_tables>
<data_quality>[]</data_quality>
<inferred_targets>[]</inferred_targets>
<project_notes>OK</project_notes>`

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runPathDMapping — orchestrator', () => {
  beforeEach(() => {
    persistCalls.length = 0
    promptState.systemPrompt = 'TEST_SYSTEM_PROMPT'
    promptState.userMessage = 'TEST_USER_MESSAGE'
    persistState.result = {
      data_quality: { status: 'inserted', count: 1 },
      mappings: { status: 'inserted', count: 1 },
      coverage: { status: 'inserted', count: 1 },
      lookup_tables: { status: 'inserted', count: 1 },
      inferred_targets: { status: 'inserted', count: 1 },
      decisions: { status: 'inserted', count: 1 },
      project_notes: { status: 'inserted', count: 1 },
    }
  })

  // ── Test 1: happy path ─────────────────────────────────────────────────
  it('happy path — runs end-to-end, persists, writes llm_calls, emits provenance', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client, streamSpy } = makeFakeAnthropic(stream)
    const { admin, calls } = makeMockAdmin({
      tfmReadRows: [
        { id: 'tfm-1', target_field_id: 'tf-1', confidence: 0.9, ai_reasoning: 'r1' },
        { id: 'tfm-2', target_field_id: 'tf-2', confidence: 0.85, ai_reasoning: 'r2' },
      ],
    })

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.tfmCount).toBe(1) // mock returned mappings.count=1
    expect(streamSpy).toHaveBeenCalledTimes(1)
    expect(persistCalls).toHaveLength(1)
    // llm_calls insert recorded
    const llmCallsInsert = calls.find((c) => c.table === 'llm_calls' && c.method === 'insert')
    expect(llmCallsInsert).toBeDefined()
    // provenance: 2 ai_edit_history rows (one per TFM in the read mock)
    const aehInsert = calls.find((c) => c.table === 'ai_edit_history' && c.method === 'insert')
    expect(aehInsert).toBeDefined()
    expect((aehInsert!.args[0] as unknown[]).length).toBe(2)
  })

  // ── Test 2: pre-call cost gate ─────────────────────────────────────────
  it('pre-call cost gate — huge prompt triggers ceiling; stream is NOT opened', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    promptState.systemPrompt = 'X'.repeat(200_000) // ~57k tokens; far above $0.01 ceiling
    const stream = makeFakeStream([])
    const { client, streamSpy } = makeFakeAnthropic(stream)
    const { admin } = makeMockAdmin()

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.errorCode).toBe('COST_CEILING')
    expect(result.error).toContain('pre-call')
    expect(streamSpy).not.toHaveBeenCalled() // gate fired BEFORE stream open
    expect(persistCalls).toHaveLength(0) // never reached persistence
  })

  // ── Test 3: mid-stream cost ceiling abort ──────────────────────────────
  it('mid-stream cost ceiling — aborts stream, persists what arrived, returns COST_CEILING', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    // Build event sequence: many text_deltas of moderate size so cumulative
    // output tokens crosses the lowered $0.01 ceiling at roughly the 50th
    // delta (when the orchestrator samples).
    const chunk = 'x'.repeat(50)
    const events: MockEvent[] = [
      { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 } } },
    ]
    // 80 deltas × 50 chars = 4000 chars ≈ 1143 tokens output → cost
    // ≈ (100*5 + 1143*25) / 1M ≈ $0.029, exceeding the $0.01 ceiling.
    for (let i = 0; i < 80; i++) {
      events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } })
    }

    const stream = makeFakeStream(events)
    const { client } = makeFakeAnthropic(stream)
    const { admin } = makeMockAdmin()

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.errorCode).toBe('COST_CEILING')
    expect(result.error).toContain('mid-stream')
    expect(stream.controller.abort).toHaveBeenCalledTimes(1)
    // Persistence runs even when aborted (per-section recovery design)
    expect(persistCalls).toHaveLength(1)
  })

  // ── Test 4: parse_error in middle section ──────────────────────────────
  it('parse_error in middle section — orchestrator returns success; per-section error in summary', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    persistState.result = {
      ...persistState.result,
      lookup_tables: { status: 'errored', error: 'simulated lookup_tables insert failed' },
    }
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin } = makeMockAdmin({
      tfmReadRows: [{ id: 'tfm-1', target_field_id: 'tf-1', confidence: 0.9, ai_reasoning: 'r' }],
    })

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.summary.lookup_tables.status).toBe('errored')
    expect(result.summary.mappings.status).toBe('inserted') // upstream still ok
    expect(result.summary.project_notes.status).toBe('inserted') // downstream still ok
  })

  // ── Test 5: persistence error on mappings ──────────────────────────────
  it('persistence error on mappings — returns success: true with tfmCount=0; provenance NOT emitted', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    persistState.result = {
      ...persistState.result,
      mappings: { status: 'errored', error: 'simulated TFM upsert failed' },
    }
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin, calls } = makeMockAdmin()

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.tfmCount).toBe(0)
    expect(result.summary.mappings.status).toBe('errored')
    // Provenance guarded on mappings.status === 'inserted'; no ai_edit_history insert
    const aehInsert = calls.find((c) => c.table === 'ai_edit_history' && c.method === 'insert')
    expect(aehInsert).toBeUndefined()
  })

  // ── Test 6: experiment metadata written into llm_calls.metadata ────────
  it('experiment metadata — llm_calls insert payload carries pathDExperimentMetadata fields', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin, calls } = makeMockAdmin({ tfmReadRows: [] })

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(true)
    const llmCallsInsert = calls.find((c) => c.table === 'llm_calls' && c.method === 'insert')
    expect(llmCallsInsert).toBeDefined()
    const row = (llmCallsInsert!.args[0] as Record<string, unknown>)
    const meta = row.metadata as Record<string, unknown>
    expect(meta.experiment_label).toBe('path_d')
    expect(typeof meta.experiment_run_id).toBe('string')
    expect(meta.max_output_tokens).toBe(100) // matches mocked path-d-config override
    expect(typeof meta.max_cost_usd).toBe('number')
    expect(row.feature).toBe('mapping_generate')
    expect(row.model).toBe('claude-opus-4-7')
    expect(row.is_streaming).toBe(true)
    expect(row.prompt_version).toBe('path-d-v0')
  })

  // ── Test 7: provenance row shape ───────────────────────────────────────
  it('ai_edit_history shape — per-TFM rows with experiment_label and run_method in metadata', async () => {
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin, calls } = makeMockAdmin({
      tfmReadRows: [
        { id: 'tfm-A', target_field_id: 'tf-A', confidence: 0.92, ai_reasoning: 'rA' },
        { id: 'tfm-B', target_field_id: 'tf-B', confidence: 0.78, ai_reasoning: 'rB' },
        { id: 'tfm-C', target_field_id: 'tf-C', confidence: 0.65, ai_reasoning: 'rC' },
      ],
    })

    const result = await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(result.success).toBe(true)
    const aehInsert = calls.find((c) => c.table === 'ai_edit_history' && c.method === 'insert')
    expect(aehInsert).toBeDefined()
    const rows = aehInsert!.args[0] as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.entity_type).toBe('target_field_mapping')
      expect(row.edit_kind).toBe('ai_proposed')
      expect(row.field_path).toBe('confidence')
      expect(row.old_value).toBeNull()
      const meta = row.metadata as Record<string, unknown>
      expect(meta.experiment_label).toBe('path_d')
      expect(meta.run_method).toBe('path_d_monolithic')
      expect(typeof meta.experiment_run_id).toBe('string')
      const newVal = row.new_value as Record<string, unknown>
      expect(typeof newVal.confidence).toBe('number')
      expect(typeof newVal.ai_reasoning).toBe('string')
      expect(typeof newVal.target_field_id).toBe('string')
    }
  })

  // ── Test 8: INF-41 regression guard — intelligence forwarding ──────────
  it('INF-41 — forwards ctx.intelligence_context as intelligenceCtx to buildPathDUserMessage', async () => {
    // Pre-INF-41 the orchestrator called `buildPathDUserMessage({ ctx })`
    // and silently dropped the intelligence block — buildAIContext
    // populates ctx.intelligence_context (when userId is supplied) but
    // the optional intelligenceCtx arg on the builder is the actual
    // read path. Surfaced by the context-flow audit (PR #107) as a
    // load-bearing gap because every Path D run since #103 had been
    // intelligence-OFF in production. This test pins the call-site
    // forwarding so a future refactor that drops the arg again fails.
    const MARKER = 'INF_41_ORCHESTRATOR_MARKER_xyz123'
    const { buildAIContext } = await import('@/lib/ai/context-builder')
    vi.mocked(buildAIContext).mockResolvedValueOnce({
      project_id: 'p1',
      project_name: 'test',
      source_tables: [],
      target_tables: [],
      documents: {
        source_documents: [],
        target_documents: [],
        business_context_documents: [],
      },
      intelligence_context: MARKER,
    })

    const { buildPathDUserMessage } = await import('@/lib/ai/path-d-system-prompt')
    vi.mocked(buildPathDUserMessage).mockClear()

    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin } = makeMockAdmin({
      tfmReadRows: [{ id: 'tfm-1', target_field_id: 'tf-1', confidence: 0.9, ai_reasoning: 'r' }],
    })

    await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(vi.mocked(buildPathDUserMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ intelligenceCtx: MARKER }),
    )
  })

  // ── Test 9: INF-41 negative — empty intelligence_context flows through ─
  it('INF-41 — empty ctx.intelligence_context still forwards (preserves intelligence-OFF baseline shape)', async () => {
    // Verify the call-site forwarding works for the empty-string path
    // too. The builder's null guard (intelligenceCtx ? ...) handles the
    // empty-string case at render time (empty string is falsy in the
    // ternary), so an empty forward produces a byte-identical prompt
    // to the pre-INF-41 dropped behavior. This pins that shape so a
    // future refactor that adds a `?? null` collapse or similar won't
    // accidentally change rendered prompt bytes.
    const { buildAIContext } = await import('@/lib/ai/context-builder')
    vi.mocked(buildAIContext).mockResolvedValueOnce({
      project_id: 'p1',
      project_name: 'test',
      source_tables: [],
      target_tables: [],
      documents: {
        source_documents: [],
        target_documents: [],
        business_context_documents: [],
      },
      intelligence_context: '',
    })

    const { buildPathDUserMessage } = await import('@/lib/ai/path-d-system-prompt')
    vi.mocked(buildPathDUserMessage).mockClear()

    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const stream = makeFakeStream(eventsForText(HAPPY_FIXTURE, { inputTokens: 100 }))
    const { client } = makeFakeAnthropic(stream)
    const { admin } = makeMockAdmin({
      tfmReadRows: [{ id: 'tfm-1', target_field_id: 'tf-1', confidence: 0.9, ai_reasoning: 'r' }],
    })

    await runPathDMapping({
      projectId: 'p1',
      userId: 'u1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      anthropicClient: client,
      admin: admin as never,
    })

    expect(vi.mocked(buildPathDUserMessage)).toHaveBeenCalledWith(
      expect.objectContaining({ intelligenceCtx: '' }),
    )
  })
})
