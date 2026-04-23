// @vitest-environment node
// Integration test — must run in Node (not jsdom). Uses the server-side
// Supabase admin client which refuses to initialize under a browser-
// like environment. Node is correct anyway for tests that hit
// Supabase over the network.

import { describe, it, expect } from 'vitest'

/**
 * Consolidated PostgREST nested-filter verification (Prompt 3d,
 * Step 3D-14).
 *
 * This test exercises the FOUR accumulated PostgREST filter-semantics
 * concerns surfaced during Prompt 3d Steps 3D-5 through 3D-8. Each
 * concern is the same class: does PostgREST correctly AND-combine
 * multiple filter predicates on a nested / inner-joined relation,
 * OR does it evaluate them independently (silently dropping the
 * intended AND semantics)?
 *
 * The four call sites under scrutiny:
 *
 *   1. `lib/actions/staged-row-flags.ts :: flagStagedRowIssues` (3D-5)
 *      Query: target_field_mappings + mapping_sources!inner, filtered by
 *        .eq('mapping_sources.source_table_id', tm.source_table_id)
 *        .in('mapping_sources.source_field_id', fieldIds)
 *      Concern: both MS-side filters must AND-combine so only rows
 *      where a SINGLE mapping_source matches BOTH predicates survive.
 *
 *   2. `lib/actions/staging.ts :: stageAllData / getStagedDataPreview` (3D-6)
 *      Query: target_field_mappings + target_field:fields embed,
 *        filtered by .eq('target_field.table_id', tm.target_table_id).
 *      Concern: the embedded-resource filter must drop TFMs whose
 *      target_field lives on a different table. `staging.ts` also
 *      belt-and-braces re-checks in-memory, so production is safe
 *      either way — this test verifies the SQL-side filter is doing
 *      what the production code expects, not whether production breaks.
 *
 *   3. `lib/actions/validation-rules.ts :: executeCustomRules` (3D-7)
 *      Query: mapping_sources + target_field_mapping!inner, filtered by
 *        .eq('target_field_mapping.project_id', projectId)
 *        .neq('target_field_mapping.status', 'rejected')
 *      Concern: both TFM-side filters must AND-combine on the parent
 *      TFM (not OR), AND only rows whose owning TFM satisfies both
 *      predicates must survive the `!inner` join.
 *
 *   4. `lib/actions/ai-quality-detection.ts :: runAIAugmentedChecks` (3D-8)
 *      Query: mapping_sources + target_field_mapping!inner, filtered by
 *        .neq('target_field_mapping.status', 'rejected')
 *        .order('ordinal', { ascending: true })
 *      Concern: the `!inner` drop must take effect for rejected TFMs,
 *      AND the order-by on a parent column must survive the inner
 *      filter (no reordering glitch).
 *
 * Verification strategy (per site):
 *   • Run the production query verbatim (copied into this file, not
 *     imported, so a regression in the production query shape is
 *     immediately visible vs a drift-by-proxy test).
 *   • Walk the returned rows and assert the filter invariants hold
 *     programmatically — i.e. "every row satisfies the claimed
 *     predicate". This is the strongest PostgREST-semantics guard.
 *   • Where possible, compare to an intentionally broader baseline
 *     query (dropping ONE of the filters) and verify the filter
 *     actually excluded rows — catches the case where the filter is
 *     a silent no-op.
 *
 * This test is SCAFFOLDED per the user directive in Step 3D-14:
 * implementation + build verification first, then the user runs it
 * locally against Heritage Core. Output is reviewed for correctness
 * BEFORE any pinning happens.
 *
 * Env-gated:
 *   RUN_POSTGREST_INTEGRATION     — REQUIRED explicit opt-in ('1').
 *                                   .env.local auto-loading alone is
 *                                   insufficient; this prevents
 *                                   accidental execution during
 *                                   scaffold/debug runs (see below).
 *   POSTGREST_HERITAGE_PROJECT_ID — preferred; uuid of a canary project
 *                                   with a non-trivial mapping graph
 *                                   (multi-source TFMs + VAs + at
 *                                   least one rejected TFM).
 *   HERITAGE_PROJECT_ID           — fallback.
 *   NEXT_PUBLIC_SUPABASE_URL      — required for admin client bootstrap.
 *   SUPABASE_SERVICE_ROLE_KEY     — required for privileged reads.
 *
 * Run locally (when the user is ready):
 *   RUN_POSTGREST_INTEGRATION=1 POSTGREST_HERITAGE_PROJECT_ID=... \
 *     NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/postgrest-filter-semantics.test.ts
 */

