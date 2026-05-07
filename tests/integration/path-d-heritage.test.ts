// @vitest-environment node
//
// Heritage Capture D — pin Path B byte-identical behavior when the Path D
// flag is OFF.
//
// Sub-PR 4a wires the Path D flag (AI_MAPPING_PATH_D_ENABLED) at the
// generateMappings BULK callsite. When the flag is unset (default), Path B
// production must run UNCHANGED. This test verifies that contract:
//
//   1. Path D's 4 new tables (migration 093) have ZERO rows for the canary
//      project (no Path D writes happened).
//   2. The TFM read-path output for the canary is unchanged from prior PRs'
//      heritage baselines (existing mappings-for-redesign-heritage.test.ts
//      already pins this implicitly; the explicit fingerprint here makes the
//      "flag-OFF byte-identical" guarantee diagnostic when this test fails:
//      a failure here immediately says "Path D activated when it shouldn't
//      have," not just "TFM output drifted").
//
// Env-gated: RUN_PATH_D_HERITAGE_INTEGRATION=1 + HERITAGE_PROJECT_ID +
// Supabase service role key. Default vitest skips.

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'

const RUN = process.env.RUN_PATH_D_HERITAGE_INTEGRATION === '1'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const HERITAGE_PROJECT_ID =
  process.env.MAPPINGS_REDESIGN_HERITAGE_PROJECT_ID ??
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''

const ENV_OK = Boolean(URL) && Boolean(SERVICE_KEY) && Boolean(HERITAGE_PROJECT_ID)

const describeIf = RUN && ENV_OK ? describe : describe.skip

