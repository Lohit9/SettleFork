// @vitest-environment node
//
// Unit tests for the Path D SSE streaming endpoint.
//
// Tests split between two surfaces:
//   - Route-level (POST /api/projects/[projectId]/mapping/path-d/stream):
//     auth, permission, body validation. Mock supabase + permission via
//     vi.mock + mutable factory state.
//   - Handler-level (pathDSseStreamHandler): precondition gate, event
//     sequence, error path, cancellation. Call directly with injection
//     so we don't need to mock the underlying modules globally.
//
// 8 tests total per Sub-PR 5 Stop 1 plan.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mutable mock state for route-level tests ────────────────────────────────
// supabase getUser + requireProjectPermission swap their resolved values
// per-test. Shared mock state is the simplest pattern for vitest hoisting.

interface MockAuthState {
  user: { id: string } | null
  permissionAllowed: boolean
  permissionError: string
}

const authState: MockAuthState = {
  user: { id: 'u-1' },
  permissionAllowed: true,
  permissionError: '',
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: authState.user } })),
    },
  })),
}))

vi.mock('@/lib/actions/role-resolution', () => ({
  requireProjectPermission: vi.fn(async () => ({
    allowed: authState.permissionAllowed,
    error: authState.permissionAllowed ? undefined : authState.permissionError,
  })),
}))

// Stub supabase admin so the precondition helper's field-count query
// doesn't blow up if any test reaches that code path. Tests that
// exercise preconditions inject their own admin via the handler's
// `injection.admin` arg; this stub is for the route-level path.
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        in: vi.fn(async () => ({ count: 0 })),
      })),
    })),
  },
}))

// Stub the handler so route-level tests can assert the handler's args
// without spinning up the full orchestrator chain. Per-test `mockImpl`
// override lets us return different streams (for the happy-path test
// we let the real handler run with injection).
const handlerSpy = vi.fn<(args: unknown) => ReadableStream<Uint8Array>>()
vi.mock('@/lib/ai/path-d-stream-handler', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/ai/path-d-stream-handler')>()
  return {
    ...actual,
    pathDSseStreamHandler: (args: unknown) => handlerSpy(args),
  }
})

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close()
    },
  })
}

async function readSseBody(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let body = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    body += decoder.decode(value, { stream: true })
  }
  body += decoder.decode()
  return body
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? ''
      const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}'
      return { event, data: JSON.parse(dataLine) }
    })
}

function makeRequest(body: unknown): Request {
  return new Request('http://test.local/api/path-d/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PROJECT_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ROUTE_CONTEXT = { params: Promise.resolve({ projectId: PROJECT_ID }) }

beforeEach(() => {
  authState.user = { id: 'u-1' }
  authState.permissionAllowed = true
  authState.permissionError = ''
  handlerSpy.mockReset()
  handlerSpy.mockImplementation(() => emptyStream())
})

// ── Route-level tests ──────────────────────────────────────────────────────

describe('POST /api/projects/[projectId]/mapping/path-d/stream — route-level', () => {
  it('Test 1: 401 when unauthenticated (no user session)', async () => {
    authState.user = null
    const { POST } = await import(
      '@/app/api/projects/[projectId]/mapping/path-d/stream/route'
    )
    const res = await POST(
      makeRequest({ sourceTableIds: ['s1'], targetTableIds: ['t1'] }),
      ROUTE_CONTEXT,
    )
    expect(res.status).toBe(401)
    expect(handlerSpy).not.toHaveBeenCalled()
    const body = (await res.json()) as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/auth/i)
  })

  it('Test 2: 403 when user lacks editor permission', async () => {
    authState.permissionAllowed = false
    authState.permissionError = 'Insufficient permissions. Required role: editor'
    const { POST } = await import(
      '@/app/api/projects/[projectId]/mapping/path-d/stream/route'
    )
    const res = await POST(
      makeRequest({ sourceTableIds: ['s1'], targetTableIds: ['t1'] }),
      ROUTE_CONTEXT,
    )
    expect(res.status).toBe(403)
    expect(handlerSpy).not.toHaveBeenCalled()
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/Insufficient permissions/i)
  })

  it('Test 3: 400 when body is malformed (missing/empty arrays)', async () => {
    const { POST } = await import(
      '@/app/api/projects/[projectId]/mapping/path-d/stream/route'
    )
    // Empty arrays
    const res1 = await POST(
      makeRequest({ sourceTableIds: [], targetTableIds: ['t1'] }),
      ROUTE_CONTEXT,
    )
    expect(res1.status).toBe(400)
    // Missing fields
    const res2 = await POST(makeRequest({}), ROUTE_CONTEXT)
    expect(res2.status).toBe(400)
    // Non-string array elements
    const res3 = await POST(
      makeRequest({ sourceTableIds: [1, 2], targetTableIds: ['t1'] }),
      ROUTE_CONTEXT,
    )
    expect(res3.status).toBe(400)
    expect(handlerSpy).not.toHaveBeenCalled()
  })
})

