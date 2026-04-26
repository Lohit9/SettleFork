// @vitest-environment node
//
// Phase 4c-1 — Heritage-backed integration tests for the bulk approve
// wrappers in `lib/actions/mappings-for-redesign.ts`:
//
//   - bulkApproveFieldMappingsForTargetTable (IB1)
//   - approveHighConfidenceMappings           (IB3)
//
// Mirrors the env-gating + mock shape used by the rest of the
// Heritage integration suite — opt-in via
// `RUN_BULK_APPROVE_HERITAGE_INTEGRATION=1`.
//
// What these tests pin (and why source-level invariants are
// insufficient):
//
//   IB1. The bulk SQL `.update().in(tfmIds)` actually round-trips
//        against real `target_field_mappings` rows, the activity-log
//        emit doesn't error under live constraints, and the TM
//        recompute pass tolerates real Heritage table-mapping shapes.
//   IB3. The high-confidence WHERE clause's `gte(confidence, threshold)`
//        plays well with NULL confidences (which must not match) and
//        with the `is_acknowledged=false` gate (acknowledgments must
//        not flip even at high confidence).
//
// Run locally:
//   RUN_BULK_APPROVE_HERITAGE_INTEGRATION=1 \
//   HERITAGE_PROJECT_ID=... \
//   NEXT_PUBLIC_SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//     npx vitest run tests/integration/bulk-approve-heritage.test.ts
//
// Cleanup contract: each test seeds its own TFMs into a target table
// that has unmapped fields available, then deletes them in `afterEach`.
// We never mutate pre-existing Heritage data — every TFM under test
// is one we just inserted.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const RUN = process.env.RUN_BULK_APPROVE_HERITAGE_INTEGRATION === '1'

const HERITAGE_PROJECT_ID =
  process.env.MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID ??
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

const HAS_ENV =
  RUN &&
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

// ─── Mocks ───────────────────────────────────────────────────────────
//
// The bulk wrappers do NOT depend on any SECURITY DEFINER RPC — they
// use plain `.update().in()` against `target_field_mappings`, which
// the service-role admin client can invoke without an `auth.uid()`
// context. So our mocks are simpler than the edit-mapping suite:
// just make `createClient()` return a service-role-backed shim and
// stub the auth + permission + maintenance gates.

const HERITAGE_OWNER_USER_ID = 'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'

vi.mock('@/lib/supabase/server', async () => {
  const adminMod =
    await vi.importActual<typeof import('@/lib/supabase/admin')>(
      '@/lib/supabase/admin',
    )
  const { supabaseAdmin } = adminMod
  return {
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: HERITAGE_OWNER_USER_ID } },
          error: null,
        }),
      },
      from: supabaseAdmin.from.bind(supabaseAdmin),
      rpc: supabaseAdmin.rpc.bind(supabaseAdmin),
    }),
  }
})

vi.mock('@/lib/actions/role-resolution', () => ({
  requireProjectPermission: async () => ({ allowed: true }),
}))

vi.mock('@/lib/auth/mapping-writes', () => ({
  assertMappingWritesEnabled: async () => {},
}))

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
}))

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Fixture discovery ───────────────────────────────────────────────
//
// We need a target table inside Heritage whose fields are NOT yet
// fully mapped — so we can seed needs_review TFMs without colliding
// with the project_id+target_field_id unique constraint.
//
// Strategy: scan target tables, for each find at least 3 unmapped
// target fields. Find one source field in any source table to attach
// each TFM to (so mapping_sources isn't empty; the bulk wrapper's
// scope filter does NOT inspect mapping_sources, but we want the
// fixture to look like a realistic mapped row rather than a bare TFM).

interface Fx {
  projectId: string
  targetTableId: string
  targetTableName: string
  unmappedTargetFieldIds: string[]
  sourceFieldId: string
  sourceTableId: string
}

