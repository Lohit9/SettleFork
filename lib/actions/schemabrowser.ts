'use server'

import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'

// Lazy per-table column-name fetch for the setup-page schema browser.
// Read-only; RLS scopes to the caller's org, while the project-permission check
// plus the dataset join prevent reading tables outside the named project.
export interface SchemaField {
  id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key: boolean
}

export async function getTableFields(
  projectId: string,
  tableId: string
): Promise<SchemaField[]> {
  const { allowed, error: permError } = await requireProjectPermission(projectId, 'viewer')
  if (!allowed) throw new Error(permError ?? 'Not authorized to view this project')

  const supabase = await createClient()

  const { data: table } = await supabase
    .from('tables')
    .select('id, datasets!inner(project_id)')
    .eq('id', tableId)
    .eq('datasets.project_id', projectId)
    .maybeSingle()

  if (!table) return []

  const { data, error } = await supabase
    .from('fields')
    .select('id, name, data_type, is_nullable, is_primary_key, ordinal_position')
    .eq('table_id', tableId)
    .order('ordinal_position', { ascending: true })
    .limit(500)

  if (error) throw new Error(error.message)
  return (data ?? []).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    data_type: (f.data_type as string) ?? '',
    is_nullable: (f.is_nullable as boolean) ?? true,
    is_primary_key: (f.is_primary_key as boolean) ?? false,
  }))
}
