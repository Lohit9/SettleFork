'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import { buildAIContext, formatDocumentsForPrompt } from '@/lib/ai/context-builder'
import { fieldNeedsTransform, wrapFieldRefsInJsonb } from '@/lib/utils/transform-helpers'
import { buildReadinessDocx } from '@/lib/reports/readiness-report-docx'
import { calculateReadinessScore, type ReadinessComponents } from '@/lib/quality/readiness-formula'
import { computeReadinessScore } from '@/lib/quality/readiness-score'

// ── Shared types ──────────────────────────────────────────────────────────────

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
}

export interface GeneratedFile {
  tableName: string
  sourceTableName: string
  downloadUrl: string
  rowCount: number
  version: string
  outputId: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCSV(headers: string[], rows: Record<string, unknown>[]): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return ''
    const str = String(val)
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"'
    }
    return str
  }
  return [headers.map(escape).join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n')
}

function escapeSqlValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL'
  const str = String(val)
  return "'" + str.replace(/'/g, "''") + "'"
}

function nextVersion(current: string): string {
  const parts = current.split('.')
  const minor = parseInt(parts[1] ?? '0', 10)
  return `${parts[0]}.${minor + 1}`
}

async function getNextVersion(projectId: string, type: string, format: string): Promise<string> {
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

async function uploadAndRecord(params: {
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

// ── getOutputsPageData ────────────────────────────────────────────────────────

export async function getOutputsPageData(projectId: string): Promise<OutputsPageData> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      project: { id: projectId, name: 'Unknown' },
      sourceDataset: null,
      targetDataset: null,
      sourceTableCount: 0,
      targetTableCount: 0,
      totalSourceRows: 0,
      phases: { dataIngestion: 'incomplete', dataQuality: 'gray', mapping: 'red', transformations: 'gray', validation: 'red', completedCount: 0 },
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
      outstanding: { unmappedSourceFields: 0, blockingIssues: 0, fieldsNeedingTransformWork: 0, untestedTransforms: 0, testedTransforms: 0 },
      existingOutputs: [],
      hasMappings: false,
      hasSourceData: false,
      hasTargetData: false,
    }
  }

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .single()
  if (!project) throw new Error('Project not found')

  // Round 2: everything that only needs projectId — all parallel
  const [
    { data: datasets },
    { data: rawTableMappings },
    { data: qualityIssueRows },
    { data: fixHistoryRows },
    { data: validationRuleRows },
    { data: outputRows },
    { data: activityRows },
    { data: acknowledgmentRows },
  ] = await Promise.all([
    supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId),
    supabaseAdmin.from('table_mappings').select('id, status').eq('project_id', projectId).neq('status', 'rejected'),
    supabaseAdmin.from('quality_issues').select('id, severity, status, title, description, field_id, stage, issue_kind, created_at').eq('project_id', projectId),
    supabaseAdmin.from('fix_history').select('id, fix_description, affected_row_count, applied_at').eq('project_id', projectId).eq('status', 'applied').order('applied_at', { ascending: false }).limit(20),
    supabaseAdmin.from('validation_rules').select('id, name, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(10),
    supabaseAdmin.from('outputs').select('*').eq('project_id', projectId).order('generated_at', { ascending: false }),
    supabaseAdmin.from('activity_log').select('id, action_type, description, category, metadata, created_at').eq('project_id', projectId).order('created_at', { ascending: false }).limit(200),
    supabaseAdmin.from('field_acknowledgments').select('field_id').eq('project_id', projectId),
  ])

  const sourceDataset = datasets?.find((d) => d.role === 'source') ?? null
  const targetDataset = datasets?.find((d) => d.role === 'target') ?? null
  const allDatasetIds = datasets?.map((d) => d.id) ?? []

  // tables needs dataset IDs from round 2 above
  const { data: allTables } = await supabaseAdmin
    .from('tables')
    .select('id, dataset_id, name, row_count')
    .in('dataset_id', allDatasetIds.length ? allDatasetIds : ['__none__'])

  const sourceTables = (allTables ?? []).filter((t) => t.dataset_id === sourceDataset?.id)
  const targetTables = (allTables ?? []).filter((t) => t.dataset_id === targetDataset?.id)
  const sourceTableIds = sourceTables.map((t) => t.id)
  const targetTableIds = targetTables.map((t) => t.id)
  const nonRejectedTMIds = (rawTableMappings ?? []).map((tm) => tm.id)
  const totalSourceRows = sourceTables.reduce((sum, t) => sum + (t.row_count ?? 0), 0)

  // Round 3: Fields + field mappings
  const [{ data: sourceFieldRows }, { data: targetFieldRows }, { data: rawFieldMappings }] =
    await Promise.all([
      supabaseAdmin.from('fields').select('id, name, data_type, is_nullable').in('table_id', sourceTableIds),
      supabaseAdmin.from('fields').select('id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, table_id, default_value').in('table_id', targetTableIds),
      nonRejectedTMIds.length > 0
        ? supabaseAdmin
            .from('field_mappings')
            .select('id, status, source_field_id, target_field_id, confidence, created_at, is_contributing, needs_transformation, type_compatibility')
            .in('table_mapping_id', nonRejectedTMIds)
            .neq('status', 'rejected')
        : Promise.resolve({ data: [] }),
    ])

  const allFMIds = (rawFieldMappings ?? []).map((fm) => fm.id)
  const approvedFMs = (rawFieldMappings ?? []).filter((fm) => fm.status === 'approved')

  // Round 4: Transforms
  const { data: transformRows } = await (allFMIds.length > 0
    ? supabaseAdmin.from('transformations').select('id, field_mapping_id, status, description, created_at').in('field_mapping_id', allFMIds)
    : Promise.resolve({ data: [] }))

  // ── Metrics ───────────────────────────────────────────────────────────────

  // totalSourceFields is retained purely as the denominator for the readiness
  // score's blocking/warning penalty scaling (see computeReadinessScore). It
  // is NOT the Mapping Coverage denominator.
  const totalSourceFields = (sourceFieldRows ?? []).length

  // ── Mapping Coverage: mirror MappingContent.tsx headerStats exactly ──
  // Each primary (non-contributing, non-rejected) field_mapping is 1 visual
  // review row. Each unmapped (and not acknowledged) source/target field adds
  // 1 row. Acknowledged fields count as "approved" and are added to both
  // total and approved.
  const primaryFMs = (rawFieldMappings ?? []).filter(
    (fm) => !(fm as { is_contributing?: boolean }).is_contributing && fm.status !== 'rejected'
  )
  const approvedPrimaryFMs = primaryFMs.filter((fm) => fm.status === 'approved')

  // Source field IDs covered by a primary OR contributing row (contributors
  // are folded into the primary's visual row, so their source field is
  // "handled" and must not show up in Unmapped).
  const mappedSourceIds = new Set<string>(
    primaryFMs.filter((fm) => fm.source_field_id).map((fm) => fm.source_field_id as string)
  )
  for (const fm of rawFieldMappings ?? []) {
    const isContributing = (fm as { is_contributing?: boolean }).is_contributing
    if (isContributing && fm.status !== 'rejected' && fm.source_field_id) {
      mappedSourceIds.add(fm.source_field_id)
    }
  }
  const primaryMappedTargetIds = new Set(primaryFMs.map((fm) => fm.target_field_id))

  const acknowledgedIds = new Set(
    (acknowledgmentRows ?? []).map((a) => a.field_id)
  )

  let unmappedSourceCount = 0
  let unmappedTargetCount = 0
  let acknowledgedCount = 0

  for (const f of sourceFieldRows ?? []) {
    if (!mappedSourceIds.has(f.id)) {
      if (acknowledgedIds.has(f.id)) acknowledgedCount++
      else unmappedSourceCount++
    }
  }
  for (const f of targetFieldRows ?? []) {
    if (!primaryMappedTargetIds.has(f.id)) {
      if (acknowledgedIds.has(f.id)) acknowledgedCount++
      else unmappedTargetCount++
    }
  }

  const mappingTotal =
    primaryFMs.length + unmappedSourceCount + unmappedTargetCount + acknowledgedCount
  const mappingApproved = approvedPrimaryFMs.length + acknowledgedCount
  const mappingUnmapped = unmappedSourceCount + unmappedTargetCount

  const allTransforms = transformRows ?? []
  const fmIdsWithTransforms = new Set(allTransforms.map((t) => t.field_mapping_id))
  const transformByFmId = new Map(allTransforms.map((t) => [t.field_mapping_id, t]))

  // Build field lookup maps for the fieldNeedsTransform heuristic (matches Transform sidebar logic)
  const sourceFieldById = new Map((sourceFieldRows ?? []).map((f) => [f.id, f]))
  const targetFieldById = new Map((targetFieldRows ?? []).map((f) => [f.id, f]))

  // Score every primary (non-contributing) field mapping using the same heuristic as the Transform
  // sidebar so the Migration Center denominator stays in sync with the sidebar badge count.
  const scoredFieldMappings = (rawFieldMappings ?? [])
    .filter((fm) => !(fm as typeof fm & { is_contributing?: boolean }).is_contributing)
    .map((fm) => {
      const isValueAssignment = !fm.source_field_id
      const srcField = fm.source_field_id ? sourceFieldById.get(fm.source_field_id) : null
      const tgtField = fm.target_field_id ? targetFieldById.get(fm.target_field_id) : null
      const hasTransformation = fmIdsWithTransforms.has(fm.id)
      const fmTyped = fm as typeof fm & { needs_transformation?: boolean | null; type_compatibility?: string | null }

      const needsTransform = isValueAssignment ? true : fieldNeedsTransform({
        typeCompatibility: fmTyped.type_compatibility ?? '',
        confidence: fm.confidence ?? 0,
        sourceDataType: (srcField as { data_type?: string } | null)?.data_type ?? '',
        targetDataType: (tgtField as { data_type?: string } | null)?.data_type ?? '',
        sourceFieldName: (srcField as { name?: string } | null)?.name ?? '',
        targetFieldName: (tgtField as { name?: string } | null)?.name ?? '',
        hasTransformation,
        needsTransformation: fmTyped.needs_transformation ?? null,
      })

      return { id: fm.id, needsTransform, hasTransformation }
    })

  // DENOMINATOR: all primary field mappings where needsTransform is true
  const fieldsInScope = scoredFieldMappings.filter((fm) => fm.needsTransform)
  const totalTransformScope = fieldsInScope.length

  // Compute resolved source field IDs (mirrors getResolvedSourceFieldIds logic).
  // A source field is "resolved by transform" when its approved primary mapping
  // either has needs_transformation=false OR has at least one transform record.
  const resolvedSourceFieldIds = new Set<string>()
  for (const fm of approvedPrimaryFMs) {
    const sfId = (fm as { source_field_id?: string | null }).source_field_id
    if (!sfId) continue
    const hasTransform = fmIdsWithTransforms.has(fm.id)
    const noTransformNeeded = (fm as { needs_transformation?: boolean | null }).needs_transformation === false
    if (hasTransform || noTransformNeeded) resolvedSourceFieldIds.add(sfId)
  }

  // Helper matching the isNeverResolvable check in DataQualityContent
  function isNeverResolvable(q: { issue_kind?: string | null; description?: string | null; title?: string | null }): boolean {
    const desc = (q.description ?? '').toLowerCase()
    const title = (q.title ?? '').toLowerCase()
    if (q.issue_kind === 'null_primary_key') return true
    if (q.issue_kind === 'orphaned_fk') return true
    if (q.issue_kind === 'referential_integrity') return true
    if (desc.includes('null') && (desc.includes('primary key') || desc.includes('primary_key'))) return true
    if (desc.includes('orphan') || title.includes('orphan')) return true
    if (desc.includes('referential') || title.includes('referential')) return true
    return false
  }

  const openIssues = (qualityIssueRows ?? []).filter(
    (q) => q.status === 'open' && q.stage === 'in_flight'
  )
  const openBlocking = openIssues.filter((q) => {
    if (q.severity !== 'blocking') return false
    // Source issues that are resolved by transform don't count as blocking
    if (
      q.stage === 'source' &&
      !isNeverResolvable(q) &&
      q.field_id &&
      resolvedSourceFieldIds.has(q.field_id)
    ) return false
    return true
  }).length
  const openWarnings = openIssues.filter((q) => {
    if (q.severity !== 'warning') return false
    // Source warnings resolved by transform don't count
    if (
      q.stage === 'source' &&
      !isNeverResolvable(q) &&
      q.field_id &&
      resolvedSourceFieldIds.has(q.field_id)
    ) return false
    return true
  }).length
  // NUMERATOR: in-scope fields whose transform is fully applied to staged data
  const completedTransforms = fieldsInScope.filter((fm) => transformByFmId.get(fm.id)?.status === 'applied').length
  // OUTSTANDING 1: in-scope fields with no transform record at all (orange "Transform" badge)
  const fieldsNeedingTransformWork = fieldsInScope.filter((fm) => !fm.hasTransformation).length
  // OUTSTANDING 2: in-scope fields with a draft transform (SQL saved but not tested)
  const draftTransforms = fieldsInScope.filter((fm) => transformByFmId.get(fm.id)?.status === 'draft').length
  // OUTSTANDING 3: in-scope fields with a tested transform not yet applied
  const testedTransforms = fieldsInScope.filter((fm) => transformByFmId.get(fm.id)?.status === 'tested').length
  // untestedTransforms kept for backward compat (alias for draft bucket)
  const untestedTransforms = draftTransforms

  // Staging coverage — count target tables (via non-rejected table mappings)
  // that have at least one row in staged_data_rows. Parallelized head-count
  // queries avoid pulling row payloads.
  const stagingCountResults = nonRejectedTMIds.length > 0
    ? await Promise.all(
        nonRejectedTMIds.map((tmId) =>
          supabaseAdmin
            .from('staged_data_rows')
            .select('id', { count: 'exact', head: true })
            .eq('table_mapping_id', tmId)
        )
      )
    : []
  const stagedTables = stagingCountResults.filter((r) => (r.count ?? 0) > 0).length
  const totalTargetTables = targetTables.length

  // Readiness score — single source of truth is `calculateReadinessScore`
  // (lib/quality/readiness-formula.ts). computeReadinessScore, the migration
  // runbook, and the readiness report all call the same helper with the same
  // inputs so every surface shows the same number.
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

  // ── Phase statuses ────────────────────────────────────────────────────────

  const dataIngestion = sourceTables.length > 0 && targetTables.length > 0 ? 'complete' : ('incomplete' as const)
  const dataQualityColor: PhaseColor = openBlocking === 0 ? 'green' : openBlocking < 5 ? 'yellow' : 'red'
  const mappingPct = mappingTotal > 0 ? (mappingApproved / mappingTotal) * 100 : 0
  const mappingColor: PhaseColor = mappingPct >= 80 ? 'green' : mappingPct >= 50 ? 'yellow' : 'red'
  const transformColor: PhaseColor =
    totalTransformScope === 0 ? 'gray' : completedTransforms >= totalTransformScope ? 'green' : completedTransforms > 0 ? 'yellow' : 'red'
  // Ready is green only when ALL 4 prior phases are green — a high readiness score
  // alone is not sufficient if Validate still has blocking issues or transforms are pending.
  const allPriorPhasesGreen =
    dataIngestion === 'complete' &&
    mappingColor === 'green' &&
    (transformColor === 'green' || transformColor === 'gray') &&
    dataQualityColor === 'green'
  const validationColor: PhaseColor = allPriorPhasesGreen
    ? 'green'
    : readinessScore >= 50
    ? 'yellow'
    : 'red'

  const completedCount =
    (dataIngestion === 'complete' ? 1 : 0) +
    (dataQualityColor === 'green' ? 1 : 0) +
    (mappingColor === 'green' ? 1 : 0) +
    (transformColor === 'green' || transformColor === 'gray' ? 1 : 0) +
    (validationColor === 'green' ? 1 : 0)

  // ── Decisions log — fetched in round 2 parallel batch above ─────────────────

  const allDecisions: DecisionEntry[] = (activityRows ?? []).map((entry) => ({
    id: entry.id,
    type: entry.category as DecisionType,
    label: entry.description,
    timestamp: entry.created_at,
    metadata: entry.metadata as Record<string, unknown>,
  }))

  // ── Existing outputs with signed URLs ─────────────────────────────────────

  const existingOutputs: ExistingOutput[] = await Promise.all(
    (outputRows ?? []).map(async (o) => {
      let signedUrl: string | null = null
      if (o.file_storage_path) {
        const { data: signed } = await supabaseAdmin.storage
          .from('project-files')
          .createSignedUrl(o.file_storage_path, 3600)
        signedUrl = signed?.signedUrl ?? null
      }
      // Extract table name from path for gold standard files
      const tableName = o.file_storage_path
        ? o.file_storage_path.split('/').pop()?.replace(/_v[\d.]+\.(csv|sql|md|json)$/, '') ?? null
        : null

      // For per-table outputs, reconstruct a clean file manifest from metadata
      // so we never pass raw JSONB through RSC serialization.
      let reconstructedFiles: ReconstructedFile[] | undefined
      if (o.format === 'per_table' && o.metadata) {
        const meta = o.metadata as { files?: Array<{ filename?: string; type?: string; table_name?: string | null; load_order?: number | null; storage_path?: string }> }
        reconstructedFiles = (meta.files ?? []).map((f) => ({
          filename: f.filename ?? '',
          type: f.type ?? 'table_script',
          tableName: f.table_name ?? null,
          loadOrder: f.load_order ?? null,
          storagePath: f.storage_path ?? '',
        }))
      }

      // Strip metadata from the output — only pass clean, flat data to the client
      const { metadata: _stripped, ...safeOutput } = o
      return { ...safeOutput, signedUrl, tableName, reconstructedFiles }
    })
  )

  return {
    project: { id: project.id, name: project.name },
    sourceDataset,
    targetDataset,
    sourceTableCount: sourceTables.length,
    targetTableCount: targetTables.length,
    totalSourceRows,
    phases: { dataIngestion, dataQuality: dataQualityColor, mapping: mappingColor, transformations: transformColor, validation: validationColor, completedCount },
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
    outstanding: { unmappedSourceFields: mappingUnmapped, blockingIssues: openBlocking, fieldsNeedingTransformWork, untestedTransforms, testedTransforms },
    existingOutputs,
    hasMappings: rawFieldMappings !== null && (rawFieldMappings ?? []).length > 0,
    hasSourceData: sourceTables.length > 0,
    hasTargetData: targetTables.length > 0,
  }
}

