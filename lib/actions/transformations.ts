'use server'

// ─────────────────────────────────────────────────────────────────────────────
// Transformations server actions (mapping redesign — Phase 2, Prompt 3b).
// ─────────────────────────────────────────────────────────────────────────────
//
// ID SEMANTICS — Option 2-narrow (Gate 2 decision)
//
//   The legacy UI still keys transform rows by `RichFieldMapping.id`, which
//   the shim may emit in two shapes:
//
//     - <tfmId>                    → primary / value-assignment TFM row
//     - <tfmId>::<mappingSourceId> → contributor row
//
//   Contributor rows do NOT own an independent transformation — a TFM carries
//   at most one transformation (see invariant below), and that transformation
//   describes the *target-field-level* SQL (primary + contributors combined).
//
//   `resolveTfmId(id)` is an internal helper that decodes either shape into a
//   bare TFM id. It is intentionally NOT exported: Option 2-narrow keeps shim
//   coupling contained to this module. `fk-cascade.ts` does not import the
//   shim at all — its callers supply bare TFM ids directly.
//
//   The public surface of this module therefore accepts EITHER shape on the
//   read/check paths (`checkFieldMappingHasTransform`, `getStagedPreviewForField`)
//   — contributor ids short-circuit to a "no transform on this row" response
//   — and requires bare TFM ids on write paths (`applyTransform`,
//   `resetFieldTransform`, etc.), which is how every current caller constructs
//   them.
//
// UNIQUE INVARIANT (not DB-enforced — see `lib/types/mapping-redesign.ts`)
//
//   COUNT(public.transformations) per `target_field_mapping_id` ≤ 1.
//
//   Every write path in this file relies on that invariant — we always query
//   the existing transformation via `.eq('target_field_mapping_id', …)` +
//   `.maybeSingle()`, then either UPDATE or INSERT. Migration 074 dropped
//   `transformations.field_mapping_id` in favor of `target_field_mapping_id`;
//   the constraint is soft (asserted via `tests/integration/transformations-
//   unique-invariant.test.ts` against production data rather than via a DB
//   UNIQUE index). A single DB-level duplicate would corrupt every per-field
//   read in this module — see the invariant test's header for the escalation
//   procedure if it ever fires.
//
// OUT-OF-SCOPE CALL SITES (expected to break at runtime until later prompts)
//
//   - `flagStagedRowIssues` from `@/lib/actions/staged-row-flags` — Prompt 3d.
//     Still queries legacy `field_mappings`. Call site preserved in
//     `applyTransform` inside a try/catch so the apply itself succeeds even
//     when the flagging pass fails.
//
// APPLY RPC WIRING (Gate 2 Q2 + Gate 2 G-a decisions)
//
//   - Mapped TFMs  → `dq_apply_field_transform_joined(tfmId, target_name, sql, NULL)`.
//     Single-source branch is live; cross-table (`p_join_spec != NULL`) is
//     stubbed in migration 074 until Phase 3.
//   - Value-assignment TFMs → legacy `dq_apply_field_transform(tm_id, src_tbl,
//     tgt_tbl, target_name, sql, has_staged)`. `dq_apply_field_transform_joined`
//     rejects zero-source TFMs, so we fall back to the legacy RPC; VA apply
//     iterates every TM whose `target_table_id` matches the VA's target field
//     (VAs are global per target table in the new model). A dedicated
//     `dq_apply_value_assignment` RPC is deferred to Prompt 3c.
//
// MAINTENANCE GUARD
//
//   Every write path threads its body through `guardWrites(projectId, …)`,
//   which calls `assertMappingWritesEnabled` and converts the sentinel throw
//   into a structured `{ success:false, errorCode:'MAINTENANCE_MODE' }`
//   response (same pattern as `lib/actions/mappings.ts`). Two exceptions:
//
//     - `dismissTransformNeeded` / `reinstateTransformNeeded` preserve
//       throw-on-error per Gate 2 Q4 (matches acknowledgeField precedent).
//     - `resetFieldTransform`, `resetAllTransformsForTable` are helpers
//       exclusively called from already-guarded write paths in
//       `lib/actions/mappings.ts` (per Gate 2); they do not re-assert the
//       guard. A comment at each function's header documents this.

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callClaude } from '@/lib/ai/claude'
import { extractTransformSQL } from '@/lib/ai/sql-extractor'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatFieldForPrompt, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { logActivity } from '@/lib/actions/activity-log'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { SHIMMED_ID_SEPARATOR } from '@/lib/compat/mapping-shim'
import { revalidatePath } from 'next/cache'
import type { Transformation } from '@/lib/types/database'
import type {
  TargetFieldMappingRow,
  TransformationRow,
  TransformationStatus,
} from '@/lib/types/mapping-redesign'

export { fieldNeedsTransform, wrapFieldRefsInJsonb }

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface FieldItem {
  /** Target field mapping id. The legacy field name is preserved for
   *  consumers (TransformContent.tsx) — the value is always a TFM UUID in
   *  the new model. */
  fieldMappingId: string
  sourceFieldId: string | null
  sourceFieldName: string | null
  sourceFieldDataType: string | null
  sourceFieldInferredType: string | null
  sourceFieldIsNullable: boolean
  targetFieldId: string
  targetFieldName: string
  targetFieldDataType: string
  targetFieldInferredType: string | null
  targetFieldIsNullable: boolean
  targetFieldIsPrimaryKey: boolean
  sourceTableId: string | null
  isValueAssignment: boolean
  typeCompatibility: string | null
  confidence: number | null
  /** AI-generated reasoning from the TFM (why this mapping was made) */
  aiReasoning: string | null
  /** Null rate for the source field (from field_profiles) */
  nullPercentage: number
  /** Count of format issues for the source field (from field_profiles) */
  formatIssuesCount: number
  sampleValues: unknown[]
  cardinality: number
  needsTransform: boolean
  transformation: Transformation | null
  /** Kept for API back-compatibility with TransformContent.tsx. Always
   *  `false` in the new model — contributor rows are folded into the
   *  primary FieldItem's `contributingSourceFields` and never emitted
   *  as their own FieldItem. */
  isContributing: boolean
  /** Additional source fields that contribute to the same target (for
   *  primary mappings only). Derived from `mapping_sources` rows with
   *  `ordinal > 0`. */
  contributingSourceFields: { id: string; name: string; data_type: string }[]
  /** Target field check constraint (for value assignments — helps guide value selection) */
  targetCheckConstraint?: { type: string; allowedValues?: string[]; pattern?: string; raw?: string } | null
}

export interface TableGroup {
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
  sourceTableName: string
  targetTableName: string
  fields: FieldItem[]
}

export interface DatasetGroup {
  datasetId: string
  datasetName: string
  tables: TableGroup[]
}

export interface UnmappedTargetField {
  id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key: boolean
  table_id: string
  table_name: string
  check_constraint: { type: string; allowedValues?: string[]; pattern?: string; raw?: string } | null
  /** Raw DEFAULT expression (migration 064). When set, a NOT NULL column
   *  is no longer "required" for mapping coverage — the DB auto-populates. */
  default_value: string | null
}

export interface TransformPageData {
  datasets: DatasetGroup[]
  schemaDocText: string
  hasMappings: boolean
  unmappedNotNullTargetFields: UnmappedTargetField[]
  unmappedNullableTargetFields: UnmappedTargetField[]
}

// ─── Guard wiring helper ─────────────────────────────────────────────────────
//
// Mirrors the pattern in `lib/actions/mappings.ts`. Converts the maintenance-
// mode sentinel throw from `assertMappingWritesEnabled` into a structured
// `{ success:false, errorCode:'MAINTENANCE_MODE' }` response so the UI can
// render a friendly message rather than a 500. Non-guard throws from `body`
// propagate unchanged.

const MAINTENANCE_GUARD_MESSAGE =
  'Mapping writes are temporarily disabled for scheduled maintenance'

export type TransformWriteErrorCode =
  | 'MAINTENANCE_MODE'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VALIDATION'
  | 'INTERNAL'

async function guardWrites<T extends { success: boolean; error?: string; errorCode?: TransformWriteErrorCode }>(
  projectId: string,
  body: () => Promise<T>,
): Promise<T> {
  try {
    await assertMappingWritesEnabled(projectId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === MAINTENANCE_GUARD_MESSAGE) {
      return {
        success: false,
        error: MAINTENANCE_GUARD_MESSAGE,
        errorCode: 'MAINTENANCE_MODE',
      } as T
    }
    return {
      success: false,
      error: message,
      errorCode: 'NOT_FOUND',
    } as T
  }
  return body()
}

// ─── ID resolution (Option 2-narrow — internal only) ─────────────────────────

type ResolvedTfmId =
  | { kind: 'primary'; tfmId: string }
  | { kind: 'contributor'; tfmId: string; mappingSourceId: string }
  | { kind: 'unknown' }

/**
 * Decode a caller-supplied `fieldMappingId` into a bare TFM id.
 *
 * Accepts:
 *   - bare UUID (`tfmId`) — a primary / VA TFM row
 *   - composite `tfmId::mappingSourceId` — a contributor row emitted by
 *     the shim. Contributors do not own an independent transformation, so
 *     write-path callers of `resolveTfmId` should short-circuit when they
 *     see `kind === 'contributor'`. Read-path callers may follow the
 *     `tfmId` to the owning TFM (same transformation row).
 *
 * Other shapes (ack ids, empty strings, non-UUID plain strings) return
 * `{ kind: 'unknown' }` and log a warning under the `[transformations]`
 * namespace per P2.
 */
function resolveTfmId(id: string): ResolvedTfmId {
  if (typeof id !== 'string' || id.length === 0) {
    console.warn('[transformations] resolveTfmId: empty input')
    return { kind: 'unknown' }
  }

  const parts = id.split(SHIMMED_ID_SEPARATOR)
  const UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (parts.length === 1) {
    if (UUID_REGEX.test(parts[0])) {
      return { kind: 'primary', tfmId: parts[0] }
    }
    console.warn('[transformations] resolveTfmId: unrecognized id format', { id })
    return { kind: 'unknown' }
  }

  if (parts.length === 2 && UUID_REGEX.test(parts[0]) && UUID_REGEX.test(parts[1])) {
    return { kind: 'contributor', tfmId: parts[0], mappingSourceId: parts[1] }
  }

  console.warn('[transformations] resolveTfmId: unrecognized id format', { id })
  return { kind: 'unknown' }
}

// ─── toLegacyTransformation ──────────────────────────────────────────────────
//
// Adapter that converts a new-model `TransformationRow` into the legacy
// `Transformation` shape still imported by out-of-scope consumers (outputs.ts,
// execution-package.ts, migration-intelligence.ts, …). The `field_mapping_id`
// field on `Transformation` is populated with the TFM id — consumers that
// still read `.field_mapping_id` will see the TFM id, which is semantically
// the correct replacement for the dropped legacy column.
//
// The legacy type (`@/lib/types/database`) is kept unchanged so the 10+
// out-of-scope files that project through `.field_mapping_id` continue to
// type-check. Prompt 3c/3d will rewrite those callers against
// `target_field_mapping_id` directly and the legacy type will be retired
// alongside the shim (spec §Cleanup items).
//
// TODO(prompt-3d): DELETE THIS ADAPTER and the legacy `Transformation`
// interface in `lib/types/database.ts` in the same commit that closes
// out Prompt 3d. Downstream consumers should read
// `transformations.target_field_mapping_id` directly to match the actual
// DB column name. Leaving the "field_mapping_id-but-actually-TFM-id"
// semantic shim in place past Phase 2 is a maintenance liability —
// future readers will write code that depends on the wrong identity
// semantics. See `docs/prompt-3a-remaining-work.md` §Known caveats #3.

