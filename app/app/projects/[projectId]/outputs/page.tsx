import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getOutputsPageData } from '@/lib/actions/outputs'
import OutputsContent from './OutputsContent'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function OutputsPage({ params }: PageProps) {
  const { projectId } = await params

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) notFound()

  const pageData = await getOutputsPageData(projectId)

  return <OutputsContent projectId={projectId} initialData={pageData} />
}
