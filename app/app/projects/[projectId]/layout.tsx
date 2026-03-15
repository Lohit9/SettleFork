import { notFound } from 'next/navigation'
import { Navigation } from '@/components/app/Navigation'
import { getProject } from '@/lib/actions/projects'

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

  return (
    <div className="h-screen w-full flex bg-gray-50 overflow-hidden">
      <Navigation
        projectName={project.name}
        projectId={projectId}
        sourceSystemName={sourceDataset?.name}
        targetSystemName={targetDataset?.name}
      />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}