// ── generateGoldStandardCSVs ──────────────────────────────────────────────────

export async function generateGoldStandardCSVs(projectId: string): Promise<{
  success: boolean
  files: GeneratedFile[]
  errors?: string[]
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, files: [], error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, files: [], error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single()
  if (!project) return { success: false, files: [], error: 'Access denied' }

  // Get approved table mappings with source/target table info
  const { data: approvedTMs } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .eq('status', 'approved')

  if (!approvedTMs || approvedTMs.length === 0) {
    return { success: false, files: [], error: 'No approved table mappings found. Approve mappings before generating Gold Standard files.' }
  }

  // Get table names
  const allTableIds = [...new Set([...approvedTMs.map((tm) => tm.source_table_id), ...approvedTMs.map((tm) => tm.target_table_id)])]
  const { data: tableRows } = await supabaseAdmin.from('tables').select('id, name').in('id', allTableIds)
  const tableNameById = new Map((tableRows ?? []).map((t) => [t.id, t.name]))

  const files: GeneratedFile[] = []
  const errors: string[] = []

  for (const tm of approvedTMs) {
    const sourceTableName = tableNameById.get(tm.source_table_id) ?? 'unknown'
    const targetTableName = tableNameById.get(tm.target_table_id) ?? 'unknown'

    try {
      // ── Fast path: use staged_data_rows when available ─────────────────────
      const { data: stagedSample } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data')
        .eq('table_mapping_id', tm.id)
        .limit(1)

      const hasStagedData = (stagedSample ?? []).length > 0

      let rows: Record<string, unknown>[]
      let targetFieldNames: string[]

      if (hasStagedData) {
        // Read all rows from staged_data_rows — guaranteed to match validated data
        const { data: stagedRows, error: stagedErr } = await supabaseAdmin
          .from('staged_data_rows')
          .select('transformed_row_data')
          .eq('table_mapping_id', tm.id)
          .order('row_number')

        if (stagedErr) { errors.push(`${targetTableName}: ${stagedErr.message}`); continue }

        rows = (stagedRows ?? []).map((r) => r.transformed_row_data as Record<string, unknown>)
        targetFieldNames = rows.length > 0 ? Object.keys(rows[0]) : []
      } else {
        // ── Fallback: build transformation query on the fly ──────────────────
        const { data: approvedFMs } = await supabaseAdmin
          .from('field_mappings')
          .select('id, source_field_id, target_field_id')
          .eq('table_mapping_id', tm.id)
          .eq('status', 'approved')

        if (!approvedFMs || approvedFMs.length === 0) continue

        const srcFieldIds = approvedFMs.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)
        const tgtFieldIds = approvedFMs.map((fm) => fm.target_field_id)
        const fmIds = approvedFMs.map((fm) => fm.id)

        const [{ data: srcFields }, { data: tgtFields }, { data: allSrcFields }, { data: transforms }] = await Promise.all([
          srcFieldIds.length > 0 ? supabaseAdmin.from('fields').select('id, name').in('id', srcFieldIds) : Promise.resolve({ data: [] }),
          supabaseAdmin.from('fields').select('id, name').in('id', tgtFieldIds),
          supabaseAdmin.from('fields').select('name').eq('table_id', tm.source_table_id),
          supabaseAdmin.from('transformations').select('field_mapping_id, generated_sql').in('field_mapping_id', fmIds),
        ])

        const srcById = new Map((srcFields ?? []).map((f) => [f.id, f]))
        const tgtById = new Map((tgtFields ?? []).map((f) => [f.id, f]))
        const allSrcFieldNames = (allSrcFields ?? []).map((f) => f.name)
        const transformByFMId = new Map((transforms ?? []).map((t) => [t.field_mapping_id, t.generated_sql]))

        const columns: string[] = []
        targetFieldNames = []

        for (const fm of approvedFMs) {
          const srcField = fm.source_field_id ? srcById.get(fm.source_field_id) : null
          const tgtField = tgtById.get(fm.target_field_id)
          if (!tgtField) continue

          const tgtAlias = `"${tgtField.name.replace(/"/g, '""')}"`
          const transformSql = transformByFMId.get(fm.id)

          if (!srcField && !transformSql) continue

          targetFieldNames.push(tgtField.name)

          if (transformSql) {
            const wrapped = wrapFieldRefsInJsonb(transformSql.replace(/;+$/, '').trim(), allSrcFieldNames)
            columns.push(`${wrapped} AS ${tgtAlias}`)
          } else {
            const escaped = srcField!.name.replace(/'/g, "''")
            columns.push(`row_data->>'${escaped}' AS ${tgtAlias}`)
          }
        }

        if (columns.length === 0) continue

        const sql = `SELECT ${columns.join(', ')} FROM data_rows WHERE table_id = '${tm.source_table_id}' ORDER BY row_number`
        const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('execute_gold_standard_query', { p_sql: sql })
        if (rpcErr) { errors.push(`${targetTableName}: ${rpcErr.message}`); continue }
        rows = (rpcResult as Record<string, unknown>[]) ?? []
      }

      if (targetFieldNames.length === 0) continue

      const csvContent = buildCSV(targetFieldNames, rows)
      const version = await getNextVersion(projectId, 'gold_standard_csv', 'csv')
      const storagePath = `outputs/gold_standard/${targetTableName}_v${version}.csv`

      const { signedUrl, outputId } = await uploadAndRecord({
        projectId,
        userId: user.id,
        content: csvContent,
        storagePath,
        contentType: 'text/csv',
        outputType: 'gold_standard_csv',
        format: 'csv',
        version,
      })

      files.push({ tableName: targetTableName, sourceTableName, downloadUrl: signedUrl, rowCount: rows.length, version, outputId })
    } catch (err) {
      errors.push(`${targetTableName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { success: files.length > 0 || errors.length === 0, files, errors: errors.length > 0 ? errors : undefined }
}

// ── generateSQLLoadScripts ────────────────────────────────────────────────────

export async function generateSQLLoadScripts(projectId: string): Promise<{
  success: boolean
  files: GeneratedFile[]
  errors?: string[]
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, files: [], error: 'Not authenticated' }

  const { checkProjectPermission: checkPerm } = await import('@/lib/actions/role-resolution')
  if (!(await checkPerm(projectId, 'editor'))) {
    return { success: false, files: [], error: 'Insufficient permissions' }
  }

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single()
  if (!project) return { success: false, files: [], error: 'Access denied' }

  const { data: approvedTMs } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .eq('status', 'approved')

  if (!approvedTMs || approvedTMs.length === 0) {
    return { success: false, files: [], error: 'No approved table mappings found.' }
  }

  const allTableIds = [...new Set([...approvedTMs.map((tm) => tm.source_table_id), ...approvedTMs.map((tm) => tm.target_table_id)])]
  const { data: tableRows } = await supabaseAdmin.from('tables').select('id, name').in('id', allTableIds)
  const tableNameById = new Map((tableRows ?? []).map((t) => [t.id, t.name]))

  const { data: datasets } = await supabaseAdmin.from('datasets').select('id, name, role').eq('project_id', projectId)
  const srcDatasetName = datasets?.find((d) => d.role === 'source')?.name ?? 'SOURCE'

  const files: GeneratedFile[] = []
  const errors: string[] = []

  for (const tm of approvedTMs) {
    const sourceTableName = tableNameById.get(tm.source_table_id) ?? 'unknown'
    const targetTableName = tableNameById.get(tm.target_table_id) ?? 'unknown'

    try {
      // ── Fast path: use staged_data_rows when available ───────────────────
      const { data: stagedSampleSQL } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data')
        .eq('table_mapping_id', tm.id)
        .limit(1)

      const hasStagedDataSQL = (stagedSampleSQL ?? []).length > 0

      let rows: Record<string, unknown>[]
      let targetFieldNames: string[]

      if (hasStagedDataSQL) {
        const { data: stagedRows, error: stagedErr } = await supabaseAdmin
          .from('staged_data_rows')
          .select('transformed_row_data')
          .eq('table_mapping_id', tm.id)
          .order('row_number')

        if (stagedErr) { errors.push(`${targetTableName}: ${stagedErr.message}`); continue }
        rows = (stagedRows ?? []).map((r) => r.transformed_row_data as Record<string, unknown>)
        targetFieldNames = rows.length > 0 ? Object.keys(rows[0]) : []
      } else {
        // ── Fallback: build transformation query on the fly ─────────────────
        const { data: approvedFMs } = await supabaseAdmin
          .from('field_mappings')
          .select('id, source_field_id, target_field_id')
          .eq('table_mapping_id', tm.id)
          .eq('status', 'approved')

        if (!approvedFMs || approvedFMs.length === 0) continue

        const srcFieldIds = approvedFMs.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)
        const tgtFieldIds = approvedFMs.map((fm) => fm.target_field_id)
        const fmIds = approvedFMs.map((fm) => fm.id)

        const [{ data: srcFields }, { data: tgtFields }, { data: allSrcFields }, { data: transforms }] = await Promise.all([
          srcFieldIds.length > 0 ? supabaseAdmin.from('fields').select('id, name').in('id', srcFieldIds) : Promise.resolve({ data: [] }),
          supabaseAdmin.from('fields').select('id, name').in('id', tgtFieldIds),
          supabaseAdmin.from('fields').select('name').eq('table_id', tm.source_table_id),
          supabaseAdmin.from('transformations').select('field_mapping_id, generated_sql').in('field_mapping_id', fmIds),
        ])

        const srcById = new Map((srcFields ?? []).map((f) => [f.id, f]))
        const tgtById = new Map((tgtFields ?? []).map((f) => [f.id, f]))
        const allSrcFieldNames = (allSrcFields ?? []).map((f) => f.name)
        const transformByFMId = new Map((transforms ?? []).map((t) => [t.field_mapping_id, t.generated_sql]))

        const columns: string[] = []
        targetFieldNames = []

        for (const fm of approvedFMs) {
          const srcField = fm.source_field_id ? srcById.get(fm.source_field_id) : null
          const tgtField = tgtById.get(fm.target_field_id)
          if (!tgtField) continue
          const tgtAlias = `"${tgtField.name.replace(/"/g, '""')}"`
          const transformSql = transformByFMId.get(fm.id)
          if (!srcField && !transformSql) continue
          targetFieldNames.push(tgtField.name)
          if (transformSql) {
            const wrapped = wrapFieldRefsInJsonb(transformSql.replace(/;+$/, '').trim(), allSrcFieldNames)
            columns.push(`${wrapped} AS ${tgtAlias}`)
          } else {
            const escaped = srcField!.name.replace(/'/g, "''")
            columns.push(`row_data->>'${escaped}' AS ${tgtAlias}`)
          }
        }

        if (columns.length === 0) continue

        const sql = `SELECT ${columns.join(', ')} FROM data_rows WHERE table_id = '${tm.source_table_id}' ORDER BY row_number`
        const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc('execute_gold_standard_query', { p_sql: sql })
        if (rpcErr) { errors.push(`${targetTableName}: ${rpcErr.message}`); continue }
        rows = (rpcResult as Record<string, unknown>[]) ?? []
      }

      if (targetFieldNames.length === 0) continue
      const now = new Date().toUTCString()
      const colList = targetFieldNames.map((n) => `"${n.replace(/"/g, '""')}"`).join(', ')

      // Build INSERT statements in chunks of 500 rows
      const CHUNK = 500
      const sqlLines: string[] = [
        `-- Generated by Settle`,
        `-- Target table: ${targetTableName}`,
        `-- Source: ${srcDatasetName}.${sourceTableName}`,
        `-- Generated: ${now}`,
        `-- Rows: ${rows.toLocaleString()}`,
        '',
      ]

      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK)
        const valueRows = chunk.map((row) => `(${targetFieldNames.map((h) => escapeSqlValue(row[h])).join(', ')})`).join(',\n')
        sqlLines.push(`INSERT INTO "${targetTableName}" (${colList}) VALUES`)
        sqlLines.push(valueRows + ';')
        sqlLines.push('')
      }

      const sqlContent = sqlLines.join('\n')
      const version = await getNextVersion(projectId, 'gold_standard_sql', 'sql')
      const storagePath = `outputs/gold_standard/${targetTableName}_v${version}.sql`

      const { signedUrl, outputId } = await uploadAndRecord({
        projectId,
        userId: user.id,
        content: sqlContent,
        storagePath,
        contentType: 'application/sql',
        outputType: 'gold_standard_sql',
        format: 'sql',
        version,
      })

      files.push({ tableName: targetTableName, sourceTableName, downloadUrl: signedUrl, rowCount: rows.length, version, outputId })
    } catch (err) {
      errors.push(`${targetTableName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { success: files.length > 0 || errors.length === 0, files, errors: errors.length > 0 ? errors : undefined }
}

// ── generateReadinessReport ───────────────────────────────────────────────────

const REPORT_SYSTEM_PROMPT = `You are a senior data migration consultant. Generate a comprehensive Migration Readiness Report in clean Markdown format. Use ## for section headers, **bold** for key terms, and tables where appropriate. Be direct, precise, and actionable. Reference specific table and field names from the data provided.

If documentation is provided (business rules, data dictionaries, schema docs), reference it when assessing readiness. Flag any areas where the current data state does not meet the documented requirements, and include relevant business rule references in the Risk Register.

Structure the report exactly as follows:
## Go/No-Go Recommendation
## Executive Summary
## Migration Scope
## Readiness Score Analysis
## Mapping Coverage
## Data Quality Assessment
## Transformation Summary
## Risk Register
## Fix History & Audit Trail
## Recommended Next Steps`

export async function generateReadinessReport(
  projectId: string,
  format: 'pdf' | 'docx' | 'markdown'
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: checkPerm } = await import('@/lib/actions/role-resolution')
  if (!(await checkPerm(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  const rateLimit = checkAIRateLimit(user.id)
  if (!rateLimit.allowed) return { success: false, error: rateLimit.error }

  const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  if (!project) return { success: false, error: 'Access denied' }

  // Gather all context for the report
  const { data: datasets } = await supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId)
  const srcDs = datasets?.find((d) => d.role === 'source')
  const tgtDs = datasets?.find((d) => d.role === 'target')
  const datasetIds = (datasets ?? []).map((d) => d.id)

  const [
    { data: allTables },
    { data: qualityIssues },
    { data: fixHistory },
    { data: validationRules },
  ] = await Promise.all([
    supabaseAdmin.from('tables').select('id, dataset_id, name, row_count').in('dataset_id', datasetIds),
    supabaseAdmin.from('quality_issues').select('title, severity, description, affected_records, status, stage, created_at').eq('project_id', projectId),
    supabaseAdmin.from('fix_history').select('fix_description, affected_row_count, applied_at, status').eq('project_id', projectId).order('applied_at', { ascending: false }).limit(50),
    supabaseAdmin.from('validation_rules').select('name, description, rule_type, severity').eq('project_id', projectId),
  ])

  const srcTables = (allTables ?? []).filter((t) => t.dataset_id === srcDs?.id)
  const tgtTables = (allTables ?? []).filter((t) => t.dataset_id === tgtDs?.id)
  const srcTableIds = srcTables.map((t) => t.id)

  const { data: tableMappings } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id, status, confidence')
    .eq('project_id', projectId)

  const nonRejectedTMIds = (tableMappings ?? []).filter((tm) => tm.status !== 'rejected').map((tm) => tm.id)

  const [{ data: fieldMappings }, { data: srcFields }] = await Promise.all([
    nonRejectedTMIds.length > 0
      ? supabaseAdmin.from('field_mappings').select('id, status, confidence, source_field_id, is_contributing').in('table_mapping_id', nonRejectedTMIds)
      : Promise.resolve({ data: [] }),
    srcTableIds.length > 0
      ? supabaseAdmin.from('fields').select('id').in('table_id', srcTableIds)
      : Promise.resolve({ data: [] }),
  ])

  const allFMIds = (fieldMappings ?? []).map((fm) => fm.id)
  const approvedFMs = (fieldMappings ?? []).filter((fm) => fm.status === 'approved')
  const { data: transforms } =
    allFMIds.length > 0
      ? await supabaseAdmin.from('transformations').select('field_mapping_id, status, description, generated_sql').in('field_mapping_id', allFMIds)
      : { data: [] }

  const totalSourceFields = (srcFields ?? []).length
  const avgConfidence = approvedFMs.length > 0
    ? Math.round(approvedFMs.reduce((s, fm) => s + (fm.confidence ?? 0), 0) / approvedFMs.length)
    : 0
  const openBlocking = (qualityIssues ?? []).filter((q) => q.severity === 'blocking' && q.status === 'open').length
  const openWarnings = (qualityIssues ?? []).filter((q) => q.severity === 'warning' && q.status === 'open').length
  const savedTransforms = (transforms ?? []).filter((t) => t.status === 'saved').length
  const totalSourceRows = srcTables.reduce((s, t) => s + (t.row_count ?? 0), 0)

  // Use the shared readiness helper so this report's score always matches the
  // Migration Center card and the Validate page. Note: the open-issue counts
  // above describe the full backlog for the Claude prompt; they intentionally
  // are not the same filter as the score (which is in-flight only).
  const readiness = await computeReadinessScore(projectId)
  const readinessScore = readiness.score
  const readinessLabel =
    readiness.status === 'ready'
      ? 'Ready'
      : readiness.status === 'at_risk'
      ? 'Ready with Conditions'
      : 'Not Ready'

  const openIssuesDetail = (qualityIssues ?? [])
    .filter((q) => q.status === 'open')
    .slice(0, 20)
    .map((q) => `- [${q.severity.toUpperCase()}] ${q.title}: ${q.description} (${q.affected_records} records affected)`)
    .join('\n')

  const acceptedRisksDetail = (qualityIssues ?? [])
    .filter((q) => q.status === 'accepted_risk')
    .slice(0, 10)
    .map((q) => `- ${q.title}: ${q.description}`)
    .join('\n')

  const savedTransformDetail = (transforms ?? [])
    .filter((t) => t.status === 'saved')
    .slice(0, 15)
    .map((t) => `- ${t.description ?? 'Transform'}: \`${(t.generated_sql ?? '').slice(0, 80)}${t.generated_sql && t.generated_sql.length > 80 ? '...' : ''}\``)
    .join('\n')

  const fixHistoryDetail = (fixHistory ?? [])
    .slice(0, 20)
    .map((fh) => `- ${new Date(fh.applied_at).toLocaleDateString()}: ${fh.fix_description} (${fh.affected_row_count} rows, status: ${fh.status})`)
    .join('\n')

  const reportCtx = await buildAIContext(projectId, {
    includeProfilingStats: false,
    includeValueDistributions: false,
    includeSampleValues: false,
    includeDocuments: true,
  })
  const reportDocBlock = formatDocumentsForPrompt(reportCtx.documents)

  const userMessage = `<project>
Name: ${project.name}
Source: ${srcDs?.name ?? 'Unknown'} (${srcTables.length} tables, ${totalSourceRows.toLocaleString()} rows)
Target: ${tgtDs?.name ?? 'Unknown'} (${tgtTables.length} tables)
</project>

<readiness>
Score: ${readinessScore}%
Status: ${readinessLabel}
</readiness>

<mapping_summary>
Total source fields: ${totalSourceFields}
Approved field mappings: ${new Set(approvedFMs.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)).size} source fields → ${new Set(approvedFMs.filter((fm) => !(fm as { is_contributing?: boolean }).is_contributing).map((fm) => (fm as { target_field_id?: string }).target_field_id)).size} target fields (${totalSourceFields > 0 ? Math.round((new Set(approvedFMs.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)).size / totalSourceFields) * 100) : 0}% source coverage)
Value assignments (no source field): ${approvedFMs.filter((fm) => fm.source_field_id === null).length}
Unmapped source fields: ${totalSourceFields - new Set(approvedFMs.map((fm) => fm.source_field_id).filter((id): id is string => id !== null)).size}
Approved table mappings: ${(tableMappings ?? []).filter((tm) => tm.status === 'approved').length}
Rejected mappings: ${(fieldMappings ?? []).filter((fm) => fm.status === 'rejected').length}
Average confidence: ${avgConfidence}%
</mapping_summary>

<quality_summary>
Open blocking issues: ${openBlocking}
Open warnings: ${openWarnings}
Fixed issues: ${(qualityIssues ?? []).filter((q) => q.status === 'fixed').length}
Accepted risks: ${(qualityIssues ?? []).filter((q) => q.status === 'accepted_risk').length}
Active validation rules: ${(validationRules ?? []).length}
</quality_summary>

<quality_issues_detail>
${openIssuesDetail || 'No open issues.'}
</quality_issues_detail>

<accepted_risks>
${acceptedRisksDetail || 'No accepted risks.'}
</accepted_risks>

<transformations>
Total transforms: ${(transforms ?? []).length}
Saved: ${savedTransforms}
Tested: ${(transforms ?? []).filter((t) => t.status === 'tested').length}
Draft: ${(transforms ?? []).filter((t) => t.status === 'draft').length}
${savedTransformDetail || 'No saved transforms.'}
</transformations>

<fix_history>
${fixHistoryDetail || 'No fixes applied.'}
</fix_history>
${reportDocBlock}
Generate the full Migration Readiness Report now.`

  let reportText: string
  try {
    reportText = await callClaude(REPORT_SYSTEM_PROMPT, userMessage, 6000)
  } catch {
    return { success: false, error: 'AI report generation failed. Please try again.' }
  }

  const now = new Date().toUTCString()

  // Build the Word document from Claude's Markdown output
  let docxBuffer: Buffer
  try {
    docxBuffer = await buildReadinessDocx(reportText, {
      projectName: project.name,
      generatedDate: now,
      readinessScore,
      readinessLabel,
    })
  } catch {
    return { success: false, error: 'Failed to build Word document. Please try again.' }
  }

  const actualFormat = 'docx'
  const ext = 'docx'
  const version = await getNextVersion(projectId, 'readiness_report', actualFormat)
  const storagePath = `outputs/reports/readiness_report_v${version}.${ext}`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId: user.id,
    content: docxBuffer,
    storagePath,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    outputType: 'readiness_report',
    format: actualFormat,
    version,
  })

  return { success: true, downloadUrl: signedUrl, version }
}

// ── generateMappingFile ───────────────────────────────────────────────────────

export async function generateMappingFile(
  projectId: string,
  format: 'csv' | 'json'
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  if (!project) return { success: false, error: 'Access denied' }

  const { data: datasets } = await supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId)

  const { data: tableMappings } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id, status, confidence, ai_reasoning')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  if (!tableMappings || tableMappings.length === 0) {
    return { success: false, error: 'No table mappings found.' }
  }

  const tmIds = tableMappings.map((tm) => tm.id)
  const allTableIds = [...new Set([...tableMappings.map((tm) => tm.source_table_id), ...tableMappings.map((tm) => tm.target_table_id)])]

  const [{ data: allTables }, { data: fieldMappings }] = await Promise.all([
    supabaseAdmin.from('tables').select('id, name, dataset_id').in('id', allTableIds),
    supabaseAdmin.from('field_mappings').select('id, table_mapping_id, source_field_id, target_field_id, status, confidence, type_compatibility, ai_reasoning').in('table_mapping_id', tmIds),
  ])

  const tableById = new Map((allTables ?? []).map((t) => [t.id, t]))
  const fmIds = (fieldMappings ?? []).map((fm) => fm.id)
  const allFieldIds = [...new Set([...(fieldMappings ?? []).map((fm) => fm.source_field_id).filter((id): id is string => id !== null), ...(fieldMappings ?? []).map((fm) => fm.target_field_id)])]

  const [{ data: allFields }, { data: transforms }] = await Promise.all([
    allFieldIds.length > 0 ? supabaseAdmin.from('fields').select('id, name, data_type, table_id').in('id', allFieldIds) : Promise.resolve({ data: [] }),
    fmIds.length > 0 ? supabaseAdmin.from('transformations').select('field_mapping_id, status').in('field_mapping_id', fmIds) : Promise.resolve({ data: [] }),
  ])

  const fieldById = new Map((allFields ?? []).map((f) => [f.id, f]))
  const transformByFMId = new Map((transforms ?? []).map((t) => [t.field_mapping_id, t]))

  let content: string
  const version = await getNextVersion(projectId, 'mapping_file', format)

  if (format === 'csv') {
    const headers = ['source_table', 'source_field', 'source_type', 'target_table', 'target_field', 'target_type', 'confidence', 'status', 'reasoning', 'needs_transform']
    const rows: Record<string, unknown>[] = []

    for (const fm of fieldMappings ?? []) {
      const srcField = fm.source_field_id ? fieldById.get(fm.source_field_id) : null
      const tgtField = fieldById.get(fm.target_field_id)
      if (!tgtField) continue

      const srcTable = srcField ? tableById.get(srcField.table_id) : null
      const tgtTable = tableById.get(tgtField.table_id ?? '')

      rows.push({
        source_table: srcTable?.name ?? '',
        source_field: srcField ? srcField.name : '[Value Assignment]',
        source_type: srcField ? srcField.data_type : '',
        target_table: tgtTable?.name ?? '',
        target_field: tgtField.name,
        target_type: tgtField.data_type,
        confidence: fm.confidence !== null ? Math.round(fm.confidence) : '',
        status: fm.status,
        reasoning: fm.ai_reasoning ?? '',
        needs_transform: transformByFMId.has(fm.id) ? 'true' : 'false',
      })
    }
    content = buildCSV(headers, rows)
  } else {
    const tableGroups = tableMappings.map((tm) => {
      const srcTable = tableById.get(tm.source_table_id)
      const tgtTable = tableById.get(tm.target_table_id)
      const srcDs = datasets?.find((d) => d.id === srcTable?.dataset_id)
      const tgtDs = datasets?.find((d) => d.id === tgtTable?.dataset_id)
      const fms = (fieldMappings ?? [])
        .filter((fm) => fm.table_mapping_id === tm.id)
        .map((fm) => {
          const sf = fm.source_field_id ? fieldById.get(fm.source_field_id) : null
          const tf = fieldById.get(fm.target_field_id)
          return {
            source_field: sf?.name ?? (fm.source_field_id === null ? '[Value Assignment]' : ''),
            source_type: sf?.data_type ?? '',
            target_field: tf?.name ?? '',
            target_type: tf?.data_type ?? '',
            confidence: fm.confidence !== null ? Math.round(fm.confidence) : null,
            status: fm.status,
            type_compatibility: fm.type_compatibility ?? null,
            reasoning: fm.ai_reasoning ?? null,
            needs_transform: transformByFMId.has(fm.id),
          }
        })

      return {
        source: { table: srcTable?.name ?? '', dataset: srcDs?.name ?? '' },
        target: { table: tgtTable?.name ?? '', dataset: tgtDs?.name ?? '' },
        confidence: tm.confidence !== null ? Math.round(tm.confidence) : null,
        status: tm.status,
        reasoning: tm.ai_reasoning ?? null,
        field_mappings: fms,
      }
    })

    content = JSON.stringify(
      {
        project: project.name,
        generated_at: new Date().toISOString(),
        version,
        table_mappings: tableGroups,
      },
      null,
      2
    )
  }

  const ext = format === 'csv' ? 'csv' : 'json'
  const storagePath = `outputs/mapping/mapping_file_v${version}.${ext}`
  const contentType = format === 'csv' ? 'text/csv' : 'application/json'

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId: user.id,
    content,
    storagePath,
    contentType,
    outputType: 'mapping_file',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── generateTransformSpecs ────────────────────────────────────────────────────

