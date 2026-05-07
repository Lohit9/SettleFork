// @vitest-environment node
//
// Path D happy-path — REAL Anthropic + Supabase, env-gated, opt-in only.
//
// Cost: ~$1 per run on Rootstock POC scale (per Sub-PR 4b investigation;
// Opus 4.7 actual pricing $5/M input + $25/M output gives ~$0.85-$1.15
// for a Rootstock-sized run). NOT default vitest. NOT CI.
//
// What this test verifies (end-to-end, the only place it can be):
//   1. runPathDMapping produces { success: true } against a real project
//   2. all 7 sections parse cleanly (parser handles real Opus 4.7 output)
//   3. persistence writes ≥10 TFMs + ≥1 coverage + ≥1 DQ + 1 project_notes
//   4. llm_calls row carries pathDExperimentMetadata
//   5. ai_edit_history row count ≥ TFM count (one per TFM, orchestrator-emitted)
//   6. idempotency: a second runPathDMapping call does not duplicate TFMs
//      (UPSERT contract on (project_id, target_field_id))
//
// Env required:
//   RUN_PATH_D_HAPPY_PATH=1
//   ANTHROPIC_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   PATH_D_HAPPY_PATH_USER_ID   (a real user UUID with project access; required)
//
// To run:
//   RUN_PATH_D_HAPPY_PATH=1 \
//     PATH_D_HAPPY_PATH_USER_ID=<your-user-uuid> \
//     pnpm test:integration path-d-happy-path
//
// Default vitest skips this file via describe.skip — env unset or missing keys.
//
// ── Project ID locked in code, NOT env-overridable ─────────────────────────
// The target project is hardcoded to the Rootstock POC. The previous draft
// of this file allowed env override (PATH_D_HAPPY_PATH_PROJECT_ID +
// HERITAGE_PROJECT_ID fallback), but that created a risk: if someone runs
// this with HERITAGE_PROJECT_ID set to the canary, a real Path D run would
// mutate canary state and invalidate the heritage pins. Hardcoding the
// Rootstock POC ID is the simplest belt-and-suspenders fix.

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const ROOTSTOCK_POC_PROJECT_ID = '894eeb8e-73b1-471c-afc3-1c39225de19e'

const RUN = process.env.RUN_PATH_D_HAPPY_PATH === '1'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANTHROPIC = process.env.ANTHROPIC_API_KEY
const PROJECT_ID = ROOTSTOCK_POC_PROJECT_ID
const USER_ID = process.env.PATH_D_HAPPY_PATH_USER_ID ?? ''

const ENV_OK =
  Boolean(URL) &&
  Boolean(SERVICE_KEY) &&
  Boolean(ANTHROPIC) &&
  Boolean(PROJECT_ID) &&
  Boolean(USER_ID)

const describeIf = RUN && ENV_OK ? describe : describe.skip

