'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { Project, Dataset, ProjectWithDatasets, ProjectWithStats } from '@/lib/types/database'
import { extractMigrationIntelligence } from '@/lib/actions/migration-intelligence'
import { logActivity } from '@/lib/actions/activity-log'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function updateProjectLabels(
  projectId: string,
  sourceLabel: string,
  targetLabel: string
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  await Promise.all([
    supabase.from('datasets').update({ name: sourceLabel }).eq('project_id', projectId).eq('role', 'source'),
    supabase.from('datasets').update({ name: targetLabel }).eq('project_id', projectId).eq('role', 'target'),
  ])

  revalidatePath('/app/projects')
}

export async function createProject(
  name: string,
  sourceSystemName: string = 'Source System',
  targetSystemName: string = 'Target System',
  description?: string
): Promise<Project> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new Error('Not authenticated')

  const { data: project, error } = await supabase
    .from('projects')
    .insert({ name, description: description || null, user_id: user.id })
    .select()
    .single()

  if (error || !project) throw new Error(error?.message || 'Failed to create project')

  const { error: datasetError } = await supabase.from('datasets').insert([
    { project_id: project.id, role: 'source', name: sourceSystemName },
    { project_id: project.id, role: 'target', name: targetSystemName },
  ])

  if (datasetError) throw new Error(datasetError.message)

  return project as Project
}

export async function getProjects(): Promise<Project[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data || []) as Project[]
}

export async function getProject(projectId: string): Promise<ProjectWithDatasets> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .select('*, datasets(*)')
    .eq('id', projectId)
    .single()

  if (error || !data) throw new Error(error?.message || 'Project not found')
  return data as ProjectWithDatasets
}

export async function updateProject(
  projectId: string,
  updates: { name?: string; description?: string; status?: string; completed_at?: string | null; archived_at?: string | null }
): Promise<Project> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single()

  if (error || !data) throw new Error(error?.message || 'Failed to update project')
  return data as Project
}

export async function deleteProject(projectId: string): Promise<void> {
  const supabase = await createClient()
  const { error } = await supabase.from('projects').delete().eq('id', projectId)
  if (error) throw new Error(error.message)
}

