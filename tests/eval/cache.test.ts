// @vitest-environment node
//
// Cache unit tests — mocks supabaseAdmin to verify the SELECT shape
// and the hit/miss paths without hitting a real database. The
// integration test in PR 10.4 will exercise the real DB path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { selectChain, fromSpy } = vi.hoisted(() => {
  // Mutable container for the next .maybeSingle() result. Tests assign
  // to `nextResult` to control hit vs miss.
  const state: { nextResult: { data: unknown; error: unknown } } = {
    nextResult: { data: null, error: null },
  }
  // Build a chain that supports the exact methods called by checkCache:
  //   .from('llm_calls').select(...).eq(...).eq(...).eq(...).eq(...)
  //   .gte(...).order(...).limit(...).maybeSingle()
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    gte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => state.nextResult),
  }
  const fromSpy = vi.fn(() => chain)
  return { selectChain: chain, fromSpy, state } as unknown as {
    selectChain: typeof chain
    fromSpy: typeof fromSpy
    state: { nextResult: { data: unknown; error: unknown } }
  }
})

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: { from: fromSpy },
}))

import { checkCache, shortHash } from '@/lib/eval/cache'

// Allow tests to flip the next maybeSingle() result.
function setNextResult(data: unknown, error: unknown = null) {
  ;(selectChain.maybeSingle as unknown as { mockResolvedValueOnce: (v: unknown) => unknown }).mockResolvedValueOnce(
    { data, error },
  )
}

describe('shortHash', () => {
  it('produces a 16-char hex prefix of SHA-256', () => {
    const h = shortHash('hello')
    expect(h).toHaveLength(16)
    expect(/^[0-9a-f]{16}$/.test(h)).toBe(true)
  })

  it('is stable across calls', () => {
    expect(shortHash('the quick brown fox')).toBe(shortHash('the quick brown fox'))
  })

  it('differs for different inputs', () => {
    expect(shortHash('a')).not.toBe(shortHash('b'))
  })

  it('trims whitespace before hashing (matches lib/ai/llm-client.ts)', () => {
    expect(shortHash('hello')).toBe(shortHash('  hello  '))
  })
})

describe('checkCache — hit/miss', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fromSpy.mockClear()
    selectChain.maybeSingle.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns hit when a matching row exists', async () => {
    setNextResult({
      id: 'call-1',
      response_text: 'cached response text',
      created_at: '2026-05-01T12:00:00Z',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.0012,
    })
    const result = await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'system',
      userMessage: 'user',
    })
    expect(result.hit).toBe(true)
    if (result.hit) {
      expect(result.responseText).toBe('cached response text')
      expect(result.llmCallId).toBe('call-1')
      expect(result.inputTokens).toBe(100)
    }
    expect(fromSpy).toHaveBeenCalledWith('llm_calls')
  })

  it('returns miss when no matching row exists', async () => {
    setNextResult(null)
    const result = await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'unique system',
      userMessage: 'unique user',
    })
    expect(result.hit).toBe(false)
  })

  it('returns miss when row has null response_text (defensive)', async () => {
    setNextResult({
      id: 'call-1',
      response_text: null,
      created_at: '2026-05-01T12:00:00Z',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    })
    const result = await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'system',
      userMessage: 'user',
    })
    expect(result.hit).toBe(false)
  })

  it('returns miss with maxAgeDays=0 (cache disabled) without querying', async () => {
    const result = await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'system',
      userMessage: 'user',
      maxAgeDays: 0,
    })
    expect(result.hit).toBe(false)
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('soft-skips when llm_calls table does not exist (migration not applied)', async () => {
    setNextResult(null, { message: 'relation "llm_calls" does not exist' })
    const result = await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'system',
      userMessage: 'user',
    })
    expect(result.hit).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('throws on other database errors', async () => {
    setNextResult(null, { message: 'permission denied' })
    await expect(
      checkCache({
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'system',
        userMessage: 'user',
      }),
    ).rejects.toThrow(/Lookup failed/)
  })
})

describe('checkCache — query shape', () => {
  beforeEach(() => {
    fromSpy.mockClear()
    selectChain.eq.mockClear()
    selectChain.gte.mockClear()
    selectChain.order.mockClear()
    selectChain.limit.mockClear()
    selectChain.maybeSingle.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters by model + both prompt hashes + succeeded=true', async () => {
    setNextResult(null)
    await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'sys',
      userMessage: 'usr',
    })
    const eqCalls = (selectChain.eq as unknown as { mock: { calls: [string, unknown][] } }).mock.calls
    const eqMap = new Map(eqCalls.map((c) => [c[0], c[1]]))
    expect(eqMap.get('model')).toBe('claude-sonnet-4-20250514')
    expect(eqMap.get('system_prompt_hash')).toBe(shortHash('sys'))
    expect(eqMap.get('user_message_hash')).toBe(shortHash('usr'))
    expect(eqMap.get('succeeded')).toBe(true)
  })

  it('orders by created_at DESC and limits to 1', async () => {
    setNextResult(null)
    await checkCache({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'sys',
      userMessage: 'usr',
    })
    const orderCalls = (selectChain.order as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(orderCalls[0]![0]).toBe('created_at')
    expect(orderCalls[0]![1]).toMatchObject({ ascending: false })
    const limitCalls = (selectChain.limit as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(limitCalls[0]![0]).toBe(1)
  })
})
