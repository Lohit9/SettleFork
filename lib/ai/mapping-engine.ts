/**
 * Mapping engine — pure logic for transforming raw mapping data into
 * the redesign UI's view model. No 'use server' directive: this file
 * exports sync helpers and types alongside async functions.
 *
 * Server actions in lib/actions/mappings.ts and lib/actions/mappings-for-redesign.ts
 * call into this module. UI code MUST NOT import this file directly —
 * see tests/lib/no-engine-in-redesign-ui.test.ts for the enforcement.
 *
 * File convention: pure things first, side-effecting things last.
 *   1. Types
 *   2. Pure helpers (un-exported)
 *   3. Pure exported entry points (`assembleMappingsForRedesign`, …)
 *   4. DB-touching orchestrators (`getMappingsForRedesignCore`, future
 *      `runMappingGeneration`, `runMappingSuggestion`, …)
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import { callLLM, callLLMStreaming, type CallLLMResult } from '@/lib/ai/llm-client'
import { withProvenanceGuidance } from '@/lib/ai/agent-provenance-guidance'
import { type AgentLoopResult } from '@/lib/ai/agent-loop'
import {
  EMIT_TABLE_MAPPINGS_TOOL,
  EMIT_MAPPING_SUGGESTION_TOOL,
} from '@/lib/ai/tool-schemas'
import {
  buildAIContext,
  formatDocumentsForPrompt,
  formatPocAnswerKeyBlock,
  formatSchemaForPrompt,
  formatSchemaOverviewBlock,
} from '@/lib/ai/context-builder'
import type { TFMCombinationType } from '@/lib/types/mapping-redesign'
import type {
  JoinSpec,
  MappedRow,
  MappingCounts,
  MappingRow,
  MappingSourceRef,
  MappingTransformationStatus,
  MappingsForRedesignResult,
  PartitionInfo,
  SourceFieldAcknowledgmentSummary,
  SourceFieldWithState,
  SourceTableSummary,
  TargetFieldRef,
  TargetTableSummary,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import { inferFkCandidates } from '@/lib/utils/fk-inference'
import { runSingleAgentMappingLoop } from '@/lib/ai/single-agent-mapping'
import { findTemplate } from '@/lib/actions/migration-templates'
import type { MigrationTemplate } from '@/lib/validation/migration-template'
import { interpretCrossSystemSynonyms, interpretFieldDomains } from '@/lib/ai/field-interpreter'
import { validateMappingBatch, type MappingProposal } from '@/lib/validation/mapping-validator'
import { validateTransformSQL } from '@/lib/validation/transform-validator'
import { runSelfCorrectionLoop } from '@/lib/validation/self-correction'
import {
  getStaticSuggestionForTarget,
  resolveStaticSourceUnmappedRationale,
  type StaticSourceUnmappedInfo,
} from '@/lib/mappings/static-provider'

// ─── Raw row shapes fetched from Supabase ────────────────────────────
//
// Kept local to this module. They're a strict subset of the public
// `lib/types/mapping-redesign.ts` row shapes — just enough columns to
// assemble the redesign contract. Narrow upfront so downstream code
// has full type safety without `as any` escape hatches.

interface RawDatasetRow {
  id: string
  role: 'source' | 'target' | string
  name: string
}

interface RawTableRow {
  id: string
  dataset_id: string
  name: string
}

interface RawFieldRow {
  id: string
  table_id: string
  name: string
  data_type: string
  is_nullable: boolean | null
  is_primary_key: boolean | null
  is_foreign_key: boolean | null
  fk_reference: string | null
  default_value: string | null
  ordinal_position: number
  /**
   * PR 3a — added to surface DDL-derived description on the
   * target side. NULL for existing rows (migration 090 backfill is
   * "DEFAULT NULL"). Source-side reads of this column are unchanged.
   */
  description?: string | null
  field_profiles?: Array<{
    field_id: string
    sample_values: unknown
  }> | null
}

interface RawTfmRow {
  id: string
  target_field_id: string
  /**
   * PR Ω.3.2 — the partition (table_mapping) this TFM belongs to. NOT NULL
   * post-Ω.1 (migration 107 SET NOT NULL); the optional `?` only relaxes the
   * constraint for synthetic test fixtures.
   */
  table_mapping_id?: string | null
  confidence: number | null
  status: 'needs_review' | 'approved' | 'rejected' | string
  ai_reasoning: string | null
  is_acknowledged: boolean
  acknowledgment_reason: string | null
  combination_type: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql' | null | string
  combination_sql: string | null
  transformation_intent?: string | null
  needs_transformation?: boolean | null
}

/**
 * PR Ω.3.2 — `table_mappings` row read for partition tab strip + per-row
 * partition binding. Sourced from migration 107 (table_mapping_id, filter_sql,
 * partitions_enabled) + migration 111 (partition_label, partition_ordinal,
 * identity_field_id, dedup_priority).
 */
interface RawTableMappingRow {
  id: string
  source_table_id: string
  target_table_id: string
  partition_label: string | null
  partition_ordinal: number | null
  filter_sql: string | null
  identity_field_id: string | null
  dedup_priority: number | null
  created_at: string
}

interface RawMappingSourceRow {
  id: string
  target_field_mapping_id: string
  source_field_id: string | null
  source_table_id: string | null
  confidence: number | null
  ai_reasoning: string | null
  type_compatibility: string | null
  join_spec: unknown | null
  ordinal: number
}

interface RawSourceAckRow {
  id: string
  source_field_id: string
  reason: string
  /**
   * Migration 103 — user decision. Defaults to `'acknowledged'` on
   * pre-migration rows. Treated as an open string type because the DB
   * CHECK constraint enforces the two values; the read translator
   * coerces unknown values to `'acknowledged'` defensively.
   */
  decision?: 'acknowledged' | 'rejected' | string | null
}

interface RawTransformationRow {
  id: string
  target_field_mapping_id: string
  status: string | null
  // Q11.E lock (drawer redesign, 2026-04-26): added to power the
  // drawer-redesign Transformation section. `description` is the
  // human-authored intent line; `generated_sql` is the full SQL,
  // truncated server-side (`MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH`)
  // before being placed on `MappingRowBase.transformationSqlPreview`.
  description: string | null
  generated_sql: string | null
}

/**
 * One row of `target_field_coverage` (migration 093 + 095). Read by
 * `assembleMappingsForRedesign` to surface PR γ's `coverageStatus` /
 * `statusSetBy` row-prop fields and to drive the resolution-priority
 * rule for `UnmappedRow.status` (PR γ unification).
 *
 * Resolution priority for the row prop's effective `status` field:
 *   1. TFM exists       → status = TFM.status
 *   2. Coverage row     → status = coverage.status (per migration 095)
 *   3. Neither (orphan) → status = 'needs_review' synthesized
 *                         (statusSetBy = 'system_default')
 */
interface RawCoverageRow {
  id: string
  target_field_id: string
  coverage_status: 'covered' | 'partial' | 'gap' | 'optional' | 'out_of_scope' | string
  ai_reasoning?: string | null
  status: 'needs_review' | 'approved' | 'rejected' | string
  status_set_by: 'ai_auto' | 'user' | 'system_default' | string
  /**
   * PR γ.1 — AI confidence on no-source rows. Migration 096 added
   * the `confidence` column to target_field_coverage; Path D's
   * persistence layer writes the LLM's 0.0-1.0 emission directly
   * (mirrors the TFM convention). Pre-PR-γ.1 rows carry NULL and
   * render the em-dash branch of ConfidenceCell; post-merge rows
   * flow onto UnmappedRow.confidence for grid rendering.
   */
  confidence: number | null
}

/**
 * Server-side cap for `MappingRowBase.transformationSqlPreview`.
 * Mirrors the legacy mapping page preview length (see
 * `app/app/projects/[projectId]/mapping/MappingContent.tsx` Transform
 * tab preview block). Values longer than the cap are truncated and a
 * single `…` appended so the wire payload stays bounded.
 *
 * The standalone Transform page is the canonical surface for the full
 * SQL — the drawer is a glance-only consumer.
 */
const MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH = 300

/**
 * The raw inputs to `assembleMappingsForRedesign`. Exported so unit
 * tests can construct fixtures with full type checking.
 */
export interface AssembleInput {
  projectId: string
  datasets: RawDatasetRow[]
  tables: RawTableRow[]
  fields: RawFieldRow[]
  tfms: RawTfmRow[]
  mappingSources: RawMappingSourceRow[]
  sourceAcks: RawSourceAckRow[]
  transformations: RawTransformationRow[]
  /**
   * PR γ — Mapping grid state model unification. Optional with default
   * `[]` so existing fixture builders + tests don't have to thread an
   * empty coverage array; orphan target fields synthesize the
   * target_only row-prop shape (statusSetBy='system_default') when no
   * coverage row is present.
   */
  coverage?: RawCoverageRow[]
  /**
   * PR Ω.3.2 — `table_mappings` rows for the project. Drives partition
   * binding on every emitted MappingRow + populates the result envelope's
   * `partitionsByTargetTable`. Optional with default `[]` so pre-Ω.1
   * fixtures continue to compile; the wire core always passes a real
   * (possibly empty) array.
   */
  tableMappings?: RawTableMappingRow[]
  /**
   * PR Ω.3.2 — value of `projects.partitions_enabled`. Default false so
   * heritage fixtures don't need to thread the flag. The wire core reads
   * the column in Round 1 and forwards it onto the result envelope.
   */
  partitionsEnabled?: boolean
  /**
   * Display-only metadata for unmapped source fields, keyed by
   * `fields.id`. Sourced from the static-mappings config's
   * `explanation` + `confidence` fields via
   * `resolveStaticSourceUnmappedRationale`. Optional with default empty
   * `Map` — projects with no static config (and fixtures / tests)
   * simply omit it. Flows onto `SourceFieldWithState.aiReasoning` +
   * `SourceFieldWithState.confidence`.
   */
  staticSourceRationale?: ReadonlyMap<string, StaticSourceUnmappedInfo>
}

// Also export the raw row types so tests and future call sites can
// import them without duplicating the shapes.
export type {
  RawDatasetRow,
  RawTableRow,
  RawFieldRow,
  RawTfmRow,
  RawMappingSourceRow,
  RawSourceAckRow,
  RawTransformationRow,
  RawCoverageRow,
  RawTableMappingRow,
}

// ─── Mapping generation: Claude response shapes ──────────────────────
//
// The Claude API returns a JSON document shaped by
// `MAPPING_GENERATION_SYSTEM_PROMPT` (below). These types narrow the
// response so downstream handlers can access fields with full type
// safety. Exported because both `runMappingGeneration` (this file)
// and `runMappingGenerationForPair` (the regenerate-single-TM path
// in `lib/actions/mappings.ts`) consume them.

export interface ClaudeFieldMapping {
  source_field: string
  target_field: string
  confidence: number
  reasoning: string
  similar_fields_considered?: string[]
  type_compatibility?: string
  needs_transformation?: boolean
  mapping_type?: 'one_to_one' | 'many_to_one' | 'one_to_many'
  contributing_source_fields?: string[]
  combination_hint?: string
  split_hint?: string
  transform_sql?: string
}

export interface ClaudeTableMapping {
  source_table: string
  target_table: string
  confidence: number
  reasoning: string
  field_mappings: ClaudeFieldMapping[]
  // SET-36: structured value assignments for unmapped target fields
  unmapped_fields?: Array<{
    target_field: string
    assignment: string // "Constant: X" | "Leave NULL" | "Requires manual input"
    reasoning: string
  }>
}

export interface ClaudeResponse {
  table_mappings: ClaudeTableMapping[]
}

// ─── Mapping generation: system prompt ───────────────────────────────

/**
 * System prompt for the mapping-generation Claude call. Shared by
 * `runMappingGeneration` (initial-generation orchestrator, this file)
 * and `runMappingGenerationForPair` (per-pair regenerate path,
 * `lib/actions/mappings.ts`). Exported so both callers reference the
 * same canonical prompt.
 *
 * Locked content — see
 * `tests/actions/generate-mappings-orchestration.test.ts` Group A for
 * the verbatim section pins.
 */
