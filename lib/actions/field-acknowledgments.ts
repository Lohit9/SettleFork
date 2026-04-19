'use server'

import { createClient } from '@/lib/supabase/server'
import { recomputeTableMappingStatus } from './mappings'

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

// Acknowledgment changes can shift a TM between `approved` and `needs_review`
// because TM status now requires every target AND source field to be either
// mapped or acknowledged. Recompute every TM whose target OR source table
// contains the field so the badge in the UI stays in sync without a full
// refetch.
async function recomputeAffectedTableMappings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
  fieldId: string
): Promise<void> {
  const { data: field } = await supabase
    .from('fields')
    .select('table_id')
    .eq('id', fieldId)
    .single()

  if (!field) return

  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id')
    .eq('project_id', projectId)
    .or(`target_table_id.eq.${field.table_id},source_table_id.eq.${field.table_id}`)

  for (const tm of tms ?? []) {
    await recomputeTableMappingStatus(supabase, tm.id)
  }
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

  await recomputeAffectedTableMappings(supabase, projectId, fieldId)

  // Intentionally no revalidatePath: the caller (MappingContent) already
  // does an optimistic local-state update and then a targeted refreshData()
  // on success. A layout-wide revalidate here would force a full RSC
  // re-render of the entire project layout in parallel with that refresh,
  // doubling server work and producing a visible flicker.
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

  await recomputeAffectedTableMappings(supabase, projectId, fieldId)

  // See acknowledgeField: client is responsible for its own refresh.
}