function toLegacyTransformation(row: TransformationRow): Transformation {
  return {
    id: row.id,
    field_mapping_id: row.target_field_mapping_id,
    description: row.description,
    generated_sql: row.generated_sql,
    is_ai_generated: row.is_ai_generated,
    test_results: row.test_results,
    status: row.status,
    created_at: row.created_at,
  }
}

// ─── TFM context resolver (shared across write paths) ────────────────────────
//
// Every write path needs the same basic context: the TFM row, its project,
// its target field (+ table), and — for mapped TFMs — the primary source
// field (+ table) plus the linking table_mapping. This helper does the query
// once so individual write paths stay focused on their own logic.
//
// Returns `null` when the TFM does not exist (caller translates to NOT_FOUND).
// Throws on structural invariant violations (e.g. mapped TFM with no
// mapping_sources at all) — those indicate data corruption and should abort
// the request rather than silently malfunctioning.

interface ContextField {
  id: string
  name: string
  table_id: string
  data_type: string
}

interface TfmContext {
  tfm: TargetFieldMappingRow
  projectId: string
  targetField: { id: string; name: string; table_id: string }
  targetTable: { id: string; name: string }
  /** Primary source (ordinal=0). NULL for VAs. */
  primarySource: {
    mappingSourceId: string
    sourceFieldId: string
    sourceField: ContextField | null
    sourceTableId: string
  } | null
  /** Contributor sources (ordinal > 0), ordered by ordinal. */
  contributors: Array<{
    mappingSourceId: string
    sourceFieldId: string
    sourceField: ContextField | null
    ordinal: number
  }>
  /** Resolved table_mapping linking primary source table → target table.
   *  NULL for VAs. */
  tableMapping: {
    id: string
    source_table_id: string
    target_table_id: string
  } | null
}

async function loadTfmContext(tfmId: string): Promise<TfmContext | null> {
  const { data: tfm } = await supabaseAdmin
    .from('target_field_mappings')
    .select('*')
    .eq('id', tfmId)
    .maybeSingle<TargetFieldMappingRow>()

  if (!tfm) return null

  const { data: targetField } = await supabaseAdmin
    .from('fields')
    .select('id, name, table_id')
    .eq('id', tfm.target_field_id)
    .single<{ id: string; name: string; table_id: string }>()

  if (!targetField) return null

  const { data: targetTable } = await supabaseAdmin
    .from('tables')
    .select('id, name')
    .eq('id', targetField.table_id)
    .single<{ id: string; name: string }>()

  if (!targetTable) return null

  const { data: sources } = await supabaseAdmin
    .from('mapping_sources')
    .select('id, source_field_id, source_table_id, ordinal')
    .eq('target_field_mapping_id', tfmId)
    .order('ordinal', { ascending: true })

  const sourceFieldIds = (sources ?? [])
    .map((s) => s.source_field_id)
    .filter((x): x is string => x != null)

  const sourceFieldById = new Map<string, ContextField>()

  if (sourceFieldIds.length > 0) {
    const { data: srcFields } = await supabaseAdmin
      .from('fields')
      .select('id, name, table_id, data_type')
      .in('id', sourceFieldIds)

    for (const f of (srcFields ?? []) as ContextField[]) {
      sourceFieldById.set(f.id, f)
    }
  }

  const primaryRow = (sources ?? []).find((s) => s.ordinal === 0) ?? null
  const contributorRows = (sources ?? []).filter((s) => s.ordinal > 0)

  const primarySource = primaryRow
    ? {
        mappingSourceId: primaryRow.id as string,
        sourceFieldId: (primaryRow.source_field_id ?? '') as string,
        sourceField: primaryRow.source_field_id
          ? sourceFieldById.get(primaryRow.source_field_id) ?? null
          : null,
        sourceTableId: (primaryRow.source_table_id ?? '') as string,
      }
    : null

  const contributors = contributorRows.map((r) => ({
    mappingSourceId: r.id as string,
    sourceFieldId: (r.source_field_id ?? '') as string,
    sourceField: r.source_field_id
      ? sourceFieldById.get(r.source_field_id) ?? null
      : null,
    ordinal: r.ordinal as number,
  }))

  // Resolve table_mapping for mapped TFMs. Mapped = at least one source.
  let tableMapping: TfmContext['tableMapping'] = null
  if (primarySource && primarySource.sourceTableId) {
    const { data: tm } = await supabaseAdmin
      .from('table_mappings')
      .select('id, source_table_id, target_table_id')
      .eq('project_id', tfm.project_id)
      .eq('source_table_id', primarySource.sourceTableId)
      .eq('target_table_id', targetField.table_id)
      .maybeSingle<{ id: string; source_table_id: string; target_table_id: string }>()
    tableMapping = tm ?? null
  }

  return {
    tfm,
    projectId: tfm.project_id,
    targetField,
    targetTable,
    primarySource,
    contributors,
    tableMapping,
  }
}

// ─── getTransformData ─────────────────────────────────────────────────────────
//
// Read path — renders the Transform tab's dataset → table → field tree.
//
// Semantic parity with the legacy implementation:
//   - Each TFM surfaces as ONE FieldItem under the TableGroup that hosts its
//     primary source table (or — for value assignments — under the first TM
//     whose target_table matches the VA's target_field.table_id; VAs are
//     global per target table in the new model).
//   - Contributor mapping_sources are folded into the primary FieldItem's
//     `contributingSourceFields` list. The UI already hides contributors from
//     the transform tree (legacy `isContributing=true` filter); we achieve the
//     same effect by never emitting contributor rows at all.
//   - `FieldItem.isContributing` stays `false` everywhere for API stability.
//   - `needsTransform` is computed via `fieldNeedsTransform` — the heuristic
//     is unchanged; its `needsTransformation` input now comes from the new
//     `target_field_mappings.needs_transformation` column (migration 075).

