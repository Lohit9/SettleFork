'use server'

import { createClient } from '@/lib/supabase/server'
import { Project, Dataset, ProjectWithDatasets } from '@/lib/types/database'

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