// PR 13.1: Cached via Anthropic prompt caching (cacheControl: true).
// Editing this string invalidates the prompt cache; expect a 1-day cost
// spike after deploys that touch this prompt while the cache rewarms.
export const MAPPING_GENERATION_SYSTEM_PROMPT = `You are an enterprise data migration expert specializing in source-to-target schema mapping. Given source and target database schemas with sample data and optional documentation context, generate comprehensive mapping suggestions.

For each mapping, provide:
- A confidence score (0-100) based on how certain you are about the match
- Brief reasoning explaining WHY this mapping makes sense
- Alternative target fields you considered
- Type compatibility assessment — describe what specific conversion or validation is needed, not just whether types match. Examples: "VARCHAR → DECIMAL — strip $ and commas, parse to number", "VARCHAR → BOOLEAN — normalize Y/N/yes/no/1/0 to TRUE/FALSE", "VARCHAR(200) → VARCHAR(120) — truncation needed, 12 values exceed limit". If no conversion is needed, write "direct compatible — no conversion needed".
- Whether a transformation will be needed (see transformation rules below)

TRANSFORMATION RULES — A field needs_transformation = true if ANY of these apply:
1. DATA TYPE CONVERSION: Source data type must change to fit target (VARCHAR → DECIMAL, VARCHAR → DATE, VARCHAR → BOOLEAN, etc.)
2. VALUE MAPPING: Source values must be translated to different target values (e.g., "Won" → "Closed Won", "Technology" → "TECH"). Look at the value distribution — if source values don't match expected target picklist/enum values from documentation, this needs transformation.
3. FORMAT STANDARDIZATION: Source values are in inconsistent or wrong format for target (mixed date formats like "01/15/2024" and "2024-01-15" → ISO only, phone numbers needing E.164, currency strings like "$1,234.56" → numeric).
4. ID FORMAT CHANGE: Source uses one ID scheme, target uses another (e.g., "CUST-00001" → Salesforce 18-char alphanumeric ID).
5. BOOLEAN NORMALIZATION: Source uses mixed representations (Y/N, yes/no, 1/0, true/false) and target expects a specific boolean format. Check the value distribution for mixed boolean-like values.
6. CASING / CAPITALIZATION: Source values need systematic casing changes (e.g., "john" or "JOHN" → "John" for proper name fields). Check sample values for inconsistent casing.
7. TRUNCATION: Source values exceed target field's max length.
8. COMPUTATION: Target value must be derived (stripping currency symbols, concatenating fields, splitting fields).
9. FOREIGN KEY REFORMAT: A FK field whose referenced PK is being transformed (if customer_id → Account.Id changes format, then contact.customer_id → Contact.AccountId also needs transformation to stay consistent).

A field DOES NOT need transformation for:
- Naming convention differences only (snake_case vs camelCase, lowercase vs PascalCase) when data values pass through unchanged
- Minor type aliasing where data is compatible without conversion (TEXT vs VARCHAR, VARCHAR(100) vs VARCHAR(255) when no values exceed the smaller limit)
- Fields where source and target are semantically identical and values can be copied directly

MULTI-FIELD MAPPING PATTERNS:

You MUST detect and correctly map these patterns:

MANY-TO-ONE (multiple source fields → one target field):
When multiple source fields should be combined into a single target field, set:
- mapping_type: "many_to_one"
- source_field: the FIRST/PRIMARY source field name
- contributing_source_fields: array of ADDITIONAL source field names (do NOT repeat the primary)
- combination_hint: brief description of how to combine (e.g., "Concatenate with space separator")
- needs_transformation: true (always true for many-to-one)

Common many-to-one patterns:
- first_name + last_name → full_name, name, display_name, primary_contact
- street + city + state + zip → full_address, address
- date_field + time_field → datetime
- Any name component fields → a single combined name field

IMPORTANT: Return many-to-one as a SINGLE mapping entry (not separate entries for each source field). The contributing_source_fields array tells the system which other fields to include.

ONE-TO-MANY (one source field → multiple target fields):
When a single source field should be split into multiple target fields, create SEPARATE mapping entries for EACH target field, each with:
- mapping_type: "one_to_many"
- source_field: the SAME source field name in each entry
- target_field: DIFFERENT target field in each entry
- split_hint: description of what part to extract (e.g., "Extract first name", "Extract last name")
- needs_transformation: true (always true for one-to-many)

Common one-to-many patterns:
- full_name → first_name, last_name
- full_address → street, city, state, zip
- datetime → date, time

IMPORTANT: Each split target gets its OWN mapping entry in the field_mappings array. They share the same source_field but have different target_field values.

If a mapping is standard one-to-one, either omit mapping_type or set it to "one_to_one". Do NOT include contributing_source_fields or split_hint for one-to-one mappings.

TABLE-LEVEL MATCHING — WHEN TO EMIT A table_mapping:

You process ONE source table per request, but the migration contains OTHER source tables that will be processed in separate requests. When the user message includes an <other_source_tables> block, use that list to decide which targets actually deserve a mapping from the current source.

Rules for emitting table_mappings:

1. PRIMARY-MATCH RULE: Only emit a table_mapping when the current source table is the best (or a strong secondary) semantic match for the target. If another source table listed in <other_source_tables> is clearly a better primary match for a target — based on name similarity, field overlap, or business meaning — DO NOT emit a table_mapping to that target from the current source. Let the better-matching source table claim it when its own batch runs.

2. LOOKUP / REFERENCE TABLES: Narrow source tables whose shape is a code + description (typically 2-4 columns like CODE + DESC, ID + NAME, TYPE + LABEL — e.g., STATUS_CODES, COUNTRY_CODES, CURRENCY_CODES, PRODUCT_TYPES) represent enumerated reference data. They should map to AT MOST ONE target — the target table that stores the SAME enumeration (e.g., STATUS_CODES → account_status, COUNTRY_CODES → countries). They MUST NOT map to entity tables (customers, accounts, orders, contacts) even when an entity table has a matching status/type/code column — that column is populated via a foreign-key join at the field level, not by copying rows from the lookup table into the entity. Emitting a lookup → entity table_mapping is almost always wrong.

3. ENTITY TABLES: Wide tables representing business entities (e.g., CIF_MASTER → customers, ACCT_MASTER → accounts) should map to their corresponding entity target. Legitimate one-to-many entity mappings exist (denormalization, splitting), but each must have clear field-level overlap — not just one or two coincidental columns.

4. WEAK-OVERLAP RULE: If the current source has weak field overlap with a candidate target (fewer than roughly a third of the source's non-trivial fields map, OR only generic fields like id / name / created_at / updated_at match), DO NOT emit a table_mapping to that target — the target almost certainly belongs to a different source table. It is better to emit zero table_mappings for the current source than to emit low-quality mappings that the user will have to reject.

5. When in doubt between two candidate targets, pick the ONE target whose name and field set most closely mirrors the current source, and skip the others.

Scoring guidelines:
- 90-100: Near-certain match (identical names, same types, same business meaning)
- 75-89: High confidence (similar names, compatible types, clear business alignment)
- 50-74: Moderate confidence (partial name match, type conversion needed, or ambiguous business meaning)
- Below 50: Low confidence (weak signals, multiple possible targets)

Consider these signals when mapping:
- Field name similarity (camelCase vs UPPER_SNAKE_CASE conventions)
- Data type compatibility
- Business meaning and context from documentation
- Common enterprise patterns (Id→ID, Name→NAME, Email→EMAIL_ADDRESS)
- Primary/foreign key relationships
- Cardinality and value patterns from sample data
- Field position and grouping within tables

If documentation is provided, use it to:
- Identify exact value mappings (industry codes, stage values, status values)
- Understand target field constraints (picklist values, required formats, NOT NULL fields)
- Flag fields that need specific transformation logic based on documented rules
- Set higher confidence scores when documentation confirms a mapping from a business logic perspective. If documentation describes different data types or constraints than the structured schema, always follow the structured schema — it reflects the user's latest configuration.

CRITICAL: Respond with ONLY valid JSON, no markdown, no backticks, no explanation outside the JSON structure.

When needs_transformation is TRUE, you MUST also emit transform_sql: a PostgreSQL expression (not a full statement — no SELECT, FROM, WHERE, DDL, or DML keywords) converting the source value to the target representation. Reference source fields as row_data->>'FieldName'. No window functions. Explicit cast to target type. Examples:
- Boolean: CASE WHEN row_data->>'active' IN ('Y','yes','1') THEN true ELSE false END::BOOLEAN
- Value map: CASE WHEN row_data->>'stage' = 'Won' THEN 'Closed Won' ELSE row_data->>'stage' END
- Numeric cast: (row_data->>'amount')::NUMERIC
- Truncate: LEFT(row_data->>'description', 120)
- Concat: row_data->>'first_name' || ' ' || row_data->>'last_name'
Omit transform_sql when needs_transformation is FALSE.

UNMAPPED TARGET FIELDS — VALUE ASSIGNMENTS:

For target fields that have NO reasonable source field match, you MUST still include them in the output with structured value assignments. Add an "unmapped_fields" array at the table_mapping level:

"unmapped_fields": [
  {
    "target_field": "created_at",
    "assignment": "Constant: NOW()",
    "reasoning": "Target requires creation timestamp; no source equivalent"
  },
  {
    "target_field": "record_type",
    "assignment": "Constant: 'MIGRATED'",
    "reasoning": "Target enum field; migration records should be tagged"
  },
  {
    "target_field": "legacy_notes",
    "assignment": "Leave NULL",
    "reasoning": "Optional field; no source data available"
  }
]

Rules for unmapped_fields:
- Use EXACTLY "Constant: <value>" for fields that should get a default (use SQL literal syntax for the value)
- Use EXACTLY "Leave NULL" for nullable fields with no source and no sensible default
- Use EXACTLY "Requires manual input" for NOT NULL fields with no source and no computable default
- Do NOT use prose like "This field should be left empty" or "Not applicable" — use the exact formats above
- Include ALL target fields that you did not map to a source field`

// ─── PR 3.4a — Agent-mode system prompt ─────────────────────────────────────
// `MAPPING_GENERATION_AGENT_SYSTEM_PROMPT` is the original prompt + the
// AGENT_TOOL_GUIDANCE block. Adopters (PR 3.4b first) opt in per-call;
// the original constant is UNCHANGED for flag-OFF heritage.
// Spec: docs/investigations/pr3.4-mapping-agent-adoption.md §C1.
//
// PR 3.4cd commit 4: AGENT_TOOL_GUIDANCE moved to a dependency-free
// module (`agent-tool-guidance.ts`) to break a circular-import cycle
// between this file → multi-agent-orchestrator → multi-agent-prompts → here.
// Re-exported here for PR 3.4a consumers' import-path stability.
import { AGENT_TOOL_GUIDANCE } from '@/lib/ai/agent-tool-guidance'
export { AGENT_TOOL_GUIDANCE }

/** PR 3.4a — agent-mode prompt = original + AGENT_TOOL_GUIDANCE. */
export const MAPPING_GENERATION_AGENT_SYSTEM_PROMPT =
  MAPPING_GENERATION_SYSTEM_PROMPT + '\n\n' + AGENT_TOOL_GUIDANCE

// ─── PR 3.4b — Agent-loop helpers ────────────────────────────────────────────

const BUSINESS_CONTEXT_MAX_CHARS = 2000

/**
 * Read `projects.business_context` for the agent prompt prelude. Both
 * NULL and empty string read as "absent". Truncated to a hard ceiling
 * to bound prompt size.
 */
export async function readBusinessContext(
  supabase: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('projects')
    .select('business_context')
    .eq('id', projectId)
    .maybeSingle()
  const raw = (data as { business_context?: string | null } | null)?.business_context
  if (!raw || raw.trim().length === 0) return null
  return raw.slice(0, BUSINESS_CONTEXT_MAX_CHARS)
}

/**
 * Compose the agent-mode user message: optional business-context block +
 * schema-overview block + the existing base user message. Both preludes
 * are pre-pended so the model sees frame-setting context before the
 * detailed schema. Pure function.
 */
export function buildAgentUserMessage(args: {
  baseUserMessage: string
  schemaOverview: string
  businessContext: string | null
}): string {
  const sections: string[] = []
  if (args.businessContext) {
    sections.push(
      `<customer_business_context>\n${args.businessContext}\n</customer_business_context>`,
    )
  }
  if (args.schemaOverview) sections.push(args.schemaOverview)
  sections.push(args.baseUserMessage)
  return sections.join('\n\n')
}

/**
 * Adapter that maps a successful `AgentLoopResult` (kind='final') to the
 * existing `CallLLMResult` shape so the downstream persistence path is
 * untouched. Per-iteration token counters live on the `llm_calls` rows
 * the agent loop writes; the synthesized result zeroes those fields and
 * surfaces only the aggregate cost + the head-of-chain callId.
 */
export function synthesizeToolUseResult(
  result: AgentLoopResult & { kind: 'final' },
): CallLLMResult {
  const callId = result.callIds[result.callIds.length - 1] ?? ''
  return {
    kind: 'toolUse',
    toolUse: {
      name: result.finalToolUse.name,
      input: result.finalToolUse.input,
    },
    callId,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: result.totalCostUsd,
    anthropicRequestId: null,
  }
}

// ─── Row builders ────────────────────────────────────────────────────

/**
 * Exported for unit-test coverage (PR 3a). Production callers reach the
 * function only via `getMappingsForRedesignCore`'s row-build path; the
 * export keeps the row-translator boundary intact while letting
 * `tests/lib/mapping-engine-target-field-ref.test.ts` exercise the
 * additive field population (isPrimaryKey, isForeignKey, fkReference,
 * description, sampleValues) without spinning up a Supabase mock.
 * Mirrors the existing `buildAgentUserMessage` testability export.
 */
export function buildTargetFieldRef(
  field: RawFieldRow,
  tablesById: Map<string, RawTableRow>,
): TargetFieldRef | null {
  const table = tablesById.get(field.table_id)
  if (!table) return null
  return {
    id: field.id,
    name: field.name,
    dataType: field.data_type,
    // `fields.is_nullable` is nullable in the DB (legacy rows may be NULL).
    // Conservative default: treat missing as NULL-able (`true`) — matches
    // PostgreSQL's own default for unconstrained columns.
    isNullable: field.is_nullable === null ? true : field.is_nullable,
    defaultValue: field.default_value,
    targetTable: { id: table.id, name: table.name },
    ordinalPosition: field.ordinal_position,
    // PR 3a — additive read-shape extension for the drawer body
    // redesign's TARGET FIELD section. `is_primary_key` /
    // `is_foreign_key` are nullable in the DB schema (migration 002
    // declares DEFAULT false but legacy rows could carry NULL); we
    // coerce to `false` to match the DDL's semantic.
    isPrimaryKey: field.is_primary_key === true,
    isForeignKey: field.is_foreign_key === true,
    fkReference: field.fk_reference,
    description: field.description ?? null,
    sampleValues: extractSampleValues(field.field_profiles),
  }
}

function buildUnmappedRow(
  targetField: TargetFieldRef,
  coverageRow: RawCoverageRow | null,
  tfm: RawTfmRow | null,
  /**
   * PR Ω.3.8 — partition binding for the (collapsed) unmapped row.
   * `tableMappingId` is the canonical / first partition the collapsed row
   * spans; `tableMappingIds` carries the full set (`partitionLabel` is the
   * canonical partition's label). For the heritage / no-partitions case,
   * `tableMappingId` is null and `tableMappingIds` is `[]`.
   */
  partition: {
    tableMappingId: string | null
    partitionLabel: string | null
    tableMappingIds: string[]
  },
): UnmappedRow {
  // PR γ resolution priority for unmapped rows:
  //   coverage row exists  → status = coverage.status; statusSetBy =
  //                          coverage.status_set_by; coverageStatus =
  //                          coverage.coverage_status
  //   no coverage (orphan) → status = 'needs_review' (synthesized);
  //                          statusSetBy = 'system_default';
  //                          coverageStatus = null
  const status = coverageRow
    ? coerceStatus(coverageRow.status)
    : tfm
      ? coerceStatus(tfm.status)
      : 'needs_review'
  const statusSetBy: 'ai_auto' | 'user' | 'system_default' | null = coverageRow
    ? (coerceStatusSetBy(coverageRow.status_set_by) ?? 'system_default')
    : 'system_default'
  const coverageStatus = coverageRow
    ? coerceCoverageVerdict(coverageRow.coverage_status)
    : null
  // PR γ.1 — flow AI coverage confidence onto UnmappedRow.confidence.
  // Coverage row exists + has confidence  → row.confidence = that value
  // Coverage row exists, NULL confidence  → row.confidence = null (legacy
  //                                          pre-PR-γ.1 row; em-dash)
  // No coverage row (target_only orphan)  → row.confidence = null (em-dash)
  // ConfidenceCell renders the value with no special-casing — its
  // formatter is scale-tolerant per lib/utils/confidence-format.ts.
  const confidence: number | null =
    tfm && typeof tfm.confidence === 'number'
      ? tfm.confidence
      : coverageRow && typeof coverageRow.confidence === 'number'
        ? coverageRow.confidence
        : null

  // PR Ω.3.8 synthetic ID: always `unmapped::<target_field_id>`. Post-collapse
  // there is at most one unmapped row per target_field (covering every
  // partition that lacks a TFM), so the partition-suffixed long form from
  // PR Ω.3.2 is no longer needed for React-key uniqueness.
  const syntheticId = `unmapped::${targetField.id}`

  return {
    kind: 'unmapped',
    id: syntheticId,
    tableMappingId: partition.tableMappingId,
    tableMappingIds: partition.tableMappingIds,
    partitionLabel: partition.partitionLabel,
    targetField,
    confidence,
    aiReasoning: tfm?.ai_reasoning ?? coverageRow?.ai_reasoning ?? null,
    status,
    hasTransformation: false,
    transformationStatus: null,
    transformationDescription: null,
    transformationSqlPreview: null,
    transformationIntent: tfm?.transformation_intent ?? null,
    transformationNeeded: tfm?.needs_transformation ?? null,
    mapping_content: 'no-source',
    coverageStatus,
    statusSetBy,
  }
}

function buildValueAssignmentRow(
  tfm: RawTfmRow,
  targetField: TargetFieldRef,
  transformation: RawTransformationRow | null,
  coverageRow: RawCoverageRow | null,
  /**
   * PR Ω.3.8 — the (collapsed) partition binding for this VA row.
   * `tableMappingId` is the canonical partition (the one whose TFM uuid
   * lands on `id`); `tableMappingIds` carries every partition the VA
   * spans (Rootstock VAs replicate byte-identically across all
   * partitions of the target table, so this is typically all N).
   */
  partition: {
    tableMappingId: string | null
    partitionLabel: string | null
    tableMappingIds: string[]
  },
): ValueAssignmentRow {
  return {
    kind: 'value_assignment',
    id: tfm.id,
    tableMappingId: partition.tableMappingId,
    tableMappingIds: partition.tableMappingIds,
    partitionLabel: partition.partitionLabel,
    targetField,
    confidence: tfm.confidence,
    status: coerceStatus(tfm.status),
    hasTransformation: transformation !== null,
    transformationStatus: coerceTransformationStatus(
      transformation?.status ?? null,
      transformation !== null,
    ),
    transformationDescription: transformation?.description ?? null,
    transformationSqlPreview: buildTransformationSqlPreview(
      transformation?.generated_sql ?? null,
    ),
    transformationIntent: tfm.transformation_intent ?? null,
    transformationNeeded: tfm.needs_transformation ?? null,
    combinationType: 'custom_sql',
    combinationSql: tfm.combination_sql,
    aiReasoning: tfm.ai_reasoning,
    // PR γ — coverage metadata pass-through. VAs have zero sources
    // (custom_sql with empty mapping_sources). Effective row status
    // comes from TFM.status; coverage's status_set_by is the coverage
    // row's own provenance metadata, surfaced for the drawer.
    mapping_content: 'VA',
    coverageStatus: coverageRow
      ? coerceCoverageVerdict(coverageRow.coverage_status)
      : null,
    statusSetBy: coverageRow ? coerceStatusSetBy(coverageRow.status_set_by) : null,
  }
}

