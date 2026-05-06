// @vitest-environment node
//
// fix/buildaicontext-field-load-rls — runtime regression test for the
// fields-load-zero bug that shipped to Rootstock POC (May 2026).
//
// SYMPTOM: production buildAIContext returned 0 fields for fresh
// projects despite the fields existing in the DB. Tables loaded
// (visible in prompt); fields and field_profiles silently returned [].
//
// ROOT CAUSE: the fields RLS policy descends 2 levels (tables →
// datasets, both with RLS); combined with `data`-only destructuring
// (silent error swallow), any RLS-cascade quirk produced an empty
// array that was indistinguishable from "no fields exist". Heritage
// tests didn't catch it because they ran via supabaseAdmin (which
// bypasses RLS), masking the bug.
//
// FIX (this PR): after the user-authed project access check, read all
// related rows via supabaseAdmin. Authorisation is enforced once, at
// the entry, by the project SELECT.
//
// TEST: build a fresh synthetic project (mirrors how a real customer's
// fresh project is shaped — datasets + tables + fields + field
// profiles), then call buildAIContext with the eval user's USER-AUTHED
// client. Assert fields.length > 0. Without the fix, this test fails
// with `source_tables[0].fields.length === 0`. With the fix, the
// access check validates user membership (project_members row was
// created during synthetic-project provisioning) and admin reads
// surface every field.
//
// Env-gated: RUN_BUILD_AI_CONTEXT_FIELD_LOAD_INTEGRATION=1 + Supabase
// + EVAL_USER_ID + EVAL_ORG_ID. Same gating shape as
// mappings-for-redesign-heritage.test.ts.

import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

import { buildAIContext } from '@/lib/ai/context-builder'
import { supabaseAdmin } from '@/lib/supabase/admin'
import {
  EVAL_PROJECT_PREFIX,
  createSyntheticProject,
  teardownSyntheticProject,
} from '@/lib/eval/scratch-context'
import { signSyntheticJwt } from '@/lib/eval/synthetic-jwt'

// ─── Env gating ─────────────────────────────────────────────────────────────

const RUN = process.env.RUN_BUILD_AI_CONTEXT_FIELD_LOAD_INTEGRATION === '1'

const HAS_ENV =
  RUN &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  Boolean(process.env.EVAL_USER_ID) &&
  Boolean(process.env.EVAL_ORG_ID)

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Supabase client whose Authorization header carries the JWT
 * we sign for `EVAL_USER_ID` — same pattern as `lib/eval/runner.ts`'s
 * `buildUserAuthedClient`. We hit the same RLS surface a real customer
 * sees, not a service-role bypass.
 */
function buildUserAuthedClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const jwt = signSyntheticJwt()
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

interface SeededProject {
  projectId: string
  sourceTableId: string
  sourceFieldCount: number
  targetTableId: string
  targetFieldCount: number
}

/**
 * Provision a fresh synthetic project with one source table (3 fields)
 * and one target table (4 fields), each with a `field_profiles` row.
 *
 * This shape matches the minimum a freshly-created project would have
 * after onboarding completes (datasets created, tables ingested,
 * fields inferred, profiles computed). The Rootstock POC bug surfaced
 * exactly here: 37 source + 163 target fields all present, all
 * profiled, but invisible at prompt time.
 */
