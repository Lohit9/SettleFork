/**
 * Business logic for outputs generation. NOT a 'use server' module.
 *
 * Server actions in lib/actions/outputs.ts are thin wrappers that:
 *   1. Enforce auth via await createClient()
 *   2. Resolve project permissions
 *   3. Call into the core functions here
 *   4. Return the result
 *
 * Functions here are directly testable with in-memory fixtures.
 * __skipPersistence flag stays internal — never exposed to server
 * action signatures, UI, or route handlers.
 *
 * Pattern established in Prompt 3c (Gate 3 Item 2). Same pattern
 * SHOULD be applied to execution-package.ts in future work, but
 * was out of scope for Prompt 3c.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callLLM } from '@/lib/ai/llm-client'
import { buildAIContext, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { buildReadinessDocx } from '@/lib/reports/readiness-report-docx'
import { computeReadinessScore } from '@/lib/quality/readiness-score'
import { calculateReadinessScore, type ReadinessComponents } from '@/lib/quality/readiness-formula'
import { computeProjectStats } from '@/lib/quality/stat-formulas'
import {
  rollupProjectStats,
  type ProjectStats,
  type RawProjectStatsData,
} from '@/lib/quality/project-stats'
import { getMappingsForRedesignCore } from '@/lib/ai/mapping-engine'
import {
  flattenRowsForListView,
  countFlatRowStatuses,
} from '@/lib/utils/flatten-rows-for-list-view'
import type {
  MappingSourceRow,
  SourceFieldAcknowledgmentRow,
  TargetFieldMappingRow,
  TransformationRow,
} from '@/lib/types/mapping-redesign'
import {
  buildMappingCsvRows,
  buildMappingJsonGroups,
  buildTransformSpecsLines,
  buildGoldStandardSelectSQL,
  buildSqlLoadScriptInserts,
  buildReadinessReportPrompt,
  MAPPING_CSV_HEADERS,
  type TranslatorDataset,
  type TranslatorField,
  type TranslatorTable,
  type TranslatorTableMapping,
} from '@/lib/actions/_outputs-translators'

// ── Public types owned by the core module ────────────────────────────────────

export type PhaseColor = 'green' | 'yellow' | 'red' | 'gray'

export interface PhaseStatus {
  dataIngestion: 'complete' | 'incomplete'
  dataQuality: PhaseColor
  mapping: PhaseColor
  transformations: PhaseColor
  validation: PhaseColor
  completedCount: number
}

export interface OutputsMetrics {
  readinessScore: number
  readinessStatus: 'ready' | 'at_risk' | 'not_ready'
  readinessComponents: ReadinessComponents
  approvedFieldMappings: number
  totalFieldMappings: number
  openBlocking: number
  openWarnings: number
  completedTransforms: number
  totalTransforms: number
  stagedTables: number
  totalTargetTables: number
}

export type DecisionType = 'fix' | 'mapping' | 'transform' | 'validation' | 'data' | 'system'

export interface DecisionEntry {
  id: string
  type: DecisionType
  label: string
  timestamp: string
  user_id: string | null
  // Populated by enrichWithUserIdentity() in the outputs.ts wrapper —
  // absent in the core data path. Render layer reads these.
  user_name?: string | null
  user_email?: string | null
  metadata?: Record<string, unknown>
}

export interface OutstandingItems {
  unmappedSourceFields: number
  blockingIssues: number
  fieldsNeedingTransformWork: number
  untestedTransforms: number
  testedTransforms: number
}

export interface ReconstructedFile {
  filename: string
  type: string
  tableName: string | null
  loadOrder: number | null
  storagePath: string
}

export interface ExistingOutput {
  id: string
  type: string
  format: string
  version: string
  generated_at: string
  file_storage_path: string | null
  signedUrl: string | null
  tableName: string | null
  dialect: string | null
  reconstructedFiles?: ReconstructedFile[]
}

export interface OutputsPageData {
  project: { id: string; name: string }
  sourceDataset: { id: string; name: string } | null
  targetDataset: { id: string; name: string } | null
  sourceTableCount: number
  targetTableCount: number
  totalSourceRows: number
  phases: PhaseStatus
  metrics: OutputsMetrics
  decisions: DecisionEntry[]
  totalDecisions: number
  outstanding: OutstandingItems
  existingOutputs: ExistingOutput[]
  hasMappings: boolean
  hasSourceData: boolean
  hasTargetData: boolean
  // PR-1 (feat/project-stats-shared-helper): new public-surface view from
  // the shared helper at `lib/quality/project-stats.ts`. Carries the
  // 3-state machine label + axis-shaped stats (target / source / transforms
  // / blocking). Legacy fields on `metrics` stay populated for current UI;
  // PR-3 (Migration Center widget redesign) consumes `projectStats`
  // directly to surface the source axis and the redefined
  // `transforms.complete` numerator.
  projectStats: ProjectStats
  // Flat-row status tally — Approved / Needs Review counts derived from
  // the same `flattenRowsForListView` projection the Mapping page
  // summary strip counts over. The Migration Center "Mapping Coverage"
  // card renders these so its two figures match the strip exactly
  // (the target-axis `projectStats.target.*` numbers do NOT — they
  // exclude unmapped-source rows). See `countFlatRowStatuses`.
  mappingFlatCounts: { approved: number; needsReview: number }
}

export interface GeneratedFile {
  tableName: string
  sourceTableName: string
  downloadUrl: string
  rowCount: number
  version: string
  outputId: string
}

export function emptyOutputsPageData(projectId: string): OutputsPageData {
  return {
    project: { id: projectId, name: 'Unknown' },
    sourceDataset: null,
    targetDataset: null,
    sourceTableCount: 0,
    targetTableCount: 0,
    totalSourceRows: 0,
    phases: {
      dataIngestion: 'incomplete',
      dataQuality: 'gray',
      mapping: 'red',
      transformations: 'gray',
      validation: 'red',
      completedCount: 0,
    },
    metrics: {
      readinessScore: 0,
      readinessStatus: 'not_ready',
      readinessComponents: { mapping: 0, transform: 0, blocking: 0, warnings: 0, staging: 0 },
      approvedFieldMappings: 0,
      totalFieldMappings: 0,
      openBlocking: 0,
      openWarnings: 0,
      completedTransforms: 0,
      totalTransforms: 0,
      stagedTables: 0,
      totalTargetTables: 0,
    },
    decisions: [],
    totalDecisions: 0,
    outstanding: {
      unmappedSourceFields: 0,
      blockingIssues: 0,
      fieldsNeedingTransformWork: 0,
      untestedTransforms: 0,
      testedTransforms: 0,
    },
    existingOutputs: [],
    hasMappings: false,
    hasSourceData: false,
    hasTargetData: false,
    projectStats: {
      state: 'awaiting_data',
      target: { approved: 0, total: 0, unmapped: 0, needsReview: 0, usedInMapping: 0, schemaTotal: 0 },
      source: { decided: 0, total: 0, usedInMapping: 0 },
      transforms: { complete: 0, total: 0 },
      blocking: 0,
    },
    mappingFlatCounts: { approved: 0, needsReview: 0 },
  }
}

export interface HydratedProjectData {
  project: { id: string; name: string }
  datasets: TranslatorDataset[]
  datasetsById: Map<string, TranslatorDataset>
  tables: TranslatorTable[]
  tablesById: Map<string, TranslatorTable>
  fields: TranslatorField[]
  fieldsById: Map<string, TranslatorField>
  tableMappings: TranslatorTableMapping[]
  targetFieldMappings: TargetFieldMappingRow[]
  mappingSources: MappingSourceRow[]
  transformations: TransformationRow[]
  sourceFieldAcknowledgments: SourceFieldAcknowledgmentRow[]
}

// ── Shared helpers ────────────────────────────────────────────────────────────

export function buildCSV(
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }
  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n')
}

function nextVersion(current: string): string {
  const parts = current.split('.')
  const minor = parseInt(parts[1] ?? '0', 10)
  return `${parts[0]}.${minor + 1}`
}

export async function getNextVersion(
  projectId: string,
  type: string,
  format: string,
): Promise<string> {
  const { data } = await supabaseAdmin
    .from('outputs')
    .select('version')
    .eq('project_id', projectId)
    .eq('type', type)
    .eq('format', format)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data ? nextVersion(data.version) : '1.0'
}

export async function uploadAndRecord(params: {
  projectId: string
  userId: string
  content: string | Buffer
  storagePath: string
  contentType: string
  outputType: string
  format: string
  version: string
  tableName?: string
}): Promise<{ signedUrl: string; outputId: string }> {
  const { projectId, userId, content, storagePath, contentType, outputType, format, version } = params

  const fullPath = `${userId}/${projectId}/${storagePath}`

  await supabaseAdmin.storage.from('project-files').upload(fullPath, content, {
    contentType,
    upsert: true,
  })

  const { data: signed } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(fullPath, 3600)

  const signedUrl = signed?.signedUrl ?? ''

  const { data: outputRecord } = await supabaseAdmin
    .from('outputs')
    .insert({
      project_id: projectId,
      type: outputType,
      format,
      version,
      file_storage_path: fullPath,
    })
    .select('id')
    .single()

  return { signedUrl, outputId: outputRecord?.id ?? '' }
}

/**
 * Loads the hydrated data every Internal function needs. Uses supabaseAdmin
 * (RLS-bypassing) — callers upstream are responsible for auth gating.
 */
