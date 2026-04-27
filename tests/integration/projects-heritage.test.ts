// @vitest-environment node
// Integration test — must run in Node (not jsdom). `projects.ts` lives
// behind `'use server'` and its transitive imports refuse to
// initialize in a browser-like environment. Node is the correct
// environment for tests that hit Supabase over the network anyway.

import { describe, it, expect } from 'vitest'

/**
 * Heritage baseline for `getProjectsWithStats` (Prompt 3d, Step 3D-11).
 *
 * Purpose: post-rewrite regression guard for the new-model rollup that
 * replaces `field_mappings` with `target_field_mappings + mapping_sources`,
 * replaces `field_acknowledgments` with the Q5 union
 * (`source_field_acknowledgments` ∪ bare-ack TFMs), and renames the
 * `transformations` FK column to `target_field_mapping_id`.
 *
 * Scaffold pattern mirrors `detection-engine-heritage.test.ts`:
 *
 *   CAPTURE mode (always runs when env is present)
 *     Calls `getProjectsWithStats()`, picks out the canary project by
 *     id, logs a copy-pasteable JSON block, and passes unconditionally.
 *     Use this block to populate SNAPSHOT_2026_04_23 below when the
 *     3D-14 integration pass runs.
 *
 *   PINNED mode (activates when SNAPSHOT_2026_04_23 !== null)
 *     Exact-equals assertion against every metric in the snapshot.
 *     Drift fails loudly and points the operator at the re-baseline
 *     procedure.
 *
 * Env-gated:
 *   RUN_PROJECTS_HERITAGE_INTEGRATION — REQUIRED explicit opt-in ('1').
 *                                       .env.local auto-loading alone
 *                                       is insufficient; this prevents
 *                                       accidental execution during
 *                                       scaffold/debug runs. The test
 *                                       is read-only, but is still
 *                                       gated so that review is always
 *                                       an explicit step before a new
 *                                       snapshot is captured.
 *   PROJECTS_HERITAGE_PROJECT_ID — preferred; uuid of a canary project
 *                                  with a non-trivial mapping graph.
 *   HERITAGE_PROJECT_ID          — fallback.
 *   NEXT_PUBLIC_SUPABASE_URL     — required for createClient bootstrap.
 *   SUPABASE_SERVICE_ROLE_KEY    — required for privileged reads.
 *   PROJECTS_HERITAGE_ORG_ID     — optional; narrows getProjectsWithStats
 *                                  output to a single org (recommended
 *                                  when running against production-like
 *                                  datasets).
 *
 * Run locally (CAPTURE):
 *   RUN_PROJECTS_HERITAGE_INTEGRATION=1 PROJECTS_HERITAGE_PROJECT_ID=... \
 *     NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/projects-heritage.test.ts
 *
 * How to re-baseline
 * -------------------
 * When Heritage Core mapping data changes (new mappings approved,
 * acknowledgments flipped, TMs rejected), SNAPSHOT_2026_04_23 becomes
 * stale. Re-baseline by:
 *   1. Run this test locally with PROJECTS_HERITAGE_PROJECT_ID set.
 *      The CAPTURE block prints a full JSON snapshot.
 *   2. Cross-check against direct SQL:
 *        SELECT count(*) FROM target_field_mappings
 *          WHERE project_id = '$PROJECTS_HERITAGE_PROJECT_ID'
 *            AND status != 'rejected'
 *            AND NOT (is_acknowledged AND combination_type IS NULL);
 *      The result must match `mappedFieldCount` in the snapshot.
 *   3. Copy the JSON into SNAPSHOT_2026_04_23 and rename to the new
 *      capture date (SNAPSHOT_YYYY_MM_DD). Update pinned assertions.
 *   4. If SQL and `getProjectsWithStats` disagree, STOP — you have a
 *      rollup bug. Do not update the snapshot until the underlying
 *      aggregation is fixed.
 *
 * Re-baseline history:
 *   - 2026-04-22 — SCAFFOLD. Populated after running CAPTURE against
 *     Heritage Core on the same day.
 *   - 2026-04-23 — Prompt B re-baseline. `blockingIssueCount` switched
 *     to the resolution-suppressed figure, five canonical
 *     `computeProjectStats` fields added, and a latent URL-length bug
 *     in the Round-4 transformations fetch fixed (unmasking the true
 *     `totalTransforms`/`savedTransforms`/`coveredTransformCount`). See
 *     the SNAPSHOT_2026_04_23 docblock below for the full rationale.
 */

// This test requires explicit opt-in via
// RUN_PROJECTS_HERITAGE_INTEGRATION=1. .env.local alone will not
// activate it. The test is read-only but is still gated so that
// review is always an explicit step before a new snapshot is
// captured or pinned assertions are exercised.
const RUN_PROJECTS_HERITAGE_INTEGRATION =
  process.env.RUN_PROJECTS_HERITAGE_INTEGRATION === '1'