export async function getTransformData(
  projectId: string,
): Promise<TransformPageData> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const empty: TransformPageData = {
    datasets: [],
    schemaDocText: '',
    hasMappings: false,
    unmappedNotNullTargetFields: [],
    unmappedNullableTargetFields: [],
  }
  if (!user) return empty

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return empty

  // ── 1. Table mappings (non-rejected) ───────────────────────────────────────
  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tms || tms.length === 0) return empty

  const allTableIds = Array.from(
    new Set([
      ...tms.map((tm) => tm.source_table_id),
      ...tms.map((tm) => tm.target_table_id),
    ]),
  )

  // ── 2. Tables + target_field_mappings + mapping_sources + transformations ─
  const [tablesRes, tfmsRes, msRes] = await Promise.all([
    supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name, role)')
      .in('id', allTableIds),
    supabase
      .from('target_field_mappings')
      .select('*')
      .eq('project_id', projectId)
      .neq('status', 'rejected')
      .eq('is_acknowledged', false)
      .returns<TargetFieldMappingRow[]>(),
    // A deliberate two-step join: mapping_sources → TFMs → project. We pre-
    // filtered TFMs by project/status above, so scoping MS by the resulting
    // tfmIds below is cheaper and clearer than an inline join.
    Promise.resolve(null),
  ])

  const tables = tablesRes.data ?? []
  const tfms = (tfmsRes.data ?? []) as TargetFieldMappingRow[]
  void msRes

  if (tfms.length === 0) {
    // No TFMs means no mappings for this project. `hasMappings: true` stays
    // because table_mappings exist — the UI distinguishes between
    // "approve mappings first" and "no tables paired" states.
    return { ...empty, hasMappings: true }
  }

  const tfmIds = tfms.map((t) => t.id)

  const { data: sources } = await supabase
    .from('mapping_sources')
    .select('id, target_field_mapping_id, source_field_id, source_table_id, ordinal, type_compatibility, confidence')
    .in('target_field_mapping_id', tfmIds)
    .order('ordinal', { ascending: true })

  const allSourceFieldIds = Array.from(
    new Set(
      (sources ?? [])
        .map((s) => s.source_field_id)
        .filter((x): x is string => x != null),
    ),
  )
  const allTargetFieldIds = Array.from(new Set(tfms.map((t) => t.target_field_id)))

  // ── 3. Fields, profiles, transformations ───────────────────────────────────
  const [
    { data: sourceFields },
    { data: targetFields },
    { data: fieldProfiles },
    { data: transformations },
  ] = await Promise.all([
    allSourceFieldIds.length > 0
      ? supabase
          .from('fields')
          .select('id, name, data_type, inferred_type, is_nullable, table_id, ordinal_position')
          .in('id', allSourceFieldIds)
          .order('ordinal_position', { ascending: true })
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; data_type: string; inferred_type: string | null; is_nullable: boolean; table_id: string; ordinal_position: number }>, error: null }),
    supabase
      .from('fields')
      .select('id, name, data_type, inferred_type, is_nullable, is_primary_key, check_constraint, table_id')
      .in('id', allTargetFieldIds),
    allSourceFieldIds.length > 0
      ? supabase
          .from('field_profiles')
          .select('field_id, sample_values, cardinality, null_percentage, format_issues_count')
          .in('field_id', allSourceFieldIds)
      : Promise.resolve({ data: [] as Array<{ field_id: string; sample_values: string[] | null; cardinality: number | null; null_percentage: number | null; format_issues_count: number | null }>, error: null }),
    supabase
      .from('transformations')
      .select('*')
      .in('target_field_mapping_id', tfmIds)
      .returns<TransformationRow[]>(),
  ])

  // ── 4. Schema documents for context ────────────────────────────────────────
  const allDatasetIds = Array.from(
    new Set(tables.map((t) => t.dataset_id)),
  )
  const { data: schemaDocs } = await supabase
    .from('schema_documents')
    .select('extracted_text')
    .in('dataset_id', allDatasetIds)
    .not('extracted_text', 'is', null)

  const schemaDocText = schemaDocs
    ?.map((d) => d.extracted_text ?? '')
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000) ?? ''

  // ── Index lookups ──────────────────────────────────────────────────────────
  const tableById = new Map(tables.map((t) => [t.id, t]))
  const srcFieldById = new Map((sourceFields ?? []).map((f) => [f.id, f]))
  const tgtFieldById = new Map((targetFields ?? []).map((f) => [f.id, f]))
  const profileByFieldId = new Map(
    (fieldProfiles ?? []).map((p) => [p.field_id, p]),
  )
  const transformByTfmId = new Map<string, TransformationRow>()
  for (const tr of (transformations ?? []) as TransformationRow[]) {
    transformByTfmId.set(tr.target_field_mapping_id, tr)
  }

  // ── Index sources per TFM ──────────────────────────────────────────────────
  interface IndexedSource {
    mappingSourceId: string
    sourceFieldId: string | null
    sourceTableId: string | null
    ordinal: number
    typeCompatibility: string | null
    confidence: number | null
  }
  const sourcesByTfmId = new Map<string, IndexedSource[]>()
  for (const s of sources ?? []) {
    const list = sourcesByTfmId.get(s.target_field_mapping_id) ?? []
    list.push({
      mappingSourceId: s.id as string,
      sourceFieldId: (s.source_field_id ?? null) as string | null,
      sourceTableId: (s.source_table_id ?? null) as string | null,
      ordinal: s.ordinal as number,
      typeCompatibility: (s.type_compatibility ?? null) as string | null,
      confidence: (s.confidence ?? null) as number | null,
    })
    sourcesByTfmId.set(s.target_field_mapping_id, list)
  }

  // ── TFM routing: which TableGroup does each TFM render under? ─────────────
  //
  // Mapped TFM: the TM whose (source_table_id, target_table_id) matches the
  // TFM's primary source_table_id and the target field's table_id.
  //
  // VA TFM: the FIRST TM (in `tms` order) whose target_table_id matches the
  // VA's target field's table_id. This mirrors legacy behaviour where a VA
  // row surfaced under exactly one TableGroup (legacy `fm.table_mapping_id`).
  // `applyTransform` / `revertTransform` loop every matching TM when the
  // staged-data work happens — the routing here is purely for tree display.

  const tmById = new Map(tms.map((tm) => [tm.id, tm]))
  const firstTmByTargetTable = new Map<string, string>()
  for (const tm of tms) {
    if (!firstTmByTargetTable.has(tm.target_table_id)) {
      firstTmByTargetTable.set(tm.target_table_id, tm.id)
    }
  }

  function routeTfmToTm(
    tfm: TargetFieldMappingRow,
    tgtField: { table_id: string },
    primary: IndexedSource | undefined,
  ): string | null {
    if (primary && primary.sourceTableId) {
      for (const tm of tms ?? []) {
        if (tm.source_table_id === primary.sourceTableId && tm.target_table_id === tgtField.table_id) {
          return tm.id
        }
      }
      return null
    }
    return firstTmByTargetTable.get(tgtField.table_id) ?? null
  }

  // ── Build per-TM field lists ──────────────────────────────────────────────
  const fieldsByTmId = new Map<string, FieldItem[]>()

  for (const tfm of tfms) {
    const tgtField = tgtFieldById.get(tfm.target_field_id)
    if (!tgtField) continue

    const tfmSources = sourcesByTfmId.get(tfm.id) ?? []
    const primary = tfmSources.find((s) => s.ordinal === 0)
    const contributors = tfmSources.filter((s) => s.ordinal > 0)

    const tmId = routeTfmToTm(tfm, tgtField, primary)
    if (!tmId) continue

    const isValueAssignment = primary == null
    const srcField = primary?.sourceFieldId
      ? srcFieldById.get(primary.sourceFieldId) ?? null
      : null

    // Skip mapped TFMs with a stray source_field_id that failed to hydrate —
    // matches legacy "skip if source lookup failed" guard.
    if (!isValueAssignment && !srcField) continue

    const profile = primary?.sourceFieldId
      ? profileByFieldId.get(primary.sourceFieldId)
      : null
    const transformationRow = transformByTfmId.get(tfm.id) ?? null
    const transformation = transformationRow
      ? toLegacyTransformation(transformationRow)
      : null

    const needsTransform = isValueAssignment
      ? true
      : fieldNeedsTransform({
          typeCompatibility: primary?.typeCompatibility ?? null,
          confidence: primary?.confidence ?? tfm.confidence,
          sourceDataType: srcField!.data_type,
          targetDataType: tgtField.data_type,
          sourceFieldName: srcField!.name,
          targetFieldName: tgtField.name,
          hasTransformation: transformation !== null,
          needsTransformation: tfm.needs_transformation,
        })

    const contributingSourceFields: { id: string; name: string; data_type: string }[] = []
    for (const c of contributors) {
      if (!c.sourceFieldId) continue
      const cf = srcFieldById.get(c.sourceFieldId)
      if (!cf) continue
      contributingSourceFields.push({ id: cf.id, name: cf.name, data_type: cf.data_type })
    }

    const item: FieldItem = {
      fieldMappingId: tfm.id,
      sourceFieldId: srcField?.id ?? null,
      sourceFieldName: srcField?.name ?? null,
      sourceFieldDataType: srcField?.data_type ?? null,
      sourceFieldInferredType: srcField?.inferred_type ?? null,
      sourceFieldIsNullable: srcField?.is_nullable ?? true,
      targetFieldId: tgtField.id,
      targetFieldName: tgtField.name,
      targetFieldDataType: tgtField.data_type,
      targetFieldInferredType: tgtField.inferred_type,
      targetFieldIsNullable: tgtField.is_nullable,
      targetFieldIsPrimaryKey: !!(tgtField as typeof tgtField & { is_primary_key?: boolean }).is_primary_key,
      sourceTableId: srcField?.table_id ?? null,
      isValueAssignment,
      typeCompatibility: primary?.typeCompatibility ?? null,
      confidence: primary?.confidence ?? tfm.confidence,
      aiReasoning: tfm.ai_reasoning,
      nullPercentage: (profile as typeof profile & { null_percentage?: number } | undefined)?.null_percentage ?? 0,
      formatIssuesCount: (profile as typeof profile & { format_issues_count?: number } | undefined)?.format_issues_count ?? 0,
      sampleValues: (profile?.sample_values as unknown[]) ?? [],
      cardinality: profile?.cardinality ?? 0,
      needsTransform,
      transformation,
      isContributing: false,
      contributingSourceFields,
      targetCheckConstraint: isValueAssignment
        ? ((tgtField as typeof tgtField & { check_constraint?: unknown }).check_constraint as FieldItem['targetCheckConstraint'] ?? null)
        : null,
    }

    const list = fieldsByTmId.get(tmId) ?? []
    list.push(item)
    fieldsByTmId.set(tmId, list)
  }

  // ── Assemble DatasetGroup[] ───────────────────────────────────────────────
  const datasetGroupMap = new Map<string, DatasetGroup>()

  for (const tm of tms) {
    const fields = fieldsByTmId.get(tm.id)
    if (!fields || fields.length === 0) continue

    const srcTable = tableById.get(tm.source_table_id)
    const tgtTable = tableById.get(tm.target_table_id)
    if (!srcTable || !tgtTable) continue

    const dataset = srcTable.datasets as unknown as { id: string; name: string; role: string } | null
    if (!dataset) continue
    if (dataset.role !== 'source') continue

    let dsGroup = datasetGroupMap.get(dataset.id)
    if (!dsGroup) {
      dsGroup = { datasetId: dataset.id, datasetName: dataset.name, tables: [] }
      datasetGroupMap.set(dataset.id, dsGroup)
    }

    fields.sort((a, b) => {
      if (a.isValueAssignment && !b.isValueAssignment) return 1
      if (!a.isValueAssignment && b.isValueAssignment) return -1
      if (a.isValueAssignment && b.isValueAssignment) {
        return a.targetFieldName.localeCompare(b.targetFieldName)
      }
      const sfA = a.sourceFieldId ? (srcFieldById.get(a.sourceFieldId) as { ordinal_position?: number } | undefined) : undefined
      const sfB = b.sourceFieldId ? (srcFieldById.get(b.sourceFieldId) as { ordinal_position?: number } | undefined) : undefined
      return (sfA?.ordinal_position ?? 9999) - (sfB?.ordinal_position ?? 9999)
    })

    dsGroup.tables.push({
      tableMappingId: tm.id,
      sourceTableId: tm.source_table_id,
      targetTableId: tm.target_table_id,
      sourceTableName: srcTable.name,
      targetTableName: tgtTable.name,
      fields,
    })
  }

  void tmById // reserved for future per-TM lookups; keeps the map live.

  // ── Compute unmapped target fields ────────────────────────────────────────
  const allTargetTableIds = Array.from(new Set(tms.map((tm) => tm.target_table_id)))
  const { data: allTgtFieldRows } = await supabase
    .from('fields')
    .select('id, name, data_type, is_nullable, is_primary_key, table_id, check_constraint, default_value')
    .in('table_id', allTargetTableIds.length > 0 ? allTargetTableIds : ['__none__'])
    .order('ordinal_position', { ascending: true })

  // "Mapped" = a non-rejected, non-acknowledged TFM exists for this target
  // field. Already filtered in the tfms query above.
  const mappedTargetFieldIds = new Set(tfms.map((t) => t.target_field_id))

  const tgtTableNameById = new Map(
    tables.filter((t) => allTargetTableIds.includes(t.id)).map((t) => [t.id, t.name]),
  )

  const allUnmapped = (allTgtFieldRows ?? []).filter((f) => !mappedTargetFieldIds.has(f.id))
  const toUnmapped = (f: typeof allUnmapped[number]): UnmappedTargetField => ({
    id: f.id,
    name: f.name,
    data_type: f.data_type,
    is_nullable: f.is_nullable,
    is_primary_key: f.is_primary_key ?? false,
    table_id: f.table_id,
    table_name: tgtTableNameById.get(f.table_id) ?? '',
    check_constraint: f.check_constraint as UnmappedTargetField['check_constraint'],
    default_value: (f as { default_value?: string | null }).default_value ?? null,
  })

  // A column with a DEFAULT expression (migration 064) auto-populates on
  // INSERT even when unmapped, so it does NOT belong in the "blocking"
  // NOT-NULL bucket that the transform page uses to gate readiness.
  const hasDefault = (f: typeof allUnmapped[number]) => {
    const dv = (f as { default_value?: string | null }).default_value
    return dv != null && String(dv).length > 0
  }
  const unmappedNotNullTargetFields = allUnmapped
    .filter((f) => !f.is_nullable && !hasDefault(f))
    .map(toUnmapped)
  const unmappedNullableTargetFields = allUnmapped
    .filter((f) => f.is_nullable || hasDefault(f))
    .map(toUnmapped)

  return {
    datasets: [...datasetGroupMap.values()],
    schemaDocText,
    hasMappings: true,
    unmappedNotNullTargetFields,
    unmappedNullableTargetFields,
  }
}

// ─── Claude system prompt ─────────────────────────────────────────────────────

