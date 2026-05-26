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
// OUT-OF-SCOPE CALL SITES (historical — kept for change-history visibility)
//
//   - `flagStagedRowIssues` from `@/lib/actions/staged-row-flags` — was
//     Prompt 3b out-of-scope. Rewritten in Prompt 3d (Step 3D-5) to the
//     new TFM+mapping_sources model. The call site in `applyTransform`
//     retains its try/catch as defense-in-depth against runtime failures
//     (network / DB / RPC), not because the callee is known-broken.
//
// APPLY RPC WIRING (Gate 2 Q2 + Gate 2 G-a + Phase 4a-6 decisions)
//
//   - Mapped TFMs  → `dq_apply_field_transform_joined(tfmId, target_name, sql, p_join_spec)`.
//     Migration 076 (Phase 4a-6) wired the cross-table branch:
//       * Same-table TFM           → p_join_spec = NULL  (byte-for-byte
//                                     migration 074 semantics preserved).
//       * Cross-table TFM          → p_join_spec = { dominant_table_id,
//                                     joins: [...] } JSONB. Action layer
//                                     builds the spec via
//                                     `buildJoinSpec(tfmId, supabase)` from
//                                     `lib/utils/transform-cross-table.ts`,
//                                     dedupes per-source rows to per-table
//                                     entries, and re-derives FK relationships
//                                     when stored `mapping_sources.join_spec`
//                                     is null. Ambiguous re-derivation
//                                     (0 or 2+ candidates at apply time)
//                                     surfaces `CROSS_TABLE_FK_INFERENCE_FAILED`
//                                     before the RPC is invoked.
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
//       `dismissValueAssignment` / `reinstateValueAssignment` (migration 077)
//       follow the same throw-on-error pattern for the symmetric VA-side flag.
//     - `resetFieldTransform`, `resetAllTransformsForTable` are helpers
//       exclusively called from already-guarded write paths in
//       `lib/actions/mappings.ts` (per Gate 2); they do not re-assert the
//       guard. A comment at each function's header documents this.

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { callLLM } from '@/lib/ai/llm-client'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
import { EMIT_TRANSFORM_SQL_TOOL } from '@/lib/ai/tool-schemas'
import { extractTransformSQL } from '@/lib/ai/sql-extractor'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import {
  buildAIContext,
  formatFieldForPrompt,
  formatDocumentsForPrompt,
  formatPocAnswerKeyBlock,
} from '@/lib/ai/context-builder'
import {
  formatLookupTablesBlock,
  formatProjectDecisionsBlock,
  formatTransformationIntentBlock,
  type ProjectDecisionRow,
  type ProjectLookupTableRow,
} from '@/lib/ai/project-context-blocks'
import { composeTransformUserMessage } from '@/lib/ai/transform-prompt'
import { TRANSFORM_SYSTEM_PROMPT } from '@/lib/ai/transform-system-prompt'
import { assertNoDml, fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { buildJoinSpec } from '@/lib/utils/transform-cross-table'
import { resolveTransformationIntent } from '@/lib/utils/transformation-intent'
import { logActivity } from '@/lib/actions/activity-log'
import { logAIEdit } from '@/lib/actions/ai-edit-history'
import { assertMappingWritesEnabled } from '@/lib/auth/mapping-writes'
import { SHIMMED_ID_SEPARATOR } from '@/lib/compat/mapping-shim'
import { revalidatePath } from 'next/cache'
import { validateTransformSQL } from '@/lib/validation/transform-validator'
import { saveTemplate } from '@/lib/actions/migration-templates'
import type { CompletedMapping } from '@/lib/validation/migration-template'
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
  /** Upstream transform guidance from the mapping phase. */
  transformationIntent: string | null
  /** Null rate for the source field (from field_profiles) */
  nullPercentage: number
  /** Count of format issues for the source field (from field_profiles) */
  formatIssuesCount: number
  sampleValues: unknown[]
  cardinality: number
  needsTransform: boolean
  /**
   * Raw new-model `TransformationRow` for the TFM — or `null` if no
   * transformation has been generated yet. The legacy `Transformation`
   * adapter (`toLegacyTransformation`) was removed in Prompt 3d Step
   * 3D-12; consumers now read the new-model columns directly
   * (`target_field_mapping_id`, `generated_sql`, `status`, etc.).
   */
  transformation: TransformationRow | null
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
  /**
   * Phase 4a-3 — true when the underlying TFM's mapping_sources span
   * 2+ distinct source tables. Cross-table apply is not yet
   * supported by `dq_apply_field_transform_joined`; the Transform tab
   * server-disables Apply / Test buttons for these rows. False for
   * value assignments, single-source mapped TFMs, and same-table
   * multi-source TFMs.
   */
  isCrossTable: boolean
  /**
   * Migration 077 — true when the user has dismissed the
   * value-assignment requirement for this TFM (e.g. the field has a
   * DB default or is intentionally left null). Only meaningful when
   * `isValueAssignment === true`. Mirrors the mapped-side
   * `needs_transformation = false` dismissal but with distinct semantics
   * for load SQL and readiness scoring (dismissed VAs are skipped from
   * SELECT lists; transform-dismissed mapped fields are not).
   */
  vaDismissed: boolean
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
  /** Persisted no-source metadata when this target field already has an acknowledged TFM. */
  confidence?: number | null
  aiReasoning?: string | null
  transformationIntent?: string | null
  transformationNeeded?: boolean | null
}

/**
 * One row inside a `TargetTableGroup`. Either a mapping (TFM, mapped or VA)
 * or a target field with no TFM yet (truly unmapped). Rows are interleaved
 * in DDL order by the server so the sidebar can render them inline without
 * a client-side sort.
 */
export type TargetTableRow =
  | { kind: 'mapping'; field: FieldItem }
  | { kind: 'unmapped'; field: UnmappedTargetField }

/**
 * Phase 3 redesign — target-led sidebar grouping. Each target table is a
 * top-level group; fields inside the group are TFMs (mapped + VA, including
 * dismissed VAs) plus any target fields with no TFM yet, all in DDL order.
 *
 * Coexists with `datasets` (source-led grouping). The target-led shape is
 * what the redesigned sidebar consumes; the source-led shape is preserved
 * so the existing selection-lookup helpers (`findField`, etc.) continue to
 * work without rewriting every call site.
 */
export interface TargetTableGroup {
  targetTableId: string
  targetTableName: string
  rows: TargetTableRow[]
}

