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
//
// Phase 4a-2 — write-path coverage for `createFieldMapping` and
// `suggestMappingForTarget`. These tests catch the class of defect we
// hit in the smoke test: PostgREST contract drift in identity-read
// joins (`tables(project_id)` vs the correct
// `tables!inner(datasets!inner(project_id))`). Source-level grep tests
// cannot detect this — only a real query against Heritage does.
//
// The write-path tests use admin-credentialed mocks for `createClient`
// and bypass the maintenance-mode + permission gates. Each test
// snapshots the parent TM's status pre-test and restores it post-test
// so test runs are idempotent against Heritage.

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
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
   * Phase 3 Gap 11b — total source field count for the project.
   * Drives the source-schema sidebar's count badge. Captured here so
   * the integration snapshot covers contract drift in `sourceFields`
   * shape / ordering as well as row state.
   */
  sourceFieldCount: number
  /**
   * Phase 3 Gap 11b — split of source fields by `mappingStatus`.
   * `mapped + unmapped` always equals `sourceFieldCount`. The split
   * locks in the founder-locked semantic that rejected TFMs do NOT
   * claim their contributing sources as mapped.
   */
  sourceFieldsByStatus: { mapped: number; unmapped: number }
  /**
   * Phase 3 Gap 11b — count of source fields with `isAcknowledged=true`.
   * Always equals `sourceFieldAckCount` for any project where every
   * acknowledgment row points at a live source field; tracked
   * separately so a divergence (acks pointing at deleted fields) is
   * surfaced.
   */
  acknowledgedSourceFieldCount: number
  /**
   * SHA-256 of a normalized row fingerprint: for each row we capture
   * `{id, kind, status, targetField.id, sourceIds, hasTransformation}`
   * in the contract-guaranteed server order. Any silent drift in
   * discriminator derivation, ordering, or source-set assembly fails
   * here without having to pin the entire row array.
   */
  rowsFingerprint: string
  /**
   * SHA-256 of a normalized source-field fingerprint, in the
   * contract-guaranteed server order. Captures
   * `{id, sourceTable.id, mappingStatus, isAcknowledged,
   * sampleValueCount}` per field. Like `rowsFingerprint`, this
   * lets the snapshot detect ordering / shape / status drift
   * without pinning the entire `sourceFields` array.
   */
  sourceFieldsFingerprint: string
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

  const sourceFieldsByStatus = { mapped: 0, unmapped: 0 }
  let acknowledgedSourceFieldCount = 0
  for (const sf of result.sourceFields) {
    sourceFieldsByStatus[sf.mappingStatus]++
    if (sf.isAcknowledged) acknowledgedSourceFieldCount++
  }

  const sourceFieldsFingerprintBody = result.sourceFields
    .map((sf) =>
      [
        sf.id,
        sf.sourceTable.id,
        sf.mappingStatus,
        sf.isAcknowledged ? 'A' : '_',
        String(sf.sampleValues.length),
      ].join('|'),
    )
    .join('\n')
  const sourceFieldsFingerprint = createHash('sha256')
    .update(sourceFieldsFingerprintBody)
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
    sourceFieldCount: result.sourceFields.length,
    sourceFieldsByStatus,
    acknowledgedSourceFieldCount,
    rowsFingerprint,
    sourceFieldsFingerprint,
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

// ─── Write-path integration (Phase 4a-2) ─────────────────────────────
//
// Heritage owner — used as the fake authenticated user when calling
// the wrapper. activity_log.user_id has a FK to auth.users so we need
// a real id. Sourced from project_members for HERITAGE_PROJECT_ID
// (role=owner). Hard-coded rather than discovered at test time because
// the tests need to be readable about who they're impersonating.
const HERITAGE_OWNER_USER_ID = 'd5f9972e-03d3-4b7d-b0a4-a205aef0bedf'

// Hoisted mock for callClaude so individual tests can customize the
// LLM response per case. `vi.hoisted` runs before the `vi.mock` factory
// below, sidestepping the usual hoisting headache.
const { callClaudeMock } = vi.hoisted(() => ({ callClaudeMock: vi.fn() }))

// Mocks below only matter when the wrapper is imported (i.e. inside
// the write-path describe block when HAS_ENV is true). For unit-test
// runs without the env gate the wrapper is never imported and these
// factories never evaluate, so they're inert.

