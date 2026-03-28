'use server'

import { createClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'

export interface FieldAcknowledgment {
  id: string
  project_id: string
  field_id: string
  side: 'source' | 'target'
  reason: string
  notes: string | null
  acknowledged_by: string | null
  acknowledged_at: string
}

export async function acknowledgeField(
  projectId: string,
  fieldId: string,
  side: 'source' | 'target',
  reason: string,
  notes?: string
): Promise<FieldAcknowledgment> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data, error } = await supabase
    .from('field_acknowledgments')
    .upsert(
      {
        project_id: projectId,
        field_id: fieldId,
        side,
        reason,
        notes: notes ?? null,
        acknowledged_by: user?.id,
        acknowledged_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,field_id' }
    )
    .select()
    .single()

  if (error) throw new Error(`Failed to acknowledge field: ${error.message}`)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return data as FieldAcknowledgment
}

export async function removeAcknowledgment(
  projectId: string,
  fieldId: string
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('field_acknowledgments')
    .delete()
    .eq('project_id', projectId)
    .eq('field_id', fieldId)

  if (error) throw new Error(`Failed to remove acknowledgment: ${error.message}`)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
}