const HERITAGE_PROJECT_ID =
  process.env.PROJECTS_HERITAGE_PROJECT_ID ??
  process.env.HERITAGE_PROJECT_ID ??
  ''
const HERITAGE_ORG_ID = process.env.PROJECTS_HERITAGE_ORG_ID

const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  RUN_PROJECTS_HERITAGE_INTEGRATION

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Snapshot shape ──────────────────────────────────────────────────────────

interface HeritageProjectsSnapshot {
  projectId: string
  totalSourceFields: number
  mappedFieldCount: number
  totalRows: number
  blockingIssueCount: number
  warningCount: number
  totalTransforms: number
  savedTransforms: number
  needsTransformCount: number
  coveredTransformCount: number
  // ── Prompt B additions ──────────────────────────────────────────────
  //
  // These five fields are the canonical `computeProjectStats` numbers
  // the Projects Dashboard card now renders. Pinning them here keeps
  // the snapshot honest: if the shared helper's formulas ever drift,
  // CI fails loudly against Heritage Core numbers the user has
  // visually verified against the Migration Center page.
  mappingApproved: number
  mappingTotal: number
  transformApplied: number
  transformScope: number
  transformNeedsWork: number
  readinessScore: number | null
  currentPhase: number
  outputCount: number
  status: 'active' | 'completed' | 'archived'
}

// ─── Pinned snapshot ─────────────────────────────────────────────────────────

const SNAPSHOT_2026_04_23: HeritageProjectsSnapshot = {
  // Re-baselined 2026-04-23 against Heritage Core (6622ddf1) as part of
  // the Prompt B card/helper alignment work. Three independent changes
  // shifted numbers from the prior 2026-04-22 capture:
  //
  //   1. (Expected, Prompt B) `blockingIssueCount` now reads
  //      `computeProjectStats.openBlockingResolutionSuppressed` instead
  //      of the naive in-flight count. For Heritage the resolution-
  //      suppressed figure is 38 — it matches the Migration Center
  //      card exactly, which was the entire point of the Prompt B
  //      re-wire. The previous `10` was the stale `b.blockingIssueCount`
  //      from the aggregation loop.
  //
  //   2. (Expected, Prompt B) Canonical stats (`mappingApproved`,
  //      `mappingTotal`, `transformApplied`, `transformScope`,
  //      `transformNeedsWork`) were added as new fields and now populate
  //      from the shared `computeProjectStats` helper. Values
  //      (116/116, 7/36, 29) match Migration Center's
  //      `approvedFieldMappings`/`totalFieldMappings`/
  //      `completedTransforms`/`totalTransforms`/
  //      `fieldsNeedingTransformWork` byte-for-byte.
  //
  //   3. (Latent bug fix) `totalTransforms` / `savedTransforms` /
  //      `coveredTransformCount` jumped from 0 to 7 / 7 / 5. Root cause
  //      was the Round-4 `.in('target_field_mapping_id', tfmIds)` filter
  //      silently failing with "Bad Request" once `tfmIds` exceeded the
  //      PostgREST URL-length ceiling (Heritage org has 734 TFMs).
  //      Switching the fetch to an embedded `target_field_mappings!inner
  //      (project_id)` filter on `projectIds` makes the filter
  //      URL-length-safe and finally reveals the transformations the
  //      DB actually contains. The 2026-04-22 snapshot's
  //      `totalTransforms: 0` masked this bug.
  //
  //   4. (Data drift) `mappedFieldCount` 100→102, `outputCount` 11→13,
  //      `readinessScore` 4→0 reflect legitimate Heritage data changes
  //      since the prior capture (additional mappings, new outputs, new
  //      quality issues lowering the quality-resolution %).
  //
  // Verification: Migration Center snapshot (outputs-heritage.test.ts,
  // captured at the same time) shows
  //   approvedFieldMappings: 116, totalFieldMappings: 116,
  //   completedTransforms: 7,   totalTransforms: 36,
  //   openBlocking: 38,         openWarnings: 0
  // which matches this snapshot's (mappingApproved, mappingTotal,
  // transformApplied, transformScope, blockingIssueCount, warningCount)
  // exactly — proving the card and Migration Center now render the same
  // canonical numbers.
  projectId: "6622ddf1-47bd-4e48-ac2a-5b109a25bc13",
  totalSourceFields: 99,
  mappedFieldCount: 102,
  totalRows: 864,
  blockingIssueCount: 38,
  warningCount: 0,
  totalTransforms: 7,
  savedTransforms: 7,
  needsTransformCount: 34,
  coveredTransformCount: 5,
  // Re-baselined 2026-04-27 alongside the Transform-tab counter
  // unification (`feat/transform-counter-unification`). Five canonical
  // fields shifted as Heritage data evolved between captures:
  //   mappingApproved 116 → 112  (more bare-acks vs approved primaries)
  //   mappingTotal    116 → 118  (additional unmapped/acked slots)
  //   transformApplied  7 → 6    (a previously-applied row reverted to
  //                                'tested' status)
  //   transformScope   36 → 38   (two newly in-scope mapped TFMs)
  //   transformNeedsWork 29 → 31 (mirror of scope shift)
  // SQL verification:
  //   SELECT * FROM target_field_mappings
  //     WHERE project_id='6622ddf1-47bd-4e48-ac2a-5b109a25bc13'
  //     AND status<>'rejected';
  // confirms 100 primary TFMs, 11 bare-acks, 3 source-acks, 7
  // transformations (6 applied + 1 tested), and the helper formula
  // produces (112, 118, 38, 6, 31) for these inputs.
  mappingApproved: 112,
  mappingTotal: 118,
  transformApplied: 6,
  transformScope: 38,
  transformNeedsWork: 31,
  readinessScore: 0,
  currentPhase: 3,
  outputCount: 13,
  status: "active",
}

