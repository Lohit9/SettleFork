/**
 * scripts/load-rootstock-spec.ts
 *
 * One-shot loader for the Rootstock POC mapping spec.
 *
 * Reads scripts/data/rootstock-spec.json (or --spec <path>), classifies each
 * entry into mapped TFM / value assignment / source acknowledgment, and writes
 * it to the target project. Sets projects.poc_template = 'rootstock' last,
 * which both (a) enables the <poc_answer_key> context block (context-builder.ts:361)
 * and (b) activates the Path D suppression check (path-d-mapping.ts:202).
 *
 * Usage:
 *   tsx scripts/load-rootstock-spec.ts \
 *     --project-id <uuid> \
 *     [--spec scripts/data/rootstock-spec.json] \
 *     [--dry-run] \
 *     [--force]
 *
 * Re-run idempotency: first run refuses if the project already has any
 * non-rejected TFMs; pass --force to wipe (TFMs cascade to transformations
 * + mapping_sources) and reload fresh.
 *
 * The loader bypasses RLS via the service-role client. It does NOT go through
 * the dq_create_target_field_mapping RPC (which only writes a subset of the
 * columns we need); instead it mirrors Path D's bulk-UPSERT pattern
 * (lib/ai/path-d-persistence.ts:500-505) so that ai_reasoning,
 * transformation_intent, needs_transformation, original_ai_reasoning, and
 * confidence are all written in a single round-trip per phase.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { config } from 'dotenv'
import { z } from 'zod'
import {
  EIM_IDENTITY_TARGET_FIELD_NAME,
  EIM_PARTITIONS,
  EIM_TARGET_TABLE,
  ICC_TARGET_TABLE,
  routePartition,
} from './rootstock-partitions'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local',
  )
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ── CLI ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const hasFlag = (name: string) => argv.includes(name)

const projectId = getArg('--project-id')
const specPath = getArg('--spec') ?? 'scripts/data/rootstock-spec.json'
const dryRun = hasFlag('--dry-run')
const force = hasFlag('--force')

if (!projectId) {
  console.error('Missing required argument: --project-id <uuid>')
  process.exit(1)
}

const POC_TEMPLATE_VALUE = 'rootstock'

// ── Zod schema ───────────────────────────────────────────────────────────

const EntrySchema = z.object({
  source_table: z.string().min(1),
  source_field: z.string().min(1),
  target_table: z.string().min(1),
  target_field: z.string().min(1),
  explanation: z.string(),
  transformation_needed: z.boolean(),
  transformations: z.array(z.string()),
  confidence: z.number().min(0).max(100),
})

const LoadOrderSchema = z.object({
  sequence: z.number().int(),
  target_table: z.string(),
  depends_on: z.array(z.string()),
  reason: z.string(),
})

const JoinDeclarationSchema = z.object({
  from_table: z.string().min(1),
  from_field: z.string().min(1),
  to_table: z.string().min(1),
  to_field: z.string().min(1),
})

const SpecSchema = z.array(
  z.object({
    project_ids: z.array(z.string().uuid()),
    load_order: z.array(LoadOrderSchema),
    joins: z.array(JoinDeclarationSchema).optional().default([]),
    entries: z.array(EntrySchema).min(1),
  }),
)

type EntryT = z.infer<typeof EntrySchema>
type JoinDeclaration = z.infer<typeof JoinDeclarationSchema>

// ── Classification ───────────────────────────────────────────────────────

type Classified =
  | { kind: 'mapped'; entry: EntryT }
  | { kind: 'value_assignment'; entry: EntryT }
  | { kind: 'source_ack'; entry: EntryT }

function classify(e: EntryT): Classified {
  const sourceUnmapped =
    e.source_table === 'Unmapped' && e.source_field === 'Unmapped'
  const targetUnmapped =
    e.target_table === 'Unmapped' && e.target_field === 'Unmapped'
  if (sourceUnmapped && targetUnmapped) {
    throw new Error(
      `Entry has BOTH source and target unmapped (no-op): ${JSON.stringify(e)}`,
    )
  }
  if (sourceUnmapped) return { kind: 'value_assignment', entry: e }
  if (targetUnmapped) return { kind: 'source_ack', entry: e }
  return { kind: 'mapped', entry: e }
}

// ── VA literal extraction ────────────────────────────────────────────────
// Matches the "Constant `X`" pattern only (backtick-quoted). Anything
// without backticks (prose-heavy rules, the 11 commodity codes) returns
// null — the user authors SQL via Generate Transform later. Conservative
// by design.

function extractValueLiteral(transformPRose: string | undefined): string | null {
  if (!transformPRose) return null
  const m = transformPRose.match(/Constant\s+`([^`]+)`/i)
  return m ? m[1]! : null
}

// ── Multi-source TFM composition ─────────────────────────────────────────
// For (target_table, target_field) groups with >1 mapped entry, combine the
// per-source ai_reasoning and transformation_intent into a single labeled
// block. Single-source TFMs use the entry's text verbatim.

function composeAiReasoning(entries: EntryT[]): string {
  if (entries.length === 1) return entries[0]!.explanation
  return entries
    .map((e) => `[${e.source_table}.${e.source_field}]\n${e.explanation}`)
    .join('\n\n')
}

function composeTransformationIntent(entries: EntryT[]): string | null {
  const intents = entries
    .map((e) => ({ src: `${e.source_table}.${e.source_field}`, t: e.transformations[0] }))
    .filter((x): x is { src: string; t: string } => Boolean(x.t))
  if (intents.length === 0) return null
  if (intents.length === 1) return intents[0]!.t
  return intents.map((x) => `[${x.src}]\n${x.t}`).join('\n\n')
}

// ── join_spec composition ────────────────────────────────────────────────
// Pre-computes the per-row mapping_sources.join_spec JSONB at load time so
// the runtime path in lib/utils/transform-cross-table.ts (deriveJoinSpec)
// short-circuits FK inference. Required because Rootstock source schemas
// carry no FK metadata — inferFkCandidates would return 0 candidates and
// the runtime would throw CROSS_TABLE_FK_INFERENCE_FAILED.
//
// Shape: { via_fk_field, to_fk_field } — the exact two snake_case keys
// buildJoinSpec reads at transform-cross-table.ts:296-307. Stored values
// are field NAMES, not UUIDs (verified at mappings-for-redesign.ts:728).
//
// Returns null for the dominant row (ordinal 0, where contributor table ==
// dominant) and for any same-table multi-source contributor. Throws when a
// cross-table contributor has no matching joins declaration — the loader
// then aborts before any DB write (Phase 5 runs before Phase 6 wipe).
//
// Known limitation: this populates join_spec uniformly for all multi-source
// cross-table TFMs. The platform's apply RPC currently supports only Shape 1
// (LEFT JOIN) semantics. The "Item Number" TFM is conceptually Shape 2
// (UNION ALL + dedup of SKUs from both tables); populating join_spec for it
// removes the FK-inference error but Apply will still produce wrong output
// until migration 076 grows UNION support. Item Description and the
// iccomcod external-id mapping are genuinely Shape 1 and work correctly.

function computeJoinSpec(
  dominantTableName: string,
  contributorTableName: string,
  joins: JoinDeclaration[],
  contextForError: string,
): { via_fk_field: string; to_fk_field: string } | null {
  if (contributorTableName === dominantTableName) return null

  const match = joins.find(
    (j) =>
      j.from_table === dominantTableName &&
      j.to_table === contributorTableName,
  )
  if (!match) {
    throw new Error(
      `Missing join declaration for cross-table TFM "${contextForError}": ` +
        `dominant="${dominantTableName}" contributor="${contributorTableName}". ` +
        `Add an entry to spec[0].joins with from_table="${dominantTableName}", ` +
        `to_table="${contributorTableName}".`,
    )
  }

  return {
    via_fk_field: match.from_field,
    to_fk_field: match.to_field,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

interface UnresolvedName {
  side: 'source' | 'target'
  table: string
  field: string
}

async function main(): Promise<void> {
  console.log(`[load-rootstock-spec] starting`)
  console.log(`  project_id : ${projectId}`)
  console.log(`  spec_path  : ${specPath}`)
  console.log(`  dry_run    : ${dryRun}`)
  console.log(`  force      : ${force}`)

  // ── Phase 1: parse + validate JSON ─────────────────────────────────────
  const raw = readFileSync(resolve(process.cwd(), specPath), 'utf-8')
  const parsed = SpecSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    console.error('[load-rootstock-spec] JSON failed Zod validation:')
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    process.exit(1)
  }
  const spec = parsed.data[0]
  if (!spec) {
    console.error('[load-rootstock-spec] spec array is empty')
    process.exit(1)
  }
  const { entries } = spec

  if (!spec.project_ids.includes(projectId!)) {
    console.warn(
      `[load-rootstock-spec] WARNING: --project-id ${projectId} is not in ` +
        `spec[0].project_ids (${spec.project_ids.join(', ')}). Proceeding ` +
        `because spec project_ids is advisory.`,
    )
  }

  // ── Phase 2: classify + dedup-detect ───────────────────────────────────
  const classified = entries.map(classify)

  // Mapped: dedup on full 4-tuple. Multi-source for same target is allowed.
  const mappedKey = (e: EntryT) =>
    `${e.source_table}|${e.source_field}|${e.target_table}|${e.target_field}`
  const vaKey = (e: EntryT) => `${e.target_table}|${e.target_field}`
  const ackKey = (e: EntryT) => `${e.source_table}|${e.source_field}`

  const seenMapped = new Set<string>()
  const seenVa = new Set<string>()
  const seenAck = new Set<string>()
  const dupes: string[] = []
  for (const c of classified) {
    if (c.kind === 'mapped') {
      const k = mappedKey(c.entry)
      if (seenMapped.has(k)) dupes.push(`mapped: ${k}`)
      seenMapped.add(k)
    } else if (c.kind === 'value_assignment') {
      const k = vaKey(c.entry)
      if (seenVa.has(k)) dupes.push(`value_assignment: ${k}`)
      seenVa.add(k)
    } else {
      const k = ackKey(c.entry)
      if (seenAck.has(k)) dupes.push(`source_ack: ${k}`)
      seenAck.add(k)
    }
  }
  if (dupes.length > 0) {
    console.error(`[load-rootstock-spec] duplicate entries detected:`)
    for (const d of dupes) console.error(`  ${d}`)
    process.exit(1)
  }

  // ── Phase 3: resolve table/field names → UUIDs ─────────────────────────
  console.log(`[load-rootstock-spec] resolving table/field names...`)

  const { data: datasets, error: dsErr } = await supabase
    .from('datasets')
    .select('id, role, name')
    .eq('project_id', projectId!)
  if (dsErr) {
    console.error(`[load-rootstock-spec] datasets read failed: ${dsErr.message}`)
    process.exit(1)
  }
  if (!datasets || datasets.length === 0) {
    console.error(
      `[load-rootstock-spec] no datasets found for project ${projectId}. ` +
        `Upload source + target schemas first.`,
    )
    process.exit(1)
  }
  const sourceDatasetIds = datasets.filter((d) => d.role === 'source').map((d) => d.id)
  const targetDatasetIds = datasets.filter((d) => d.role === 'target').map((d) => d.id)

  async function fetchTablesAndFields(datasetIds: string[]) {
    if (datasetIds.length === 0) return { tables: [], fields: [] }
    const { data: tbls, error: tErr } = await supabase
      .from('tables')
      .select('id, name, dataset_id')
      .in('dataset_id', datasetIds)
    if (tErr) throw new Error(`tables read: ${tErr.message}`)
    const tableIds = (tbls ?? []).map((t) => t.id)
    if (tableIds.length === 0) return { tables: tbls ?? [], fields: [] }
    const { data: flds, error: fErr } = await supabase
      .from('fields')
      .select('id, name, table_id')
      .in('table_id', tableIds)
    if (fErr) throw new Error(`fields read: ${fErr.message}`)
    return { tables: tbls ?? [], fields: flds ?? [] }
  }

  const src = await fetchTablesAndFields(sourceDatasetIds)
  const tgt = await fetchTablesAndFields(targetDatasetIds)

  type TblRow = { id: string; name: string; dataset_id: string }
  type FldRow = { id: string; name: string; table_id: string }

  function buildResolver(tables: TblRow[], fields: FldRow[]) {
    const tableByName = new Map<string, TblRow[]>()
    for (const t of tables) {
      const arr = tableByName.get(t.name) ?? []
      arr.push(t)
      tableByName.set(t.name, arr)
    }
    const fieldByTblId = new Map<string, Map<string, FldRow>>()
    for (const f of fields) {
      const inner = fieldByTblId.get(f.table_id) ?? new Map<string, FldRow>()
      inner.set(f.name, f)
      fieldByTblId.set(f.table_id, inner)
    }
    function resolveField(
      tableName: string,
      fieldName: string,
    ): { tableId: string; fieldId: string } | null {
      const tbls = tableByName.get(tableName)
      if (!tbls || tbls.length === 0) return null
      // If multiple tables share the name (rare), accept only when the
      // field also resolves uniquely across them.
      for (const t of tbls) {
        const inner = fieldByTblId.get(t.id)
        const f = inner?.get(fieldName)
        if (f) return { tableId: t.id, fieldId: f.id }
      }
      return null
    }
    // PR Ω.3.6 — table-only resolver for partition TM creation (Phase 6.5
    // hardcodes EIM partitions; needs source/target table ids without a
    // specific field reference).
    function resolveTable(tableName: string): { tableId: string } | null {
      const tbls = tableByName.get(tableName)
      if (!tbls || tbls.length === 0) return null
      // Take the first match; same uniqueness assumption as resolveField.
      return { tableId: tbls[0]!.id }
    }
    return { resolveField, resolveTable }
  }

  const srcResolver = buildResolver(src.tables as TblRow[], src.fields as FldRow[])
  const tgtResolver = buildResolver(tgt.tables as TblRow[], tgt.fields as FldRow[])
  const resolveSource = srcResolver.resolveField
  const resolveTarget = tgtResolver.resolveField
  const resolveSourceTable = srcResolver.resolveTable
  const resolveTargetTable = tgtResolver.resolveTable

  const unresolved: UnresolvedName[] = []
  for (const c of classified) {
    if (c.kind === 'mapped') {
      if (!resolveSource(c.entry.source_table, c.entry.source_field)) {
        unresolved.push({
          side: 'source',
          table: c.entry.source_table,
          field: c.entry.source_field,
        })
      }
      if (!resolveTarget(c.entry.target_table, c.entry.target_field)) {
        unresolved.push({
          side: 'target',
          table: c.entry.target_table,
          field: c.entry.target_field,
        })
      }
    } else if (c.kind === 'value_assignment') {
      if (!resolveTarget(c.entry.target_table, c.entry.target_field)) {
        unresolved.push({
          side: 'target',
          table: c.entry.target_table,
          field: c.entry.target_field,
        })
      }
    } else {
      if (!resolveSource(c.entry.source_table, c.entry.source_field)) {
        unresolved.push({
          side: 'source',
          table: c.entry.source_table,
          field: c.entry.source_field,
        })
      }
    }
  }
  if (unresolved.length > 0) {
    // Dedup the list — many duplicate complaints if a table is missing.
    const dedup = new Set(unresolved.map((u) => `${u.side}: ${u.table}.${u.field}`))
    console.error(`[load-rootstock-spec] ${dedup.size} unresolved name(s):`)
    for (const line of dedup) console.error(`  ${line}`)
    console.error(
      `\nFix the JSON spec to match tables.name / fields.name in the DB, or ` +
        `update the schemas. Aborting before any write.`,
    )
    process.exit(1)
  }
  console.log(
    `[load-rootstock-spec] name resolution OK. ` +
      `source tables=${src.tables.length}, target tables=${tgt.tables.length}`,
  )

  // ── Phase 4: existing-data gate ────────────────────────────────────────
  const { count: existingTfmCount, error: countErr } = await supabase
    .from('target_field_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId!)
    .neq('status', 'rejected')
  if (countErr) {
    console.error(`[load-rootstock-spec] TFM count failed: ${countErr.message}`)
    process.exit(1)
  }
  if ((existingTfmCount ?? 0) > 0 && !force) {
    console.error(
      `[load-rootstock-spec] project ${projectId} already has ${existingTfmCount} ` +
        `non-rejected TFMs. Re-run with --force to wipe and reload.`,
    )
    process.exit(1)
  }
  // Mirror the TFM gate for table_mappings — the loader inserts (and in --force,
  // wipes) TMs in addition to TFMs, so a non-force re-run against a project that
  // already has TMs (e.g. someone ran AI "Generate Mappings" before the loader)
  // would otherwise produce duplicate rows in Phase 8.5.
  const { count: existingTmCount, error: tmCountErr } = await supabase
    .from('table_mappings')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId!)
    .neq('status', 'rejected')
  if (tmCountErr) {
    console.error(`[load-rootstock-spec] table_mappings count failed: ${tmCountErr.message}`)
    process.exit(1)
  }
  if ((existingTmCount ?? 0) > 0 && !force) {
    console.error(
      `[load-rootstock-spec] project ${projectId} already has ${existingTmCount} ` +
        `non-rejected table_mappings. Re-run with --force to wipe and reload.`,
    )
    process.exit(1)
  }

  // ── Phase 5: build write payloads (in-memory, no DB writes yet) ────────
  //
  // PR Ω.3.6 — PARTITION-AWARE GROUPING.
  //
  // Cardinality change vs heritage:
  //   Old: grouped by (target_table, target_field) → 1 TFM per pair,
  //        multi-source via mapping_sources.
  //   New: grouped by (target_table, target_field, partition_label) →
  //        1 TFM per (pair, partition). VAs targeting EIM REPLICATE to
  //        all 3 partitions (Q5 locked: verbatim replication; Joanna
  //        edits per-partition post-load).
  //
  // ICC-target entries are SKIPPED entirely per Q4 Option A (ICC is
  // loaded in Rootstock outside Settle). The router returns [] for them.

  // Group MAPPED entries by (target_table, target_field, partition_label).
  // Each entry routes to 1+ partition labels via routePartition().
  const mappedByTargetAndPartition = new Map<string, EntryT[]>()
  let skippedIccCount = 0
  for (const c of classified) {
    if (c.kind !== 'mapped') continue
    const partitions = routePartition(c.entry)
    if (partitions.length === 0) {
      // ICC entries are intentionally skipped (Option A).
      if (c.entry.target_table === ICC_TARGET_TABLE) {
        skippedIccCount++
        continue
      }
      // Otherwise this is a bug — routePartition would have thrown.
      throw new Error(
        `[Phase 5] mapped entry returned empty partition list and ` +
          `isn't ICC: ${JSON.stringify(c.entry)}`,
      )
    }
    for (const partitionLabel of partitions) {
      const k = `${c.entry.target_table}|${c.entry.target_field}|${partitionLabel}`
      const arr = mappedByTargetAndPartition.get(k) ?? []
      arr.push(c.entry)
      mappedByTargetAndPartition.set(k, arr)
    }
  }

  type TfmRow = {
    project_id: string
    target_field_id: string
    // PR Ω.1 — populated in Phase 6.75 after TMs are written in Phase 6.5.
    // PR Ω.3.6 — every TFM now carries a specific partition_label resolved
    // via routePartition(); Phase 6.75 looks up the TM by that label.
    table_mapping_id: string
    ai_reasoning: string
    original_ai_reasoning: string
    transformation_intent: string | null
    needs_transformation: boolean
    combination_type: 'single' | 'concat_space' | 'custom_sql'
    combination_sql: string | null
    confidence: number
    status: 'needs_review'
  }
  type MappingSourceRow = {
    target_field_mapping_id: string // filled after TFM upsert returns ids
    source_field_id: string
    source_table_id: string
    confidence: number
    ordinal: number
    join_spec: { via_fk_field: string; to_fk_field: string } | null
  }
  type SourceAckRow = {
    project_id: string
    source_field_id: string
    reason: string
    notes: null
    acknowledged_by: null
    acknowledged_at: string
    decision: 'acknowledged'
  }

  const tfmRows: TfmRow[] = []
  // PR Ω.3.6 — every tfmRow has a corresponding entry in this sidecar
  // tracking which partition_label it belongs to. tfmRows[i] ↔
  // tfmPartitionByIndex[i]. Phase 6.75 binds table_mapping_id by looking
  // up the partition_label in tmIdByPartitionLabel.
  const tfmPartitionByIndex: string[] = []
  // mapping_sources are resolved AFTER TFM upsert (we need the inserted ids).
  // PR Ω.3.6 — keyed by `${target_field_id}|${partition_label}` since
  // multiple TFMs now share a target_field_id (one per partition).
  const pendingSourcesByTfmKey = new Map<
    string,
    Array<{
      source_field_id: string
      source_table_id: string
      confidence: number
      ordinal: number
      join_spec: { via_fk_field: string; to_fk_field: string } | null
    }>
  >()

  for (const [groupKey, group] of mappedByTargetAndPartition) {
    const [targetTable, targetField, partitionLabel] = groupKey.split('|')
    if (!targetTable || !targetField || !partitionLabel) {
      throw new Error(`[Phase 5] malformed groupKey: ${groupKey}`)
    }
    const head = group[0]!
    const resolvedTarget = resolveTarget(targetTable, targetField)!
    const combinationType: TfmRow['combination_type'] =
      group.length === 1 ? 'single' : 'concat_space'

    const aiReasoning = composeAiReasoning(group)
    const transformationIntent = composeTransformationIntent(group)
    const needsTransform = group.some((e) => e.transformation_needed)
    const confidence = Math.min(...group.map((e) => e.confidence))

    tfmRows.push({
      project_id: projectId!,
      target_field_id: resolvedTarget.fieldId,
      // table_mapping_id filled in Phase 6.75 after Phase 6.5 writes TMs.
      table_mapping_id: '',
      ai_reasoning: aiReasoning,
      original_ai_reasoning: aiReasoning,
      transformation_intent: transformationIntent,
      needs_transformation: needsTransform,
      combination_type: combinationType,
      combination_sql: null,
      confidence,
      status: 'needs_review',
    })
    tfmPartitionByIndex.push(partitionLabel)

    // Build mapping_sources rows for THIS partition's TFM. Cross-table
    // multi-source within a single partition is rare under the new
    // routing (each entry routes to one partition tied to its source
    // table), but keep computeJoinSpec wired for future flexibility.
    const dominantTableName = head.source_table
    const sources: Array<{
      source_field_id: string
      source_table_id: string
      confidence: number
      ordinal: number
      join_spec: { via_fk_field: string; to_fk_field: string } | null
    }> = []
    for (let i = 0; i < group.length; i++) {
      const e = group[i]!
      const r = resolveSource(e.source_table, e.source_field)!
      const joinSpec = computeJoinSpec(
        dominantTableName,
        e.source_table,
        spec.joins,
        `${targetTable}.${targetField}@${partitionLabel}`,
      )
      sources.push({
        source_field_id: r.fieldId,
        source_table_id: r.tableId,
        confidence: e.confidence,
        ordinal: i,
        join_spec: joinSpec,
      })
    }
    pendingSourcesByTfmKey.set(
      `${resolvedTarget.fieldId}|${partitionLabel}`,
      sources,
    )
  }

  // Value assignments — replicate across the partitions returned by the
  // router. EIM-targeted VAs replicate to all 3 EIM partitions (Q5).
  // Non-EIM target VAs are out of scope today; routePartition returns []
  // and we surface a fail-loud for any unexpected case.
  let skippedIccVaCount = 0
  for (const c of classified) {
    if (c.kind !== 'value_assignment') continue
    const e = c.entry
    const resolvedTarget = resolveTarget(e.target_table, e.target_field)!
    const literal = extractValueLiteral(e.transformations[0])
    const partitions = routePartition(e)
    if (partitions.length === 0) {
      if (e.target_table === ICC_TARGET_TABLE) {
        skippedIccVaCount++
        continue
      }
      throw new Error(
        `[Phase 5] VA returned empty partition list and isn't ICC: ` +
          JSON.stringify(e),
      )
    }
    for (const partitionLabel of partitions) {
      tfmRows.push({
        project_id: projectId!,
        target_field_id: resolvedTarget.fieldId,
        // Filled in Phase 6.75 via partition_label lookup.
        table_mapping_id: '',
        ai_reasoning: e.explanation,
        original_ai_reasoning: e.explanation,
        transformation_intent: e.transformations[0] ?? null,
        needs_transformation: e.transformation_needed,
        combination_type: 'custom_sql',
        combination_sql: literal,
        confidence: e.confidence,
        status: 'needs_review',
      })
      tfmPartitionByIndex.push(partitionLabel)
      // VAs have zero mapping_sources rows — do not add to
      // pendingSourcesByTfmKey.
    }
  }

  // Source acknowledgments.
  const ackRows: SourceAckRow[] = []
  for (const c of classified) {
    if (c.kind !== 'source_ack') continue
    const e = c.entry
    const r = resolveSource(e.source_table, e.source_field)!
    ackRows.push({
      project_id: projectId!,
      source_field_id: r.fieldId,
      reason: e.explanation,
      notes: null,
      acknowledged_by: null,
      acknowledged_at: new Date().toISOString(),
      decision: 'acknowledged',
    })
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const mappedTfmCount = mappedByTargetAndPartition.size
  const vaTfmCount = tfmRows.length - mappedTfmCount
  const totalMappingSources = Array.from(pendingSourcesByTfmKey.values()).reduce(
    (acc, arr) => acc + arr.length,
    0,
  )
  const literalVaCount = tfmRows.filter(
    (t) => t.combination_type === 'custom_sql' && t.combination_sql !== null,
  ).length

  console.log(`[load-rootstock-spec] write plan:`)
  console.log(`  TFMs (mapped, per partition): ${mappedTfmCount}`)
  console.log(`  TFMs (VA, per partition)    : ${vaTfmCount} (${literalVaCount} with combination_sql literal)`)
  console.log(`  mapping_sources rows         : ${totalMappingSources}`)
  console.log(`  table_mappings rows (partitions): ${EIM_PARTITIONS.length} (EIM hardcoded)`)
  console.log(`  ICC entries skipped          : ${skippedIccCount + skippedIccVaCount}`)
  console.log(`  source_field_acks     : ${ackRows.length}`)
  console.log(`  schema_documents rows : 1 (poc_answer_key)`)
  console.log(`  projects.poc_template : '${POC_TEMPLATE_VALUE}'`)

  if (dryRun) {
    console.log(`[load-rootstock-spec] dry-run: exiting without DB writes.`)
    return
  }

  // ── Phase 6: --force wipe ──────────────────────────────────────────────
  if (force) {
    console.log(`[load-rootstock-spec] --force: wiping existing project data...`)
    // DELETE source_field_acknowledgments first (independent table).
    {
      const { error } = await supabase
        .from('source_field_acknowledgments')
        .delete()
        .eq('project_id', projectId!)
      if (error) {
        console.error(`  source_field_acknowledgments delete failed: ${error.message}`)
        process.exit(1)
      }
    }
    // DELETE target_field_mappings → CASCADE drops transformations + mapping_sources
    // per migration 074:398-400 (transformations FK ON DELETE CASCADE) and
    // 074 mapping_sources FK ON DELETE CASCADE.
    {
      const { error } = await supabase
        .from('target_field_mappings')
        .delete()
        .eq('project_id', projectId!)
      if (error) {
        console.error(`  target_field_mappings delete failed: ${error.message}`)
        process.exit(1)
      }
    }
    // DELETE table_mappings — TFMs do not FK to TMs (the new mapping model in
    // migration 074 bypasses table_mappings), so a TFM wipe does not cascade
    // here. Wiping ensures Phase 8.5's unconditional INSERT doesn't produce
    // duplicate (src_table, tgt_table) pairs on re-runs. Destructive by design:
    // any user-edited TM rows (status='approved', custom ai_reasoning) for this
    // project are dropped — matches the rest of --force's contract.
    {
      const { error } = await supabase
        .from('table_mappings')
        .delete()
        .eq('project_id', projectId!)
      if (error) {
        console.error(`  table_mappings delete failed: ${error.message}`)
        process.exit(1)
      }
    }
    // DELETE schema_documents poc_answer_key row(s) for this project.
    {
      const { error } = await supabase
        .from('schema_documents')
        .delete()
        .eq('project_id', projectId!)
        .eq('doc_type', 'poc_answer_key')
      if (error) {
        console.error(`  schema_documents (poc_answer_key) delete failed: ${error.message}`)
        process.exit(1)
      }
    }
    console.log(`  wipe complete (poc_template preserved if set).`)
  }

  // ── Phase 6.5: bulk UPSERT table_mappings (hardcoded EIM partitions) ───
  //
  // PR Ω.3.6 — TMs are no longer derived from observed (source, target)
  // pairs; they're the hardcoded EIM_PARTITIONS array from
  // scripts/rootstock-partitions.ts. Each partition carries
  // partition_label, partition_ordinal, filter_sql, identity_field_id,
  // and dedup_priority per the Ω.3.1 schema.
  //
  // identity_field_id is resolved here (after Phase 3 name-resolution
  // is available) for the EIM target field 'Item Number' shared by all
  // 3 partitions (Ω.3.1 sibling-consistency contract).
  //
  // Idempotency: UPSERT with onConflict on the
  // (project_id, target_table_id, partition_label) tuple — the same
  // uniqueness Ω.3.1 enforces server-side.
  //
  // Note on Rootstock-only scope: this PR hardcodes EIM. If a future
  // POC needs partitions for other target tables, extend
  // EIM_PARTITIONS into a per-POC catalog. For Rootstock the spec
  // exclusively targets EIM + ICC (the latter skipped per Q4 Option A).
  const eimIdentityResolved = resolveTarget(
    EIM_TARGET_TABLE,
    EIM_IDENTITY_TARGET_FIELD_NAME,
  )
  if (!eimIdentityResolved) {
    console.error(
      `[load-rootstock-spec] could not resolve identity field "${EIM_IDENTITY_TARGET_FIELD_NAME}" ` +
        `on target table "${EIM_TARGET_TABLE}". Make sure the target schema was uploaded.`,
    )
    process.exit(1)
  }
  const eimTargetTableResolved = resolveTargetTable(EIM_TARGET_TABLE)
  if (!eimTargetTableResolved) {
    console.error(
      `[load-rootstock-spec] could not resolve target table "${EIM_TARGET_TABLE}".`,
    )
    process.exit(1)
  }

  const tmRowsToUpsert = EIM_PARTITIONS.map((p) => {
    const sourceTableResolved = resolveSourceTable(p.sourceTableName)
    if (!sourceTableResolved) {
      console.error(
        `[load-rootstock-spec] partition "${p.label}" references missing source table "${p.sourceTableName}"`,
      )
      process.exit(1)
    }
    return {
      project_id: projectId!,
      source_table_id: sourceTableResolved.tableId,
      target_table_id: eimTargetTableResolved.tableId,
      confidence: null,
      status: 'approved' as const,
      ai_reasoning: `Seeded from Rootstock POC spec — ${p.label} partition`,
      filter_sql: p.filterSql,
      partition_label: p.label,
      partition_ordinal: p.ordinal,
      identity_field_id: eimIdentityResolved.fieldId,
      dedup_priority: p.dedupPriority,
    }
  })
  console.log(
    `[load-rootstock-spec] upserting ${tmRowsToUpsert.length} table_mappings (EIM partitions)...`,
  )
  const { error: tmUpsertErr } = await supabase
    .from('table_mappings')
    .upsert(tmRowsToUpsert, {
      onConflict: 'project_id,target_table_id,partition_label',
    })
  if (tmUpsertErr) {
    console.error(`  table_mappings upsert failed: ${tmUpsertErr.message}`)
    process.exit(1)
  }

  // Re-fetch to get the partition ids, indexed by partition_label.
  const { data: allProjectTms, error: tmFetchErr } = await supabase
    .from('table_mappings')
    .select('id, target_table_id, partition_label')
    .eq('project_id', projectId!)
  if (tmFetchErr) {
    console.error(`  table_mappings refetch failed: ${tmFetchErr.message}`)
    process.exit(1)
  }
  const tmIdByPartitionLabel = new Map<string, string>()
  for (const tm of allProjectTms ?? []) {
    if (tm.partition_label) {
      tmIdByPartitionLabel.set(
        tm.partition_label as string,
        tm.id as string,
      )
    }
  }

  // ── Phase 6.75: bind table_mapping_id onto each TfmRow ─────────────────
  // Every TFM carries its target partition_label in tfmPartitionByIndex —
  // a direct map lookup binds it to the correct TM.
  for (let i = 0; i < tfmRows.length; i++) {
    const partitionLabel = tfmPartitionByIndex[i]
    if (!partitionLabel) {
      console.error(`  internal: no partition_label sidecar for tfmRows[${i}]`)
      process.exit(1)
    }
    const tmId = tmIdByPartitionLabel.get(partitionLabel)
    if (!tmId) {
      console.error(
        `  internal: no table_mapping found for partition_label "${partitionLabel}" ` +
          `(target_field_id=${tfmRows[i]!.target_field_id}). Phase 6.5 should have ` +
          `created all EIM partition TMs.`,
      )
      process.exit(1)
    }
    tfmRows[i]!.table_mapping_id = tmId
  }

  // ── Phase 7: bulk UPSERT target_field_mappings ─────────────────────────
  // PR Ω.3.6 — returns table_mapping_id so Phase 8 can index by the
  // composite (target_field_id, table_mapping_id) key. Required because
  // multiple TFMs share a target_field_id under partitions.
  console.log(`[load-rootstock-spec] writing ${tfmRows.length} TFMs...`)
  const { data: upsertedTfms, error: tfmErr } = await supabase
    .from('target_field_mappings')
    .upsert(tfmRows, { onConflict: 'project_id,target_field_id,table_mapping_id' })
    .select('id, target_field_id, table_mapping_id')
  if (tfmErr) {
    console.error(`  TFM upsert failed: ${tfmErr.message}`)
    process.exit(1)
  }
  // Indexed by `${target_field_id}|${table_mapping_id}` — the natural
  // identity for a partition-bound TFM.
  const tfmIdByCompositeKey = new Map<string, string>()
  for (const row of upsertedTfms ?? []) {
    const compositeKey = `${row.target_field_id as string}|${row.table_mapping_id as string}`
    tfmIdByCompositeKey.set(compositeKey, row.id as string)
  }

  // ── Phase 8: bulk INSERT mapping_sources ───────────────────────────────
  // PR Ω.3.6 — pendingSourcesByTfmKey is keyed by
  // `${target_field_id}|${partition_label}`. Translate via
  // tmIdByPartitionLabel to the composite TFM key.
  const msRows: MappingSourceRow[] = []
  for (const [tfmKey, sources] of pendingSourcesByTfmKey) {
    const [targetFieldId, partitionLabel] = tfmKey.split('|')
    if (!targetFieldId || !partitionLabel) {
      console.error(`  internal: malformed pendingSourcesByTfmKey "${tfmKey}"`)
      process.exit(1)
    }
    const tmId = tmIdByPartitionLabel.get(partitionLabel)
    if (!tmId) {
      console.error(
        `  internal: no TM for partition_label "${partitionLabel}" in Phase 8`,
      )
      process.exit(1)
    }
    const tfmId = tfmIdByCompositeKey.get(`${targetFieldId}|${tmId}`)
    if (!tfmId) {
      console.error(
        `  internal: TFM id not found for (target_field_id=${targetFieldId}, ` +
          `partition_label="${partitionLabel}", table_mapping_id=${tmId}) after upsert`,
      )
      process.exit(1)
    }
    for (const s of sources) {
      msRows.push({
        target_field_mapping_id: tfmId,
        source_field_id: s.source_field_id,
        source_table_id: s.source_table_id,
        confidence: s.confidence,
        ordinal: s.ordinal,
        join_spec: s.join_spec,
      })
    }
  }
  if (msRows.length > 0) {
    console.log(`[load-rootstock-spec] writing ${msRows.length} mapping_sources...`)
    const { error: msErr } = await supabase.from('mapping_sources').insert(msRows)
    if (msErr) {
      console.error(`  mapping_sources insert failed: ${msErr.message}`)
      process.exit(1)
    }
  }

  // ── Phase 8.5 removed (PR Ω.1) ─────────────────────────────────────────
  // TM writes moved to Phase 6.5 because target_field_mappings.table_mapping_id
  // is NOT NULL after migration 107 and must be populated at TFM insert time.

  // ── Phase 9: bulk UPSERT source_field_acknowledgments ──────────────────
  if (ackRows.length > 0) {
    console.log(`[load-rootstock-spec] writing ${ackRows.length} source_field_acknowledgments...`)
    const { error: ackErr } = await supabase
      .from('source_field_acknowledgments')
      .upsert(ackRows, { onConflict: 'project_id,source_field_id' })
    if (ackErr) {
      console.error(`  source_field_acknowledgments upsert failed: ${ackErr.message}`)
      process.exit(1)
    }
  }

  // ── Phase 10: insert schema_documents (poc_answer_key) ─────────────────
  console.log(`[load-rootstock-spec] writing schema_documents (poc_answer_key)...`)
  const fullJson = JSON.stringify(spec, null, 2)
  const { error: docErr } = await supabase.from('schema_documents').insert({
    dataset_id: null,
    project_id: projectId!,
    doc_type: 'poc_answer_key',
    filename: 'rootstock-spec.json',
    file_size: Buffer.byteLength(fullJson, 'utf-8'),
    file_storage_path: 'inline://rootstock-spec',
    extracted_text: fullJson,
  })
  if (docErr) {
    console.error(`  schema_documents insert failed: ${docErr.message}`)
    process.exit(1)
  }

  // ── Phase 11: set projects.poc_template (LAST) ─────────────────────────
  // Done last on purpose: until poc_template is set, the Path D suppression
  // check in path-d-mapping.ts is OFF. Setting it last means a partial
  // failure above leaves the project in a recoverable state (re-run with
  // --force still works because suppression isn't active yet).
  console.log(`[load-rootstock-spec] setting projects.poc_template='${POC_TEMPLATE_VALUE}'...`)
  const { error: pocErr } = await supabase
    .from('projects')
    .update({ poc_template: POC_TEMPLATE_VALUE })
    .eq('id', projectId!)
  if (pocErr) {
    console.error(`  projects.poc_template update failed: ${pocErr.message}`)
    process.exit(1)
  }

  console.log(`[load-rootstock-spec] done.`)
}

main().catch((err) => {
  console.error('[load-rootstock-spec] fatal:', err)
  process.exit(1)
})