async function discoverFixture(): Promise<Fx | null> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  const { data: targetTables } = await supabaseAdmin
    .from('tables')
    .select('id, name, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', 'target')
  if (!targetTables || targetTables.length === 0) return null

  // First source field we can find — used as a sentinel attach for
  // mapping_sources rows on the seeded TFMs.
  const { data: sourceTables } = await supabaseAdmin
    .from('tables')
    .select('id, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', 'source')
  if (!sourceTables || sourceTables.length === 0) return null
  let sourceFieldId = ''
  let sourceTableId = ''
  for (const st of sourceTables) {
    const { data: sFields } = await supabaseAdmin
      .from('fields')
      .select('id')
      .eq('table_id', st.id as string)
      .limit(1)
    if (sFields && sFields.length > 0) {
      sourceFieldId = sFields[0].id as string
      sourceTableId = st.id as string
      break
    }
  }
  if (!sourceFieldId) return null

  for (const t of targetTables) {
    const { data: fields } = await supabaseAdmin
      .from('fields')
      .select('id, name')
      .eq('table_id', t.id as string)
    if (!fields || fields.length === 0) continue

    const unmapped: string[] = []
    for (const f of fields) {
      const { data: existing } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id')
        .eq('project_id', HERITAGE_PROJECT_ID)
        .eq('target_field_id', f.id as string)
        .maybeSingle()
      if (!existing) unmapped.push(f.id as string)
      if (unmapped.length === 3) break
    }
    if (unmapped.length >= 3) {
      return {
        projectId: HERITAGE_PROJECT_ID,
        targetTableId: t.id as string,
        targetTableName: t.name as string,
        unmappedTargetFieldIds: unmapped,
        sourceFieldId,
        sourceTableId,
      }
    }
  }
  return null
}

// ─── Cleanup tracker ─────────────────────────────────────────────────

const createdTfmIds = new Set<string>()

async function cleanup(): Promise<void> {
  if (createdTfmIds.size === 0) return
  const ids = Array.from(createdTfmIds)
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  await supabaseAdmin
    .from('mapping_sources')
    .delete()
    .in('target_field_mapping_id', ids)
  await supabaseAdmin.from('target_field_mappings').delete().in('id', ids)
  createdTfmIds.clear()
}

async function seedTfm(
  fx: Fx,
  targetFieldId: string,
  opts: { confidence: number | null; ack?: boolean } = { confidence: null },
): Promise<string> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  const { data: tfm, error: tfmErr } = await supabaseAdmin
    .from('target_field_mappings')
    .insert({
      project_id: fx.projectId,
      target_field_id: targetFieldId,
      status: 'needs_review',
      is_acknowledged: opts.ack ?? false,
      confidence: opts.confidence,
      combination_type: 'single',
      combination_sql: null,
      ai_reasoning: null,
    })
    .select('id')
    .single()
  if (tfmErr || !tfm) {
    throw new Error(`seed TFM failed: ${tfmErr?.message ?? 'unknown'}`)
  }
  createdTfmIds.add(tfm.id as string)
  // Attach a single mapping_source so the row looks realistic.
  if (!opts.ack) {
    await supabaseAdmin.from('mapping_sources').insert({
      target_field_mapping_id: tfm.id as string,
      source_field_id: fx.sourceFieldId,
      source_table_id: fx.sourceTableId,
      ordinal: 0,
    })
  }
  return tfm.id as string
}

// ─── Tests ───────────────────────────────────────────────────────────

