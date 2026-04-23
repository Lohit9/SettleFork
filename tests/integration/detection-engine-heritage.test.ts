// @vitest-environment node
// Integration test — must run in Node (not jsdom). `detection-engine.ts`
// transitively imports server-only modules that refuse to initialize in
// a browser-like environment. Node is the correct environment for tests
// that hit Supabase over the network anyway.

import { describe, it, expect } from 'vitest'

/**
 * Heritage baseline for the in-flight quality detection engine
 * (`lib/quality/_detection-engine-core.ts :: runInFlightChecksInternal`).
 *
 * Purpose: post-rewrite regression guard for the Prompt 3d Option A
 * rewrite (c-source-iterate on source branch + primary-only on staged
 * branch).
 *
 * Why post-rewrite-only (no pre-rewrite baseline)
 * -----------------------------------------------
 * Legacy `runInFlightChecks` was observed to produce zero issues when
 * invoked from this Vitest harness against projects that held pre-existing
 * `manual_scan` rows from prior UI scans. That meant we could not capture
 * a meaningful pre-rewrite snapshot — running the test deleted the
 * existing rows and inserted nothing. Root cause not investigated
 * (legacy was scheduled for replacement in this same prompt; debugging
 * throwaway code was not worth the hours). See the
 * "detection-engine-heritage empirical baseline gap" entry in
 * `docs/prompt-3a-remaining-work.md :: Known test infrastructure issues`
 * for full rationale.
 *
 * This file is therefore scaffolded as a single-mode snapshot:
 *
 *   CAPTURE mode (always runs when env is present)
 *     Calls `runInFlightChecksInternal` against the canary project,
 *     reads back the fresh in-flight quality_issues rows, aggregates
 *     into a HeritageDetectionSnapshot, and logs a copy-pasteable JSON
 *     block. The test always passes in this mode.
 *
 *   PINNED mode (activates when SNAPSHOT_2026_04_22 !== null)
 *     When the captured JSON is pasted back into SNAPSHOT_2026_04_22,
 *     a second describe block runs exact-equals assertions against
 *     every metric in the snapshot. Drift fails loudly.
 *
 * IMPORTANT: `runInFlightChecksInternal` MUTATES `quality_issues`.
 * Every call deletes existing (auto, manual_scan) in-flight issues
 * for the project and re-inserts fresh ones. This is the same thing
 * the "Scan" button in the Quality tab does. It is idempotent against
 * a stable dataset — running the test twice produces identical output —
 * but it does overwrite whatever was previously stored. That is
 * acceptable: in-flight issues are a derived artifact, not user-authored
 * state.
 *
 * Env-gated:
 *   RUN_DETECTION_HERITAGE_INTEGRATION — REQUIRED explicit opt-in ('1').
 *                                        This test MUTATES quality_issues
 *                                        in Heritage, so .env.local
 *                                        auto-loading alone must not
 *                                        activate it. Accidental runs
 *                                        would rewrite the canary's
 *                                        in-flight issue rows.
 *   DETECTION_HERITAGE_PROJECT_ID  — preferred: uuid of a project with
 *                                    manual_scan issues (this test needs
 *                                    data that exercises auto checks)
 *   HERITAGE_PROJECT_ID            — fallback
 *   NEXT_PUBLIC_SUPABASE_URL       — required for supabaseAdmin import path
 *   SUPABASE_SERVICE_ROLE_KEY      — admin client
 *
 * Run locally (CAPTURE):
 *   RUN_DETECTION_HERITAGE_INTEGRATION=1 DETECTION_HERITAGE_PROJECT_ID=... \
 *     NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/detection-engine-heritage.test.ts
 *
 * Attribution model under test (per Option A):
 *   - Check 8  length_overflow    — staged: per-TFM (1 issue)   | source: per-MS (N issues for multi-source TFMs)
 *   - Check 9  case_inconsistency — staged: per-TFM (1 issue)   | source: per-MS
 *   - Check 10 orphaned_fk        — staged-only; per-TFM (1 issue)
 *   - Check 11 null_required      — staged: per-TFM (1 issue)   | source: per-MS
 *   - Check 12 unmapped_required  — global per target field (1 issue)
 *
 * How to re-baseline
 * -------------------
 * When Heritage Core data changes via a manual operation (re-ingest,
 * approval, acknowledgment, migration), SNAPSHOT_2026_04_22 becomes
 * stale. Re-baseline by:
 *   1. Run this test locally with DETECTION_HERITAGE_PROJECT_ID set.
 *      The "prints full in-flight issue surface for capture" test
 *      logs a JSON block with every asserted field.
 *   2. Cross-check the grand totals against a direct SQL query:
 *        SELECT issue_kind, count(*) FROM quality_issues
 *         WHERE project_id = '$DETECTION_HERITAGE_PROJECT_ID'
 *           AND stage = 'in_flight'
 *           AND detection_source IN ('auto','manual_scan')
 *         GROUP BY issue_kind;
 *      Counts must match exactly.
 *   3. Copy the JSON into SNAPSHOT_2026_04_22 and rename the constant
 *      to the new capture date (SNAPSHOT_YYYY_MM_DD). Update assertions.
 *   4. If the SQL and `runInFlightChecksInternal` disagree, STOP — you
 *      have a bug in the detection engine. Do not update the snapshot
 *      until the underlying computation is fixed.
 *
 * Re-baseline history:
 *   - 2026-04-22 — CAPTURE SCAFFOLD. No pre-rewrite baseline (see
 *     empirical-baseline-gap note in remaining-work doc).
 *     SNAPSHOT_2026_04_22 is populated post-rewrite only.
 */