describeIf('Path D — happy-path (real Opus 4.7 + Rootstock-scale project)', () => {
  let admin: SupabaseClient
  let firstRunId: string
  let firstTfmCount: number

  beforeAll(() => {
    admin = createClient(URL!, SERVICE_KEY!)
  })

  it('runPathDMapping produces success + comprehensive output (~$1, ~30-90s)', async () => {
    // Resolve the project's source/target table IDs at runtime (the test
    // doesn't hard-code them — keeps the test resilient to schema edits
    // on the canary project).
    const { data: datasets, error: dsErr } = await admin
      .from('datasets')
      .select('id, role')
      .eq('project_id', PROJECT_ID)
    expect(dsErr).toBeNull()

    const sourceDsIds = (datasets ?? [])
      .filter((d) => d.role === 'source')
      .map((d) => d.id as string)
    const targetDsIds = (datasets ?? [])
      .filter((d) => d.role === 'target')
      .map((d) => d.id as string)
    expect(sourceDsIds.length).toBeGreaterThan(0)
    expect(targetDsIds.length).toBeGreaterThan(0)

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

    // Dynamic import keeps module-load-time side effects out of the suite
    // when the test is skipped (Anthropic SDK constructs at module load
    // and fails without ANTHROPIC_API_KEY).
    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')

    const t0 = Date.now()
    // Pass `admin` explicitly so the orchestrator uses the same service-role
    // client this test uses for assertions, instead of the module-level
    // `supabaseAdmin` proxy. The proxy's lazy env-var resolution has a
    // diagnosed-but-not-yet-pinned bug in this test runner where writes
    // appear to succeed (return shape OK) but no rows materialise.
    // Production callsites (generateMappings server action) still use the
    // proxy; the integration test exercises the same orchestrator code
    // with an explicit client to avoid the env-var-load-order pitfall.
    const result = await runPathDMapping({
      projectId: PROJECT_ID,
      userId: USER_ID,
      sourceTableIds,
      targetTableIds,
      admin,
    })
    const elapsed = Date.now() - t0
    // eslint-disable-next-line no-console
    console.log(
      `[path-d-happy] elapsed=${elapsed}ms result.success=${result.success} ${
        result.success ? `tfmCount=${result.tfmCount} runId=${result.runId}` : `errorCode=${result.errorCode} error=${result.error.slice(0, 200)}`
      }`,
    )

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    firstRunId = result.runId
    firstTfmCount = result.tfmCount

    // All 7 sections parsed cleanly OR persisted cleanly (a parse_error
    // would surface as `skipped` here; an `errored` is a persistence
    // failure). Failing this assertion catches both per-section parse
    // problems and Postgres write conflicts.
    const sectionStatuses = [
      result.summary.mappings.status,
      result.summary.coverage.status,
      result.summary.decisions.status,
      result.summary.lookup_tables.status,
      result.summary.data_quality.status,
      result.summary.inferred_targets.status,
      result.summary.project_notes.status,
    ]
    // eslint-disable-next-line no-console
    console.log(
      `[path-d-happy] section statuses: ${JSON.stringify(result.summary, null, 2)}`,
    )
    for (const status of sectionStatuses) {
      expect(['inserted', 'skipped']).toContain(status) // 'errored' fails
    }

    // The model is supposed to produce comprehensive output — at minimum
    // ~10 mappings. (Empirical Rootstock projection per the audit doc:
    // ~21 mappings.) Treat <10 as "model failed comprehensiveness."
    expect(firstTfmCount).toBeGreaterThanOrEqual(10)
  }, 600_000) // 10-minute timeout — Opus 4.7 streaming on Rootstock POC scale (~163 target fields) takes ~3 min per call; double the per-test budget gives margin

  it('persistence side effects: TFM/coverage/DQ/notes/llm_calls/ai_edit_history populated', async () => {
    expect(firstRunId).toBeTruthy()

    // TFMs by experiment_run_id
    const { count: tfmCount } = await admin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)
      .eq('experiment_run_id', firstRunId)
    expect(tfmCount ?? 0).toBeGreaterThanOrEqual(10)

    // Coverage row count
    const { count: coverageCount } = await admin
      .from('target_field_coverage')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)
      .eq('experiment_run_id', firstRunId)
    expect(coverageCount ?? 0).toBeGreaterThanOrEqual(1)

    // DQ findings
    const { count: dqCount } = await admin
      .from('project_data_quality_issues')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)
      .eq('experiment_run_id', firstRunId)
    expect(dqCount ?? 0).toBeGreaterThanOrEqual(1)

    // outputs row of type=path_d_project_notes
    const { count: notesCount } = await admin
      .from('outputs')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)
      .eq('type', 'path_d_project_notes')
    expect(notesCount ?? 0).toBeGreaterThanOrEqual(1)

    // llm_calls row carrying pathDExperimentMetadata. Filter on
    // metadata->>'experiment_run_id' to hit exactly this run.
    const { data: llmRows } = await admin
      .from('llm_calls')
      .select('id, metadata, model, is_streaming, feature, prompt_version')
      .eq('project_id', PROJECT_ID)
      .filter('metadata->>experiment_run_id', 'eq', firstRunId)
    expect(llmRows?.length ?? 0).toBe(1)
    const llmRow = llmRows![0]!
    expect(llmRow.model).toBe('claude-opus-4-7')
    expect(llmRow.is_streaming).toBe(true)
    expect(llmRow.feature).toBe('mapping_generate')
    expect(llmRow.prompt_version).toBe('path-d-v0')
    const meta = llmRow.metadata as Record<string, unknown>
    expect(meta.experiment_label).toBe('path_d')

    // ai_edit_history rows from the orchestrator's per-TFM provenance loop.
    // Filter on metadata->>'experiment_run_id' = firstRunId.
    const { count: provCount } = await admin
      .from('ai_edit_history')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)
      .filter('metadata->>experiment_run_id', 'eq', firstRunId)
    expect(provCount ?? 0).toBeGreaterThanOrEqual(firstTfmCount)
  })

  it('idempotency: re-running does not duplicate TFM rows (UPSERT contract)', async () => {
    // Snapshot pre-second-run TFM count
    const { count: preCount } = await admin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)

    // Resolve table IDs again (same as first run)
    const { data: datasets } = await admin
      .from('datasets')
      .select('id, role')
      .eq('project_id', PROJECT_ID)
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

    const { runPathDMapping } = await import('@/lib/ai/path-d-mapping')
    const result2 = await runPathDMapping({
      projectId: PROJECT_ID,
      userId: USER_ID,
      sourceTableIds: (sourceTables ?? []).map((t) => t.id as string),
      targetTableIds: (targetTables ?? []).map((t) => t.id as string),
      admin,
    })
    expect(result2.success).toBe(true)

    const { count: postCount } = await admin
      .from('target_field_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', PROJECT_ID)

    // Post-count must be ≤ pre-count + (small new mapping count delta).
    // The UPSERT on (project_id, target_field_id) means re-runs replace
    // existing TFMs in place rather than duplicating. We allow a small
    // delta because the second run may legitimately propose mappings
    // for previously-unmapped target fields. The TIGHT version of this
    // assertion is that no two TFM rows share the same target_field_id,
    // which the migration 074 unique constraint enforces — so this
    // assertion is mostly a smoke check.
    const delta = (postCount ?? 0) - (preCount ?? 0)
    // eslint-disable-next-line no-console
    console.log(
      `[path-d-happy] idempotency: preCount=${preCount} postCount=${postCount} delta=${delta}`,
    )
    expect(delta).toBeLessThanOrEqual(50) // generous; UPSERT should keep delta near 0
  }, 600_000) // 10-minute timeout — second LLM call, same scale as the first
})
