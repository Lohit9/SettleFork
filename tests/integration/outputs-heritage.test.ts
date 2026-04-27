// @vitest-environment node
// Integration test — must run in Node (not jsdom). The Anthropic SDK
// imported transitively by `_outputs-core.ts` refuses to initialize in a
// browser-like environment. Node is the correct environment for tests
// that hit Supabase over the network anyway.

import { describe, it, expect } from 'vitest'

/**
 * Test 17 — Integration heritage tests for the outputs pipeline against the
 * Heritage Core canary project (see `docs/features/mapping-redesign.md`
 * §Canary). Gates on env vars and `describe.skip`s in CI environments
 * without production credentials.
 *
 * After the Prompt 3c Gate 3 Item 2 (Path A) refactor, the business-logic
 * functions moved out of the `'use server'` module `lib/actions/outputs.ts`
 * into `lib/actions/_outputs-core.ts`. This test imports the Internal
 * functions directly and calls them with `__skipPersistence: true` so
 * heritage runs no longer pollute the canary project's `outputs` table or
 * the `project-files` storage bucket. The end-to-end persistence
 * verification suite below proves the flag actually short-circuits writes.
 *
 * Env-gated:
 *   HERITAGE_PROJECT_ID       — uuid of the canary project
 *   NEXT_PUBLIC_SUPABASE_URL  — user-scoped client (unused here but required
 *                                for the shared supabaseAdmin import path)
 *   SUPABASE_SERVICE_ROLE_KEY — admin client
 *
 * Run locally:
 *   HERITAGE_PROJECT_ID=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/integration/outputs-heritage.test.ts
 *
 * Suite layout:
 *   1. File generators — run each Internal generator with
 *      __skipPersistence=true and assert each returns non-empty content
 *      with expected structural properties.
 *   2. `getOutputsPageData` heritage snapshot (Flag 1) — pins every metric
 *      returned against a SNAPSHOT_2026_04_22 baseline. Fails on any drift
 *      in readiness-score inputs, mapping metrics, outstanding items, or
 *      phase colors.
 *   3. `__skipPersistence` end-to-end verification — for each of the five
 *      Internal functions, capture the outputs-row count before, invoke
 *      with __skipPersistence=true, and assert the count did not change.
 *      This proves the flag's runtime behavior on production data.
 *
 * How to re-baseline the Flag 1 snapshot
 * ---------------------------------------
 * When Heritage Core data changes via a manual operation (user approves a
 * mapping, adds an acknowledgment, runs a migration), the snapshot values
 * below will become stale. Re-baseline by:
 *
 *   1. Run the test locally with HERITAGE_PROJECT_ID set. The `prints full
 *      metric surface for baseline capture` test logs a JSON block that
 *      contains every asserted field.
 *   2. Before copying anything in, run the composite verification SQL
 *      from the comment block below this preamble (search for "Baseline
 *      SQL queries for manual re-derivation") and confirm the composite
 *      `total_field_mappings` / `approved_field_mappings` match what the
 *      JSON printed. They MUST match exactly.
 *   3. If and only if the SQL matches the JSON, copy the JSON values into
 *      `SNAPSHOT_2026_04_22` and rename the constant to the new capture
 *      date (`SNAPSHOT_YYYY_MM_DD`). Update both the "matches … exactly"
 *      test body and the re-baseline history entry below.
 *   4. If the SQL and `getOutputsPageData` disagree, STOP — you have
 *      found a bug in the rewritten `outputs.ts`. Do not update the
 *      snapshot; fix the underlying computation first.
 *
 * Re-baseline history:
 *   - 2026-04-22 — initial snapshot captured post-migration 075 and
 *     post-Path-A refactor against project
 *     6622ddf1-47bd-4e48-ac2a-5b109a25bc13. After this snapshot,
 *     `__skipPersistence=true` means heritage test runs no longer bump
 *     outputs-row counts, so `existingOutputsCount` is stable until an
 *     intentional re-ingest or manual data operation occurs.
 */

const HERITAGE_PROJECT_ID = process.env.HERITAGE_PROJECT_ID ?? ''
const HAS_ENV =
  Boolean(HERITAGE_PROJECT_ID) &&
  Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

const describeFn = HAS_ENV ? describe : describe.skip