function buildMappedRow(
  tfm: RawTfmRow,
  targetField: TargetFieldRef,
  tfmSources: RawMappingSourceRow[],
  transformation: RawTransformationRow | null,
  tablesById: Map<string, RawTableRow>,
  fieldsById: Map<string, RawFieldRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
  coverageRow: RawCoverageRow | null,
  /**
   * PR Ω.3.8 — the (collapsed) partition binding for this mapped row.
   * `tableMappingId` is the canonical partition (the one whose TFM uuid
   * lands on `id`); `tableMappingIds` carries every partition where the
   * SAME (target_field, dominant source_field) tuple has a TFM. In
   * Rootstock today this is always length 1 because the loader funnels
   * each (target, source) tuple into exactly one partition — a future
   * writer that mirrors a mapping across partitions would lengthen it.
   */
  partition: {
    tableMappingId: string | null
    partitionLabel: string | null
    tableMappingIds: string[]
  },
): MappedRow {
  // Filter out defensively-null sources — a live mapping_source with
  // no source_field_id cannot be rendered.
  const validSources = tfmSources.filter(
    (s) => s.source_field_id !== null && s.source_table_id !== null,
  )

  // Dominant (ordinal=0) source drives cross-table join-annotation.
  const dominantSource = validSources.find((s) => s.ordinal === 0) ?? validSources[0] ?? null
  const dominantTableId = dominantSource?.source_table_id ?? null

  const sources: MappingSourceRef[] = validSources
    .map((s) =>
      buildMappingSourceRef(
        s,
        dominantTableId,
        tablesById,
        fieldsById,
        fieldsByTableId,
      ),
    )
    .filter((s): s is MappingSourceRef => s !== null)

  return {
    kind: 'mapped',
    id: tfm.id,
    tableMappingId: partition.tableMappingId,
    tableMappingIds: partition.tableMappingIds,
    partitionLabel: partition.partitionLabel,
    targetField,
    confidence: tfm.confidence,
    status: coerceStatus(tfm.status),
    hasTransformation: transformation !== null,
    transformationStatus: coerceTransformationStatus(
      transformation?.status ?? null,
      transformation !== null,
    ),
    transformationDescription: transformation?.description ?? null,
    transformationSqlPreview: buildTransformationSqlPreview(
      transformation?.generated_sql ?? null,
    ),
    transformationIntent: tfm.transformation_intent ?? null,
    transformationNeeded: tfm.needs_transformation ?? null,
    sources,
    combinationType: coerceCombinationType(tfm.combination_type),
    // `combinationSql` is only meaningful for `custom_sql` multi-source
    // mapped rows. Null otherwise.
    combinationSql:
      tfm.combination_type === 'custom_sql' ? tfm.combination_sql : null,
    aiReasoning: tfm.ai_reasoning,
    // PR γ — coverage metadata pass-through. Effective row status comes
    // from TFM.status; coverage's status_set_by is the coverage row's
    // own provenance metadata, surfaced for the drawer to detect e.g.
    // "TFM approved but coverage row still needs_review".
    mapping_content: 'mapped',
    coverageStatus: coverageRow
      ? coerceCoverageVerdict(coverageRow.coverage_status)
      : null,
    statusSetBy: coverageRow ? coerceStatusSetBy(coverageRow.status_set_by) : null,
  }
}

function buildMappingSourceRef(
  ms: RawMappingSourceRow,
  dominantTableId: string | null,
  tablesById: Map<string, RawTableRow>,
  fieldsById: Map<string, RawFieldRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
): MappingSourceRef | null {
  if (!ms.source_field_id || !ms.source_table_id) return null
  const sourceField = fieldsById.get(ms.source_field_id)
  const sourceTable = tablesById.get(ms.source_table_id)
  if (!sourceField || !sourceTable) return null

  // Cross-table join annotation: only emitted when this source's
  // table differs from the dominant (ordinal=0) source's table.
  const isCrossTable =
    dominantTableId !== null && dominantTableId !== ms.source_table_id

  const joinAnnotation = isCrossTable
    ? deriveJoinAnnotation(ms, dominantTableId, sourceTable.name, tablesById, fieldsByTableId)
    : null
  const joinSpec = isCrossTable ? coerceJoinSpec(ms.join_spec) : null

  const sampleValues = extractSampleValues(sourceField.field_profiles)

  return {
    id: ms.id,
    ordinal: ms.ordinal,
    confidence: ms.confidence,
    aiReasoning: ms.ai_reasoning,
    typeCompatibility: ms.type_compatibility,
    sourceField: {
      id: sourceField.id,
      name: sourceField.name,
      dataType: sourceField.data_type,
      isNullable: sourceField.is_nullable === null ? true : sourceField.is_nullable,
    },
    sourceTable: {
      id: sourceTable.id,
      name: sourceTable.name,
    },
    joinAnnotation,
    joinSpec,
    sampleValues,
  }
}

// ─── Derivation helpers ──────────────────────────────────────────────

/**
 * Derive the human-readable join annotation for a cross-table
 * mapping_source. Per design §3.2 `MappingSourceRef.joinAnnotation`:
 *
 *   1. Scan fields in the dominant source table for an FK pointing at
 *      this source's table. If exactly one match, use its name.
 *   2. Otherwise fall back to parsing the raw `join_spec.via_fk_field`
 *      — the AI-authored spec is authoritative when FK inference is
 *      ambiguous.
 *
 * Returns null when no annotation can be derived (ambiguous FK graph
 * + missing join_spec). The UI hides the annotation in that case.
 *
 * Phase 4a-3: the FK inference primitive lives in
 * `lib/utils/fk-inference.ts` so the write path can reuse it.
 */
function deriveJoinAnnotation(
  ms: RawMappingSourceRow,
  dominantTableId: string,
  joinedTableName: string,
  tablesById: Map<string, RawTableRow>,
  fieldsByTableId: Map<string, RawFieldRow[]>,
): string | null {
  const dominantFields = fieldsByTableId.get(dominantTableId) ?? []
  const fkCandidates = inferFkCandidates(
    dominantFields,
    ms.source_table_id!,
    joinedTableName,
    tablesById,
  )
  if (fkCandidates.length === 1) {
    return `(join: ${fkCandidates[0]})`
  }

  const spec = coerceJoinSpec(ms.join_spec)
  if (spec?.viaFkField) {
    return `(join: ${spec.viaFkField})`
  }

  return null
}

/**
 * Try to coerce a `mapping_sources.join_spec` JSONB value into the
 * `JoinSpec` contract. Returns null for any shape mismatch. The
 * stored JSONB is snake_case (verbatim AI output); we translate to
 * camelCase at the API boundary to match the rest of the contract.
 */
function coerceJoinSpec(raw: unknown): JoinSpec | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const viaSourceTable = asNonEmptyString(r.via_source_table)
  const viaFkField = asNonEmptyString(r.via_fk_field)
  const toFkField = asNonEmptyString(r.to_fk_field)
  if (!viaSourceTable || !viaFkField || !toFkField) return null
  return { viaSourceTable, viaFkField, toFkField }
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Max sample values we ship on the wire per source field.
 *
 * CONSUMER — drawer Source tab card (Gaps 7-10).
 * ────────────────────────────────────────────────────────────────────
 * Raised from 3 → 10 on 2026-04-24 to support deep per-source review
 * in the drawer. The main-page expanded view (chevron-toggled per-
 * source list) does NOT render these values — that path is optimized
 * for scanning, not for inspection. See
 * `docs/features/mapping-redesign.md` §Expanded view for the scoping
 * rationale and `MappingSourceRef.sampleValues` JSDoc for the
 * authoritative shape contract.
 *
 * History: a Gap 6 attempt inlined a 3-sample preview + "+N more"
 * affordance on the expanded-view bullet line. Smoke test revealed
 * the density overwhelmed the scanning use case, so the frontend
 * rendering was reverted. The 10-value wire cap survives because the
 * drawer will consume this data.
 *
 * Trade-offs considered at 10:
 *   • Heritage production data has ≥4 values on 85/99 source fields
 *     (86%). Most have ~10. Raising beyond 10 would inflate payload
 *     without a matching UX benefit at current drawer fidelity.
 *   • 10 short string values per source × ~3 sources per row × ~100
 *     rows = negligible wire cost (<50 KB at worst-case 100-char
 *     values, typically <10 KB).
 */
const MAX_SAMPLE_VALUES = 10

function extractSampleValues(
  profiles: RawFieldRow['field_profiles'],
): string[] {
  if (!profiles || profiles.length === 0) return []
  const first = profiles[0]
  const raw = first?.sample_values
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_SAMPLE_VALUES)
    .map((v) => (typeof v === 'string' ? v : String(v)))
}

function coerceStatus(status: string): 'needs_review' | 'approved' | 'rejected' {
  if (status === 'needs_review' || status === 'approved' || status === 'rejected') {
    return status
  }
  // Defensive default: unknown DB status values treated as 'needs_review'.
  return 'needs_review'
}

// PR γ — coverage row enum coercions. Mirror the defensive-default
// pattern from coerceStatus so unknown DB enum values never leak onto
// the wire as raw strings.

function coerceCoverageVerdict(
  v: string,
): 'covered' | 'partial' | 'gap' | 'optional' | 'out_of_scope' | null {
  if (
    v === 'covered' ||
    v === 'partial' ||
    v === 'gap' ||
    v === 'optional' ||
    v === 'out_of_scope'
  ) {
    return v
  }
  return null
}

function coerceStatusSetBy(
  v: string,
): 'ai_auto' | 'user' | 'system_default' | null {
  if (v === 'ai_auto' || v === 'user' || v === 'system_default') {
    return v
  }
  return null
}

function coerceCombinationType(
  v: RawTfmRow['combination_type'],
): 'single' | 'concat_space' | 'concat_comma' | 'custom_sql' {
  if (v === 'single' || v === 'concat_space' || v === 'concat_comma' || v === 'custom_sql') {
    return v
  }
  // A mapped row with NULL or unknown combination_type defaults to
  // 'single' — the most common case and a safe fallback that keeps
  // downstream Rule-selection logic working.
  return 'single'
}

function coerceTransformationStatus(
  status: string | null,
  hasTransformation: boolean,
): MappingTransformationStatus | null {
  if (!hasTransformation) return null
  if (
    status === 'draft' ||
    status === 'tested' ||
    status === 'saved' ||
    status === 'applied' ||
    status === 'stale'
  ) {
    return status
  }
  // Defensive default per §3.2 `MappingRowBase.transformationStatus`:
  // when a transformation row exists but carries a null/unknown status,
  // emit 'draft' (the initial lifecycle state).
  return 'draft'
}

/**
 * Server-truncate `transformations.generated_sql` to the wire cap so
 * the drawer-redesign Transformation section can render a glance-only
 * preview without paying the cost of the full SQL.
 *
 *   • null transformation row → null (no section rendered)
 *   • null/empty SQL          → null (translator emits null when there
 *                                     is nothing to preview, even if
 *                                     a transformation row exists in
 *                                     a degenerate state)
 *   • SQL ≤ cap               → verbatim SQL
 *   • SQL > cap               → first cap chars + `…`
 *
 * Q11.E lock (drawer redesign, 2026-04-26).
 */
function buildTransformationSqlPreview(
  sql: string | null | undefined,
): string | null {
  if (sql === null || sql === undefined) return null
  if (sql.length === 0) return null
  if (sql.length <= MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH) return sql
  return `${sql.slice(0, MAX_TRANSFORMATION_SQL_PREVIEW_LENGTH)}…`
}

