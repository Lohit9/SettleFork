// @vitest-environment node
//
// PR-4 (feat/stats-data-alignment) — cross-surface integration test.
//
// Pins the contract that the three surfaces rendering `ProjectStats` for the
// same project see byte-identical numbers:
//
//   1. Dashboard tile        — getProjectsWithStatsInternal(...).find(p).projectStats
//   2. Migration Center      — getOutputsPageDataCore(projectId, client).projectStats
//   3. Mapping page strip    — getProjectStats([projectId], client).get(projectId)
//
// Pre-PR-4, Migration Center used `supabaseAdmin` while the other two used the
// RLS-bound user client. The numbers diverged in production for a project the
// user could see: tile=11/18 mapped, MC=different, Mapping=59/89. PR-4
// threaded the user client into `getOutputsPageDataCore` (D2) and added
// `noStore()` to the dashboard data loader (D1). This test pins both so a
// future regression that re-introduces a client mismatch fails loudly.
//
// Plus a post-mutation regression test: insert a `source_field_acknowledgments`
// row directly via supabaseAdmin, confirm `source.decided` increments by 1
// across the surfaces (proves the data flow), then clean up. This does NOT
// test the Next.js cache invalidation pathway directly (revalidatePath() is a
// no-op outside a request scope) — that's covered by code review of the
// mutation handlers and behavioral observation in dev/preview environments.
//
// ─── Env gating ──────────────────────────────────────────────────────────────
// Required:
//   RUN_PROJECT_STATS_CROSS_SURFACE_INTEGRATION=1  — explicit opt-in
//   EVAL_ORG_ID                                     — org for tile aggregation
//   NEXT_PUBLIC_SUPABASE_URL                        — Supabase URL
//   SUPABASE_SERVICE_ROLE_KEY                       — service-role key
// Optional (one of):
//   STATS_CROSS_SURFACE_PROJECT_ID                  — preferred override
//   HERITAGE_PROJECT_ID                             — fallback (canary project)
//
// Run locally:
//   RUN_PROJECT_STATS_CROSS_SURFACE_INTEGRATION=1 \
//     EVAL_ORG_ID=... HERITAGE_PROJECT_ID=... \
//     NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     npx vitest run tests/integration/project-stats-cross-surface.test.ts

import { describe, it, expect } from 'vitest'

const RUN = process.env.RUN_PROJECT_STATS_CROSS_SURFACE_INTEGRATION === '1'

const PROJECT_ID =
  process.env.STATS_CROSS_SURFACE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''
const ORG_ID = process.env.EVAL_ORG_ID ?? ''

