'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { Project, Dataset, ProjectWithDatasets, ProjectWithStats } from '@/lib/types/database'
import { extractMigrationIntelligence } from '@/lib/actions/migration-intelligence'
import { logActivity } from '@/lib/actions/activity-log'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getProjectsWithStatsInternal } from '@/lib/actions/_projects-core'

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
  description?: string,
  orgId?: string
): Promise<{ success: boolean; data?: Project; error?: string }> {
  // The entire creation flow (project insert + project_members fanout +
  // datasets insert) runs inside a single SECURITY DEFINER RPC defined
  // in migration 080. This sidesteps a @supabase/ssr write-path bug
  // where the cookie-based SSR client loses JWT context on writes
  // (auth.uid() returns NULL during RLS evaluation even when reads in
  // the same request succeed). Inside the RPC, auth.uid() is captured
  // once at entry and the rest runs with definer privileges atomically.
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { success: false, error: 'Not authenticated' }

  const { data, error } = await supabase
    .rpc('create_project_with_access', {
      p_name: name,
      p_description: description ?? null,
      p_source_system_name: sourceSystemName,
      p_target_system_name: targetSystemName,
      p_org_id: orgId ?? null,
    })
    .single()

  if (error || !data) {
    return { success: false, error: error?.message || 'Failed to create project' }
  }

  return { success: true, data: data as Project }
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
): Promise<{ success: boolean; data?: Project; error?: string }> {
  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions. Required role: editor' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single()

  if (error || !data) return { success: false, error: error?.message || 'Failed to update project' }
  return { success: true, data: data as Project }
}

export async function deleteProject(projectId: string): Promise<{ success: boolean; error?: string }> {
  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'admin'))) {
    return { success: false, error: 'Insufficient permissions. Required role: admin' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('projects').delete().eq('id', projectId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// Thin wrapper over `getProjectsWithStatsInternal` in
// `_projects-core.ts`. The business logic moved in Prompt 3d Step 3D-14
// (Path A refactor) so it can be called from Node-only integration
// tests (`tests/integration/projects-heritage.test.ts`) that need to
// bypass the cookies()/request-scope machinery of `'use server'`.
//
// The wrapper builds a cookies-bound Supabase client (RLS-active —
// user sees only their own projects/orgs) and delegates. The
// delegate takes the client as a parameter and does all the
// aggregation work; see `_projects-core.ts` for the data-model
// narrative, bare-ack handling, rejected-TM scope collapse, and
// guard-wiring rationale.
//
// DO NOT inline the aggregation back here — the Path A split is a
// correctness boundary: the Internal must not transitively import
// next/headers, otherwise integration tests regress to the
// `cookies() outside request scope` failure mode that prompted the
// split. See Prompt 3d docs/prompt-3a-remaining-work.md for context.
export async function getProjectsWithStats(orgId?: string): Promise<ProjectWithStats[]> {
  const supabase = await createClient()
  return getProjectsWithStatsInternal(supabase, orgId)
}

// ───────────────────────────────────────────────────────────────────────────
// The rest of the file is other server actions (createProject,
// updateProject, deleteProject, updateProjectLabels,
// markProjectComplete, reactivateProject, archiveProject, etc.).
// These mutate projects/datasets/activity_log only — NOT mapping-
// shape tables — so the Gate 2 guard-wiring policy does not require
// `assertMappingWritesEnabled` here. The entire file is safe to run
// while mapping writes are disabled (maintenance_mode=true).
// ───────────────────────────────────────────────────────────────────────────


/**
 * Marks a project as complete and triggers background migration intelligence
 * extraction. The extraction is fire-and-forget — it never blocks the
 * completion response and failures are logged but not surfaced to the user.
 */
export async function markProjectComplete(projectId: string): Promise<{ success: boolean; data?: Project; error?: string }> {
  const result = await updateProject(projectId, { status: 'completed', completed_at: new Date().toISOString() })
  if (!result.success) return result

  // Fire intelligence extraction in the background — non-blocking and failure-safe
  try {
    extractMigrationIntelligence(projectId).catch((err) => {
      console.error('Migration intelligence extraction failed (non-critical):', err)
    })
  } catch (err) {
    console.error('Migration intelligence extraction failed (non-critical):', err)
  }

  return result
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
    const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
    if (!(await checkProjectPermission(projectId, 'admin'))) {
      return { success: false, error: 'Insufficient permissions. Admin role required.' }
    }

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
    const { data: allTables, error: tablesError } = datasetIds.length > 0
      ? await supabaseAdmin.from('tables').select('id, csv_storage_path').in('dataset_id', datasetIds)
      : { data: [], error: null }
    if (tablesError) {
      console.error('[archiveProject] Error fetching tables:', tablesError)
    }
    const tableIds = (allTables ?? []).map((t) => t.id)

    // ── Step 1: Purge data_rows ───────────────────────────────────────────────
    if (tableIds.length > 0) {
      const { error: deleteError, count } = await supabaseAdmin
        .from('data_rows')
        .delete({ count: 'exact' })
        .in('table_id', tableIds)

      if (deleteError) {
        console.error('[archiveProject] Error deleting data_rows:', deleteError)
      } else {
        console.log(`[archiveProject] Deleted ${count} data_rows`)
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
        `Project archived. Uploaded data purged.`,
        'system',
        {}
      )
    }

    revalidatePath('/app/projects')
    return { success: true }
  } catch (err) {
    console.error('[archiveProject] Unexpected error:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Failed to archive project' }
  }
}