export interface TransformPageData {
  datasets: DatasetGroup[]
  /** Phase 3 redesign — target-led grouping, DDL-ordered, alphabetical by table name. */
  targetTableGroups: TargetTableGroup[]
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

// PR ζ.1 diagnostic heuristic — matches any double-quoted token that
// contains a dot, e.g. `"Engineering BOM Masters.Assy Desc"`. Used at
// applyTransform / testTransformation entry points to surface the
// silent-degrade where the AI produced cross-table-qualified SQL but
// buildJoinSpec returned `spec:null` (same-table fallback path).
// Investigation: /tmp/pr-zeta-1-investigation.md §1.
const QUALIFIED_REF_HEURISTIC = /"[^"]+\.[^"]+"/

export type TransformWriteErrorCode =
  | 'MAINTENANCE_MODE'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VALIDATION'
  | 'INTERNAL'
  /**
   * Phase 4a-6 — surfaced by `applyTransform` (and `testTransformation`
   * for parity) when a cross-table TFM was authored with an inferred FK
   * (stored `mapping_sources.join_spec=null`) but `inferFkCandidates`
   * now returns 0 or 2+ candidates. Indicates schema drift since the
   * mapping was authored. User-facing copy:
   *   "FK relationship changed since this mapping was authored.
   *    Please re-author the mapping."
   * Replaced the legacy `CROSS_TABLE_TRANSFORM_NOT_YET_SUPPORTED` code
   * (Phase 4a-3 transparency stack — retired in 4a-6 once the RPC's
   * cross-table branch shipped via migration 076).
   */
  | 'CROSS_TABLE_FK_INFERENCE_FAILED'

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

// ─── TFM context resolver (shared across write paths) ────────────────────────
//
// Every write path needs the same basic context: the TFM row, its project,
// its target field (+ table), and — for mapped TFMs — the anchor source
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

export interface TfmContext {
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
  /** Resolved table_mapping linking anchor source table → target table.
   *  Cycle 1 — for cross-table TFMs the anchor is the first source's
   *  table (first-source-wins). NULL for VAs. */
  tableMapping: {
    id: string
    source_table_id: string
    target_table_id: string
  } | null
}

export async function loadTfmContext(tfmId: string): Promise<TfmContext | null> {
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

// ─── loadProjectContextBlocks ─────────────────────────────────────────────────
//
// Fetches project-scoped Path D outputs (decisions + lookup tables) for
// inclusion in agent user messages via the formatters at
// `lib/ai/project-context-blocks.ts`. Empty arrays when the project has none.
// Read-only; caller is responsible for prior `requireProjectPermission`
// gating. Uses `supabaseAdmin` to match `loadTfmContext`'s precedent
// (perm-gated reads bypass RLS for predictable error envelopes).
export async function loadProjectContextBlocks(
  projectId: string,
): Promise<{ decisions: ProjectDecisionRow[]; lookupTables: ProjectLookupTableRow[] }> {
  const [{ data: decisions }, { data: lookupTables }] = await Promise.all([
    supabaseAdmin
      .from('project_decisions')
      .select(
        'id, decision_type, title, description, ai_recommendation, alternatives, customer_decision, applies_to, status',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
    supabaseAdmin
      .from('project_lookup_tables')
      .select(
        'id, name, description, mappings, applies_to_fields, data_quality_notes, customer_approved',
      )
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }),
  ])

  return {
    decisions: (decisions ?? []) as ProjectDecisionRow[],
    lookupTables: (lookupTables ?? []) as ProjectLookupTableRow[],
  }
}

// ─── getTransformData ─────────────────────────────────────────────────────────
//
// Read path — renders the Transform tab's dataset → table → field tree.
//
// Semantic parity with the legacy implementation:
//   - Each TFM surfaces as ONE FieldItem under the TableGroup that hosts its
//     anchor source table (Cycle 1 — first-source-wins; or — for value
//     assignments — under the first TM whose target_table matches the VA's
//     target_field.table_id; VAs are global per target table in the new
//     model).
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
    targetTableGroups: [],
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
    { data: acknowledgedNoSourceTfms },
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
    supabase
      .from('target_field_mappings')
      .select(
        'id, target_field_id, confidence, ai_reasoning, transformation_intent, needs_transformation',
      )
      .eq('project_id', projectId)
      .eq('is_acknowledged', true)
      .neq('status', 'rejected'),
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
  const acknowledgedNoSourceTfmByTargetFieldId = new Map<
    string,
    {
      confidence: number | null
      ai_reasoning: string | null
      transformation_intent: string | null
      needs_transformation: boolean | null
    }
  >()
  for (const tfm of acknowledgedNoSourceTfms ?? []) {
    acknowledgedNoSourceTfmByTargetFieldId.set(tfm.target_field_id as string, {
      confidence: (tfm.confidence ?? null) as number | null,
      ai_reasoning: (tfm.ai_reasoning ?? null) as string | null,
      transformation_intent: (tfm.transformation_intent ?? null) as string | null,
      needs_transformation: (tfm.needs_transformation ?? null) as boolean | null,
    })
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
  // TFM's anchor source_table_id (Cycle 1 — first-source-wins) and the
  // target field's table_id.
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
    const transformation: TransformationRow | null = transformByTfmId.get(tfm.id) ?? null

    const vaDismissed = !!tfm.va_dismissed
    // Migration 077 — dismissed VAs surface as "Dismissed" in the sidebar
    // and editor (not "Define"); they no longer claim attention. The
    // mapped-side `fieldNeedsTransform` heuristic does not apply: the user
    // has explicitly opted this field out of value generation.
    const needsTransform = isValueAssignment
      ? (!vaDismissed && tfm.needs_transformation === true)
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
    let contributorSpansOtherTable = false
    for (const c of contributors) {
      if (!c.sourceFieldId) continue
      const cf = srcFieldById.get(c.sourceFieldId)
      if (!cf) continue
      contributingSourceFields.push({ id: cf.id, name: cf.name, data_type: cf.data_type })
      if (
        srcField &&
        cf.table_id &&
        srcField.table_id &&
        cf.table_id !== srcField.table_id
      ) {
        contributorSpansOtherTable = true
      }
    }
    const isCrossTable =
      !isValueAssignment && contributorSpansOtherTable

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
      transformationIntent: tfm.transformation_intent ?? null,
      nullPercentage: (profile as typeof profile & { null_percentage?: number } | undefined)?.null_percentage ?? 0,
      formatIssuesCount: (profile as typeof profile & { format_issues_count?: number } | undefined)?.format_issues_count ?? 0,
      sampleValues: (profile?.sample_values as unknown[]) ?? [],
      cardinality: profile?.cardinality ?? 0,
      needsTransform,
      transformation,
      isContributing: false,
      contributingSourceFields,
      isCrossTable,
      vaDismissed,
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
    ...(acknowledgedNoSourceTfmByTargetFieldId.get(f.id)
      ? {
          confidence: acknowledgedNoSourceTfmByTargetFieldId.get(f.id)!.confidence,
          aiReasoning: acknowledgedNoSourceTfmByTargetFieldId.get(f.id)!.ai_reasoning,
          transformationIntent:
            acknowledgedNoSourceTfmByTargetFieldId.get(f.id)!.transformation_intent,
          transformationNeeded:
            acknowledgedNoSourceTfmByTargetFieldId.get(f.id)!.needs_transformation,
        }
      : {}),
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

  // ── Phase 3 redesign — target-led grouping ───────────────────────────────
  //
  // Builds a `TargetTableGroup` per target table that participates in any
  // table_mapping, mixing TFMs (mapped + VA) and truly-unmapped target
  // fields in DDL order. The sidebar consumes this shape directly; the
  // existing `datasets` source-led shape is retained above for back-compat
  // with selection-lookup helpers (`findField`, etc.).
  //
  // Sort order:
  //   - Groups: alphabetical by `targetTableName` (locale-aware).
  //   - Rows within a group: target-field DDL order via `allTgtFieldRows`
  //     ordering (already `.order('ordinal_position', ascending)` above).
  //
  // No client-side `.sort()` is required — the consumer iterates the
  // pre-sorted arrays as-is.
  const fieldItemsByTargetFieldId = new Map<string, FieldItem>()
  for (const dsGroup of datasetGroupMap.values()) {
    for (const tbl of dsGroup.tables) {
      for (const f of tbl.fields) {
        fieldItemsByTargetFieldId.set(f.targetFieldId, f)
      }
    }
  }

  const unmappedFieldByTargetFieldId = new Map<string, UnmappedTargetField>()
  for (const u of [...unmappedNotNullTargetFields, ...unmappedNullableTargetFields]) {
    unmappedFieldByTargetFieldId.set(u.id, u)
  }

  const targetTableGroups: TargetTableGroup[] = []
  for (const tableId of allTargetTableIds) {
    const tableName = tgtTableNameById.get(tableId)
    if (!tableName) continue

    const rows: TargetTableRow[] = []
    for (const f of allTgtFieldRows ?? []) {
      if (f.table_id !== tableId) continue
      const tfmField = fieldItemsByTargetFieldId.get(f.id)
      if (tfmField) {
        rows.push({ kind: 'mapping', field: tfmField })
        continue
      }
      const unmapped = unmappedFieldByTargetFieldId.get(f.id)
      if (unmapped) {
        rows.push({ kind: 'unmapped', field: unmapped })
      }
    }

    if (rows.length === 0) continue
    targetTableGroups.push({
      targetTableId: tableId,
      targetTableName: tableName,
      rows,
    })
  }

  // Alphabetical group order. Done server-side; consumer never re-sorts.
  targetTableGroups.sort((a, b) =>
    a.targetTableName.localeCompare(b.targetTableName, undefined, { sensitivity: 'base' }),
  )

  return {
    datasets: [...datasetGroupMap.values()],
    targetTableGroups,
    schemaDocText,
    hasMappings: true,
    unmappedNotNullTargetFields,
    unmappedNullableTargetFields,
  }
}

// ─── Claude system prompt ─────────────────────────────────────────────────────
//
// `TRANSFORM_SYSTEM_PROMPT` lives at `lib/ai/transform-system-prompt.ts` so
// the unit tests can import it without transitively pulling in 'use server'
// and the Anthropic SDK singleton. Same separation pattern as
// `composeTransformUserMessage` at `lib/ai/transform-prompt.ts`.

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
  // table_mapping (the anchor source table → target table — Cycle 1 first-
  // source-wins); for VAs we use the first TM whose target_table matches.
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
  const pocBlock = formatPocAnswerKeyBlock(txCtx.documents.poc_answer_key)

  // Project-scoped Path D outputs — fetched once per call. All decisions /
  // lookup tables for the project are included; the agent self-selects
  // relevant ones (per PR 1 STOP 1 Q2/Q3). Empty arrays format to ''.
  const { decisions: projectDecisions, lookupTables: projectLookupTables } =
    await loadProjectContextBlocks(ctx.projectId)
  const lookupTablesBlock = formatLookupTablesBlock(projectLookupTables)
  const projectDecisionsBlock = formatProjectDecisionsBlock(projectDecisions)

  // Per-TFM intent — falls back to ai_reasoning's `[Combination: …]` extractor
  // for legacy (Path B/C) records that pre-date the structured column.
  const resolvedIntent = resolveTransformationIntent(
    ctx.tfm.transformation_intent,
    ctx.tfm.ai_reasoning,
  )
  const transformationIntentBlock = formatTransformationIntentBlock(resolvedIntent)

  const allSrcCtxFields = txCtx.source_tables.flatMap((t) => t.fields)
  const srcFieldCtx = srcField ? allSrcCtxFields.find((f) => f.name === srcField.name) : null
  const tgtFieldCtx = txCtx.target_tables.flatMap((t) => t.fields).find((f) => f.name === tgtField.name)

  // Contributing-source block (many-to-one mappings). Fields are grouped by
  // their owning source table so the agent can distinguish cross-table from
  // same-table TFMs and apply the qualification rule from the system prompt.
  let contributingSourcesBlock = ''
  if (contributingSources.length > 0) {
    // Build the (field, source_table_id) list, including the primary source
    // so its table participates in the cross-table detection. ctx.contributors
    // carries source_field with table_id resolved by loadTfmContext.
    const sourceEntries: Array<{ field: ContextField; isPrimary: boolean }> = []
    if (srcField) {
      sourceEntries.push({ field: srcField, isPrimary: true })
    }
    for (const c of ctx.contributors) {
      if (c.sourceField) sourceEntries.push({ field: c.sourceField, isPrimary: false })
    }

    // Resolve source table names for grouping. `tableMapping` already has the
    // primary's source_table_id resolved upstream, but contributors may live
    // in sibling tables that the existing query chain hasn't named — look
    // them up here in one round-trip.
    const uniqueTableIds = Array.from(new Set(sourceEntries.map((e) => e.field.table_id)))
    const tableNameById = new Map<string, string>()
    if (uniqueTableIds.length > 0) {
      const { data: srcTables } = await supabaseAdmin
        .from('tables')
        .select('id, name')
        .in('id', uniqueTableIds)
      for (const t of (srcTables ?? []) as Array<{ id: string; name: string }>) {
        tableNameById.set(t.id, t.name)
      }
    }

    // Preserve primary-first ordering: walk sourceEntries and group as we go.
    const groupedByTable = new Map<string, ContextField[]>()
    for (const entry of sourceEntries) {
      const name = tableNameById.get(entry.field.table_id) ?? entry.field.table_id
      const arr = groupedByTable.get(name) ?? []
      arr.push(entry.field)
      groupedByTable.set(name, arr)
    }

    const isCrossTable = groupedByTable.size > 1

    const groupedLines = Array.from(groupedByTable.entries())
      .map(([tableName, fields]) => {
        const fieldLines = fields.map((f) => {
          const cx = allSrcCtxFields.find((x) => x.name === f.name)
          return '  ' + (cx ? formatFieldForPrompt(cx) : `${f.name} (${f.data_type})`)
        })
        return `Source table: ${tableName}\n${fieldLines.join('\n')}`
      })
      .join('\n')

    // Combination hint resolution prefers the structured `transformation_intent`
    // column (Path D, migration 093). Path B legacy records have NULL there
    // and carry the hint inside ai_reasoning as `[Combination: X]`; the
    // helper falls back to the regex extractor for those. Sub-PR 2 lock —
    // 10 regression cases at tests/utils/transformation-intent.test.ts.
    const combinationHint = resolveTransformationIntent(ctx.tfm.transformation_intent, ctx.tfm.ai_reasoning) ?? ''

    const referenceStyleLine = isCrossTable
      ? `Reference source fields using the QUALIFIED "Source Table.Field" form copied verbatim from the headings above (e.g. "Engineering BOM Masters.Assy Desc"). The wrapper rewrites these to LATERAL aliases. NEVER hand-write d./j0./j1. — emit table names; the wrapper translates.`
      : `Reference source fields by name — they are accessible as row_data->>'field_name'.`

    contributingSourcesBlock = `\n<contributing_source_fields>
This is a MANY-TO-ONE mapping. Multiple source fields must be combined into a single target field value.

${srcField ? `Primary source field: ${srcField.name} (${srcField.data_type})` : 'No primary source field — this is a value assignment.'}
Contributing source fields:
${groupedLines}
${combinationHint ? `\nCombination hint: ${combinationHint}` : ''}
Generate a SQL expression that COMBINES all source fields into the target field.
${referenceStyleLine}
Handle nulls gracefully — if one source field is null, use the remaining field(s).
</contributing_source_fields>\n`
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

  const userMessage = composeTransformUserMessage({
    sourceBlock,
    contributingSourcesBlock,
    targetTableName: tgtTableName,
    targetFieldName: tgtField.name,
    targetDataType: (tgtFieldFull as { data_type: string }).data_type,
    targetInferredType: (tgtFieldFull as { inferred_type?: string | null }).inferred_type ?? null,
    targetIsNullable: (tgtFieldFull as { is_nullable: boolean }).is_nullable,
    checkConstraintLine,
    targetCardinalityLine:
      tgtFieldCtx && tgtFieldCtx.cardinality > 0 ? `Distinct values: ${tgtFieldCtx.cardinality}` : '',
    typeCompat,
    lookupTablesBlock,
    projectDecisionsBlock,
    documentationBlock: transformDocBlock,
    intelligenceContext: txCtx.intelligence_context ?? '',
    iterationBlock,
    transformationIntentBlock,
    description,
    pocBlock,
  })

  // Debug-flag-gated prompt dump (PR 1 STOP 1 Q9). Enabled by setting
  // DEBUG_TRANSFORM_PROMPT=1 — useful for verifying assembled-message
  // shape locally without triggering an LLM call. Logs char count only;
  // never logs raw prompt content in production.
  if (process.env.DEBUG_TRANSFORM_PROMPT === '1') {
    console.log(
      '[transformations] generateTransform user message: chars=' +
        userMessage.length +
        ' words=' +
        userMessage.split(/\s+/).length +
        ' poc=' +
        (pocBlock ? 'yes' : 'no') +
        ' decisions=' +
        projectDecisions.length +
        ' lookup_tables=' +
        projectLookupTables.length +
        ' intent=' +
        (resolvedIntent ? 'yes' : 'no'),
    )
  }

  return guardWrites(ctx.projectId, async () => {
    // PR 12.2 B-1: tool use under flag ON; legacy text+extractTransformSQL under flag OFF.
    const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
    let rawSql: string
    let llmCallId: string | null = null
    try {
      const result = await callLLM({
        feature: 'transform_generate',
        systemPrompt: withProvenanceGuidance(TRANSFORM_SYSTEM_PROMPT),
        userMessage,
        maxTokens: 2048,
        projectId: ctx.projectId,
        userId: user.id,
        promptVersion: 'transform-generate-v1',
        abuseUserId: user.id,
        metadata: { tfm_id: ctx.tfm.id, target_field_id: tgtField.id },
        ...(phase2Enabled && { tool: EMIT_TRANSFORM_SQL_TOOL }),
        // PR 13.1: prompt caching. TRANSFORM_SYSTEM_PROMPT is the largest
        // system prompt in the codebase (~5K tk of SQL pattern guidance);
        // per-field batching during transform-tab work delivers high
        // invocation locality. Highest single-call savings of the cohort.
        // PR-CACHE-HOTFIX: disabled to unblock 4-block limit. See INF-5 for
        // selective re-enable on top 4 blocks.
        cacheControl: false,
      })
      llmCallId = result.callId
      if (result.kind === 'toolUse') {
        const input = result.toolUse.input as { sql?: unknown }
        if (typeof input.sql !== 'string') {
          throw new Error('transform_generate: tool input missing sql string')
        }
        rawSql = input.sql
      } else {
        rawSql = result.text
      }
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

    // Layer 1 validation — annotates the row, never blocks save.
    const l1Result = await validateTransformSQL(sql, supabase)
    const validationIssues = l1Result.issues.length > 0 ? l1Result.issues : null

    // Upsert transformation keyed on target_field_mapping_id.
    // Pull generated_sql for previousSql capture (provenance diff).
    const { data: existing } = await supabase
      .from('transformations')
      .select('id, generated_sql')
      .eq('target_field_mapping_id', ctx.tfm.id)
      .maybeSingle()

    const previousSql: string | null = existing
      ? ((existing as { generated_sql: string | null }).generated_sql ?? null)
      : null

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
          validation_issues: validationIssues,
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
          // Freeze the AI's first proposal. Set on INSERT only; never
          // overwritten on subsequent regenerations.
          original_ai_generated_sql: sql,
          status: 'draft' as TransformationStatus,
          test_results: null,
          validation_issues: validationIssues,
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

    // Provenance: structured diff for ai_edit_history. ai_replaced when
    // overwriting an existing AI value (regen); ai_proposed for the
    // first AI write. llmCallId chains back to the callLLM result.
    void logAIEdit({
      projectId: ctx.projectId,
      actorId: user.id,
      entityType: 'transformation',
      entityId: transformationId,
      fieldPath: 'generated_sql',
      oldValue: previousSql,
      newValue: sql,
      editKind: previousSql ? 'ai_replaced' : 'ai_proposed',
      llmCallId,
      metadata: { tfm_id: ctx.tfm.id, target_field_id: tgtField.id },
    })

    return { success: true, sql, transformationId }
  })
}

// ─── clearStaleAiMetadataForTransformEdit ─────────────────────────────────────
//
// When the user hand-edits a transformation's SQL, the AI metadata on the
// parent TFM no longer describes the live mapping — the transformation is now
// user-owned. Clears the stale AI metadata fields:
//
//   • `ai_reasoning` — the narrative no longer matches the edited transform.
//     Guarded on a non-null `currentReasoning` so a debounced re-save neither
//     re-writes the row nor re-emits an audit entry. The frozen first-proposal
//     copy survives in `target_field_mappings.original_ai_reasoning`
//     (migration 083), so the clear is non-destructive of provenance.
//
//   • `transformation_intent` — the Path D mapping-pass recipe (migration
//     093) describing the AI's intended transformation for the original
//     pairing. Once the user hand-edits the SQL it no longer applies.
//     Guarded on a non-null `currentTransformationIntent` so a debounced
//     re-save is a no-op. Unlike `ai_reasoning` there is no frozen
//     `original_*` copy — the clear is destructive of the mapping-phase
//     recipe by design (locked model: user edits clear AI commentary; no
//     provenance-preservation use case identified — see PR notes).
//
//   • `confidence` — a "92%" number describes the AI's confidence in its
//     original proposal, not the user's edited transform (locked model: user
//     edits clear confidence). Branches on `combination_type`: the
//     MIN-of-mapping_sources trigger (migration 074) recomputes only
//     non-custom_sql TFMs, so a value assignment (`custom_sql`, zero
//     `mapping_sources`) needs a direct `target_field_mappings.confidence`
//     write, while a mapped TFM nulls its `mapping_sources.confidence` rows
//     and lets the trigger recompute. Run unconditionally (independent of the
//     `ai_reasoning` guard — a VA can carry a null `ai_reasoning` yet a stale
//     `confidence`); the write is idempotent, so a debounced re-save is safe.
//
// Best-effort: the caller's primary SQL write has already committed when this
// runs, so a clear failure is logged (matching the soft-fail pattern used for
// coverage/transform-reset cleanup elsewhere) rather than failing the action.

async function clearStaleAiMetadataForTransformEdit(args: {
  tfmId: string
  projectId: string
  actorId: string
  currentReasoning: string | null
  currentTransformationIntent: string | null
  combinationType: string | null
}): Promise<void> {
  // ── ai_reasoning — guarded so a debounced re-save is a no-op ──────────────
  if (args.currentReasoning !== null) {
    const { error } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ ai_reasoning: null, updated_at: new Date().toISOString() })
      .eq('id', args.tfmId)

    if (error) {
      console.warn(
        '[transformations] failed to clear stale TFM ai_reasoning (SQL write committed):',
        error.message,
      )
    } else {
      void logAIEdit({
        projectId: args.projectId,
        actorId: args.actorId,
        entityType: 'target_field_mapping',
        entityId: args.tfmId,
        fieldPath: 'ai_reasoning',
        oldValue: args.currentReasoning,
        newValue: null,
        editKind: 'human_modified',
        metadata: { reason: 'transformation_edited' },
      })
    }
  }

  // ── transformation_intent — guarded so a debounced re-save is a no-op ─────
  if (args.currentTransformationIntent !== null) {
    const { error } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ transformation_intent: null, updated_at: new Date().toISOString() })
      .eq('id', args.tfmId)

    if (error) {
      console.warn(
        '[transformations] failed to clear stale TFM transformation_intent (SQL write committed):',
        error.message,
      )
    } else {
      void logAIEdit({
        projectId: args.projectId,
        actorId: args.actorId,
        entityType: 'target_field_mapping',
        entityId: args.tfmId,
        fieldPath: 'transformation_intent',
        oldValue: args.currentTransformationIntent,
        newValue: null,
        editKind: 'human_modified',
        metadata: { reason: 'transformation_edited' },
      })
    }
  }

  // ── confidence — branch by combination_type (see header) ──────────────────
  if (args.combinationType === 'custom_sql') {
    const { error } = await supabaseAdmin
      .from('target_field_mappings')
      .update({ confidence: null, updated_at: new Date().toISOString() })
      .eq('id', args.tfmId)
    if (error) {
      console.warn(
        '[transformations] failed to clear stale TFM confidence (SQL write committed):',
        error.message,
      )
    }
  } else {
    const { error } = await supabaseAdmin
      .from('mapping_sources')
      .update({ confidence: null })
      .eq('target_field_mapping_id', args.tfmId)
    if (error) {
      console.warn(
        '[transformations] failed to clear stale mapping_sources confidence (SQL write committed):',
        error.message,
      )
    }
  }
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
    .select('id, status, target_field_mapping_id, generated_sql, is_ai_generated')
    .eq('id', transformationId)
    .maybeSingle<
      Pick<
        TransformationRow,
        'id' | 'status' | 'target_field_mapping_id' | 'generated_sql' | 'is_ai_generated'
      >
    >()
  if (!tx) return { success: false, error: 'Transformation not found' }

  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id, ai_reasoning, transformation_intent, combination_type')
    .eq('id', tx.target_field_mapping_id)
    .single<{
      project_id: string
      ai_reasoning: string | null
      transformation_intent: string | null
      combination_type: string | null
    }>()
  if (!tfmRow) return { success: false, error: 'Transformation not found' }

  const perm = await requireProjectPermission(tfmRow.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  return guardWrites(tfmRow.project_id, async () => {
    const cleanSql = sql.replace(/;+$/, '').trim()
    if (!cleanSql) return { success: false, error: 'SQL cannot be empty' }

    // If the transform was previously applied, surface SQL edits as 'stale'
    // so downstream readers know staged data no longer matches.
    const newStatus: TransformationStatus = tx.status === 'applied' ? 'stale' : 'draft'

    const previousSql = tx.generated_sql ?? null
    const wasAiGenerated = tx.is_ai_generated === true

    // Layer 1 validation — annotates the row, never blocks save.
    const l1Result = await validateTransformSQL(cleanSql, supabase)
    const validationIssues = l1Result.issues.length > 0 ? l1Result.issues : null

    const { error } = await supabase
      .from('transformations')
      .update({
        generated_sql: cleanSql,
        is_ai_generated: false,
        status: newStatus,
        test_results: null,
        validation_issues: validationIssues,
      })
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Failed to update SQL' }

    // Provenance: user is hand-editing SQL. human_modified when overwriting
    // an AI value (the calibration-loop signal); human_authored when
    // overwriting a previously hand-authored value or a blank.
    void logAIEdit({
      projectId: tfmRow.project_id,
      actorId: user.id,
      entityType: 'transformation',
      entityId: transformationId,
      fieldPath: 'generated_sql',
      oldValue: previousSql,
      newValue: cleanSql,
      editKind: wasAiGenerated ? 'human_modified' : 'human_authored',
      metadata: { previous_status: tx.status, next_status: newStatus },
    })

    // The user now owns this transformation — clear the parent TFM's stale
    // AI metadata (ai_reasoning narrative + transformation_intent + confidence).
    await clearStaleAiMetadataForTransformEdit({
      tfmId: tx.target_field_mapping_id,
      projectId: tfmRow.project_id,
      actorId: user.id,
      currentReasoning: tfmRow.ai_reasoning,
      currentTransformationIntent: tfmRow.transformation_intent,
      combinationType: tfmRow.combination_type,
    })

    return { success: true }
  })
}

