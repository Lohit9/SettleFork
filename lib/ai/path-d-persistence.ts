/**
 * Path D persistence — writes parser output (`PathDParsedOutput`) into the
 * 5 new tables from migration 093 + TFM enrichment columns + outputs row
 * for project_notes.
 *
 * ── Insertion order (dependency-driven, NOT emit order) ────────────────────
 * The LLM emits sections in fixed order (mappings → coverage → ... →
 * project_notes), but cross-section references force a different INSERT
 * order:
 *
 *   1.   data_quality          — mints DQ UUIDs first
 *   2.   mappings              — resolves data_quality_flag_indices → DQ UUIDs
 *   2.5  mapping_sources       — INF-45: source-field associations per TFM.
 *                                Mints no UUIDs that downstream passes need;
 *                                placed immediately after Pass 2 because it
 *                                consumes the TFM UUIDs Pass 2 returned and
 *                                completes the TFM logical write before any
 *                                downstream reads (eg. read-after-write
 *                                from getMappingsForRedesign).
 *   3.   coverage              — references target_field_id (no TFM ID needed)
 *   4.   lookup_tables         — independent
 *   5.   inferred_targets      — independent
 *   6.   decisions             — resolves applies_to.tfm_indices → TFM UUIDs
 *                                (mappings inserted first to mint TFM UUIDs)
 *   7.   project_notes         — independent; upsert into outputs table
 *
 * ── Idempotency strategy (hybrid) ──────────────────────────────────────────
 * Re-running Path D for the same project should not produce duplicates AND
 * should preserve human-decided rows. Per-table strategy:
 *
 *   target_field_mappings    UPSERT by (project_id, target_field_id)
 *   target_field_coverage    UPSERT by (project_id, target_field_id)
 *   project_lookup_tables    UPSERT by (project_id, name)
 *   project_decisions        DELETE WHERE status='pending', then INSERT
 *                            (preserves human-decided rows)
 *   project_data_quality_issues  DELETE WHERE acknowledged_at IS NULL, INSERT
 *                                (preserves acknowledged rows)
 *   project_inferred_targets  DELETE WHERE acknowledged_at IS NULL, INSERT
 *   mapping_sources          DELETE WHERE target_field_mapping_id IN tfmIds,
 *                            then INSERT (INF-45). The TFM UPSERT preserves
 *                            ids across runs but does NOT cascade-delete
 *                            mapping_sources; the explicit DELETE clears
 *                            stale rows so a re-run that emits fewer
 *                            sources for the same TFM doesn't leave
 *                            orphans. Ordinal in the inserted rows = the
 *                            source's array index in MappingPayload.
 *                            source_field_ids (preserves emit order).
 *   outputs (project_notes)  UPSERT by (project_id, type='path_d_project_notes')
 *
 * ── Per-section transactions ───────────────────────────────────────────────
 * Each section's persistence is wrapped in its own try/catch. Failure on
 * `decisions` does NOT roll back `mappings`. Caller receives per-section
 * status via the returned record. Matches "partial output should persist
 * what parsed cleanly" decision from the architecture investigation.
 *
 * ── Cross-reference resolution ─────────────────────────────────────────────
 * Parser preserves indices verbatim:
 *   - `mappings[i].data_quality_flag_indices`: [int] indices into data_quality
 *   - `decisions[i].applies_to.tfm_indices`:   [int] indices into mappings
 *   - `decisions[i].applies_to.coverage_indices`: [int] indices into coverage
 *
 * Persistence resolves indices to UUIDs by tracking insertion order: when
 * data_quality is inserted, the resulting array of inserted IDs is kept in
 * memory (`dqIds[]`). Subsequent mapping inserts look up
 * `dqIds[index]` to convert the index reference to a UUID. Same pattern for
 * tfm_indices + coverage_indices.
 *
 * Skipped sections (status !== 'parsed_ok') do NOT block downstream sections
 * — references to skipped sections resolve to empty arrays.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveDefaultTableMappingsForTargetFields } from '@/lib/utils/partition-binding'
import type {
  PathDParsedOutput,
  MappingPayload,
  CoveragePayload,
  DecisionPayload,
  LookupTablePayload,
  DQFindingPayload,
  InferredTargetPayload,
} from '@/lib/ai/path-d-parser'

export type SectionPersistStatus =
  | { status: 'inserted'; count: number }
  | { status: 'skipped'; reason: string }
  | { status: 'errored'; error: string }

export interface PathDPersistResult {
  data_quality: SectionPersistStatus
  mappings: SectionPersistStatus
  /** INF-45: status of the mapping_sources INSERT pass (Pass 2.5).
   *  Reported separately from `mappings` so a partial failure (TFMs
   *  upserted but mapping_sources insert errored) is observable. */
  mapping_sources: SectionPersistStatus
  /** Pass 2.6: table_mappings rows derived from the (source_table,
   *  target_table) pairs implied by MappingPayload.source_field_ids ×
   *  target_field_id. Path D originally skipped this table entirely,
   *  which left the Transform page (gated on table_mappings.length>0
   *  at lib/actions/transformations.ts:551) showing an empty state
   *  for every Path D-only project. Reported separately so a failure
   *  here is observable without conflating with mapping_sources. */
  table_mappings: SectionPersistStatus
  coverage: SectionPersistStatus
  lookup_tables: SectionPersistStatus
  inferred_targets: SectionPersistStatus
  decisions: SectionPersistStatus
  project_notes: SectionPersistStatus
}

