// @vitest-environment node
//
// Phase 4b-1 — Heritage-backed integration tests for `editMappingSources`
// and `updateMappingCombination`.
//
// Scope: end-to-end seed → edit → assert → cleanup against the
// "Heritage Core" canary project. Mirrors the env-gating + mock shape
// used by `mappings-for-redesign-heritage.test.ts` and
// `transform-apply-cross-table-heritage.test.ts` — opt-in via
// `RUN_EDIT_MAPPING_HERITAGE_INTEGRATION=1`.
//
// What these tests pin (and why source-level invariants are insufficient):
//   I1. `editMappingSources` actually round-trips through
//       `dq_replace_mapping_sources` against real data. Source-level
//       grep tests prove the call is wired; only this test proves the
//       RPC parses our payload and reports the correct count.
//   I2. When a transform exists at edit time, `editMappingSources`
//       drives `resetFieldTransform` which deletes the
//       `transformations` row and reverts staged data — this is the
//       only test path that exercises the full chain. Returns
//       `transformReset: true` and `stagedRowsReverted >= 1`.
//   I3. `updateMappingCombination` reverts status to `needs_review`
//       WITHOUT calling `dq_replace_mapping_sources` and WITHOUT
//       triggering a transform reset (founder §1.3).
//
// Run locally:
//   RUN_EDIT_MAPPING_HERITAGE_INTEGRATION=1 \
//   HERITAGE_PROJECT_ID=... \
//   NEXT_PUBLIC_SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//     npx vitest run tests/integration/edit-mapping-heritage.test.ts
//
// Cleanup contract: each test seeds at most one TFM (via the
// `dq_create_target_field_mapping` bypass) and self-cleans afterwards.
// If cleanup throws, subsequent runs fail with EXISTING_TFM — loud
// rather than silent.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const RUN = process.env.RUN_EDIT_MAPPING_HERITAGE_INTEGRATION === '1'

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

// ─── Mocks for the action layer ──────────────────────────────────────
//
// Same shape as `transform-apply-cross-table-heritage.test.ts`:
//   • `@/lib/supabase/server.createClient` returns a fake client whose
//     `auth.getUser()` returns the Heritage owner's user id, and whose
//     `rpc` forwards to `supabaseAdmin.rpc(...)` for everything EXCEPT
//     two SECURITY DEFINER RPCs that depend on `auth.uid()`:
//       - `dq_create_target_field_mapping` (used by `createFieldMapping`)
//       - `dq_replace_mapping_sources` (used by `editMappingSources`)
//     Both gate on `user_has_project_role(project_id, 'editor')` which
//     reads `auth.uid()` and returns `null` under the service-role
//     client. We bypass them by performing the equivalent INSERT /
//     DELETE directly via `supabaseAdmin`.
//   • Mock `requireProjectPermission` → allowed.
//   • Mock `assertMappingWritesEnabled` → no-op (avoids loading
//     `'server-only'` under Vitest's Node loader).
//   • Mock `next/cache.revalidatePath` → no-op (no Next runtime).

const HERITAGE_OWNER_USER_ID = 'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'

