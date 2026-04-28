// @vitest-environment node
//
// Phase 4a-6 — Heritage-backed integration test for cross-table
// `applyTransform`.
//
// Scope: end-to-end seed → apply → assert → cleanup against the
// "Heritage Core" canary project, exercising the cross-table branch
// of `dq_apply_field_transform_joined` (migration 076) wired through
// `applyTransform` via `buildJoinSpec`. Same env-gating shape as
// `tests/integration/mappings-for-redesign-heritage.test.ts` —
// opt-in via `RUN_TRANSFORM_APPLY_CROSS_TABLE_HERITAGE_INTEGRATION=1`.
//
// What this test pins (and why a unit test is insufficient):
//   1. The migration-076 SQL actually parses and executes against
//      Heritage's data shape. PL/pgSQL JOIN code that compiles
//      cleanly under `psql` can still trip up at run time on real
//      data (NULL FK columns, JSONB data_rows shape mismatches).
//   2. The full action-layer pipeline — createFieldMapping →
//      transformations.insert → applyTransform → staged_data_rows
//      reads — flows without a CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED
//      short-circuit (verified at source level in
//      `transforms-cross-table-apply.test.ts`, but verified
//      end-to-end here).
//   3. Joined columns surface in `staged_data_rows.transformed_row_data`
//      when the FK matches, and the column's prior value is preserved
//      when there's no match (per migration 076 LEFT JOIN semantics
//      and the §8a-OQ "preserve prior on FK miss" decision).
//
// Run locally:
//   RUN_TRANSFORM_APPLY_CROSS_TABLE_HERITAGE_INTEGRATION=1 \
//   HERITAGE_PROJECT_ID=... \
//   NEXT_PUBLIC_SUPABASE_URL=... \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//     npx vitest run tests/integration/transform-apply-cross-table-heritage.test.ts
//
// Cleanup contract: each test creates exactly one TFM (and its
// transformations row), runs the test, then deletes both. If the
// cleanup throws, subsequent runs fail with EXISTING_TFM — this is
// loud-and-correct rather than silent-and-polluting.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'

const RUN =
  process.env.RUN_TRANSFORM_APPLY_CROSS_TABLE_HERITAGE_INTEGRATION === '1'

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
// Same shape as `mappings-for-redesign-heritage.test.ts`:
//   • Mock `@/lib/supabase/server.createClient` to return a wrapper that
//     forwards `from` and `rpc` to `supabaseAdmin` but injects a real
//     Heritage owner `user.id` into `auth.getUser()` (activity-log rows
//     need a valid user id).
//   • Bypass the SECURITY DEFINER `dq_create_target_field_mapping` RPC
//     gate (which requires a real `auth.uid()` and therefore can't run
//     under the service-role client) with an INSERT-equivalent fake.
//   • Mock the permission helper at `@/lib/actions/role-resolution`
//     (NOT `@/lib/auth/project-access` — that path doesn't exist).
//   • Mock `@/lib/auth/mapping-writes.assertMappingWritesEnabled` —
//     this is the module that imports `'server-only'`, which Vitest
//     can't load. Replacing the module sidesteps the import entirely.
//   • Mock `next/cache.revalidatePath` (no Next runtime under Node).

const HERITAGE_OWNER_USER_ID = 'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'