function countByKey<T>(items: T[], keyFn: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    const k = keyFn(it)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

function localeCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

/**
 * Canonical row ordering per design §9 Q7 resolution.
 *
 *   ORDER BY
 *     targetTable.name         ASC,
 *     targetField.ordinalPosition ASC,
 *     targetField.name         ASC
 *
 * Keep this sort stable across re-renders: the client relies on
 * server-guaranteed ordering per the `MappingsForRedesignResult.rows`
 * JSDoc. Any change here must update the design doc first.
 */
function compareRows(a: MappingRow, b: MappingRow): number {
  const byTable = localeCompare(a.targetField.targetTable.name, b.targetField.targetTable.name)
  if (byTable !== 0) return byTable
  const byOrdinal = a.targetField.ordinalPosition - b.targetField.ordinalPosition
  if (byOrdinal !== 0) return byOrdinal
  return localeCompare(a.targetField.name, b.targetField.name)
}

// ─── Source schema sidebar — Phase 3 Gap 11b ─────────────────────────

/**
 * Build the `sourceFields: SourceFieldWithState[]` payload consumed
 * by the source-schema sidebar.
 *
 * SEMANTICS — `mappingStatus`
 * ───────────────────────────
 * A source field is `'mapped'` iff its id appears in
 * `mapping_sources.source_field_id` for any TFM in this project whose
 * `status !== 'rejected'`. Otherwise `'unmapped'`.
 *
 * Excluding rejected TFMs is founder-locked (Gap 11b decision 2): a
 * rejected TFM does not "claim" its contributing sources as mapped.
 * Post-Gap-9, new rejects = deletes (the TFM disappears entirely);
 * the legacy SimpleLegal rejected row is the only production case
 * where `status='rejected'` rows still carry live `mapping_sources`.
 * Excluding here is defensive against that legacy row + any future
 * data that does not delete-on-reject.
 *
 * ORDERING
 * ────────
 * Server-emitted in canonical order:
 *   (sourceTable.name ASC, ordinalPosition ASC, name ASC)
 *
 * Mirrors `rows[]` ordering. The redesign-path sort guard prevents
 * any client-side re-sorting downstream.
 */
function buildSourceFieldsWithState(
  sourceFields: RawFieldRow[],
  tablesById: Map<string, RawTableRow>,
  tfms: RawTfmRow[],
  mappingSources: RawMappingSourceRow[],
  sourceAcks: RawSourceAckRow[],
  staticSourceRationale: ReadonlyMap<string, StaticSourceUnmappedInfo>,
): SourceFieldWithState[] {
  const tfmStatusById = new Map<string, string>(
    tfms.map((t) => [t.id, t.status]),
  )

  const mappedSourceFieldIds = new Set<string>()
  for (const ms of mappingSources) {
    if (ms.source_field_id === null) continue
    if (tfmStatusById.get(ms.target_field_mapping_id) === 'rejected') continue
    mappedSourceFieldIds.add(ms.source_field_id)
  }

  // Migration 103 — split source-side decisions by `decision`. The two
  // sets are mutually exclusive because of UNIQUE (project_id,
  // source_field_id). Pre-103 rows backfilled to 'acknowledged' land
  // in the first set as expected.
  const acknowledgedSourceFieldIds = new Set<string>()
  const rejectedSourceFieldIds = new Set<string>()
  for (const a of sourceAcks) {
    if (a.decision === 'rejected') {
      rejectedSourceFieldIds.add(a.source_field_id)
    } else {
      acknowledgedSourceFieldIds.add(a.source_field_id)
    }
  }

  const out: SourceFieldWithState[] = []
  for (const field of sourceFields) {
    const table = tablesById.get(field.table_id)
    if (!table) continue
    // Reject = reset: a rejected source field carries NO preserved AI
    // commentary. Suppress the static-config rationale (and its
    // confidence) regardless of what the config file holds — the
    // `source_field_acknowledgments` rejection decision is authoritative.
    const isRejected = rejectedSourceFieldIds.has(field.id)
    const rationale = isRejected
      ? undefined
      : staticSourceRationale.get(field.id)
    out.push({
      id: field.id,
      name: field.name,
      dataType: field.data_type,
      ordinalPosition: field.ordinal_position,
      sourceTable: { id: table.id, name: table.name },
      mappingStatus: mappedSourceFieldIds.has(field.id) ? 'mapped' : 'unmapped',
      sampleValues: extractSampleValues(field.field_profiles),
      isAcknowledged: acknowledgedSourceFieldIds.has(field.id),
      isRejected,
      aiReasoning: rationale?.explanation ?? null,
      confidence: rationale?.confidence ?? null,
    })
  }

  out.sort(compareSourceFields)
  return out
}

function compareSourceFields(
  a: SourceFieldWithState,
  b: SourceFieldWithState,
): number {
  const byTable = localeCompare(a.sourceTable.name, b.sourceTable.name)
  if (byTable !== 0) return byTable
  const byOrdinal = a.ordinalPosition - b.ordinalPosition
  if (byOrdinal !== 0) return byOrdinal
  return localeCompare(a.name, b.name)
}

function computeCounts(rows: MappingRow[]): MappingCounts {
  let total = 0
  let approved = 0
  let needsReview = 0
  let rejected = 0
  let unmapped = 0
  for (const row of rows) {
    total++
    // INF-57 — chip semantics are status-driven for decided rows, with the
    // `unmapped` chip reserved for "no TFM AND awaiting decision".
    //   • kind='unmapped' AND status='needs_review' (or legacy 'unmapped'
    //     literal) → unmapped chip. This covers true orphans (no coverage
    //     row, system_default needs_review) AND post-reset rows.
    //   • kind='unmapped' AND status='approved' → approved chip. This
    //     preserves the pre-INF-57 "bare-ack counts as approved" semantic
    //     now that legacy bare-acks render as UnmappedRow under
    //     dual-recognition. Also covers canonical coverage-approved
    //     no-source rows (drawer-side approve via setCoverageStatus).
    //   • kind='unmapped' AND status='rejected' → rejected chip.
    //   • kind='mapped' / 'value_assignment' → counted by their TFM
    //     lifecycle status as before.
    if (
      row.kind === 'unmapped' &&
      (row.status === 'needs_review' || row.status === 'unmapped')
    ) {
      unmapped++
      continue
    }
    switch (row.status) {
      case 'approved':
        approved++
        break
      case 'needs_review':
        needsReview++
        break
      case 'rejected':
        rejected++
        break
    }
  }
  return { total, approved, needsReview, rejected, unmapped }
}

// ─── Mapping generation: pure helpers ────────────────────────────────
//
// Used by both `runMappingGeneration` (this file) and the legacy
// `runMappingGenerationForPair` (`lib/actions/mappings.ts`). Pure —
// no DB, no auth, no Next.js. Exported because the legacy action
// layer imports them.

export function bareTableName(s: string | null | undefined): string {
  if (!s || typeof s !== 'string') return ''
  const parts = s.split('.')
  return parts[parts.length - 1].toLowerCase().trim()
}

export function parseClaudeJSON(raw: string): ClaudeResponse {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }

  try {
    const parsed = JSON.parse(cleaned)
    if (!parsed.table_mappings || !Array.isArray(parsed.table_mappings)) {
      throw new Error('Invalid response: missing table_mappings array')
    }
    return parsed as ClaudeResponse
  } catch (err) {
    const trimmed = cleaned.trimEnd()
    const isLikelyTruncation =
      cleaned.length > 500 && !trimmed.endsWith('}') && !trimmed.endsWith(']')
    if (isLikelyTruncation) {
      console.error(
        `[Mapping] Response appears truncated (${cleaned.length} chars). ` +
          `Last 100 chars: "${cleaned.slice(-100)}"`,
      )
    }
    throw err
  }
}

export function buildTemplateBlock(template: MigrationTemplate, sourceTableName: string): string {
  const entries = template.entries.filter(
    e => e.source.tableName === sourceTableName.toLowerCase()
  )
  if (entries.length === 0) return ''
  const lines = entries.map(e =>
    `  ${e.source.fieldName} → ${e.target.tableName}.${e.target.fieldName}` +
    (e.transformSql ? ` [SQL: ${e.transformSql}]` : '') +
    ` (confidence: ${e.confidence}, reused: ${e.reuseCount}x)`
  ).join('\n')
  return `<template_mappings>
Previously approved mappings for this system pair (${template.migrationCount} migration${template.migrationCount !== 1 ? 's' : ''}). Prefer these unless schema evidence contradicts them.
${lines}
</template_mappings>`
}

/**
 * SET-35 — Build FK relationship context block for cross-table disambiguation.
 * Extracts FK references from source fields and presents them as a relationship
 * graph so the LLM knows which source tables join via FKs.
 */
export function buildFKRelationshipBlock(
  sourceFields: Array<{ name: string; table_id: string; is_foreign_key: boolean | null; fk_reference: string | null }>,
  targetFields: Array<{ name: string; table_id: string; is_foreign_key: boolean | null; fk_reference: string | null }>,
  sourceTableNames: Map<string, string>,
  targetTableNames: Map<string, string>,
): string {
  const lines: string[] = []
  for (const f of sourceFields) {
    if (!f.is_foreign_key || !f.fk_reference) continue
    const tableName = sourceTableNames.get(f.table_id)
    if (tableName) lines.push(`  Source: ${tableName}.${f.name} → ${f.fk_reference}`)
  }
  for (const f of targetFields) {
    if (!f.is_foreign_key || !f.fk_reference) continue
    const tableName = targetTableNames.get(f.table_id)
    if (tableName) lines.push(`  Target: ${tableName}.${f.name} → ${f.fk_reference}`)
  }
  if (lines.length === 0) return ''
  return `<fk_relationships>
Foreign key relationships detected:
${lines.join('\n')}

CROSS-TABLE DISAMBIGUATION:
- If a source field is an FK referencing a target table, that source field is a REFERENCE KEY — it points to data in the target, it does not own the data. Prefer mapping target entity fields (like "Item Number", "Item Description") to the source table that holds the PRIMARY/business data for those fields, not the table that merely references them via FK.
- When two source tables have similar field names, the table WITHOUT an FK to the target is more likely the entity-data owner. The table WITH an FK is a child/component table referencing the entity.
- Example: If BOM Masters.Assy Item is FK→Engineering Item Master.Item Number, then BOM Masters is a child table. A target field "Item Number" should map from Products.ProductSKU (the entity data), not BOM Masters.Assy Item (the FK reference).
</fk_relationships>`
}

export function buildMappingUserMessage(args: {
  sourceSection: string
  targetSection: string
  docBlock: string
  intelligenceCtx: string | null
  otherSourcesBlock?: string | null
  templateBlock?: string | null
  fkBlock?: string | null
  pocBlock?: string | null
}): string {
  const { sourceSection, targetSection, docBlock, intelligenceCtx, otherSourcesBlock, templateBlock, fkBlock, pocBlock } = args
  return `${sourceSection}
${targetSection}
${docBlock}
${intelligenceCtx ? intelligenceCtx + '\n\n' : ''}${templateBlock ? templateBlock + '\n\n' : ''}${fkBlock ? fkBlock + '\n\n' : ''}${otherSourcesBlock ? otherSourcesBlock + '\n\n' : ''}${pocBlock ? pocBlock + '\n\n' : ''}Generate source-to-target mappings. Respond with this exact JSON structure.

CRITICAL RULES FOR THE JSON:
- "source_table" must be ONLY the table name (e.g., "prices") — NOT the qualified name (NOT "trux.prices")
- "target_table" must be ONLY the table name (e.g., "ARTICLE_PRICES") — NOT "dataset.ARTICLE_PRICES"
- "source_field" must be ONLY the field name (e.g., "item_price") — NOT "prices.item_price"
- "target_field" must be ONLY the field name (e.g., "PRICE") — NOT "ARTICLE_PRICES.PRICE"

{
  "table_mappings": [
    {
      "source_table": "prices",
      "target_table": "ARTICLE_PRICES",
      "confidence": 88,
      "reasoning": "Both tables store pricing information for items/articles...",
        "field_mappings": [
          {
            "source_field": "item_price",
            "target_field": "PRICE",
            "confidence": 85,
            "reasoning": "Direct price field mapping, DECIMAL to DECIMAL compatible",
            "similar_fields_considered": ["UNIT_PRICE", "BASE_PRICE"],
            "type_compatibility": "DECIMAL(10,2) → DECIMAL(15,4) — target has higher precision",
            "needs_transformation": true
          },
          {
            "source_field": "contact_first",
            "target_field": "CONTACT_NAME",
            "confidence": 90,
            "reasoning": "First and last name components should be combined into full name",
            "type_compatibility": "VARCHAR(50) + VARCHAR(50) → VARCHAR(100)",
            "needs_transformation": true,
            "mapping_type": "many_to_one",
            "contributing_source_fields": ["contact_last"],
            "combination_hint": "Concatenate first and last name with space separator"
          }
        ],
        "unmapped_fields": [
          {
            "target_field": "CREATED_AT",
            "assignment": "Constant: NOW()",
            "reasoning": "Target requires creation timestamp; no source equivalent"
          },
          {
            "target_field": "LEGACY_ID",
            "assignment": "Leave NULL",
            "reasoning": "Optional field; no source data available"
          }
        ]
    }
  ]
}

Map ALL source fields to their best target match. If a source field has no reasonable target match, omit it. For every target field you did NOT map, include it in the unmapped_fields array with a structured assignment.`
}

// ─── Pure assembly ───────────────────────────────────────────────────

/**
 * Pure, testable assembly step — no DB, no side effects. Consumes the
 * raw row arrays from Round 2-4 and emits the public contract.
 *
 * All design-contract invariants live here:
 *   • row kind discrimination (mapped / VA / acknowledged / unmapped)
 *   • canonical row ordering (see §9 Q7 resolution)
 *   • server-side `MappingCounts` rollup
 *   • join-annotation derivation (FK inference + JSONB fallback)
 *   • defensive coercion of nullable DB columns
 *
 * Do not add new invariants here without updating the design doc §3/§5
 * — this function IS the contract implementation.
 */