// This test requires explicit opt-in via RUN_POSTGREST_INTEGRATION=1.
// .env.local alone will not activate it. This prevents accidental
// execution during scaffold/debug runs. The test is read-only but
// reserved for reviewed runs.
const RUN_POSTGREST_INTEGRATION = process.env.RUN_POSTGREST_INTEGRATION === '1'

const HERITAGE_PROJECT_ID =
  process.env.POSTGREST_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  RUN_POSTGREST_INTEGRATION

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Shared setup helpers ────────────────────────────────────────────────────
//
// Each test needs a real TM (source_table_id, target_table_id), a
// real source_field list, and real target_field ids from the canary
// project. We fetch them once per test via tiny probes.

type AdminClient = Awaited<
  ReturnType<typeof import('@/lib/supabase/admin').supabaseAdmin.auth.getUser>
> extends unknown
  ? typeof import('@/lib/supabase/admin').supabaseAdmin
  : never

async function getAdmin(): Promise<AdminClient> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  return supabaseAdmin as AdminClient
}

async function pickAnyTM(
  admin: AdminClient,
): Promise<{ id: string; source_table_id: string; target_table_id: string }> {
  const { data, error } = await admin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', HERITAGE_PROJECT_ID)
    .neq('status', 'rejected')
    .limit(1)
  if (error) throw new Error(`pickAnyTM failed: ${error.message}`)
  if (!data || data.length === 0) {
    throw new Error(
      `No non-rejected table_mappings for project ${HERITAGE_PROJECT_ID}`,
    )
  }
  return data[0] as { id: string; source_table_id: string; target_table_id: string }
}

async function pickFieldsFromTable(
  admin: AdminClient,
  tableId: string,
  limit = 20,
): Promise<string[]> {
  const { data, error } = await admin
    .from('fields')
    .select('id')
    .eq('table_id', tableId)
    .limit(limit)
  if (error) throw new Error(`pickFieldsFromTable failed: ${error.message}`)
  return (data ?? []).map((r) => (r as { id: string }).id)
}

// ─── Site 1: 3D-5 staged-row-flags ───────────────────────────────────────────

describeFn(
  '[integration] PostgREST filter semantics — 3D-5 staged-row-flags MS-nested filters',
  () => {
    it('every returned TFM has at least one MS satisfying BOTH source_table_id AND source_field_id filters', async () => {
      const admin = await getAdmin()
      const tm = await pickAnyTM(admin)
      const fieldIds = await pickFieldsFromTable(admin, tm.source_table_id, 50)

      if (fieldIds.length === 0) {
        console.warn(
          `[3D-5 filter-semantics] no source fields on tm.source_table_id=${tm.source_table_id} — skip assertion`,
        )
        return
      }

      // Verbatim copy of the production query from
      // lib/actions/staged-row-flags.ts::Step 5.
      const { data: tfmRows, error } = await admin
        .from('target_field_mappings')
        .select(
          `
          id,
          mapping_sources!inner ( source_field_id, source_table_id ),
          target_field:fields!target_field_id ( name, table_id )
        `,
        )
        .eq('project_id', HERITAGE_PROJECT_ID)
        .neq('status', 'rejected')
        .eq('mapping_sources.source_table_id', tm.source_table_id)
        .in('mapping_sources.source_field_id', fieldIds)

      expect(error).toBeNull()

      type Row = {
        id: string
        mapping_sources: Array<{ source_field_id: string | null; source_table_id: string | null }>
        target_field: { name: string; table_id: string } | { name: string; table_id: string }[] | null
      }

      const rows = (tfmRows ?? []) as unknown as Row[]
      console.log(
        `[3D-5 filter-semantics] TM=${tm.id} source_table=${tm.source_table_id} returned ${rows.length} TFMs`,
      )

      for (const row of rows) {
        // Invariant: within the returned MS array, at least one row
        // must satisfy BOTH predicates simultaneously (AND on the
        // nested resource, NOT OR across separate rows).
        const conforming = row.mapping_sources.filter(
          (ms) =>
            ms.source_table_id === tm.source_table_id &&
            ms.source_field_id != null &&
            fieldIds.includes(ms.source_field_id),
        )
        expect(
          conforming.length,
          `TFM ${row.id} has MS array [${row.mapping_sources
            .map((m) => `(src_tbl=${m.source_table_id},src_fld=${m.source_field_id})`)
            .join(', ')}] — none simultaneously match source_table=${tm.source_table_id} AND source_field IN requested list. PostgREST filter broke AND semantics.`,
        ).toBeGreaterThan(0)
      }
    }, 45_000)
  },
)

