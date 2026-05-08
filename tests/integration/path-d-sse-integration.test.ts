// @vitest-environment node
//
// Path D SSE streaming integration — REAL Anthropic + Supabase, env-gated.
//
// Cost: ~$1 per run on Rootstock POC scale (matches Sub-PR 4b's
// happy-path; same orchestrator code path, just with the streaming
// observer attached). NOT default vitest. NOT CI.
//
// What this verifies (end-to-end, the only place it can be):
//   1. pathDSseStreamHandler produces a valid SSE stream against the
//      real Path D pipeline — preconditions resolve, orchestrator runs,
//      events fire, stream closes cleanly.
//   2. Event sequence shape matches the Sub-PR 5 protocol:
//      ≥1 cost_update during streaming, ≥7 section_completed
//      (one per LLM-emitted section), ≥7 section_persisted (one per
//      persistence attempt), exactly 1 terminal done.
//   3. The done event's runId + summary match the persistence
//      side effects (sanity check on the protocol's terminal contract).
//
// Hits `pathDSseStreamHandler` directly with the admin injection
// (not through the Route Handler) so we don't need to mock cookies +
// auth. The Route Handler's auth/permission paths are covered by
// `tests/api/path-d-stream.test.ts:Test 1-3`.
//
// Env required:
//   RUN_PATH_D_SSE_INTEGRATION=1
//   ANTHROPIC_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PATH_D_HAPPY_PATH_USER_ID  (a real user UUID with Rootstock POC editor access)
//
// Project ID is locked to Rootstock POC in code (matching the Sub-PR 4b
// happy-path test) — env override not supported, by design.

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const ROOTSTOCK_POC_PROJECT_ID = '894eeb8e-73b1-471c-afc3-1c39225de19e'

const RUN = process.env.RUN_PATH_D_SSE_INTEGRATION === '1'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC = process.env.ANTHROPIC_API_KEY
const USER_ID = process.env.PATH_D_HAPPY_PATH_USER_ID ?? ''

const ENV_OK =
  Boolean(URL) &&
  Boolean(SERVICE_KEY) &&
  Boolean(ANTHROPIC) &&
  Boolean(USER_ID)

const describeIf = RUN && ENV_OK ? describe : describe.skip

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

async function readSseBody(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
  }
  buffer += decoder.decode()
  return buffer
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? ''
      const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '{}'
      return { event, data: JSON.parse(dataLine) }
    })
}

describeIf('Path D SSE — integration (real Opus 4.7 + Rootstock POC)', () => {
  let admin: SupabaseClient

  beforeAll(() => {
    process.env.AI_MAPPING_PATH_D_ENABLED = '1'
    admin = createClient(URL!, SERVICE_KEY!)
  })

  it('SSE stream runs end-to-end and emits the expected event sequence', async () => {
    // Resolve source/target table IDs at runtime (test resilient to
    // canary-state edits — same pattern as Sub-PR 4b's happy-path).
    const { data: datasets } = await admin
      .from('datasets')
      .select('id, role')
      .eq('project_id', ROOTSTOCK_POC_PROJECT_ID)
    const sourceDsIds = (datasets ?? [])
      .filter((d) => d.role === 'source')
      .map((d) => d.id as string)
    const targetDsIds = (datasets ?? [])
      .filter((d) => d.role === 'target')
      .map((d) => d.id as string)
    const { data: sourceTables } = await admin
      .from('tables')
      .select('id')
      .in('dataset_id', sourceDsIds)
    const { data: targetTables } = await admin
      .from('tables')
      .select('id')
      .in('dataset_id', targetDsIds)
    const sourceTableIds = (sourceTables ?? []).map((t) => t.id as string)
    const targetTableIds = (targetTables ?? []).map((t) => t.id as string)
    expect(sourceTableIds.length).toBeGreaterThan(0)
    expect(targetTableIds.length).toBeGreaterThan(0)

    // Dynamic import keeps Anthropic SDK construction out of the test
    // file's top-level module load (matches Sub-PR 4b's happy-path).
    const { pathDSseStreamHandler } = await import(
      '@/lib/ai/path-d-stream-handler'
    )

    const t0 = Date.now()
    const stream = pathDSseStreamHandler({
      projectId: ROOTSTOCK_POC_PROJECT_ID,
      userId: USER_ID,
      sourceTableIds,
      targetTableIds,
      injection: { admin },
    })

    const events = await readSseBody(stream)
    const elapsed = Date.now() - t0
    // eslint-disable-next-line no-console
    console.log(
      `[path-d-sse] elapsed=${elapsed}ms eventCount=${events.length} ` +
        `kinds=${events.map((e) => e.event).join(',').slice(0, 200)}`,
    )

    // ── Assertion 1: At least one cost_update during streaming.
    const costUpdates = events.filter((e) => e.event === 'cost_update')
    expect(costUpdates.length).toBeGreaterThanOrEqual(1)

    // ── Assertion 2: All 7 sections completed (close-tag detected).
    const completed = events.filter((e) => e.event === 'section_completed')
    expect(completed.length).toBe(7)
    const completedSections = new Set(completed.map((e) => e.data.section))
    for (const section of [
      'mappings',
      'coverage',
      'decisions',
      'lookup_tables',
      'data_quality',
      'inferred_targets',
      'project_notes',
    ]) {
      expect(completedSections.has(section)).toBe(true)
    }

    // ── Assertion 3: All 7 sections persisted (status reported).
    const persisted = events.filter((e) => e.event === 'section_persisted')
    expect(persisted.length).toBe(7)
    const persistedSections = new Set(persisted.map((e) => e.data.section))
    for (const section of [
      'mappings',
      'coverage',
      'decisions',
      'lookup_tables',
      'data_quality',
      'inferred_targets',
      'project_notes',
    ]) {
      expect(persistedSections.has(section)).toBe(true)
    }

    // ── Assertion 4: Mappings section shows 'inserted' with comprehensive count.
    const mappingsPersist = persisted.find((e) => e.data.section === 'mappings')
    expect(mappingsPersist).toBeDefined()
    expect(mappingsPersist!.data.status).toBe('inserted')
    const mappingsCount = mappingsPersist!.data.count as number
    expect(mappingsCount).toBeGreaterThanOrEqual(10)

    // ── Assertion 5: Exactly one terminal `done` event; no `error`.
    const done = events.filter((e) => e.event === 'done')
    const errors = events.filter((e) => e.event === 'error')
    expect(done).toHaveLength(1)
    expect(errors).toHaveLength(0)

    // ── Assertion 6: Done event carries a runId matching a real DB row.
    const doneData = done[0]!.data as { runId: string; summary: Record<string, unknown> }
    expect(doneData.runId).toMatch(/^[0-9a-f-]{36}$/)

    const { count: tfmCount } = await admin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', ROOTSTOCK_POC_PROJECT_ID)
      .eq('experiment_run_id', doneData.runId)
    expect(tfmCount ?? 0).toBeGreaterThanOrEqual(10)
  }, 600_000) // 10-minute timeout (matches Sub-PR 4b happy-path)
})