export function assembleMappingsForRedesign(
  input: AssembleInput,
): MappingsForRedesignResult {
  const {
    projectId,
    datasets,
    tables,
    fields,
    tfms,
    mappingSources,
    sourceAcks,
    transformations,
    coverage = [],
    staticSourceRationale = new Map<string, StaticSourceUnmappedInfo>(),
    tableMappings = [],
    partitionsEnabled = false,
  } = input

  // ── Build dataset / table / field indexes ──────────────────────────
  const datasetsById = new Map(datasets.map((d) => [d.id, d]))
  const tablesById = new Map(tables.map((t) => [t.id, t]))
  const fieldsById = new Map(fields.map((f) => [f.id, f]))

  const sourceDatasetIds = new Set(
    datasets.filter((d) => d.role === 'source').map((d) => d.id),
  )
  const targetDatasetIds = new Set(
    datasets.filter((d) => d.role === 'target').map((d) => d.id),
  )

  const sourceTables = tables.filter((t) => sourceDatasetIds.has(t.dataset_id))
  const targetTables = tables.filter((t) => targetDatasetIds.has(t.dataset_id))

  const sourceTableIds = new Set(sourceTables.map((t) => t.id))
  const targetTableIds = new Set(targetTables.map((t) => t.id))

  const sourceFields = fields.filter((f) => sourceTableIds.has(f.table_id))
  const targetFields = fields.filter((f) => targetTableIds.has(f.table_id))

  // Field-count indexes for TableSummary rollups.
  const sourceFieldCountByTable = countByKey(sourceFields, (f) => f.table_id)
  const targetFieldCountByTable = countByKey(targetFields, (f) => f.table_id)

  // Fields grouped by table — needed for FK-inference during joinAnnotation.
  const fieldsByTableId = new Map<string, RawFieldRow[]>()
  for (const f of fields) {
    const arr = fieldsByTableId.get(f.table_id) ?? []
    arr.push(f)
    fieldsByTableId.set(f.table_id, arr)
  }

  // ── Build mapping_sources and transformations by TFM ──────────────
  const mappingSourcesByTfm = new Map<string, RawMappingSourceRow[]>()
  for (const ms of mappingSources) {
    const arr = mappingSourcesByTfm.get(ms.target_field_mapping_id) ?? []
    arr.push(ms)
    mappingSourcesByTfm.set(ms.target_field_mapping_id, arr)
  }
  for (const [k, arr] of mappingSourcesByTfm) {
    arr.sort((a, b) => a.ordinal - b.ordinal)
    mappingSourcesByTfm.set(k, arr)
  }

  const transformationByTfm = new Map<string, RawTransformationRow>()
  for (const tr of transformations) {
    // Invariant: COUNT(transformations) per tfm ≤ 1 (see lib/types/mapping-redesign.ts).
    // If the DB contains a duplicate, the second entry wins here — consistent
    // with the legacy getMappings behaviour (upsert semantics).
    transformationByTfm.set(tr.target_field_mapping_id, tr)
  }

  // ── PR Ω.3.2: partition indexes ───────────────────────────────────
  // tableMappings is already server-sorted by:
  //   target_table_id ASC, partition_ordinal ASC NULLS LAST, created_at ASC, id ASC
  // so iterating it produces partitions in canonical order. The two indexes
  // below preserve that order via Map insertion semantics.
  const tableMappingsById = new Map<string, RawTableMappingRow>()
  for (const tm of tableMappings) {
    tableMappingsById.set(tm.id, tm)
  }
  // `partitionsByTargetTableId` — for each target table, its partitions in
  // canonical order. Used both for row-loop iteration (N rows per target field)
  // and for the result envelope's `partitionsByTargetTable`.
  const partitionsByTargetTableId = new Map<string, RawTableMappingRow[]>()
  for (const tm of tableMappings) {
    const arr = partitionsByTargetTableId.get(tm.target_table_id) ?? []
    arr.push(tm)
    partitionsByTargetTableId.set(tm.target_table_id, arr)
  }

  // ── Build TFMs by (target_field_id, table_mapping_id) for row assembly ──
  // Pre-Ω.3.2 this was Map<target_field_id, RawTfmRow> assuming UNIQUE
  // (project_id, target_field_id). Post-Ω.1 (migration 107), the UNIQUE
  // is (project_id, target_field_id, table_mapping_id) so a single target
  // field may have multiple TFMs — one per partition.
  const tfmByTargetAndPartition = new Map<string, RawTfmRow>()
  for (const t of tfms) {
    // Defensive: pre-Ω.1 fixtures may carry null/missing table_mapping_id;
    // fall back to a stable sentinel so heritage assemblers still group.
    const tmId = t.table_mapping_id ?? '__no_partition__'
    tfmByTargetAndPartition.set(`${t.target_field_id}::${tmId}`, t)
  }

  // ── PR γ — coverage by target_field_id for unified row props ──────
  // Migration 093 enforces UNIQUE (project_id, target_field_id) on
  // target_field_coverage, so the map collapse is safe. Coverage is NOT
  // per-partition today; the same coverage row applies to every partition
  // of the same target field.
  const coverageByTargetFieldId = new Map<string, RawCoverageRow>()
  for (const c of coverage) {
    coverageByTargetFieldId.set(c.target_field_id, c)
  }

  // ── Assemble rows ─────────────────────────────────────────────────
  // PR Ω.3.8 cardinality contract — one row per distinct
  // (target_field_id, source_field_id) tuple. Replaces the per-partition
  // fan-out introduced by PR Ω.3.2.
  //
  //   Heritage (0 partitions in `partitionsForTable` — pre-Ω.1 projects):
  //     1 row per target field. `tableMappingIds` is `[]`.
  //
  //   Partition-aware (1+ partitions):
  //     Group the per-partition TFMs for each target_field into buckets:
  //       mapped TFM     → keyed by dominant `source_field_id`
  //                        (the same (target, source) tuple appearing in
  //                        multiple partitions collapses to one row)
  //       VA TFM         → single bucket (one row per target_field
  //                        regardless of how many partitions replicate
  //                        the VA)
  //       no TFM / ack   → single bucket per target_field
  //     Each bucket emits ONE row. `tableMappingIds[]` carries every
  //     partition that contributed to the bucket; `tableMappingId` /
  //     `partitionLabel` are the canonical (first / lowest-ordinal)
  //     partition's values, since `partitionsForTable` already iterates
  //     in canonical order.
  //
  //     PR Ω.3.8.2 emit guard: the unmapped bucket emits ONLY when both
  //     the mapped and VA buckets are empty for this target field. A
  //     field with ANY mapped or VA TFM is a mapped/VA field — partitions
  //     where it lacks a TFM fold into the mapped/VA row's transformation
  //     context, not a separate unmapped row. Fields with zero TFMs in
  //     any partition (skipped ICC, truly-unmapped EIM) still emit their
  //     single unmapped row.
  //
  // Divergence detection: `assertCollapseConsistency` warns when a
  // mapped or VA bucket contains sibling TFMs whose combination SQL
  // differs across partitions. This never happens in the Rootstock
  // loader (each mapped tuple routes to exactly one partition; VAs are
  // byte-identical replicas) — the warning exists so a future writer
  // mirroring a mapping across partitions with different transformations
  // gets a visible operator signal before the canonical TFM wins.
  //
  // Status mutation contract (PR Ω.3.8 → deferred to PR Ω.3.8.1):
  // approve/reject/edit mutations in `lib/actions/mappings-for-redesign.ts`
  // take a single TFM uuid (the row's canonical `id`) and update only
  // that one DB row. A collapsed row that spans N partitions therefore
  // updates only its canonical TFM's status; the N-1 sibling TFMs keep
  // their pre-action status. This is load-time correct — `staging.ts`
  // and `lib/actions/_outputs-core.ts` both gate on
  // `.neq('status', 'rejected')`, so `needs_review` siblings still flow
  // their constants / source values into partitions B, C, … — but it
  // creates an informational counter divergence between the mapping
  // page (which counts collapsed rows: 1/1 approved) and the Migration
  // Center (which counts TFMs via `lib/quality/stat-formulas.ts`
  // `mappingApproved`: 1/N approved). PR Ω.3.8.1 will fan status
  // mutations across `tableMappingIds[]` to close that divergence.

  /**
   * Inline because it references the local `RawTfmRow` / `RawTableMappingRow`
   * types defined inside `assembleResult`. Side-effect: one `console.warn`
   * per divergent group.
   */
  function assertCollapseConsistency(
    targetFieldId: string,
    kind: 'mapped' | 'value_assignment',
    entries: ReadonlyArray<{ partition: RawTableMappingRow; tfm: RawTfmRow }>,
  ): void {
    if (entries.length <= 1) return
    const first = entries[0]!.tfm
    for (let i = 1; i < entries.length; i++) {
      const sibling = entries[i]!.tfm
      if (
        sibling.combination_sql !== first.combination_sql ||
        sibling.combination_type !== first.combination_type ||
        sibling.transformation_intent !== first.transformation_intent
      ) {
        console.warn(
          `[mapping-engine] ${kind} TFM collapse divergence for ` +
            `target_field_id=${targetFieldId}: partition ` +
            `${entries[0]!.partition.id} (tfm=${first.id}) and partition ` +
            `${entries[i]!.partition.id} (tfm=${sibling.id}) differ on ` +
            `combination_sql/combination_type/transformation_intent. ` +
            `Collapsing to canonical (first partition).`,
        )
        return
      }
    }
  }

  const rows: MappingRow[] = []

  for (const targetField of targetFields) {
    const targetFieldRef = buildTargetFieldRef(targetField, tablesById)
    if (!targetFieldRef) continue // Parent target table missing (shouldn't happen under normal ingestion).

    const partitionsForTable = partitionsByTargetTableId.get(targetField.table_id) ?? []
    const coverageRow = coverageByTargetFieldId.get(targetField.id) ?? null

    if (partitionsForTable.length === 0) {
      // Heritage path — target table has zero `table_mappings` rows. Two
      // sub-cases:
      //   (a) Pre-Ω.1 production projects (migration 107 not applied) — every
      //       TFM has `table_mapping_id IS NULL`; legacy 1-row-per-target
      //       behavior with `tableMappingId=null` and `tableMappingIds=[]`.
      //   (b) Synthetic test fixtures that build TFMs without a paired
      //       `tableMappings` array — same fallback so existing tests pass.
      //
      // At most one TFM per target_field in this case (pre-Ω.1 UNIQUE on
      // (project_id, target_field_id) without table_mapping_id discriminator).
      const tfmKey = `${targetField.id}::__no_partition__`
      const tfm = tfmByTargetAndPartition.get(tfmKey) ?? null
      const noPartitionBinding = {
        tableMappingId: null,
        partitionLabel: null,
        tableMappingIds: [] as string[],
      }

      if (!tfm) {
        rows.push(buildUnmappedRow(targetFieldRef, coverageRow, null, noPartitionBinding))
        continue
      }

      const tfmSources = mappingSourcesByTfm.get(tfm.id) ?? []
      const transformation = transformationByTfm.get(tfm.id) ?? null

      if (tfm.is_acknowledged) {
        rows.push(buildUnmappedRow(targetFieldRef, coverageRow, tfm, noPartitionBinding))
        continue
      }
      if (tfm.combination_type === 'custom_sql' && tfmSources.length === 0) {
        rows.push(
          buildValueAssignmentRow(tfm, targetFieldRef, transformation, coverageRow, noPartitionBinding),
        )
        continue
      }
      if (tfmSources.length === 0) {
        rows.push(buildUnmappedRow(targetFieldRef, coverageRow, tfm, noPartitionBinding))
        continue
      }
      rows.push(
        buildMappedRow(
          tfm,
          targetFieldRef,
          tfmSources,
          transformation,
          tablesById,
          fieldsById,
          fieldsByTableId,
          coverageRow,
          noPartitionBinding,
        ),
      )
      continue
    }

    // Partition-aware path. Walk each partition once, bucketing the
    // (partition, tfm) entries by the collapse key. Insertion order =
    // canonical partition order (since `partitionsForTable` is already
    // sorted), so the FIRST entry in each bucket becomes the canonical
    // partition for its emitted row.
    const mappedGroups = new Map<
      string,
      Array<{
        partition: RawTableMappingRow
        tfm: RawTfmRow
        tfmSources: RawMappingSourceRow[]
      }>
    >()
    const vaEntries: Array<{ partition: RawTableMappingRow; tfm: RawTfmRow }> = []
    const unmappedEntries: Array<{
      partition: RawTableMappingRow
      tfm: RawTfmRow | null
    }> = []

    for (const partition of partitionsForTable) {
      const tfm =
        tfmByTargetAndPartition.get(`${targetField.id}::${partition.id}`) ?? null

      if (!tfm) {
        unmappedEntries.push({ partition, tfm: null })
        continue
      }

      const tfmSources = mappingSourcesByTfm.get(tfm.id) ?? []

      // Discriminator: matches the pre-Ω.3.8 per-partition logic — only
      // the EMIT step has been hoisted out so siblings can collapse.
      if (tfm.is_acknowledged) {
        unmappedEntries.push({ partition, tfm })
        continue
      }
      if (tfm.combination_type === 'custom_sql' && tfmSources.length === 0) {
        vaEntries.push({ partition, tfm })
        continue
      }
      if (tfmSources.length === 0) {
        // Defensive: a TFM with non-custom_sql combination_type and zero
        // sources is semantically invalid; surface as unmapped to avoid
        // emitting a MappedRow with an empty `sources` array that would
        // violate the Rules 1-4 selector.
        unmappedEntries.push({ partition, tfm })
        continue
      }

      const dominantSource =
        tfmSources.find((s) => s.ordinal === 0) ?? tfmSources[0]!
      if (!dominantSource.source_field_id) {
        // Defensive: missing source_field_id on the dominant source —
        // not renderable as a mapped row.
        unmappedEntries.push({ partition, tfm })
        continue
      }
      const groupKey = dominantSource.source_field_id
      const bucket = mappedGroups.get(groupKey) ?? []
      bucket.push({ partition, tfm, tfmSources })
      mappedGroups.set(groupKey, bucket)
    }

    // Emit one row per bucket. `rows.sort(compareRows)` below normalizes
    // the final wire ordering, so the emit order here only matters for
    // stable insertion under tied compareRows keys.
    for (const entries of mappedGroups.values()) {
      assertCollapseConsistency(targetField.id, 'mapped', entries)
      const canonical = entries[0]!
      const transformation = transformationByTfm.get(canonical.tfm.id) ?? null
      rows.push(
        buildMappedRow(
          canonical.tfm,
          targetFieldRef,
          canonical.tfmSources,
          transformation,
          tablesById,
          fieldsById,
          fieldsByTableId,
          coverageRow,
          {
            tableMappingId: canonical.partition.id,
            partitionLabel: canonical.partition.partition_label,
            tableMappingIds: entries.map((e) => e.partition.id),
          },
        ),
      )
    }

    if (vaEntries.length > 0) {
      assertCollapseConsistency(targetField.id, 'value_assignment', vaEntries)
      const canonical = vaEntries[0]!
      const transformation = transformationByTfm.get(canonical.tfm.id) ?? null
      rows.push(
        buildValueAssignmentRow(
          canonical.tfm,
          targetFieldRef,
          transformation,
          coverageRow,
          {
            tableMappingId: canonical.partition.id,
            partitionLabel: canonical.partition.partition_label,
            tableMappingIds: vaEntries.map((e) => e.partition.id),
          },
        ),
      )
    }

    // PR Ω.3.8.2 — only emit the collapsed unmapped row when the field
    // is FULLY uncovered (no mapped TFM, no VA TFM). A field with any
    // source mapping or value-assignment is a mapped/VA field; the
    // partitions where it lacks a TFM are handled in the mapped/VA
    // row's transformation context, not as a separate unmapped row.
    // Truly-unmapped fields (skipped ICC, EIM fields with zero TFMs in
    // any partition) still emit their single unmapped row.
    if (
      unmappedEntries.length > 0 &&
      mappedGroups.size === 0 &&
      vaEntries.length === 0
    ) {
      const canonical = unmappedEntries[0]!
      rows.push(
        buildUnmappedRow(targetFieldRef, coverageRow, canonical.tfm, {
          tableMappingId: canonical.partition.id,
          partitionLabel: canonical.partition.partition_label,
          tableMappingIds: unmappedEntries.map((e) => e.partition.id),
        }),
      )
    }
  }

  // ── Canonical ordering (§9 Q7) ────────────────────────────────────
  rows.sort(compareRows)

  // ── Filter universes ──────────────────────────────────────────────
  const targetTableSummaries: TargetTableSummary[] = targetTables
    .map((t) => {
      const dataset = datasetsById.get(t.dataset_id)
      return {
        id: t.id,
        name: t.name,
        datasetName: dataset?.name ?? '',
        fieldCount: targetFieldCountByTable.get(t.id) ?? 0,
      }
    })
    .sort((a, b) => localeCompare(a.name, b.name))

  const sourceTableSummaries: SourceTableSummary[] = sourceTables
    .map((t) => {
      const dataset = datasetsById.get(t.dataset_id)
      return {
        id: t.id,
        name: t.name,
        datasetName: dataset?.name ?? '',
        fieldCount: sourceFieldCountByTable.get(t.id) ?? 0,
      }
    })
    .sort((a, b) => localeCompare(a.name, b.name))

  const sourceFieldAcknowledgments: SourceFieldAcknowledgmentSummary[] =
    sourceAcks.map((a) => ({
      id: a.id,
      sourceFieldId: a.source_field_id,
      reason: a.reason,
      // Migration 103 — coerce unknown values to 'acknowledged' so a
      // pre-103 backfilled row (NULL decision) or any future enum drift
      // never reaches the UI as an out-of-band value.
      decision: a.decision === 'rejected' ? 'rejected' : 'acknowledged',
    }))

  // ── Source schema sidebar (Phase 3 Gap 11b) ──────────────────────
  const sourceFieldsWithState = buildSourceFieldsWithState(
    sourceFields,
    tablesById,
    tfms,
    mappingSources,
    sourceAcks,
    staticSourceRationale,
  )

  // ── Project-level counters ────────────────────────────────────────
  const counts: MappingCounts = computeCounts(rows)

  // ── PR Ω.3.2: partitions envelope ─────────────────────────────────
  // Build the public PartitionInfo[] per target_table from the raw rows,
  // joining `source_table_id → tables.name` for the display fallback when
  // partition_label is null. Order is already canonical (the SELECT enforced
  // partition_ordinal NULLS LAST → created_at → id).
  const partitionsByTargetTable: Record<string, PartitionInfo[]> = {}
  for (const [targetTableId, partitions] of partitionsByTargetTableId) {
    partitionsByTargetTable[targetTableId] = partitions.map((tm) => {
      const sourceTable = tablesById.get(tm.source_table_id)
      return {
        id: tm.id,
        label: tm.partition_label,
        ordinal: tm.partition_ordinal,
        sourceTableId: tm.source_table_id,
        sourceTableName: sourceTable?.name ?? '',
        filterSql: tm.filter_sql,
        identityFieldId: tm.identity_field_id,
        dedupPriority: tm.dedup_priority,
      }
    })
  }

  return {
    projectId,
    rows,
    targetTables: targetTableSummaries,
    sourceTables: sourceTableSummaries,
    sourceFieldAcknowledgments,
    sourceFields: sourceFieldsWithState,
    counts,
    targetSchemaEmpty: targetTables.length === 0 || targetFields.length === 0,
    partitionsByTargetTable,
    partitionsEnabled,
  }
}

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
  // ── Round 1 — access gate + project flags ────────────────────────
  // PR Ω.3.2: also reads `partitions_enabled` (added by migration 107) so
  // the UI can gate the "+ Add Partition" affordance without an extra
  // round-trip. Heritage projects default to false.
  const { data: projectRow } = await supabase
    .from('projects')
    .select('id, partitions_enabled')
    .eq('id', projectId)
    .maybeSingle<{ id: string; partitions_enabled: boolean | null }>()
  if (!projectRow) return null
  const partitionsEnabled = projectRow.partitions_enabled === true

  // ── Round 2 — project-scoped parallel fetch ───────────────────────
  const [
    { data: datasetsRaw },
    { data: tfmsRaw },
    { data: sourceAcksRaw },
    { data: coverageRaw },
    { data: tableMappingsRaw },
  ] = await Promise.all([
    supabase
      .from('datasets')
      .select('id, role, name')
      .eq('project_id', projectId),
    supabase
      .from('target_field_mappings')
      // PR Ω.3.2: table_mapping_id added so each TFM carries its partition
      // binding directly (no JOIN needed in the assembler).
      .select('id, target_field_id, table_mapping_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql, transformation_intent, needs_transformation')
      .eq('project_id', projectId),
    supabase
      .from('source_field_acknowledgments')
      .select('id, source_field_id, reason, decision')
      .eq('project_id', projectId),
    // PR γ — target_field_coverage join for unified row-prop status +
    // coverageStatus + statusSetBy. PR γ.1 adds `confidence` to the
    // SELECT so UnmappedRow.confidence can flow from the AI's
    // coverage-verdict confidence (migration 096). Optional read:
    // pre-Path-D projects have zero coverage rows and the translator
    // synthesises a target_only row-prop shape for orphans (no
    // coverage, no TFM).
    supabase
      .from('target_field_coverage')
      .select('id, target_field_id, coverage_status, ai_reasoning, status, status_set_by, confidence')
      .eq('project_id', projectId),
    // PR Ω.3.2: table_mappings — partition metadata for the project. Used by
    // the assembler to populate every row's tableMappingId + partitionLabel
    // and to build the result envelope's partitionsByTargetTable.
    //
    // ORDER BY here is the canonical partition ordering rule (mirrors Ω.1
    // backfill #2 + lib/utils/partition-binding.ts). Enforced once on the
    // server; clients do not re-sort.
    supabase
      .from('table_mappings')
      .select('id, source_table_id, target_table_id, partition_label, partition_ordinal, filter_sql, identity_field_id, dedup_priority, created_at')
      .eq('project_id', projectId)
      .order('target_table_id', { ascending: true })
      .order('partition_ordinal', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true }),
  ])

  const datasets = (datasetsRaw ?? []) as RawDatasetRow[]
  const tfms = (tfmsRaw ?? []) as RawTfmRow[]
  const sourceAcks = (sourceAcksRaw ?? []) as RawSourceAckRow[]
  const coverage = (coverageRaw ?? []) as RawCoverageRow[]
  const tableMappings = (tableMappingsRaw ?? []) as RawTableMappingRow[]

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
          .select('id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, default_value, description, ordinal_position, field_profiles(field_id, sample_values)')
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

  // Display-only rationale for unmapped source fields, resolved from the
  // static-mappings config (one config-file read; empty map for projects
  // with no static config). Read-only — no `source_field_acknowledgments`
  // write. Flows onto `SourceFieldWithState.aiReasoning`.
  const staticSourceRationale = await resolveStaticSourceUnmappedRationale(
    supabase,
    projectId,
    fields,
    tables,
  )

  return assembleMappingsForRedesign({
    projectId,
    datasets,
    tables,
    fields,
    tfms,
    mappingSources,
    sourceAcks,
    transformations,
    coverage,
    staticSourceRationale,
    tableMappings,
    partitionsEnabled,
  })
}