export interface PersistPathDOutputArgs {
  supabaseAdmin: SupabaseClient
  projectId: string
  userId: string
  experimentRunId: string
  parsed: PathDParsedOutput
}

export async function persistPathDOutput(
  args: PersistPathDOutputArgs,
): Promise<PathDPersistResult> {
  const { supabaseAdmin, projectId, userId, experimentRunId, parsed } = args

  const result: PathDPersistResult = {
    data_quality: { status: 'skipped', reason: 'not yet attempted' },
    mappings: { status: 'skipped', reason: 'not yet attempted' },
    mapping_sources: { status: 'skipped', reason: 'not yet attempted' },
    table_mappings: { status: 'skipped', reason: 'not yet attempted' },
    coverage: { status: 'skipped', reason: 'not yet attempted' },
    lookup_tables: { status: 'skipped', reason: 'not yet attempted' },
    inferred_targets: { status: 'skipped', reason: 'not yet attempted' },
    decisions: { status: 'skipped', reason: 'not yet attempted' },
    project_notes: { status: 'skipped', reason: 'not yet attempted' },
  }

  // Pass 1: data_quality (mints DQ UUIDs needed by mappings cross-refs)
  const dqIds: string[] = []
  if (parsed.data_quality.status === 'parsed_ok') {
    try {
      const ids = await persistDataQuality(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.data_quality.data,
      )
      dqIds.push(...ids)
      result.data_quality = { status: 'inserted', count: ids.length }
    } catch (err) {
      result.data_quality = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.data_quality = {
      status: 'skipped',
      reason: parsed.data_quality.status === 'parse_error' ? parsed.data_quality.error : 'missing',
    }
  }

  // Pass 2: mappings (resolves data_quality_flag_indices → dqIds[])
  const tfmIds: string[] = []
  if (parsed.mappings.status === 'parsed_ok') {
    try {
      const ids = await persistMappings(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.mappings.data,
        dqIds,
      )
      tfmIds.push(...ids)
      result.mappings = { status: 'inserted', count: ids.length }
    } catch (err) {
      result.mappings = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.mappings = {
      status: 'skipped',
      reason: parsed.mappings.status === 'parse_error' ? parsed.mappings.error : 'missing',
    }
  }

  // Pass 2.5: mapping_sources (INF-45). Pre-INF-45 the TFM UPSERT in
  // Pass 2 silently dropped MappingPayload.source_field_ids — every Path D
  // run wrote TFM shells without their source associations, leaving the
  // UI to render every Path D-generated mapping as "—" (no source). This
  // pass writes the mapping_sources rows that the UI's read path expects.
  //
  // Skipped cleanly when Pass 2 didn't run (mappings parse-errored or
  // missing) — mapping_sources rows would have no TFMs to attach to.
  if (parsed.mappings.status === 'parsed_ok' && tfmIds.length > 0) {
    try {
      const count = await persistMappingSources(
        supabaseAdmin,
        parsed.mappings.data,
        tfmIds,
      )
      result.mapping_sources = { status: 'inserted', count }
    } catch (err) {
      result.mapping_sources = {
        status: 'errored',
        error: (err as Error).message,
      }
    }
  } else if (parsed.mappings.status !== 'parsed_ok') {
    result.mapping_sources = {
      status: 'skipped',
      reason: 'mappings section not parsed_ok',
    }
  } else {
    // Pass 2 ran but yielded zero TFM ids (empty mappings array).
    result.mapping_sources = { status: 'inserted', count: 0 }
  }

  // Pass 2.6: table_mappings. Path D originally skipped this table entirely
  // because its data model (TFM-centric) didn't need it. But the Transform
  // page, readiness-score, fix-target, and detection-engine-core all gate on
  // `table_mappings.length > 0` for the project — without a TM row per
  // (source_table, target_table) pair they degrade to empty/null. This pass
  // derives the pair set from MappingPayload.source_field_ids × target_field
  // and inserts any missing TM rows with status='needs_review'. VAs (empty
  // source_field_ids) contribute zero pairs — matches legacy semantics where
  // VAs live under TMs the table-pair flow already created. Multi-source-
  // table TFMs (sources spanning multiple source_tables) contribute one
  // pair per distinct source_table. Idempotent via existing-pair pre-fetch;
  // re-running Path D will not duplicate.
  if (parsed.mappings.status === 'parsed_ok') {
    try {
      const count = await persistTableMappings(
        supabaseAdmin,
        projectId,
        parsed.mappings.data,
      )
      result.table_mappings = { status: 'inserted', count }
    } catch (err) {
      result.table_mappings = {
        status: 'errored',
        error: (err as Error).message,
      }
    }
  } else {
    result.table_mappings = {
      status: 'skipped',
      reason: 'mappings section not parsed_ok',
    }
  }

  // Pass 3: coverage (references target_field_id; no TFM UUID resolution needed)
  const coverageIds: string[] = []
  if (parsed.coverage.status === 'parsed_ok') {
    try {
      const ids = await persistCoverage(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.coverage.data,
      )
      coverageIds.push(...ids)
      result.coverage = { status: 'inserted', count: ids.length }
    } catch (err) {
      result.coverage = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.coverage = {
      status: 'skipped',
      reason: parsed.coverage.status === 'parse_error' ? parsed.coverage.error : 'missing',
    }
  }

  // Pass 4: lookup_tables (independent)
  if (parsed.lookup_tables.status === 'parsed_ok') {
    try {
      const count = await persistLookupTables(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.lookup_tables.data,
      )
      result.lookup_tables = { status: 'inserted', count }
    } catch (err) {
      result.lookup_tables = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.lookup_tables = {
      status: 'skipped',
      reason:
        parsed.lookup_tables.status === 'parse_error' ? parsed.lookup_tables.error : 'missing',
    }
  }

  // Pass 5: inferred_targets (independent)
  if (parsed.inferred_targets.status === 'parsed_ok') {
    try {
      const count = await persistInferredTargets(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.inferred_targets.data,
      )
      result.inferred_targets = { status: 'inserted', count }
    } catch (err) {
      result.inferred_targets = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.inferred_targets = {
      status: 'skipped',
      reason:
        parsed.inferred_targets.status === 'parse_error'
          ? parsed.inferred_targets.error
          : 'missing',
    }
  }

  // Pass 6: decisions (resolves applies_to.tfm_indices → tfmIds[],
  //                  applies_to.coverage_indices → coverageIds[])
  if (parsed.decisions.status === 'parsed_ok') {
    try {
      const count = await persistDecisions(
        supabaseAdmin,
        projectId,
        experimentRunId,
        parsed.decisions.data,
        tfmIds,
        coverageIds,
      )
      result.decisions = { status: 'inserted', count }
    } catch (err) {
      result.decisions = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.decisions = {
      status: 'skipped',
      reason: parsed.decisions.status === 'parse_error' ? parsed.decisions.error : 'missing',
    }
  }

  // Pass 7: project_notes (upsert into outputs)
  if (parsed.project_notes.status === 'parsed_ok') {
    try {
      await persistProjectNotes(
        supabaseAdmin,
        projectId,
        userId,
        experimentRunId,
        parsed.project_notes.data,
      )
      result.project_notes = { status: 'inserted', count: 1 }
    } catch (err) {
      result.project_notes = { status: 'errored', error: (err as Error).message }
    }
  } else {
    result.project_notes = {
      status: 'skipped',
      reason:
        parsed.project_notes.status === 'parse_error' ? parsed.project_notes.error : 'missing',
    }
  }

  return result
}

// ── Per-section helpers ─────────────────────────────────────────────────────

async function persistDataQuality(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: DQFindingPayload[],
): Promise<string[]> {
  // DELETE WHERE acknowledged_at IS NULL — preserves acknowledged findings
  const delResult = await admin
    .from('project_data_quality_issues')
    .delete()
    .eq('project_id', projectId)
    .is('acknowledged_at', null)
  if (delResult.error) throw new Error(`data_quality delete: ${delResult.error.message}`)

  if (data.length === 0) return []

  const rows = data.map((d) => ({
    project_id: projectId,
    source_field_id: d.source_field_id ?? null,
    severity: d.severity,
    category: d.category,
    description: d.description,
    example_values: d.example_values ?? null,
    recommendation: d.recommendation ?? null,
    experiment_run_id: experimentRunId,
  }))

  const insResult = await admin
    .from('project_data_quality_issues')
    .insert(rows)
    .select('id')
  if (insResult.error) throw new Error(`data_quality insert: ${insResult.error.message}`)

  return (insResult.data ?? []).map((r) => r.id as string)
}

// ─── INF-53 user-lock helpers ────────────────────────────────────────────────
//
// Re-running Path D used to silently overwrite customer approve/reject
// decisions on every UPSERT. INF-53 fixes that by pre-fetching the
// existing user-locked rows on each surface and preserving their status
// in the row mapper (Approach B: refresh AI metadata, preserve user
// status — locked semantic is "respect my decision," not "freeze the
// AI commentary").
//
// Lock signal differs by surface:
//   * coverage  → status_set_by='user' (explicit provenance from
//                 setCoverageStatus in mappings-for-redesign.ts)
//   * TFM       → status IN ('approved', 'rejected'). AI never emits
//                 these values; MappingPayloadSchema defaults to
//                 'needs_review'. So the status itself is the user-
//                 action signal — no separate provenance column needed.
//
// Each helper returns a Map<target_field_id, status> the persister
// consults during the row map. Single round-trip per surface; cheap.

async function fetchCoverageUserLocks(
  admin: SupabaseClient,
  projectId: string,
): Promise<Map<string, 'needs_review' | 'approved' | 'rejected'>> {
  const res = await admin
    .from('target_field_coverage')
    .select('target_field_id, status')
    .eq('project_id', projectId)
    .eq('status_set_by', 'user')
  if (res.error) {
    throw new Error(`coverage user-lock fetch: ${res.error.message}`)
  }
  const map = new Map<string, 'needs_review' | 'approved' | 'rejected'>()
  for (const row of res.data ?? []) {
    map.set(
      row.target_field_id as string,
      row.status as 'needs_review' | 'approved' | 'rejected',
    )
  }
  return map
}

async function fetchTfmUserLocks(
  admin: SupabaseClient,
  projectId: string,
): Promise<Map<string, 'approved' | 'rejected'>> {
  const res = await admin
    .from('target_field_mappings')
    .select('target_field_id, status')
    .eq('project_id', projectId)
    .in('status', ['approved', 'rejected'])
  if (res.error) {
    throw new Error(`tfm user-lock fetch: ${res.error.message}`)
  }
  const map = new Map<string, 'approved' | 'rejected'>()
  for (const row of res.data ?? []) {
    map.set(row.target_field_id as string, row.status as 'approved' | 'rejected')
  }
  return map
}

async function persistMappings(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: MappingPayload[],
  dqIds: string[],
): Promise<string[]> {
  if (data.length === 0) return []

  // INF-53 — pre-fetch existing user-approved/rejected TFMs so the
  // UPSERT below preserves their status. Without this fetch, re-running
  // Path D would silently overwrite every user approval with the AI's
  // default 'needs_review', a fundamental trust violation.
  const userLocks = await fetchTfmUserLocks(admin, projectId)

  // PR Ω.1 — Path D writes ack-style TFMs without a natural source TM.
  // Resolve the default table_mapping_id for each target field via the
  // same rule migration 107's backfill #2 used (MIN created_at, id).
  const defaultTms = await resolveDefaultTableMappingsForTargetFields(
    admin,
    projectId,
    data.map((m) => m.target_field_id),
  )

  // Build TFM rows; resolve data_quality_flag_indices → dqIds[]
  const tfmRows = data.map((m) => {
    const dqUuids = m.data_quality_flag_indices
      .map((idx) => dqIds[idx])
      .filter((u): u is string => Boolean(u))
    // INF-53 — preserve user-set status when re-running Path D. AI
    // metadata (ai_reasoning, confidence, transformation_intent, etc.)
    // continues to refresh on every run; only the status decision is
    // sticky for user-locked rows.
    const lockedStatus = userLocks.get(m.target_field_id)
    return {
      project_id: projectId,
      target_field_id: m.target_field_id,
      table_mapping_id: defaultTms.get(m.target_field_id),
      ai_reasoning: m.ai_reasoning,
      transformation_intent: m.transformation_intent,
      mapping_cardinality: m.mapping_cardinality,
      dedup_required: m.dedup_required,
      dedup_strategy: m.dedup_strategy ?? null,
      data_quality_flag_ids: dqUuids,
      combination_type: m.combination_type,
      combination_sql: m.combination_sql ?? null,
      confidence: m.confidence ?? null,
      status: lockedStatus ?? m.status,
      experiment_run_id: experimentRunId,
    }
  })

  // Drop rows that have no matching TM for the target table — the NOT NULL
  // constraint on target_field_mappings.table_mapping_id (PR Ω.1) would reject
  // them and abort the entire upsert otherwise. Log so the operator notices.
  const orphans = tfmRows.filter((r) => !r.table_mapping_id)
  if (orphans.length > 0) {
    console.error(
      `[path-d-persistence] ${orphans.length} target field(s) skipped — no table_mapping for their target table:`,
      orphans.map((r) => r.target_field_id),
    )
  }
  const writableRows = tfmRows.filter((r) => r.table_mapping_id)
  if (writableRows.length === 0) return []

  // UPSERT by (project_id, target_field_id, table_mapping_id) — partition-aware
  // natural key from migration 107.
  const upResult = await admin
    .from('target_field_mappings')
    .upsert(writableRows, { onConflict: 'project_id,target_field_id,table_mapping_id' })
    .select('id, target_field_id')
  if (upResult.error) throw new Error(`mappings upsert: ${upResult.error.message}`)

  // Preserve order matching `data` so downstream tfm_indices resolve correctly.
  const upserted = upResult.data ?? []
  const idByTargetFieldId = new Map<string, string>()
  for (const row of upserted) {
    idByTargetFieldId.set(row.target_field_id as string, row.id as string)
  }
  // Return TFM IDs in the SAME ORDER as the input data array (so tfm_indices
  // from decisions resolve correctly).
  return data.map((m) => idByTargetFieldId.get(m.target_field_id) ?? '').filter(Boolean)
}

// ─── Pass 2.5: mapping_sources (INF-45) ──────────────────────────────────────
//
// Bug class fixed: pre-INF-45 the TFM UPSERT in Pass 2 silently dropped
// `MappingPayload.source_field_ids`. The AI emitted source associations
// per mapping; the parser preserved them; the persistence layer never
// read them. Result: every Path D run produced TFM shells with no
// children rows in `mapping_sources`, and the UI rendered every Path D
// mapping as "—" (no source).
//
// Why undetected: tests/lib/path-d-persistence.test.ts had zero
// mapping_sources references (verified by grep), and the Phase C eval
// runner scores in-memory parsed output before any persistence runs.
//
// Re-run idempotency: TFM ids are stable across runs (Pass 2 UPSERTs
// by (project_id, target_field_id) preserves ids), so this pass must
// explicitly clear stale mapping_sources rows for the affected TFMs
// before inserting fresh ones — otherwise a re-run that emits fewer
// sources for a TFM would leave orphan source associations in place.
// Same DELETE-then-INSERT pattern as Passes 6 (decisions), 1
// (data_quality), and 5 (inferred_targets).
//
// `source_table_id` resolution: `MappingPayload.source_field_ids`
// carries only field UUIDs. The mapping_sources schema has a
// `source_table_id` FK that the read path consumes. Resolved here
// via a single batch fetch from `fields` keyed on the union of
// source_field_ids across all mappings — one round-trip regardless
// of mapping count.
async function persistMappingSources(
  admin: SupabaseClient,
  data: MappingPayload[],
  tfmIdsInOrder: string[],
): Promise<number> {
  if (data.length === 0 || tfmIdsInOrder.length === 0) return 0

  // Build (tfmId, source_field_id, ordinal, confidence) tuples. Skip
  // mappings whose source_field_ids array is empty (no sources to
  // associate). Skip entries whose tfmId failed to resolve (defensive —
  // persistMappings already filtered these out via the
  // `idByTargetFieldId` lookup).
  type SourceTuple = {
    tfmId: string
    sourceFieldId: string
    ordinal: number
    confidence: number | null
  }
  const tuples: SourceTuple[] = []
  for (let i = 0; i < data.length; i++) {
    const m = data[i]!
    const tfmId = tfmIdsInOrder[i]
    if (!tfmId) continue
    for (let ord = 0; ord < m.source_field_ids.length; ord++) {
      tuples.push({
        tfmId,
        sourceFieldId: m.source_field_ids[ord]!,
        ordinal: ord,
        confidence: m.confidence ?? null,
      })
    }
  }
  if (tuples.length === 0) return 0

  // Batch-fetch source_table_id for every distinct source_field_id we
  // need. One round-trip; ignores duplicates within `tuples` since the
  // .in() filter dedupes server-side.
  const distinctSourceFieldIds = Array.from(
    new Set(tuples.map((t) => t.sourceFieldId)),
  )
  const fieldsRes = await admin
    .from('fields')
    .select('id, table_id')
    .in('id', distinctSourceFieldIds)
  if (fieldsRes.error) {
    throw new Error(
      `mapping_sources: source_table_id lookup failed: ${fieldsRes.error.message}`,
    )
  }
  const tableIdBySourceFieldId = new Map<string, string>()
  for (const row of fieldsRes.data ?? []) {
    tableIdBySourceFieldId.set(row.id as string, row.table_id as string)
  }

  // Idempotency DELETE: clear any existing mapping_sources rows for the
  // TFMs in scope. Re-run safety — see file header.
  const delRes = await admin
    .from('mapping_sources')
    .delete()
    .in('target_field_mapping_id', tfmIdsInOrder)
  if (delRes.error) {
    throw new Error(
      `mapping_sources: pre-insert clear failed: ${delRes.error.message}`,
    )
  }

  // Build INSERT rows. Defensive: skip tuples whose source_field_id
  // didn't resolve to a table_id (the FK lookup found no match — the
  // AI emitted a UUID that doesn't exist in this project's fields).
  // The TFM column `data_quality_flag_ids` is set on the parent TFM,
  // not duplicated here.
  //
  // `confidence`: propagated from the parent MappingPayload onto every
  // contributing source row. Path D's payload schema carries one
  // confidence per mapping, not per source — duplicating across sources
  // is the faithful translation. This is load-bearing for the DB-side
  // recompute trigger (migration 074 §STEP 4): for non-custom_sql,
  // non-acknowledged TFMs the trigger runs `SET TFM.confidence =
  // MIN(mapping_sources.confidence)` after every source INSERT. When
  // every source was previously NULL the trigger overwrote TFM.confidence
  // to NULL (the flat-view bug); MIN of identical non-null values now
  // equals the parent's value, so TFM.confidence survives.
  // `ai_reasoning` / `similar_fields_considered` / `type_compatibility`
  // stay null — they're TFM-level on Path D's payload, not per-source.
  const rows = tuples
    .filter((t) => tableIdBySourceFieldId.has(t.sourceFieldId))
    .map((t) => ({
      target_field_mapping_id: t.tfmId,
      source_field_id: t.sourceFieldId,
      source_table_id: tableIdBySourceFieldId.get(t.sourceFieldId)!,
      ordinal: t.ordinal,
      confidence: t.confidence,
      ai_reasoning: null,
      similar_fields_considered: null,
      type_compatibility: null,
      join_spec: null,
    }))

  if (rows.length === 0) return 0

  const insRes = await admin.from('mapping_sources').insert(rows)
  if (insRes.error) {
    throw new Error(`mapping_sources: insert failed: ${insRes.error.message}`)
  }

  return rows.length
}

// ─── Pass 2.6: table_mappings ────────────────────────────────────────────────
//
// Path D's data model is TFM-centric: a `target_field_mappings` row carries
// the project/target_field/combination/source_field_ids it needs to render
// in the Mapping page. The redesigned Mapping read path (mapping-engine.ts
// :getMappingsForRedesignCore) reflects that — it never reads
// `table_mappings`. But the Transform page (lib/actions/transformations.ts
// :545-551), readiness-score (lib/quality/readiness-score.ts:67-71),
// fix-target (lib/quality/fix-target.ts:93-98), and detection-engine-core
// (lib/quality/_detection-engine-core.ts:755-758) all still scope their
// reads on `table_mappings` for the project and degrade to empty/null when
// the project has none. Pre-this-pass, every Path D-only project hit those
// degraded paths.
//
// This pass derives the unique (source_table_id, target_table_id) pair set
// from MappingPayload.source_field_ids × target_field_id, pre-fetches any
// pairs that already exist, and INSERTs the rest with status='needs_review'.
// Conventions match the legacy AI table-pair writer at mapping-engine.ts
// :1986-1997: status starts 'needs_review', confidence + ai_reasoning left
// null. `recomputeTableMappingStatus` (lib/actions/mappings.ts:833) is the
// downstream single source of truth for promotion — Path D does not call it
// (importing from lib/actions/* into lib/ai/* would invert layering).
//
// Edge cases:
//   * Empty source_field_ids (VAs / orphans): contribute zero pairs.
//     Matches legacy — VAs live under TMs the table-pair flow already
//     created; they never originate a new TM. Target tables that ONLY
//     receive VA TFMs and zero source-having TFMs WILL still render
//     empty in Transform (tracked in notes/follow-ups.md).
//   * Multi-source-table TFMs: contribute one pair per distinct source_
//     table. Both pairs are real distinct apply-batches downstream.
//   * Re-run idempotency: pre-fetch existing pairs and skip them. There
//     is no DB-level UNIQUE on (project_id, source_table_id,
//     target_table_id) so this app-side check is load-bearing.
async function persistTableMappings(
  admin: SupabaseClient,
  projectId: string,
  data: MappingPayload[],
): Promise<number> {
  if (data.length === 0) return 0

  // Pre-check: if every mapping is VA-shaped (empty source_field_ids), no
  // pair can be formed — skip the fields.select round-trip entirely. Also
  // preserves Pass 2.5's "no fields.select when source_field_ids are all
  // empty" invariant pinned by tests at tests/lib/path-d-persistence.test.ts.
  if (data.every((m) => m.source_field_ids.length === 0)) return 0

  // Collect the union of field UUIDs we need to resolve to table_id —
  // every source_field_id plus every target_field_id across all mappings.
  const fieldIds = new Set<string>()
  for (const m of data) {
    fieldIds.add(m.target_field_id)
    for (const sfId of m.source_field_ids) fieldIds.add(sfId)
  }
  if (fieldIds.size === 0) return 0

  const fieldsRes = await admin
    .from('fields')
    .select('id, table_id')
    .in('id', Array.from(fieldIds))
  if (fieldsRes.error) {
    throw new Error(
      `table_mappings: field→table_id lookup failed: ${fieldsRes.error.message}`,
    )
  }
  const tableIdByFieldId = new Map<string, string>()
  for (const row of fieldsRes.data ?? []) {
    tableIdByFieldId.set(row.id as string, row.table_id as string)
  }

  // Derive the unique pair set. VAs (source_field_ids: []) skip naturally.
  // Defensive: skip pairs whose endpoints failed to resolve (the AI emitted
  // a UUID not in the project's fields table — same defensive policy as
  // persistMappingSources).
  const pairs = new Set<string>()
  for (const m of data) {
    const tgtTableId = tableIdByFieldId.get(m.target_field_id)
    if (!tgtTableId) continue
    for (const sfId of m.source_field_ids) {
      const srcTableId = tableIdByFieldId.get(sfId)
      if (!srcTableId) continue
      pairs.add(`${srcTableId}::${tgtTableId}`)
    }
  }
  if (pairs.size === 0) return 0

  // Pre-fetch existing pairs for the project; the schema has no UNIQUE
  // constraint on (project_id, source_table_id, target_table_id) so we
  // dedupe application-side — same pattern as the legacy writer at
  // mapping-engine.ts:510-517.
  const existingRes = await admin
    .from('table_mappings')
    .select('source_table_id, target_table_id')
    .eq('project_id', projectId)
  if (existingRes.error) {
    throw new Error(
      `table_mappings: existing-pair lookup failed: ${existingRes.error.message}`,
    )
  }
  const existing = new Set<string>()
  for (const row of existingRes.data ?? []) {
    existing.add(`${row.source_table_id as string}::${row.target_table_id as string}`)
  }

  const rowsToInsert: Array<{
    project_id: string
    source_table_id: string
    target_table_id: string
    status: 'needs_review'
    confidence: null
    ai_reasoning: null
  }> = []
  for (const key of pairs) {
    if (existing.has(key)) continue
    const [src, tgt] = key.split('::')
    rowsToInsert.push({
      project_id: projectId,
      source_table_id: src!,
      target_table_id: tgt!,
      status: 'needs_review',
      confidence: null,
      ai_reasoning: null,
    })
  }
  if (rowsToInsert.length === 0) return 0

  const insRes = await admin.from('table_mappings').insert(rowsToInsert)
  if (insRes.error) {
    throw new Error(`table_mappings: insert failed: ${insRes.error.message}`)
  }
  return rowsToInsert.length
}

/**
 * Default coverage-row `status` for Path-D-authored rows. PR γ.2
 * reversed the original PR γ categorical-kind mapping (migration 095:
 * out_of_scope/optional → approved; gap/covered/partial → needs_review)
 * to a uniform 'needs_review' on every coverage row.
 *
 * Founder principle: AI proposes → deterministic validates → human
 * approves. The original auto-approve policy had the AI approving
 * out_of_scope and optional rows on the customer's behalf without
 * explicit review; status_set_by='ai_auto' on status='approved'
 * violated that principle. PR γ.2 (migration 097 + this helper flip)
 * removes the auto-approval; status_set_by='ai_auto' is now always
 * paired with status='needs_review' for forward writes.
 *
 * Migration 097 backfills the existing auto-approved rows
 * (status='approved' AND status_set_by='ai_auto') back to
 * 'needs_review' to bring production data in line with the new policy.
 *
 * Coverage row's status='approved' going forward is exclusively
 * status_set_by='user' (drawer-side approve action via setCoverageStatus
 * in lib/actions/mappings-for-redesign.ts).
 */
function defaultStatusForCoverageStatus(
  _coverageStatus: CoveragePayload['coverage_status'],
): 'needs_review' {
  return 'needs_review'
}

async function persistCoverage(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: CoveragePayload[],
): Promise<string[]> {
  if (data.length === 0) return []

  // INF-53 — pre-fetch existing user-locked coverage rows
  // (status_set_by='user') so the UPSERT below preserves their status +
  // status_set_by. Without this fetch, re-running Path D would silently
  // overwrite every customer-approved/rejected coverage row with
  // status='needs_review' + status_set_by='ai_auto'. Edge case
  // documented in PR body: when coverage_status changes on re-run for
  // a user-locked row, the AI verdict refreshes (e.g., 'gap' → 'covered'
  // because a new mapping landed in between) but the approval status
  // stands — the lock is on STATUS, not on the AI's verdict.
  const userLocks = await fetchCoverageUserLocks(admin, projectId)

  const rows = data.map((c) => {
    const lockedStatus = userLocks.get(c.target_field_id)
    const isLocked = lockedStatus !== undefined
    return {
      project_id: projectId,
      target_field_id: c.target_field_id,
      coverage_status: c.coverage_status,
      ai_reasoning: c.ai_reasoning ?? null,
      default_value_recommendation: c.default_value_recommendation ?? null,
      status: isLocked ? lockedStatus : defaultStatusForCoverageStatus(c.coverage_status),
      status_set_by: isLocked ? ('user' as const) : ('ai_auto' as const),
      // PR γ.1 — AI confidence on no-source rows. Path D emits 0.0-1.0
      // per CoveragePayloadSchema; persisted directly (mirrors the TFM
      // persistence convention at line 380 above — no ×100 scaling).
      // Optional on the wire payload, so legacy responses without the
      // field land as NULL and the UI renders an em-dash.
      confidence: c.confidence ?? null,
      experiment_run_id: experimentRunId,
    }
  })

  const upResult = await admin
    .from('target_field_coverage')
    .upsert(rows, { onConflict: 'project_id,target_field_id' })
    .select('id, target_field_id')
  if (upResult.error) throw new Error(`coverage upsert: ${upResult.error.message}`)

  const upserted = upResult.data ?? []
  const idByTargetFieldId = new Map<string, string>()
  for (const row of upserted) {
    idByTargetFieldId.set(row.target_field_id as string, row.id as string)
  }
  return data.map((c) => idByTargetFieldId.get(c.target_field_id) ?? '').filter(Boolean)
}

async function persistLookupTables(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: LookupTablePayload[],
): Promise<number> {
  if (data.length === 0) return 0

  const rows = data.map((l) => ({
    project_id: projectId,
    name: l.name,
    description: l.description ?? null,
    applies_to_fields: l.applies_to_fields ?? null,
    mappings: l.mappings,
    data_quality_notes: l.data_quality_notes ?? null,
    experiment_run_id: experimentRunId,
  }))

  const upResult = await admin
    .from('project_lookup_tables')
    .upsert(rows, { onConflict: 'project_id,name' })
    .select('id')
  if (upResult.error) throw new Error(`lookup_tables upsert: ${upResult.error.message}`)
  return (upResult.data ?? []).length
}

async function persistInferredTargets(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: InferredTargetPayload[],
): Promise<number> {
  // DELETE WHERE acknowledged_at IS NULL — preserves human-acknowledged rows
  const delResult = await admin
    .from('project_inferred_targets')
    .delete()
    .eq('project_id', projectId)
    .is('acknowledged_at', null)
  if (delResult.error)
    throw new Error(`inferred_targets delete: ${delResult.error.message}`)

  if (data.length === 0) return 0

  const rows = data.map((t) => ({
    project_id: projectId,
    inferred_target_object: t.inferred_target_object,
    evidence_source_fields: t.evidence_source_fields ?? null,
    reasoning: t.reasoning ?? null,
    experiment_run_id: experimentRunId,
  }))

  const insResult = await admin.from('project_inferred_targets').insert(rows).select('id')
  if (insResult.error) throw new Error(`inferred_targets insert: ${insResult.error.message}`)
  return (insResult.data ?? []).length
}

async function persistDecisions(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: DecisionPayload[],
  tfmIds: string[],
  coverageIds: string[],
): Promise<number> {
  // DELETE WHERE status='pending' — preserves human-decided rows
  const delResult = await admin
    .from('project_decisions')
    .delete()
    .eq('project_id', projectId)
    .eq('status', 'pending')
  if (delResult.error) throw new Error(`decisions delete: ${delResult.error.message}`)

  if (data.length === 0) return 0

  const rows = data.map((d) => {
    const tfmUuids = (d.applies_to?.tfm_indices ?? [])
      .map((idx) => tfmIds[idx])
      .filter((u): u is string => Boolean(u))
    const coverageUuids = (d.applies_to?.coverage_indices ?? [])
      .map((idx) => coverageIds[idx])
      .filter((u): u is string => Boolean(u))
    const appliesTo = {
      tfm_ids: tfmUuids,
      coverage_ids: coverageUuids,
    }
    return {
      project_id: projectId,
      decision_type: d.decision_type,
      title: d.title,
      description: d.description ?? null,
      ai_recommendation: d.ai_recommendation,
      alternatives: d.alternatives,
      applies_to: appliesTo,
      status: d.status,
      experiment_run_id: experimentRunId,
    }
  })

  const insResult = await admin.from('project_decisions').insert(rows).select('id')
  if (insResult.error) throw new Error(`decisions insert: ${insResult.error.message}`)
  return (insResult.data ?? []).length
}

async function persistProjectNotes(
  admin: SupabaseClient,
  projectId: string,
  _userId: string,
  experimentRunId: string,
  markdown: string,
): Promise<void> {
  // UPSERT into outputs by (project_id, type='path_d_project_notes').
  // The outputs table doesn't have a unique constraint on this combination,
  // so we DELETE+INSERT to maintain idempotency.
  //
  // Schema notes:
  //   - `outputs.metadata` (JSONB) was added in migration 049.
  //   - `outputs.type` CHECK extended to include 'path_d_project_notes' in
  //     migration 094 (the 4a draft of this helper assumed the value was
  //     already allowed; turned out it wasn't).
  //   - `outputs` has no `user_id` column (the 4a draft of this helper
  //     spuriously included one and the insert failed in production —
  //     fixed here by dropping the field). The userId arg stays in the
  //     signature for symmetry with the other persist helpers; prefixed
  //     with `_` to signal "intentionally unused".
  //   - `format` is NOT NULL in the schema (no default), so we set it to
  //     'markdown' explicitly.
  const delResult = await admin
    .from('outputs')
    .delete()
    .eq('project_id', projectId)
    .eq('type', 'path_d_project_notes')
  if (delResult.error) throw new Error(`project_notes delete: ${delResult.error.message}`)

  const row = {
    project_id: projectId,
    type: 'path_d_project_notes',
    format: 'markdown',
    metadata: {
      markdown,
      experiment_run_id: experimentRunId,
    },
  }
  const insResult = await admin.from('outputs').insert(row)
  if (insResult.error) throw new Error(`project_notes insert: ${insResult.error.message}`)
}
