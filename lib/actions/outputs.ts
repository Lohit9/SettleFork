'use server'

/**
 * Customer-facing output generation — thin server-action layer.
 *
 * Architecture (Prompt 3c Gate 3 Item 2 / Path A refactor):
 *
 *   Client → outputs.ts (auth + permission gating) → _outputs-core.ts (business
 *           logic) → _outputs-translators.ts (pure text/SQL/CSV assembly)
 *
 * This file is a `'use server'` module. Every exported function below is a
 * server action callable from React components. Each one does:
 *
 *   1. Resolve the authed user via `createClient().auth.getUser()`.
 *   2. Check the required project permission (`checkProjectPermission`).
 *   3. Delegate to the matching `*Internal` function in
 *      `_outputs-core.ts` with `__skipPersistence=false`.
 *   4. Return the result.
 *
 * The `*Internal` functions live in a non-`'use server'` module so tests can
 * import and invoke them directly (with `__skipPersistence=true` to exercise
 * the content-generation path without touching storage or the `outputs`
 * table). Keeping the flag out of this file's public signatures preserves
 * the audit-trail invariant: any browser-reachable call path always persists.
 *
 * Why there's no maintenance-mode guard here
 * ------------------------------------------
 * `assertMappingWritesEnabled()` gates mapping / transformation / FK-cascade
 * WRITES against the canonical mapping model. Output generation only READS
 * that model (plus some auxiliary tables like quality_issues and activity_log)
 * and then writes its OWN artifacts into `outputs` + storage. A customer in
 * maintenance mode should still be able to download the reports that were
 * generated just before the maintenance window opened. If a later prompt
 * decides maintenance mode should also freeze output generation, add the
 * guard explicitly — don't assume it based on "this file writes something".
 * Decision recorded in Prompt 3c Gate 2 D8.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { enrichWithUserIdentity } from '@/lib/auth/users'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import {
  buildCSV,
  getNextVersion,
  uploadAndRecord,
  getOutputsPageDataCore,
  emptyOutputsPageData,
  generateGoldStandardCSVsInternal,
  generateSQLLoadScriptsInternal,
  generateReadinessReportInternal,
  generateMappingFileInternal,
  generateTransformSpecsInternal,
  type OutputsPageData as CoreOutputsPageData,
  type PhaseColor as CorePhaseColor,
  type PhaseStatus as CorePhaseStatus,
  type OutputsMetrics as CoreOutputsMetrics,
  type DecisionType as CoreDecisionType,
  type DecisionEntry as CoreDecisionEntry,
  type OutstandingItems as CoreOutstandingItems,
  type ReconstructedFile as CoreReconstructedFile,
  type ExistingOutput as CoreExistingOutput,
  type GeneratedFile as CoreGeneratedFile,
} from '@/lib/actions/_outputs-core'

// ── Public type aliases (re-export from core for UI + tests) ─────────────────

export type PhaseColor = CorePhaseColor
export type PhaseStatus = CorePhaseStatus
export type OutputsMetrics = CoreOutputsMetrics
export type DecisionType = CoreDecisionType
export type DecisionEntry = CoreDecisionEntry
export type OutstandingItems = CoreOutstandingItems
export type ReconstructedFile = CoreReconstructedFile
export type ExistingOutput = CoreExistingOutput
export type OutputsPageData = CoreOutputsPageData
export type GeneratedFile = CoreGeneratedFile

// ── getOutputsPageData ────────────────────────────────────────────────────────
//
// Thin server-action wrapper. Auth check + delegate to getOutputsPageDataCore.
// No business logic in this function — it exists solely to enforce the rule
// that browser-reachable call paths always go through auth.

export async function getOutputsPageData(projectId: string): Promise<OutputsPageData> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return emptyOutputsPageData(projectId)
  }

  // PR-4: thread the cookies-bound user client into core so stat-feeder
  // rows (TFMs / mapping_sources / fields / etc.) come from the same
  // RLS-bound rowset the Mapping page and dashboard tile see. Without
  // this, MC silently surfaced an admin-fetched superset and the
  // numbers diverged across surfaces.
  const data = await getOutputsPageDataCore(projectId, supabase)

  // Live-join actor identity into the decisions log so the UI can
  // render "timestamp · name" without denormalising user_name into
  // activity_log. Helper handles the empty-array case internally.
  if (data.decisions.length > 0) {
    data.decisions = await enrichWithUserIdentity(data.decisions, 'user_id')
  }

  return data
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

  return generateGoldStandardCSVsInternal(projectId, user.id, false)
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

  return generateSQLLoadScriptsInternal(projectId, user.id, false)
}

// ── generateReadinessReport ───────────────────────────────────────────────────

export async function generateReadinessReport(
  projectId: string,
  format: 'pdf' | 'docx' | 'markdown',
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

  return generateReadinessReportInternal(projectId, user.id, format, false)
}

// ── generateMappingFile ───────────────────────────────────────────────────────

export async function generateMappingFile(
  projectId: string,
  format: 'csv' | 'json',
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  return generateMappingFileInternal(projectId, user.id, format, false)
}

// ── generateTransformSpecs ────────────────────────────────────────────────────

export async function generateTransformSpecs(
  projectId: string,
  format: 'sql' | 'markdown',
): Promise<{ success: boolean; downloadUrl?: string; content?: string; version?: string; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission: chk } = await import('@/lib/actions/role-resolution')
  if (!(await chk(projectId, 'editor'))) return { success: false, error: 'Insufficient permissions' }

  return generateTransformSpecsInternal(projectId, user.id, format, false)
}

// ── generateFixLog (unchanged — does not read the mapping model) ──────────────

export async function generateFixLog(
  projectId: string,
  format: 'csv',
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

// ── generateDataDictionary (unchanged — does not read the mapping model) ──────

export async function generateDataDictionary(
  projectId: string,
  format: 'csv' | 'json',
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

  const { data: allFields } = tableIds.length > 0
    ? await supabaseAdmin
        .from('fields')
        .select(
          'id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position, table_id',
        )
        .in('table_id', tableIds)
        .order('ordinal_position')
    : { data: [] }

  const fieldIds = (allFields ?? []).map((f) => f.id)
  const { data: profiles } = fieldIds.length > 0
    ? await supabaseAdmin
        .from('field_profiles')
        .select('field_id, null_percentage, cardinality, unique_percentage, format_issues_count, min_value, max_value, sample_values')
        .in('field_id', fieldIds)
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
      const sampleVals = Array.isArray(profile?.sample_values)
        ? (profile.sample_values as unknown[]).slice(0, 5).join(', ')
        : ''

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
            stats: p
              ? {
                  null_pct: p.null_percentage,
                  cardinality: p.cardinality,
                  unique_pct: p.unique_percentage,
                  format_issues: p.format_issues_count,
                  sample_values: p.sample_values,
                }
              : null,
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

// ── generateAllDeliverables (unchanged) ───────────────────────────────────────

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

  const settle = (
    key: string,
    result: PromiseSettledResult<{
      success: boolean
      downloadUrl?: string
      version?: string
      error?: string
    }>,
  ) => {
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

// ── getSignedOutputUrl (unchanged) ────────────────────────────────────────────

export async function getSignedOutputUrl(
  outputId: string,
  projectId: string,
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

  const { data: signed } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  return { success: true, url: signed?.signedUrl }
}