// ─── Mapping generation: persistence helper ──────────────────────────

interface ClaudeTmPersistArgs {
  supabase: SupabaseClient
  projectId: string
  tableMappingId: string
  sourceFieldMap: Map<string, { id: string; name: string }>
  targetFieldMap: Map<string, { id: string; name: string }>
  fieldMappings: ClaudeFieldMapping[]
  sourceTableId: string
}

/**
 * Insert one TFM per target field plus its mapping_sources children
 * for a single (source_table, target_table) pair. Includes the
 * many-to-one collision-collapse logic that protects the
 * `UNIQUE (project_id, target_field_id)` constraint.
 *
 * Used by both `runMappingGeneration` (initial generation, this file)
 * and `runMappingGenerationForPair` (per-pair regenerate path,
 * `lib/actions/mappings.ts`).
 */
export async function persistClaudeFieldMappingsForTM(
  args: ClaudeTmPersistArgs,
): Promise<{ inserted: number }> {
  const {
    supabase,
    projectId,
    tableMappingId,
    sourceFieldMap,
    targetFieldMap,
    fieldMappings,
    sourceTableId,
  } = args

  // Group incoming suggestions by target field so we emit exactly one TFM
  // per target (with its ordinal=0 primary + ordinal=N contributors). Claude
  // may emit the same target twice in many-to-one form; collapse here.
  type CollapsedEntry = {
    targetFieldId: string
    primarySourceId: string
    contributorSourceIds: string[]
    combinationType: TFMCombinationType
    combinationHint: string
    reasoning: string
    confidence: number
    similar: string[]
    typeCompatibility: string | null
    transformSql?: string
  }
  const byTarget = new Map<string, CollapsedEntry>()

  for (const fm of fieldMappings) {
    const srcKey = bareTableName(fm.source_field)
    const tgtKey = bareTableName(fm.target_field)
    const srcField = sourceFieldMap.get(srcKey)
    const tgtField = targetFieldMap.get(tgtKey)
    if (!srcField || !tgtField) {
      console.warn(
        `[mappings] Field no match: "${fm.source_field}" → "${fm.target_field}"`,
      )
      continue
    }

    const mappingType = fm.mapping_type || 'one_to_one'
    const combinationType: TFMCombinationType =
      mappingType === 'many_to_one' ? 'concat_space' : 'single'

    let reasoningText = fm.reasoning
    if (fm.combination_hint) reasoningText += ` [Combination: ${fm.combination_hint}]`
    if (fm.split_hint) reasoningText += ` [Split: ${fm.split_hint}]`

    const existing = byTarget.get(tgtField.id)
    if (!existing) {
      const contributors: string[] = []
      if (mappingType === 'many_to_one' && fm.contributing_source_fields?.length) {
        for (const name of fm.contributing_source_fields) {
          const c = sourceFieldMap.get(bareTableName(name))
          if (c && c.id !== srcField.id) contributors.push(c.id)
        }
      }
      byTarget.set(tgtField.id, {
        targetFieldId: tgtField.id,
        primarySourceId: srcField.id,
        contributorSourceIds: contributors,
        combinationType,
        combinationHint: fm.combination_hint ?? '',
        reasoning: reasoningText,
        confidence: fm.confidence,
        similar: fm.similar_fields_considered ?? [],
        typeCompatibility: fm.type_compatibility ?? null,
        transformSql: fm.transform_sql,
      })
    } else {
      // Second row for same target — treat as contributor (many-to-one).
      if (srcField.id !== existing.primarySourceId) {
        existing.contributorSourceIds.push(srcField.id)
        existing.combinationType = 'concat_space'
      }
    }
  }

  let inserted = 0
  for (const entry of byTarget.values()) {
    const sources = [
      {
        source_field_id: entry.primarySourceId,
        source_table_id: sourceTableId,
        confidence: entry.confidence,
        ai_reasoning: entry.reasoning,
        similar_fields_considered: entry.similar,
        type_compatibility: entry.typeCompatibility,
        ordinal: 0,
      },
      ...entry.contributorSourceIds.map((cid, i) => ({
        source_field_id: cid,
        source_table_id: sourceTableId,
        confidence: entry.confidence,
        ai_reasoning: `Contributing source for many-to-one. ${entry.combinationHint}`.trim(),
        similar_fields_considered: [] as string[],
        type_compatibility: entry.typeCompatibility,
        ordinal: i + 1,
      })),
    ]

    const { data: tfmId, error } = await supabase.rpc('dq_create_target_field_mapping', {
      p_project_id: projectId,
      p_target_field_id: entry.targetFieldId,
      p_sources: sources,
      p_combination: {
        type: entry.combinationType,
        ai_reasoning: entry.reasoning,
      },
      p_table_mapping_id: tableMappingId,
    })
    if (error) {
      console.error(
        `[mappings] dq_create_target_field_mapping failed for target ${entry.targetFieldId}:`,
        error.message,
      )
      continue
    }
    inserted++

    if (tfmId && entry.transformSql) {
      // Static-only validation (no RPC) — avoid N async calls in batch loop.
      const l1Result = await validateTransformSQL(entry.transformSql)
      const validationIssues = l1Result.issues.length > 0 ? l1Result.issues : null

      const { error: txErr } = await supabase
        .from('transformations')
        .insert({
          target_field_mapping_id: tfmId as string,
          description: null,
          generated_sql: entry.transformSql,
          is_ai_generated: true,
          status: 'draft',
          test_results: null,
          validation_issues: validationIssues,
        })
      if (txErr) {
        console.error(
          `[mappings] transformations insert failed for TFM ${tfmId}:`,
          txErr.message,
        )
      }
    }
  }

  return { inserted }
}

// ─── Mapping generation: orchestrator ─────────────────────────────────

/**
 * Initial-generation orchestrator. Per-source-table batch loop that
 * calls Claude with the canonical mapping prompt, parses the
 * response (with one JSON-repair retry), and persists new TFMs via
 * the `dq_create_target_field_mapping` RPC.
 *
 * Skips (source, target) pairs already represented in
 * `existingPairSet` — the wrapper at
 * `lib/actions/mappings.ts:generateMappings` builds and passes in
 * the set.
 *
 * Returns:
 *   • `{ success: true, generated: N, skipped: M, message? }` on
 *     successful runs (including all-skipped, which returns
 *     `generated: 0` with the user-facing "all already mapped" message)
 *   • `{ success: false, errorCode: 'INTERNAL', error }` on:
 *       — zero stored AND zero skipped (Claude returned table names
 *         that didn't match any source/target table in the project)
 *       — uncaught exceptions during the AI work
 *
 * Does NOT produce 'VALIDATION' / 'PERMISSION_DENIED' /
 * 'MAINTENANCE_MODE' / 'NOT_FOUND' — those are wrapper concerns.
 */
