import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClaudeFieldMapping } from '@/lib/ai/mapping-engine'

type StaticTransform = string | Record<string, unknown>

export interface StaticMappingEntry {
  source_table: string
  source_field: string
  target_table: string
  target_field: string
  explanation: string
  transformation_needed: boolean
  transformations: StaticTransform[]
}

interface StaticOrgMappingConfig {
  project_ids: string[]
  entries: StaticMappingEntry[]
}

interface ResolvedStaticOrgMapping {
  orgId: string
  config: StaticOrgMappingConfig
}

interface StaticTableRow {
  id: string
  name: string
}

interface StaticFieldRow {
  id: string
  table_id: string
  name: string
}

interface ResolvedMappedEntry {
  entry: StaticMappingEntry
  sourceTableId: string
  sourceFieldId: string
  targetTableId: string
  targetFieldId: string
  pairKey: string
}

interface PersistSelectionArgs {
  supabase: SupabaseClient
  projectId: string
  sourceTableIds: string[]
  targetTableIds: string[]
  existingPairSet: Set<string>
}

interface PersistPairArgs {
  supabase: SupabaseClient
  projectId: string
  tableMappingId: string
  sourceTableId: string
  targetTableId: string
}

interface StaticSuggestionArgs {
  supabase: SupabaseClient
  projectId: string
  targetFieldId: string
  rationaleMaxChars: number
}

export type StaticSuggestionResult =
  | { kind: 'disabled' }
  | { kind: 'missing'; error: string }
  | {
      kind: 'suggestion'
      suggestion: {
        sourceFieldIds: string[]
        combinationType: 'single' | 'concat_space' | 'concat_comma'
        confidence: number
        rationale: string
      }
    }

const STATIC_CONFIDENCE = 100
const UNMAPPED_TOKEN = 'unmapped'
const STATIC_MAPPINGS_DIR = join(process.cwd(), 'config', 'static-mappings')

function normalizeName(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') return ''
  const parts = value.split('.')
  return parts[parts.length - 1]?.toLowerCase().trim() ?? ''
}

function isUnmappedToken(value: string | null | undefined): boolean {
  return normalizeName(value) === UNMAPPED_TOKEN
}

function isSourceUnmappedEntry(entry: StaticMappingEntry): boolean {
  return (
    isUnmappedToken(entry.source_table) &&
    isUnmappedToken(entry.source_field) &&
    !isUnmappedToken(entry.target_table) &&
    !isUnmappedToken(entry.target_field)
  )
}

function isTargetUnmappedEntry(entry: StaticMappingEntry): boolean {
  return (
    !isUnmappedToken(entry.source_table) &&
    !isUnmappedToken(entry.source_field) &&
    isUnmappedToken(entry.target_table) &&
    isUnmappedToken(entry.target_field)
  )
}

function isMappedEntry(entry: StaticMappingEntry): boolean {
  return (
    !isUnmappedToken(entry.source_table) &&
    !isUnmappedToken(entry.source_field) &&
    !isUnmappedToken(entry.target_table) &&
    !isUnmappedToken(entry.target_field)
  )
}

function buildReasoning(entry: StaticMappingEntry): string {
  const parts = [entry.explanation.trim()]
  parts.push(
    entry.transformation_needed
      ? 'Transformation needed: yes.'
      : 'Transformation needed: no.',
  )
  if (entry.transformations.length > 0) {
    const rendered = entry.transformations
      .map((t) => (typeof t === 'string' ? t : JSON.stringify(t)))
      .join('; ')
    parts.push(`Transformations: ${rendered}`)
  }
  return parts.filter(Boolean).join(' ')
}

async function resolveStaticOrgMappingForProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ResolvedStaticOrgMapping | null> {
  const { data: project, error } = await supabase
    .from('projects')
    .select('org_id')
    .eq('id', projectId)
    .single<{ org_id: string }>()

  if (error || !project?.org_id) return null

  const orgConfig = readStaticOrgMappingConfig(project.org_id, projectId)
  if (!orgConfig) return null

  return {
    orgId: project.org_id,
    config: {
      project_ids: orgConfig.project_ids,
      entries: Array.isArray(orgConfig.entries) ? orgConfig.entries : [],
    },
  }
}

