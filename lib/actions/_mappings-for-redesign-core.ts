/**
 * Core data-assembly for the Phase 3 redesigned Mapping page.
 *
 * NOT a `'use server'` module. The server-action wrapper at
 * `lib/actions/mappings-for-redesign.ts` enforces auth via
 * `createClient()` then delegates to `getMappingsForRedesignCore` here.
 * Splitting the core out preserves direct-import testability:
 *
 *   • `assembleMappingsForRedesign(input)` — PURE function over raw
 *     Supabase row arrays, returns `MappingsForRedesignResult`. Lives
 *     in `lib/ai/mapping-engine.ts` after PR 1 of the engine carve-out.
 *     The translator unit tests drive it directly with in-memory
 *     fixtures (no DB). This mirrors the `_outputs-translators.ts`
 *     split.
 *
 *   • `getMappingsForRedesignCore(supabase, projectId)` — executes the
 *     4-round query plan from design §4.2 against the provided
 *     Supabase client, then delegates to `assembleMappingsForRedesign`.
 *     The integration test targets this function; production calls
 *     flow through `mappings-for-redesign.ts` → here.
 *
 * Both functions implement the contract locked at
 * `docs/features/phase-3-gap-4a-design.md` (commit 70e1ef5).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  assembleMappingsForRedesign,
  type RawDatasetRow,
  type RawFieldRow,
  type RawMappingSourceRow,
  type RawSourceAckRow,
  type RawTableRow,
  type RawTfmRow,
  type RawTransformationRow,
} from '@/lib/ai/mapping-engine'
import type { MappingsForRedesignResult } from '@/lib/types/mappings-for-redesign'

// ─── Full 4-round fetch + assembly ───────────────────────────────────

/**
 * Full Mapping-page read path for the Phase 3 redesign UI.
 *
 * Returns `null` on any failure to access the project (unauthenticated
 * via RLS, project missing, or project ID malformed) — callers fall
 * back to `notFound()`. All other errors propagate as thrown exceptions
 * the wrapping server action surfaces to the user.
 *
 * Uses the supplied Supabase client — typically a user-scoped
 * `createClient()` from `lib/supabase/server.ts` so RLS gates the read.
 * The integration test can pass `supabaseAdmin` to bypass RLS (it
 * filters by `projectId` explicitly, so the bypass is scope-safe).
 */
export async function getMappingsForRedesignCore(
  supabase: SupabaseClient,
  projectId: string,
): Promise<MappingsForRedesignResult | null> {
  // ── Round 1 — access gate ─────────────────────────────────────────
  const { data: projectRow } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .maybeSingle()
  if (!projectRow) return null

  // ── Round 2 — project-scoped parallel fetch ───────────────────────
  const [
    { data: datasetsRaw },
    { data: tfmsRaw },
    { data: sourceAcksRaw },
  ] = await Promise.all([
    supabase
      .from('datasets')
      .select('id, role, name')
      .eq('project_id', projectId),
    supabase
      .from('target_field_mappings')
      .select('id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql')
      .eq('project_id', projectId),
    supabase
      .from('source_field_acknowledgments')
      .select('id, source_field_id, reason')
      .eq('project_id', projectId),
  ])

  const datasets = (datasetsRaw ?? []) as RawDatasetRow[]
  const tfms = (tfmsRaw ?? []) as RawTfmRow[]
  const sourceAcks = (sourceAcksRaw ?? []) as RawSourceAckRow[]

  const datasetIds = datasets.map((d) => d.id)
  const tfmIds = tfms.map((t) => t.id)

  // ── Round 3 — dependent IN-list fetch (tables + mapping_sources) ──
  const [
    { data: tablesRaw },
    { data: mappingSourcesRaw },
  ] = await Promise.all([
    datasetIds.length > 0
      ? supabase
          .from('tables')
          .select('id, dataset_id, name')
          .in('dataset_id', datasetIds)
      : Promise.resolve({ data: [] as RawTableRow[] }),
    tfmIds.length > 0
      ? supabase
          .from('mapping_sources')
          .select('id, target_field_mapping_id, source_field_id, source_table_id, confidence, ai_reasoning, type_compatibility, join_spec, ordinal')
          .in('target_field_mapping_id', tfmIds)
          .order('ordinal', { ascending: true })
      : Promise.resolve({ data: [] as RawMappingSourceRow[] }),
  ])

  const tables = (tablesRaw ?? []) as RawTableRow[]
  const mappingSources = (mappingSourcesRaw ?? []) as RawMappingSourceRow[]

  const tableIds = tables.map((t) => t.id)

  // ── Round 4 — fields + transformations ───────────────────────────
  const [
    { data: fieldsRaw },
    { data: transformationsRaw },
  ] = await Promise.all([
    tableIds.length > 0
      ? supabase
          .from('fields')
          .select('id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, default_value, ordinal_position, field_profiles(field_id, sample_values)')
          .in('table_id', tableIds)
      : Promise.resolve({ data: [] as RawFieldRow[] }),
    tfmIds.length > 0
      ? supabase
          .from('transformations')
          .select('id, target_field_mapping_id, status, description, generated_sql')
          .in('target_field_mapping_id', tfmIds)
      : Promise.resolve({ data: [] as RawTransformationRow[] }),
  ])

  const fields = (fieldsRaw ?? []) as RawFieldRow[]
  const transformations = (transformationsRaw ?? []) as RawTransformationRow[]

  return assembleMappingsForRedesign({
    projectId,
    datasets,
    tables,
    fields,
    tfms,
    mappingSources,
    sourceAcks,
    transformations,
  })
}
