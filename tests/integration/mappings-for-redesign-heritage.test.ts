// @vitest-environment node
//
// Phase 3 Gap 4b — Heritage-backed integration test for the new
// read path. Shape matches `tests/integration/projects-heritage.test.ts`:
// CAPTURE mode always runs (prints re-baselinable JSON); PINNED mode
// asserts an exact snapshot.
//
// Env-gated: RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1 is required.
// .env.local auto-loading alone is insufficient — this test is
// intentionally opt-in so review is always an explicit step before a
// new snapshot is captured or pinned assertions are exercised.
//
// Re-baseline procedure:
//   1. Run with RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION=1 set.
//      CAPTURE prints the JSON block.
//   2. Cross-check against direct SQL (see design §7.2):
//        SELECT count(*) FROM fields f
//        JOIN tables t ON t.id = f.table_id
//        JOIN datasets d ON d.id = t.dataset_id
//        WHERE d.project_id = $HERITAGE AND d.role = 'target';
//      The result must match `rowCount` in the snapshot.
//   3. Copy the JSON into SNAPSHOT_2026_04_23 and rename to the new
//      capture date. Update pinned assertions if needed.

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'

const RUN = process.env.RUN_MAPPINGS_REDESIGN_HERITAGE_INTEGRATION === '1'

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

const describeFn = HAS_ENV ? describe : describe.skip

// ─── Snapshot shape ──────────────────────────────────────────────────

interface HeritageMappingsRedesignSnapshot {
  projectId: string
  rowCount: number
  rowCountByKind: {
    mapped: number
    value_assignment: number
    target_acknowledged: number
    unmapped: number
  }
  counts: {
    total: number
    approved: number
    needsReview: number
    rejected: number
    unmapped: number
  }
  targetTableCount: number
  sourceTableCount: number
  sourceFieldAckCount: number
  targetSchemaEmpty: boolean
  /**
   * SHA-256 of a normalized row fingerprint: for each row we capture
   * `{id, kind, status, targetField.id, sourceIds, hasTransformation}`
   * in the contract-guaranteed server order. Any silent drift in
   * discriminator derivation, ordering, or source-set assembly fails
   * here without having to pin the entire row array.
   */
  rowsFingerprint: string
}

// ─── Pinned snapshot (populate on first CAPTURE run) ────────────────

/**
 * Populate this after running CAPTURE mode once against Heritage
 * Core. Leave as `null` until the baseline is established.
 */
const SNAPSHOT_2026_04_23: HeritageMappingsRedesignSnapshot | null = null

// ─── Capture helper ──────────────────────────────────────────────────

async function captureSnapshot(): Promise<HeritageMappingsRedesignSnapshot> {
  const { getMappingsForRedesignCore } = await import(
    '@/lib/actions/_mappings-for-redesign-core'
  )
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  const result = await getMappingsForRedesignCore(
    supabaseAdmin,
    HERITAGE_PROJECT_ID,
  )
  if (!result) {
    throw new Error(
      `getMappingsForRedesignCore returned null for ${HERITAGE_PROJECT_ID} — ` +
        `verify service role visibility and project existence.`,
    )
  }

  const rowCountByKind = {
    mapped: 0,
    value_assignment: 0,
    target_acknowledged: 0,
    unmapped: 0,
  }
  for (const row of result.rows) {
    rowCountByKind[row.kind]++
  }

  const fingerprintBody = result.rows
    .map((row) => {
      const sourceIds =
        row.kind === 'mapped'
          ? row.sources.map((s) => s.sourceField.id).sort().join(',')
          : ''
      return [
        row.id,
        row.kind,
        row.status,
        row.targetField.id,
        sourceIds,
        row.hasTransformation ? 'T' : 'F',
      ].join('|')
    })
    .join('\n')

  const rowsFingerprint = createHash('sha256')
    .update(fingerprintBody)
    .digest('hex')

  return {
    projectId: result.projectId,
    rowCount: result.rows.length,
    rowCountByKind,
    counts: result.counts,
    targetTableCount: result.targetTables.length,
    sourceTableCount: result.sourceTables.length,
    sourceFieldAckCount: result.sourceFieldAcknowledgments.length,
    targetSchemaEmpty: result.targetSchemaEmpty,
    rowsFingerprint,
  }
}

// ─── CAPTURE mode (always runs when HAS_ENV) ─────────────────────────

describeFn(
  '[integration] getMappingsForRedesign against Heritage Core — capture',
  () => {
    it('prints the snapshot JSON block', async () => {
      const snap = await captureSnapshot()
      console.log('\n══════ HERITAGE MAPPINGS-REDESIGN CAPTURE ══════')
      console.log(JSON.stringify(snap, null, 2))
      console.log('════════════════════════════════════════════════\n')
      expect(snap.projectId).toBe(HERITAGE_PROJECT_ID)
    }, 60_000)
  },
)

// ─── PINNED mode ─────────────────────────────────────────────────────

const PINNED_READY = HAS_ENV && SNAPSHOT_2026_04_23 !== null
const pinnedDescribeFn = PINNED_READY ? describe : describe.skip

pinnedDescribeFn(
  '[integration] getMappingsForRedesign against Heritage Core — pinned',
  () => {
    it('snapshot matches SNAPSHOT_2026_04_23 exactly', async () => {
      const snap = await captureSnapshot()
      expect(snap).toEqual(SNAPSHOT_2026_04_23)
    }, 60_000)
  },
)