export async function hydrateProjectData(
  projectId: string,
): Promise<HydratedProjectData | null> {
  const [{ data: project }, { data: datasetsRaw }] = await Promise.all([
    supabaseAdmin.from('projects').select('id, name').eq('id', projectId).maybeSingle(),
    supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId),
  ])
  if (!project) return null

  const datasets: TranslatorDataset[] = (datasetsRaw ?? [])
    .filter((d): d is { id: string; role: 'source' | 'target'; name: string } =>
      d.role === 'source' || d.role === 'target',
    )
    .map((d) => ({ id: d.id, role: d.role, name: d.name }))
  const datasetIds = datasets.map((d) => d.id)

  const { data: tablesRaw } = datasetIds.length
    ? await supabaseAdmin
        .from('tables')
        .select('id, dataset_id, name, row_count')
        .in('dataset_id', datasetIds)
    : { data: [] }
  const tables: TranslatorTable[] = (tablesRaw ?? []).map((t) => ({
    id: t.id,
    dataset_id: t.dataset_id,
    name: t.name,
    row_count: t.row_count,
  }))
  const tableIds = tables.map((t) => t.id)

  const [{ data: fieldsRaw }, { data: tmRaw }] = await Promise.all([
    tableIds.length
      ? supabaseAdmin
          .from('fields')
          .select(
            'id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position',
          )
          .in('table_id', tableIds)
      : Promise.resolve({ data: [] }),
    supabaseAdmin
      .from('table_mappings')
      .select('id, project_id, source_table_id, target_table_id, status, confidence, ai_reasoning')
      .eq('project_id', projectId),
  ])

  const fields: TranslatorField[] = (fieldsRaw ?? []).map((f) => ({
    id: f.id,
    table_id: f.table_id,
    name: f.name,
    data_type: f.data_type,
    inferred_type: f.inferred_type,
    is_nullable: f.is_nullable,
    is_primary_key: f.is_primary_key,
    is_foreign_key: f.is_foreign_key,
    fk_reference: f.fk_reference,
    ordinal_position: f.ordinal_position,
  }))
  const tableMappings: TranslatorTableMapping[] = (tmRaw ?? []).map((tm) => ({
    id: tm.id,
    project_id: tm.project_id,
    source_table_id: tm.source_table_id,
    target_table_id: tm.target_table_id,
    status: tm.status,
    confidence: tm.confidence,
    ai_reasoning: tm.ai_reasoning,
  }))

  const [{ data: tfmRaw }, { data: msRaw }, { data: sackRaw }] = await Promise.all([
    supabaseAdmin
      .from('target_field_mappings')
      .select(
        'id, project_id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, acknowledgment_reason, combination_type, combination_sql, needs_transformation, va_dismissed, dismissal_reason, created_at, updated_at',
      )
      .eq('project_id', projectId),
    // PR-4 followup-A: project filter via embedded inner-join. Same bug
    // and same fix as `getOutputsPageDataCore`'s mapping_sources fetch
    // (lines ~1066-1080). Without this scope, the global fetch was
    // silently truncated by PostgREST's server-side `db-max-rows` cap
    // for orgs with many mapping_sources rows — affecting all output
    // generators (Gold Standard CSV, SQL Load Scripts, Readiness Report,
    // Mapping File, Transform Specs) that consume `hydrateProjectData`.
    supabaseAdmin
      .from('mapping_sources')
      .select(
        'id, target_field_mapping_id, source_field_id, source_table_id, confidence, ai_reasoning, similar_fields_considered, type_compatibility, join_spec, ordinal, created_at, target_field_mappings!inner(project_id)',
      )
      .eq('target_field_mappings.project_id', projectId),
    supabaseAdmin
      .from('source_field_acknowledgments')
      .select('id, project_id, source_field_id, reason, notes, acknowledged_by, acknowledged_at')
      .eq('project_id', projectId),
  ])

  const targetFieldMappings = (tfmRaw ?? []) as TargetFieldMappingRow[]
  const tfmIdSet = new Set(targetFieldMappings.map((t) => t.id))
  // Defense-in-depth: SQL embedded inner-join already restricts msRaw to
  // this project's TFMs, so this filter is now a no-op against correct
  // input. Kept for parity with the consumer-side narrowing pattern.
  const mappingSources = ((msRaw ?? []) as MappingSourceRow[]).filter((ms) =>
    tfmIdSet.has(ms.target_field_mapping_id),
  )
  const sourceFieldAcknowledgments = (sackRaw ?? []) as SourceFieldAcknowledgmentRow[]

  const { data: txRaw } = tfmIdSet.size
    ? await supabaseAdmin
        .from('transformations')
        .select(
          'id, target_field_mapping_id, description, generated_sql, is_ai_generated, test_results, status, created_at',
        )
        .in('target_field_mapping_id', Array.from(tfmIdSet))
    : { data: [] }
  const transformations = (txRaw ?? []) as TransformationRow[]

  return {
    project: { id: project.id, name: project.name },
    datasets,
    datasetsById: new Map(datasets.map((d) => [d.id, d])),
    tables,
    tablesById: new Map(tables.map((t) => [t.id, t])),
    fields,
    fieldsById: new Map(fields.map((f) => [f.id, f])),
    tableMappings,
    targetFieldMappings,
    mappingSources,
    transformations,
    sourceFieldAcknowledgments,
  }
}