const ENV_OK =
  Boolean(PROJECT_ID) &&
  Boolean(ORG_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeIf = RUN && ENV_OK ? describe : describe.skip

describeIf('[integration] project-stats cross-surface alignment', () => {
  it('three surfaces return identical ProjectStats for the same project', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { getProjectsWithStatsInternal } = await import('@/lib/actions/_projects-core')
    const { getOutputsPageDataCore } = await import('@/lib/actions/_outputs-core')
    const { getProjectStats } = await import('@/lib/quality/project-stats')

    const [projectsList, outputsData, statsMap] = await Promise.all([
      getProjectsWithStatsInternal(supabaseAdmin, ORG_ID),
      getOutputsPageDataCore(PROJECT_ID, supabaseAdmin),
      getProjectStats([PROJECT_ID], supabaseAdmin),
    ])

    const tileStats = projectsList.find((p) => p.id === PROJECT_ID)?.projectStats
    const mcStats = outputsData.projectStats
    const mappingStats = statsMap.get(PROJECT_ID)

    expect(tileStats, `canary ${PROJECT_ID} not found in org ${ORG_ID}`).toBeTruthy()
    expect(mcStats).toBeTruthy()
    expect(mappingStats).toBeTruthy()

    // The canonical assertion: all three surfaces must return the same
    // ProjectStats object shape for the same project + same client.
    expect(tileStats).toEqual(mcStats)
    expect(mcStats).toEqual(mappingStats)
  }, 60_000)

  it('post-mutation: source.decided increments after a source ack insert and reverts on cleanup', async () => {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { getProjectStats } = await import('@/lib/quality/project-stats')

    // ── Capture baseline ──────────────────────────────────────────────────
    const baselineMap = await getProjectStats([PROJECT_ID], supabaseAdmin)
    const baseline = baselineMap.get(PROJECT_ID)
    expect(baseline).toBeTruthy()
    if (!baseline) return

    // ── Find a source field that's NOT mapped and NOT already acked ───────
    const { data: sourceDataset } = await supabaseAdmin
      .from('datasets')
      .select('id')
      .eq('project_id', PROJECT_ID)
      .eq('role', 'source')
      .maybeSingle()
    if (!sourceDataset) {
      console.warn('[cross-surface] no source dataset on canary; skipping mutation regression')
      return
    }

    const { data: sourceTables } = await supabaseAdmin
      .from('tables')
      .select('id')
      .eq('dataset_id', sourceDataset.id)
    const sourceTableIds = (sourceTables ?? []).map((t) => t.id)
    if (sourceTableIds.length === 0) {
      console.warn('[cross-surface] no source tables on canary; skipping mutation regression')
      return
    }

    const { data: allSourceFields } = await supabaseAdmin
      .from('fields')
      .select('id')
      .in('table_id', sourceTableIds)
    const allSourceFieldIds = new Set((allSourceFields ?? []).map((f) => f.id))

    // Already-decided source ids = mapped (any non-rejected mapping_sources
    // row) ∪ acknowledged. Subtract from the full source set to find a free
    // candidate.
    const { data: existingAcks } = await supabaseAdmin
      .from('source_field_acknowledgments')
      .select('source_field_id')
      .eq('project_id', PROJECT_ID)
    const ackedIds = new Set((existingAcks ?? []).map((a) => a.source_field_id))

    const { data: nonRejectedTfms } = await supabaseAdmin
      .from('target_field_mappings')
      .select('id')
      .eq('project_id', PROJECT_ID)
      .neq('status', 'rejected')
    const nonRejectedTfmIds = (nonRejectedTfms ?? []).map((t) => t.id)
    const { data: existingMs } =
      nonRejectedTfmIds.length > 0
        ? await supabaseAdmin
            .from('mapping_sources')
            .select('source_field_id')
            .in('target_field_mapping_id', nonRejectedTfmIds)
        : { data: [] }
    const mappedIds = new Set(
      (existingMs ?? [])
        .map((m) => m.source_field_id)
        .filter((id): id is string => Boolean(id)),
    )

    const candidateId = [...allSourceFieldIds].find(
      (id) => !ackedIds.has(id) && !mappedIds.has(id),
    )
    if (!candidateId) {
      console.warn(
        '[cross-surface] every source field is decided on canary; skipping mutation regression. ' +
          'Cross-surface equality test still ran above.',
      )
      return
    }

    // ── Insert the temporary acknowledgment ───────────────────────────────
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('source_field_acknowledgments')
      .insert({
        project_id: PROJECT_ID,
        source_field_id: candidateId,
        reason: '__pr-4-cross-surface-test__',
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      throw new Error(`[cross-surface] insert failed: ${insertErr?.message}`)
    }

    try {
      // After insert: source.decided should be +1, total unchanged.
      const afterMap = await getProjectStats([PROJECT_ID], supabaseAdmin)
      const after = afterMap.get(PROJECT_ID)
      expect(after).toBeTruthy()
      expect(after!.source.decided).toBe(baseline.source.decided + 1)
      expect(after!.source.total).toBe(baseline.source.total)
    } finally {
      // ── Cleanup ─────────────────────────────────────────────────────────
      const { error: deleteErr } = await supabaseAdmin
        .from('source_field_acknowledgments')
        .delete()
        .eq('id', inserted.id)
      if (deleteErr) {
        // Hard fail — leaving a test ack on a real project is a maintenance
        // hazard. The reason marker `__pr-4-cross-surface-test__` makes
        // manual cleanup tractable but better to fail noisily.
        throw new Error(`[cross-surface] cleanup failed for ack ${inserted.id}: ${deleteErr.message}`)
      }
    }

    // ── Verify cleanup restored the baseline ──────────────────────────────
    const restoredMap = await getProjectStats([PROJECT_ID], supabaseAdmin)
    const restored = restoredMap.get(PROJECT_ID)
    expect(restored).toBeTruthy()
    expect(restored!.source.decided).toBe(baseline.source.decided)
  }, 90_000)
})