const TRANSFORM_SYSTEM_PROMPT = `You are a SQL transformation expert for enterprise data migrations.
Given a source field, target field, their schemas, sample data, and a natural language description of the desired transformation, generate the SQL transformation expression.

CRITICAL RULES:
1. Output ONLY the SQL expression (CASE statement, function call, type cast, string operation, etc.)
2. Do NOT output a full SELECT, UPDATE, or INSERT statement
3. Do NOT include semicolons
4. Do NOT include column aliases (no AS clause at the top level)
5. The expression will be embedded inside: SELECT {your_expression} AS "target_field" FROM ...
6. Use ONLY the bare field name without any table prefix — write "Region", NOT "Sales.Region"; write "Type", NOT "Account.Type". The system handles table context automatically.
7. Handle NULL values explicitly when relevant using COALESCE or CASE WHEN ... IS NULL
8. Handle edge cases (unexpected values) with an ELSE clause in CASE statements
9. Be precise — map actual sample values from the data, not generic patterns
10. Do NOT use window functions (ROW_NUMBER, RANK, etc.) — they are not allowed in expressions
11. LPAD / RPAD require TEXT as their first argument. ALWAYS cast numeric/integer/bigint expressions
    to text before passing to LPAD or RPAD:
    CORRECT: LPAD(some_number::text, 7, '0')
    WRONG:   LPAD(some_number, 7, '0')  ← crashes with "function lpad(bigint, integer, unknown) does not exist"
    This applies to row_number, any integer column, ROW_NUMBER() results, etc.

Common transformation patterns:
- Value mapping: CASE WHEN field = 'X' THEN 'Y' WHEN field = 'Z' THEN 'W' ELSE 'OTHER' END
- Type casting: field::integer, field::numeric (avoid bare ::date — use TO_DATE with explicit format instead)
- String operations: UPPER(field), LOWER(field), TRIM(field), LEFT(field, 10)
- Concatenation: field1 || '-' || field2
- Null handling: COALESCE(field, 'default')
- Substring: SUBSTRING(field FROM 1 FOR 10)
- Regex replace: REGEXP_REPLACE(field, 'pattern', 'replacement')
- Hash: MD5(field)
- Truncation: LEFT(field, 10) or SUBSTRING(field FROM 1 FOR 10)

DATE FORMATTING — CRITICAL RULES:
NEVER use bare ::date casts or TO_CHAR(field::date, ...) — these fail when data contains mixed formats.
NEVER call TO_DATE(field, 'MM/DD/YYYY') on data that may contain DD/MM/YYYY values — month=22 will crash.
ALWAYS use a CASE + regex approach that detects the format before parsing.
Each WHEN branch must target ONE specific format with its own separator and format string.
NEVER nest a CASE expression inside a SPLIT_PART argument — use separate WHEN branches instead.

Example template (adapt branches to actual sample data, remove unused branches):

  CASE
    WHEN field IS NULL OR TRIM(field) = '' THEN NULL
    -- Already ISO 8601 (YYYY-MM-DD) — pass through
    WHEN field ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN SUBSTRING(field FROM 1 FOR 10)
    -- YYYY/MM/DD
    WHEN field ~ '^[0-9]{4}/[0-9]' THEN TO_CHAR(TO_DATE(field, 'YYYY/MM/DD'), 'YYYY-MM-DD')
    -- Slash 4-digit year: first part > 12 → DD/MM/YYYY (e.g. 22/11/2025)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' AND SPLIT_PART(field, '/', 1)::int > 12 THEN TO_CHAR(TO_DATE(field, 'DD/MM/YYYY'), 'YYYY-MM-DD')
    -- Slash 4-digit year: first part <= 12 → MM/DD/YYYY (e.g. 03/06/2027)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$' THEN TO_CHAR(TO_DATE(field, 'MM/DD/YYYY'), 'YYYY-MM-DD')
    -- Slash 2-digit year → MM/DD/YY (e.g. 08/15/22)
    WHEN field ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{2}$' THEN TO_CHAR(TO_DATE(field, 'MM/DD/YY'), 'YYYY-MM-DD')
    -- Dash 4-digit year: first part > 12 → DD-MM-YYYY (e.g. 13-09-2026)
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' AND SPLIT_PART(field, '-', 1)::int > 12 THEN TO_CHAR(TO_DATE(field, 'DD-MM-YYYY'), 'YYYY-MM-DD')
    -- Dash 4-digit year: first part <= 12 → MM-DD-YYYY (e.g. 05-31-2026)
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}$' THEN TO_CHAR(TO_DATE(field, 'MM-DD-YYYY'), 'YYYY-MM-DD')
    -- Dash 2-digit year → MM-DD-YY
    WHEN field ~ '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{2}$' THEN TO_CHAR(TO_DATE(field, 'MM-DD-YY'), 'YYYY-MM-DD')
    -- Month name (Mar 15 2024, 15 March 2024, March 15 2024)
    WHEN field ~* '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)' THEN TO_CHAR((field)::date, 'YYYY-MM-DD')
    ELSE NULL
  END

Rules:
- Include only WHEN branches for formats actually observed in the sample data. Remove unused branches.
- Always keep the ISO passthrough branch and ELSE NULL.
- Never mix separators in a single TO_DATE call — use separate WHEN branches.
- The SPLIT_PART "first part > 12" check disambiguates DD/MM from MM/DD without nested CASEs.

If documentation is provided, follow the exact value mappings and transformation rules specified in the business rules. Do not invent mappings that contradict the documentation. If the documentation specifies edge cases or special handling, include them in the expression.

CRITICAL — USER INSTRUCTION FAITHFULNESS:
The user's natural language description is the AUTHORITATIVE specification for this transformation. Follow it exactly.
- If the user specifies explicit value mappings and a default/catch-all (e.g., "all others=X" or "everything else=X"), generate ONLY the mappings they listed. All values not explicitly mapped MUST go to the catch-all via ELSE. Do NOT invent additional mappings for values you see in the data.
- If the user specifies a general rule (e.g., "convert to uppercase", "strip $ and commas"), apply that rule uniformly — do not add case-by-case logic unless the user asked for it.
- If the user's instruction is ambiguous or incomplete, prefer a simpler interpretation that matches their words over a more "complete" one that adds logic they didn't request.
- The value distribution and sample data are provided so you can write CORRECT SQL (proper quoting, case handling, edge cases) — NOT so you can expand the user's specification with additional mappings.
- It is ALWAYS better to under-engineer (strict adherence to user's words + ELSE catch-all) than to over-engineer (inventing mappings the user didn't ask for).

ITERATIVE REFINEMENT (when <existing_sql> is provided):
- A previous SQL expression was already generated for this field mapping
- The user updated their description and wants the SQL modified, not rewritten from scratch
- Preserve the CASE WHEN structure, variable naming, null handling, and overall approach
- Only modify the specific parts that the new description requires
- Keep existing edge case handling (null checks, TRIM, type casting) even if the new description doesn't mention them — they were added for a reason
- If the new description fundamentally changes the transformation approach, you may rewrite entirely
- If no <existing_sql> block is present, generate from scratch as usual

NULL HANDLING:
Always preserve NULL and empty values unless the user explicitly instructs you to convert them. When generating CASE expressions or any conditional logic, add a NULL/empty guard as the FIRST condition:
  CASE
    WHEN field_name IS NULL OR TRIM(field_name::text) = '' THEN NULL
    WHEN ... (user's specified logic)
    ELSE ...
  END
This ensures that NULL source values do not accidentally map to a default/catch-all value. "All others" or "everything else" in the user's description means "all other NON-NULL, NON-EMPTY values" unless they explicitly say otherwise (e.g., "including nulls" or "map nulls to X"). Apply this NULL guard to ALL conditional expressions (CASE, COALESCE chains, IIF, etc.) unless the user's instruction explicitly handles nulls differently.`

// ─── wrapWithNullGuard ────────────────────────────────────────────────────────
//
// Deterministically ensures NULL/empty source values are preserved as NULL in
// the generated SQL regardless of what Claude produced.
//
//   - If Claude already included a NULL guard for the source field → return as-is
//   - If the SQL is a CASE expression → prepend a NULL WHEN as the first clause
//   - Otherwise → wrap the whole expression in a NULL-safe CASE/ELSE

function wrapWithNullGuard(sql: string, sourceFieldName: string): string {
  const trimmed = sql.trim()
  const escapedName = sourceFieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const hasNullGuard = new RegExp(
    `WHEN\\s+["']?${escapedName}["']?\\s+IS\\s+NULL|WHEN\\s+TRIM\\s*\\(\\s*["']?${escapedName}["']?`,
    'i',
  ).test(trimmed)
  if (hasNullGuard) return trimmed

  const nullWhen = `WHEN "${sourceFieldName}" IS NULL OR TRIM("${sourceFieldName}"::text) = '' THEN NULL`

  if (/^\s*CASE\b/i.test(trimmed)) {
    return trimmed.replace(/^(\s*CASE\b)/i, `$1\n  ${nullWhen}`)
  }

  return `CASE\n  ${nullWhen}\n  ELSE ${trimmed}\nEND`
}

// ─── generateTransform ────────────────────────────────────────────────────────