export async function getProjectsWithStats(): Promise<ProjectWithStats[]> {
  const supabase = await createClient()

  // Round 1: projects with their datasets
  const { data: projects, error } = await supabase
    .from('projects')
    .select('*, datasets(id, role, name)')
    .order('created_at', { ascending: false })

  if (error || !projects || projects.length === 0) return []

  const projectIds = projects.map((p) => p.id)
  const allDatasets = projects.flatMap((p) => (p.datasets || []) as Dataset[])
  const sourceDatasetIds = allDatasets.filter((d) => d.role === 'source').map((d) => d.id)
  const targetDatasetIds = allDatasets.filter((d) => d.role === 'target').map((d) => d.id)

  // Round 2: parallel fetch (tables for both source + target, table_mappings, quality_issues, outputs, acknowledgments)
  const DUMMY_ID = '00000000-0000-0000-0000-000000000000'
  const [
    { data: sourceTables },
    { data: targetTables },
    { data: tableMappings },
    { data: qualityIssues },
    { data: outputs },
    { data: fieldAcks },
  ] = await Promise.all([
    supabase
      .from('tables')
      .select('id, dataset_id, row_count')
      .in('dataset_id', sourceDatasetIds.length > 0 ? sourceDatasetIds : [DUMMY_ID]),
    supabase
      .from('tables')
      .select('id, dataset_id')
      .in('dataset_id', targetDatasetIds.length > 0 ? targetDatasetIds : [DUMMY_ID]),
    supabase
      .from('table_mappings')
      .select('id, project_id, target_table_id')
      .in('project_id', projectIds)
      .neq('status', 'rejected'),
    supabase
      .from('quality_issues')
      .select('project_id, severity, status, field_id, stage, issue_kind, description')
      .in('project_id', projectIds),
    supabase.from('outputs').select('project_id').in('project_id', projectIds),
    supabase.from('field_acknowledgments').select('project_id, field_id').in('project_id', projectIds),
  ])

  const sourceTableIds = (sourceTables || []).map((t) => t.id)
  const tableMappingIds = (tableMappings || []).map((tm) => tm.id)
  const allTargetTableIds = [...new Set((tableMappings || []).map((tm) => tm.target_table_id))]

  // Round 3: source fields, field_mappings (with richer columns), ALL target fields (for counting)
  const [{ data: fields }, { data: fieldMappings }, { data: allTargetFields }] = await Promise.all([
    sourceTableIds.length > 0
      ? supabase.from('fields').select('id, table_id').in('table_id', sourceTableIds)
      : Promise.resolve({ data: [] as { id: string; table_id: string }[], error: null }),
    tableMappingIds.length > 0
      ? supabase
          .from('field_mappings')
          .select('id, table_mapping_id, status, is_contributing, source_field_id, target_field_id, needs_transformation')
          .in('table_mapping_id', tableMappingIds)
      : Promise.resolve({
          data: [] as { id: string; table_mapping_id: string; status: string; is_contributing: boolean; source_field_id: string | null; target_field_id: string; needs_transformation: boolean | null }[],
          error: null,
        }),
    allTargetTableIds.length > 0
      ? supabase.from('fields').select('id, table_id').in('table_id', allTargetTableIds)
      : Promise.resolve({ data: [] as { id: string; table_id: string }[], error: null }),
  ])

  const fieldMappingIds = (fieldMappings || []).map((fm) => fm.id)

  // Round 4: transformations
  const { data: transformations } =
    fieldMappingIds.length > 0
      ? await supabase
          .from('transformations')
          .select('field_mapping_id, status')
          .in('field_mapping_id', fieldMappingIds)
      : { data: [] as { field_mapping_id: string; status: string }[] }

  // Build lookup maps
  const datasetToProject = new Map<string, string>()
  projects.forEach((p) => {
    ;(p.datasets || []).forEach((d: Dataset) => datasetToProject.set(d.id, p.id))
  })

  const tableToProject = new Map<string, string>()
  ;(sourceTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (pid) tableToProject.set(t.id, pid)
  })

  const tmToProject = new Map<string, string>()
  ;(tableMappings || []).forEach((tm) => tmToProject.set(tm.id, tm.project_id))

  const fmToTM = new Map<string, string>()
  ;(fieldMappings || []).forEach((fm) => fmToTM.set(fm.id, fm.table_mapping_id))

  // Per-project aggregation buckets
  type Bucket = {
    totalSourceFields: number
    totalRows: number
    mappedFieldCount: number
    blockingIssueCount: number
    warningCount: number
    totalTransforms: number
    savedTransforms: number
    totalQualityIssues: number
    resolvedQualityIssues: number
    outputCount: number
    hasSourceTables: boolean
    hasTargetTables: boolean
    // Mapping phase: track primary mappings, approvals, and acknowledgments
    primaryMappingCount: number
    allPrimaryApproved: boolean
    mappedTargetFieldIds: Set<string>
    mappedSourceFieldIds: Set<string>
    acknowledgedFieldIds: Set<string>
    totalSourceFieldCount: number
    totalTargetFieldCount: number
    // Transform phase: track needs_transformation coverage
    needsTransformIds: Set<string>
    coveredTransformIds: Set<string>
    // Dedup guard for target field counting
    countedTargetFieldIds: Set<string>
  }
  const buckets = new Map<string, Bucket>()
  projectIds.forEach((id) =>
    buckets.set(id, {
      totalSourceFields: 0,
      totalRows: 0,
      mappedFieldCount: 0,
      blockingIssueCount: 0,
      warningCount: 0,
      totalTransforms: 0,
      savedTransforms: 0,
      totalQualityIssues: 0,
      resolvedQualityIssues: 0,
      outputCount: 0,
      hasSourceTables: false,
      hasTargetTables: false,
      primaryMappingCount: 0,
      allPrimaryApproved: true,
      mappedTargetFieldIds: new Set(),
      mappedSourceFieldIds: new Set(),
      acknowledgedFieldIds: new Set(),
      totalSourceFieldCount: 0,
      totalTargetFieldCount: 0,
      needsTransformIds: new Set(),
      coveredTransformIds: new Set(),
      countedTargetFieldIds: new Set(),
    })
  )

  ;(fields || []).forEach((f) => {
    const pid = tableToProject.get(f.table_id)
    if (pid) {
      buckets.get(pid)!.totalSourceFields++
      buckets.get(pid)!.totalSourceFieldCount++
    }
  })
  ;(sourceTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (!pid) return
    const b = buckets.get(pid)!
    b.totalRows += t.row_count || 0
    b.hasSourceTables = true
  })
  // Count target fields per project (via target tables → datasets → project)
  const targetTableToProject = new Map<string, string>()
  ;(targetTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (pid) {
      buckets.get(pid)!.hasTargetTables = true
      targetTableToProject.set(t.id, pid)
    }
  })
  // Count target fields per project (via table mapping target tables).
  // Use countedTargetFieldIds to avoid double-counting when multiple source
  // tables map to the same target table.
  ;(allTargetFields || []).forEach((f) => {
    const tms = (tableMappings || []).filter((tm) => tm.target_table_id === f.table_id)
    for (const tm of tms) {
      const b = buckets.get(tm.project_id)
      if (b && !b.countedTargetFieldIds.has(f.id)) {
        b.totalTargetFieldCount++
        b.countedTargetFieldIds.add(f.id)
      }
    }
  })
  ;(fieldAcks || []).forEach((fa) => {
    const b = buckets.get(fa.project_id)
    if (b) b.acknowledgedFieldIds.add(fa.field_id)
  })
  ;(fieldMappings || []).forEach((fm) => {
    const pid = tmToProject.get(fm.table_mapping_id)
    if (!pid) return
    const b = buckets.get(pid)!
    if (fm.status !== 'rejected') {
      b.mappedFieldCount++
    }
    if (fm.status !== 'rejected' && fm.source_field_id) b.mappedSourceFieldIds.add(fm.source_field_id)
    if (!fm.is_contributing) {
      b.primaryMappingCount++
      if (fm.status !== 'approved') b.allPrimaryApproved = false
      if (fm.status !== 'rejected') b.mappedTargetFieldIds.add(fm.target_field_id)
      if (fm.status === 'approved' && fm.needs_transformation) {
        b.needsTransformIds.add(fm.id)
      }
    }
  })
  // Build per-project set of source field IDs resolved by transform — mirrors the
  // logic in lib/quality/resolved-by-transform.ts and lib/actions/outputs.ts.
  // A source field is resolved when its approved primary mapping either has
  // needs_transformation=false OR has at least one transform record.
  const fmIdsWithTransform = new Set((transformations || []).map((t) => t.field_mapping_id))
  const resolvedSourceFieldIdsByProject = new Map<string, Set<string>>()
  ;(fieldMappings || []).forEach((fm) => {
    if (!fm.source_field_id || fm.status !== 'approved' || fm.is_contributing) return
    const pid = tmToProject.get(fm.table_mapping_id)
    if (!pid) return
    const hasTransform = fmIdsWithTransform.has(fm.id)
    const noTransformNeeded = fm.needs_transformation === false
    if (hasTransform || noTransformNeeded) {
      if (!resolvedSourceFieldIdsByProject.has(pid)) resolvedSourceFieldIdsByProject.set(pid, new Set())
      resolvedSourceFieldIdsByProject.get(pid)!.add(fm.source_field_id)
    }
  })

  // Mirrors isNeverResolvable() in DataQualityContent — structural issues that
  // a transform expression cannot fix regardless of field mapping state.
  function isNeverResolvable(qi: { issue_kind?: string | null; description?: string | null }): boolean {
    const desc = (qi.description ?? '').toLowerCase()
    if (qi.issue_kind === 'null_primary_key') return true
    if (qi.issue_kind === 'orphaned_fk') return true
    if (qi.issue_kind === 'referential_integrity') return true
    if (desc.includes('null') && (desc.includes('primary key') || desc.includes('primary_key'))) return true
    if (desc.includes('orphan')) return true
    if (desc.includes('referential')) return true
    return false
  }

  ;(qualityIssues || []).forEach((qi) => {
    const b = buckets.get(qi.project_id)
    if (!b) return
    b.totalQualityIssues++
    if (qi.status === 'fixed' || qi.status === 'accepted_risk') b.resolvedQualityIssues++
    if (qi.status === 'open') {
      // Source issues whose field has an approved transform are resolved — exclude
      // from counts, matching the Validate page and Migration Center logic.
      const resolvedByTransform =
        qi.stage === 'source' &&
        !isNeverResolvable(qi) &&
        qi.field_id != null &&
        (resolvedSourceFieldIdsByProject.get(qi.project_id)?.has(qi.field_id) ?? false)

      if (!resolvedByTransform) {
        if (qi.severity === 'blocking') b.blockingIssueCount++
        else if (qi.severity === 'warning') b.warningCount++
      }
    }
  })
  ;(transformations || []).forEach((t) => {
    const tmId = fmToTM.get(t.field_mapping_id)
    if (!tmId) return
    const pid = tmToProject.get(tmId)
    if (!pid) return
    const b = buckets.get(pid)!
    b.totalTransforms++
    if (t.status === 'saved' || t.status === 'applied') b.savedTransforms++
    if (b.needsTransformIds.has(t.field_mapping_id)) {
      b.coveredTransformIds.add(t.field_mapping_id)
    }
  })
  ;(outputs || []).forEach((o) => {
    const b = buckets.get(o.project_id)
    if (b) b.outputCount++
  })

  return projects.map((project) => {
    const b = buckets.get(project.id)!
    const datasets = (project.datasets || []) as Dataset[]
    const src = datasets.find((d) => d.role === 'source')
    const tgt = datasets.find((d) => d.role === 'target')

    const readinessScore =
      b.totalQualityIssues === 0
        ? null
        : Math.round((b.resolvedQualityIssues / b.totalQualityIssues) * 100)

    // Phase 1 — Ingestion: both source and target tables exist
    const ingestionDone = b.hasSourceTables && b.hasTargetTables

    // Phase 2 — Mapping: all fields addressed (mapped or acknowledged)
    const hasMappings = b.primaryMappingCount > 0
    const totalFields = b.totalSourceFieldCount + b.totalTargetFieldCount
    const allMappedOrAckedIds = new Set([...b.mappedSourceFieldIds, ...b.mappedTargetFieldIds, ...b.acknowledgedFieldIds])
    const addressedCount = allMappedOrAckedIds.size
    const mappingDone = hasMappings && b.allPrimaryApproved && totalFields > 0 && addressedCount >= totalFields

    // Phase 3 — Transform: all approved needs_transformation mappings have a saved transform
    const transformDone = b.needsTransformIds.size === 0
      ? hasMappings
      : b.coveredTransformIds.size >= b.needsTransformIds.size

    // Phase 4 — Validate: at least one scan run AND zero open blocking issues
    const validateDone = b.totalQualityIssues > 0 && b.blockingIssueCount === 0

    let completed = 0
    if (ingestionDone) completed = 1
    if (completed >= 1 && mappingDone) completed = 2
    if (completed >= 2 && transformDone) completed = 3
    if (completed >= 3 && validateDone) completed = 4
    if (completed >= 4 && b.outputCount > 0) completed = 5
    const currentPhase = completed >= 5 ? 6 : completed + 1

    return {
      id: project.id,
      name: project.name,
      source_label: src?.name || 'Source',
      target_label: tgt?.name || 'Target',
      status: project.status as 'active' | 'completed' | 'archived',
      created_at: project.created_at,
      updated_at: project.updated_at,
      completed_at: project.completed_at ?? null,
      archived_at: project.archived_at ?? null,
      totalSourceFields: b.totalSourceFields,
      mappedFieldCount: b.mappedFieldCount,
      totalRows: b.totalRows,
      blockingIssueCount: b.blockingIssueCount,
      warningCount: b.warningCount,
      totalTransforms: b.totalTransforms,
      savedTransforms: b.savedTransforms,
      needsTransformCount: b.needsTransformIds.size,
      coveredTransformCount: b.coveredTransformIds.size,
      readinessScore,
      currentPhase,
      outputCount: b.outputCount,
    }
  })
}