// Uses DETECTION_HERITAGE_PROJECT_ID if set, falling back to
// HERITAGE_PROJECT_ID. Detection-engine needs a canary project with
// manual_scan issues across multiple auto check kinds (length_overflow,
// null_required, orphaned_fk, null_required, unmapped_required). The
// primary HERITAGE_PROJECT_ID canary (6622ddf1) has clean data that
// produces zero auto-check findings, making it useless for this test's
// purpose. Override with DETECTION_HERITAGE_PROJECT_ID set to a
// project whose data triggers multiple checks.
// This test requires explicit opt-in via
// RUN_DETECTION_HERITAGE_INTEGRATION=1. .env.local alone will not
// activate it. The test MUTATES Heritage quality_issues rows (delete
// + re-insert in-flight rows for the canary project), so accidental
// execution during scaffold/debug runs must be prevented.
const RUN_DETECTION_HERITAGE_INTEGRATION =
  process.env.RUN_DETECTION_HERITAGE_INTEGRATION === '1'

const HERITAGE_PROJECT_ID =
  process.env.DETECTION_HERITAGE_PROJECT_ID
    ?? process.env.HERITAGE_PROJECT_ID
    ?? ''
const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) &&
  RUN_DETECTION_HERITAGE_INTEGRATION

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Pinned snapshot (post-rewrite, 2026-04-22) ──────────────────────────────
//
// Post-rewrite only; no pre-rewrite baseline was captured. See
// "detection-engine-heritage empirical baseline gap" in
// docs/prompt-3a-remaining-work.md :: Known test infrastructure issues.
//
// Captured 2026-04-22 against
//   DETECTION_HERITAGE_PROJECT_ID=0ad1bef0-decf-4525-8b3c-4eada73255dc
// after the Prompt 3d Option A rewrite of
// lib/quality/_detection-engine-core.ts. Legacy `runInFlightChecks`
// produced zero issues from the same harness against the same project —
// Option A therefore surfaced 29 in-flight issues the legacy code path
// could not. All issues are staged-branch (the canary has staged rows
// on every TM), so this snapshot exercises checks 8, 10, 11, and 12 on
// the staged branch but does NOT exercise the source-branch per-MS
// fanout. Source-branch coverage is tracked as future work in the
// "empirical baseline gap" note.
//
// DO NOT edit these values manually without re-running the CAPTURE test
// and verifying via the cross-check SQL in the re-baseline procedure above.