export async function generateTransform(
  fieldMappingId: string,
  description: string,
  existingSQL?: string | null,
): Promise<{ success: boolean; sql?: string; transformationId?: string; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  if (!description.trim()) return { success: false, error: 'Description is required' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    // Contributor rows don't own an independent transformation; unknown ids
    // are a caller bug. Both surface as a friendly "not found" — matches
    // legacy behavior when fm lookup failed.
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const isValueAssignment = ctx.primarySource == null
  if (!isValueAssignment && !ctx.primarySource?.sourceField) {
    return { success: false, error: 'Source field not found' }
  }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const tgtField = ctx.targetField
  const { data: tgtFieldFull } = await supabase
    .from('fields')
    .select('id, name, data_type, inferred_type, is_nullable, check_constraint')
    .eq('id', tgtField.id)
    .single()
  if (!tgtFieldFull) return { success: false, error: 'Target field not found' }

  const tgtCheckConstraint = (tgtFieldFull as typeof tgtFieldFull & { check_constraint?: unknown })
    .check_constraint as
      | { type: string; allowedValues?: string[]; pattern?: string; min?: number; max?: number; raw?: string }
      | null
      | undefined

  const srcField = ctx.primarySource?.sourceField ?? null
  const contributingSources = ctx.contributors
    .map((c) => c.sourceField)
    .filter((x): x is ContextField => x != null)

  // Resolve tables for prompt rendering. For mapped TFMs we use the resolved
  // table_mapping; for VAs we use the first TM whose target_table matches.
  let srcTableName = ''
  let srcTableId: string | null = null
  let tgtTableId: string = tgtField.table_id
  if (ctx.tableMapping) {
    const { data: srcTable } = await supabase
      .from('tables')
      .select('id, name, datasets(id, name)')
      .eq('id', ctx.tableMapping.source_table_id)
      .single()
    srcTableName = srcTable?.name ?? ''
    srcTableId = ctx.tableMapping.source_table_id
    tgtTableId = ctx.tableMapping.target_table_id
  } else if (isValueAssignment) {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('id, source_table_id, target_table_id, tables:tables!table_mappings_source_table_id_fkey(id, name)')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', tgtField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    if (anyTm) {
      srcTableId = anyTm.source_table_id as string
      const srcTblObj = anyTm.tables as unknown as { id: string; name: string } | null
      srcTableName = srcTblObj?.name ?? ''
    }
  }

  // Build rich AI context. When the primary is a VA, we still pass the target
  // field so the prompt can surface target constraints / distributions.
  const allSourceFieldIds = srcField
    ? [srcField.id, ...contributingSources.map((f) => f.id)]
    : contributingSources.map((f) => f.id)

  const contextTableIds = [srcTableId, tgtTableId].filter((x): x is string => x != null)
  const txCtx = await buildAIContext(
    ctx.projectId,
    {
      tableIds: contextTableIds,
      fieldIds: [...allSourceFieldIds, tgtField.id],
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDistributionValues: 25,
    },
    user.id,
  )

  const tgtTableName = ctx.targetTable.name
  const transformDocBlock = formatDocumentsForPrompt(txCtx.documents)

  const allSrcCtxFields = txCtx.source_tables.flatMap((t) => t.fields)
  const srcFieldCtx = srcField ? allSrcCtxFields.find((f) => f.name === srcField.name) : null
  const tgtFieldCtx = txCtx.target_tables.flatMap((t) => t.fields).find((f) => f.name === tgtField.name)

  // Contributing-source block (many-to-one mappings).
  let contributingSourcesBlock = ''
  if (contributingSources.length > 0) {
    const { data: contribFields } = await supabase
      .from('fields')
      .select('id, name, data_type')
      .in('id', contributingSources.map((f) => f.id))
    if (contribFields && contribFields.length > 0) {
      const lines = contribFields.map((cf) => {
        const cx = allSrcCtxFields.find((f) => f.name === cf.name)
        return cx ? formatFieldForPrompt(cx) : `${cf.name} (${cf.data_type})`
      })
      // Combination hint lives on the TFM's ai_reasoning (migrated from the
      // legacy primary FM's reasoning in 074).
      const hintMatch = ctx.tfm.ai_reasoning?.match(/\[Combination:\s*(.*?)\]/)
      const combinationHint = hintMatch ? hintMatch[1] : ''
      contributingSourcesBlock = `\n<contributing_source_fields>
This is a MANY-TO-ONE mapping. Multiple source fields must be combined into a single target field value.

${srcField ? `Primary source field: ${srcField.name} (${srcField.data_type})` : 'No primary source field — this is a value assignment.'}
Contributing source fields:
${lines.join('\n')}
${combinationHint ? `\nCombination hint: ${combinationHint}` : ''}
Generate a SQL expression that COMBINES all source fields into the target field.
Reference source fields by name — they are accessible as row_data->>'field_name'.
Handle nulls gracefully — if one source field is null, use the remaining field(s).
</contributing_source_fields>\n`
    }
  }

  let iterationBlock = ''
  if (existingSQL && existingSQL.trim().length > 0) {
    iterationBlock = `<existing_sql>
${existingSQL.trim()}
</existing_sql>

<iteration_instruction>
The user has updated their description. Modify the existing SQL expression above to match the new description.
- Preserve the existing structure, CASE WHEN patterns, and null handling where possible
- Only change what the new description specifically requires
- If the existing SQL handles edge cases (null checks, trim, type casting) that the new description doesn't mention, KEEP them
- If the new description contradicts the existing SQL, follow the new description
- If the new description adds a requirement, add it to the existing SQL rather than rewriting
</iteration_instruction>

`
  }

  const checkConstraintLine = (() => {
    const cc = tgtCheckConstraint
    if (!cc) return ''
    if (cc.type === 'in_list' && cc.allowedValues && cc.allowedValues.length > 0) {
      return `\nAllowed values: ${JSON.stringify(cc.allowedValues)}`
    }
    if (cc.type === 'regex' && cc.pattern) {
      return `\nValue pattern (regex): ${cc.pattern}`
    }
    if (cc.type === 'range') {
      const parts: string[] = []
      if (cc.min !== undefined) parts.push(`min: ${cc.min}`)
      if (cc.max !== undefined) parts.push(`max: ${cc.max}`)
      if (parts.length === 0) return ''
      return `\nValue range: ${parts.join(', ')}`
    }
    if (cc.raw) {
      return `\nCHECK constraint: ${cc.raw}`
    }
    return ''
  })()

  const sourceBlock = isValueAssignment
    ? `<source_field>\nNo source field — this is a VALUE ASSIGNMENT.\nDefine a constant, expression, or function that produces the value for the target field.\nDo NOT reference row_data unless you know the source table columns.\nTable: ${srcTableName}\n</source_field>`
    : `<source_field>\n${srcFieldCtx ? formatFieldForPrompt(srcFieldCtx) : `${srcField!.name} (${(srcField as typeof srcField & { data_type?: string }).data_type ?? ''})`}\nTable: ${srcTableName}\n</source_field>`

  const typeCompat = ctx.primarySource?.mappingSourceId
    ? (await supabase
        .from('mapping_sources')
        .select('type_compatibility')
        .eq('id', ctx.primarySource.mappingSourceId)
        .single()
      ).data?.type_compatibility ?? null
    : null

  const userMessage = `${sourceBlock}
${contributingSourcesBlock}
<target_field>
Field: ${tgtTableName}.${tgtField.name}
Type: ${(tgtFieldFull as { data_type: string }).data_type}${(tgtFieldFull as { inferred_type?: string | null }).inferred_type ? ` (${(tgtFieldFull as { inferred_type?: string | null }).inferred_type})` : ''}
Nullable: ${(tgtFieldFull as { is_nullable: boolean }).is_nullable}${checkConstraintLine}
${tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : ''}
</target_field>

<type_compatibility>
${typeCompat ?? 'Not specified'}
</type_compatibility>
${transformDocBlock}
${txCtx.intelligence_context ? txCtx.intelligence_context + '\n\n' : ''}${iterationBlock}<description>
${description}
</description>

Generate the SQL transformation expression.`

  return guardWrites(ctx.projectId, async () => {
    let rawSql: string
    try {
      rawSql = await callClaude(TRANSFORM_SYSTEM_PROMPT, userMessage, 2048)
    } catch {
      return { success: false, error: 'AI generation failed. Please try again.' }
    }

    let sql = extractTransformSQL(rawSql)
    if (sql !== rawSql.trim()) {
      console.log('[transformations] generateTransform: SQL extracted from mixed response, raw length:', rawSql.length, 'extracted length:', sql.length)
    }

    if (!sql) return { success: false, error: 'AI returned empty SQL. Please try again.' }

    if (srcField) {
      sql = wrapWithNullGuard(sql, srcField.name)
    }

    // Upsert transformation keyed on target_field_mapping_id.
    const { data: existing } = await supabase
      .from('transformations')
      .select('id')
      .eq('target_field_mapping_id', ctx.tfm.id)
      .maybeSingle()

    let transformationId: string

    if (existing) {
      const { error: updateErr } = await supabase
        .from('transformations')
        .update({
          description: description.trim(),
          generated_sql: sql,
          is_ai_generated: true,
          status: 'draft' as TransformationStatus,
          test_results: null,
        })
        .eq('id', existing.id)
      if (updateErr) return { success: false, error: 'Failed to save transformation' }
      transformationId = existing.id as string
    } else {
      const { data: created, error: insertErr } = await supabase
        .from('transformations')
        .insert({
          target_field_mapping_id: ctx.tfm.id,
          description: description.trim(),
          generated_sql: sql,
          is_ai_generated: true,
          status: 'draft' as TransformationStatus,
          test_results: null,
        })
        .select('id')
        .single()
      if (insertErr || !created) return { success: false, error: 'Failed to save transformation' }
      transformationId = created.id as string
    }

    // If this target field is a PK, regenerating its transform may invalidate
    // FK dependents. Stale their transforms so users can address the drift.
    const { data: tgtFieldPk } = await supabaseAdmin
      .from('fields')
      .select('is_primary_key')
      .eq('id', tgtField.id)
      .single()

    if (tgtFieldPk?.is_primary_key) {
      const { staleFKDependentTransforms } = await import('@/lib/actions/fk-cascade')
      await staleFKDependentTransforms(ctx.projectId, tgtField.id)
    }

    return { success: true, sql, transformationId }
  })
}

// ─── updateTransformSQL ───────────────────────────────────────────────────────

export async function updateTransformSQL(
  transformationId: string,
  sql: string,
): Promise<{ success: boolean; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: tx } = await supabaseAdmin
    .from('transformations')
    .select('id, status, target_field_mapping_id')
    .eq('id', transformationId)
    .maybeSingle<Pick<TransformationRow, 'id' | 'status' | 'target_field_mapping_id'>>()
  if (!tx) return { success: false, error: 'Transformation not found' }

  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id')
    .eq('id', tx.target_field_mapping_id)
    .single<{ project_id: string }>()
  if (!tfmRow) return { success: false, error: 'Transformation not found' }

  const perm = await requireProjectPermission(tfmRow.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  return guardWrites(tfmRow.project_id, async () => {
    const cleanSql = sql.replace(/;+$/, '').trim()
    if (!cleanSql) return { success: false, error: 'SQL cannot be empty' }

    // If the transform was previously applied, surface SQL edits as 'stale'
    // so downstream readers know staged data no longer matches.
    const newStatus: TransformationStatus = tx.status === 'applied' ? 'stale' : 'draft'

    const { error } = await supabase
      .from('transformations')
      .update({
        generated_sql: cleanSql,
        is_ai_generated: false,
        status: newStatus,
        test_results: null,
      })
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Failed to update SQL' }
    return { success: true }
  })
}

// ─── autoSaveTransform ────────────────────────────────────────────────────────
// Persists sql, description, and optionally status. Used by the client-side
// debounced auto-save while the user is editing in the Transform tab.

export async function autoSaveTransform(
  transformationId: string,
  sql: string,
  description: string,
  status?: string,
): Promise<{ success: boolean; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: tx } = await supabaseAdmin
    .from('transformations')
    .select('id, target_field_mapping_id')
    .eq('id', transformationId)
    .maybeSingle<Pick<TransformationRow, 'id' | 'target_field_mapping_id'>>()
  if (!tx) return { success: false, error: 'Transformation not found' }

  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id')
    .eq('id', tx.target_field_mapping_id)
    .single<{ project_id: string }>()
  if (!tfmRow) return { success: false, error: 'Transformation not found' }

  const perm = await requireProjectPermission(tfmRow.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  return guardWrites(tfmRow.project_id, async () => {
    const cleanSql = sql.replace(/;+$/, '').trim()
    const updates: Record<string, unknown> = {
      generated_sql: cleanSql || sql,
      description: description.trim() || null,
    }
    if (status) updates.status = status

    const { error } = await supabase
      .from('transformations')
      .update(updates)
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Auto-save failed' }
    return { success: true }
  })
}

// ─── runFullTransformTest ─────────────────────────────────────────────────────
// Runs the stored transform SQL against ALL rows in the source table. Returns
// pass/fail counts and up to 20 failure details. On zero failures sets the
// transformation status → 'tested'; on failures keeps 'draft'.

export interface TransformTestFailure {
  rowNumber: number
  sourceValue: string
  errorMessage: string
}

export interface FullTransformTestResult {
  totalRows: number
  passedRows: number
  failedRows: number
  failures: TransformTestFailure[]
}

