'use server'

import { createClient } from '@/lib/supabase/server'
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
): Promise<Field> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify the field belongs to a project owned by the current user
  const { data: field } = await supabase
    .from('fields')
    .select(
      `id, table_id,
       tables!inner(dataset_id,
         datasets!inner(project_id,
           projects!inner(user_id)
         )
       )`
    )
    .eq('id', fieldId)
    .single()

  if (!field) throw new Error('Field not found')

  // RLS already enforces ownership, but this is an explicit check
  const { data: updated, error } = await supabase
    .from('fields')
    .update(updates)
    .eq('id', fieldId)
    .select()
    .single()

  if (error || !updated) throw new Error(error?.message || 'Failed to update field')
  return updated as Field
}