export async function generateTransformSpecs(
  projectId: string,
  format: 'sql' | 'markdown'
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  if (!project) return { success: false, error: 'Access denied' }

  const { data: tableMappings } = await supabaseAdmin
    .from('table_mappings')
    .select('id, source_table_id, target_table_id')
    .eq('project_id', projectId)
    .neq('status', 'rejected')

  const tmIds = (tableMappings ?? []).map((tm) => tm.id)
  const { data: fieldMappings } = tmIds.length > 0
    ? await supabaseAdmin.from('field_mappings').select('id, source_field_id, target_field_id, table_mapping_id').in('table_mapping_id', tmIds)
    : { data: [] }

  const fmIds = (fieldMappings ?? []).map((fm) => fm.id)
  const { data: transforms } = fmIds.length > 0
    ? await supabaseAdmin.from('transformations').select('field_mapping_id, description, generated_sql, status, created_at').in('field_mapping_id', fmIds)
    : { data: [] }

  if (!transforms || transforms.length === 0) {
    return { success: false, error: 'No transformations found.' }
  }

  const allFieldIds = [...new Set([...(fieldMappings ?? []).map((fm) => fm.source_field_id).filter((id): id is string => id !== null), ...(fieldMappings ?? []).map((fm) => fm.target_field_id)])]
  const tableIds = [...new Set([...(tableMappings ?? []).map((tm) => tm.source_table_id), ...(tableMappings ?? []).map((tm) => tm.target_table_id)])]

  const [{ data: allFields }, { data: allTables }] = await Promise.all([
    allFieldIds.length > 0 ? supabaseAdmin.from('fields').select('id, name, table_id').in('id', allFieldIds) : Promise.resolve({ data: [] }),
    tableIds.length > 0 ? supabaseAdmin.from('tables').select('id, name').in('id', tableIds) : Promise.resolve({ data: [] }),
  ])

  const fieldById = new Map((allFields ?? []).map((f) => [f.id, f]))
  const tableById = new Map((allTables ?? []).map((t) => [t.id, t]))
  const fmById = new Map((fieldMappings ?? []).map((fm) => [fm.id, fm]))
  const tmById = new Map((tableMappings ?? []).map((tm) => [tm.id, tm]))

  const now = new Date().toUTCString()
  const lines: string[] = [
    `-- ============================================================`,
    `-- Settle — Transformation Specifications`,
    `-- Project: ${project.name}`,
    `-- Generated: ${now}`,
    `-- Total transforms: ${transforms.length}`,
    `-- ============================================================`,
    '',
  ]

  for (const t of transforms) {
    const fm = fmById.get(t.field_mapping_id)
    if (!fm) continue
    const tm = tmById.get(fm.table_mapping_id)
    const srcField = fm.source_field_id ? fieldById.get(fm.source_field_id) : null
    const tgtField = fieldById.get(fm.target_field_id)
    const srcTable = tm ? tableById.get(tm.source_table_id) : null
    const tgtTable = tm ? tableById.get(tm.target_table_id) : null
    const statusMark = t.status === 'saved' ? '✓ Saved' : t.status === 'tested' ? '◎ Tested' : '○ Draft'

    const srcLabel = srcField ? `${srcTable?.name ?? '?'}.${srcField.name}` : '[Value Assignment]'
    lines.push(`-- Source: ${srcLabel} → Target: ${tgtTable?.name ?? '?'}.${tgtField?.name ?? '?'}`)
    if (t.description) lines.push(`-- Description: ${t.description}`)
    lines.push(`-- Status: ${statusMark}`)
    lines.push(t.generated_sql)
    lines.push('')
  }

  const content = lines.join('\n')
  const version = await getNextVersion(projectId, 'transformation_specs', format)
  const storagePath = `outputs/transforms/transform_specs_v${version}.sql`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId: user.id,
    content,
    storagePath,
    contentType: 'application/sql',
    outputType: 'transformation_specs',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── generateFixLog ────────────────────────────────────────────────────────────

export async function generateFixLog(
  projectId: string,
  format: 'csv'
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).single()
  if (!project) return { success: false, error: 'Access denied' }

  const { data: fixHistory } = await supabaseAdmin
    .from('fix_history')
    .select('id, fix_description, fix_option_chosen, affected_row_count, status, applied_at, reverted_at, table_id')
    .eq('project_id', projectId)
    .order('applied_at', { ascending: true })

  const { data: qualityIssues } = await supabaseAdmin
    .from('quality_issues')
    .select('id, title, severity, status, created_at')
    .eq('project_id', projectId)
    .eq('status', 'accepted_risk')

  const tableIds = [...new Set((fixHistory ?? []).map((fh) => fh.table_id))]
  const { data: tables } = tableIds.length > 0
    ? await supabaseAdmin.from('tables').select('id, name').in('id', tableIds)
    : { data: [] }
  const tableById = new Map((tables ?? []).map((t) => [t.id, t.name]))

  const headers = ['timestamp', 'action', 'description', 'table', 'rows_affected', 'status', 'reverted_at']
  const rows: Record<string, unknown>[] = [
    ...(fixHistory ?? []).map((fh) => ({
      timestamp: fh.applied_at,
      action: 'Fix Applied',
      description: fh.fix_description,
      table: tableById.get(fh.table_id) ?? fh.table_id,
      rows_affected: fh.affected_row_count,
      status: fh.status,
      reverted_at: fh.reverted_at ?? '',
    })),
    ...(qualityIssues ?? []).map((qi) => ({
      timestamp: qi.created_at,
      action: 'Risk Accepted',
      description: `${qi.title} [${qi.severity}]`,
      table: '',
      rows_affected: '',
      status: 'accepted_risk',
      reverted_at: '',
    })),
  ].sort((a, b) => new Date(String(a.timestamp)).getTime() - new Date(String(b.timestamp)).getTime())

  if (rows.length === 0) {
    return { success: false, error: 'No fix history or accepted risks found.' }
  }

  const content = buildCSV(headers, rows)
  const version = await getNextVersion(projectId, 'fix_log', format)
  const storagePath = `outputs/fix_log/fix_log_v${version}.csv`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId: user.id,
    content,
    storagePath,
    contentType: 'text/csv',
    outputType: 'fix_log',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── generateDataDictionary ────────────────────────────────────────────────────

export async function generateDataDictionary(
  projectId: string,
  format: 'csv' | 'json'
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  const { data: project } = await supabase.from('projects').select('id, name').eq('id', projectId).single()
  if (!project) return { success: false, error: 'Access denied' }

  const { data: datasets } = await supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId)
  const datasetIds = (datasets ?? []).map((d) => d.id)
  const dsById = new Map((datasets ?? []).map((d) => [d.id, d]))

  const { data: allTables } = await supabaseAdmin.from('tables').select('id, name, dataset_id, row_count').in('dataset_id', datasetIds)
  const tableIds = (allTables ?? []).map((t) => t.id)
  const tableById = new Map((allTables ?? []).map((t) => [t.id, t]))

  const [{ data: allFields }, { data: allProfiles }] = await Promise.all([
    tableIds.length > 0 ? supabaseAdmin.from('fields').select('id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position, table_id').in('table_id', tableIds).order('ordinal_position') : Promise.resolve({ data: [] }),
    tableIds.length > 0 ? supabaseAdmin.from('field_profiles').select('field_id, null_percentage, cardinality, unique_percentage, format_issues_count, min_value, max_value, sample_values').in('field_id', tableIds.flatMap(() => [])) : Promise.resolve({ data: [] }),
  ])

  const fieldIds = (allFields ?? []).map((f) => f.id)
  const { data: profiles } = fieldIds.length > 0
    ? await supabaseAdmin.from('field_profiles').select('field_id, null_percentage, cardinality, unique_percentage, format_issues_count, min_value, max_value, sample_values').in('field_id', fieldIds)
    : { data: [] }

  const profileByFieldId = new Map((profiles ?? []).map((p) => [p.field_id, p]))

  let content: string
  const version = await getNextVersion(projectId, 'data_dictionary', format)

  if (format === 'csv') {
    const headers = ['dataset', 'role', 'table', 'field', 'type', 'inferred_type', 'nullable', 'primary_key', 'foreign_key', 'fk_reference', 'null_pct', 'cardinality', 'unique_pct', 'format_issues', 'sample_values']
    const rows: Record<string, unknown>[] = []

    for (const field of allFields ?? []) {
      const table = tableById.get(field.table_id)
      const ds = table ? dsById.get(table.dataset_id) : null
      const profile = profileByFieldId.get(field.id)
      const sampleVals = Array.isArray(profile?.sample_values) ? (profile.sample_values as unknown[]).slice(0, 5).join(', ') : ''

      rows.push({
        dataset: ds?.name ?? '',
        role: ds?.role ?? '',
        table: table?.name ?? '',
        field: field.name,
        type: field.data_type,
        inferred_type: field.inferred_type ?? '',
        nullable: field.is_nullable ? 'true' : 'false',
        primary_key: field.is_primary_key ? 'true' : 'false',
        foreign_key: field.is_foreign_key ? 'true' : 'false',
        fk_reference: field.fk_reference ?? '',
        null_pct: profile ? `${profile.null_percentage}%` : '',
        cardinality: profile?.cardinality ?? '',
        unique_pct: profile ? `${profile.unique_percentage}%` : '',
        format_issues: profile?.format_issues_count ?? '',
        sample_values: sampleVals,
      })
    }
    content = buildCSV(headers, rows)
  } else {
    const tableGroups = (allTables ?? []).map((table) => {
      const ds = dsById.get(table.dataset_id)
      const fields = (allFields ?? [])
        .filter((f) => f.table_id === table.id)
        .map((f) => {
          const p = profileByFieldId.get(f.id)
          return {
            name: f.name,
            type: f.data_type,
            inferred_type: f.inferred_type,
            nullable: f.is_nullable,
            primary_key: f.is_primary_key,
            foreign_key: f.is_foreign_key,
            fk_reference: f.fk_reference,
            stats: p ? { null_pct: p.null_percentage, cardinality: p.cardinality, unique_pct: p.unique_percentage, format_issues: p.format_issues_count, sample_values: p.sample_values } : null,
          }
        })
      return { dataset: ds?.name ?? '', role: ds?.role ?? '', table: table.name, row_count: table.row_count, fields }
    })
    content = JSON.stringify({ project: project.name, generated_at: new Date().toISOString(), version, tables: tableGroups }, null, 2)
  }

  const ext = format === 'csv' ? 'csv' : 'json'
  const storagePath = `outputs/data_dictionary/data_dictionary_v${version}.${ext}`

  const { signedUrl } = await uploadAndRecord({
    projectId,
    userId: user.id,
    content,
    storagePath,
    contentType: format === 'csv' ? 'text/csv' : 'application/json',
    outputType: 'data_dictionary',
    format,
    version,
  })

  return { success: true, downloadUrl: signedUrl, content, version }
}