export async function runFullTransformTest(
  fieldMappingId: string,
): Promise<{ success: boolean; result?: FullTransformTestResult; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const { data: transformation } = await supabase
    .from('transformations')
    .select('id, generated_sql, status')
    .eq('target_field_mapping_id', ctx.tfm.id)
    .maybeSingle<Pick<TransformationRow, 'id' | 'generated_sql' | 'status'>>()
  if (!transformation?.generated_sql) {
    return { success: false, error: 'No transform SQL found. Generate a transform first.' }
  }

  // Source table: primary's source field's table_id for mapped TFMs; first TM
  // whose target_table matches for VAs (same pattern as generateTransform).
  const srcField = ctx.primarySource?.sourceField ?? null
  let sourceTableId: string | null = srcField?.table_id ?? null
  if (!sourceTableId) {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('source_table_id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', ctx.targetField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    sourceTableId = (anyTm?.source_table_id as string | undefined) ?? null
  }
  if (!sourceTableId) return { success: false, error: 'Source table not found' }

  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(transformation.generated_sql.replace(/;+$/, '').trim(), fieldNames)

  return guardWrites(ctx.projectId, async () => {
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
      'execute_transform_full_test',
      {
        p_expression: wrappedSql,
        p_table_id: sourceTableId,
        p_source_field: srcField?.name ?? '_none_',
      },
    )

    if (rpcErr) return { success: false, error: rpcErr.message }

    const raw = rpcResult as {
      total_rows: number
      passed_rows: number
      failed_rows: number
      failures: { row_number: number; source_value: string; error_message: string }[]
    }

    const result: FullTransformTestResult = {
      totalRows: raw.total_rows ?? 0,
      passedRows: raw.passed_rows ?? 0,
      failedRows: raw.failed_rows ?? 0,
      failures: (raw.failures ?? []).map((f) => ({
        rowNumber: f.row_number,
        sourceValue: f.source_value,
        errorMessage: f.error_message,
      })),
    }

    const newStatus: TransformationStatus = result.failedRows === 0 ? 'tested' : 'draft'
    await supabase
      .from('transformations')
      .update({ status: newStatus })
      .eq('id', transformation.id)

    return { success: true, result }
  })
}

// ─── testTransformation ───────────────────────────────────────────────────────

export async function testTransformation(
  fieldMappingId: string,
  sql: string,
  contributingFieldNames?: string[],
  options?: { silent?: boolean },
): Promise<{
  success: boolean
  results?: { before: string | null; after: string | null; beforeValues?: Record<string, string | null> }[]
  transformationId?: string
  error?: string
  errorCode?: TransformWriteErrorCode
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, error: 'No SQL to test' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const isValueAssignment = ctx.primarySource == null
  const srcField = ctx.primarySource?.sourceField ?? null
  if (!isValueAssignment && !srcField) return { success: false, error: 'Source field not found' }

  // Source table: same resolution as runFullTransformTest.
  let sourceTableId: string | null = srcField?.table_id ?? null
  if (!sourceTableId) {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('source_table_id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', ctx.targetField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    sourceTableId = (anyTm?.source_table_id as string | undefined) ?? null
  }
  if (!sourceTableId) return { success: false, error: 'Source table not found' }

  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(sql.trim(), fieldNames)

  const sourceFieldNames = srcField ? [srcField.name, ...(contributingFieldNames ?? [])] : (contributingFieldNames ?? [])
  const useMultiField = sourceFieldNames.length > 1

  return guardWrites(ctx.projectId, async () => {
    const { data: rpcResult, error: rpcErr } = useMultiField
      ? await supabaseAdmin.rpc('execute_transform_test', {
          p_expression: wrappedSql,
          p_table_id: sourceTableId,
          p_source_fields: sourceFieldNames,
          p_limit: 20,
        })
      : sourceFieldNames.length === 1
      ? await supabaseAdmin.rpc('execute_transform_test', {
          p_expression: wrappedSql,
          p_table_id: sourceTableId,
          p_source_field: sourceFieldNames[0],
          p_limit: 20,
        })
      : await supabaseAdmin.rpc('execute_transform_test', {
          p_expression: wrappedSql,
          p_table_id: sourceTableId,
          p_source_field: '_none_',
          p_limit: 10,
        })

    if (rpcErr) return { success: false, error: rpcErr.message }

    const rows = (rpcResult as { before_value: unknown; after_value: unknown; before_values?: Record<string, unknown> }[]) ?? []
    const results = rows.map((r) => ({
      before: r.before_value != null ? String(r.before_value) : null,
      after: r.after_value != null ? String(r.after_value) : null,
      ...(r.before_values ? {
        beforeValues: Object.fromEntries(
          Object.entries(r.before_values).map(([k, v]) => [k, v != null ? String(v) : null]),
        ),
      } : {}),
    }))

    // Upsert-ish: if a transformation exists, attach the test results (but
    // never downgrade an already-applied transform — the auto-preview calls
    // this function on field selection).
    const { data: existing } = await supabase
      .from('transformations')
      .select('id')
      .eq('target_field_mapping_id', ctx.tfm.id)
      .maybeSingle()

    let transformationId: string | undefined
    if (existing) {
      await supabase
        .from('transformations')
        .update({ status: 'tested' as TransformationStatus, test_results: results })
        .eq('id', existing.id)
        .neq('status', 'applied')
      transformationId = existing.id as string
    }

    if (!options?.silent) {
      await logActivity(
        ctx.projectId,
        'transform_tested',
        `Transform tested: ${srcField?.name ?? '[value]'} \u2192 ${ctx.targetField.name}`,
        'transform',
        { transformation_id: transformationId, source_field: srcField?.name ?? null, target_field: ctx.targetField.name },
      )
    }

    return { success: true, results, transformationId }
  })
}

// ─── saveTransformation ───────────────────────────────────────────────────────

export async function saveTransformation(
  transformationId: string,
): Promise<{ success: boolean; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: tx } = await supabaseAdmin
    .from('transformations')
    .select('id, target_field_mapping_id')
    .eq('id', transformationId)
    .maybeSingle<Pick<TransformationRow, 'id' | 'target_field_mapping_id'>>()
  if (!tx) return { success: false, error: 'Transformation not found' }

  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id')
    .eq('id', tx.target_field_mapping_id)
    .single<{ project_id: string }>()
  if (!tfmRow) return { success: false, error: 'Transformation not found' }

  const perm = await requireProjectPermission(tfmRow.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  return guardWrites(tfmRow.project_id, async () => {
    const { error } = await supabase
      .from('transformations')
      .update({ status: 'saved' as TransformationStatus })
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Failed to save transformation' }
    return { success: true }
  })
}

// ─── autoGenerateAllTransforms ────────────────────────────────────────────────

export async function autoGenerateAllTransforms(
  projectId: string,
): Promise<{
  success: boolean
  generated: number
  failed: number
  error?: string
  errorCode?: TransformWriteErrorCode
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, generated: 0, failed: 0, error: 'Not authenticated' }

  const { checkProjectPermission: checkPerm } = await import('@/lib/actions/role-resolution')
  if (!(await checkPerm(projectId, 'editor'))) {
    return { success: false, generated: 0, failed: 0, error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { success: false, generated: 0, failed: 0, error: 'Project not found' }

  return guardWrites(projectId, async () => {
    const pageData = await getTransformData(projectId)
    if (!pageData.hasMappings) return { success: true, generated: 0, failed: 0 }

    const targets: FieldItem[] = []
    for (const ds of pageData.datasets) {
      for (const tbl of ds.tables) {
        for (const field of tbl.fields) {
          if (field.needsTransform && !field.transformation) {
            targets.push(field)
          }
        }
      }
    }

    if (targets.length === 0) return { success: true, generated: 0, failed: 0 }

    let generated = 0
    let failed = 0

    for (const field of targets) {
      const autoDesc = field.typeCompatibility
        ? `Transform ${field.sourceFieldName} to ${field.targetFieldName}: ${field.typeCompatibility}`
        : `Map ${field.sourceFieldName} (${field.sourceFieldDataType}) to ${field.targetFieldName} (${field.targetFieldDataType})`

      const result = await generateTransform(field.fieldMappingId, autoDesc)
      if (result.success) generated++
      else failed++
    }

    return { success: true, generated, failed }
  })
}

// ─── applyTransform ───────────────────────────────────────────────────────────
//
// Applies a single TFM's transform to staged_data_rows.
//
// Mapped TFMs        → `dq_apply_field_transform_joined(tfmId, tgt_name, sql, NULL)`.
// Value-assignments  → `dq_apply_field_transform(tm_id, src_tbl, tgt_tbl, tgt_name, sql, has_staged)`
//                      looped over every TM sharing the VA's target_table
//                      (VAs are global per target table in the new model).

export async function applyTransform(
  fieldMappingId: string,
  sql: string,
): Promise<{ success: boolean; rowsAffected: number; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, rowsAffected: 0, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, rowsAffected: 0, error: 'No SQL to apply' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: false, rowsAffected: 0, error: 'Field mapping not found' }
  }

  // Gate: require the transform to have been tested first.
  const { data: trans } = await supabase
    .from('transformations')
    .select('status')
    .eq('target_field_mapping_id', resolved.tfmId)
    .maybeSingle<{ status: TransformationStatus }>()
  if (trans && trans.status !== 'tested' && trans.status !== 'applied') {
    return { success: false, rowsAffected: 0, error: 'Run "Test Transform" before applying.' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, rowsAffected: 0, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, rowsAffected: 0, error: perm.error }

  const isValueAssignment = ctx.primarySource == null
  if (!isValueAssignment && !ctx.primarySource?.sourceField) {
    return { success: false, rowsAffected: 0, error: 'Source field not found' }
  }

  return guardWrites(ctx.projectId, async () => {
    const tgtField = ctx.targetField
    let totalRows = 0

    if (!isValueAssignment) {
      // ── Mapped TFM — single call via the new joined RPC ─────────────────────
      const srcField = ctx.primarySource!.sourceField!
      const { data: allSourceFields } = await supabase
        .from('fields')
        .select('name')
        .eq('table_id', srcField.table_id)
      const fieldNames = (allSourceFields ?? []).map((f) => f.name)
      const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), fieldNames)

      const { data: rowsAffected, error: rpcErr } = await supabaseAdmin.rpc(
        'dq_apply_field_transform_joined',
        {
          p_target_field_mapping_id: ctx.tfm.id,
          p_target_field_name: tgtField.name,
          p_transform_sql: wrappedSql,
          p_join_spec: null,
        },
      )

      if (rpcErr) return { success: false, rowsAffected: 0, error: rpcErr.message }

      totalRows = Number(rowsAffected ?? 0)
    } else {
      // ── Value-assignment TFM — loop every TM whose target_table matches ────
      // Uses the legacy single-TM RPC per Gate 2 G-a decision. A dedicated
      // `dq_apply_value_assignment` is deferred to Prompt 3c.
      const { data: tms } = await supabaseAdmin
        .from('table_mappings')
        .select('id, source_table_id, target_table_id')
        .eq('project_id', ctx.projectId)
        .eq('target_table_id', tgtField.table_id)
        .neq('status', 'rejected')

      if (!tms || tms.length === 0) {
        return { success: false, rowsAffected: 0, error: 'No table mapping pairs the target table' }
      }

      // For VA apply, SQL is constant across TMs. Wrap with empty fieldNames
      // (VAs don't reference source columns); wrapping is still safe because
      // `wrapFieldRefsInJsonb` is a no-op when the set is empty.
      const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), [])

      for (const tm of tms) {
        const { count: stagedCount } = await supabaseAdmin
          .from('staged_data_rows')
          .select('id', { count: 'exact', head: true })
          .eq('table_mapping_id', tm.id)

        const hasExistingStaged = (stagedCount ?? 0) > 0

        const { data: rowsAffected, error: rpcErr } = await supabaseAdmin.rpc(
          'dq_apply_field_transform',
          {
            p_table_mapping_id: tm.id,
            p_source_table_id: tm.source_table_id,
            p_target_table_id: tm.target_table_id,
            p_target_field_name: tgtField.name,
            p_transform_sql: wrappedSql,
            p_has_existing_staged: hasExistingStaged,
          },
        )

        if (rpcErr) {
          console.error('[transformations] applyTransform: VA apply failed', {
            tmId: tm.id,
            tfmId: ctx.tfm.id,
            error: rpcErr.message,
          })
          return { success: false, rowsAffected: 0, error: rpcErr.message }
        }

        totalRows += Number(rowsAffected ?? 0)
      }
    }

    // Mark the transformation as applied.
    await supabase
      .from('transformations')
      .update({ status: 'applied' as TransformationStatus })
      .eq('target_field_mapping_id', ctx.tfm.id)

    // Re-flag row_issues now that transform values have changed.
    // `staged-row-flags` is Prompt-3d scope; catching keeps apply resilient.
    try {
      const { flagStagedRowIssues } = await import('@/lib/actions/staged-row-flags')
      const tmForFlag = ctx.tableMapping?.id
        ?? (isValueAssignment
          ? (await supabaseAdmin
              .from('table_mappings')
              .select('id')
              .eq('project_id', ctx.projectId)
              .eq('target_table_id', tgtField.table_id)
              .neq('status', 'rejected')
              .limit(1)
              .maybeSingle()).data?.id as string | undefined
          : undefined)
      if (tmForFlag) {
        await flagStagedRowIssues(ctx.projectId, tmForFlag)
      }
    } catch {
      // Non-critical — row_issues may be stale but staging data is intact.
    }

    const srcField = ctx.primarySource?.sourceField ?? null
    await logActivity(
      ctx.projectId,
      'transform_applied',
      `Transform applied: ${srcField?.name ?? '[value]'} \u2192 ${tgtField.name} — ${totalRows} row${totalRows !== 1 ? 's' : ''}`,
      'transform',
      {
        field_mapping_id: ctx.tfm.id,
        source_field: srcField?.name ?? null,
        target_field: tgtField.name,
        rows_affected: totalRows,
      },
    )

    revalidatePath(`/app/projects/${ctx.projectId}`, 'layout')
    return { success: true, rowsAffected: totalRows }
  })
}