// ── Handler-level tests ────────────────────────────────────────────────────
//
// Tests invoke `pathDSseStreamHandler` directly with `injection` so we can
// substitute a mock orchestrator without `vi.mock`'ing the actual module
// (the route-level mock above intercepts the route's import; handler-level
// tests need to test the REAL handler, so we use vi.unmock to restore it).

describe('pathDSseStreamHandler — handler-level', () => {
  it('Test 4: precondition FLAG_OFF emits single error event then closes', async () => {
    const prevFlag = process.env.AI_MAPPING_PATH_D_ENABLED
    delete process.env.AI_MAPPING_PATH_D_ENABLED

    const { pathDSseStreamHandler } = await vi.importActual<
      typeof import('@/lib/ai/path-d-stream-handler')
    >('@/lib/ai/path-d-stream-handler')

    const stream = pathDSseStreamHandler({
      projectId: PROJECT_ID,
      userId: 'u-1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      injection: {
        runOrchestrator: vi.fn(async () => {
          throw new Error('orchestrator should NOT be called when flag is off')
        }),
        admin: { from: () => ({ select: () => ({ in: async () => ({ count: 0 }) }) }) } as never,
      },
    })

    const body = await readSseBody(stream)
    const events = parseSseEvents(body)
    expect(events).toHaveLength(1)
    expect(events[0]!.event).toBe('error')
    const data = events[0]!.data as { kind: string; phase: string; message: string }
    expect(data.kind).toBe('error')
    expect(data.phase).toBe('precondition')
    expect(data.message).toMatch(/AI_MAPPING_PATH_D_ENABLED/i)

    if (prevFlag !== undefined) process.env.AI_MAPPING_PATH_D_ENABLED = prevFlag
  })

  it('Test 5: precondition OVER_THRESHOLD emits single error event then closes', async () => {
    process.env.AI_MAPPING_PATH_D_ENABLED = '1'

    const { pathDSseStreamHandler } = await vi.importActual<
      typeof import('@/lib/ai/path-d-stream-handler')
    >('@/lib/ai/path-d-stream-handler')

    const adminOverThreshold = {
      from: () => ({
        select: () => ({ in: async () => ({ count: 999 }) }),
      }),
    }

    const stream = pathDSseStreamHandler({
      projectId: PROJECT_ID,
      userId: 'u-1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      injection: {
        runOrchestrator: vi.fn(async () => {
          throw new Error('orchestrator should NOT be called when over threshold')
        }),
        admin: adminOverThreshold as never,
      },
    })

    const body = await readSseBody(stream)
    const events = parseSseEvents(body)
    expect(events).toHaveLength(1)
    const data = events[0]!.data as { phase: string; message: string }
    expect(data.phase).toBe('precondition')
    expect(data.message).toMatch(/exceeding the Path D monolithic threshold/i)

    delete process.env.AI_MAPPING_PATH_D_ENABLED
  })

  it('Test 6: happy path — orchestrator events flow through to SSE in order', async () => {
    process.env.AI_MAPPING_PATH_D_ENABLED = '1'

    const { pathDSseStreamHandler } = await vi.importActual<
      typeof import('@/lib/ai/path-d-stream-handler')
    >('@/lib/ai/path-d-stream-handler')

    // Mock orchestrator that synchronously fires the canonical event
    // sequence through onEvent before resolving.
    const mockOrchestrator = vi.fn(async (args: { onEvent?: (e: unknown) => void }) => {
      const e = args.onEvent!
      e({ kind: 'section_completed', section: 'mappings' })
      e({ kind: 'cost_update', outputTokens: 100, estimatedCostUsd: 0.005 })
      e({ kind: 'section_completed', section: 'coverage' })
      e({ kind: 'section_persisted', section: 'data_quality', status: 'inserted', count: 5 })
      e({ kind: 'section_persisted', section: 'mappings', status: 'inserted', count: 26 })
      e({ kind: 'done', runId: 'r-1', summary: { mappings: { status: 'inserted', count: 26 } } })
      return { success: true }
    })

    const stream = pathDSseStreamHandler({
      projectId: PROJECT_ID,
      userId: 'u-1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      injection: {
        runOrchestrator: mockOrchestrator as never,
        admin: { from: () => ({ select: () => ({ in: async () => ({ count: 50 }) }) }) } as never,
      },
    })

    const body = await readSseBody(stream)
    const events = parseSseEvents(body)
    expect(events.map((e) => e.event)).toEqual([
      'section_completed',
      'cost_update',
      'section_completed',
      'section_persisted',
      'section_persisted',
      'done',
    ])
    const done = events[5]!.data as { kind: string; runId: string }
    expect(done.kind).toBe('done')
    expect(done.runId).toBe('r-1')
    expect(mockOrchestrator).toHaveBeenCalledTimes(1)

    delete process.env.AI_MAPPING_PATH_D_ENABLED
  })

  it('Test 7: orchestrator throws → handler emits internal error event and closes', async () => {
    process.env.AI_MAPPING_PATH_D_ENABLED = '1'

    const { pathDSseStreamHandler } = await vi.importActual<
      typeof import('@/lib/ai/path-d-stream-handler')
    >('@/lib/ai/path-d-stream-handler')

    const mockOrchestrator = vi.fn(async (args: { onEvent?: (e: unknown) => void }) => {
      // Emit one event, then throw uncaught.
      args.onEvent!({ kind: 'section_completed', section: 'mappings' })
      throw new Error('boom — synthetic uncaught failure')
    })

    const stream = pathDSseStreamHandler({
      projectId: PROJECT_ID,
      userId: 'u-1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      injection: {
        runOrchestrator: mockOrchestrator as never,
        admin: { from: () => ({ select: () => ({ in: async () => ({ count: 50 }) }) }) } as never,
      },
    })

    const body = await readSseBody(stream)
    const events = parseSseEvents(body)
    expect(events.map((e) => e.event)).toEqual(['section_completed', 'error'])
    const errEvent = events[1]!.data as { phase: string; message: string }
    expect(errEvent.phase).toBe('internal')
    expect(errEvent.message).toMatch(/boom/)

    delete process.env.AI_MAPPING_PATH_D_ENABLED
  })

  it('Test 8: external abort signal cascades through to the orchestrator', async () => {
    process.env.AI_MAPPING_PATH_D_ENABLED = '1'

    const { pathDSseStreamHandler } = await vi.importActual<
      typeof import('@/lib/ai/path-d-stream-handler')
    >('@/lib/ai/path-d-stream-handler')

    const abortCtrl = new AbortController()
    let observedSignal: AbortSignal | undefined

    const mockOrchestrator = vi.fn(async (args: { abortSignal?: AbortSignal; onEvent?: (e: unknown) => void }) => {
      observedSignal = args.abortSignal
      // Wait for the abort signal to fire, then resolve with no events
      // (mirrors what the real orchestrator would do — abort cascades
      // and persistence runs on whatever was buffered, then return).
      await new Promise<void>((resolve) => {
        if (args.abortSignal?.aborted) return resolve()
        args.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { success: true }
    })

    const stream = pathDSseStreamHandler({
      projectId: PROJECT_ID,
      userId: 'u-1',
      sourceTableIds: ['s1'],
      targetTableIds: ['t1'],
      abortSignal: abortCtrl.signal,
      injection: {
        runOrchestrator: mockOrchestrator as never,
        admin: { from: () => ({ select: () => ({ in: async () => ({ count: 50 }) }) }) } as never,
      },
    })

    // Trigger the abort, then drain the stream — should close cleanly.
    abortCtrl.abort()
    const body = await readSseBody(stream)
    const events = parseSseEvents(body)
    // No events were emitted in the mock, but the stream closed cleanly.
    expect(events).toEqual([])
    expect(observedSignal).toBe(abortCtrl.signal)
    expect(observedSignal?.aborted).toBe(true)

    delete process.env.AI_MAPPING_PATH_D_ENABLED
  })
})