/**
 * Marks a project as complete and triggers background migration intelligence
 * extraction. The extraction is fire-and-forget — it never blocks the
 * completion response and failures are logged but not surfaced to the user.
 */
export async function markProjectComplete(projectId: string): Promise<Project> {
  const project = await updateProject(projectId, { status: 'completed', completed_at: new Date().toISOString() })

  // Fire intelligence extraction in the background — non-blocking and failure-safe
  try {
    extractMigrationIntelligence(projectId).catch((err) => {
      console.error('Migration intelligence extraction failed (non-critical):', err)
    })
  } catch (err) {
    console.error('Migration intelligence extraction failed (non-critical):', err)
  }

  return project
}

export async function reactivateProject(projectId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: project, error: fetchError } = await supabase
      .from('projects')
      .select('status')
      .eq('id', projectId)
      .single()

    if (fetchError || !project) return { success: false, error: 'Project not found' }
    if (project.status === 'archived') return { success: false, error: 'Archived projects cannot be reactivated' }
    if (project.status === 'active') return { success: true }

    const { error } = await supabase
      .from('projects')
      .update({ status: 'active', completed_at: null, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .eq('status', 'completed')

    if (error) return { success: false, error: error.message }

    revalidatePath('/app/projects')
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to reactivate project' }
  }
}