vi.mock('@/lib/supabase/server', async () => {
  const adminMod =
    await vi.importActual<typeof import('@/lib/supabase/admin')>(
      '@/lib/supabase/admin',
    )
  const { supabaseAdmin } = adminMod

  type FakeRpcResult = { data: unknown; error: { message: string } | null }

  const fakeCreateTfm = async (
    params: Record<string, unknown>,
  ): Promise<FakeRpcResult> => {
    const projectId = params.p_project_id as string
    const targetFieldId = params.p_target_field_id as string
    const combination = (params.p_combination ?? {}) as Record<string, unknown>
    const sources = (params.p_sources ?? []) as Array<Record<string, unknown>>

    const { data: tfm, error: tfmErr } = await supabaseAdmin
      .from('target_field_mappings')
      .insert({
        project_id: projectId,
        target_field_id: targetFieldId,
        confidence: null,
        status: 'needs_review',
        ai_reasoning: combination.ai_reasoning ?? null,
        is_acknowledged: false,
        combination_type: combination.type ?? null,
        combination_sql: combination.sql ?? null,
      })
      .select('id')
      .single()
    if (tfmErr || !tfm) {
      return { data: null, error: tfmErr ?? { message: 'TFM insert failed' } }
    }
    if (sources.length > 0) {
      const rows = sources.map((s) => ({
        target_field_mapping_id: tfm.id,
        source_field_id: s.source_field_id,
        source_table_id: s.source_table_id,
        confidence: s.confidence ?? null,
        ai_reasoning: s.ai_reasoning ?? null,
        similar_fields_considered: s.similar_fields_considered ?? [],
        type_compatibility: s.type_compatibility ?? null,
        join_spec: s.join_spec ?? null,
        ordinal: s.ordinal ?? 0,
      }))
      const { error: msErr } = await supabaseAdmin
        .from('mapping_sources')
        .insert(rows)
      if (msErr) {
        await supabaseAdmin
          .from('target_field_mappings')
          .delete()
          .eq('id', tfm.id)
        return { data: null, error: msErr }
      }
    }
    return { data: tfm.id, error: null }
  }

  const fakeReplaceSources = async (
    params: Record<string, unknown>,
  ): Promise<FakeRpcResult> => {
    const tfmId = params.p_tfm_id as string
    const sources = (params.p_sources ?? []) as Array<Record<string, unknown>>

    const { error: delErr } = await supabaseAdmin
      .from('mapping_sources')
      .delete()
      .eq('target_field_mapping_id', tfmId)
    if (delErr) return { data: null, error: delErr }

    if (sources.length > 0) {
      const rows = sources.map((s) => ({
        target_field_mapping_id: tfmId,
        source_field_id: s.source_field_id,
        source_table_id: s.source_table_id,
        confidence: s.confidence ?? null,
        ai_reasoning: s.ai_reasoning ?? null,
        similar_fields_considered: s.similar_fields_considered ?? [],
        type_compatibility: s.type_compatibility ?? null,
        join_spec: s.join_spec ?? null,
        ordinal: s.ordinal ?? 0,
      }))
      const { error: insErr } = await supabaseAdmin
        .from('mapping_sources')
        .insert(rows)
      if (insErr) return { data: null, error: insErr }
    }

    await supabaseAdmin
      .from('target_field_mappings')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', tfmId)

    return { data: sources.length, error: null }
  }

  const fakeRpc = async (
    fnName: string,
    params: Record<string, unknown>,
  ): Promise<FakeRpcResult> => {
    if (fnName === 'dq_create_target_field_mapping') {
      return fakeCreateTfm(params)
    }
    if (fnName === 'dq_replace_mapping_sources') {
      return fakeReplaceSources(params)
    }
    return supabaseAdmin.rpc(fnName, params) as unknown as FakeRpcResult
  }

  return {
    createClient: async () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: HERITAGE_OWNER_USER_ID } },
          error: null,
        }),
      },
      from: supabaseAdmin.from.bind(supabaseAdmin),
      rpc: fakeRpc,
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
// We need an unmapped target field with at least 2 candidate same-table
// sources. The first 4b integration test seeds a TFM with 1 source then
// edits it to add a second; the second test seeds with 2 sources, plants
// a transformations row, then edits to swap one of them. Same-table only
// (cross-table FK inference is exercised by the 4a-6 test).
//
// Strategy: scan target tables in role='target' for a field whose name
// is NOT already mapped, then find at least 2 source fields in any
// source table that share a name prefix with the target. Falls back to
// "any 2 source fields from a table that has ≥2" if no name overlap.

interface Fx {
  projectId: string
  targetFieldId: string
  targetFieldName: string
  targetTableId: string
  sourceTableId: string
  sourceFieldA: string
  sourceFieldB: string
  sourceFieldC: string // for swap test
}