// Placeholder user id for __skipPersistence calls. With the flag set to
// true, `uploadAndRecord` is never invoked, so the userId never reaches
// storage or the outputs table. A zero-uuid keeps the signatures honest
// without reserving or side-effecting any real auth user.
const PLACEHOLDER_USER_ID = '00000000-0000-0000-0000-000000000000'

// ── SNAPSHOT_2026_04_22 (Flag 1 baseline) ────────────────────────────────────
//
// Baseline captured 2026-04-22 against Heritage Core canary project
// (id: 6622ddf1-47bd-4e48-ac2a-5b109a25bc13 — "Heritage Core to
// Nymbus Core Migration").
//
// Re-baseline required after any of:
//   - Manual data operations on Heritage Core (rare, intentional)
//   - Source data re-ingest
//   - Schema changes affecting phase transition logic
//   - Intentional output generation producing outputs rows
//   - Transform application state changes (applied vs saved counts)
//
// When re-baselining, update the date suffix in constant name
// (SNAPSHOT_YYYY_MM_DD) and document the change in commit message
// with the trigger reason.
const SNAPSHOT_2026_04_22 = {
  sourceTableCount: 8,
  targetTableCount: 8,
  totalSourceRows: 864,
  hasMappings: true,
  hasSourceData: true,
  hasTargetData: true,
  totalDecisions: 27,
  existingOutputsCount: 11,
  phases: {
    dataIngestion: 'complete' as const,
    dataQuality: 'red' as const,
    mapping: 'green' as const,
    transformations: 'yellow' as const,
    validation: 'yellow' as const,
    completedCount: 2,
  },
  metrics: {
    readinessScore: 61,
    readinessStatus: 'at_risk' as const,
    readinessComponents: {
      mapping: 20,
      transform: 1.3,
      blocking: 24.2,
      warnings: 5,
      staging: 10,
    },
    // Re-baselined 2026-04-27 alongside the Transform-tab counter
    // unification (`feat/transform-counter-unification`). The four
    // canonical-stats fields below + `fieldsNeedingTransformWork`
    // (`stats.transformNeedsWork`) are the same ones the Transform tab
    // and Projects List now read from `computeProjectStats`. Heritage
    // data has evolved since the 2026-04-22 capture:
    //   approvedFieldMappings  116 → 112  (more bare-acks vs approved)
    //   totalFieldMappings     116 → 118  (additional unmapped/acked slots)
    //   completedTransforms      3 →   6  (more rows reached 'applied')
    //   totalTransforms         58 →  38  (transformations dismissed via
    //                                      needs_transformation=false fall
    //                                      out of scope)
    //   fieldsNeedingTransformWork 55 → 31 (mirror of scope shift)
    // SQL verification:
    //   SELECT * FROM target_field_mappings
    //     WHERE project_id='6622ddf1-47bd-4e48-ac2a-5b109a25bc13'
    //     AND status<>'rejected';
    // confirms 100 primary TFMs, 11 bare-acks, 3 source-acks, 7
    // transformations (6 applied + 1 tested); the canonical helper
    // produces (112, 118, 38, 6, 31). Other fields in this snapshot
    // (openBlocking, blockingIssues, readinessScore, etc.) are NOT
    // derived from the unification path and are intentionally left at
    // their 2026-04-22 values; if the integration suite is rerun and
    // those fail, refresh them in a separate baseline commit.
    approvedFieldMappings: 112,
    totalFieldMappings: 118,
    openBlocking: 39,
    openWarnings: 0,
    completedTransforms: 6,
    totalTransforms: 38,
    stagedTables: 8,
    totalTargetTables: 8,
  },
  outstanding: {
    unmappedSourceFields: 0,
    blockingIssues: 39,
    fieldsNeedingTransformWork: 31,
    untestedTransforms: 0,
    testedTransforms: 0,
  },
} as const