vi.mock('@/lib/supabase/server', async () => {
  const adminMod =
    await vi.importActual<typeof import('@/lib/supabase/admin')>(
      '@/lib/supabase/admin',
    )
  const { supabaseAdmin } = adminMod

  // The `dq_create_target_field_mapping` RPC is SECURITY DEFINER and
  // gates on `user_has_project_role(..., auth.uid())`. When we route
  // the user-scoped client through `supabaseAdmin`, `auth.uid()` is
  // NULL and the gate denies the call. The wrapper's outer
  // `requireProjectPermission` already enforces the same role check
  // (mocked to allow above), so for integration we substitute an
  // INSERT-equivalent that bypasses the in-RPC gate. Other RPCs (none
  // in this wrapper today) fall through to the admin client.
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

vi.mock('@/lib/ai/claude', () => ({
  callClaude: callClaudeMock,
}))

vi.mock('@/lib/ai/rate-limit', () => ({
  checkAIRateLimit: () => ({ allowed: true }),
}))

// Identity material discovered against Heritage in `beforeAll`. All
// IDs are real Heritage UUIDs — no synthetic data here. The discovery
// queries are deliberately small (limit-bounded) so test setup stays
// under a second.
interface HeritageWriteFixtures {
  // A target field with no live target_field_mappings row (Rule 6
  // unmapped). Each test creates+deletes a TFM here.
  unmappedTargetField: { id: string; tableId: string; name: string }
  // A second unmapped target field — used for tests that run in
  // parallel describes or that need a clean target distinct from the
  // primary.
  secondUnmappedTargetField: { id: string; tableId: string; name: string }
  // Two source fields in the SAME source table (any non-rejected
  // table) for the multi-source same-table happy path.
  sameTableSources: Array<{ id: string; tableId: string; name: string }>
  // Two source fields in DIFFERENT source tables for the cross-table
  // guard test.
  crossTableSources: Array<{ id: string; tableId: string; name: string }>
  // The single source field used for the simple happy path. Lives in
  // a source table that has a TM to the target table OR where
  // findOrCreateTableMapping will create one. Either way the wrapper
  // succeeds.
  primarySource: { id: string; tableId: string; name: string }
}

async function discoverHeritageWriteFixtures(): Promise<HeritageWriteFixtures> {
  const { supabaseAdmin } = await import('@/lib/supabase/admin')

  // Find target tables in Heritage.
  const { data: targetTables } = await supabaseAdmin
    .from('tables')
    .select('id, name, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', 'target')
  if (!targetTables || targetTables.length === 0) {
    throw new Error('No target tables in Heritage — fixture discovery failed')
  }
  const targetTableIds = targetTables.map((t) => t.id)

  // Pick TWO target fields with no live TFM. Avoid the `notes` field
  // because the user-side smoke test reuses it — interfering would
  // cross-contaminate.
  const { data: allTargetFields } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .in('table_id', targetTableIds)
  if (!allTargetFields || allTargetFields.length === 0) {
    throw new Error('No target fields in Heritage')
  }

  const { data: liveTfms } = await supabaseAdmin
    .from('target_field_mappings')
    .select('target_field_id')
    .eq('project_id', HERITAGE_PROJECT_ID)
  const tfmTargetIds = new Set((liveTfms ?? []).map((t) => t.target_field_id))

  const unmappedCandidates = allTargetFields
    .filter((f) => !tfmTargetIds.has(f.id) && f.name !== 'notes')
    .map((f) => ({ id: f.id, tableId: f.table_id as string, name: f.name }))

  if (unmappedCandidates.length < 2) {
    throw new Error(
      `Need ≥2 unmapped target fields in Heritage (excluding "notes"); ` +
        `found ${unmappedCandidates.length}.`,
    )
  }
  const unmappedTargetField = unmappedCandidates[0]
  const secondUnmappedTargetField = unmappedCandidates[1]

  // Find source tables — pick one with ≥2 fields for same-table
  // multi-source, and a different one for cross-table.
  const { data: sourceTables } = await supabaseAdmin
    .from('tables')
    .select('id, name, datasets!inner(project_id, role)')
    .eq('datasets.project_id', HERITAGE_PROJECT_ID)
    .eq('datasets.role', 'source')
  if (!sourceTables || sourceTables.length < 2) {
    throw new Error(
      'Need ≥2 source tables in Heritage for cross-table fixture',
    )
  }

  // Resolve same-table sources from the first source table.
  const firstSourceTable = sourceTables[0]
  const { data: firstSourceFields } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('table_id', firstSourceTable.id)
    .limit(2)
  if (!firstSourceFields || firstSourceFields.length < 2) {
    throw new Error(
      `Need ≥2 fields in source table "${firstSourceTable.name}" for ` +
        `same-table multi-source fixture`,
    )
  }
  const sameTableSources = firstSourceFields.map((f) => ({
    id: f.id,
    tableId: f.table_id as string,
    name: f.name,
  }))
  const primarySource = sameTableSources[0]

  // Cross-table fixture: pick one field each from the first two
  // distinct source tables.
  const secondSourceTable = sourceTables[1]
  const { data: secondSourceFields } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('table_id', secondSourceTable.id)
    .limit(1)
  if (!secondSourceFields || secondSourceFields.length === 0) {
    throw new Error(
      `Source table "${secondSourceTable.name}" has no fields for ` +
        `cross-table fixture`,
    )
  }
  const crossTableSources = [
    sameTableSources[0],
    {
      id: secondSourceFields[0].id,
      tableId: secondSourceFields[0].table_id as string,
      name: secondSourceFields[0].name,
    },
  ]

  return {
    unmappedTargetField,
    secondUnmappedTargetField,
    sameTableSources,
    crossTableSources,
    primarySource,
  }
}

// Cleanup: tracked TFM ids created across tests. afterEach deletes
// them so the next test runs against a clean slate. Cross-test
// pollution would surface as EXISTING_TFM collisions on the second
// run, which would mask real defects.
const createdTfmIds = new Set<string>()

async function cleanupCreatedTfms(): Promise<void> {
  if (createdTfmIds.size === 0) return
  const { supabaseAdmin } = await import('@/lib/supabase/admin')
  const ids = Array.from(createdTfmIds)
  // Identity-snapshot the parent TMs so we can recompute their status
  // post-delete (the wrapper recomputes on create; we mirror that on
  // cleanup to leave Heritage in a deterministic coverage state).
  const { data: msRows } = await supabaseAdmin
    .from('mapping_sources')
    .select(
      'target_field_mapping_id, source_table_id, target_field_mappings!inner(project_id, target_field_id)',
    )
    .in('target_field_mapping_id', ids)
  const tmKeys = new Set<string>()
  for (const ms of msRows ?? []) {
    const parent = (ms as unknown as {
      target_field_mappings: { project_id: string; target_field_id: string }
    }).target_field_mappings
    if (!parent) continue
    // Resolve TM via (source_table_id, target_table_id, project_id).
    // We don't have target_table_id directly; look it up via target field.
    const { data: tgtField } = await supabaseAdmin
      .from('fields')
      .select('table_id')
      .eq('id', parent.target_field_id)
      .single()
    if (!tgtField) continue
    const { data: tm } = await supabaseAdmin
      .from('table_mappings')
      .select('id')
      .eq('project_id', parent.project_id)
      .eq('source_table_id', ms.source_table_id)
      .eq('target_table_id', tgtField.table_id as string)
      .maybeSingle()
    if (tm?.id) tmKeys.add(tm.id)
  }

  await supabaseAdmin.from('target_field_mappings').delete().in('id', ids)
  createdTfmIds.clear()

  // Restore parent TM coverage. Best-effort: if the recompute fails,
  // the TM lands in an inconsistent state but the next user-driven
  // mapping action will recover. We log instead of throwing so a
  // single flaky cleanup doesn't cascade into red tests.
  if (tmKeys.size > 0) {
    try {
      const { recomputeTableMappingStatus } = await import(
        '@/lib/actions/mappings'
      )
      const fakeClient = {
        from: supabaseAdmin.from.bind(supabaseAdmin),
        rpc: supabaseAdmin.rpc.bind(supabaseAdmin),
      } as unknown as Parameters<typeof recomputeTableMappingStatus>[0]
      for (const tmId of tmKeys) {
        await recomputeTableMappingStatus(fakeClient, tmId)
      }
    } catch (err) {
      console.warn('[write-path cleanup] recompute failed:', err)
    }
  }
}

const writeDescribeFn = HAS_ENV ? describe : describe.skip

writeDescribeFn(
  '[integration] mappings-for-redesign WRITE PATH against Heritage',
  () => {
    let fixtures: HeritageWriteFixtures

    beforeAll(async () => {
      fixtures = await discoverHeritageWriteFixtures()
    }, 60_000)

    afterEach(async () => {
      await cleanupCreatedTfms()
      callClaudeMock.mockReset()
    })

    it('createFieldMapping happy path — single source, same-table', async () => {
      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )
      const { supabaseAdmin } = await import('@/lib/supabase/admin')

      const result = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.unmappedTargetField.id,
        sourceFieldIds: [fixtures.primarySource.id],
        combinationType: 'single',
      })

      expect(result.success).toBe(true)
      if (!result.success) return // type narrowing
      createdTfmIds.add(result.tfmId)

      // Verify TFM shape.
      const { data: tfm } = await supabaseAdmin
        .from('target_field_mappings')
        .select(
          'id, project_id, target_field_id, status, is_acknowledged, combination_type',
        )
        .eq('id', result.tfmId)
        .single()
      expect(tfm).toMatchObject({
        id: result.tfmId,
        project_id: HERITAGE_PROJECT_ID,
        target_field_id: fixtures.unmappedTargetField.id,
        status: 'needs_review',
        is_acknowledged: false,
        combination_type: 'single',
      })

      // Verify exactly one mapping_sources child with ordinal 0.
      const { data: ms } = await supabaseAdmin
        .from('mapping_sources')
        .select('source_field_id, ordinal')
        .eq('target_field_mapping_id', result.tfmId)
      expect(ms).toEqual([
        { source_field_id: fixtures.primarySource.id, ordinal: 0 },
      ])

      // Verify activity_log entry.
      const { data: log } = await supabaseAdmin
        .from('activity_log')
        .select('action_type, description, metadata')
        .eq('project_id', HERITAGE_PROJECT_ID)
        .eq('action_type', 'mapping_created')
        .contains('metadata', { target_field_mapping_id: result.tfmId })
        .limit(1)
      expect(log).toHaveLength(1)
      expect((log ?? [])[0].description).toContain(
        fixtures.unmappedTargetField.name,
      )
    }, 30_000)

    it('createFieldMapping happy path — multi-source same-table (concat_space)', async () => {
      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )
      const { supabaseAdmin } = await import('@/lib/supabase/admin')

      const sourceIds = fixtures.sameTableSources.map((s) => s.id)
      const result = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.secondUnmappedTargetField.id,
        sourceFieldIds: sourceIds,
        combinationType: 'concat_space',
      })

      expect(result.success).toBe(true)
      if (!result.success) return
      createdTfmIds.add(result.tfmId)

      const { data: tfm } = await supabaseAdmin
        .from('target_field_mappings')
        .select('combination_type, status')
        .eq('id', result.tfmId)
        .single()
      expect(tfm).toMatchObject({
        combination_type: 'concat_space',
        status: 'needs_review',
      })

      const { data: ms } = await supabaseAdmin
        .from('mapping_sources')
        .select('source_field_id, ordinal')
        .eq('target_field_mapping_id', result.tfmId)
        .order('ordinal', { ascending: true })
      expect(ms).toEqual([
        { source_field_id: sourceIds[0], ordinal: 0 },
        { source_field_id: sourceIds[1], ordinal: 1 },
      ])
    }, 30_000)

    it('createFieldMapping cross-table input → CROSS_TABLE_NOT_YET_SUPPORTED', async () => {
      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )

      const result = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.unmappedTargetField.id,
        sourceFieldIds: fixtures.crossTableSources.map((s) => s.id),
        combinationType: 'concat_space',
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.errorCode).toBe('CROSS_TABLE_NOT_YET_SUPPORTED')
    }, 30_000)

    it('createFieldMapping custom_sql → VALIDATION', async () => {
      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )

      const result = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.unmappedTargetField.id,
        sourceFieldIds: [fixtures.primarySource.id],
        combinationType: 'custom_sql',
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.errorCode).toBe('VALIDATION')
      expect(result.error.toLowerCase()).toContain('custom sql')
    }, 30_000)

    it('createFieldMapping empty sourceFieldIds → VALIDATION', async () => {
      const { createFieldMapping } = await import(
        '@/lib/actions/mappings-for-redesign'
      )

      const result = await createFieldMapping({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.unmappedTargetField.id,
        sourceFieldIds: [],
        combinationType: 'concat_space',
      })

      expect(result.success).toBe(false)
      if (result.success) return
      expect(result.errorCode).toBe('VALIDATION')
      expect(result.error.toLowerCase()).toContain(
        'at least one source field is required',
      )
    }, 30_000)

    it('suggestMappingForTarget happy path — identity read works, prompt assembled', async () => {
      const { suggestMappingForTarget } = await import(
        '@/lib/actions/mappings-for-redesign'
      )

      // Mock the LLM to return a known Heritage source field name. The
      // wrapper resolves bare names → ids via a project-wide lookup, so
      // any field from `sameTableSources` is guaranteed to round-trip.
      const fieldName = fixtures.primarySource.name
      callClaudeMock.mockResolvedValueOnce(
        JSON.stringify({
          source_field_names: [fieldName],
          combination_type: 'single',
          confidence: 80,
          rationale: 'Mocked rationale for integration test',
        }),
      )

      const result = await suggestMappingForTarget({
        projectId: HERITAGE_PROJECT_ID,
        targetFieldId: fixtures.unmappedTargetField.id,
      })

      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.suggestion.sourceFieldIds).toEqual([
        fixtures.primarySource.id,
      ])
      expect(result.suggestion.combinationType).toBe('single')
      expect(result.suggestion.confidence).toBe(80)

      // Verify prompt assembly: the LLM was called once and the user
      // message references the target field name (proves identity read
      // succeeded — the regression we just fixed).
      expect(callClaudeMock).toHaveBeenCalledTimes(1)
      const userMsg = callClaudeMock.mock.calls[0][1] as string
      expect(userMsg).toContain(fixtures.unmappedTargetField.name)
    }, 60_000)
  },
)