// ─── Site 2: 3D-6 staging ───────────────────────────────────────────────────

describeFn(
  '[integration] PostgREST filter semantics — 3D-6 staging target_field.table_id embedded filter',
  () => {
    it('every returned TFM has target_field.table_id matching tm.target_table_id', async () => {
      const admin = await getAdmin()
      const tm = await pickAnyTM(admin)

      // Verbatim copy of the production query from
      // lib/actions/staging.ts::stageAllData.
      const { data: projectTfms, error } = await admin
        .from('target_field_mappings')
        .select(
          `
          id,
          combination_type,
          target_field_id,
          mapping_sources (
            ordinal,
            source_table_id,
            source_field:fields!source_field_id ( id, name )
          ),
          target_field:fields!target_field_id ( id, name, table_id )
        `,
        )
        .eq('project_id', HERITAGE_PROJECT_ID)
        .neq('status', 'rejected')
        .eq('target_field.table_id', tm.target_table_id)

      expect(error).toBeNull()

      type Row = {
        id: string
        target_field: { id: string; name: string; table_id: string } | { id: string; name: string; table_id: string }[] | null
      }

      const rows = (projectTfms ?? []) as unknown as Row[]
      console.log(
        `[3D-6 filter-semantics] TM=${tm.id} target_table=${tm.target_table_id} returned ${rows.length} TFMs`,
      )

      // Intentionally broader baseline — no target_field.table_id
      // filter. If the embedded filter is a silent no-op, the counts
      // will be identical (strong evidence of a filter failure on
      // projects with multiple target tables).
      const { data: baseline } = await admin
        .from('target_field_mappings')
        .select('id, target_field:fields!target_field_id ( table_id )')
        .eq('project_id', HERITAGE_PROJECT_ID)
        .neq('status', 'rejected')

      const baselineCount = (baseline ?? []).length
      console.log(
        `[3D-6 filter-semantics] baseline (no table_id filter): ${baselineCount} TFMs`,
      )

      // PostgREST embedded-resource `.eq()` behaviour: the filter
      // drops non-matching EMBEDDED rows (replaces with null) but
      // does NOT drop the parent. `staging.ts` follows up with an
      // in-memory filter on `tgt.table_id !== tm.target_table_id`,
      // which is why production works either way. We document the
      // observed behaviour here rather than assert a specific
      // count-shrink — the goal is to verify what PostgREST actually
      // does so future readers can reason about it.
      for (const row of rows) {
        const tgt = Array.isArray(row.target_field)
          ? row.target_field[0] ?? null
          : row.target_field
        if (tgt !== null) {
          // When the embedded row IS present, its table_id MUST match
          // the filter — that is the one guarantee we can rely on.
          expect(
            tgt.table_id,
            `TFM ${row.id} returned target_field with table_id=${tgt.table_id} but filter required ${tm.target_table_id} — embedded filter broken.`,
          ).toBe(tm.target_table_id)
        }
      }
    }, 45_000)
  },
)

// ─── Site 3: 3D-7 validation-rules ──────────────────────────────────────────

