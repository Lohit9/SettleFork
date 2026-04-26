// @vitest-environment node
//
// Phase 4c-2 — Heritage-backed integration test for the bulk reject
// wrapper in `lib/actions/mappings-for-redesign.ts`:
//
//   - bulkRejectFieldMappingsForTargetTable (IB2)
//
// Mirrors the env-gating + mock shape used by `bulk-approve-heritage`
// — opt-in via `RUN_BULK_REJECT_HERITAGE_INTEGRATION=1`.
//
// What this test pins (and why source-level invariants are
// insufficient):
//
//   IB2. The bulk SQL `.delete().in(rejectableIds)` actually cascades
//        through `mapping_sources` and `transformations` rows in real
//        Heritage state, the per-TFM `resetFieldTransform` loop runs
//        before the delete with the right TFM context in scope, and
//        the activity-log emit lands once with the full metadata.
//
// Run locally:
//   RUN_BULK_REJECT_HERITAGE_INTEGRATION=1 \
//   HERITAGE_PROJECT_ID=... \
//   NEXT_PUBLIC_SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//     npx vitest run tests/integration/bulk-reject-heritage.test.ts
//
// Cleanup contract: each test seeds its own TFMs into a target table
// that has unmapped fields available, then deletes them in `afterEach`
// (the wrapper itself deletes most of them; cleanup picks up the rows
// the wrapper intentionally LEFT ALONE, e.g. acknowledged TFMs).

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const RUN = process.env.RUN_BULK_REJECT_HERITAGE_INTEGRATION === '1'

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
// Same mock shape as bulk-approve-heritage: service-role-backed
// supabase client, stub out auth/permission/maintenance gates.

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
// fully mapped — same shape as bulk-approve-heritage's discoverFixture.

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
  // The wrapper deletes most TFMs we seeded; the cleanup pass picks up
  // any survivors (acknowledged TFMs that fall outside the wrapper's
  // scope filter). FK CASCADE handles mapping_sources + transformations.
  await supabaseAdmin
    .from('mapping_sources')
    .delete()
    .in('target_field_mapping_id', ids)
  await supabaseAdmin
    .from('transformations')
    .delete()
    .in('target_field_mapping_id', ids)
  await supabaseAdmin.from('target_field_mappings').delete().in('id', ids)
  createdTfmIds.clear()
}

async function seedTfm(
  fx: Fx,
  targetFieldId: string,
  opts: {
    confidence: number | null
    ack?: boolean
    withTransform?: boolean
  } = { confidence: null },
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
  const tfmId = tfm.id as string
  createdTfmIds.add(tfmId)
  if (!opts.ack) {
    await supabaseAdmin.from('mapping_sources').insert({
      target_field_mapping_id: tfmId,
      source_field_id: fx.sourceFieldId,
      source_table_id: fx.sourceTableId,
      ordinal: 0,
    })
  }
  if (opts.withTransform) {
    const { error: txErr } = await supabaseAdmin
      .from('transformations')
      .insert({
        target_field_mapping_id: tfmId,
        description: 'integration-seeded transform',
        // Cheap pass-through SQL — the wrapper deletes the row before
        // any execution, so the SQL never runs.
        generated_sql: 'SELECT 1',
        is_ai_generated: false,
        status: 'draft',
        test_results: null,
      })
    if (txErr) {
      throw new Error(`seed transformation failed: ${txErr.message}`)
    }
  }
  return tfmId
}

// ─── Tests ───────────────────────────────────────────────────────────

describeFn('[integration] bulk reject against Heritage', () => {
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

  it('IB2: bulkRejectFieldMappingsForTargetTable deletes every needs_review TFM in the table, runs transform reset for TFMs with a transformation row, leaves acknowledged TFMs untouched, and emits a single activity log', async () => {
    if (!fx) return
    const { bulkRejectFieldMappingsForTargetTable } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    // Seed 3 TFMs:
    //   A: needs_review, NOT ack, NO transformation         → in scope, no reset
    //   B: needs_review, NOT ack, WITH transformation row   → in scope, reset runs
    //   C: needs_review,     ack=true                       → out of scope (ack)
    const tfmA = await seedTfm(fx, fx.unmappedTargetFieldIds[0], {
      confidence: 80,
    })
    const tfmB = await seedTfm(fx, fx.unmappedTargetFieldIds[1], {
      confidence: 75,
      withTransform: true,
    })
    const tfmC = await seedTfm(fx, fx.unmappedTargetFieldIds[2], {
      confidence: null,
      ack: true,
    })

    const before = new Date().toISOString()

    const result = await bulkRejectFieldMappingsForTargetTable({
      projectId: fx.projectId,
      targetTableId: fx.targetTableId,
    })
    expect(result.success, JSON.stringify(result)).toBe(true)
    if (!result.success) return
    expect(result.rowsAffected).toBe(2)
    expect(result.tfmIds.sort()).toEqual([tfmA, tfmB].sort())
    expect(result.transformsReset).toBe(1)
    expect(result.failedTfmIds).toBeUndefined()

    // Verify A + B are gone (DELETE), C survives.
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
    expect(byId.has(tfmA)).toBe(false)
    expect(byId.has(tfmB)).toBe(false)
    expect(byId.get(tfmC)?.status).toBe('needs_review')
    expect(byId.get(tfmC)?.ack).toBe(true)

    // Verify B's transformation row is gone (resetFieldTransform deletes
    // it; the bulk DELETE would also CASCADE-delete it as a defense in
    // depth).
    const { data: residualTransforms } = await supabaseAdmin
      .from('transformations')
      .select('id')
      .in('target_field_mapping_id', [tfmA, tfmB])
    expect((residualTransforms ?? []).length).toBe(0)

    // Verify exactly ONE mapping_bulk_rejected activity-log entry
    // since `before`.
    const { data: logs } = await supabaseAdmin
      .from('activity_log')
      .select('action_type, metadata')
      .eq('project_id', fx.projectId)
      .gte('created_at', before)
      .order('created_at', { ascending: false })
    const bulkLogs = (logs ?? []).filter(
      (l) => l.action_type === 'mapping_bulk_rejected',
    )
    expect(bulkLogs.length).toBe(1)
    const meta = (bulkLogs[0].metadata ?? {}) as Record<string, unknown>
    expect(meta.scope).toBe('target_table_needs_review')
    expect(meta.count).toBe(2)
    expect(Array.isArray(meta.tfm_ids)).toBe(true)
    expect((meta.tfm_ids as string[]).sort()).toEqual([tfmA, tfmB].sort())
    expect(meta.target_table_id).toBe(fx.targetTableId)
    expect(meta.target_table_name).toBe(fx.targetTableName)
    expect(meta.transforms_reset).toBe(1)
    // Full success → no failed_tfm_ids in metadata.
    expect(meta.failed_tfm_ids).toBeUndefined()
    expect(Array.isArray(meta.fields_affected)).toBe(true)
    expect((meta.fields_affected as string[]).length).toBe(2)
  }, 60_000)
})