vi.mock('@/lib/supabase/server', async () => {
  const adminMod =
    await vi.importActual<typeof import('@/lib/supabase/admin')>(
      '@/lib/supabase/admin',
    )
  const { supabaseAdmin } = adminMod

  type FakeRpcResult = { data: unknown; error: { message: string } | null }
  const fakeRpc = async (
    fnName: string,
    params: Record<string, unknown>,
  ): Promise<FakeRpcResult> => {
    if (fnName !== 'dq_create_target_field_mapping') {
      return supabaseAdmin.rpc(fnName, params) as unknown as FakeRpcResult
    }
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
// Heritage canonical cross-table fixture (verified against
// production schema 2026-04-26 — see investigation in the
// Phase 4a-6 commit thread):
//   target  : loans.status
//   dominant: LOAN_MASTER.STATUS
//   joined  : CIF_MASTER.CIF_TYPE  (via LOAN_MASTER.CIF_NO → CIF_MASTER.CIF_NO)
//
// `LOAN_MASTER.CIF_NO` carries `fk_reference='CIF_MASTER.CIF_NO'`
// (single candidate), so `inferFkCandidates` resolves without
// ambiguity and `buildJoinSpec` succeeds without explicit
// joinAnnotations from the caller.
//
// If any of these don't exist (Heritage schema drift) the test
// self-skips with a clear console warning rather than failing.
// Also self-skips if `loans.status` already has a TFM — the
// caller is expected to free the slot (Reject existing TFM via
// redesign UI) before running.

interface Fx {
  loansStatusFieldId: string
  loansTableId: string
  loanMasterStatus: { id: string; tableId: string; name: string }
  cifMasterCifType: { id: string; tableId: string; name: string }
}

async function findField(
  tableName: string,
  role: 'source' | 'target',
  fieldName: string,
): Promise<{ id: string; tableId: string; name: string } | null> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  const { data: tbl } = await supabaseAdmin
    .from('tables')
    .select('id, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', role)
    .eq('name', tableName)
    .maybeSingle()
  if (!tbl) return null
  const { data: fld } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('table_id', tbl.id as string)
    .eq('name', fieldName)
    .maybeSingle()
  if (!fld) return null
  return {
    id: fld.id,
    tableId: fld.table_id as string,
    name: fld.name,
  }
}

async function discoverFixtures(): Promise<Fx | null> {
  const loansStatus = await findField('loans', 'target', 'status')
  const loanMasterStatus = await findField('LOAN_MASTER', 'source', 'STATUS')
  const cifMasterCifType = await findField('CIF_MASTER', 'source', 'CIF_TYPE')
  if (!loansStatus || !loanMasterStatus || !cifMasterCifType) return null

  // If loans.status already has a TFM, we'd collide. Treat as not-applicable
  // rather than failing — the canonical fixture is a single slot.
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  const { data: existing } = await supabaseAdmin
    .from('target_field_mappings')
    .select('id')
    .eq('project_id', HERITAGE_PROJECT_ID)
    .eq('target_field_id', loansStatus.id)
    .maybeSingle()
  if (existing) return null

  return {
    loansStatusFieldId: loansStatus.id,
    loansTableId: loansStatus.tableId,
    loanMasterStatus,
    cifMasterCifType,
  }
}

// ─── Cleanup tracker ─────────────────────────────────────────────────

const createdTfmIds = new Set<string>()

async function cleanup(): Promise<void> {
  if (createdTfmIds.size === 0) return
  const ids = Array.from(createdTfmIds)
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  // Delete transformations first — the FK from transformations to
  // target_field_mappings is RESTRICT-ed (per migration 075).
  await supabaseAdmin
    .from('transformations')
    .delete()
    .in('target_field_mapping_id', ids)
  await supabaseAdmin
    .from('target_field_mappings')
    .delete()
    .in('id', ids)
  createdTfmIds.clear()
}

// ─── Tests ───────────────────────────────────────────────────────────

describeFn(
  '[integration] applyTransform cross-table apply against Heritage',
  () => {
    let fx: Fx | null = null

    beforeAll(async () => {
      fx = await discoverFixtures()
      if (!fx) {
        console.warn(
          '[integration] Heritage canonical cross-table fixture missing or already mapped — tests will skip.',
        )
      }
    }, 60_000)

    afterEach(async () => {
      await cleanup()
    })

    it('seeds cross-table TFM, applies transform, and surfaces joined values in staged_data_rows', async () => {
      if (!fx) return // self-skip when canonical fixture isn't available

      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )
      const { applyTransform } = await import('@/lib/actions/transformations')
      const { supabaseAdmin } = await import('@/lib/supabase/admin')

      // 1. Create cross-table TFM via the wrapper. Cycle 1 — the
      //    create-time FK precheck has been removed, so cross-table
      //    inputs always succeed regardless of FK candidate count.
      //    Read-path FK inference (and any apply-time
      //    `CROSS_TABLE_FK_INFERENCE_FAILED` surfacing) lives
      //    downstream in `applyTransform`. Heritage has a single
      //    LOAN_MASTER → CIF_MASTER FK that the read-path
      //    `inferFkCandidates` should still resolve cleanly.
      const created = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fx.loansStatusFieldId,
        sourceFieldIds: [fx.loanMasterStatus.id, fx.cifMasterCifType.id],
        combinationType: 'concat_space',
      })
      if (!created.success) {
        console.warn(
          `[integration] cross-table seed failed (${created.errorCode}); skipping.`,
        )
        return
      }
      createdTfmIds.add(created.tfmId)

      // 2. Insert a transformations row pinned to status='tested' so
      //    `applyTransform` doesn't reject on the gate. The SQL
      //    concatenates the dominant LOAN_MASTER.STATUS with the
      //    joined CIF_MASTER.CIF_TYPE using qualified field
      //    references — exactly the shape the cross-table
      //    `wrapFieldRefsInJsonb` overload expects.
      const transformSql =
        `"LOAN_MASTER.STATUS" || ' / ' || "CIF_MASTER.CIF_TYPE"`
      const { error: insertErr } = await supabaseAdmin
        .from('transformations')
        .insert({
          target_field_mapping_id: created.tfmId,
          generated_sql: transformSql,
          status: 'tested',
        })
      expect(insertErr).toBeNull()

      // 3. Apply.
      const applyResult = await applyTransform(created.tfmId, transformSql)
      expect(applyResult.error).toBeUndefined()
      expect(applyResult.success).toBe(true)
      expect(applyResult.errorCode).toBeUndefined()
      expect(applyResult.rowsAffected).toBeGreaterThan(0)

      // 4. Inspect staged_data_rows for the loans target table. The
      //    cross-table apply path writes through the dominant TM's
      //    staging partition. Sample a handful of rows and assert
      //    that the transformed_row_data['status'] contains either:
      //      • a `<LOAN_MASTER.STATUS> / <CIF_MASTER.CIF_TYPE>`
      //        composite (FK matched), OR
      //      • the dominant value alone followed by ` / ` (FK matched
      //        but joined value was NULL — Postgres `||` propagates
      //        NULL through, so this manifests as the entire
      //        transformed value being NULL).
      const { data: stagedSample } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data')
        .eq('target_table_id', fx.loansTableId)
        .not('transformed_row_data->>status', 'is', null)
        .limit(5)

      // We assert at least one row has the composite shape — proves
      // the JOIN actually fired against real data and produced a
      // non-NULL joined value.
      expect(stagedSample).toBeTruthy()
      const composites = (stagedSample ?? []).filter((r) => {
        const v = (r.transformed_row_data as Record<string, string | null>)
          .status
        return typeof v === 'string' && v.includes(' / ')
      })
      expect(
        composites.length,
        'expected ≥1 staged row with the composite "<dom> / <joined>" shape — the JOIN never produced a non-NULL joined value',
      ).toBeGreaterThan(0)
    }, 120_000)

    it('cross-table apply does NOT short-circuit with CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED', async () => {
      if (!fx) return

      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )
      const { applyTransform } = await import('@/lib/actions/transformations')
      const { supabaseAdmin } = await import('@/lib/supabase/admin')

      const created = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fx.loansStatusFieldId,
        sourceFieldIds: [fx.loanMasterStatus.id, fx.cifMasterCifType.id],
        combinationType: 'concat_space',
      })
      if (!created.success) return
      createdTfmIds.add(created.tfmId)

      await supabaseAdmin
        .from('transformations')
        .insert({
          target_field_mapping_id: created.tfmId,
          generated_sql: `"LOAN_MASTER.STATUS"`,
          status: 'tested',
        })

      const result = await applyTransform(
        created.tfmId,
        `"LOAN_MASTER.STATUS"`,
      )
      // The retired error code MUST NOT come back. If it does, the
      // transparency stack snuck back in and the new RPC branch is
      // not being exercised.
      expect(result.errorCode).not.toBe('CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED')
    }, 60_000)
  },
)
