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

const SpecSchema = z.array(
  z.object({
    project_ids: z.array(z.string().uuid()),
    load_order: z.array(LoadOrderSchema),
    entries: z.array(EntrySchema).min(1),
  }),
)

type EntryT = z.infer<typeof EntrySchema>

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
    return function resolve(
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
  }

  const resolveSource = buildResolver(src.tables as TblRow[], src.fields as FldRow[])
  const resolveTarget = buildResolver(tgt.tables as TblRow[], tgt.fields as FldRow[])

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

  // ── Phase 5: build write payloads (in-memory, no DB writes yet) ────────

  // Group mapped entries by (target_table, target_field).
  const mappedByTarget = new Map<string, EntryT[]>()
  for (const c of classified) {
    if (c.kind !== 'mapped') continue
    const k = `${c.entry.target_table}|${c.entry.target_field}`
    const arr = mappedByTarget.get(k) ?? []
    arr.push(c.entry)
    mappedByTarget.set(k, arr)
  }

  type TfmRow = {
    project_id: string
    target_field_id: string
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
  // mapping_sources are resolved AFTER TFM upsert (we need the inserted ids).
  // Carry the pending sources keyed by target_field_id so we can join.
  const pendingSourcesByTargetFieldId = new Map<
    string,
    Array<{ source_field_id: string; source_table_id: string; confidence: number; ordinal: number }>
  >()

  for (const [, group] of mappedByTarget) {
    const head = group[0]!
    const resolvedTarget = resolveTarget(head.target_table, head.target_field)!
    const combinationType: TfmRow['combination_type'] =
      group.length === 1 ? 'single' : 'concat_space'

    const aiReasoning = composeAiReasoning(group)
    const transformationIntent = composeTransformationIntent(group)
    const needsTransform = group.some((e) => e.transformation_needed)
    const confidence = Math.min(...group.map((e) => e.confidence))

    tfmRows.push({
      project_id: projectId!,
      target_field_id: resolvedTarget.fieldId,
      ai_reasoning: aiReasoning,
      original_ai_reasoning: aiReasoning,
      transformation_intent: transformationIntent,
      needs_transformation: needsTransform,
      combination_type: combinationType,
      combination_sql: null,
      confidence,
      status: 'needs_review',
    })

    const sources: Array<{
      source_field_id: string
      source_table_id: string
      confidence: number
      ordinal: number
    }> = []
    for (let i = 0; i < group.length; i++) {
      const e = group[i]!
      const r = resolveSource(e.source_table, e.source_field)!
      sources.push({
        source_field_id: r.fieldId,
        source_table_id: r.tableId,
        confidence: e.confidence,
        ordinal: i,
      })
    }
    pendingSourcesByTargetFieldId.set(resolvedTarget.fieldId, sources)
  }

  // Value assignments — one per (target_table, target_field).
  for (const c of classified) {
    if (c.kind !== 'value_assignment') continue
    const e = c.entry
    const resolvedTarget = resolveTarget(e.target_table, e.target_field)!
    const literal = extractValueLiteral(e.transformations[0])
    tfmRows.push({
      project_id: projectId!,
      target_field_id: resolvedTarget.fieldId,
      ai_reasoning: e.explanation,
      original_ai_reasoning: e.explanation,
      transformation_intent: e.transformations[0] ?? null,
      needs_transformation: e.transformation_needed,
      combination_type: 'custom_sql',
      combination_sql: literal,
      confidence: e.confidence,
      status: 'needs_review',
    })
    // VAs have zero mapping_sources rows — do not add to pendingSourcesByTargetFieldId.
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
  const mappedTfmCount = mappedByTarget.size
  const vaTfmCount = tfmRows.length - mappedTfmCount
  const totalMappingSources = Array.from(pendingSourcesByTargetFieldId.values()).reduce(
    (acc, arr) => acc + arr.length,
    0,
  )
  const literalVaCount = tfmRows.filter(
    (t) => t.combination_type === 'custom_sql' && t.combination_sql !== null,
  ).length

  console.log(`[load-rootstock-spec] write plan:`)
  console.log(`  TFMs (mapped)         : ${mappedTfmCount}`)
  console.log(`  TFMs (value assignment): ${vaTfmCount} (${literalVaCount} with combination_sql literal)`)
  console.log(`  mapping_sources rows  : ${totalMappingSources}`)
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

  // ── Phase 7: bulk UPSERT target_field_mappings ─────────────────────────
  console.log(`[load-rootstock-spec] writing ${tfmRows.length} TFMs...`)
  const { data: upsertedTfms, error: tfmErr } = await supabase
    .from('target_field_mappings')
    .upsert(tfmRows, { onConflict: 'project_id,target_field_id' })
    .select('id, target_field_id')
  if (tfmErr) {
    console.error(`  TFM upsert failed: ${tfmErr.message}`)
    process.exit(1)
  }
  const tfmIdByTargetFieldId = new Map<string, string>()
  for (const row of upsertedTfms ?? []) {
    tfmIdByTargetFieldId.set(
      row.target_field_id as string,
      row.id as string,
    )
  }

  // ── Phase 8: bulk INSERT mapping_sources ───────────────────────────────
  const msRows: MappingSourceRow[] = []
  for (const [targetFieldId, sources] of pendingSourcesByTargetFieldId) {
    const tfmId = tfmIdByTargetFieldId.get(targetFieldId)
    if (!tfmId) {
      console.error(
        `  internal: TFM id for target_field_id ${targetFieldId} not found after upsert`,
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