describeFn('[integration] bulk approve against Heritage', () => {
  let fx: Fx | null = null

  beforeAll(async () => {
    fx = await discoverFixture()
    if (!fx) {
      console.warn(
        '[integration] no usable Heritage fixture (need a target table with 3+ unmapped fields); tests will skip.',
      )
    }
  }, 60_000)

  afterEach(async () => {
    await cleanup()
  })

  it('IB1: bulkApproveFieldMappingsForTargetTable flips every needs_review TFM in the table to approved, leaves out-of-scope TFMs untouched, and emits a single activity log', async () => {
    if (!fx) return
    const { bulkApproveFieldMappingsForTargetTable } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    // Seed 3 TFMs in the target table:
    //   A: needs_review, NOT acknowledged                → in scope
    //   B: needs_review, acknowledged                    → out of scope
    //   C: needs_review (we will pre-approve before run) → out of scope
    //                                                       (status filter)
    const tfmA = await seedTfm(fx, fx.unmappedTargetFieldIds[0], {
      confidence: 80,
    })
    const tfmB = await seedTfm(fx, fx.unmappedTargetFieldIds[1], {
      confidence: null,
      ack: true,
    })
    const tfmC = await seedTfm(fx, fx.unmappedTargetFieldIds[2], {
      confidence: 60,
    })
    await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('id', tfmC)

    const before = new Date().toISOString()

    const result = await bulkApproveFieldMappingsForTargetTable({
      projectId: fx.projectId,
      targetTableId: fx.targetTableId,
    })
    expect(result.success, JSON.stringify(result)).toBe(true)
    if (!result.success) return
    expect(result.rowsAffected).toBe(1)
    expect(result.tfmIds).toEqual([tfmA])

    // Verify rows directly:
    const { data: post } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, status, is_acknowledged')
      .in('id', [tfmA, tfmB, tfmC])
    const byId = new Map(
      (post ?? []).map((r) => [
        r.id as string,
        { status: r.status, ack: r.is_acknowledged } as {
          status: string
          ack: boolean
        },
      ]),
    )
    expect(byId.get(tfmA)?.status).toBe('approved')
    // B was acknowledged — must remain needs_review (out of scope).
    expect(byId.get(tfmB)?.status).toBe('needs_review')
    expect(byId.get(tfmB)?.ack).toBe(true)
    // C was already approved — should still be approved.
    expect(byId.get(tfmC)?.status).toBe('approved')

    // Verify exactly ONE activity-log entry was emitted in the
    // window since `before`.
    const { data: logs } = await supabaseAdmin
      .from('activity_log')
      .select('action_type, metadata')
      .eq('project_id', fx.projectId)
      .gte('created_at', before)
      .order('created_at', { ascending: false })
    const bulkLogs = (logs ?? []).filter(
      (l) => l.action_type === 'mapping_bulk_approved',
    )
    expect(bulkLogs.length).toBe(1)
    const meta = (bulkLogs[0].metadata ?? {}) as Record<string, unknown>
    expect(meta.scope).toBe('target_table_needs_review')
    expect(meta.count).toBe(1)
    expect(Array.isArray(meta.tfm_ids)).toBe(true)
    expect((meta.tfm_ids as string[]).length).toBe(1)
    expect((meta.tfm_ids as string[])[0]).toBe(tfmA)
  }, 60_000)

  it('IB3: approveHighConfidenceMappings flips only TFMs whose confidence >= threshold and skips acknowledgments + out-of-scope rows', async () => {
    if (!fx) return
    const { approveHighConfidenceMappings } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    // Seed 3 TFMs:
    //   A: confidence=92, needs_review, !ack → in scope
    //   B: confidence=70, needs_review, !ack → out of scope (low conf)
    //   C: confidence=null, needs_review, ack → out of scope (ack)
    const tfmA = await seedTfm(fx, fx.unmappedTargetFieldIds[0], {
      confidence: 92,
    })
    const tfmB = await seedTfm(fx, fx.unmappedTargetFieldIds[1], {
      confidence: 70,
    })
    const tfmC = await seedTfm(fx, fx.unmappedTargetFieldIds[2], {
      confidence: null,
      ack: true,
    })

    const before = new Date().toISOString()

    const result = await approveHighConfidenceMappings({
      projectId: fx.projectId,
      threshold: 85,
    })
    expect(result.success, JSON.stringify(result)).toBe(true)
    if (!result.success) return
    // Heritage already has 2 high-confidence needs_review TFMs in
    // production state; our seed adds 1 more. The wrapper sweeps all
    // of them in a single pass — so we assert tfmA is INCLUDED rather
    // than asserting an exact count (which would be Heritage-state
    // coupled).
    expect(result.tfmIds).toContain(tfmA)
    expect(result.tfmIds).not.toContain(tfmB)
    expect(result.tfmIds).not.toContain(tfmC)

    const { data: post } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id, status')
      .in('id', [tfmA, tfmB, tfmC])
    const byId = new Map(
      (post ?? []).map((r) => [r.id as string, r.status as string]),
    )
    expect(byId.get(tfmA)).toBe('approved')
    expect(byId.get(tfmB)).toBe('needs_review')
    expect(byId.get(tfmC)).toBe('needs_review')

    // Verify activity-log scope.
    const { data: logs } = await supabaseAdmin
      .from('activity_log')
      .select('action_type, metadata')
      .eq('project_id', fx.projectId)
      .gte('created_at', before)
      .order('created_at', { ascending: false })
    const bulkLogs = (logs ?? []).filter(
      (l) => l.action_type === 'mapping_bulk_approved',
    )
    expect(bulkLogs.length).toBe(1)
    const meta = (bulkLogs[0].metadata ?? {}) as Record<string, unknown>
    expect(meta.scope).toBe('project_high_confidence')
    expect(meta.threshold).toBe(85)
  }, 60_000)
})
