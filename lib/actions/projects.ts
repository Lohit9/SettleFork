'use server'

import { createClient } from '@/lib/supabase/server'
import { Project, Dataset, ProjectWithDatasets, ProjectWithStats } from '@/lib/types/database'

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
  updates: { name?: string; description?: string; status?: string }
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

  // Round 2: parallel fetch (tables, table_mappings, quality_issues, outputs)
  const DUMMY_ID = '00000000-0000-0000-0000-000000000000'
  const [
    { data: sourceTables },
    { data: tableMappings },
    { data: qualityIssues },
    { data: outputs },
  ] = await Promise.all([
    supabase
      .from('tables')
      .select('id, dataset_id, row_count')
      .in('dataset_id', sourceDatasetIds.length > 0 ? sourceDatasetIds : [DUMMY_ID]),
    supabase
      .from('table_mappings')
      .select('id, project_id')
      .in('project_id', projectIds),
    supabase
      .from('quality_issues')
      .select('project_id, severity, status')
      .in('project_id', projectIds),
    supabase.from('outputs').select('project_id').in('project_id', projectIds),
  ])

  const sourceTableIds = (sourceTables || []).map((t) => t.id)
  const tableMappingIds = (tableMappings || []).map((tm) => tm.id)

  // Round 3: fields and field_mappings
  const [{ data: fields }, { data: fieldMappings }] = await Promise.all([
    sourceTableIds.length > 0
      ? supabase.from('fields').select('id, table_id').in('table_id', sourceTableIds)
      : Promise.resolve({ data: [] as { id: string; table_id: string }[], error: null }),
    tableMappingIds.length > 0
      ? supabase
          .from('field_mappings')
          .select('id, table_mapping_id, status')
          .in('table_mapping_id', tableMappingIds)
      : Promise.resolve({
          data: [] as { id: string; table_mapping_id: string; status: string }[],
          error: null,
        }),
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
    hasSourceData: boolean
    hasMappings: boolean
    allTransformsSaved: boolean
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
      hasSourceData: false,
      hasMappings: false,
      allTransformsSaved: true,
    })
  )

  ;(fields || []).forEach((f) => {
    const pid = tableToProject.get(f.table_id)
    if (pid) buckets.get(pid)!.totalSourceFields++
  })
  ;(sourceTables || []).forEach((t) => {
    const pid = datasetToProject.get(t.dataset_id)
    if (!pid) return
    const b = buckets.get(pid)!
    b.totalRows += t.row_count || 0
    if ((t.row_count || 0) > 0) b.hasSourceData = true
  })
  ;(fieldMappings || []).forEach((fm) => {
    const pid = tmToProject.get(fm.table_mapping_id)
    if (!pid) return
    const b = buckets.get(pid)!
    if (fm.status !== 'rejected') {
      b.mappedFieldCount++
      b.hasMappings = true
    }
  })
  ;(qualityIssues || []).forEach((qi) => {
    const b = buckets.get(qi.project_id)
    if (!b) return
    b.totalQualityIssues++
    if (qi.status === 'fixed' || qi.status === 'accepted_risk') b.resolvedQualityIssues++
    if (qi.status === 'open') {
      if (qi.severity === 'blocking') b.blockingIssueCount++
      else if (qi.severity === 'warning') b.warningCount++
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
    else b.allTransformsSaved = false
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

    // Determine highest completed phase
    let completed = 0
    if (b.hasSourceData) completed = 1
    if (completed >= 1 && b.hasMappings) completed = 2
    if (completed >= 2 && (b.totalTransforms === 0 || b.allTransformsSaved)) completed = 3
    if (completed >= 3 && readinessScore !== null && readinessScore >= 90) completed = 4
    if (completed >= 4 && b.outputCount > 0) completed = 5
    // currentPhase = next phase to work on (1-indexed), capped so that when
    // all 5 phases are done the bar shows fully green (use 6 to signal "all done")
    const currentPhase = completed >= 5 ? 6 : completed + 1

    return {
      id: project.id,
      name: project.name,
      source_label: src?.name || 'Source',
      target_label: tgt?.name || 'Target',
      status: project.status as 'active' | 'completed' | 'archived',
      created_at: project.created_at,
      updated_at: project.updated_at,
      totalSourceFields: b.totalSourceFields,
      mappedFieldCount: b.mappedFieldCount,
      totalRows: b.totalRows,
      blockingIssueCount: b.blockingIssueCount,
      warningCount: b.warningCount,
      totalTransforms: b.totalTransforms,
      savedTransforms: b.savedTransforms,
      readinessScore,
      currentPhase,
      outputCount: b.outputCount,
    }
  })
}
