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

  const isArchived = project.status === 'archived'
  const archivedDate = (project as { archived_at?: string | null }).archived_at
    ? new Date((project as { archived_at: string }).archived_at).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
      })
    : null

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
      <div className="h-full overflow-auto flex flex-col">
        {isArchived && (
          <div className="flex-shrink-0 bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center gap-2.5 text-sm text-amber-800">
            <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
            <span>
              <span className="font-medium">This project is archived.</span>
              {' '}Source data has been purged. Mappings, transformations, and outputs are preserved as read-only.
              {archivedDate && <span className="ml-2 text-amber-600">Archived on {archivedDate}.</span>}
            </span>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      </div>
    </div>
  )
}