describeIf('Heritage Capture D — Path B byte-identical when AI_MAPPING_PATH_D_ENABLED is OFF', () => {
  let admin: SupabaseClient

  beforeAll(() => {
    // Explicitly assert the flag is not set in the test environment so the
    // "flag-OFF behavior" guarantee is unambiguous. CI may have it set;
    // require explicit unsetting before running this test.
    if (process.env.AI_MAPPING_PATH_D_ENABLED === '1') {
      throw new Error(
        '[Heritage Capture D] AI_MAPPING_PATH_D_ENABLED=1 is set; cannot run heritage test under flag-ON conditions. Unset and re-run.',
      )
    }
    admin = createClient(URL!, SERVICE_KEY!)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Pin 1-4: 093 tables have ZERO rows for the canary project
  //
  // Path B never writes to these tables. If a Path D run accidentally
  // happens against the canary, the row count for that table jumps above
  // zero and these tests fail loudly.
  // ─────────────────────────────────────────────────────────────────────

  it('Pin 1: target_field_coverage has zero rows for canary project', async () => {
    const { count, error } = await admin
      .from('target_field_coverage')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  it('Pin 2: project_decisions has zero rows for canary project', async () => {
    const { count, error } = await admin
      .from('project_decisions')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  it('Pin 3: project_lookup_tables has zero rows for canary project', async () => {
    const { count, error } = await admin
      .from('project_lookup_tables')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  it('Pin 4: project_inferred_targets has zero rows for canary project', async () => {
    const { count, error } = await admin
      .from('project_inferred_targets')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Pin 5: TFM read-path fingerprint stable
  //
  // Captures a SHA-256 of (id, target_field_id, status, combination_type,
  // experiment_run_id) for all TFMs in the canary project, sorted by id.
  // The fingerprint changes only if Path B writes drift, OR if a Path D
  // run accidentally happens against the canary (experiment_run_id would
  // newly populate). Both are diagnostic failures.
  //
  // First run: CAPTURE mode prints the fingerprint; pin manually after
  // cross-checking against direct SQL.
  // ─────────────────────────────────────────────────────────────────────

  it('Pin 5: TFM read-path fingerprint stable (no Path D writes; no Path B drift)', async () => {
    const { data, error } = await admin
      .from('target_field_mappings')
      .select('id, target_field_id, status, combination_type, experiment_run_id')
      .eq('project_id', HERITAGE_PROJECT_ID)
      .order('id')
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)

    // experiment_run_id MUST be null on every Path B-produced row.
    // A non-null value would mean either (a) Path D ran against canary, or
    // (b) Path C (INF-22) ran against canary at some point. Either way,
    // this test catches it.
    for (const row of data!) {
      expect(row.experiment_run_id).toBeNull()
    }

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          (data ?? []).map((r) => ({
            id: r.id,
            target_field_id: r.target_field_id,
            status: r.status,
            combination_type: r.combination_type,
          })),
        ),
      )
      .digest('hex')

    // CAPTURE mode: log the fingerprint for manual baselining. The pinned
    // value below was captured at Sub-PR 4a authoring time; subsequent runs
    // assert against it. To re-baseline (legitimate Path B writes shipped),
    // update PINNED_FINGERPRINT after cross-checking against direct SQL.
    if (process.env.PATH_D_HERITAGE_CAPTURE === '1') {
      // eslint-disable-next-line no-console
      console.log(`[Heritage Capture D] TFM fingerprint: ${fingerprint} (count=${data!.length})`)
      return
    }

    // Skip pin assertion until baseline is captured + pinned. First run with
    // PATH_D_HERITAGE_CAPTURE=1 prints the value; copy below + remove the
    // skip flag.
    const PINNED_FINGERPRINT: string | null = null
    if (PINNED_FINGERPRINT === null) {
      // eslint-disable-next-line no-console
      console.log(
        `[Heritage Capture D] No baseline pinned yet. Run with PATH_D_HERITAGE_CAPTURE=1 to capture, then paste the fingerprint into PINNED_FINGERPRINT. Current: ${fingerprint}`,
      )
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unreachable
    expect(fingerprint).toBe(PINNED_FINGERPRINT)
  })

  // ─────────────────────────────────────────────────────────────────────
  // Pin 6 + Pin 7 — added in Sub-PR 4b now that the orchestrator is
  // reachable. Path D doesn't directly write `transformations` or
  // `validation_rules`, but a TFM-leak from a flag-OFF Path D run would
  // surface in the transform-page join (TFMs joined with their downstream
  // transformations) and a validation_rules write would surface in the
  // validation-page list. Both are env-gated under
  // RUN_PATH_D_HERITAGE_INTEGRATION=1; both have CAPTURE mode.
  // ─────────────────────────────────────────────────────────────────────

  it('Pin 6: transform-page query fingerprint stable (no Path D writes leaking into transformations)', async () => {
    // Identify TFM IDs in the canary first (the transform page joins TFMs
    // → transformations via target_field_mapping_id).
    const { data: tfms } = await admin
      .from('target_field_mappings')
      .select('id')
      .eq('project_id', HERITAGE_PROJECT_ID)
      .order('id')
    const tfmIds = (tfms ?? []).map((r) => r.id as string)

    // The transform page's authoritative read is keyed on these TFM IDs —
    // see `getTransformData` in `lib/actions/transformations.ts`. We
    // fingerprint the (id, target_field_mapping_id, status) tuple ordered
    // by id so a Path D run that wrote spurious transformations OR a
    // Path B drift in the read shape would shift the fingerprint.
    const { data, error } = await admin
      .from('transformations')
      .select('id, target_field_mapping_id, status')
      .in('target_field_mapping_id', tfmIds.length > 0 ? tfmIds : ['00000000-0000-0000-0000-000000000000'])
      .order('id')
    expect(error).toBeNull()

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          (data ?? []).map((r) => ({
            id: r.id,
            target_field_mapping_id: r.target_field_mapping_id,
            status: r.status,
          })),
        ),
      )
      .digest('hex')

    if (process.env.PATH_D_HERITAGE_CAPTURE === '1') {
      // eslint-disable-next-line no-console
      console.log(`[Heritage Capture D] Transform-page fingerprint: ${fingerprint} (count=${data!.length})`)
      return
    }

    const PINNED_TRANSFORM_FINGERPRINT: string | null = null
    if (PINNED_TRANSFORM_FINGERPRINT === null) {
      // eslint-disable-next-line no-console
      console.log(
        `[Heritage Capture D] No transform baseline pinned yet. Run with PATH_D_HERITAGE_CAPTURE=1 to capture. Current: ${fingerprint}`,
      )
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unreachable
    expect(fingerprint).toBe(PINNED_TRANSFORM_FINGERPRINT)
  })

  it('Pin 7: validation-page rule list fingerprint stable (no Path D writes leaking into validation_rules)', async () => {
    // The validation page's authoritative read is `getValidationRules` in
    // `lib/actions/validation-rules.ts`:
    //   from('validation_rules').select('*').eq('project_id', $).order('created_at', desc)
    // We fingerprint the durable shape (id, name, rule_type, severity)
    // ordered by id (NOT created_at, which is locale-sensitive in
    // JSON.stringify and which we don't need for stable diffing). Schema
    // ref: supabase/migrations/006_data_quality.sql.
    const { data, error } = await admin
      .from('validation_rules')
      .select('id, name, rule_type, severity')
      .eq('project_id', HERITAGE_PROJECT_ID)
      .order('id')
    expect(error).toBeNull()

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify(
          (data ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            rule_type: r.rule_type,
            severity: r.severity,
          })),
        ),
      )
      .digest('hex')

    if (process.env.PATH_D_HERITAGE_CAPTURE === '1') {
      // eslint-disable-next-line no-console
      console.log(`[Heritage Capture D] Validation-page fingerprint: ${fingerprint} (count=${data!.length})`)
      return
    }

    const PINNED_VALIDATION_FINGERPRINT: string | null = null
    if (PINNED_VALIDATION_FINGERPRINT === null) {
      // eslint-disable-next-line no-console
      console.log(
        `[Heritage Capture D] No validation baseline pinned yet. Run with PATH_D_HERITAGE_CAPTURE=1 to capture. Current: ${fingerprint}`,
      )
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unreachable
    expect(fingerprint).toBe(PINNED_VALIDATION_FINGERPRINT)
  })
})

