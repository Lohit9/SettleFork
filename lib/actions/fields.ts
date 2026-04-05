'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { Field } from '@/lib/types/database'

export async function updateField(
  fieldId: string,
  updates: {
    name?: string
    data_type?: string
    inferred_type?: string | null
    is_nullable?: boolean
    is_primary_key?: boolean
    is_foreign_key?: boolean
    fk_reference?: string | null
  }
): Promise<{ success: boolean; data?: Field; error?: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { data: fieldLookup } = await supabaseAdmin
    .from('fields')
    .select('id, tables!inner(datasets!inner(project_id))')
    .eq('id', fieldId)
    .single()
  if (!fieldLookup) return { success: false, error: 'Field not found' }
  const projectId = (fieldLookup as any).tables.datasets.project_id
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }

  // Mark as manually edited — manual takes precedence over doc_enriched or inferred
  const { data: updated, error } = await supabase
    .from('fields')
    .update({ ...updates, schema_source: 'manual' })
    .eq('id', fieldId)
    .select()
    .single()

  if (error || !updated) return { success: false, error: error?.message || 'Failed to update field' }
  return { success: true, data: updated as Field }
}