// ─── revertTransform ──────────────────────────────────────────────────────────
// Removes a target field's staged value from all matching staged_data_rows and
// resets the transformation status back to 'tested'. Mapped TFMs revert one
// TM; VAs loop every TM sharing the target table (mirroring applyTransform).

export async function revertTransform(
  fieldMappingId: string,
): Promise<{ success: boolean; rowsAffected: number; error?: string; errorCode?: TransformWriteErrorCode }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, rowsAffected: 0, error: 'Not authenticated' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: false, rowsAffected: 0, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, rowsAffected: 0, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, rowsAffected: 0, error: perm.error }

  return guardWrites(ctx.projectId, async () => {
    const tgtField = ctx.targetField

    // Gather the TM set to revert.
    let tmIds: string[] = []
    if (ctx.tableMapping) {
      tmIds = [ctx.tableMapping.id]
    } else {
      const { data: tms } = await supabaseAdmin
        .from('table_mappings')
        .select('id')
        .eq('project_id', ctx.projectId)
        .eq('target_table_id', tgtField.table_id)
        .neq('status', 'rejected')
      tmIds = (tms ?? []).map((t) => t.id as string)
    }

    let totalReverted = 0
    for (const tmId of tmIds) {
      const { data: count, error: rpcErr } = await supabaseAdmin.rpc('revert_field_transform', {
        p_table_mapping_id: tmId,
        p_target_field_name: tgtField.name,
      })
      if (rpcErr) return { success: false, rowsAffected: 0, error: rpcErr.message }
      totalReverted += (count as number) ?? 0
    }

    // Reset transform status from 'applied' back to 'tested'.
    await supabaseAdmin
      .from('transformations')
      .update({ status: 'tested' as TransformationStatus })
      .eq('target_field_mapping_id', ctx.tfm.id)
      .eq('status', 'applied')

    revalidatePath(`/app/projects/${ctx.projectId}`, 'layout')
    return { success: true, rowsAffected: totalReverted }
  })
}

// ─── getStagedPreviewForField ─────────────────────────────────────────────────
// Reads a sample of staged_data_rows and extracts the source → target pair for
// a specific TFM. Used by the Transform Data Preview after Apply so the user
// sees real staged values rather than a re-executed live SQL preview.

export async function getStagedPreviewForField(
  fieldMappingId: string,
  limit = 20,
): Promise<{
  success: boolean
  rows?: Array<{ sourceValue: string | null; targetValue: string | null }>
  totalRows?: number
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind === 'unknown') {
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const srcFieldName = ctx.primarySource?.sourceField?.name ?? null
  const tgtFieldName = ctx.targetField.name

  // Pick the TM to read from. For mapped: the resolved linking TM. For VAs:
  // the first TM sharing the target table. Matches the getTransformData
  // routing so what the user sees under a TableGroup maps to THIS TM's
  // staged rows.
  let tmId: string | null = ctx.tableMapping?.id ?? null
  if (!tmId) {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', ctx.targetField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    tmId = (anyTm?.id as string | undefined) ?? null
  }
  if (!tmId) return { success: true, rows: [], totalRows: 0 }

  const { count } = await supabase
    .from('staged_data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_mapping_id', tmId)

  const { data: rows, error } = await supabase
    .from('staged_data_rows')
    .select('source_row_data, transformed_row_data')
    .eq('table_mapping_id', tmId)
    .order('row_number', { ascending: true })
    .limit(limit)

  if (error) return { success: false, error: error.message }

  const mapped = (rows ?? []).map((r) => ({
    sourceValue:
      srcFieldName != null
        ? ((r.source_row_data as Record<string, unknown>)?.[srcFieldName] ?? null)?.toString() ?? null
        : null,
    targetValue:
      ((r.transformed_row_data as Record<string, unknown>)?.[tgtFieldName] ?? null)?.toString() ?? null,
  }))

  return { success: true, rows: mapped, totalRows: count ?? 0 }
}

// ─── previewTransformDistinct ─────────────────────────────────────────────────
// Returns all distinct (before, after, count) triples for a SQL expression.
// Used by the "All Distinct Values" toggle in the live preview panel.
// Read path — no maintenance guard (viewer permission suffices).

export async function previewTransformDistinct(
  fieldMappingId: string,
  sql: string,
  contributingFieldNames?: string[],
): Promise<{
  success: boolean
  results?: { before: string | null; beforeValues: Record<string, string | null>; after: string | null; count: number }[]
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  if (!sql.trim()) return { success: false, error: 'No SQL to preview' }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind === 'unknown') {
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'viewer')
  if (!perm.allowed) return { success: false, error: perm.error }

  const srcField = ctx.primarySource?.sourceField ?? null

  let sourceTableId: string | null = srcField?.table_id ?? null
  if (!sourceTableId) {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('source_table_id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', ctx.targetField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    sourceTableId = (anyTm?.source_table_id as string | undefined) ?? null
  }
  if (!sourceTableId) return { success: false, error: 'Source table not found' }

  const { data: allSourceFields } = await supabase
    .from('fields')
    .select('name')
    .eq('table_id', sourceTableId)
  const fieldNames = (allSourceFields ?? []).map((f) => f.name)

  const wrappedSql = wrapFieldRefsInJsonb(sql.replace(/;+$/, '').trim(), fieldNames)

  const sourceFields = srcField ? [srcField.name, ...(contributingFieldNames ?? [])] : (contributingFieldNames ?? [])
  if (sourceFields.length === 0) sourceFields.push('_none_')

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'execute_transform_test_distinct',
    {
      p_table_id: sourceTableId,
      p_source_fields: sourceFields,
      p_transform_sql: wrappedSql,
      p_limit: 200,
    },
  )

  if (rpcErr) return { success: false, error: rpcErr.message }

  const rows = (rpcResult as { before_values: unknown; after_value: unknown; occurrence_count: number }[]) ?? []
  const results = rows.map((r) => {
    const bv = r.before_values as Record<string, string | null> | null
    if (bv && (bv as { _error?: boolean })._error) {
      return {
        before: null,
        beforeValues: {} as Record<string, string | null>,
        after: r.after_value != null ? String(r.after_value) : null,
        count: 0,
      }
    }
    const primaryVal = bv && srcField ? (bv[srcField.name] ?? null) : null
    return {
      before: primaryVal != null ? String(primaryVal) : null,
      beforeValues: (bv ?? {}) as Record<string, string | null>,
      after: r.after_value != null ? String(r.after_value) : null,
      count: r.occurrence_count ?? 0,
    }
  })

  return { success: true, results }
}

// ─── suggestTransformDescription ──────────────────────────────────────────────

const SUGGEST_SYSTEM_PROMPT = `You are a data migration expert. Given context about a source-to-target field mapping, generate a concise natural language description of how this field should be transformed.

The description will be fed directly into a SQL transform generator, so be specific and actionable. Include:
- The type of transformation needed (value mapping, format change, type conversion, etc.)
- Specific value mappings if the value distribution and documentation make them clear
- How to handle edge cases (nulls are handled automatically — do NOT include null handling instructions)
- Any truncation, formatting, or normalization rules

Write as a direct instruction. Keep it under 2-3 sentences for simple transforms, or use a clear mapping format for value mappings.

Examples of good descriptions:
- "Convert to uppercase and trim whitespace"
- "Strip $ signs and commas, then cast to decimal number"
- "Map industry names to codes: Technology=TECH, Manufacturing=MANU, Healthcare=HLTH. All other non-null values=OTHR"
- "Parse mixed date formats (MM/DD/YYYY and YYYY-MM-DD) to ISO 8601 (YYYY-MM-DD)"
- "Convert boolean representations (Y/N, yes/no, 1/0, true/false) to PostgreSQL TRUE/FALSE"
- "Strip CUST- prefix and return the numeric portion as a string"

Return ONLY the description text — no explanation, no preamble, no markdown.`

