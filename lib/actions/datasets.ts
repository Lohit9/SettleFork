'use server'

import { createClient } from '@/lib/supabase/server'
import { Dataset } from '@/lib/types/database'

export interface DatasetWithTableStats {
  id: string
  name: string
  role: 'source' | 'target'
  tables: TableStats[]
}

export interface TableStats {
  id: string
  name: string
  row_count: number
  field_count: number
  csv_storage_path: string | null
  created_at: string
}

export async function getDatasetsWithTables(
  projectId: string,
  role: 'source' | 'target'
): Promise<DatasetWithTableStats[]> {
  const supabase = await createClient()

  const { data: datasets, error } = await supabase
    .from('datasets')
    .select('id, name, role')
    .eq('project_id', projectId)
    .eq('role', role)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  if (!datasets || datasets.length === 0) return []

  const datasetIds = datasets.map((d) => d.id)

  // Fetch tables with field counts
  const { data: tables } = await supabase
    .from('tables')
    .select('id, name, row_count, csv_storage_path, created_at, dataset_id, fields(count)')
    .in('dataset_id', datasetIds)
    .order('created_at', { ascending: true })

  const tablesByDataset = new Map<string, TableStats[]>()
  datasetIds.forEach((id) => tablesByDataset.set(id, []))

  for (const t of tables || []) {
    const list = tablesByDataset.get(t.dataset_id) ?? []
    const fieldCountArr = t.fields as unknown as Array<{ count: number }>
    list.push({
      id: t.id,
      name: t.name,
      row_count: t.row_count ?? 0,
      field_count: fieldCountArr?.[0]?.count ?? 0,
      csv_storage_path: t.csv_storage_path,
      created_at: t.created_at,
    })
    tablesByDataset.set(t.dataset_id, list)
  }

  return datasets.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role as 'source' | 'target',
    tables: tablesByDataset.get(d.id) ?? [],
  }))
}

export async function createDataset(
  projectId: string,
  role: 'source' | 'target',
  name: string
): Promise<Dataset> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('datasets')
    .insert({ project_id: projectId, role, name })
    .select()
    .single()

  if (error || !data) throw new Error(error?.message || 'Failed to create dataset')
  return data as Dataset
}

export async function renameDataset(datasetId: string, name: string): Promise<Dataset> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('datasets')
    .update({ name })
    .eq('id', datasetId)
    .select()
    .single()

  if (error || !data) throw new Error(error?.message || 'Failed to rename dataset')
  return data as Dataset
}

export async function getTablesForDataset(datasetId: string): Promise<TableStats[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('tables')
    .select('id, name, row_count, csv_storage_path, created_at, fields(count)')
    .eq('dataset_id', datasetId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)

  return (data || []).map((t) => {
    const fieldCountArr = t.fields as unknown as Array<{ count: number }>
    return {
      id: t.id,
      name: t.name,
      row_count: t.row_count ?? 0,
      field_count: fieldCountArr?.[0]?.count ?? 0,
      csv_storage_path: t.csv_storage_path,
      created_at: t.created_at,
    }
  })
}