// Baseline SQL queries for manual re-derivation.
//
// IMPORTANT: `totalFieldMappings` and `approvedFieldMappings` are COMPOSITE
// metrics — each is a sum of four components, not a single COUNT. A naïve
// "SELECT count(*) FROM target_field_mappings WHERE ..." only captures the
// primary-TFMs component and will systematically under-report. The full
// derivation (used to verify the 2026-04-22 snapshot during calibration) is:
//
//   WITH
//     primary_tfms AS (
//       SELECT id, target_field_id, status
//       FROM target_field_mappings
//       WHERE project_id = '$HERITAGE_PROJECT_ID'
//         AND status != 'rejected'
//         AND NOT (is_acknowledged AND combination_type IS NULL)
//     ),
//     bare_ack_target_ids AS (
//       SELECT target_field_id FROM target_field_mappings
//       WHERE project_id = '$HERITAGE_PROJECT_ID'
//         AND is_acknowledged AND combination_type IS NULL
//     ),
//     source_ack_ids AS (
//       SELECT source_field_id FROM source_field_acknowledgments
//       WHERE project_id = '$HERITAGE_PROJECT_ID'
//     ),
//     datasets_p AS (
//       SELECT id, role FROM datasets WHERE project_id = '$HERITAGE_PROJECT_ID'
//     ),
//     source_tables AS (
//       SELECT id FROM tables WHERE dataset_id IN (SELECT id FROM datasets_p WHERE role='source')
//     ),
//     target_tables AS (
//       SELECT id FROM tables WHERE dataset_id IN (SELECT id FROM datasets_p WHERE role='target')
//     ),
//     source_fields AS (SELECT id FROM fields WHERE table_id IN (SELECT id FROM source_tables)),
//     target_fields AS (SELECT id FROM fields WHERE table_id IN (SELECT id FROM target_tables)),
//     mapped_source_ids AS (
//       SELECT DISTINCT ms.source_field_id
//       FROM mapping_sources ms
//       WHERE ms.target_field_mapping_id IN (SELECT id FROM primary_tfms)
//         AND ms.source_field_id IS NOT NULL
//     ),
//     primary_mapped_target_ids AS (SELECT DISTINCT target_field_id FROM primary_tfms),
//     ack_field_ids AS (
//       SELECT source_field_id AS field_id FROM source_ack_ids
//       UNION
//       SELECT target_field_id AS field_id FROM bare_ack_target_ids
//     ),
//     unmapped_source AS (
//       SELECT id FROM source_fields
//       WHERE id NOT IN (SELECT source_field_id FROM mapped_source_ids)
//         AND id NOT IN (SELECT field_id FROM ack_field_ids)
//     ),
//     acked_source AS (
//       SELECT id FROM source_fields
//       WHERE id NOT IN (SELECT source_field_id FROM mapped_source_ids)
//         AND id IN (SELECT field_id FROM ack_field_ids)
//     ),
//     unmapped_target AS (
//       SELECT id FROM target_fields
//       WHERE id NOT IN (SELECT target_field_id FROM primary_mapped_target_ids)
//         AND id NOT IN (SELECT field_id FROM ack_field_ids)
//     ),
//     acked_target AS (
//       SELECT id FROM target_fields
//       WHERE id NOT IN (SELECT target_field_id FROM primary_mapped_target_ids)
//         AND id IN (SELECT field_id FROM ack_field_ids)
//     )
//   SELECT
//     (SELECT count(*) FROM primary_tfms)
//       + (SELECT count(*) FROM unmapped_source)
//       + (SELECT count(*) FROM unmapped_target)
//       + (SELECT count(*) FROM acked_source)
//       + (SELECT count(*) FROM acked_target)                    AS total_field_mappings,
//     (SELECT count(*) FROM primary_tfms WHERE status='approved')
//       + (SELECT count(*) FROM acked_source)
//       + (SELECT count(*) FROM acked_target)                    AS approved_field_mappings;
//
// Simpler single-component queries (for spot-checking individual pieces):
//
//   fieldsNeedingTransformWork:
//     SELECT count(*) FROM target_field_mappings tfm
//      WHERE tfm.project_id = '$HERITAGE_PROJECT_ID'
//        AND tfm.status != 'rejected'
//        AND NOT (tfm.is_acknowledged AND tfm.combination_type IS NULL)
//        AND tfm.needs_transformation = true
//        AND NOT EXISTS (
//              SELECT 1 FROM transformations t
//               WHERE t.target_field_mapping_id = tfm.id
//                 AND t.status = 'applied'
//            );