// ── generateGoldStandardCSVsInternal ─────────────────────────────────────────

export async function generateGoldStandardCSVsInternal(
  projectId: string,
  userId: string,
  __skipPersistence: boolean,
): Promise<{ success: boolean; files: GeneratedFile[]; errors?: string[]; error?: string }> {
  const data = await hydrateProjectData(projectId)
  if (!data) return { success: false, files: [], error: 'Access denied' }

  const approvedTMs = data.tableMappings.filter((tm) => tm.status === 'approved')
  if (approvedTMs.length === 0) {
    return {
      success: false,
      files: [],
      error:
        'No approved table mappings found. Approve mappings before generating Gold Standard files.',
    }
  }

  const files: GeneratedFile[] = []
  const errors: string[] = []

  for (const tm of approvedTMs) {
    const sourceTableName = data.tablesById.get(tm.source_table_id)?.name ?? 'unknown'
    const targetTableName = data.tablesById.get(tm.target_table_id)?.name ?? 'unknown'

    try {
      const { data: stagedSample } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data')
        .eq('table_mapping_id', tm.id)
        .limit(1)

      let rows: Record<string, unknown>[]
      let targetFieldNames: string[]

      if ((stagedSample ?? []).length > 0) {
        const { data: stagedRows, error: stagedErr } = await supabaseAdmin
          .from('staged_data_rows')
          .select('transformed_row_data')
          .eq('table_mapping_id', tm.id)
          .order('row_number')

        if (stagedErr) {
          errors.push(`${targetTableName}: ${stagedErr.message}`)
          continue
        }
        rows = (stagedRows ?? []).map((r) => r.transformed_row_data as Record<string, unknown>)
        targetFieldNames = rows.length > 0 ? Object.keys(rows[0]) : []
      } else {
        const allSourceFieldNames = data.fields
          .filter((f) => f.table_id === tm.source_table_id)
          .map((f) => f.name)

        const { selectSQL, targetFieldNames: derivedNames, warnings } = buildGoldStandardSelectSQL({
          tableMapping: tm,
          targetFieldMappings: data.targetFieldMappings,
          mappingSources: data.mappingSources,
          transformations: data.transformations,
          fieldsById: data.fieldsById,
          allSourceFieldNames,
        })
        for (const w of warnings) errors.push(w)
        if (!selectSQL) continue

        const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
          'execute_gold_standard_query',
          { p_sql: selectSQL },
        )
        if (rpcErr) {
          errors.push(`${targetTableName}: ${rpcErr.message}`)
          continue
        }
        rows = (rpcResult as Record<string, unknown>[]) ?? []
        targetFieldNames = derivedNames
      }

      if (targetFieldNames.length === 0) continue

      const csvContent = buildCSV(targetFieldNames, rows)
      if (__skipPersistence) {
        files.push({
          tableName: targetTableName,
          sourceTableName,
          downloadUrl: '',
          rowCount: rows.length,
          version: '0.0',
          outputId: '',
        })
        continue
      }

      const version = await getNextVersion(projectId, 'gold_standard_csv', 'csv')
      const storagePath = `outputs/gold_standard/${targetTableName}_v${version}.csv`

      const { signedUrl, outputId } = await uploadAndRecord({
        projectId,
        userId,
        content: csvContent,
        storagePath,
        contentType: 'text/csv',
        outputType: 'gold_standard_csv',
        format: 'csv',
        version,
      })

      files.push({
        tableName: targetTableName,
        sourceTableName,
        downloadUrl: signedUrl,
        rowCount: rows.length,
        version,
        outputId,
      })
    } catch (err) {
      errors.push(`${targetTableName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    success: files.length > 0 || errors.length === 0,
    files,
    errors: errors.length > 0 ? errors : undefined,
  }
}

// ── generateSQLLoadScriptsInternal ───────────────────────────────────────────

export async function generateSQLLoadScriptsInternal(
  projectId: string,
  userId: string,
  __skipPersistence: boolean,
): Promise<{ success: boolean; files: GeneratedFile[]; errors?: string[]; error?: string }> {
  const data = await hydrateProjectData(projectId)
  if (!data) return { success: false, files: [], error: 'Access denied' }

  const approvedTMs = data.tableMappings.filter((tm) => tm.status === 'approved')
  if (approvedTMs.length === 0) {
    return { success: false, files: [], error: 'No approved table mappings found.' }
  }

  const srcDatasetName = data.datasets.find((d) => d.role === 'source')?.name ?? 'SOURCE'

  const files: GeneratedFile[] = []
  const errors: string[] = []

  for (const tm of approvedTMs) {
    const sourceTableName = data.tablesById.get(tm.source_table_id)?.name ?? 'unknown'
    const targetTableName = data.tablesById.get(tm.target_table_id)?.name ?? 'unknown'

    try {
      const { data: stagedSample } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data')
        .eq('table_mapping_id', tm.id)
        .limit(1)

      let rows: Record<string, unknown>[]
      let targetFieldNames: string[]

      if ((stagedSample ?? []).length > 0) {
        const { data: stagedRows, error: stagedErr } = await supabaseAdmin
          .from('staged_data_rows')
          .select('transformed_row_data')
          .eq('table_mapping_id', tm.id)
          .order('row_number')
        if (stagedErr) {
          errors.push(`${targetTableName}: ${stagedErr.message}`)
          continue
        }
        rows = (stagedRows ?? []).map((r) => r.transformed_row_data as Record<string, unknown>)
        targetFieldNames = rows.length > 0 ? Object.keys(rows[0]) : []
      } else {
        const allSourceFieldNames = data.fields
          .filter((f) => f.table_id === tm.source_table_id)
          .map((f) => f.name)

        const { selectSQL, targetFieldNames: derivedNames, warnings } = buildGoldStandardSelectSQL({
          tableMapping: tm,
          targetFieldMappings: data.targetFieldMappings,
          mappingSources: data.mappingSources,
          transformations: data.transformations,
          fieldsById: data.fieldsById,
          allSourceFieldNames,
        })
        for (const w of warnings) errors.push(w)
        if (!selectSQL) continue

        const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
          'execute_gold_standard_query',
          { p_sql: selectSQL },
        )
        if (rpcErr) {
          errors.push(`${targetTableName}: ${rpcErr.message}`)
          continue
        }
        rows = (rpcResult as Record<string, unknown>[]) ?? []
        targetFieldNames = derivedNames
      }

      if (targetFieldNames.length === 0) continue

      const sqlContent = buildSqlLoadScriptInserts({
        targetTableName,
        sourceTableName,
        sourceDatasetName: srcDatasetName,
        generatedAt: new Date().toUTCString(),
        rows,
        targetFieldNames,
      })

      if (__skipPersistence) {
        files.push({
          tableName: targetTableName,
          sourceTableName,
          downloadUrl: '',
          rowCount: rows.length,
          version: '0.0',
          outputId: '',
        })
        continue
      }

      const version = await getNextVersion(projectId, 'gold_standard_sql', 'sql')
      const storagePath = `outputs/gold_standard/${targetTableName}_v${version}.sql`

      const { signedUrl, outputId } = await uploadAndRecord({
        projectId,
        userId,
        content: sqlContent,
        storagePath,
        contentType: 'application/sql',
        outputType: 'gold_standard_sql',
        format: 'sql',
        version,
      })

      files.push({
        tableName: targetTableName,
        sourceTableName,
        downloadUrl: signedUrl,
        rowCount: rows.length,
        version,
        outputId,
      })
    } catch (err) {
      errors.push(`${targetTableName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    success: files.length > 0 || errors.length === 0,
    files,
    errors: errors.length > 0 ? errors : undefined,
  }
}

// ── generateReadinessReportInternal ──────────────────────────────────────────

export async function generateReadinessReportInternal(
  projectId: string,
  userId: string,
  _format: 'pdf' | 'docx' | 'markdown',
  __skipPersistence: boolean,
): Promise<{
  success: boolean
  downloadUrl?: string
  content?: string
  version?: string
  error?: string
}> {
  const data = await hydrateProjectData(projectId)
  if (!data) return { success: false, error: 'Access denied' }

  const srcDs = data.datasets.find((d) => d.role === 'source') ?? null
  const tgtDs = data.datasets.find((d) => d.role === 'target') ?? null

  const [{ data: qualityIssues }, { data: fixHistory }, { data: validationRules }] =
    await Promise.all([
      supabaseAdmin
        .from('quality_issues')
        .select('title, severity, description, affected_records, status')
        .eq('project_id', projectId),
      supabaseAdmin
        .from('fix_history')
        .select('fix_description, affected_row_count, applied_at, status')
        .eq('project_id', projectId)
        .order('applied_at', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('validation_rules')
        .select('name, description, rule_type, severity')
        .eq('project_id', projectId),
    ])

  const srcTables = data.tables.filter((t) => t.dataset_id === srcDs?.id)
  const tgtTables = data.tables.filter((t) => t.dataset_id === tgtDs?.id)
  const srcTableIds = new Set(srcTables.map((t) => t.id))
  const totalSourceFields = data.fields.filter((f) => srcTableIds.has(f.table_id)).length
  const totalSourceRows = srcTables.reduce((s, t) => s + (t.row_count ?? 0), 0)

  const readiness = await computeReadinessScore(projectId)
  const readinessScore = readiness.score
  const readinessLabel =
    readiness.status === 'ready'
      ? 'Ready'
      : readiness.status === 'at_risk'
        ? 'Ready with Conditions'
        : 'Not Ready'

  const reportCtx = await buildAIContext(projectId, {
    includeProfilingStats: false,
    includeValueDistributions: false,
    includeSampleValues: false,
    includeDocuments: true,
  })
  const documentBlock = formatDocumentsForPrompt(reportCtx.documents)

  const bundle = buildReadinessReportPrompt({
    projectName: data.project.name,
    srcDatasetName: srcDs?.name ?? 'Unknown',
    tgtDatasetName: tgtDs?.name ?? 'Unknown',
    srcTableCount: srcTables.length,
    tgtTableCount: tgtTables.length,
    totalSourceRows,
    totalSourceFields,
    readinessScore,
    readinessLabel,
    tableMappings: data.tableMappings,
    targetFieldMappings: data.targetFieldMappings,
    mappingSources: data.mappingSources,
    sourceFieldAcknowledgments: data.sourceFieldAcknowledgments,
    transformations: data.transformations,
    qualityIssues: (qualityIssues ?? []).map((q) => ({
      title: q.title,
      severity: q.severity,
      description: q.description,
      affected_records: q.affected_records,
      status: q.status,
    })),
    fixHistory: (fixHistory ?? []).map((fh) => ({
      fix_description: fh.fix_description,
      affected_row_count: fh.affected_row_count,
      applied_at: fh.applied_at,
      status: fh.status,
    })),
    validationRules: validationRules ?? [],
    documentBlock,
  })

  let reportText: string
  try {
    const result = await callLLM({
      feature: 'outputs_readiness_report',
      systemPrompt: bundle.systemPrompt,
      userMessage: bundle.userMessage,
      maxTokens: bundle.maxTokens,
      projectId,
      userId,
      promptVersion: 'readiness-report-v1',
      abuseUserId: userId,
    })
    // PR 12.2 B-2: stay-text callsite (markdown narrative — tool-use here
    // would be schema-validation theater per Phase A §2.3). No `tool` is
    // passed, so result.kind is always 'text'; the ternary narrows the
    // discriminated union without a throwable defensive branch.
    reportText = result.kind === 'text' ? result.text : ''
  } catch {
    return { success: false, error: 'AI report generation failed. Please try again.' }
  }

  const now = new Date().toUTCString()
  let docxBuffer: Buffer
  try {
    docxBuffer = await buildReadinessDocx(reportText, {
      projectName: data.project.name,
      generatedDate: now,
      readinessScore,
      readinessLabel,
    })
  } catch {
    return { success: false, error: 'Failed to build Word document. Please try again.' }
  }

  if (__skipPersistence) {
    return { success: true, version: '0.0', content: reportText }
  }

  const actualFormat = 'docx'
  const ext = 'docx'
  const version = await getNextVersion(projectId, 'readiness_report', actualFormat)
  const storagePath = `outputs/reports/readiness_report_v${version}.${ext}`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId,
    content: docxBuffer,
    storagePath,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    outputType: 'readiness_report',
    format: actualFormat,
    version,
  })

  return { success: true, downloadUrl: signedUrl, version }
}

// ── generateMappingFileInternal ──────────────────────────────────────────────

export async function generateMappingFileInternal(
  projectId: string,
  userId: string,
  format: 'csv' | 'json',
  __skipPersistence: boolean,
): Promise<{
  success: boolean
  downloadUrl?: string
  content?: string
  version?: string
  error?: string
}> {
  const data = await hydrateProjectData(projectId)
  if (!data) return { success: false, error: 'Access denied' }

  // Legacy filtered TMs to non-rejected before generating the JSON (audit
  // trail includes rejected FMs inside approved/needs_review TMs, but drops
  // whole-TM rejections). Mirror that here.
  const nonRejectedTMs = data.tableMappings.filter((tm) => tm.status !== 'rejected')
  if (nonRejectedTMs.length === 0) {
    return { success: false, error: 'No table mappings found.' }
  }

  let content: string
  if (format === 'csv') {
    const rows = buildMappingCsvRows({
      tableMappings: nonRejectedTMs,
      targetFieldMappings: data.targetFieldMappings,
      mappingSources: data.mappingSources,
      transformations: data.transformations,
      fieldsById: data.fieldsById,
      tablesById: data.tablesById,
    })
    content = buildCSV(MAPPING_CSV_HEADERS, rows as unknown as Record<string, unknown>[])
  } else {
    const groups = buildMappingJsonGroups({
      tableMappings: nonRejectedTMs,
      targetFieldMappings: data.targetFieldMappings,
      mappingSources: data.mappingSources,
      transformations: data.transformations,
      fieldsById: data.fieldsById,
      tablesById: data.tablesById,
      datasetsById: data.datasetsById,
    })
    content = JSON.stringify(
      {
        project: data.project.name,
        generated_at: new Date().toISOString(),
        version: '__pending__',
        table_mappings: groups,
      },
      null,
      2,
    )
  }

  if (__skipPersistence) {
    return { success: true, content, version: '0.0' }
  }

  const version = await getNextVersion(projectId, 'mapping_file', format)
  if (format === 'json') {
    content = content.replace('"version": "__pending__"', `"version": ${JSON.stringify(version)}`)
  }
  const ext = format === 'csv' ? 'csv' : 'json'
  const storagePath = `outputs/mapping/mapping_file_v${version}.${ext}`
  const contentType = format === 'csv' ? 'text/csv' : 'application/json'

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId,
    content,
    storagePath,
    contentType,
    outputType: 'mapping_file',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── generateTransformSpecsInternal ───────────────────────────────────────────

export async function generateTransformSpecsInternal(
  projectId: string,
  userId: string,
  format: 'sql' | 'markdown',
  __skipPersistence: boolean,
): Promise<{
  success: boolean
  downloadUrl?: string
  content?: string
  version?: string
  error?: string
}> {
  const data = await hydrateProjectData(projectId)
  if (!data) return { success: false, error: 'Access denied' }

  if (data.transformations.length === 0) {
    return { success: false, error: 'No transformations found.' }
  }

  const lines = buildTransformSpecsLines({
    projectName: data.project.name,
    generatedAt: new Date().toUTCString(),
    tableMappings: data.tableMappings,
    targetFieldMappings: data.targetFieldMappings,
    mappingSources: data.mappingSources,
    transformations: data.transformations,
    fieldsById: data.fieldsById,
    tablesById: data.tablesById,
  })

  const content = lines.join('\n')
  if (__skipPersistence) {
    return { success: true, content, version: '0.0' }
  }

  const version = await getNextVersion(projectId, 'transformation_specs', format)
  const storagePath = `outputs/transforms/transform_specs_v${version}.sql`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId,
    content,
    storagePath,
    contentType: 'application/sql',
    outputType: 'transformation_specs',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── getOutputsPageDataCore ────────────────────────────────────────────────────
//
// Core data-assembly function for the outputs page. The server action
// `getOutputsPageData` in outputs.ts enforces auth + project membership and
// passes its cookies-bound user client through; the rows that feed
// `projectStats` (datasets, tables, fields, target_field_mappings,
// mapping_sources, source_field_acknowledgments, transformations,
// quality_issues, projects) MUST go through that client so the Migration
// Center widgets see the same RLS-bound rowset as the Mapping page top
// strip and the dashboard tile. Without this unification, MC would silently
// see admin-fetched rows the user can't observe elsewhere — which is the
// alignment bug PR-4 closes.
//
// Auxiliary rows (table_mappings, outputs, activity_log, staged_data_rows)
// stay on supabaseAdmin: they're not stat feeders and their RLS posture
// hasn't been audited as part of this PR. Pre-PR-1 audit confirmed all 10
// stat-feeder tables have project-broad SELECT policies via
// `user_can_access_project`, so the swap is a pure client substitution
// with no rowset change for project members.
//
// Tests / heritage callers that need to bypass auth (e.g.
// outputs-heritage.test.ts) can omit `client` — the parameter defaults to
// supabaseAdmin to preserve the prior behavior.

export async function getOutputsPageDataCore(
  projectId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<OutputsPageData> {
  const { data: project } = await client
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()
  if (!project) throw new Error('Project not found')

  const [
    { data: datasets },
    { data: rawTableMappings },
    { data: qualityIssueRows },
    { data: outputRows },
    { data: activityRows },
    { data: sourceAckRows },
    { data: tfmRows },
    { data: msRows },
    { data: coverageRows },
  ] = await Promise.all([
    client.from('datasets').select('id, role, name').eq('project_id', projectId),
    supabaseAdmin
      .from('table_mappings')
      .select('id, status, source_table_id, target_table_id')
      .eq('project_id', projectId)
      .neq('status', 'rejected'),
    client
      .from('quality_issues')
      .select('id, severity, status, title, description, field_id, stage, issue_kind, created_at')
      .eq('project_id', projectId),
    supabaseAdmin
      .from('outputs')
      .select('*')
      .eq('project_id', projectId)
      .order('generated_at', { ascending: false }),
    supabaseAdmin
      .from('activity_log')
      .select('id, action_type, description, category, metadata, created_at, user_id')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(200),
    client
      .from('source_field_acknowledgments')
      .select('source_field_id')
      .eq('project_id', projectId),
    client
      .from('target_field_mappings')
      .select(
        // PR ε — `combination_sql` is now required on `RawProjectStatsData.tfms`
        // so the canonical formula can distinguish completed VA literals from
        // blank placeholders. Added here purely to satisfy the typed projection
        // at line ~1235; the Migration Center surface itself doesn't render
        // `targetFieldsUsedInMapping`, so no user-visible behavior changes.
        'id, target_field_id, confidence, status, ai_reasoning, is_acknowledged, combination_type, combination_sql, needs_transformation, va_dismissed, created_at',
      )
      .eq('project_id', projectId),
    // PR-4 followup-A: project filter via embedded inner-join. The prior
    // shape was a global unfiltered fetch + a downstream
    // `tfmIdSet`-based filter, which silently truncated to PostgREST's
    // server-side `db-max-rows` cap (1000 in this environment) for orgs
    // with many mapping_sources rows — driving the cross-surface stats
    // misalignment diagnosed in Stop 1. Mirrors the transformations fetch
    // pattern already in `fetchProjectStatsData`
    // (`lib/quality/project-stats.ts:282`).
    client
      .from('mapping_sources')
      .select(
        'id, target_field_mapping_id, source_field_id, source_table_id, confidence, ordinal, type_compatibility, target_field_mappings!inner(project_id)',
      )
      .eq('target_field_mappings.project_id', projectId),
    // PR γ.2 — coverage rows so computeProjectStats UNIONs coverage-
    // status='approved' into mappingApproved for no-source target
    // fields. Pre-Path-D projects return zero rows.
    client
      .from('target_field_coverage')
      .select('target_field_id, status, status_set_by')
      .eq('project_id', projectId),
  ])

  const sourceDataset = datasets?.find((d) => d.role === 'source') ?? null
  const targetDataset = datasets?.find((d) => d.role === 'target') ?? null
  const allDatasetIds = datasets?.map((d) => d.id) ?? []

  const { data: allTables } = await client
    .from('tables')
    .select('id, dataset_id, name, row_count')
    .in('dataset_id', allDatasetIds.length ? allDatasetIds : ['__none__'])

  const sourceTables = (allTables ?? []).filter((t) => t.dataset_id === sourceDataset?.id)
  const targetTables = (allTables ?? []).filter((t) => t.dataset_id === targetDataset?.id)
  const sourceTableIds = sourceTables.map((t) => t.id)
  const targetTableIds = targetTables.map((t) => t.id)
  const nonRejectedTMIds = (rawTableMappings ?? []).map((tm) => tm.id)
  const totalSourceRows = sourceTables.reduce((sum, t) => sum + (t.row_count ?? 0), 0)

  const [{ data: sourceFieldRows }, { data: targetFieldRows }] = await Promise.all([
    client
      .from('fields')
      .select('id, name, data_type, is_nullable, table_id')
      .in('table_id', sourceTableIds.length ? sourceTableIds : ['__none__']),
    client
      .from('fields')
      .select(
        'id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, table_id, default_value',
      )
      .in('table_id', targetTableIds.length ? targetTableIds : ['__none__']),
  ])

  const tfms = (tfmRows ?? []) as Array<{
    id: string
    target_field_id: string
    confidence: number | null
    status: 'needs_review' | 'approved' | 'rejected'
    ai_reasoning: string | null
    is_acknowledged: boolean
    combination_type: string | null
    /** PR ε — surfaced so the canonical formula can distinguish a completed
     *  VA literal from a blank placeholder when downstream consumers compute
     *  `targetFieldsUsedInMapping` via `RawProjectStatsData`. */
    combination_sql: string | null
    needs_transformation: boolean | null
    va_dismissed: boolean | null
    created_at: string
  }>
  const tfmIdSet = new Set(tfms.map((t) => t.id))
  const nonRejectedTfms = tfms.filter((t) => t.status !== 'rejected')
  const msByTfmId = new Map<string, Array<{ source_field_id: string | null; source_table_id: string | null; confidence: number | null; ordinal: number; type_compatibility: string | null }>>()
  for (const ms of (msRows ?? []).filter((m) => tfmIdSet.has(m.target_field_mapping_id))) {
    const list = msByTfmId.get(ms.target_field_mapping_id) ?? []
    list.push(ms)
    msByTfmId.set(ms.target_field_mapping_id, list)
  }

  const { data: transformRows } =
    tfmIdSet.size > 0
      ? await client
          .from('transformations')
          .select('id, target_field_mapping_id, status, description, created_at')
          .in('target_field_mapping_id', Array.from(tfmIdSet))
      : { data: [] }

  const totalSourceFields = (sourceFieldRows ?? []).length

  // Mapping / transform / quality-issue counts now come from the canonical
  // `computeProjectStats` helper (`lib/quality/stat-formulas.ts`). The helper
  // also powers `computeReadinessScore` and (post Prompt B) the Projects
  // Dashboard card, so any future change to these formulas lands in exactly
  // one place. See the helper's file header for the full historical rationale.
  const stats = computeProjectStats({
    tfms,
    mappingSources: (msRows ?? []).map((m) => ({
      target_field_mapping_id: m.target_field_mapping_id,
      source_field_id: m.source_field_id,
      ordinal: m.ordinal,
      type_compatibility: m.type_compatibility,
    })),
    sourceFields: (sourceFieldRows ?? []).map((f) => ({ id: f.id, name: f.name, data_type: f.data_type })),
    targetFields: (targetFieldRows ?? []).map((f) => ({ id: f.id, name: f.name, data_type: f.data_type })),
    sourceAckFieldIds: (sourceAckRows ?? []).map((a) => a.source_field_id),
    transforms: (transformRows ?? []).map((t) => ({
      target_field_mapping_id: t.target_field_mapping_id,
      status: t.status,
    })),
    qualityIssues: qualityIssueRows ?? [],
    // PR γ.2 — coverage UNION input for mappingApproved.
    coverage: (coverageRows ?? []).map((c) => ({
      target_field_id: c.target_field_id,
      status: c.status,
      status_set_by: c.status_set_by,
    })),
  })

  // The Migration Center's card uses the resolution-suppressed counts so
  // blocking-issue totals drop immediately when a user resolves a source
  // field via dismissal or transform application. Readiness-score.ts
  // separately picks the naive counts to preserve historic behavior; the
  // drift is documented on `ProjectStats.openBlocking`.
  const mappingApproved = stats.mappingApproved
  const mappingTotal = stats.mappingTotal
  const mappingUnmapped = stats.mappingUnmapped
  const completedTransforms = stats.transformApplied
  const totalTransformScope = stats.transformScope
  const fieldsNeedingTransformWork = stats.transformNeedsWork
  const draftTransforms = stats.transformDraft
  const testedTransforms = stats.transformTested
  const openBlocking = stats.openBlockingResolutionSuppressed
  const openWarnings = stats.openWarningsResolutionSuppressed
  const untestedTransforms = draftTransforms

  // PR-1 (feat/project-stats-shared-helper): produce the new
  // public-surface `ProjectStats` view via the shared helper. We build a
  // `RawProjectStatsData` from rows already fetched above (no extra
  // round-trip) and call `rollupProjectStats` directly. This is the
  // canonical surface consumed by PR-3 (Migration Center widget redesign);
  // the legacy `metrics.*` fields above stay populated for the current UI.
  const projectStatsRaw: RawProjectStatsData = {
    datasets: (datasets ?? []).map((d) => ({
      id: d.id,
      project_id: projectId,
      role: d.role,
    })),
    tables: (allTables ?? []).map((t) => ({ id: t.id, dataset_id: t.dataset_id })),
    fields: [
      ...(sourceFieldRows ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        table_id: f.table_id,
      })),
      ...(targetFieldRows ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        data_type: f.data_type,
        table_id: f.table_id,
      })),
    ],
    tfms: tfms.map((t) => ({
      id: t.id,
      project_id: projectId,
      target_field_id: t.target_field_id,
      confidence: t.confidence,
      status: t.status,
      is_acknowledged: t.is_acknowledged,
      combination_type: t.combination_type,
      combination_sql: t.combination_sql,
      needs_transformation: t.needs_transformation,
      va_dismissed: t.va_dismissed,
    })),
    mappingSources: (msRows ?? [])
      .filter((m) => tfmIdSet.has(m.target_field_mapping_id))
      .map((m) => ({
        target_field_mapping_id: m.target_field_mapping_id,
        source_field_id: m.source_field_id,
        ordinal: m.ordinal,
        type_compatibility: m.type_compatibility,
      })),
    sourceAcks: (sourceAckRows ?? []).map((a) => ({
      project_id: projectId,
      source_field_id: a.source_field_id,
    })),
    transformations: (transformRows ?? []).map((t) => ({
      target_field_mapping_id: t.target_field_mapping_id,
      status: t.status,
      target_field_mappings: { project_id: projectId },
    })),
    qualityIssues: (qualityIssueRows ?? []).map((q) => ({
      project_id: projectId,
      severity: q.severity,
      status: q.status,
      stage: q.stage,
      field_id: q.field_id,
      issue_kind: q.issue_kind,
      description: q.description,
      title: q.title,
    })),
    // PR γ.2 — coverage rows for the rollup's mappingApproved UNION.
    coverage: (coverageRows ?? []).map((c) => ({
      project_id: projectId,
      target_field_id: c.target_field_id,
      status: c.status,
      status_set_by: c.status_set_by,
    })),
  }
  const projectStats = rollupProjectStats(projectId, projectStatsRaw)

  // Flat-row status tally for the Migration Center "Mapping Coverage"
  // card. Counts over the SAME `flattenRowsForListView` projection the
  // Mapping page summary strip counts over, so the MC card's Approved /
  // Needs Review figures match the strip exactly. `getMappingsForRedesignCore`
  // gates on the `projects` row and filters every fetch by `projectId`,
  // so passing the RLS-bound `client` is scope-safe; a null return
  // (project gate failed) degrades to zero counts. The aggregate
  // `projectStats.target.*` numbers deliberately are NOT used here —
  // they exclude unmapped-source rows and so undercount Needs Review.
  const mappingResult = await getMappingsForRedesignCore(client, projectId)
  const mappingFlatCounts = mappingResult
    ? countFlatRowStatuses(flattenRowsForListView(mappingResult))
    : { approved: 0, needsReview: 0 }

  const stagingCountResults = nonRejectedTMIds.length > 0
    ? await Promise.all(
        nonRejectedTMIds.map((tmId) =>
          supabaseAdmin
            .from('staged_data_rows')
            .select('id', { count: 'exact', head: true })
            .eq('table_mapping_id', tmId),
        ),
      )
    : []
  const stagedTables = stagingCountResults.filter((r) => (r.count ?? 0) > 0).length
  const totalTargetTables = targetTables.length

  const readinessResult = calculateReadinessScore({
    mappingApproved,
    mappingTotal,
    transformApplied: completedTransforms,
    transformScope: totalTransformScope,
    openBlocking,
    openWarnings,
    totalFields: totalSourceFields,
    stagedTables,
    totalTables: totalTargetTables,
  })
  const readinessScore = readinessResult.score
  const readinessStatus = readinessResult.status

  const dataIngestion: 'complete' | 'incomplete' =
    sourceTables.length > 0 && targetTables.length > 0 ? 'complete' : 'incomplete'
  const dataQualityColor: PhaseColor = openBlocking === 0 ? 'green' : openBlocking < 5 ? 'yellow' : 'red'
  const mappingPct = mappingTotal > 0 ? (mappingApproved / mappingTotal) * 100 : 0
  const mappingColor: PhaseColor = mappingPct >= 80 ? 'green' : mappingPct >= 50 ? 'yellow' : 'red'
  const transformColor: PhaseColor =
    totalTransformScope === 0
      ? 'gray'
      : completedTransforms >= totalTransformScope
        ? 'green'
        : completedTransforms > 0
          ? 'yellow'
          : 'red'
  const allPriorPhasesGreen =
    dataIngestion === 'complete' &&
    mappingColor === 'green' &&
    (transformColor === 'green' || transformColor === 'gray') &&
    dataQualityColor === 'green'
  const validationColor: PhaseColor = allPriorPhasesGreen ? 'green' : readinessScore >= 50 ? 'yellow' : 'red'

  const completedCount =
    (dataIngestion === 'complete' ? 1 : 0) +
    (dataQualityColor === 'green' ? 1 : 0) +
    (mappingColor === 'green' ? 1 : 0) +
    (transformColor === 'green' || transformColor === 'gray' ? 1 : 0) +
    (validationColor === 'green' ? 1 : 0)

  const allDecisions: DecisionEntry[] = (activityRows ?? []).map((entry) => ({
    id: entry.id,
    type: entry.category as DecisionType,
    label: entry.description,
    timestamp: entry.created_at,
    user_id: entry.user_id ?? null,
    metadata: entry.metadata as Record<string, unknown>,
  }))

  const existingOutputs: ExistingOutput[] = await Promise.all(
    (outputRows ?? []).map(async (o) => {
      let signedUrl: string | null = null
      if (o.file_storage_path) {
        const { data: signed } = await supabaseAdmin.storage
          .from('project-files')
          .createSignedUrl(o.file_storage_path, 3600)
        signedUrl = signed?.signedUrl ?? null
      }
      const tableName = o.file_storage_path
        ? o.file_storage_path.split('/').pop()?.replace(/_v[\d.]+\.(csv|sql|md|json)$/, '') ?? null
        : null

      let reconstructedFiles: ReconstructedFile[] | undefined
      if (o.format === 'per_table' && o.metadata) {
        const meta = o.metadata as {
          files?: Array<{
            filename?: string
            type?: string
            table_name?: string | null
            load_order?: number | null
            storage_path?: string
          }>
        }
        reconstructedFiles = (meta.files ?? []).map((f) => ({
          filename: f.filename ?? '',
          type: f.type ?? 'table_script',
          tableName: f.table_name ?? null,
          loadOrder: f.load_order ?? null,
          storagePath: f.storage_path ?? '',
        }))
      }

      const { metadata: _stripped, ...safeOutput } = o
      return { ...safeOutput, signedUrl, tableName, reconstructedFiles }
    }),
  )

  return {
    project: { id: project.id, name: project.name },
    sourceDataset,
    targetDataset,
    sourceTableCount: sourceTables.length,
    targetTableCount: targetTables.length,
    totalSourceRows,
    phases: {
      dataIngestion,
      dataQuality: dataQualityColor,
      mapping: mappingColor,
      transformations: transformColor,
      validation: validationColor,
      completedCount,
    },
    metrics: {
      readinessScore,
      readinessStatus,
      readinessComponents: readinessResult.components,
      approvedFieldMappings: mappingApproved,
      totalFieldMappings: mappingTotal,
      openBlocking,
      openWarnings,
      completedTransforms,
      totalTransforms: totalTransformScope,
      stagedTables,
      totalTargetTables,
    },
    decisions: allDecisions,
    totalDecisions: allDecisions.length,
    outstanding: {
      unmappedSourceFields: mappingUnmapped,
      blockingIssues: openBlocking,
      fieldsNeedingTransformWork,
      untestedTransforms,
      testedTransforms,
    },
    existingOutputs,
    hasMappings: tfms.length > 0,
    hasSourceData: sourceTables.length > 0,
    hasTargetData: targetTables.length > 0,
    projectStats,
    mappingFlatCounts,
  }
}