function readStaticOrgMappingConfig(
  orgId: string,
  projectId: string,
): StaticOrgMappingConfig | null {
  const configPath = join(STATIC_MAPPINGS_DIR, `${orgId}.json`)
  if (!existsSync(configPath)) return null

  const raw = readFileSync(configPath, 'utf8')
  const parsed = JSON.parse(raw) as Array<Partial<StaticOrgMappingConfig>> | null
  if (!Array.isArray(parsed)) return null

  const matched = parsed.find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false
    return Array.isArray(candidate.project_ids) && candidate.project_ids.includes(projectId)
  })
  if (!matched) return null

  return {
    project_ids: Array.isArray(matched.project_ids)
      ? matched.project_ids.filter((value): value is string => typeof value === 'string')
      : [],
    entries: Array.isArray(matched.entries) ? matched.entries as StaticMappingEntry[] : [],
  }
}

function groupEntriesByPair(entries: StaticMappingEntry[]): Map<string, StaticMappingEntry[]> {
  const grouped = new Map<string, StaticMappingEntry[]>()
  for (const entry of entries) {
    const key = `${normalizeName(entry.source_table)}::${normalizeName(entry.target_table)}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(entry)
    else grouped.set(key, [entry])
  }
  return grouped
}

function buildFieldMappingsForPair(entries: StaticMappingEntry[]): ClaudeFieldMapping[] {
  const groupedByTarget = new Map<string, StaticMappingEntry[]>()
  for (const entry of entries) {
    const key = normalizeName(entry.target_field)
    const bucket = groupedByTarget.get(key)
    if (bucket) bucket.push(entry)
    else groupedByTarget.set(key, [entry])
  }

  const fieldMappings: ClaudeFieldMapping[] = []
  for (const group of groupedByTarget.values()) {
    const primary = group[0]
    if (!primary) continue
    const contributors = group.slice(1).map((entry) => entry.source_field)
    fieldMappings.push({
      source_field: primary.source_field,
      target_field: primary.target_field,
      confidence: STATIC_CONFIDENCE,
      reasoning: group.map(buildReasoning).join(' '),
      similar_fields_considered: [],
      type_compatibility: primary.transformation_needed
        ? 'static mapping requires configured transformation handling'
        : 'direct compatible — no conversion needed',
      needs_transformation: group.some((entry) => entry.transformation_needed),
      mapping_type: group.length > 1 ? 'many_to_one' : 'one_to_one',
      contributing_source_fields:
        group.length > 1 ? contributors : undefined,
      combination_hint:
        group.length > 1 ? 'Static mapping configuration for combined target field.' : undefined,
    })
  }

  return fieldMappings
}

function hasAnyValidFieldMapping(
  fieldMappings: ClaudeFieldMapping[],
  sourceFieldMap: Map<string, { id: string; name: string }>,
  targetFieldMap: Map<string, { id: string; name: string }>,
): boolean {
  return fieldMappings.some((mapping) => {
    const sourceExists = sourceFieldMap.has(normalizeName(mapping.source_field))
    const targetExists = targetFieldMap.has(normalizeName(mapping.target_field))
    return sourceExists && targetExists
  })
}

async function loadTablesAndFieldsForIds(
  supabase: SupabaseClient,
  sourceTableIds: string[],
  targetTableIds: string[],
): Promise<{
  sourceTables: StaticTableRow[]
  targetTables: StaticTableRow[]
  sourceFields: StaticFieldRow[]
  targetFields: StaticFieldRow[]
}> {
  const [{ data: sourceTables }, { data: targetTables }, { data: sourceFields }, { data: targetFields }] =
    await Promise.all([
      supabase
        .from('tables')
        .select('id, name')
        .in('id', sourceTableIds)
        .returns<StaticTableRow[]>(),
      supabase
        .from('tables')
        .select('id, name')
        .in('id', targetTableIds)
        .returns<StaticTableRow[]>(),
      supabase
        .from('fields')
        .select('id, table_id, name')
        .in('table_id', sourceTableIds)
        .returns<StaticFieldRow[]>(),
      supabase
        .from('fields')
        .select('id, table_id, name')
        .in('table_id', targetTableIds)
        .returns<StaticFieldRow[]>(),
    ])

  return {
    sourceTables: sourceTables ?? [],
    targetTables: targetTables ?? [],
    sourceFields: sourceFields ?? [],
    targetFields: targetFields ?? [],
  }
}

async function persistSourceAcknowledgments(
  supabase: SupabaseClient,
  projectId: string,
  entries: StaticMappingEntry[],
  sourceTables: StaticTableRow[],
  sourceFields: StaticFieldRow[],
): Promise<number> {
  if (entries.length === 0) return 0

  const sourceTableByName = new Map(
    sourceTables.map((table) => [normalizeName(table.name), table]),
  )
  const sourceFieldIdByTableAndName = new Map<string, string>()
  for (const field of sourceFields) {
    sourceFieldIdByTableAndName.set(
      `${field.table_id}::${normalizeName(field.name)}`,
      field.id,
    )
  }

  const rows: Array<{
    project_id: string
    source_field_id: string
    reason: string
    notes: string | null
    acknowledged_at: string
  }> = []

  for (const entry of entries) {
    const sourceTable = sourceTableByName.get(normalizeName(entry.source_table))
    if (!sourceTable) continue
    const sourceFieldId = sourceFieldIdByTableAndName.get(
      `${sourceTable.id}::${normalizeName(entry.source_field)}`,
    )
    if (!sourceFieldId) continue

    rows.push({
      project_id: projectId,
      source_field_id: sourceFieldId,
      reason: entry.explanation.trim() || 'Unmapped',
      notes:
        entry.transformations.length > 0
          ? entry.transformations
              .map((t) => (typeof t === 'string' ? t : JSON.stringify(t)))
              .join('; ')
          : null,
      acknowledged_at: new Date().toISOString(),
    })
  }

  if (rows.length === 0) return 0

  const { error } = await supabase
    .from('source_field_acknowledgments')
    .upsert(rows, { onConflict: 'project_id,source_field_id' })
  if (error) {
    throw new Error(`Static source acknowledgment upsert failed: ${error.message}`)
  }
  return rows.length
}

async function persistTargetAcknowledgments(
  supabase: SupabaseClient,
  projectId: string,
  entries: StaticMappingEntry[],
  targetTables: StaticTableRow[],
  targetFields: StaticFieldRow[],
): Promise<number> {
  if (entries.length === 0) return 0

  const targetTableByName = new Map(
    targetTables.map((table) => [normalizeName(table.name), table]),
  )
  const targetFieldIdByTableAndName = new Map<string, string>()
  for (const field of targetFields) {
    targetFieldIdByTableAndName.set(
      `${field.table_id}::${normalizeName(field.name)}`,
      field.id,
    )
  }

  let inserted = 0
  for (const entry of entries) {
    const targetTable = targetTableByName.get(normalizeName(entry.target_table))
    if (!targetTable) continue
    const targetFieldId = targetFieldIdByTableAndName.get(
      `${targetTable.id}::${normalizeName(entry.target_field)}`,
    )
    if (!targetFieldId) continue

    const { error } = await supabase.rpc('dq_acknowledge_target', {
      p_project_id: projectId,
      p_target_field_id: targetFieldId,
      p_reason: entry.explanation.trim() || 'Unmapped',
    })
    if (error) {
      throw new Error(`Static target acknowledgment failed: ${error.message}`)
    }
    inserted++
  }

  return inserted
}

function buildFieldMapForTable(
  fields: StaticFieldRow[],
  tableId: string,
): Map<string, { id: string; name: string }> {
  const out = new Map<string, { id: string; name: string }>()
  for (const field of fields) {
    if (field.table_id !== tableId) continue
    out.set(normalizeName(field.name), { id: field.id, name: field.name })
  }
  return out
}

function buildFieldIdByTableAndName(
  fields: StaticFieldRow[],
): Map<string, string> {
  const out = new Map<string, string>()
  for (const field of fields) {
    out.set(`${field.table_id}::${normalizeName(field.name)}`, field.id)
  }
  return out
}

function resolveMappedEntriesToLiveFields(args: {
  entries: StaticMappingEntry[]
  sourceTableByName: Map<string, StaticTableRow>
  targetTableByName: Map<string, StaticTableRow>
  sourceFieldIdByTableAndName: Map<string, string>
  targetFieldIdByTableAndName: Map<string, string>
}): ResolvedMappedEntry[] {
  const resolved: ResolvedMappedEntry[] = []

  for (const entry of args.entries) {
    const sourceTable = args.sourceTableByName.get(normalizeName(entry.source_table))
    const targetTable = args.targetTableByName.get(normalizeName(entry.target_table))
    if (!sourceTable || !targetTable) continue

    const sourceFieldId = args.sourceFieldIdByTableAndName.get(
      `${sourceTable.id}::${normalizeName(entry.source_field)}`,
    )
    const targetFieldId = args.targetFieldIdByTableAndName.get(
      `${targetTable.id}::${normalizeName(entry.target_field)}`,
    )
    if (!sourceFieldId || !targetFieldId) continue

    resolved.push({
      entry,
      sourceTableId: sourceTable.id,
      sourceFieldId,
      targetTableId: targetTable.id,
      targetFieldId,
      pairKey: `${sourceTable.id}::${targetTable.id}`,
    })
  }

  return resolved
}

async function ensureStaticTableMappings(args: {
  supabase: SupabaseClient
  projectId: string
  resolvedEntries: ResolvedMappedEntry[]
}): Promise<{ pairToTableMappingId: Map<string, string>; created: number; reused: number }> {
  const pairToTableMappingId = new Map<string, string>()
  const pairSpecs = new Map<string, { sourceTableId: string; targetTableId: string }>()

  for (const entry of args.resolvedEntries) {
    if (!pairSpecs.has(entry.pairKey)) {
      pairSpecs.set(entry.pairKey, {
        sourceTableId: entry.sourceTableId,
        targetTableId: entry.targetTableId,
      })
    }
  }

  if (pairSpecs.size === 0) {
    return { pairToTableMappingId, created: 0, reused: 0 }
  }

  const sourceTableIds = [...new Set([...pairSpecs.values()].map((pair) => pair.sourceTableId))]
  const targetTableIds = [...new Set([...pairSpecs.values()].map((pair) => pair.targetTableId))]

  const { data: existingRows } = await args.supabase
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', args.projectId)
    .in('source_table_id', sourceTableIds)
    .in('target_table_id', targetTableIds)
    .returns<Array<{ id: string; source_table_id: string; target_table_id: string }>>()

  for (const row of existingRows ?? []) {
    pairToTableMappingId.set(
      `${row.source_table_id}::${row.target_table_id}`,
      row.id,
    )
  }

  let created = 0
  for (const [pairKey, pair] of pairSpecs.entries()) {
    if (pairToTableMappingId.has(pairKey)) continue

    const { data: inserted, error } = await args.supabase
      .from('table_mappings')
      .insert({
        project_id: args.projectId,
        source_table_id: pair.sourceTableId,
        target_table_id: pair.targetTableId,
        confidence: STATIC_CONFIDENCE,
        status: 'needs_review',
        ai_reasoning: 'Static mapping configuration applied.',
      })
      .select('id, source_table_id, target_table_id')
      .single<{ id: string; source_table_id: string; target_table_id: string }>()

    if (error || !inserted) continue
    pairToTableMappingId.set(
      `${inserted.source_table_id}::${inserted.target_table_id}`,
      inserted.id,
    )
    created++
  }

  return {
    pairToTableMappingId,
    created,
    reused: pairToTableMappingId.size - created,
  }
}

async function persistResolvedStaticTargetMappings(args: {
  supabase: SupabaseClient
  projectId: string
  resolvedEntries: ResolvedMappedEntry[]
}): Promise<number> {
  const grouped = new Map<string, ResolvedMappedEntry[]>()
  for (const entry of args.resolvedEntries) {
    const key = `${entry.targetTableId}::${entry.targetFieldId}`
    const bucket = grouped.get(key)
    if (bucket) bucket.push(entry)
    else grouped.set(key, [entry])
  }

  let inserted = 0
  for (const group of grouped.values()) {
    const primary = group[0]
    if (!primary) continue

    const seenSourceFieldIds = new Set<string>()
    const rpcSources: Array<{
      source_field_id: string
      source_table_id: string
      confidence: number
      ai_reasoning: string
      similar_fields_considered: string[]
      type_compatibility: string | null
      ordinal: number
    }> = []

    let ordinal = 0
    for (const item of group) {
      if (seenSourceFieldIds.has(item.sourceFieldId)) continue
      seenSourceFieldIds.add(item.sourceFieldId)

      rpcSources.push({
        source_field_id: item.sourceFieldId,
        source_table_id: item.sourceTableId,
        confidence: STATIC_CONFIDENCE,
        ai_reasoning:
          ordinal === 0
            ? buildReasoning(item.entry)
            : `Contributing source for configured mapping. ${buildReasoning(item.entry)}`.trim(),
        similar_fields_considered: [],
        type_compatibility: item.entry.transformation_needed
          ? 'configured mapping requires transformation handling'
          : 'direct compatible — no conversion needed',
        ordinal,
      })
      ordinal++
    }

    if (rpcSources.length === 0) continue

    const reasoning = group.map((item) => buildReasoning(item.entry)).join(' ')
    const combinationType = rpcSources.length > 1 ? 'concat_space' : 'single'

    const { error } = await args.supabase.rpc('dq_create_target_field_mapping', {
      p_project_id: args.projectId,
      p_target_field_id: primary.targetFieldId,
      p_sources: rpcSources,
      p_combination: {
        type: combinationType,
        ai_reasoning: reasoning,
      },
    })

    if (error) {
      console.error(
        `[static-mappings] dq_create_target_field_mapping failed for target ${primary.targetFieldId}:`,
        error.message,
      )
      continue
    }

    inserted++
  }

  return inserted
}

export async function persistStaticMappingsForSelection(
  args: PersistSelectionArgs,
): Promise<
  | { kind: 'disabled' }
  | {
      kind: 'persisted'
      generated: number
      skipped: number
      message?: string
    }
  | { kind: 'error'; error: string }
> {
  const resolved = await resolveStaticOrgMappingForProject(args.supabase, args.projectId)
  if (!resolved) return { kind: 'disabled' }

  const { sourceTables, targetTables, sourceFields, targetFields } =
    await loadTablesAndFieldsForIds(
      args.supabase,
      args.sourceTableIds,
      args.targetTableIds,
    )

  const sourceTableByName = new Map(
    sourceTables.map((table) => [normalizeName(table.name), table]),
  )
  const targetTableByName = new Map(
    targetTables.map((table) => [normalizeName(table.name), table]),
  )
  const sourceFieldIdByTableAndName = buildFieldIdByTableAndName(sourceFields)
  const targetFieldIdByTableAndName = buildFieldIdByTableAndName(targetFields)

  const matchedEntries = resolved.config.entries.filter(
    (entry) =>
      (isMappedEntry(entry) &&
        sourceTableByName.has(normalizeName(entry.source_table)) &&
        targetTableByName.has(normalizeName(entry.target_table))) ||
      (isSourceUnmappedEntry(entry) &&
        sourceTableByName.has(normalizeName(entry.source_table))) ||
      (isTargetUnmappedEntry(entry) &&
        targetTableByName.has(normalizeName(entry.target_table))),
  )

  const mappedEntries = matchedEntries.filter(isMappedEntry)
  const sourceUnmappedEntries = matchedEntries.filter(isSourceUnmappedEntry)
  const targetUnmappedEntries = matchedEntries.filter(isTargetUnmappedEntry)
  const resolvedMappedEntries = resolveMappedEntriesToLiveFields({
    entries: mappedEntries,
    sourceTableByName,
    targetTableByName,
    sourceFieldIdByTableAndName,
    targetFieldIdByTableAndName,
  })

  if (
    resolvedMappedEntries.length === 0 &&
    sourceUnmappedEntries.length === 0 &&
    targetUnmappedEntries.length === 0
  ) {
    return {
      kind: 'error',
      error:
        'No configured entries matched the selected source and target tables.',
    }
  }

  let generated = 0
  let skipped = 0

  await persistSourceAcknowledgments(
    args.supabase,
    args.projectId,
    sourceUnmappedEntries,
    sourceTables,
    sourceFields,
  )
  await persistTargetAcknowledgments(
    args.supabase,
    args.projectId,
    targetUnmappedEntries,
    targetTables,
    targetFields,
  )

  const { pairToTableMappingId, created, reused } = await ensureStaticTableMappings({
    supabase: args.supabase,
    projectId: args.projectId,
    resolvedEntries: resolvedMappedEntries,
  })
  generated = pairToTableMappingId.size
  skipped = reused

  const insertedTargetMappings = await persistResolvedStaticTargetMappings({
    supabase: args.supabase,
    projectId: args.projectId,
    resolvedEntries: resolvedMappedEntries,
  })

  if (insertedTargetMappings === 0) {
    if (skipped > 0) {
      return {
        kind: 'persisted',
        generated,
        skipped,
        message:
          'Configured table pairs already exist, but no target mappings were created.',
      }
    }
    return {
      kind: 'error',
      error:
        'Configured entries were found for the selected tables, but none matched the current field names.',
    }
  }

  return {
    kind: 'persisted',
    generated,
    skipped,
    message:
      skipped > 0
        ? `Applied mappings across ${generated} table pair${generated !== 1 ? 's' : ''}. Reused ${skipped} existing pair${skipped !== 1 ? 's' : ''}.`
        : undefined,
  }
}

export async function persistStaticMappingsForPair(
  args: PersistPairArgs,
): Promise<
  | { kind: 'disabled' }
  | { kind: 'persisted'; inserted: number }
  | { kind: 'error'; error: string }
> {
  const resolved = await resolveStaticOrgMappingForProject(args.supabase, args.projectId)
  if (!resolved) return { kind: 'disabled' }

  const { sourceTables, targetTables, sourceFields, targetFields } =
    await loadTablesAndFieldsForIds(
      args.supabase,
      [args.sourceTableId],
      [args.targetTableId],
    )

  const sourceTable = sourceTables[0]
  const targetTable = targetTables[0]
  if (!sourceTable || !targetTable) {
    return {
      kind: 'error',
      error: 'Source or target table not found for static mapping resolution.',
    }
  }

  const matchedEntries = resolved.config.entries.filter(
    (entry) =>
      (isMappedEntry(entry) &&
        normalizeName(entry.source_table) === normalizeName(sourceTable.name) &&
        normalizeName(entry.target_table) === normalizeName(targetTable.name)) ||
      (isSourceUnmappedEntry(entry) &&
        normalizeName(entry.source_table) === normalizeName(sourceTable.name)) ||
      (isTargetUnmappedEntry(entry) &&
        normalizeName(entry.target_table) === normalizeName(targetTable.name)),
  )

  if (matchedEntries.length === 0) {
    return {
      kind: 'error',
      error:
        'No configured entries matched this source and target table pair.',
    }
  }

  const mappedEntries = matchedEntries.filter(isMappedEntry)
  const sourceUnmappedEntries = matchedEntries.filter(isSourceUnmappedEntry)
  const targetUnmappedEntries = matchedEntries.filter(isTargetUnmappedEntry)

  await persistSourceAcknowledgments(
    args.supabase,
    args.projectId,
    sourceUnmappedEntries,
    sourceTables,
    sourceFields,
  )
  await persistTargetAcknowledgments(
    args.supabase,
    args.projectId,
    targetUnmappedEntries,
    targetTables,
    targetFields,
  )

  if (mappedEntries.length === 0) {
    return {
      kind: 'persisted',
      inserted: 0,
    }
  }

  const sourceFieldMap = buildFieldMapForTable(sourceFields, sourceTable.id)
  const targetFieldMap = buildFieldMapForTable(targetFields, targetTable.id)
  const fieldMappings = buildFieldMappingsForPair(mappedEntries)

  if (!hasAnyValidFieldMapping(fieldMappings, sourceFieldMap, targetFieldMap)) {
    return {
      kind: 'error',
      error:
        'Configured entries were found for this table pair, but none matched the current field names.',
    }
  }

  const { persistClaudeFieldMappingsForTM } = await import(
    '@/lib/ai/mapping-engine'
  )
  const { inserted } = await persistClaudeFieldMappingsForTM({
    supabase: args.supabase,
    projectId: args.projectId,
    tableMappingId: args.tableMappingId,
    sourceFieldMap,
    targetFieldMap,
    fieldMappings,
    sourceTableId: args.sourceTableId,
  })

  return {
    kind: 'persisted',
    inserted,
  }
}

export async function getStaticSuggestionForTarget(
  args: StaticSuggestionArgs,
): Promise<StaticSuggestionResult> {
  const resolved = await resolveStaticOrgMappingForProject(args.supabase, args.projectId)
  if (!resolved) return { kind: 'disabled' }

  const { data: targetField, error: targetFieldErr } = await args.supabase
    .from('fields')
    .select('id, name, table_id')
    .eq('id', args.targetFieldId)
    .single<{ id: string; name: string; table_id: string }>()

  if (targetFieldErr || !targetField) {
    return {
      kind: 'missing',
      error: 'Target field not found',
    }
  }

  const { data: targetTable, error: targetTableErr } = await args.supabase
    .from('tables')
    .select('id, name')
    .eq('id', targetField.table_id)
    .single<{ id: string; name: string }>()

  if (targetTableErr || !targetTable) {
    return {
      kind: 'missing',
      error: 'Target table not found',
    }
  }

  const { data: sourceDatasets } = await args.supabase
    .from('datasets')
    .select('id')
    .eq('project_id', args.projectId)
    .eq('role', 'source')
    .returns<Array<{ id: string }>>()

  const sourceDatasetIds = (sourceDatasets ?? []).map((dataset) => dataset.id)
  if (sourceDatasetIds.length === 0) {
    return {
      kind: 'missing',
      error: 'No source tables available to map against',
    }
  }

  const { data: sourceTables } = await args.supabase
    .from('tables')
    .select('id, name, dataset_id')
    .in('dataset_id', sourceDatasetIds)
    .returns<Array<{ id: string; name: string; dataset_id: string }>>()

  const sourceTableIds = (sourceTables ?? []).map((table) => table.id)
  if (sourceTableIds.length === 0) {
    return {
      kind: 'missing',
      error: 'No source tables available to map against',
    }
  }

  const { data: sourceFields } = await args.supabase
    .from('fields')
    .select('id, name, table_id')
    .in('table_id', sourceTableIds)
    .returns<Array<{ id: string; name: string; table_id: string }>>()

  const sourceTableByName = new Map(
    (sourceTables ?? []).map((table) => [normalizeName(table.name), table]),
  )
  const sourceFieldIdByTableAndName = new Map<string, string>()
  for (const field of sourceFields ?? []) {
    sourceFieldIdByTableAndName.set(
      `${field.table_id}::${normalizeName(field.name)}`,
      field.id,
    )
  }

  const matches = resolved.config.entries.filter(
    (entry) =>
      isMappedEntry(entry) &&
      normalizeName(entry.target_table) === normalizeName(targetTable.name) &&
      normalizeName(entry.target_field) === normalizeName(targetField.name),
  )

  if (matches.length === 0) {
    return {
      kind: 'missing',
      error:
        'No configured entry matched this target field.',
    }
  }

  const sourceTableIdsForMatches = new Set<string>()
  const sourceFieldIds: string[] = []
  for (const match of matches) {
    const sourceTable = sourceTableByName.get(normalizeName(match.source_table))
    if (!sourceTable) continue
    sourceTableIdsForMatches.add(sourceTable.id)
    const fieldId = sourceFieldIdByTableAndName.get(
      `${sourceTable.id}::${normalizeName(match.source_field)}`,
    )
    if (fieldId) sourceFieldIds.push(fieldId)
  }

  if (sourceFieldIds.length === 0) {
    return {
      kind: 'missing',
      error:
        'Configured source fields were not found in the project schema.',
    }
  }

  if (sourceTableIdsForMatches.size > 1) {
    return {
      kind: 'missing',
      error:
        'This target spans multiple source tables and cannot be returned by the single-table suggest flow.',
    }
  }

  return {
    kind: 'suggestion',
    suggestion: {
      sourceFieldIds,
      combinationType: sourceFieldIds.length > 1 ? 'concat_space' : 'single',
      confidence: STATIC_CONFIDENCE,
      rationale: matches
        .map((match) => match.explanation.trim())
        .join(' ')
        .slice(0, args.rationaleMaxChars),
    },
  }
}