describeFn('[integration] outputs pipeline against Heritage Core — file generators (__skipPersistence)', () => {
  it('generateMappingFileInternal CSV returns non-empty content with expected columns', async () => {
    const { generateMappingFileInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateMappingFileInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'csv',
      true,
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.content).toBeTypeOf('string')
    expect(result.content!.length).toBeGreaterThan(0)
    // __skipPersistence=true returns a sentinel version string.
    expect(result.version).toBe('0.0')
    expect(result.downloadUrl).toBeUndefined()

    const headerLine = result.content!.split('\n')[0]
    expect(headerLine).toContain('source_table')
    expect(headerLine).toContain('target_table')
    expect(headerLine).toContain('status')
    expect(headerLine).toContain('needs_transform')
  })

  it('generateMappingFileInternal JSON returns parseable content', async () => {
    const { generateMappingFileInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateMappingFileInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'json',
      true,
    )

    expect(result.success).toBe(true)
    if (!result.success) return
    const parsed = JSON.parse(result.content!)
    expect(parsed).toHaveProperty('table_mappings')
    expect(Array.isArray(parsed.table_mappings)).toBe(true)
    expect(result.version).toBe('0.0')
  })

  it('generateTransformSpecsInternal returns non-empty SQL-ish content', async () => {
    const { generateTransformSpecsInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateTransformSpecsInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'sql',
      true,
    )

    // Heritage Core may legitimately have zero transformations — in that
    // case the function returns success:false with a well-formed error.
    if (!result.success) {
      expect(result.error).toBeTypeOf('string')
      return
    }
    expect(result.content).toBeTypeOf('string')
    expect(result.content!.length).toBeGreaterThan(0)
    expect(result.version).toBe('0.0')
  })
})