const SNAPSHOT_2026_04_22: HeritageDetectionSnapshot | null = {
  totalInflightIssues: 29,
  perIssueKindCount: {
    null_required: 11,
    unmapped_required: 12,
    orphaned_fk: 3,
    length_overflow: 3,
  },
  perIssueKindDistinctTriples: {
    null_required: 11,
    unmapped_required: 12,
    orphaned_fk: 3,
    length_overflow: 3,
  },
  perIssueKindTotalAffectedRecords: {
    null_required: 245,
    unmapped_required: 0,
    orphaned_fk: 3,
    length_overflow: 147,
  },
  stagedVsSourceBranchSplit: {
    null_required: { stagedBranch: 11, sourceBranch: 0 },
    unmapped_required: { stagedBranch: 12, sourceBranch: 0 },
    orphaned_fk: { stagedBranch: 3, sourceBranch: 0 },
    length_overflow: { stagedBranch: 3, sourceBranch: 0 },
  },
}

// ─── Snapshot shape ──────────────────────────────────────────────────────────

interface HeritageDetectionSnapshot {
  totalInflightIssues: number
  /** One entry per issue_kind. Keys: length_overflow, case_inconsistency,
   *  orphaned_fk, null_required, unmapped_required_target. */
  perIssueKindCount: Record<string, number>
  /**
   * Distinct (issue_kind, table_id, field_id) triple count per issue_kind.
   * Under correct Option A behaviour this should equal perIssueKindCount
   * for staged-branch-only kinds and equal-or-less for mixed-branch kinds.
   * Under legacy behaviour this is STRICTLY LESS than perIssueKindCount
   * for multi-source TFM projects — the gap is the duplicate-bug evidence.
   */
  perIssueKindDistinctTriples: Record<string, number>
  perIssueKindTotalAffectedRecords: Record<string, number>
  /**
   * For checks that can run on either branch, splits the issue count by
   * which branch emitted it. Detection heuristic: an issue is on the
   * staged branch iff its table_id matches a target_table_id of some TM
   * in the project; on the source branch iff its table_id matches a
   * source_table_id.
   */
  stagedVsSourceBranchSplit: Record<string, { stagedBranch: number; sourceBranch: number }>
}

// ─── Shared capture helper ───────────────────────────────────────────────────
//
// Runs `runInFlightChecksInternal` against the canary project and
// aggregates the resulting `quality_issues` rows into a
// HeritageDetectionSnapshot. Shared between CAPTURE (logs + always
// passes) and PINNED (exact-equals assertion).
//
// IMPORTANT: this MUTATES quality_issues for the project (same as the
// UI "Scan" button). Idempotent — running twice produces identical
// counts — but it does overwrite prior auto/manual_scan in-flight rows.