async function seedSyntheticProject(): Promise<SeededProject> {
  const userId = process.env.EVAL_USER_ID!
  const orgId = process.env.EVAL_ORG_ID!

  const projectId = await createSyntheticProject({
    name: `${EVAL_PROJECT_PREFIX}field-load-test-${Date.now()}`,
    userId,
    orgId,
  })

  // Datasets — one source + one target (mirrors buildSyntheticMappingContext).
  const { data: srcDs, error: srcDsErr } = await supabaseAdmin
    .from('datasets')
    .insert({ project_id: projectId, role: 'source', name: 'fl-test-source' })
    .select('id')
    .single()
  if (srcDsErr || !srcDs) throw new Error(`source dataset insert: ${srcDsErr?.message}`)

  const { data: tgtDs, error: tgtDsErr } = await supabaseAdmin
    .from('datasets')
    .insert({ project_id: projectId, role: 'target', name: 'fl-test-target' })
    .select('id')
    .single()
  if (tgtDsErr || !tgtDs) throw new Error(`target dataset insert: ${tgtDsErr?.message}`)

  // Tables.
  const { data: srcTbl, error: stErr } = await supabaseAdmin
    .from('tables')
    .insert({ dataset_id: srcDs.id as string, name: 'customers', row_count: 100 })
    .select('id')
    .single()
  if (stErr || !srcTbl) throw new Error(`source table insert: ${stErr?.message}`)

  const { data: tgtTbl, error: ttErr } = await supabaseAdmin
    .from('tables')
    .insert({ dataset_id: tgtDs.id as string, name: 'Account', row_count: 0 })
    .select('id')
    .single()
  if (ttErr || !tgtTbl) throw new Error(`target table insert: ${ttErr?.message}`)

  // Source fields — 3 fields with realistic shape.
  const sourceFieldRows = [
    { table_id: srcTbl.id as string, name: 'id', data_type: 'uuid', is_nullable: false, is_primary_key: true, ordinal_position: 1 },
    { table_id: srcTbl.id as string, name: 'email', data_type: 'varchar(255)', is_nullable: false, is_primary_key: false, inferred_type: 'email', ordinal_position: 2 },
    { table_id: srcTbl.id as string, name: 'created_at', data_type: 'timestamp', is_nullable: false, is_primary_key: false, ordinal_position: 3 },
  ]
  const { data: srcFieldRows, error: sfErr } = await supabaseAdmin
    .from('fields')
    .insert(sourceFieldRows)
    .select('id, name')
  if (sfErr || !srcFieldRows) throw new Error(`source fields insert: ${sfErr?.message}`)

  // Target fields — 4 fields.
  const targetFieldRows = [
    { table_id: tgtTbl.id as string, name: 'Id', data_type: 'varchar(18)', is_nullable: false, is_primary_key: true, ordinal_position: 1 },
    { table_id: tgtTbl.id as string, name: 'Email__c', data_type: 'varchar(80)', is_nullable: false, is_primary_key: false, inferred_type: 'email', ordinal_position: 2 },
    { table_id: tgtTbl.id as string, name: 'CreatedDate', data_type: 'datetime', is_nullable: false, is_primary_key: false, ordinal_position: 3 },
    { table_id: tgtTbl.id as string, name: 'Name', data_type: 'varchar(255)', is_nullable: true, is_primary_key: false, ordinal_position: 4 },
  ]
  const { data: tgtFieldRows, error: tfErr } = await supabaseAdmin
    .from('fields')
    .insert(targetFieldRows)
    .select('id, name')
  if (tfErr || !tgtFieldRows) throw new Error(`target fields insert: ${tfErr?.message}`)

  // Field profiles for source fields — sample values + distribution.
  // `total_rows` and `null_count` are NOT NULL on field_profiles
  // (migration 002:58); set both per the seeded `tables.row_count = 100`.
  const profileRows = (srcFieldRows as Array<{ id: string; name: string }>).map((f) => ({
    field_id: f.id,
    total_rows: 100,
    null_count: 0,
    null_percentage: 0,
    cardinality: 100,
    unique_percentage: 100,
    format_issues_count: 0,
    sample_values: [`example-${f.name}-1`, `example-${f.name}-2`],
    value_distribution: [{ value: `example-${f.name}-1`, count: 50 }],
  }))
  const { error: fpErr } = await supabaseAdmin.from('field_profiles').insert(profileRows)
  if (fpErr) throw new Error(`field_profiles insert: ${fpErr?.message}`)

  return {
    projectId,
    sourceTableId: srcTbl.id as string,
    sourceFieldCount: sourceFieldRows.length,
    targetTableId: tgtTbl.id as string,
    targetFieldCount: targetFieldRows.length,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describeFn(
  '[integration] buildAIContext field loading on a fresh synthetic project',
  () => {
    let seeded: SeededProject | null = null

    afterAll(async () => {
      if (seeded) await teardownSyntheticProject(seeded.projectId)
    })

    it(
      'loads source + target fields via the user-authed entry — RLS access gate plus admin reads',
      async () => {
        seeded = await seedSyntheticProject()
        const userClient = buildUserAuthedClient()

        const ctx = await buildAIContext(
          seeded.projectId,
          {
            includeProfilingStats: true,
            includeValueDistributions: true,
            includeSampleValues: true,
            includeDocuments: false,
          },
          process.env.EVAL_USER_ID,
          // Inject the user-authed client so we exercise the production
          // path (NOT the eval-runner admin path). Pre-fix this combo
          // produced empty fields[]; post-fix it loads them.
          userClient as unknown as Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>,
        )

        expect(ctx.project_id).toBe(seeded.projectId)
        expect(ctx.source_tables).toHaveLength(1)
        expect(ctx.target_tables).toHaveLength(1)

        // The load-bearing assertion: fields ARE populated. Pre-fix
        // these were both 0; post-fix they match the seeded counts.
        expect(ctx.source_tables[0].fields.length).toBe(seeded.sourceFieldCount)
        expect(ctx.target_tables[0].fields.length).toBe(seeded.targetFieldCount)

        // Spot-check a known field shape — confirms the admin read
        // returns the same column data the user-authed client should
        // have returned (and didn't, pre-fix).
        const emailField = ctx.source_tables[0].fields.find((f) => f.name === 'email')
        expect(emailField).toBeDefined()
        expect(emailField?.data_type).toBe('varchar(255)')
        expect(emailField?.inferred_type).toBe('email')

        // Field profiles flowed through too — sample_values populated.
        expect(emailField?.sample_values?.length ?? 0).toBeGreaterThan(0)
      },
      30_000,
    )

    it(
      'rejects an unauthorised user (RLS access check still enforces ownership)',
      async () => {
        // Build a JWT for a fictitious user-id and confirm the project
        // access check at entry rejects it. This proves the fix did NOT
        // turn buildAIContext into an unauthenticated read of any
        // project — RLS still gates entry; admin only takes over AFTER
        // the gate.
        if (!seeded) seeded = await seedSyntheticProject()

        const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        // Anon client (no JWT) — RLS will see no auth.uid() so the
        // project SELECT returns 0 rows.
        const anonClient = createClient(url, anonKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        })

        await expect(
          buildAIContext(
            seeded.projectId,
            { includeDocuments: false },
            undefined,
            anonClient as unknown as Awaited<
              ReturnType<typeof import('@/lib/supabase/server').createClient>
            >,
          ),
        ).rejects.toThrow(/Project not found/)
      },
      30_000,
    )
  },
)