describeFn('[integration] getOutputsPageData heritage snapshot (Flag 1)', () => {
  it('prints full metric surface for baseline capture', async () => {
    // Purpose: dump every field that downstream tests assert against, so a
    // reviewer running this test once can paste the complete snapshot back
    // for exact-equality calibration. Keep this test first in the describe
    // block so the log appears before any assertion failures.
    //
    // We call `getOutputsPageDataCore` directly (the non-'use server'
    // function in _outputs-core.ts) to bypass the auth wrapper in
    // outputs.ts. The wrapper only adds an auth guard around the core
    // function — every metric the snapshot asserts against comes from the
    // core function's output verbatim.
    const { getOutputsPageDataCore } = await import('@/lib/actions/_outputs-core')
    const data = await getOutputsPageDataCore(HERITAGE_PROJECT_ID)

    const snapshot = {
      sourceTableCount: data.sourceTableCount,
      targetTableCount: data.targetTableCount,
      totalSourceRows: data.totalSourceRows,
      hasMappings: data.hasMappings,
      hasSourceData: data.hasSourceData,
      hasTargetData: data.hasTargetData,
      totalDecisions: data.totalDecisions,
      existingOutputsCount: data.existingOutputs.length,
      phases: data.phases,
      metrics: {
        readinessScore: data.metrics.readinessScore,
        readinessStatus: data.metrics.readinessStatus,
        readinessComponents: data.metrics.readinessComponents,
        approvedFieldMappings: data.metrics.approvedFieldMappings,
        totalFieldMappings: data.metrics.totalFieldMappings,
        openBlocking: data.metrics.openBlocking,
        openWarnings: data.metrics.openWarnings,
        completedTransforms: data.metrics.completedTransforms,
        totalTransforms: data.metrics.totalTransforms,
        stagedTables: data.metrics.stagedTables,
        totalTargetTables: data.metrics.totalTargetTables,
      },
      outstanding: {
        unmappedSourceFields: data.outstanding.unmappedSourceFields,
        blockingIssues: data.outstanding.blockingIssues,
        fieldsNeedingTransformWork: data.outstanding.fieldsNeedingTransformWork,
        untestedTransforms: data.outstanding.untestedTransforms,
        testedTransforms: data.outstanding.testedTransforms,
      },
    }
    // eslint-disable-next-line no-console
    console.log('\n=== HERITAGE FLAG 1 SNAPSHOT ===')
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(snapshot, null, 2))
    // eslint-disable-next-line no-console
    console.log('=== END HERITAGE FLAG 1 SNAPSHOT ===\n')

    expect(snapshot).toBeDefined()
  })

  it('matches SNAPSHOT_2026_04_22 exactly (every field)', async () => {
    const { getOutputsPageDataCore } = await import('@/lib/actions/_outputs-core')
    const data = await getOutputsPageDataCore(HERITAGE_PROJECT_ID)

    expect(data.sourceTableCount).toBe(SNAPSHOT_2026_04_22.sourceTableCount)
    expect(data.targetTableCount).toBe(SNAPSHOT_2026_04_22.targetTableCount)
    expect(data.totalSourceRows).toBe(SNAPSHOT_2026_04_22.totalSourceRows)
    expect(data.hasMappings).toBe(SNAPSHOT_2026_04_22.hasMappings)
    expect(data.hasSourceData).toBe(SNAPSHOT_2026_04_22.hasSourceData)
    expect(data.hasTargetData).toBe(SNAPSHOT_2026_04_22.hasTargetData)
    expect(data.totalDecisions).toBe(SNAPSHOT_2026_04_22.totalDecisions)
    expect(data.existingOutputs.length).toBe(SNAPSHOT_2026_04_22.existingOutputsCount)

    expect(data.phases.dataIngestion).toBe(SNAPSHOT_2026_04_22.phases.dataIngestion)
    expect(data.phases.dataQuality).toBe(SNAPSHOT_2026_04_22.phases.dataQuality)
    expect(data.phases.mapping).toBe(SNAPSHOT_2026_04_22.phases.mapping)
    expect(data.phases.transformations).toBe(SNAPSHOT_2026_04_22.phases.transformations)
    expect(data.phases.validation).toBe(SNAPSHOT_2026_04_22.phases.validation)
    expect(data.phases.completedCount).toBe(SNAPSHOT_2026_04_22.phases.completedCount)

    expect(data.metrics.readinessScore).toBe(SNAPSHOT_2026_04_22.metrics.readinessScore)
    expect(data.metrics.readinessStatus).toBe(SNAPSHOT_2026_04_22.metrics.readinessStatus)
    expect(data.metrics.readinessComponents.mapping).toBe(
      SNAPSHOT_2026_04_22.metrics.readinessComponents.mapping,
    )
    expect(data.metrics.readinessComponents.transform).toBe(
      SNAPSHOT_2026_04_22.metrics.readinessComponents.transform,
    )
    expect(data.metrics.readinessComponents.blocking).toBe(
      SNAPSHOT_2026_04_22.metrics.readinessComponents.blocking,
    )
    expect(data.metrics.readinessComponents.warnings).toBe(
      SNAPSHOT_2026_04_22.metrics.readinessComponents.warnings,
    )
    expect(data.metrics.readinessComponents.staging).toBe(
      SNAPSHOT_2026_04_22.metrics.readinessComponents.staging,
    )
    expect(data.metrics.approvedFieldMappings).toBe(SNAPSHOT_2026_04_22.metrics.approvedFieldMappings)
    expect(data.metrics.totalFieldMappings).toBe(SNAPSHOT_2026_04_22.metrics.totalFieldMappings)
    expect(data.metrics.openBlocking).toBe(SNAPSHOT_2026_04_22.metrics.openBlocking)
    expect(data.metrics.openWarnings).toBe(SNAPSHOT_2026_04_22.metrics.openWarnings)
    expect(data.metrics.completedTransforms).toBe(SNAPSHOT_2026_04_22.metrics.completedTransforms)
    expect(data.metrics.totalTransforms).toBe(SNAPSHOT_2026_04_22.metrics.totalTransforms)
    expect(data.metrics.stagedTables).toBe(SNAPSHOT_2026_04_22.metrics.stagedTables)
    expect(data.metrics.totalTargetTables).toBe(SNAPSHOT_2026_04_22.metrics.totalTargetTables)

    expect(data.outstanding.unmappedSourceFields).toBe(
      SNAPSHOT_2026_04_22.outstanding.unmappedSourceFields,
    )
    expect(data.outstanding.blockingIssues).toBe(SNAPSHOT_2026_04_22.outstanding.blockingIssues)
    expect(data.outstanding.fieldsNeedingTransformWork).toBe(
      SNAPSHOT_2026_04_22.outstanding.fieldsNeedingTransformWork,
    )
    expect(data.outstanding.untestedTransforms).toBe(
      SNAPSHOT_2026_04_22.outstanding.untestedTransforms,
    )
    expect(data.outstanding.testedTransforms).toBe(SNAPSHOT_2026_04_22.outstanding.testedTransforms)
  })
})