async function captureHeritageSnapshot(): Promise<HeritageDetectionSnapshot> {
  const { runInFlightChecksInternal } = await import(
    '@/lib/quality/_detection-engine-core'
  )
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  await runInFlightChecksInternal(HERITAGE_PROJECT_ID)

  const { data: issues, error } = await supabaseAdmin
    .from('quality_issues')
    .select('id, issue_kind, table_id, field_id, affected_records, stage, detection_source')
    .eq('project_id', HERITAGE_PROJECT_ID)
    .eq('stage', 'in_flight')
    .in('detection_source', ['auto', 'manual_scan'])

  if (error) throw new Error(`quality_issues fetch failed: ${error.message}`)
  const rows = issues ?? []

  // Resolve table roles (source vs target) for branch attribution via
  // the project's table_mappings.
  const { data: tms } = await supabaseAdmin
    .from('table_mappings')
    .select('source_table_id, target_table_id')
    .eq('project_id', HERITAGE_PROJECT_ID)
    .neq('status', 'rejected')

  const sourceTableIds = new Set<string>((tms ?? []).map((tm) => tm.source_table_id))
  const targetTableIds = new Set<string>((tms ?? []).map((tm) => tm.target_table_id))

  const perIssueKindCount: Record<string, number> = {}
  const perIssueKindDistinctTriples: Record<string, Set<string>> = {}
  const perIssueKindTotalAffectedRecords: Record<string, number> = {}
  const stagedVsSourceBranchSplit: Record<string, { stagedBranch: number; sourceBranch: number }> = {}

  for (const r of rows) {
    const kind = (r.issue_kind as string) ?? 'unknown'
    perIssueKindCount[kind] = (perIssueKindCount[kind] ?? 0) + 1
    perIssueKindTotalAffectedRecords[kind] =
      (perIssueKindTotalAffectedRecords[kind] ?? 0) + Number(r.affected_records ?? 0)

    const triple = `${kind}::${r.table_id ?? 'null'}::${r.field_id ?? 'null'}`
    ;(perIssueKindDistinctTriples[kind] ??= new Set()).add(triple)

    const branch =
      r.table_id && targetTableIds.has(r.table_id)
        ? 'stagedBranch'
        : r.table_id && sourceTableIds.has(r.table_id)
          ? 'sourceBranch'
          : null
    if (branch) {
      ;(stagedVsSourceBranchSplit[kind] ??= { stagedBranch: 0, sourceBranch: 0 })[branch] += 1
    }
  }

  return {
    totalInflightIssues: rows.length,
    perIssueKindCount,
    perIssueKindDistinctTriples: Object.fromEntries(
      Object.entries(perIssueKindDistinctTriples).map(([k, set]) => [k, set.size]),
    ),
    perIssueKindTotalAffectedRecords,
    stagedVsSourceBranchSplit,
  }
}

// ─── CAPTURE test (always runs when env is present) ──────────────────────────

describeFn('[integration] detection-engine against Heritage Core — capture', () => {
  it('prints full in-flight issue surface for capture', async () => {
    const snapshot = await captureHeritageSnapshot()

    console.log('\n══════ HERITAGE DETECTION-ENGINE CAPTURE ══════')
    console.log(JSON.stringify(snapshot, null, 2))
    console.log('═══════════════════════════════════════════════\n')

    // Diagnostic warning: zero issues means the canary project does not
    // exercise detection-engine well. See "detection-engine-heritage
    // empirical baseline gap" in docs/prompt-3a-remaining-work.md.
    if (snapshot.totalInflightIssues === 0) {
      console.warn(
        '[detection-engine capture] zero in-flight issues detected for project=' +
          HERITAGE_PROJECT_ID +
          ' — canary does not exercise auto checks. See empirical-baseline-gap note.',
      )
    }

    // CAPTURE mode always passes (diagnostic only).
    expect(snapshot.totalInflightIssues).toBeGreaterThanOrEqual(0)
  }, 120_000)
})

// ─── PINNED assertions (activate when SNAPSHOT_2026_04_22 !== null) ─────────
//
// Gated on SNAPSHOT_2026_04_22 !== null. When the snapshot is populated
// (current state: yes, 2026-04-22) this block asserts exact equality
// against every metric in the snapshot. When null the block skips at the
// suite level so the file remains ready-to-activate after a re-baseline.

const PINNED_READY = HAS_ENV && SNAPSHOT_2026_04_22 !== null
const pinnedDescribeFn = PINNED_READY ? describe : describe.skip

pinnedDescribeFn(
  '[integration] detection-engine against Heritage Core — pinned assertions',
  () => {
    it('totals, per-kind counts, and branch split match SNAPSHOT_2026_04_22 exactly', async () => {
      // Narrow: PINNED_READY guarantees SNAPSHOT is non-null. Type-assert
      // for the subsequent equality check.
      const expected = SNAPSHOT_2026_04_22 as HeritageDetectionSnapshot

      const snapshot = await captureHeritageSnapshot()

      // Exact structural equality. If ANY per-kind count, triple count,
      // affected-records total, or branch split changes, this fails
      // loudly and points the operator at the re-baseline procedure.
      expect(snapshot).toEqual(expected)
    }, 120_000)
  },
)