export async function archiveProject(projectId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Verify project exists and is not already archived
    const { data: project, error: fetchError } = await supabase
      .from('projects')
      .select('id, status')
      .eq('id', projectId)
      .single()

    if (fetchError || !project) return { success: false, error: 'Project not found' }
    if (project.status === 'archived') return { success: false, error: 'Project is already archived' }

    // Fetch dataset IDs once — reused across multiple purge steps
    const { data: allDatasets } = await supabaseAdmin
      .from('datasets')
      .select('id')
      .eq('project_id', projectId)
    const datasetIds = (allDatasets ?? []).map((d) => d.id)

    // Fetch table IDs once — reused for data_rows and field_profiles
    const { data: allTables } = datasetIds.length > 0
      ? await supabaseAdmin.from('tables').select('id, csv_storage_path').in('dataset_id', datasetIds)
      : { data: [] }
    const tableIds = (allTables ?? []).map((t) => t.id)

    // ── Step 1: Purge data_rows in batches ────────────────────────────────────
    let totalDeleted = 0
    if (tableIds.length > 0) {
      let keepDeleting = true
      while (keepDeleting) {
        const { data: ids, error: idsError } = await supabaseAdmin
          .from('data_rows')
          .select('id')
          .in('table_id', tableIds)
          .limit(10000)

        if (idsError || !ids || ids.length === 0) {
          keepDeleting = false
          break
        }

        const { error: deleteError } = await supabaseAdmin
          .from('data_rows')
          .delete()
          .in('id', ids.map((r) => r.id))

        if (deleteError) {
          console.error('[archiveProject] Error deleting data_rows batch:', deleteError)
          keepDeleting = false
        } else {
          totalDeleted += ids.length
          if (ids.length < 10000) keepDeleting = false
        }
      }
    }

    // ── Step 2: Purge CSV files from storage ──────────────────────────────────
    try {
      const tablesWithPaths = (allTables ?? []).filter((t) => t.csv_storage_path != null)

      if (tablesWithPaths.length > 0) {
        const paths = tablesWithPaths
          .map((t) => t.csv_storage_path as string)
          .filter(Boolean)

        if (paths.length > 0) {
          await supabaseAdmin.storage.from('project-files').remove(paths)
        }

        await supabaseAdmin
          .from('tables')
          .update({ csv_storage_path: null })
          .in('id', tablesWithPaths.map((t) => t.id))
      }
    } catch (storageErr) {
      console.error('[archiveProject] Error purging CSV storage files:', storageErr)
    }

    // ── Step 3: Purge db_connections ─────────────────────────────────────────
    try {
      await supabaseAdmin.from('db_connections').delete().eq('project_id', projectId)
    } catch (connErr) {
      console.error('[archiveProject] Error deleting db_connections:', connErr)
    }

    // ── Step 4: Null out sensitive field_profiles columns ────────────────────
    try {
      if (tableIds.length > 0) {
        const { data: fieldIds } = await supabaseAdmin
          .from('fields')
          .select('id')
          .in('table_id', tableIds)

        if (fieldIds && fieldIds.length > 0) {
          for (let i = 0; i < fieldIds.length; i += 500) {
            const batch = fieldIds.slice(i, i + 500).map((f) => f.id)
            await supabaseAdmin
              .from('field_profiles')
              .update({ sample_values: null, min_value: null, max_value: null, value_distribution: null })
              .in('field_id', batch)
          }
        }
      }
    } catch (profileErr) {
      console.error('[archiveProject] Error nulling field_profiles:', profileErr)
    }

    // ── Step 5: Zero out table row counts ────────────────────────────────────
    try {
      if (datasetIds.length > 0) {
        await supabaseAdmin
          .from('tables')
          .update({ row_count: 0 })
          .in('dataset_id', datasetIds)
      }
    } catch (rowCountErr) {
      console.error('[archiveProject] Error zeroing row counts:', rowCountErr)
    }

    // ── Step 6: Mark project as archived ─────────────────────────────────────
    const now = new Date().toISOString()
    const { error: archiveError } = await supabaseAdmin
      .from('projects')
      .update({ status: 'archived', archived_at: now, updated_at: now })
      .eq('id', projectId)

    if (archiveError) return { success: false, error: archiveError.message }

    // ── Step 7: Log the archival ──────────────────────────────────────────────
    if (user) {
      await logActivity(
        projectId,
        'project_archived',
        `Project archived. Uploaded data purged. ${totalDeleted} data rows removed.`,
        'system',
        { data_rows_deleted: totalDeleted }
      )
    }

    revalidatePath('/app/projects')
    return { success: true }
  } catch (err) {
    console.error('[archiveProject] Unexpected error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Failed to archive project' }
  }
}
