import type { SupabaseClient } from '@supabase/supabase-js'

// Resolves a default `table_mapping_id` for ack-style TFM writers — Path D
// persistence, static-config target acknowledgments, approve-all unmapped-target
// fanouts — that create acknowledgment rows with no natural source table to
// bind to.
//
// The rule mirrors backfill #2 in migration 107: pick the TM for the target
// field's table whose (created_at, id) is lowest. This keeps ack rows bound
// to the same partition the migration would have picked, preserving the
// metadata-only invariant for N=1 projects (all roads lead to the same TM)
// and the deterministic default for N>1 projects (PR Ω.3 introduces explicit
// per-partition ack UX).
//
// Returns null when no TM exists for the target field's table. Caller decides
// whether that's a hard error (Path D, static-config) or a skip (approve-all).
export async function resolveDefaultTableMappingForTargetField(
  supabase: SupabaseClient,
  projectId: string,
  targetFieldId: string,
): Promise<string | null> {
  const { data: targetField, error: fieldErr } = await supabase
    .from('fields')
    .select('table_id')
    .eq('id', targetFieldId)
    .single<{ table_id: string }>()
  if (fieldErr || !targetField) return null

  const { data: tm } = await supabase
    .from('table_mappings')
    .select('id, created_at')
    .eq('project_id', projectId)
    .eq('target_table_id', targetField.table_id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string; created_at: string }>()

  return tm?.id ?? null
}

// Bulk variant: resolves the default TM for many target_field_ids in one
// round-trip. Returns a Map keyed by target_field_id.
//
// Path D and static-config writers process N target fields per call; a per-row
// roundtrip would multiply their write latency. This batches the fields→table
// resolution and TM lookup into two queries total, regardless of N.
export async function resolveDefaultTableMappingsForTargetFields(
  supabase: SupabaseClient,
  projectId: string,
  targetFieldIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (targetFieldIds.length === 0) return out

  const { data: fields } = await supabase
    .from('fields')
    .select('id, table_id')
    .in('id', targetFieldIds)
  const tableIdByFieldId = new Map<string, string>()
  for (const f of fields ?? []) {
    tableIdByFieldId.set(f.id as string, f.table_id as string)
  }
  const uniqueTableIds = Array.from(new Set(tableIdByFieldId.values()))
  if (uniqueTableIds.length === 0) return out

  const { data: tms } = await supabase
    .from('table_mappings')
    .select('id, target_table_id, created_at')
    .eq('project_id', projectId)
    .in('target_table_id', uniqueTableIds)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })

  const tmIdByTableId = new Map<string, string>()
  for (const tm of tms ?? []) {
    const ttid = tm.target_table_id as string
    if (!tmIdByTableId.has(ttid)) tmIdByTableId.set(ttid, tm.id as string)
  }

  for (const fid of targetFieldIds) {
    const tableId = tableIdByFieldId.get(fid)
    if (!tableId) continue
    const tmId = tmIdByTableId.get(tableId)
    if (tmId) out.set(fid, tmId)
  }
  return out
}
