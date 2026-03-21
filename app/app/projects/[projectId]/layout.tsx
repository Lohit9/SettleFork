import { notFound } from 'next/navigation'
import { Navigation } from '@/components/app/Navigation'
import { getProject } from '@/lib/actions/projects'
import { supabaseAdmin } from '@/lib/supabase/admin'

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  const project = await getProject(projectId).catch(() => notFound())

  const sourceDataset = project.datasets?.find((d) => d.role === 'source')
  const targetDataset = project.datasets?.find((d) => d.role === 'target')

  // Count open blocking issues for sidebar badge (non-fatal if it fails)
  let blockingIssueCount = 0
  try {
    const { count } = await supabaseAdmin
      .from('quality_issues')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('severity', 'blocking')
      .eq('status', 'open')
    blockingIssueCount = count ?? 0
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
