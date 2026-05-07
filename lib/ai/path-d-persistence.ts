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
 *   1. data_quality          — mints DQ UUIDs first
 *   2. mappings              — resolves data_quality_flag_indices → DQ UUIDs
 *   3. coverage              — references target_field_id (no TFM ID needed)
 *   4. lookup_tables         — independent
 *   5. inferred_targets      — independent
 *   6. decisions             — resolves applies_to.tfm_indices → TFM UUIDs
 *                              (mappings inserted first to mint TFM UUIDs)
 *   7. project_notes         — independent; upsert into outputs table
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

async function persistMappings(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: MappingPayload[],
  dqIds: string[],
): Promise<string[]> {
  if (data.length === 0) return []

  // Build TFM rows; resolve data_quality_flag_indices → dqIds[]
  const tfmRows = data.map((m) => {
    const dqUuids = m.data_quality_flag_indices
      .map((idx) => dqIds[idx])
      .filter((u): u is string => Boolean(u))
    return {
      project_id: projectId,
      target_field_id: m.target_field_id,
      ai_reasoning: m.ai_reasoning,
      transformation_intent: m.transformation_intent,
      mapping_cardinality: m.mapping_cardinality,
      dedup_required: m.dedup_required,
      dedup_strategy: m.dedup_strategy ?? null,
      data_quality_flag_ids: dqUuids,
      combination_type: m.combination_type,
      combination_sql: m.combination_sql ?? null,
      confidence: m.confidence ?? null,
      status: m.status,
      experiment_run_id: experimentRunId,
    }
  })

  // UPSERT by (project_id, target_field_id) — natural key from migration 074
  const upResult = await admin
    .from('target_field_mappings')
    .upsert(tfmRows, { onConflict: 'project_id,target_field_id' })
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

async function persistCoverage(
  admin: SupabaseClient,
  projectId: string,
  experimentRunId: string,
  data: CoveragePayload[],
): Promise<string[]> {
  if (data.length === 0) return []

  const rows = data.map((c) => ({
    project_id: projectId,
    target_field_id: c.target_field_id,
    coverage_status: c.coverage_status,
    ai_reasoning: c.ai_reasoning ?? null,
    default_value_recommendation: c.default_value_recommendation ?? null,
    experiment_run_id: experimentRunId,
  }))

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
  userId: string,
  experimentRunId: string,
  markdown: string,
): Promise<void> {
  // UPSERT into outputs by (project_id, type='path_d_project_notes')
  // The outputs table doesn't have a unique constraint on this combination,
  // so we DELETE+INSERT to maintain idempotency.
  const delResult = await admin
    .from('outputs')
    .delete()
    .eq('project_id', projectId)
    .eq('type', 'path_d_project_notes')
  if (delResult.error) throw new Error(`project_notes delete: ${delResult.error.message}`)

  const row = {
    project_id: projectId,
    type: 'path_d_project_notes',
    user_id: userId,
    metadata: {
      markdown,
      experiment_run_id: experimentRunId,
    },
  }
  const insResult = await admin.from('outputs').insert(row)
  if (insResult.error) throw new Error(`project_notes insert: ${insResult.error.message}`)
}
