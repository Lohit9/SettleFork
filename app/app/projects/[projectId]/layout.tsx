import { notFound, redirect } from 'next/navigation'
import { Navigation } from '@/components/app/Navigation'
import { getProject } from '@/lib/actions/projects'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { getResolvedSourceFieldIds } from '@/lib/quality/resolved-by-transform'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  // Check auth first — unauthenticated users go to login, not the not-found page
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?returnTo=/app/projects/${projectId}`)
  }

  const project = await getProject(projectId).catch(() => notFound())

  const sourceDataset = project.datasets?.find((d) => d.role === 'source')
  const targetDataset = project.datasets?.find((d) => d.role === 'target')

  // Count unresolved open blocking issues for sidebar badge (non-fatal if it fails).
  // Source issues whose field has an approved transform are excluded from the count.
  let blockingIssueCount = 0
  try {
    const [{ data: blockingIssues }, resolvedFieldIds] = await Promise.all([
      supabaseAdmin
        .from('quality_issues')
        .select('id, field_id, stage, description, title, issue_kind')
        .eq('project_id', projectId)
        .eq('severity', 'blocking')
        .eq('status', 'open'),
      getResolvedSourceFieldIds(projectId).catch(() => [] as string[]),
    ])

    const resolvedSet = new Set(resolvedFieldIds)

    blockingIssueCount = (blockingIssues ?? []).filter((issue) => {
      // Target-ready issues are never auto-resolved
      if (issue.stage !== 'source') return true
      // Structural issues (null PK, orphaned FK) can never be resolved by transforms
      const desc = (issue.description ?? '').toLowerCase()
      const title = (issue.title ?? '').toLowerCase()
      if (issue.issue_kind === 'null_primary_key') return true
      if (issue.issue_kind === 'orphaned_fk') return true
      if (issue.issue_kind === 'referential_integrity') return true
      if (desc.includes('null') && (desc.includes('primary key') || desc.includes('primary_key'))) return true
      if (desc.includes('orphan') || title.includes('orphan')) return true
      if (desc.includes('referential') || title.includes('referential')) return true
      // Exclude source issues whose field is resolved by an approved transform
      if (issue.field_id && resolvedSet.has(issue.field_id)) return false
      return true
    }).length
  } catch {
    // Non-fatal
  }

  return (
    <div className="h-screen bg-gray-50 overflow-hidden">
      <Navigation
        projectName={project.name}
        projectId={projectId}
        sourceSystemName={sourceDataset?.name}
        targetSystemName={targetDataset?.name}
        blockingIssueCount={blockingIssueCount}
        projectStatus={project.status ?? 'active'}
      />
      <div className="h-full pl-[60px] overflow-auto">{children}</div>
    </div>
  )
}