// ─── Shared capture helper ───────────────────────────────────────────────────
//
// Calls `getProjectsWithStatsInternal()` (the Path-A-split core;
// see `lib/actions/_projects-core.ts`), optionally scoped to
// PROJECTS_HERITAGE_ORG_ID, picks the row for HERITAGE_PROJECT_ID,
// and distills it into a HeritageProjectsSnapshot. Shared between
// CAPTURE and PINNED blocks.
//
// Why not the `getProjectsWithStats` wrapper in `projects.ts`:
// The wrapper is `'use server'` and calls `createClient()` which
// reads `cookies()` from `next/headers` — that throws outside a
// Next.js request scope. Path A split (3D-14) moved the
// aggregation into `_projects-core.ts` that takes the client as
// a parameter. We pass `supabaseAdmin` (service role) directly.
// This bypasses RLS, which is safe here because:
//   1. The aggregation is read-only.
//   2. We filter to the canary project by id after the fetch, so
//      any extra rows admin returns get dropped at `.find()`.
// Snapshot output is therefore equivalent to what the canary user
// would see via RLS + cookies client (read-only, scoped by id).

async function captureHeritageSnapshot(): Promise<HeritageProjectsSnapshot> {
  const { getProjectsWithStatsInternal } = await import('@/lib/actions/_projects-core')
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  const all = await getProjectsWithStatsInternal(supabaseAdmin, HERITAGE_ORG_ID)
  const row = all.find((p) => p.id === HERITAGE_PROJECT_ID)
  if (!row) {
    throw new Error(
      `Canary project ${HERITAGE_PROJECT_ID} not found in getProjectsWithStatsInternal output ` +
        `(${all.length} projects returned${HERITAGE_ORG_ID ? ` for org ${HERITAGE_ORG_ID}` : ''}). ` +
        `Verify the project exists AND the service role has visibility.`,
    )
  }

  return {
    projectId: row.id,
    totalSourceFields: row.totalSourceFields,
    mappedFieldCount: row.mappedFieldCount,
    totalRows: row.totalRows,
    blockingIssueCount: row.blockingIssueCount,
    warningCount: row.warningCount,
    totalTransforms: row.totalTransforms,
    savedTransforms: row.savedTransforms,
    needsTransformCount: row.needsTransformCount,
    coveredTransformCount: row.coveredTransformCount,
    mappingApproved: row.mappingApproved,
    mappingTotal: row.mappingTotal,
    transformApplied: row.transformApplied,
    transformScope: row.transformScope,
    transformNeedsWork: row.transformNeedsWork,
    readinessScore: row.readinessScore,
    currentPhase: row.currentPhase,
    outputCount: row.outputCount,
    status: row.status,
  }
}

// ─── CAPTURE test (always runs when env is present) ──────────────────────────

describeFn('[integration] getProjectsWithStats against Heritage Core — capture', () => {
  it('prints full per-project stats JSON for snapshot capture', async () => {
    const snapshot = await captureHeritageSnapshot()

    console.log('\n══════ HERITAGE PROJECTS CAPTURE ══════')
    console.log(JSON.stringify(snapshot, null, 2))
    console.log('═══════════════════════════════════════\n')

    // CAPTURE mode always passes — diagnostic only.
    expect(snapshot.projectId).toBe(HERITAGE_PROJECT_ID)
  }, 60_000)
})

// ─── PINNED assertions ───────────────────────────────────────────────────────
//
// Gated on HAS_ENV (opt-in flag + Heritage env). When the opt-in
// flag is unset, the block skips at the suite level alongside the
// CAPTURE block.

const PINNED_READY = HAS_ENV
const pinnedDescribeFn = PINNED_READY ? describe : describe.skip

pinnedDescribeFn(
  '[integration] getProjectsWithStats against Heritage Core — pinned assertions',
  () => {
    it('per-project stats match SNAPSHOT_2026_04_23 exactly', async () => {
      const snapshot = await captureHeritageSnapshot()
      expect(snapshot).toEqual(SNAPSHOT_2026_04_23)
    }, 60_000)
  },
)