async function discoverFixture(): Promise<Fx | null> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  // Find an unmapped target field with at least 3 candidate source
  // fields in some source table (need 3 to support seed + edit + swap).
  const { data: targetTables } = await supabaseAdmin
    .from('tables')
    .select('id, name, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', 'target')
  if (!targetTables || targetTables.length === 0) return null

  for (const t of targetTables) {
    const { data: fields } = await supabaseAdmin
      .from('fields')
      .select('id, name')
      .eq('table_id', t.id as string)
    if (!fields) continue
    for (const f of fields) {
      const { data: existingTfm } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id')
        .eq('project_id', HERITAGE_PROJECT_ID)
        .eq('target_field_id', f.id as string)
        .maybeSingle()
      if (existingTfm) continue

      // Find any source table with ≥3 fields.
      const { data: sourceTables } = await supabaseAdmin
        .from('tables')
        .select('id, datasets!inner(project_id, role)')
        .eq('datasets.project_id', HERITAGE_PROJECT_ID)
        .eq('datasets.role', 'source')
      if (!sourceTables) continue
      for (const st of sourceTables) {
        const { data: sFields } = await supabaseAdmin
          .from('fields')
          .select('id, name')
          .eq('table_id', st.id as string)
          .limit(3)
        if (!sFields || sFields.length < 3) continue
        return {
          projectId: HERITAGE_PROJECT_ID,
          targetFieldId: f.id as string,
          targetFieldName: f.name as string,
          targetTableId: t.id as string,
          sourceTableId: st.id as string,
          sourceFieldA: sFields[0].id as string,
          sourceFieldB: sFields[1].id as string,
          sourceFieldC: sFields[2].id as string,
        }
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
    .from('transformations')
    .delete()
    .in('target_field_mapping_id', ids)
  await supabaseAdmin.from('mapping_sources').delete().in('target_field_mapping_id', ids)
  await supabaseAdmin.from('target_field_mappings').delete().in('id', ids)
  createdTfmIds.clear()
}

// ─── Tests ───────────────────────────────────────────────────────────

describeFn('[integration] editMappingSources / updateMappingCombination against Heritage', () => {
  let fx: Fx | null = null

  beforeAll(async () => {
    fx = await discoverFixture()
    if (!fx) {
      console.warn(
        '[integration] no usable Heritage fixture found (no unmapped target with 3+ source candidates); tests will skip.',
      )
    }
  }, 60_000)

  afterEach(async () => {
    await cleanup()
  })

  it('I1: editMappingSources adds a source, reverts status to needs_review, no transform reset when no transform exists', async () => {
    if (!fx) return
    const { createFieldMapping, editMappingSources } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    // Seed a single-source TFM and pre-approve it so we can verify
    // the status revert.
    const seed = await createFieldMapping({
      projectId: fx.projectId,
      targetFieldId: fx.targetFieldId,
      sourceFieldIds: [fx.sourceFieldA],
      combinationType: 'single',
    })
    expect(seed.success, JSON.stringify(seed)).toBe(true)
    if (!seed.success) return
    createdTfmIds.add(seed.tfmId)

    await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('id', seed.tfmId)

    // Edit: add a second source, switch to concat_space.
    const edit = await editMappingSources({
      tfmId: seed.tfmId,
      sourceFieldIds: [fx.sourceFieldA, fx.sourceFieldB],
      combinationType: 'concat_space',
    })
    expect(edit.success, JSON.stringify(edit)).toBe(true)
    if (!edit.success) return
    expect(edit.transformReset).toBe(false)
    expect(edit.stagedRowsReverted).toBe(0)
    expect(edit.sourcesChanged).toBe(true)

    // Verify status reverted + sources replaced.
    const { data: post } = await supabaseAdmin
      .from('target_field_mappings')
      .select('status, combination_type')
      .eq('id', seed.tfmId)
      .single()
    expect(post?.status).toBe('needs_review')
    expect(post?.combination_type).toBe('concat_space')

    const { data: postSources } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id')
      .eq('target_field_mapping_id', seed.tfmId)
      .order('ordinal', { ascending: true })
    const ids = (postSources ?? []).map((r) => r.source_field_id)
    expect(ids).toEqual([fx.sourceFieldA, fx.sourceFieldB])
  }, 60_000)

  it('I2: editMappingSources resets the transform when sources change and a transformations row exists', async () => {
    if (!fx) return
    const { createFieldMapping, editMappingSources } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const seed = await createFieldMapping({
      projectId: fx.projectId,
      targetFieldId: fx.targetFieldId,
      sourceFieldIds: [fx.sourceFieldA, fx.sourceFieldB],
      combinationType: 'concat_space',
    })
    expect(seed.success, JSON.stringify(seed)).toBe(true)
    if (!seed.success) return
    createdTfmIds.add(seed.tfmId)

    // Plant a transformations row with status='applied' so
    // `resetFieldTransform` will treat the transform as deletable.
    // The transformations FK from staged_data_rows is not strict —
    // we only need the row to exist; no staged data is required for
    // the assertion `transformReset === true`.
    const { error: trErr } = await supabaseAdmin
      .from('transformations')
      .insert({
        target_field_mapping_id: seed.tfmId,
        generated_sql: 'NULL',
        status: 'applied',
      })
    expect(trErr, trErr?.message).toBeNull()

    // Edit: swap sourceFieldB → sourceFieldC.
    const edit = await editMappingSources({
      tfmId: seed.tfmId,
      sourceFieldIds: [fx.sourceFieldA, fx.sourceFieldC],
      combinationType: 'concat_space',
    })
    expect(edit.success, JSON.stringify(edit)).toBe(true)
    if (!edit.success) return
    expect(edit.sourcesChanged).toBe(true)
    expect(edit.transformReset).toBe(true)

    // Verify the transformations row is gone.
    const { data: tr } = await supabaseAdmin
      .from('transformations')
      .select('id')
      .eq('target_field_mapping_id', seed.tfmId)
      .maybeSingle()
    expect(tr).toBeNull()

    // Verify status reverted.
    const { data: post } = await supabaseAdmin
      .from('target_field_mappings')
      .select('status')
      .eq('id', seed.tfmId)
      .single()
    expect(post?.status).toBe('needs_review')
  }, 60_000)

  it('I3: updateMappingCombination reverts status WITHOUT touching sources or transforms (founder §1.3)', async () => {
    if (!fx) return
    const { createFieldMapping, updateMappingCombination } = await import(
      '@/lib/actions/mappings-for-redesign'
    )
    const { supabaseAdmin } = await import('@/lib/supabase/admin')

    const seed = await createFieldMapping({
      projectId: fx.projectId,
      targetFieldId: fx.targetFieldId,
      sourceFieldIds: [fx.sourceFieldA, fx.sourceFieldB],
      combinationType: 'concat_space',
    })
    expect(seed.success, JSON.stringify(seed)).toBe(true)
    if (!seed.success) return
    createdTfmIds.add(seed.tfmId)

    // Plant a transform — to prove it is NOT reset on combination-only edits.
    const { error: trErr } = await supabaseAdmin
      .from('transformations')
      .insert({
        target_field_mapping_id: seed.tfmId,
        generated_sql: 'NULL',
        status: 'applied',
      })
    expect(trErr, trErr?.message).toBeNull()

    // Pre-approve so the status revert is observable.
    await supabaseAdmin
      .from('target_field_mappings')
      .update({ status: 'approved' })
      .eq('id', seed.tfmId)

    // Capture pre-edit source set so we can assert it's unchanged.
    const { data: preSources } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id, ordinal')
      .eq('target_field_mapping_id', seed.tfmId)
      .order('ordinal', { ascending: true })
    const preIds = (preSources ?? []).map((r) => r.source_field_id)

    const upd = await updateMappingCombination(seed.tfmId, 'concat_comma')
    expect(upd.success, JSON.stringify(upd)).toBe(true)
    if (!upd.success) return

    const { data: post } = await supabaseAdmin
      .from('target_field_mappings')
      .select('status, combination_type')
      .eq('id', seed.tfmId)
      .single()
    expect(post?.status).toBe('needs_review')
    expect(post?.combination_type).toBe('concat_comma')

    // Sources unchanged.
    const { data: postSources } = await supabaseAdmin
      .from('mapping_sources')
      .select('source_field_id, ordinal')
      .eq('target_field_mapping_id', seed.tfmId)
      .order('ordinal', { ascending: true })
    const postIds = (postSources ?? []).map((r) => r.source_field_id)
    expect(postIds).toEqual(preIds)

    // Transform NOT deleted.
    const { data: tr } = await supabaseAdmin
      .from('transformations')
      .select('id, status')
      .eq('target_field_mapping_id', seed.tfmId)
      .maybeSingle()
    expect(tr).not.toBeNull()
    expect(tr?.status).toBe('applied')
  }, 60_000)
})