export async function suggestTransformDescription(
  fieldMappingId: string,
): Promise<{ success: boolean; suggestion?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: false, error: 'Field mapping not found' }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: false, error: 'Field mapping not found' }

  const perm = await requireProjectPermission(ctx.projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  const srcField = ctx.primarySource?.sourceField ?? null
  const tgtField = ctx.targetField

  const { data: tgtFieldFull } = await supabase
    .from('fields')
    .select('id, name, data_type, inferred_type, is_nullable')
    .eq('id', tgtField.id)
    .single()
  if (!tgtFieldFull) return { success: false, error: 'Target field not found' }

  const { data: srcFieldFull } = srcField
    ? await supabase
        .from('fields')
        .select('id, name, data_type, inferred_type, is_nullable')
        .eq('id', srcField.id)
        .single()
    : { data: null }
  if (srcField && !srcFieldFull) return { success: false, error: 'Source field not found' }

  const fieldIds = srcField ? [srcField.id, tgtField.id] : [tgtField.id]
  // Tables: if mapped, use the resolved TM's pair; else collect the VA's
  // target table and any matching TM's source table.
  let tableIds: string[]
  if (ctx.tableMapping) {
    tableIds = [ctx.tableMapping.source_table_id, ctx.tableMapping.target_table_id]
  } else {
    const { data: anyTm } = await supabase
      .from('table_mappings')
      .select('source_table_id, target_table_id')
      .eq('project_id', ctx.projectId)
      .eq('target_table_id', tgtField.table_id)
      .neq('status', 'rejected')
      .limit(1)
      .maybeSingle()
    tableIds = anyTm
      ? [anyTm.source_table_id as string, anyTm.target_table_id as string]
      : [tgtField.table_id]
  }

  const aiCtx = await buildAIContext(
    ctx.projectId,
    {
      tableIds,
      fieldIds,
      includeProfilingStats: true,
      includeValueDistributions: true,
      includeSampleValues: true,
      includeDocuments: true,
      maxDistributionValues: 20,
    },
    user.id,
  )

  const srcFieldCtx = srcField
    ? aiCtx.source_tables.flatMap((t) => t.fields).find((f) => f.name === srcField.name)
    : null
  const tgtFieldCtx = aiCtx.target_tables.flatMap((t) => t.fields).find((f) => f.name === tgtField.name)
  const docsBlock = formatDocumentsForPrompt(aiCtx.documents)

  const typeCompat = ctx.primarySource?.mappingSourceId
    ? (await supabase
        .from('mapping_sources')
        .select('type_compatibility')
        .eq('id', ctx.primarySource.mappingSourceId)
        .single()
      ).data?.type_compatibility ?? null
    : null

  const sourceBlock = srcFieldFull
    ? `<source_field>\n${srcFieldCtx ? formatFieldForPrompt(srcFieldCtx) : `${(srcFieldFull as { name: string }).name} (${(srcFieldFull as { data_type: string }).data_type})\n  Nullable: ${(srcFieldFull as { is_nullable: boolean }).is_nullable}`}\n</source_field>`
    : `<source_field>\nNo source field — this is a value assignment. Define a constant or expression for the target field.\n</source_field>`

  const userMessage = `${sourceBlock}

<target_field>
${(tgtFieldFull as { name: string }).name} (${(tgtFieldFull as { data_type: string }).data_type}${(tgtFieldFull as { inferred_type?: string | null }).inferred_type ? `, ${(tgtFieldFull as { inferred_type?: string | null }).inferred_type}` : ''})
Nullable: ${(tgtFieldFull as { is_nullable: boolean }).is_nullable}
${tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : ''}
</target_field>

<mapping_context>
Type compatibility: ${typeCompat ?? 'Not specified'}
Confidence: ${ctx.primarySource?.mappingSourceId ? (ctx.tfm.confidence ?? 'N/A') : (ctx.tfm.confidence ?? 'N/A')}%
AI reasoning: ${ctx.tfm.ai_reasoning ?? 'Not available'}
</mapping_context>
${docsBlock}
${aiCtx.intelligence_context ? aiCtx.intelligence_context + '\n\n' : ''}Suggest a transformation description for this field mapping.`

  let suggestion: string
  try {
    suggestion = await callClaude(SUGGEST_SYSTEM_PROMPT, userMessage, 256)
  } catch {
    return { success: false, error: 'AI suggestion failed. Please describe the transformation manually.' }
  }

  return { success: true, suggestion: suggestion.trim() }
}

// ─── Dismiss / reinstate needs_transformation ────────────────────────────────
// Writes to `target_field_mappings.needs_transformation` (migration 075). Per
// Gate 2 Q4 these functions preserve throw-on-error: guard failures propagate
// as native Error instances (matching `acknowledgeField` precedent).

/**
 * Marks a TFM as NOT needing transformation.
 * Used when the AI incorrectly flagged a direct-passthrough field.
 * Does NOT delete any existing transformation record.
 */
export async function dismissTransformNeeded(
  projectId: string,
  fieldMappingId: string,
): Promise<{ success: boolean; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  await assertMappingWritesEnabled(projectId)

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    throw new Error(`Failed to dismiss transform: invalid id ${fieldMappingId}`)
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('target_field_mappings')
    .update({ needs_transformation: false })
    .eq('id', resolved.tfmId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to dismiss transform: ${error.message}`)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

/**
 * Reinstates a TFM as needing transformation.
 * Used to undo a previous dismissal.
 */
export async function reinstateTransformNeeded(
  projectId: string,
  fieldMappingId: string,
): Promise<{ success: boolean; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  await assertMappingWritesEnabled(projectId)

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    throw new Error(`Failed to reinstate transform: invalid id ${fieldMappingId}`)
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('target_field_mappings')
    .update({ needs_transformation: true })
    .eq('id', resolved.tfmId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to reinstate transform: ${error.message}`)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

// ─── resetFieldTransform ──────────────────────────────────────────────────────
//
// Removes the transformation row for a TFM and, if the transform was applied,
// reverts the staged JSONB key on every matching staged_data_rows row. Called
// from `lib/actions/mappings.ts` before editing or deleting a mapping so stale
// SQL and orphaned staged keys never linger.
//
// NOTE ON GUARDING: this function intentionally does NOT call
// `assertMappingWritesEnabled`. It is invoked exclusively from already-guarded
// write paths in `mappings.ts` (via `guardWrites`). Re-asserting would
// double-call the guard (inefficient) and would complicate the throw-on-error
// contract the caller relies on.

export async function resetFieldTransform(
  fieldMappingId: string,
  options?: { skipFKCascade?: boolean },
): Promise<{
  success: boolean
  hadTransform: boolean
  hadStagedData: boolean
  rowsReverted: number
  fkDependentsReset?: number
  fkRowsReverted?: number
  error?: string
}> {
  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { success: true, hadTransform: false, hadStagedData: false, rowsReverted: 0 }
  }

  const ctx = await loadTfmContext(resolved.tfmId)
  if (!ctx) return { success: true, hadTransform: false, hadStagedData: false, rowsReverted: 0 }

  const { data: transform } = await supabaseAdmin
    .from('transformations')
    .select('id, status')
    .eq('target_field_mapping_id', ctx.tfm.id)
    .maybeSingle<{ id: string; status: TransformationStatus }>()

  if (!transform) {
    return { success: true, hadTransform: false, hadStagedData: false, rowsReverted: 0 }
  }

  let hadStagedData = false
  let rowsReverted = 0

  // Revert staged data via the existing RPC, scoped to the TM set this TFM
  // renders against (mapped: 1 TM, VA: all matching TMs).
  if (transform.status === 'applied') {
    const tgtFieldName = ctx.targetField.name
    let tmIds: string[] = []
    if (ctx.tableMapping) {
      tmIds = [ctx.tableMapping.id]
    } else {
      const { data: tms } = await supabaseAdmin
        .from('table_mappings')
        .select('id')
        .eq('project_id', ctx.projectId)
        .eq('target_table_id', ctx.targetField.table_id)
        .neq('status', 'rejected')
      tmIds = (tms ?? []).map((t) => t.id as string)
    }

    for (const tmId of tmIds) {
      const { data: count } = await supabaseAdmin.rpc('revert_field_transform', {
        p_table_mapping_id: tmId,
        p_target_field_name: tgtFieldName,
      })
      hadStagedData = true
      rowsReverted += (count as number) ?? 0
    }
  }

  // Delete the transformation row — clean slate for the new mapping.
  await supabaseAdmin
    .from('transformations')
    .delete()
    .eq('target_field_mapping_id', ctx.tfm.id)

  // If this target field is a PK, stale all FK-dependent transforms.
  // Dynamic import avoids a circular dependency with fk-cascade.ts.
  // `skipFKCascade: true` prevents recursion when called from within
  // `staleFKDependentTransforms` itself.
  let fkDependentsReset = 0
  let fkRowsReverted = 0

  if (!options?.skipFKCascade) {
    const { staleFKDependentTransforms } = await import('@/lib/actions/fk-cascade')
    const fkResult = await staleFKDependentTransforms(ctx.projectId, ctx.targetField.id)
    fkDependentsReset = fkResult.dependentsStaled
    fkRowsReverted = fkResult.stagedRowsReverted
  }

  return { success: true, hadTransform: true, hadStagedData, rowsReverted, fkDependentsReset, fkRowsReverted }
}

// ─── checkFieldMappingHasTransform ────────────────────────────────────────────
// Lightweight check used by the UI before showing a re-map confirmation dialog.
// Accepts either a bare TFM id or a shimmed contributor id. Contributors don't
// own a transformation; short-circuit to `hasTransform: false`.

export async function checkFieldMappingHasTransform(
  fieldMappingId: string,
): Promise<{ hasTransform: boolean; status?: string; hasStaged: boolean }> {
  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    return { hasTransform: false, hasStaged: false }
  }

  const { data: transform } = await supabaseAdmin
    .from('transformations')
    .select('id, status')
    .eq('target_field_mapping_id', resolved.tfmId)
    .maybeSingle<{ id: string; status: TransformationStatus }>()

  return {
    hasTransform: !!transform,
    status: transform?.status ?? undefined,
    hasStaged: transform?.status === 'applied',
  }
}

// ─── resetAllTransformsForTable ───────────────────────────────────────────────
//
// Deletes all staged_data_rows for a table mapping before the caller tears
// down its field mappings. Transformations themselves cascade via
// `transformations.target_field_mapping_id` ON DELETE CASCADE when the owning
// TFM is deleted — that is the responsibility of `mappings.ts`'s
// `deleteTableMapping` (which computes orphaned TFMs explicitly).
//
// The `transformsReset` count is informational only; in the new model the
// deletion of transformation rows is scoped by TFM orphan-ship rather than
// TM-id, so we report 0 here and let the caller compute the actual transform
// fallout from its own `computeOrphanedTfmsForTmDelete` pass.
//
// NOTE ON GUARDING: same pattern as `resetFieldTransform` — called exclusively
// from guarded write paths in `mappings.ts`; no re-assertion.

export async function resetAllTransformsForTable(
  tableMappingId: string,
): Promise<{ success: boolean; transformsReset: number; stagedRowsReverted: number; error?: string }> {
  const { count: stagedCount } = await supabaseAdmin
    .from('staged_data_rows')
    .delete({ count: 'exact' })
    .eq('table_mapping_id', tableMappingId)

  return {
    success: true,
    transformsReset: 0,
    stagedRowsReverted: stagedCount ?? 0,
  }
}