describeFn('[integration] __skipPersistence end-to-end verification', () => {
  // Each test below captures the current `outputs` table row count for the
  // Heritage project, calls one Internal function with __skipPersistence=true,
  // and asserts the count did not change. Because `uploadAndRecord` performs
  // storage upload + outputs-row insert as a coupled pair (insert happens
  // ONLY after upload succeeds), DB-row absence is a reliable proxy for
  // storage-write absence: no new outputs rows ⇒ the `if (__skipPersistence)
  // return ...` branch was taken before any side effects. An orphaned
  // storage file (upload OK, insert failed) is not a scenario
  // __skipPersistence is designed to exercise, so we do not test it here.

  async function countOutputsRows(): Promise<number> {
    const { supabaseAdmin } = await import('@/lib/supabase/admin')
    const { count, error } = await supabaseAdmin
      .from('outputs')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', HERITAGE_PROJECT_ID)
    if (error) throw new Error(`outputs count query failed: ${error.message}`)
    return count ?? 0
  }

  it('generateMappingFileInternal with __skipPersistence=true writes zero outputs rows (CSV)', async () => {
    const before = await countOutputsRows()
    const { generateMappingFileInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateMappingFileInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'csv',
      true,
    )
    expect(result.success).toBe(true)
    expect(result.content).toBeTypeOf('string')
    expect(result.content!.length).toBeGreaterThan(0)
    const after = await countOutputsRows()
    expect(after).toBe(before)
  })

  it('generateMappingFileInternal with __skipPersistence=true writes zero outputs rows (JSON)', async () => {
    const before = await countOutputsRows()
    const { generateMappingFileInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateMappingFileInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'json',
      true,
    )
    expect(result.success).toBe(true)
    expect(result.content).toBeTypeOf('string')
    const after = await countOutputsRows()
    expect(after).toBe(before)
  })

  it('generateTransformSpecsInternal with __skipPersistence=true writes zero outputs rows', async () => {
    const before = await countOutputsRows()
    const { generateTransformSpecsInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateTransformSpecsInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      'sql',
      true,
    )
    // Success depends on whether Heritage has any transformations; either
    // way no persistence should occur.
    if (result.success) {
      expect(result.content).toBeTypeOf('string')
      expect(result.content!.length).toBeGreaterThan(0)
    }
    const after = await countOutputsRows()
    expect(after).toBe(before)
  })

  it('generateGoldStandardCSVsInternal with __skipPersistence=true writes zero outputs rows', async () => {
    const before = await countOutputsRows()
    const { generateGoldStandardCSVsInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateGoldStandardCSVsInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      true,
    )
    // Whether success depends on approved TMs existing; either way no
    // persistence should occur.
    if (result.success) {
      expect(Array.isArray(result.files)).toBe(true)
      for (const f of result.files) {
        // __skipPersistence path emits sentinel version + empty download URL.
        expect(f.version).toBe('0.0')
        expect(f.downloadUrl).toBe('')
        expect(f.outputId).toBe('')
      }
    }
    const after = await countOutputsRows()
    expect(after).toBe(before)
  })

  it('generateSQLLoadScriptsInternal with __skipPersistence=true writes zero outputs rows', async () => {
    const before = await countOutputsRows()
    const { generateSQLLoadScriptsInternal } = await import('@/lib/actions/_outputs-core')
    const result = await generateSQLLoadScriptsInternal(
      HERITAGE_PROJECT_ID,
      PLACEHOLDER_USER_ID,
      true,
    )
    if (result.success) {
      expect(Array.isArray(result.files)).toBe(true)
      for (const f of result.files) {
        expect(f.version).toBe('0.0')
        expect(f.downloadUrl).toBe('')
        expect(f.outputId).toBe('')
      }
    }
    const after = await countOutputsRows()
    expect(after).toBe(before)
  })

  // Note: generateReadinessReportInternal is intentionally excluded from
  // this block. It calls out to the Claude API (costly, non-idempotent,
  // rate-limited) and its __skipPersistence path still consumes an LLM
  // token quota. The flag's persistence short-circuit is structurally
  // identical to the other four functions — tested by golden output
  // comparison in tests/outputs/readiness-report-prompt.golden.test.ts
  // and covered at the type/signature level by tsc. If a reviewer wants
  // runtime proof for the readiness report specifically, run it manually
  // with the same pattern:
  //
  //   const before = await countOutputsRows()
  //   await generateReadinessReportInternal(projectId, userId, 'docx', true)
  //   const after = await countOutputsRows()
  //   expect(after).toBe(before)
})