export async function runMappingGeneration(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  sourceTableIds: string[],
  targetTableIds: string[],
  existingPairSet: Set<string>,
): Promise<{
  success: boolean
  error?: string
  errorCode?: 'INTERNAL'
  generated?: number
  skipped?: number
  message?: string
}> {
  try {
    // PR 3.4b — Phase 3 agent-loop adoption gate. Default OFF preserves
    // heritage flag-OFF byte-identical behavior. When ON, both the
    // pre-loop aiCtx (per-role sample bumps) and the per-iteration
    // gate route through `runAgentLoop` instead of single-shot callLLM.
    const phase3Enabled = process.env.AI_PHASE_3_ENABLED === '1'
    const { data: sourceTables, error: stErr } = await supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name)')
      .in('id', sourceTableIds)
    if (stErr) throw stErr

    const { data: targetTables, error: ttErr } = await supabase
      .from('tables')
      .select('id, name, dataset_id, datasets(id, name)')
      .in('id', targetTableIds)
    if (ttErr) throw ttErr

    const { data: sourceFields, error: sfErr } = await supabase
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
      .in('table_id', sourceTableIds)
      .order('ordinal_position', { ascending: true })
    if (sfErr) throw sfErr

    const { data: targetFields, error: tfErr } = await supabase
      .from('fields')
      .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, check_constraint')
      .in('table_id', targetTableIds)
      .order('ordinal_position', { ascending: true })
    if (tfErr) throw tfErr

    const aiCtx = await buildAIContext(
      projectId,
      {
        tableIds: [...sourceTableIds, ...targetTableIds],
        includeProfilingStats: true,
        includeValueDistributions: true,
        includeSampleValues: true,
        includeDocuments: true,
        maxDistributionValues: 15,
        maxSampleValues: 5,
        // PR 3.4b — agent path uses asymmetric per-role sample budgets
        // (LOCK #5/#6/#7). Spread is empty under flag-OFF → byte-identical.
        ...(phase3Enabled && { maxSourceSampleValues: 50, maxTargetSampleValues: 30 }),
      },
      userId,
      // Pass the caller's client so buildAIContext skips cookies()-based
      // auth. Matches the eval-runner injection pattern (PR 10.4).
      // reason: SupabaseClient generic params differ from createClient return
      supabase as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    )

    interpretFieldDomains(projectId, sourceTableIds, userId).catch((err) =>
      console.error('[mapping] interpretFieldDomains failed:', err),
    )
    interpretCrossSystemSynonyms(projectId, sourceTableIds, userId).catch((err) =>
      console.error('[mapping] interpretCrossSystemSynonyms failed:', err),
    )

    // S2.3 — fetch template for this system pair (fire once, reuse per batch)
    const srcDs = sourceTables?.[0]?.datasets as unknown as { name: string } | null
    const tgtDs = targetTables?.[0]?.datasets as unknown as { name: string } | null
    const srcSystem = srcDs?.name ?? ''
    const tgtSystem = tgtDs?.name ?? ''
    let template: MigrationTemplate | null = null
    if (srcSystem && tgtSystem) {
      const { data: project } = await supabase
        .from('projects').select('org_id').eq('id', projectId).single()
      if (project) {
        const r = await findTemplate(
          (project as typeof project & { org_id: string }).org_id,
          srcSystem,
          tgtSystem,
        )
        template = r.data ?? null
      }
    }

    // PR 3.4b — fetch business_context + compute schema-overview once
    // (single read for the whole BULK loop). Both null/empty when flag OFF.
    const businessContext = phase3Enabled
      ? await readBusinessContext(supabase, projectId)
      : null
    const schemaOverviewBlock = phase3Enabled ? formatSchemaOverviewBlock(aiCtx) : ''

    const targetSection = formatSchemaForPrompt(aiCtx.target_tables, 'target')
    const docBlock = formatDocumentsForPrompt(aiCtx.documents)
    // POC answer key (authoritative) — already proven on the transform path;
    // the mapping path was loading it into aiCtx but never injecting it.
    // Empty string when no answer key is present (non-POC projects).
    const pocBlock = formatPocAnswerKeyBlock(aiCtx.documents.poc_answer_key)

    const sourceFieldNamesByTableId = new Map<string, string[]>()
    for (const f of sourceFields ?? []) {
      const list = sourceFieldNamesByTableId.get(f.table_id) ?? []
      list.push(f.name)
      sourceFieldNamesByTableId.set(f.table_id, list)
    }
    const sourceTableRowsByNameKey = new Map(
      (sourceTables ?? []).map((t) => [t.name.toLowerCase(), t]),
    )

    // SET-35 — FK context block (computed once, reused per batch)
    const sourceTableNameById = new Map(
      (sourceTables ?? []).map((t) => [t.id, t.name]),
    )
    const targetTableNameById = new Map(
      (targetTables ?? []).map((t) => [t.id, t.name]),
    )
    const fkBlock = buildFKRelationshipBlock(
      (sourceFields ?? []).map(f => ({
        name: f.name,
        table_id: f.table_id,
        is_foreign_key: f.is_foreign_key,
        fk_reference: f.fk_reference,
      })),
      (targetFields ?? []).map(f => ({
        name: f.name,
        table_id: f.table_id,
        is_foreign_key: f.is_foreign_key ?? false,
        fk_reference: f.fk_reference ?? null,
      })),
      sourceTableNameById,
      targetTableNameById,
    ) || null

    // Streaming + 32k token budget per batch (May 2026 incident).
    // Pre-incident: 16000, set when mapping_generate ran non-streaming.
    // Bumped to 32000 because (a) streaming responses for projects with
    // 100+ source/target field pairs were truncating the
    // emit_table_mappings tool input mid-array, and (b) streaming
    // removes the previous "non-streaming requires max_tokens ≤ ~8K
    // for low-latency" pressure. 32k stays inside Anthropic Sonnet
    // 4.6 / Opus 4.7 max_tokens limits (64k+).
    const PER_BATCH_MAX_TOKENS = 32000
    const allTableMappings: ClaudeTableMapping[] = []
    const sourceTablesForBatching = aiCtx.source_tables

    for (let i = 0; i < sourceTablesForBatching.length; i++) {
      const sourceCtx = sourceTablesForBatching[i]
      console.log(`[Mapping] Generating mappings for ${sourceCtx.table_name} (${i + 1}/${sourceTablesForBatching.length})...`)

      const sourceSection = formatSchemaForPrompt([sourceCtx], 'source')
      const currentSourceRow = sourceTableRowsByNameKey.get(sourceCtx.table_name.toLowerCase())
      const otherSourcesList = (sourceTables ?? [])
        .filter((st) => st.id !== currentSourceRow?.id)
        .map((st) => {
          const fields = sourceFieldNamesByTableId.get(st.id) ?? []
          return `  - ${st.name} (${fields.join(', ')})`
        })
        .join('\n')

      const otherSourcesBlock = otherSourcesList
        ? `<other_source_tables>
These other source tables also exist in this migration and will be processed separately in their own requests. Use this information to decide whether the current source table (${sourceCtx.table_name}) is the best primary match for each target table. If another source table listed below is clearly a better primary match for a target, do NOT create a table_mapping to that target from ${sourceCtx.table_name} — let the better-matching source claim it in its own batch.

See the TABLE-LEVEL MATCHING rules in the system prompt for lookup/reference tables vs entity tables and weak-overlap handling.

${otherSourcesList}
</other_source_tables>`
        : ''

      const batchUserMessage = buildMappingUserMessage({
        sourceSection,
        targetSection,
        docBlock,
        intelligenceCtx: aiCtx.intelligence_context ?? null,
        otherSourcesBlock,
        templateBlock: template ? buildTemplateBlock(template, sourceCtx.table_name) : null,
        fkBlock: fkBlock || null,
        pocBlock: pocBlock || null,
      })

      // PR 12 H1: when AI_PHASE_2_ENABLED=1 the engine forces a tool
      // call (`emit_table_mappings`); otherwise the legacy text path
      // runs unchanged. Heritage byte-identical fingerprints depend
      // on the legacy path being preserved.
      const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
      let primaryResult: Awaited<ReturnType<typeof callLLM>>
      if (phase3Enabled) {
        // S1.1: agent path via runSingleAgentMappingLoop.
        const baseMetadata = {
          source_table_id: currentSourceRow?.id ?? null,
          source_table_name: sourceCtx.table_name,
          batch_index: i,
          batch_total: sourceTablesForBatching.length,
        }
        // S1.1: single-agent path (multi-agent dead code removed).
        const r = await runSingleAgentMappingLoop({
          supabase,
          projectId,
          userId,
          feature: 'mapping_generate',
          baseUserMessage: batchUserMessage,
          schemaOverviewBlock,
          businessContext,
          maxTokens: PER_BATCH_MAX_TOKENS,
          baseMetadata,
          // PR-CACHE-HOTFIX: disabled to unblock 4-block limit. See INF-5
          // for selective re-enable on top 4 blocks.
          cacheControl: false,
        })
        if (r.kind === 'agent_threw') {
          console.error(`[Mapping] Agent loop failed for source table ${sourceCtx.table_name}:`, r.error)
          continue
        }
        if (r.kind === 'fallback_threw') {
          console.error(`[Mapping] Schema-error fallback failed for ${sourceCtx.table_name}:`, r.error)
          continue
        }
        if (r.kind === 'aborted_other') {
          console.error(`[Mapping] Agent aborted for ${sourceCtx.table_name}: ${r.reason} — ${r.message}`)
          continue
        }
        primaryResult = r.result

        // S1.4 — self-correction: if the initial proposal has hard validation
        // errors, re-prompt up to MAX_CORRECTION_ITERATIONS times before
        // persisting. Only runs on the phase3 path where we have Opus + streaming.
        if (primaryResult.kind === 'toolUse') {
          const initialResponse = primaryResult.toolUse.input as { table_mappings?: ClaudeTableMapping[] }
          const currentSrcFields = (sourceFields ?? []).filter(f => f.table_id === currentSourceRow?.id)
          const correctionResult = await runSelfCorrectionLoop({
            initialResponse: { table_mappings: initialResponse.table_mappings ?? [] },
            initialLlmResult: primaryResult,
            sourceFields: currentSrcFields.map(f => ({
              name: f.name,
              data_type: f.data_type ?? f.inferred_type ?? 'unknown',
              is_nullable: f.is_nullable ?? true,
            })),
            targetFields: (targetFields ?? []).map(f => ({
              name: f.name,
              data_type: f.data_type ?? f.inferred_type ?? 'unknown',
              is_nullable: f.is_nullable ?? true,
              is_primary_key: f.is_primary_key ?? false,
              is_foreign_key: f.is_foreign_key ?? false,
              fk_reference: f.fk_reference ?? null,
            })),
            originalUserMessage: batchUserMessage,
            feature: 'mapping_generate',
            projectId,
            userId,
            maxTokens: PER_BATCH_MAX_TOKENS,
          })

          if (correctionResult.correctionsApplied > 0 || correctionResult.unresolvableFields.length > 0) {
            console.log(
              `[Mapping] Self-correction for ${sourceCtx.table_name}: ` +
              `${correctionResult.correctionsApplied} iteration(s), ` +
              `exit=${correctionResult.exitReason}, ` +
              `unresolvable=${correctionResult.unresolvableFields.length}`,
            )
          }

          // Replace primaryResult with the corrected LLM result so the
          // allTableMappings.push below accumulates the corrected proposals.
          primaryResult = correctionResult.llmResult
        }
      } else {
        try {
          // Streaming switch (May 2026 incident): mapping_generate uses
          // callLLMStreaming on the BULK legacy single-shot path.
          // Streaming + tool_use is supported on @anthropic-ai/sdk 0.78
          // via stream.finalMessage() — the wrapper assembles the full
          // tool_use block and returns the same { kind: 'toolUse' }
          // shape as the non-streaming wrapper, so callers downstream
          // (extractTransformSQL, persistence) are unchanged. Streaming
          // unblocks the 32k token budget required for projects with
          // 100+ field-pair source/target sets (non-streaming
          // truncates at the previous 16k).
          primaryResult = await callLLMStreaming({
            feature: 'mapping_generate',
            systemPrompt: withProvenanceGuidance(MAPPING_GENERATION_SYSTEM_PROMPT),
            userMessage: batchUserMessage,
            maxTokens: PER_BATCH_MAX_TOKENS,
            projectId,
            userId,
            promptVersion: 'mapping-v1-streaming',
            abuseUserId: userId,
            metadata: {
              source_table_id: currentSourceRow?.id ?? null,
              source_table_name: sourceCtx.table_name,
              batch_index: i,
              batch_total: sourceTablesForBatching.length,
            },
            ...(phase2Enabled && { tool: EMIT_TABLE_MAPPINGS_TOOL }),
            // PR-CACHE-HOTFIX: disabled to unblock 4-block limit. See INF-5
            // for selective re-enable on top 4 blocks.
            cacheControl: false,
          })
        } catch (err) {
          console.error(`[Mapping] Claude call failed for source table ${sourceCtx.table_name}:`, err)
          continue
        }
      }

      if (primaryResult.kind === 'toolUse') {
        // PR 12 flag-ON: tool input is already schema-validated by
        // Anthropic; parse failures are structurally impossible here,
        // so the legacy `mapping_generate_repair` retry below is
        // unreachable on this branch.
        const input = primaryResult.toolUse.input as { table_mappings?: ClaudeTableMapping[] }
        allTableMappings.push(...(input.table_mappings ?? []))
      } else {
        // PR 12 flag-OFF: legacy JSON.parse + repair-retry path.
        // Preserved verbatim to keep heritage fingerprints byte-identical.
        const batchRaw = primaryResult.text
        const primaryCallId = primaryResult.callId
        try {
          const batchParsed = parseClaudeJSON(batchRaw)
          allTableMappings.push(...(batchParsed.table_mappings ?? []))
        } catch {
          try {
            const retryResult = await callLLM({
              feature: 'mapping_generate_repair',
              systemPrompt: 'You are a JSON repair tool. Return ONLY valid JSON, nothing else.',
              userMessage: `The previous response was malformed JSON. Fix it and return ONLY the corrected JSON:\n\n${batchRaw}`,
              maxTokens: PER_BATCH_MAX_TOKENS,
              projectId,
              userId,
              promptVersion: 'mapping-repair-v1',
              parentCallId: primaryCallId,
              abuseUserId: userId,
            })
            // The retry runs on the legacy text path (no tool passed)
            // so the result is always { kind: 'text', text }; the
            // discriminator narrowing is required for tsc.
            if (retryResult.kind !== 'text') {
              throw new Error('Unexpected toolUse on mapping_generate_repair retry')
            }
            const retryParsed = parseClaudeJSON(retryResult.text)
            allTableMappings.push(...(retryParsed.table_mappings ?? []))
          } catch (retryErr) {
            console.error(`[Mapping] Failed to parse mappings for source table ${sourceCtx.table_name} after retry:`, retryErr)
          }
        }
      }
    }

    const parsedResponse: ClaudeResponse = { table_mappings: allTableMappings }

    let skippedCount = 0

    const sourceTableMap = new Map((sourceTables ?? []).map((t) => [t.name.toLowerCase(), t]))
    const targetTableMap = new Map((targetTables ?? []).map((t) => [t.name.toLowerCase(), t]))

    const sourceFieldsByTable = new Map<string, Map<string, (typeof sourceFields)[number]>>()
    for (const f of sourceFields ?? []) {
      if (!sourceFieldsByTable.has(f.table_id)) sourceFieldsByTable.set(f.table_id, new Map())
      sourceFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
    }
    const targetFieldsByTable = new Map<string, Map<string, (typeof targetFields)[number]>>()
    for (const f of targetFields ?? []) {
      if (!targetFieldsByTable.has(f.table_id)) targetFieldsByTable.set(f.table_id, new Map())
      targetFieldsByTable.get(f.table_id)!.set(f.name.toLowerCase(), f)
    }

    let storedCount = 0

    for (const tm of parsedResponse.table_mappings) {
      if (!tm.source_table || !tm.target_table) continue
      const srcKey = bareTableName(tm.source_table)
      const tgtKey = bareTableName(tm.target_table)
      if (!srcKey || !tgtKey) continue
      const srcTable = sourceTableMap.get(srcKey)
      const tgtTable = targetTableMap.get(tgtKey)
      if (!srcTable || !tgtTable) {
        console.warn(`[mappings] No match for "${tm.source_table}" → "${tm.target_table}"`)
        continue
      }

      const pairKey = `${srcTable.id}::${tgtTable.id}`
      if (existingPairSet.has(pairKey)) {
        skippedCount++
        continue
      }

      const { data: insertedTM, error: tmErr } = await supabase
        .from('table_mappings')
        .insert({
          project_id: projectId,
          source_table_id: srcTable.id,
          target_table_id: tgtTable.id,
          confidence: tm.confidence,
          status: 'needs_review',
          ai_reasoning: tm.reasoning,
        })
        .select('id')
        .single()

      if (tmErr || !insertedTM) continue
      storedCount++

      await persistClaudeFieldMappingsForTM({
        supabase,
        projectId,
        tableMappingId: insertedTM.id,
        sourceFieldMap: sourceFieldsByTable.get(srcTable.id) ?? new Map(),
        targetFieldMap: targetFieldsByTable.get(tgtTable.id) ?? new Map(),
        fieldMappings: tm.field_mappings ?? [],
        sourceTableId: srcTable.id,
      })

      // SET-36: persist structured value assignments for unmapped target fields.
      // The LLM emits unmapped_fields with "Constant: X" / "Leave NULL" /
      // "Requires manual input" assignments. We create acknowledged TFM rows
      // so they appear in the UI for review.
      // Guard: skip fields that already have a mapped TFM (from this batch or
      // a prior batch) to avoid overwriting real mappings with VA rows.
      if (tm.unmapped_fields && tm.unmapped_fields.length > 0) {
        const tgtFMap = targetFieldsByTable.get(tgtTable.id) ?? new Map()
        const mappedTargetKeys = new Set(
          (tm.field_mappings ?? []).map(fm => bareTableName(fm.target_field)),
        )
        for (const uf of tm.unmapped_fields) {
          const tgtKey = bareTableName(uf.target_field)
          if (mappedTargetKeys.has(tgtKey)) continue
          const tgtField = tgtFMap.get(tgtKey)
          if (!tgtField) continue
          // Only INSERT if no TFM exists yet — don't overwrite a prior batch's mapping
          const { data: existing } = await supabase
            .from('target_field_mappings')
            .select('id')
            .eq('project_id', projectId)
            .eq('target_field_id', tgtField.id)
            .limit(1)
          if (existing && existing.length > 0) continue
          try {
            await supabase
              .from('target_field_mappings')
              .insert({
                project_id: projectId,
                target_field_id: tgtField.id,
                table_mapping_id: insertedTM.id,
                is_acknowledged: true,
                acknowledgment_reason: uf.assignment,
                ai_reasoning: uf.reasoning,
                status: 'needs_review',
                combination_type: null,
                combination_sql: null,
                confidence: null,
              })
          } catch (err) {
            console.warn(`[mappings] VA persist failed for ${uf.target_field}:`, err)
          }
        }
      }

      // Deterministic validation pass — runs on schema metadata only (no
      // profiling stats at this callsite). Issues are logged under the
      // [validation] tag in Vercel. No DB writes yet: persisting to a
      // dedicated table requires a migration that's blocked on Supabase
      // env access (alex/deterministic-validation branch TODO).
      {
        const srcFMap = sourceFieldsByTable.get(srcTable.id) ?? new Map()
        const tgtFMap = targetFieldsByTable.get(tgtTable.id) ?? new Map()
        const proposals: MappingProposal[] = []
        for (const fm of tm.field_mappings ?? []) {
          const srcF = srcFMap.get(bareTableName(fm.source_field))
          const tgtF = tgtFMap.get(bareTableName(fm.target_field))
          if (!srcF || !tgtF) continue
          proposals.push({
            sourceFields: [{
              name: srcF.name,
              dataType: srcF.data_type ?? srcF.inferred_type ?? 'unknown',
              isNullable: srcF.is_nullable ?? true,
            }],
            targetField: {
              name: tgtF.name,
              dataType: tgtF.data_type ?? tgtF.inferred_type ?? 'unknown',
              isNullable: tgtF.is_nullable ?? true,
              isPrimaryKey: tgtF.is_primary_key ?? false,
              isUnique: false, // not in fields query; conservative default
              isForeignKey: tgtF.is_foreign_key ?? false,
              fkReference: tgtF.fk_reference ?? null,
            },
          })
        }
        if (proposals.length > 0) {
          const batchResults = validateMappingBatch(proposals)
          for (const [targetName, vr] of batchResults) {
            if (!vr.valid || vr.counts.warnings > 0) {
              console.warn(
                `[validation] ${srcTable.name}→${tgtTable.name} target=${targetName}`,
                JSON.stringify({ valid: vr.valid, counts: vr.counts, issues: vr.issues }),
              )
            }
          }
        }
      }
    }

    if (storedCount === 0) {
      if (skippedCount > 0) {
        return {
          success: true,
          generated: 0,
          skipped: skippedCount,
          message: 'All selected table pairs already have mappings. Go to the Mapping tab to manage them.',
        }
      }
      console.error(
        '[mappings] Zero table mappings stored. Claude response tables:',
        parsedResponse.table_mappings.map((tm) => `${tm.source_table} → ${tm.target_table}`),
      )
      return {
        success: false,
        error: `AI returned ${parsedResponse.table_mappings.length} mapping suggestion(s) but none matched your table names. Please try again — the AI may need another attempt to use the correct names.`,
        errorCode: 'INTERNAL',
      }
    }

    return {
      success: true,
      generated: storedCount,
      skipped: skippedCount,
      message:
        skippedCount > 0
          ? `Generated mappings for ${storedCount} table pair${storedCount !== 1 ? 's' : ''}. Skipped ${skippedCount} pair${skippedCount !== 1 ? 's' : ''} that already have mappings.`
          : undefined,
    }
  } catch (err) {
    console.error('runMappingGeneration error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Generation failed', errorCode: 'INTERNAL' }
  }
}

// ─── Mapping suggestion: prompts + types ─────────────────────────────

/**
 * System prompt for the per-target Suggest Claude call. Distinct
 * from `MAPPING_GENERATION_SYSTEM_PROMPT` BY DESIGN — see the
 * investigation report §4.2 for the rationale (different scope:
 * per-target with caller-narrowed schema vs. per-source-table batch
 * with full-context decision-making). Do NOT unify the two prompts.
 *
 * Locked content — see `tests/integration/mappings-for-redesign-heritage.test.ts`
 * `suggestMappingForTarget happy path` for end-to-end coverage.
 */
export const MAPPING_SUGGESTION_SYSTEM_PROMPT =
  'You are a data migration expert. Return ONLY valid JSON.'

