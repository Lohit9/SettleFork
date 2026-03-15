'use server'

import { createClient } from '@/lib/supabase/server'
import { DBTable } from '@/lib/types/database'

export async function getDatasetTables(datasetId: string): Promise<DBTable[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tables')
    .select('*')
    .eq('dataset_id', datasetId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as DBTable[]
}