// ─── ensureValueAssignment ────────────────────────────────────────────────────
//
// Idempotent commit-trigger for Value Assignment fields (Variant C of the
// Deferred-Creation pattern, introduced in Phase C2 of the VA UI unification).
// Atomically guarantees both sides of a VA's two-row identity exist:
//
//   1. A `target_field_mappings` row with `combination_type='custom_sql'` and
//      zero `mapping_sources` — delegated to `createValueAssignment` so the
//      bare-ack deletion logic (mappings.ts :: createValueAssignment, ~L2203)
//      stays in one place. The id returned is always the NEW TFM id: if a
//      bare-ack TFM was present, `createValueAssignment` DELETEs it (FK
//      CASCADE drops any orphan `transformations` row per migration 074
//      :: ADD COLUMN target_field_mapping_id … ON DELETE CASCADE) before
//      inserting a fresh VA TFM via the `dq_create_target_field_mapping` RPC.
//
//   2. A `transformations` row keyed on the NEW TFM id, with the caller's
//      initial `sql` / `description` (or empty strings when omitted). Status
//      is always 'draft'; `is_ai_generated` is false unless the caller is
//      explicitly capturing AI-generated SQL. Re-calls that find an existing
//      row are a no-op — callers are expected to update via the dedicated
//      write paths (`generateTransform`, `updateTransformSQL`,
//      `autoSaveTransform`) rather than re-seeding.
//
// This is the single entry point for the three Variant C commit triggers —
// AI Suggest, Generate SQL, Test Transform — from `TransformContent.tsx`.
// Each trigger calls the client-side `ensureValueAssignmentOnce` wrapper,
// which dedupes concurrent invocations (Race 3A) via an in-flight ref.
//
// BARE-ACK INVARIANT (verified by the Phase C2 DB integrity test):
//   The `transformationId` returned in the response object ALWAYS keys on
//   the VA TFM's id — never on a pre-existing bare-ack id — because
//   `createValueAssignment` returns the post-delete, post-insert id and we
//   upsert `transformations` strictly on that id. No orphan
//   `transformations` row can survive a bare-ack → VA transition.