/**
 * Max characters for the LLM-emitted rationale string. Trimmed at
 * the boundary so wire payloads stay bounded and the form pre-fill
 * stays compact. Also referenced verbatim in the user message
 * (`rationale is a brief explanation, ≤ N characters`) so the LLM
 * sees the cap.
 */
export const RATIONALE_MAX_CHARS = 280

interface ClaudeSuggestionResponse {
  source_field_names?: unknown
  combination_type?: unknown
  confidence?: unknown
  rationale?: unknown
}

// ─── Mapping suggestion: orchestrator ─────────────────────────────────

/**
 * Per-target Suggest orchestrator. Reads the target field, builds a
 * project-wide AI context, calls Claude with a per-target prompt,
 * parses + validates the response, translates LLM-emitted source
 * field names into UUIDs (with same-table guard), and returns an
 * ephemeral suggestion for the form to pre-fill.
 *
 * NO DB writes. NO audit log. Confirmation flows through
 * `createFieldMapping` with `aiSuggested: true`.
 *
 * Returns:
 *   • `{ success: true, suggestion: { sourceFieldIds, combinationType,
 *     confidence, rationale } }` on a parsable, usable LLM response
 *   • `{ success: false, errorCode: 'NOT_FOUND' }` for missing target
 *     field, cross-project target, no source tables, or no source
 *     fields
 *   • `{ success: false, errorCode: 'AI_INVALID_RESPONSE' }` for
 *     LLM parse / shape / cross-table failures
 *   • `{ success: false, errorCode: 'INTERNAL' }` for context-build
 *     failures, Claude call failures, source-field read failures
 *
 * Does NOT produce 'PERMISSION_DENIED' / 'RATE_LIMITED' — those are
 * wrapper concerns.
 *
 * The wrapper at `lib/actions/mappings-for-redesign.ts:suggestMappingForTarget`
 * passes `supabaseAdmin` as the `supabase` parameter (legacy bypassed
 * RLS for the reads after explicit `requireProjectPermission`). The
 * engine doesn't care which client it gets; it uses what's given.
 */
export async function runMappingSuggestion(
  supabase: SupabaseClient,
  userId: string,
  projectId: string,
  targetFieldId: string,
  // Path 2 PR 1: optional eval-runner feature override. When present,
  // routes the LLM call to the eval_* feature taxonomy so production
  // cost reports stay clean. Production callsites omit this parameter
  // and behavior is unchanged. Mirrors the runMappingGenerationForPair
  // pattern (lib/actions/mappings.ts:121).
  featureOverride?: import('@/lib/ai/llm-client').LLMFeature,
): Promise<
  | {
      success: true
      suggestion: {
        sourceFieldIds: string[]
        combinationType: 'single' | 'concat_space' | 'concat_comma'
        confidence: number
        rationale: string
      }
    }
  | {
      success: false
      error: string
      errorCode: 'NOT_FOUND' | 'AI_INVALID_RESPONSE' | 'INTERNAL'
    }
> {
  // ── Read target field identity ───────────────────────────────────────────
  const { data: targetField, error: tfErr } = await supabase
    .from('fields')
    // Same join-chain caveat as `createFieldMapping`: walk through
    // datasets to reach project_id (`tables` has no project_id column).
    // `tables.name` lives on `tables` itself so it stays at the first
    // hop alongside the nested `datasets!inner(project_id)`.
    .select(
      'id, name, data_type, is_primary_key, is_foreign_key, is_nullable, table_id, tables!inner(name, datasets!inner(project_id))',
    )
    .eq('id', targetFieldId)
    .single<{
      id: string
      name: string
      data_type: string
      is_primary_key: boolean | null
      is_foreign_key: boolean | null
      is_nullable: boolean | null
      table_id: string
      tables:
        | {
            name: string
            datasets:
              | { project_id: string }
              | { project_id: string }[]
              | null
          }
        | {
            name: string
            datasets:
              | { project_id: string }
              | { project_id: string }[]
              | null
          }[]
        | null
    }>()
  if (tfErr || !targetField) {
    return {
      success: false,
      error: 'Target field not found',
      errorCode: 'NOT_FOUND',
    }
  }

  const targetTablesNode = Array.isArray(targetField.tables)
    ? targetField.tables[0]
    : targetField.tables
  const targetDatasetsNode = Array.isArray(targetTablesNode?.datasets)
    ? targetTablesNode?.datasets[0]
    : targetTablesNode?.datasets
  const targetProjectId = targetDatasetsNode?.project_id
  if (targetProjectId !== projectId) {
    return {
      success: false,
      error: 'Target field does not belong to this project',
      errorCode: 'NOT_FOUND',
    }
  }
  const targetTableName = targetTablesNode?.name ?? '?'

  const staticSuggestion = await getStaticSuggestionForTarget({
    supabase,
    projectId,
    targetFieldId,
    rationaleMaxChars: RATIONALE_MAX_CHARS,
  })
  if (staticSuggestion.kind === 'suggestion') {
    return {
      success: true,
      suggestion: staticSuggestion.suggestion,
    }
  }
  if (staticSuggestion.kind === 'missing') {
    return {
      success: false,
      error: staticSuggestion.error,
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Build AI context (project-wide source schema) ────────────────────────
  // Reuse `buildAIContext` so we get sample values + value distributions +
  // documents in the same shape that `suggestRemainingMappings` does.
  // Project-wide scope — the prompt's "same-table only" constraint is
  // expressed in instruction text, not by filtering the context.
  let context: Awaited<ReturnType<typeof buildAIContext>>
  try {
    context = await buildAIContext(
      projectId,
      {
        includeValueDistributions: true,
        includeSampleValues: true,
        includeDocuments: true,
        maxDistributionValues: 10,
        maxSampleValues: 5,
      },
      userId,
      // Path 2 PR 1: pass the caller-supplied supabase client through
      // to buildAIContext. The default fallback (createClient()) uses
      // Next.js cookies which throw outside a request scope (CLI/eval
      // context). Production callsites already pass a request-scoped
      // client through `supabase`, so this is a no-op for them.
      supabase,
    )
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error ? err.message : 'Failed to build AI context',
      errorCode: 'INTERNAL',
    }
  }

  // Resolve a name→id map for source fields so we can translate the LLM's
  // bare-name output back to UUIDs. `buildAIContext`'s FieldContext does
  // NOT expose field UUIDs (intentional: it's a prompt-shape contract,
  // not a DB-shape contract), so we run a small companion query that
  // fetches just (id, name, table_id) for every source-side field.
  const sourceTableIds = context.source_tables.map((t) => t.table_id)
  if (sourceTableIds.length === 0) {
    return {
      success: false,
      error: 'No source tables available to map against',
      errorCode: 'NOT_FOUND',
    }
  }

  const { data: sourceFieldRows, error: sfQErr } = await supabase
    .from('fields')
    .select('id, name, table_id')
    .in('table_id', sourceTableIds)
    .returns<Array<{ id: string; name: string; table_id: string }>>()
  if (sfQErr || !sourceFieldRows) {
    return {
      success: false,
      error: sfQErr?.message ?? 'Failed to read source fields',
      errorCode: 'INTERNAL',
    }
  }

  const sourceFieldsByLowerName = new Map<
    string,
    { id: string; tableId: string }
  >()
  for (const row of sourceFieldRows) {
    // Last-write-wins for duplicate field names across source tables.
    // Acceptable for 4a-1 (same-table only) — the prompt instructs the
    // LLM to use a single source table, so collisions only matter if
    // the LLM ignores the instruction. 4a-3 will switch to fully-
    // qualified `Table.Field` lookups for cross-table.
    sourceFieldsByLowerName.set(row.name.toLowerCase(), {
      id: row.id,
      tableId: row.table_id,
    })
  }

  if (sourceFieldsByLowerName.size === 0) {
    return {
      success: false,
      error: 'No source fields available to map against',
      errorCode: 'NOT_FOUND',
    }
  }

  // ── Build the prompt ─────────────────────────────────────────────────────
  const targetTags: string[] = []
  if (targetField.is_primary_key) targetTags.push('PK')
  if (targetField.is_foreign_key) targetTags.push('FK')
  if (targetField.is_nullable) targetTags.push('nullable')
  const targetTagStr = targetTags.length ? ` [${targetTags.join(', ')}]` : ''

  // Pull the target field's own profile (samples + distribution) from
  // the context's `target_tables` if present. `FieldContext` exposes
  // `name` and `data_type` but not `id`, so match by table_id + name.
  let targetProfileBlock = ''
  for (const tbl of context.target_tables) {
    if (tbl.table_id !== targetField.table_id) continue
    const f = tbl.fields.find((x) => x.name === targetField.name)
    if (!f) continue
    const samples = f.sample_values?.slice(0, 5) ?? []
    const dist = f.value_distribution?.slice(0, 10) ?? []
    if (samples.length > 0) {
      targetProfileBlock += `\n  Samples: ${samples.map((v) => `"${v}"`).join(', ')}`
    }
    if (dist.length > 0) {
      targetProfileBlock += `\n  Values: ${dist
        .map((v) => `"${v.value}"(${v.count})`)
        .join(', ')}`
    }
    break
  }

  const sourceTablesBlock = context.source_tables
    .map((tbl) => {
      const lines = tbl.fields
        .map((f) => {
          const tags: string[] = []
          if (f.is_primary_key) tags.push('PK')
          if (f.is_foreign_key) tags.push('FK')
          if (f.is_nullable) tags.push('nullable')
          const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
          let line = `  - ${f.name} (${f.data_type})${tagStr}`
          if (f.value_distribution?.length) {
            const top = f.value_distribution.slice(0, 5)
            line += `\n      Values: ${top.map((v) => `"${v.value}"(${v.count})`).join(', ')}`
          } else if (f.sample_values?.length) {
            line += `\n      Samples: ${f.sample_values.slice(0, 3).map((v) => `"${v}"`).join(', ')}`
          }
          return line
        })
        .join('\n')
      return `<source_table name="${tbl.table_name}">\n${lines}\n</source_table>`
    })
    .join('\n\n')

  const docBlock = formatDocumentsForPrompt(context.documents)

  const userMsg = `Target field: ${targetTableName}.${targetField.name} (${targetField.data_type})${targetTagStr}${targetProfileBlock}

Suggest ONE mapping for this target field. Pick 1 or more source fields, all from the SAME source table. Cross-table sources are NOT allowed in this version.

Available source fields (grouped by source table):

${sourceTablesBlock}
${docBlock}
${context.intelligence_context ? context.intelligence_context + '\n\n' : ''}IMPORTANT:
- Use bare field names (not table.field).
- All source_field_names MUST come from the SAME source table.
- combination_type must be one of: "single", "concat_space", "concat_comma".
  Use "single" iff exactly one source. Use "concat_space" or "concat_comma" for 2+ sources.
- confidence is 0-100 indicating how confident you are in the proposed mapping.
- rationale is a brief explanation, ≤ ${RATIONALE_MAX_CHARS} characters.

Respond with ONLY valid JSON in this exact shape:
{"source_field_names": ["FieldA"], "combination_type": "single", "confidence": 85, "rationale": "Brief reason"}`

  // ── Call LLM ─────────────────────────────────────────────────────────────
  // PR 12 H1: tool use under flag ON; legacy text+JSON.parse under flag OFF.
  const phase2Enabled = process.env.AI_PHASE_2_ENABLED === '1'
  let result: Awaited<ReturnType<typeof callLLM>>
  try {
    result = await callLLM({
      feature: featureOverride ?? 'mapping_suggest',
      systemPrompt: withProvenanceGuidance(MAPPING_SUGGESTION_SYSTEM_PROMPT),
      userMessage: userMsg,
      maxTokens: 1024,
      projectId,
      userId,
      promptVersion: 'suggest-v1',
      abuseUserId: userId,
      metadata: { target_field_id: targetFieldId },
      ...(phase2Enabled && { tool: EMIT_MAPPING_SUGGESTION_TOOL }),
    })
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'AI call failed',
      errorCode: 'INTERNAL',
    }
  }

  // ── Parse + validate response ────────────────────────────────────────────
  // The legacy text path uses an inline parser because parseClaudeJSON
  // is shape-locked to `{ table_mappings }`. The tool-use path bypasses
  // both parsers entirely.
  let parsed: ClaudeSuggestionResponse
  if (result.kind === 'toolUse') {
    parsed = result.toolUse.input as ClaudeSuggestionResponse
  } else {
    const raw = result.text
    try {
      let cleaned = raw.trim()
      if (cleaned.startsWith('```')) {
        cleaned = cleaned
          .replace(/^```(?:json)?\n?/, '')
          .replace(/\n?```$/, '')
          .trim()
      }
      parsed = JSON.parse(cleaned) as ClaudeSuggestionResponse
    } catch {
      return {
        success: false,
        error: 'AI returned invalid JSON. Please try again.',
        errorCode: 'AI_INVALID_RESPONSE',
      }
    }
  }

  if (!Array.isArray(parsed.source_field_names)) {
    return {
      success: false,
      error: 'AI response missing source_field_names array',
      errorCode: 'AI_INVALID_RESPONSE',
    }
  }

  // Translate names → ids; strip unknowns; preserve LLM-emitted order.
  const resolvedIds: string[] = []
  const resolvedTableIds = new Set<string>()
  for (const rawName of parsed.source_field_names) {
    if (typeof rawName !== 'string') continue
    const bare = rawName.split('.').pop()!.toLowerCase().trim()
    const hit = sourceFieldsByLowerName.get(bare)
    if (!hit) continue
    if (resolvedIds.includes(hit.id)) continue // dedupe
    resolvedIds.push(hit.id)
    resolvedTableIds.add(hit.tableId)
  }

  if (resolvedIds.length === 0) {
    // Either LLM emitted nothing usable or all names stripped out.
    return {
      success: false,
      error:
        'AI did not return any usable source fields. Please pick sources manually.',
      errorCode: 'AI_INVALID_RESPONSE',
    }
  }

  // Same-table guard on the LLM output. If the LLM ignored the instruction
  // and emitted cross-table sources, drop the cross-table tail and keep
  // the dominant-table prefix. If no same-table subset survives, surface
  // AI_INVALID_RESPONSE so the user retries.
  if (resolvedTableIds.size > 1) {
    const dominantTableId = sourceFieldsByLowerName.get(
      String(parsed.source_field_names[0])
        .split('.')
        .pop()!
        .toLowerCase()
        .trim(),
    )?.tableId
    const sameTable = resolvedIds.filter((id) => {
      for (const v of sourceFieldsByLowerName.values()) {
        if (v.id === id) return v.tableId === dominantTableId
      }
      return false
    })
    if (sameTable.length === 0) {
      return {
        success: false,
        error:
          'AI suggested cross-table sources, which are not yet supported. Please pick sources manually.',
        errorCode: 'AI_INVALID_RESPONSE',
      }
    }
    resolvedIds.length = 0
    resolvedIds.push(...sameTable)
  }

  // Combination type narrowing.
  const rawCombo = String(parsed.combination_type ?? '').toLowerCase()
  let combinationType: 'single' | 'concat_space' | 'concat_comma'
  if (resolvedIds.length === 1) {
    combinationType = 'single'
  } else if (rawCombo === 'concat_comma') {
    combinationType = 'concat_comma'
  } else {
    // Default for 2+ sources matches the form's pre-selection (decision 7).
    combinationType = 'concat_space'
  }

  const confidenceNum = Number(parsed.confidence)
  const confidence =
    Number.isFinite(confidenceNum) && confidenceNum >= 0 && confidenceNum <= 100
      ? Math.round(confidenceNum)
      : 50

  const rationaleRaw =
    typeof parsed.rationale === 'string' ? parsed.rationale : ''
  const rationale = rationaleRaw.slice(0, RATIONALE_MAX_CHARS)

  return {
    success: true,
    suggestion: {
      sourceFieldIds: resolvedIds,
      combinationType,
      confidence,
      rationale,
    },
  }
}