describeFn(
  '[integration] PostgREST filter semantics — 3D-7 validation-rules TFM!inner project_id + status',
  () => {
    it('every returned MS has an inner-joined TFM with project_id==projectId AND status!=rejected', async () => {
      const admin = await getAdmin()
      const tm = await pickAnyTM(admin)
      const ruleFieldIds = [
        ...(await pickFieldsFromTable(admin, tm.source_table_id, 25)),
        ...(await pickFieldsFromTable(admin, tm.target_table_id, 25)),
      ]

      if (ruleFieldIds.length === 0) {
        console.warn(`[3D-7 filter-semantics] no fields to exercise — skip`)
        return
      }

      // Verbatim copy of the (a) source-side query from
      // lib/actions/validation-rules.ts::executeCustomRules.
      const { data: msSourceRows, error } = await admin
        .from('mapping_sources')
        .select(
          `
          source_field_id,
          target_field_mapping:target_field_mappings!inner (
            id, project_id, status
          )
        `,
        )
        .in('source_field_id', ruleFieldIds)
        .eq('target_field_mapping.project_id', HERITAGE_PROJECT_ID)
        .neq('target_field_mapping.status', 'rejected')

      expect(error).toBeNull()

      type Row = {
        source_field_id: string | null
        target_field_mapping:
          | { id: string; project_id: string; status: string }
          | { id: string; project_id: string; status: string }[]
          | null
      }

      const rows = (msSourceRows ?? []) as unknown as Row[]
      console.log(
        `[3D-7 filter-semantics] project=${HERITAGE_PROJECT_ID} returned ${rows.length} MS rows`,
      )

      for (const row of rows) {
        const tfm = Array.isArray(row.target_field_mapping)
          ? row.target_field_mapping[0] ?? null
          : row.target_field_mapping
        expect(
          tfm,
          `MS (src_fld=${row.source_field_id}) returned with NULL target_field_mapping — !inner join failed.`,
        ).not.toBeNull()
        expect(
          tfm!.project_id,
          `MS (src_fld=${row.source_field_id}) has TFM project_id=${tfm!.project_id}; filter required ${HERITAGE_PROJECT_ID}.`,
        ).toBe(HERITAGE_PROJECT_ID)
        expect(
          tfm!.status,
          `MS (src_fld=${row.source_field_id}) has TFM status=${tfm!.status}; filter required != rejected.`,
        ).not.toBe('rejected')
      }
    }, 45_000)
  },
)

// ─── Site 4: 3D-8 ai-quality-detection ──────────────────────────────────────

describeFn(
  '[integration] PostgREST filter semantics — 3D-8 ai-quality-detection TFM!inner status + ordinal order',
  () => {
    it('every returned MS has TFM status!=rejected AND rows are ordinal-ascending', async () => {
      const admin = await getAdmin()
      const tm = await pickAnyTM(admin)
      // ai-quality-detection builds fieldIdList from a source table.
      const fieldIdList = await pickFieldsFromTable(admin, tm.source_table_id, 50)

      if (fieldIdList.length === 0) {
        console.warn(`[3D-8 filter-semantics] no source fields — skip`)
        return
      }

      // Verbatim copy of the production query from
      // lib/actions/ai-quality-detection.ts::runAIAugmentedChecks.
      const { data: mappings, error } = await admin
        .from('mapping_sources')
        .select(
          `
          ordinal,
          type_compatibility,
          source_field:fields!source_field_id ( name, data_type ),
          target_field_mapping:target_field_mappings!inner (
            status,
            target_field:fields!target_field_id ( name, data_type, is_nullable )
          )
        `,
        )
        .in('source_field_id', fieldIdList)
        .neq('target_field_mapping.status', 'rejected')
        .order('ordinal', { ascending: true })

      expect(error).toBeNull()

      type Row = {
        ordinal: number
        target_field_mapping:
          | { status: string; target_field: unknown }
          | { status: string; target_field: unknown }[]
          | null
      }

      const rows = (mappings ?? []) as unknown as Row[]
      console.log(
        `[3D-8 filter-semantics] tm.source_table=${tm.source_table_id} returned ${rows.length} MS rows`,
      )

      // Invariant 1: every row's TFM.status != 'rejected'.
      for (const row of rows) {
        const tfm = Array.isArray(row.target_field_mapping)
          ? row.target_field_mapping[0] ?? null
          : row.target_field_mapping
        expect(
          tfm,
          `MS (ordinal=${row.ordinal}) has null TFM — !inner join failed.`,
        ).not.toBeNull()
        expect(
          tfm!.status,
          `MS (ordinal=${row.ordinal}) has TFM status=${tfm!.status}; filter required != rejected.`,
        ).not.toBe('rejected')
      }

      // Invariant 2: rows are ordinal-ascending (order-by survived
      // the inner join).
      for (let i = 1; i < rows.length; i++) {
        expect(
          rows[i].ordinal,
          `rows[${i}].ordinal=${rows[i].ordinal} < rows[${i - 1}].ordinal=${rows[i - 1].ordinal} — order-by broke across !inner join.`,
        ).toBeGreaterThanOrEqual(rows[i - 1].ordinal)
      }
    }, 45_000)
  },
)