export async function ensureValueAssignment(
  projectId: string,
  tableMappingId: string,
  targetFieldId: string,
  initialSql?: string | null,
  initialDescription?: string | null,
): Promise<{
  success: boolean
  fieldMappingId?: string
  transformationId?: string
  error?: string
  errorCode?: TransformWriteErrorCode
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated', errorCode: 'PERMISSION_DENIED' }

  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error, errorCode: 'PERMISSION_DENIED' }

  return guardWrites(projectId, async () => {
    // Dynamic import: `mappings.ts` imports symbols from this file at the
    // module top (resetFieldTransform, checkFieldMappingHasTransform, …), so
    // a top-level `import { createValueAssignment } from '@/lib/actions/mappings'`
    // would form an import cycle. Deferring via dynamic import keeps both
    // modules initialisable in any order.
    const { createValueAssignment } = await import('@/lib/actions/mappings')

    const vaResult = await createValueAssignment(projectId, tableMappingId, targetFieldId)
    if (!vaResult.success || !vaResult.fieldMappingId) {
      return {
        success: false,
        error: vaResult.error ?? 'Could not create value assignment',
        errorCode:
          vaResult.errorCode === 'MAINTENANCE_MODE'
            ? 'MAINTENANCE_MODE'
            : vaResult.errorCode === 'PERMISSION_DENIED'
            ? 'PERMISSION_DENIED'
            : vaResult.errorCode === 'VALIDATION'
            ? 'VALIDATION'
            : 'INTERNAL',
      }
    }

    const fieldMappingId = vaResult.fieldMappingId

    // Idempotent: skip the transformations insert if a row already exists
    // for this TFM id. Callers update through the dedicated write paths
    // (`generateTransform`, `updateTransformSQL`, `autoSaveTransform`) —
    // not through re-seeding.
    const { data: existingTx } = await supabaseAdmin
      .from('transformations')
      .select('id')
      .eq('target_field_mapping_id', fieldMappingId)
      .maybeSingle<Pick<TransformationRow, 'id'>>()

    if (existingTx) {
      return { success: true, fieldMappingId, transformationId: existingTx.id }
    }

    const { data: created, error: insertErr } = await supabaseAdmin
      .from('transformations')
      .insert({
        target_field_mapping_id: fieldMappingId,
        description: (initialDescription ?? '').trim() || null,
        generated_sql: initialSql ?? '',
        is_ai_generated: false,
        status: 'draft' as TransformationStatus,
        test_results: null,
      })
      .select('id')
      .single<Pick<TransformationRow, 'id'>>()

    if (insertErr || !created) {
      return {
        success: false,
        error: insertErr?.message ?? 'Failed to create transformation row',
        errorCode: 'INTERNAL',
      }
    }

    revalidatePath(`/app/projects/${projectId}`, 'layout')
    // PR-4: dashboard tile transforms.complete tracks transformations.
    revalidatePath('/app/projects')
    return { success: true, fieldMappingId, transformationId: created.id }
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
    .select('id, target_field_mapping_id, generated_sql, is_ai_generated')
    .eq('id', transformationId)
    .maybeSingle<
      Pick<
        TransformationRow,
        'id' | 'target_field_mapping_id' | 'generated_sql' | 'is_ai_generated'
      >
    >()
  if (!tx) return { success: false, error: 'Transformation not found' }

  const { data: tfmRow } = await supabaseAdmin
    .from('target_field_mappings')
    .select('project_id, ai_reasoning, transformation_intent, combination_type')
    .eq('id', tx.target_field_mapping_id)
    .single<{
      project_id: string
      ai_reasoning: string | null
      transformation_intent: string | null
      combination_type: string | null
    }>()
  if (!tfmRow) return { success: false, error: 'Transformation not found' }

  const perm = await requireProjectPermission(tfmRow.project_id, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  return guardWrites(tfmRow.project_id, async () => {
    const cleanSql = sql.replace(/;+$/, '').trim()
    const newSql = cleanSql || sql
    const updates: Record<string, unknown> = {
      generated_sql: newSql,
      description: description.trim() || null,
    }
    if (status) updates.status = status

    const previousSql = tx.generated_sql ?? null
    const wasAiGenerated = tx.is_ai_generated === true

    const { error } = await supabase
      .from('transformations')
      .update(updates)
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Auto-save failed' }

    // Only emit when the SQL actually changed; description-only saves
    // do not produce an ai_edit_history entry.
    if (newSql !== previousSql) {
      void logAIEdit({
        projectId: tfmRow.project_id,
        actorId: user.id,
        entityType: 'transformation',
        entityId: transformationId,
        fieldPath: 'generated_sql',
        oldValue: previousSql,
        newValue: newSql,
        editKind: wasAiGenerated ? 'human_modified' : 'human_authored',
        metadata: { source: 'auto_save' },
      })
    }

    // The user now owns this transformation — clear the parent TFM's stale
    // AI metadata (ai_reasoning narrative + transformation_intent +
    // confidence). Runs on every auto-save (SQL or description); the helper's
    // non-null guards make a debounced re-save a no-op for ai_reasoning and
    // transformation_intent, and the confidence clear is idempotent.
    await clearStaleAiMetadataForTransformEdit({
      tfmId: tx.target_field_mapping_id,
      projectId: tfmRow.project_id,
      actorId: user.id,
      currentReasoning: tfmRow.ai_reasoning,
      currentTransformationIntent: tfmRow.transformation_intent,
      combinationType: tfmRow.combination_type,
    })

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

  // Phase 4a-6 — same routing logic as `applyTransform` so cross-table
  // FK ambiguity is surfaced consistently. The underlying live-preview
  // RPC (`execute_transform_test`) operates on a single `data_rows`
  // partition and cannot LATERAL-join, so we still fetch the dominant
  // table's fields below — joined-table refs in the user's SQL would
  // resolve against dominant rows only. Cross-table preview parity
  // with apply is tracked under Phase 4-extras.
  let crossTableJoinSpec: Awaited<ReturnType<typeof buildJoinSpec>> | null = null
  if (!isValueAssignment) {
    crossTableJoinSpec = await buildJoinSpec(ctx.tfm.id, supabaseAdmin)
    if (!crossTableJoinSpec.ok) {
      return {
        success: false,
        error: crossTableJoinSpec.error,
        errorCode: crossTableJoinSpec.errorCode,
      }
    }
    // PR ζ.1 diagnostic — see applyTransform for context.
    if (!crossTableJoinSpec.spec && QUALIFIED_REF_HEURISTIC.test(sql)) {
      console.warn('[testTransformation] buildJoinSpec returned null spec for qualified-ref SQL', {
        tfmId: ctx.tfm.id,
        sqlPreview: sql.slice(0, 200),
      })
    }
  }

  // PR ζ.1 client-side hot-fix: see applyTransform for context. Runs
  // before any RPC call so iccomcod-style literals containing "DROP"
  // are accepted instead of bouncing through the RPC's
  // not-literal-aware blocklist.
  try {
    assertNoDml(sql.trim())
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : 'Transform contains a DML keyword in a non-literal position'
    return { success: false, error: msg }
  }

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

  // Cross-table: prefer the qualified-aware overload so the same
  // `Table.Field` refs the apply path will accept also tokenize
  // correctly here (the dominant-table portion will preview;
  // joined-table refs resolve to NULL until cross-table preview
  // parity ships).
  let wrappedSql: string
  if (
    crossTableJoinSpec &&
    crossTableJoinSpec.ok &&
    crossTableJoinSpec.spec &&
    crossTableJoinSpec.fieldMap
  ) {
    try {
      wrappedSql = wrapFieldRefsInJsonb(sql.trim(), crossTableJoinSpec.fieldMap)
      // The execute_transform_test RPC doesn't accept aliases — strip
      // them down to bare row_data refs (the dominant table is the
      // execution scope; joined refs collapse to NULL there).
      wrappedSql = wrappedSql.replace(/\b[A-Za-z_][A-Za-z0-9_]*\.row_data->>'/g, "row_data->>'")
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : 'Cross-table transforms must use table-qualified field references.'
      return { success: false, error: msg }
    }
  } else {
    wrappedSql = wrapFieldRefsInJsonb(sql.trim(), fieldNames)
  }

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
    .select('id, target_field_mapping_id, status')
    .eq('id', transformationId)
    .maybeSingle<
      Pick<TransformationRow, 'id' | 'target_field_mapping_id' | 'status'>
    >()
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
    const previousStatus = tx.status
    const { error } = await supabase
      .from('transformations')
      .update({ status: 'saved' as TransformationStatus })
      .eq('id', transformationId)

    if (error) return { success: false, error: 'Failed to save transformation' }

    // Provenance: status-only flip. The function name is "save" but the
    // mutation is a status acceptance, not an SQL edit (SQL edits flow
    // through updateTransformSQL/autoSaveTransform). human_accepted is
    // the right edit_kind — the user is committing the existing value.
    void logAIEdit({
      projectId: tfmRow.project_id,
      actorId: user.id,
      entityType: 'transformation',
      entityId: transformationId,
      fieldPath: 'status',
      oldValue: previousStatus,
      newValue: 'saved',
      editKind: 'human_accepted',
    })

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
  /**
   * Count of VAs skipped because their `target_field_mappings.combination_sql`
   * is already populated (Path D-authored literal or user-edited draft).
   * Per-row `generateTransform` invocations bypass this skip — direct
   * invocation on a VA still runs the agent unconditionally.
   */
  skipped?: number
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
    .select('id, org_id')
    .eq('id', projectId)
    .single()
  if (!project) return { success: false, generated: 0, failed: 0, error: 'Project not found' }

  const { org_id } = project as typeof project & { org_id: string }
  snapshotTemplate(projectId, org_id).catch((err) =>
    console.error('[templates] snapshot failed:', err),
  )

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

    if (targets.length === 0) return { success: true, generated: 0, failed: 0, skipped: 0 }

    // Skip VAs whose `combination_sql` is already populated (Path D-authored
    // literal or user draft). The literal IS the answer; re-running the agent
    // risks drift. FieldItem does not expose combination_sql, so we batch-
    // fetch the column for the candidate TFM ids. Mapped TFMs are never
    // skipped — combination_sql is owned by VA-author flows and is null for
    // mapped TFMs in production. Per-row `generateTransform` is unchanged.
    const vaCandidateIds = targets
      .filter((f) => f.isValueAssignment)
      .map((f) => f.fieldMappingId)
    const skipIds = new Set<string>()
    if (vaCandidateIds.length > 0) {
      const { data: comboRows } = await supabaseAdmin
        .from('target_field_mappings')
        .select('id, combination_sql')
        .in('id', vaCandidateIds)
      for (const row of (comboRows ?? []) as { id: string; combination_sql: string | null }[]) {
        if (row.combination_sql != null && row.combination_sql.trim().length > 0) {
          skipIds.add(row.id)
        }
      }
    }

    let generated = 0
    let failed = 0
    let skipped = 0

    for (const field of targets) {
      if (skipIds.has(field.fieldMappingId)) {
        skipped++
        continue
      }
      const autoDesc = field.typeCompatibility
        ? `Transform ${field.sourceFieldName} to ${field.targetFieldName}: ${field.typeCompatibility}`
        : `Map ${field.sourceFieldName} (${field.sourceFieldDataType}) to ${field.targetFieldName} (${field.targetFieldDataType})`

      const result = await generateTransform(field.fieldMappingId, autoDesc)
      if (result.success) generated++
      else failed++
    }

    return { success: true, generated, failed, skipped }
  })
}

// ─── (retired in Phase 4a-6) Cross-table transparency helpers ────────────────
//
// Phase 4a-3 introduced two helpers — `isCrossTableTfm` and
// `projectHasCrossTableMappings` — to power a three-layer transparency
// stack (action error code + Transform tab disabled buttons + drawer
// Sources badge) preventing users from triggering the stubbed
// cross-table branch of `dq_apply_field_transform_joined`. Phase 4a-6
// wired that branch via migration 076 + `buildJoinSpec`
// (`lib/utils/transform-cross-table.ts`) and retired the transparency
// stack — both helpers are deleted; `applyTransform` /
// `testTransformation` route through the joined RPC directly.
//
// Historical narrative is preserved in
// `docs/features/mapping-redesign.md` (Phase 4a-6 section). For the
// retired implementation see this file at any commit between Phase
// 4a-3 and 4a-6 (or the migration 074 docstring).

// ─── applyTransform ───────────────────────────────────────────────────────────
//
// Applies a single TFM's transform to staged_data_rows.
//
// Mapped TFMs        → `dq_apply_field_transform_joined(tfmId, tgt_name, sql, p_join_spec)`.
//                      Same-table TFMs pass `p_join_spec = NULL`.
//                      Cross-table TFMs derive `p_join_spec` from
//                      `buildJoinSpec(tfmId, supabase)` — the helper
//                      dedupes per-source `mapping_sources` rows to
//                      per-table joins and re-derives the FK
//                      relationship when stored `join_spec` is null
//                      (parity with the read path's annotation
//                      derivation). Re-derivation that yields 0 or
//                      2+ FK candidates returns
//                      `CROSS_TABLE_FK_INFERENCE_FAILED` before the
//                      RPC is invoked. The cross-table-aware overload
//                      of `wrapFieldRefsInJsonb` rewrites
//                      `Table.Field` references to `<alias>.row_data->>'Field'`
//                      using aliases that match the join_spec.
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
    .select('id, status')
    .eq('target_field_mapping_id', resolved.tfmId)
    .maybeSingle<{ id: string; status: TransformationStatus }>()
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

  // Phase 4a-6 — derive p_join_spec for cross-table TFMs. Helper
  // returns `spec=null` for same-table TFMs (RPC's same-table branch
  // is preserved byte-for-byte from migration 074). FK ambiguity at
  // apply time short-circuits with CROSS_TABLE_FK_INFERENCE_FAILED.
  let joinSpec: Awaited<ReturnType<typeof buildJoinSpec>> | null = null
  if (!isValueAssignment) {
    joinSpec = await buildJoinSpec(ctx.tfm.id, supabaseAdmin)
    if (!joinSpec.ok) {
      return {
        success: false,
        rowsAffected: 0,
        error: joinSpec.error,
        errorCode: joinSpec.errorCode,
      }
    }
    // PR ζ.1 diagnostic: AI emitted qualified "Table.Field" refs but
    // buildJoinSpec returned null spec — apply will route to same-table
    // fallback which can't resolve the qualifier. Surfaces the
    // silent-degrade described in /tmp/pr-zeta-1-investigation.md §1
    // (Path B). Remove once Rootstock loader is confirmed correct.
    if (!joinSpec.spec && QUALIFIED_REF_HEURISTIC.test(sql)) {
      console.warn('[applyTransform] buildJoinSpec returned null spec for qualified-ref SQL', {
        tfmId: ctx.tfm.id,
        sqlPreview: sql.slice(0, 200),
      })
    }
  }

  return guardWrites(ctx.projectId, async () => {
    const tgtField = ctx.targetField
    let totalRows = 0

    if (!isValueAssignment) {
      // ── Mapped TFM — single call via the joined RPC ─────────────────────────
      const srcField = ctx.primarySource!.sourceField!
      const cleaned = sql.replace(/;+$/, '').trim()
      // PR ζ.1 client-side hot-fix: short-circuit DML false-positives
      // from data literals containing keywords like "DROP". RPC-side
      // structural fix deferred to PR ζ.2 (migration 105).
      try {
        assertNoDml(cleaned)
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : 'Transform contains a DML keyword in a non-literal position'
        return { success: false, rowsAffected: 0, error: msg }
      }
      const okSpec = joinSpec as Extract<typeof joinSpec, { ok: true }>

      let wrappedSql: string
      let p_join_spec: unknown = null

      if (okSpec.spec && okSpec.fieldMap) {
        // Cross-table — qualify field refs against the per-table alias map.
        try {
          wrappedSql = wrapFieldRefsInJsonb(cleaned, okSpec.fieldMap)
        } catch (e) {
          const msg =
            e instanceof Error
              ? e.message
              : 'Cross-table transforms must use table-qualified field references.'
          return { success: false, rowsAffected: 0, error: msg }
        }
        p_join_spec = okSpec.spec
      } else {
        // Same-table — preserve the existing flat field-name list path.
        const { data: allSourceFields } = await supabase
          .from('fields')
          .select('name')
          .eq('table_id', srcField.table_id)
        const fieldNames = (allSourceFields ?? []).map((f) => f.name)
        wrappedSql = wrapFieldRefsInJsonb(cleaned, fieldNames)
      }

      const { data: rowsAffected, error: rpcErr } = await supabase.rpc(
        'dq_apply_field_transform_joined',
        {
          p_target_field_mapping_id: ctx.tfm.id,
          p_target_field_name: tgtField.name,
          p_transform_sql: wrappedSql,
          p_join_spec,
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

        const { data: rowsAffected, error: rpcErr } = await supabase.rpc(
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

    // Call into staged-row-flags best-effort. Function is functional
    // as of Prompt 3d commit; try/catch retained as defense against
    // unexpected runtime errors (network, DB, RPC failures).
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

    // Provenance: status flip 'tested'/'applied' → 'applied'. Only emit
    // when we actually have a transformation row (idempotent re-applies
    // and missing-row no-ops both arrive here).
    if (trans) {
      void logAIEdit({
        projectId: ctx.projectId,
        actorId: user.id,
        entityType: 'transformation',
        entityId: trans.id,
        fieldPath: 'status',
        oldValue: trans.status,
        newValue: 'applied',
        editKind: 'human_accepted',
        metadata: { rows_affected: totalRows },
      })
    }

    revalidatePath(`/app/projects/${ctx.projectId}`, 'layout')
    // PR-4: dashboard tile transforms.complete tracks transformations.
    revalidatePath('/app/projects')
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
    // Capture the row first so we can emit a structured-diff provenance
    // event with the pre-revert id.
    const { data: txBefore } = await supabaseAdmin
      .from('transformations')
      .select('id, status')
      .eq('target_field_mapping_id', ctx.tfm.id)
      .maybeSingle<{ id: string; status: TransformationStatus }>()

    await supabaseAdmin
      .from('transformations')
      .update({ status: 'tested' as TransformationStatus })
      .eq('target_field_mapping_id', ctx.tfm.id)
      .eq('status', 'applied')

    // Provenance: revert is a human_rejected event on the previous
    // 'applied' state. Only emit when we found an applied row to revert.
    if (txBefore && txBefore.status === 'applied') {
      void logAIEdit({
        projectId: ctx.projectId,
        actorId: user.id,
        entityType: 'transformation',
        entityId: txBefore.id,
        fieldPath: 'status',
        oldValue: 'applied',
        newValue: 'tested',
        editKind: 'human_rejected',
        metadata: { rows_reverted: totalReverted },
      })
    }

    revalidatePath(`/app/projects/${ctx.projectId}`, 'layout')
    // PR-4: dashboard tile transforms.complete tracks transformations.
    revalidatePath('/app/projects')
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

CONTEXT BLOCKS:
The user message may include <poc_answer_key authoritative="true"> (highest authority — follow literally), <project_decisions> (recorded business outcomes — honor decided customer_decision over pending ai_recommendation), <lookup_tables> (reusable value dictionaries — reference them by name when the mapping involves a known code list), and <transformation_intent> (per-TFM recipe from the upstream mapping pass). When these blocks describe specific mappings, value lists, or rules, the suggested description should reflect them rather than restate generic instructions. Authority order: poc_answer_key > project_decisions.customer_decision > transformation_intent > project_decisions.ai_recommendation > schema/business docs > general training.

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
  const pocBlock = formatPocAnswerKeyBlock(aiCtx.documents.poc_answer_key)

  const { decisions: projectDecisions, lookupTables: projectLookupTables } =
    await loadProjectContextBlocks(ctx.projectId)
  const lookupTablesBlock = formatLookupTablesBlock(projectLookupTables)
  const projectDecisionsBlock = formatProjectDecisionsBlock(projectDecisions)
  const resolvedIntent = resolveTransformationIntent(
    ctx.tfm.transformation_intent,
    ctx.tfm.ai_reasoning,
  )
  const transformationIntentBlock = formatTransformationIntentBlock(resolvedIntent)

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

  // Same assembly order as generateTransform — POC last for positional authority.
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
Transformation suggestion: ${resolvedIntent ?? 'Not available'}
</mapping_context>
${lookupTablesBlock ? '\n' + lookupTablesBlock + '\n' : ''}${projectDecisionsBlock ? '\n' + projectDecisionsBlock + '\n' : ''}${docsBlock}
${aiCtx.intelligence_context ? aiCtx.intelligence_context + '\n\n' : ''}${transformationIntentBlock ? transformationIntentBlock + '\n\n' : ''}${pocBlock ? pocBlock + '\n\n' : ''}Suggest a transformation description for this field mapping.`

  let suggestion: string
  let llmCallId: string | null = null
  try {
    const result = await callLLM({
      feature: 'transform_describe',
      systemPrompt: withProvenanceGuidance(SUGGEST_SYSTEM_PROMPT),
      userMessage,
      maxTokens: 256,
      projectId: ctx.projectId,
      userId: user.id,
      promptVersion: 'transform-describe-v1',
      abuseUserId: user.id,
      metadata: { tfm_id: ctx.tfm.id },
    })
    // PR 12.2 B-2: stay-text callsite (1-2 sentence prose — tool-use here
    // is overkill, per Phase A §2.5). No `tool` is passed.
    suggestion = result.kind === 'text' ? result.text : ''
    llmCallId = result.callId
  } catch {
    return { success: false, error: 'AI suggestion failed. Please describe the transformation manually.' }
  }

  const trimmed = suggestion.trim()

  // Provenance: the suggestion does not mutate any DB row, but we record it
  // anchored on the parent TFM so the eval harness can later answer "did
  // the user accept the AI's suggested description in their generateTransform
  // call?" The fieldPath is virtual (not a transformations column) — the
  // generateTransform emit owns the actual generated_sql provenance.
  void logAIEdit({
    projectId: ctx.projectId,
    actorId: user.id,
    entityType: 'target_field_mapping',
    entityId: ctx.tfm.id,
    fieldPath: 'ai_suggested_description',
    oldValue: null,
    newValue: trimmed,
    editKind: 'ai_proposed',
    llmCallId,
    metadata: { tfm_id: ctx.tfm.id },
  })

  return { success: true, suggestion: trimmed }
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
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('target_field_mappings')
    .update({ needs_transformation: false })
    .eq('id', resolved.tfmId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to dismiss transform: ${error.message}`)

  // Provenance: user is dismissing the AI's "needs transformation" flag
  // for this TFM — a human_rejected event on that signal.
  if (user) {
    void logAIEdit({
      projectId,
      actorId: user.id,
      entityType: 'target_field_mapping',
      entityId: resolved.tfmId,
      fieldPath: 'needs_transformation',
      oldValue: true,
      newValue: false,
      editKind: 'human_rejected',
    })
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  // PR-4: dashboard tile transforms.complete tracks transformations.
  revalidatePath('/app/projects')
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
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('target_field_mappings')
    .update({ needs_transformation: true })
    .eq('id', resolved.tfmId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to reinstate transform: ${error.message}`)

  // Provenance: user is reverting a previous dismissal of the
  // "needs transformation" flag — human_modified on that signal.
  if (user) {
    void logAIEdit({
      projectId,
      actorId: user.id,
      entityType: 'target_field_mapping',
      entityId: resolved.tfmId,
      fieldPath: 'needs_transformation',
      oldValue: false,
      newValue: true,
      editKind: 'human_modified',
    })
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  // PR-4: dashboard tile transforms.complete tracks transformations.
  revalidatePath('/app/projects')
  return { success: true }
}

// ─── Dismiss / reinstate value-assignment requirement (migration 077) ────────
//
// Mirrors the `dismissTransformNeeded` / `reinstateTransformNeeded` pair above
// but operates on the symmetric VA-side flag `target_field_mappings.va_dismissed`.
//
// Asymmetry rationale (investigation finding 7)
//   `dismissTransformNeeded(projectId, fieldMappingId)` — mapped TFM always
//   exists by the time the user can click Dismiss (the mapping itself created
//   the TFM at approve-time).
//
//   `dismissValueAssignment(projectId, targetFieldId, tableMappingId)` — the
//   underlying TFM may NOT exist yet. The redesigned Transform path uses the
//   "Deferred Creation Pattern" (Variant C) for unmapped target fields: the
//   sidebar synthesises a placeholder FieldItem and a real TFM is created
//   only at one of the explicit commit triggers (AI Suggest / Generate SQL /
//   Test Transform). Dismissal becomes a fourth commit trigger. Threading the
//   create + flip into a single server action keeps the user intent atomic.
//
//   The shared TFM-creation primitive is `createValueAssignment` in
//   `lib/actions/mappings.ts` — already used by `ensureValueAssignment`
//   (which adds a draft `transformations` insert on top). Dismissal does
//   NOT insert a transformation row: the whole point of dismissal is "no
//   value will be generated for this field."
//
//   `reinstateValueAssignment(projectId, fieldMappingId)` — TFM always
//   exists by definition (you can only reinstate a previously-dismissed
//   field, which means a TFM already exists). Symmetric to
//   `reinstateTransformNeeded`.
//
// Existing transformation rows
//   Following the precedent from `dismissTransformNeeded`, neither action
//   touches the `transformations` table. The Transform editor gates the
//   "Dismiss" link on "VA without saved value" so the conflict case ("apply
//   then dismiss") is not reachable through the supported UX. If callers
//   ever construct it programmatically, the dismissal flag and the applied
//   transform row coexist; downstream readers (`_outputs-helpers`,
//   `migration-intelligence`, `migration-runbook`, `stat-formulas`) treat
//   `va_dismissed = true` as the authoritative signal and skip such TFMs
//   from load SQL / scope counts entirely.

/**
 * Marks a value-assignment field as NOT needing a value during migration.
 * Used for fields with database defaults, auto-generated values, or fields
 * intentionally left null. Atomically creates the underlying VA TFM via
 * `createValueAssignment` if one does not already exist, then sets
 * `va_dismissed = true`. Does NOT insert or modify any transformations row.
 *
 * Throw-on-error semantics match `dismissTransformNeeded`.
 */
export async function dismissValueAssignment(
  projectId: string,
  targetFieldId: string,
  tableMappingId: string,
  reason?: string,
): Promise<{ success: boolean; fieldMappingId?: string; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  await assertMappingWritesEnabled(projectId)
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Dynamic import: `mappings.ts` imports symbols from this file at the
  // module top, so a top-level import of `createValueAssignment` would
  // form an import cycle (same pattern as `ensureValueAssignment`).
  const { createValueAssignment } = await import('@/lib/actions/mappings')

  const vaResult = await createValueAssignment(projectId, tableMappingId, targetFieldId)
  if (!vaResult.success || !vaResult.fieldMappingId) {
    return {
      success: false,
      error: vaResult.error ?? 'Could not prepare value assignment for dismissal',
    }
  }

  const fieldMappingId = vaResult.fieldMappingId

  const { error } = await supabaseAdmin
    .from('target_field_mappings')
    .update({
      va_dismissed: true,
      needs_transformation: false,
      dismissal_reason: reason?.trim() ? reason.trim() : null,
    })
    .eq('id', fieldMappingId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to dismiss value assignment: ${error.message}`)

  if (user) {
    void logAIEdit({
      projectId,
      actorId: user.id,
      entityType: 'target_field_mapping',
      entityId: fieldMappingId,
      fieldPath: 'needs_transformation',
      oldValue: true,
      newValue: false,
      editKind: 'human_rejected',
    })
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  // PR-4: value-assignment dismissal shifts transforms.total on the tile.
  revalidatePath('/app/projects')
  return { success: true, fieldMappingId }
}

/**
 * Reinstates a previously-dismissed value-assignment requirement.
 * The TFM is left in place; only `va_dismissed` is flipped back to `false`.
 * Symmetric to `reinstateTransformNeeded`.
 */
export async function reinstateValueAssignment(
  projectId: string,
  fieldMappingId: string,
): Promise<{ success: boolean; error?: string }> {
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  await assertMappingWritesEnabled(projectId)
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const resolved = resolveTfmId(fieldMappingId)
  if (resolved.kind !== 'primary') {
    throw new Error(`Failed to reinstate value assignment: invalid id ${fieldMappingId}`)
  }

  const { error } = await supabaseAdmin
    .from('target_field_mappings')
    .update({ va_dismissed: false, needs_transformation: true, dismissal_reason: null })
    .eq('id', resolved.tfmId)
    .eq('project_id', projectId)

  if (error) throw new Error(`Failed to reinstate value assignment: ${error.message}`)

  if (user) {
    void logAIEdit({
      projectId,
      actorId: user.id,
      entityType: 'target_field_mapping',
      entityId: resolved.tfmId,
      fieldPath: 'needs_transformation',
      oldValue: false,
      newValue: true,
      editKind: 'human_modified',
    })
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  // PR-4: value-assignment reinstatement shifts transforms.total on the tile.
  revalidatePath('/app/projects')
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

  // Provenance: deletion is a human_rejected event on the transformation.
  // Best-effort auth.getUser() — this helper is called from already-guarded
  // write paths in mappings.ts, so the request always has a user; failure
  // to resolve simply skips the emit (fire-and-forget contract).
  try {
    const supabaseRls = await createClient()
    const {
      data: { user: actor },
    } = await supabaseRls.auth.getUser()
    if (actor) {
      void logAIEdit({
        projectId: ctx.projectId,
        actorId: actor.id,
        entityType: 'transformation',
        entityId: transform.id,
        fieldPath: 'status',
        oldValue: transform.status,
        newValue: null,
        editKind: 'human_rejected',
        metadata: {
          reason: 'mapping_edited',
          rows_reverted: rowsReverted,
        },
      })
    }
  } catch {
    // Non-critical — never fail the parent flow because of provenance logging.
  }

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

async function snapshotTemplate(projectId: string, orgId: string): Promise<void> {
  const data = await getTransformData(projectId)
  const srcSystem = data.datasets[0]?.datasetName ?? 'unknown'

  const { data: tgtDs } = await supabaseAdmin
    .from('datasets').select('name').eq('project_id', projectId).eq('role', 'target').limit(1)
  const tgtSystem = tgtDs?.[0]?.name ?? 'unknown'

  const mappings: CompletedMapping[] = data.datasets.flatMap(ds =>
    ds.tables.flatMap(tbl =>
      tbl.fields
        .filter(f => f.sourceFieldId && f.sourceFieldName && f.sourceFieldDataType)
        .map(f => ({
          sourceTableName: tbl.sourceTableName,
          sourceFieldName: f.sourceFieldName!,
          sourceDataType: f.sourceFieldDataType!,
          sourceIsNullable: f.sourceFieldIsNullable,
          sourceIsForeignKey: false,
          targetTableName: tbl.targetTableName,
          targetFieldName: f.targetFieldName,
          targetDataType: f.targetFieldDataType,
          targetIsNullable: f.targetFieldIsNullable,
          targetIsForeignKey: false,
          transformSql: f.transformation?.generated_sql ?? null,
          explanation: f.aiReasoning ?? '',
          confidence: f.confidence ?? 0,
        }))
    )
  )

  if (mappings.length === 0) return
  await saveTemplate(orgId, srcSystem, tgtSystem, mappings, [])
}

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
