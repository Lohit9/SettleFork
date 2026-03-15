import { notFound } from 'next/navigation'
import { getProject } from '@/lib/actions/projects'
import { getDatasetTables } from '@/lib/actions/tables'
import { ControlPlaneClient } from './ControlPlaneClient'

export default async function ControlPlanePage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const project = await getProject(projectId).catch(() => notFound())

  const sourceDataset = project.datasets?.find((d) => d.role === 'source')
  const targetDataset = project.datasets?.find((d) => d.role === 'target')

  const [sourceTables, targetTables] = await Promise.all([
    sourceDataset ? getDatasetTables(sourceDataset.id) : Promise.resolve([]),
    targetDataset ? getDatasetTables(targetDataset.id) : Promise.resolve([]),
  ])

  return (
    <ControlPlaneClient
      projectId={projectId}
      sourceDataset={sourceDataset ?? null}
      targetDataset={targetDataset ?? null}
      sourceTables={sourceTables}
      targetTables={targetTables}
    />
  )
}
