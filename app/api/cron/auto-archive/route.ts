export const maxDuration = 300  // 5 minutes max for batch processing

import { supabaseAdmin } from '@/lib/supabase/admin'
import { archiveProject } from '@/lib/actions/projects'

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 90)

  const { data: projects, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('status', 'completed')
    .lt('completed_at', cutoffDate.toISOString())
    .not('completed_at', 'is', null)

  if (error) {
    console.error('[cron/auto-archive] Failed to query projects:', error)
    return Response.json({ error: error.message }, { status: 500 })
  }

  if (!projects || projects.length === 0) {
    return Response.json({ archived: 0, message: 'No projects eligible for auto-archive' })
  }

  let archivedCount = 0
  const errors: { projectId: string; error: string }[] = []

  for (const project of projects) {
    try {
      const result = await archiveProject(project.id)
      if (result.success) {
        archivedCount++
      } else {
        errors.push({ projectId: project.id, error: result.error ?? 'Unknown error' })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error'
      console.error(`[cron/auto-archive] Failed to archive project ${project.id}:`, message)
      errors.push({ projectId: project.id, error: message })
    }
  }

  return Response.json({
    archived: archivedCount,
    total: projects.length,
    errors: errors.length > 0 ? errors : undefined,
  })
}