// ── generateAllDeliverables ───────────────────────────────────────────────────

export async function generateAllDeliverables(projectId: string): Promise<{
  success: boolean
  results: Record<string, { downloadUrl?: string; version?: string; error?: string }>
}> {
  const results: Record<string, { downloadUrl?: string; version?: string; error?: string }> = {}

  const [report, mapping, transforms, fixLog, dictionary] = await Promise.allSettled([
    generateReadinessReport(projectId, 'markdown'),
    generateMappingFile(projectId, 'csv'),
    generateTransformSpecs(projectId, 'sql'),
    generateFixLog(projectId, 'csv'),
    generateDataDictionary(projectId, 'csv'),
  ])

  const settle = (key: string, result: PromiseSettledResult<{ success: boolean; downloadUrl?: string; version?: string; error?: string }>) => {
    if (result.status === 'fulfilled') {
      results[key] = { downloadUrl: result.value.downloadUrl, version: result.value.version, error: result.value.error }
    } else {
      results[key] = { error: String(result.reason) }
    }
  }

  settle('readiness_report', report)
  settle('mapping_file', mapping)
  settle('transformation_specs', transforms)
  settle('fix_log', fixLog)
  settle('data_dictionary', dictionary)

  return { success: true, results }
}

// ── getSignedOutputUrl ────────────────────────────────────────────────────────

export async function getSignedOutputUrl(
  outputId: string,
  projectId: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: output } = await supabase
    .from('outputs')
    .select('file_storage_path, project_id')
    .eq('id', outputId)
    .eq('project_id', projectId)
    .single()

  if (!output?.file_storage_path) return { success: false, error: 'Output not found' }

  const { data: signed } = await supabaseAdmin.storage.from('project-files').createSignedUrl(output.file_storage_path, 3600)

  return { success: true, url: signed?.signedUrl }
}
