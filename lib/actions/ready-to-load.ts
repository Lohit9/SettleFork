'use server'

/**
 * Ready-to-Load view — pipeline stage ⑤.
 *
 * Per target table, the materialized loadable records, in the customer
 * answer-key shape:
 *   • Row 1  — target field names
 *   • Row 2  — the source mapping per field (source expr / coalesce / constant)
 *   • Rows 3+ — the actual transformed data
 *
 * Two modes: `annotated` (header rows + data, for review) and clean
 * (data only, for the actual load). Data comes from `staged_data_rows`
 * (transforms already applied by the Transform stage) — no re-execution
 * here. The header rows reuse the Map & Transform spec (stage ③).
 */

import { supabaseAdmin } from '@/lib/supabase/admin'
import { getMapTransformSpec, type MapTransformSpecRow } from '@/lib/actions/map-transform-spec'
import { requireProjectPermission } from '@/lib/actions/role-resolution'

export interface ReadyToLoadTable {
  targetTable: string
  /** Row 1: target field names, in table order. */
  targetFields: string[]
  /** Row 2: per-field source mapping (e.g. "Products.ProductSKU | BOM.Assy Item", "(constant)"). */
  sourceMapping: string[]
  /** Rows 3+: transformed records (clean load data). */
  rows: Record<string, unknown>[]
  /** Count of the returned page (=== rows.length). */
  rowCount: number
  /** Total staged rows for this table, independent of the returned page — bind the grid header to this. */
  totalRowCount: number
  /** True when staged data exists; false = mapping defined but transforms not yet run. */
  materialized: boolean
}

// ─── Pure header assembly (unit-tested) ────────────────────────────────────────

/** Build the two header rows for one target table from its spec rows. */
export function buildHeaderRows(specForTable: MapTransformSpecRow[]): {
  targetFields: string[]
  sourceMapping: string[]
} {
  const targetFields = specForTable.map((r) => r.targetField)
  const sourceMapping = specForTable.map((r) => {
    if (r.kind === 'unmapped') return '(unmapped)'
    if (r.kind === 'acknowledged') return '(constant)'
    if (r.kind === 'value_assignment') return '(value assignment)'
    return r.sourceField ?? '(constant)'
  })
  return { targetFields, sourceMapping }
}

// ─── Server action ─────────────────────────────────────────────────────────────

export async function getReadyToLoadView(
  projectId: string,
  opts?: { rowLimit?: number; offset?: number },
): Promise<ReadyToLoadTable[]> {
  const perm = await requireProjectPermission(projectId, 'viewer')
  if (!perm.allowed) throw new Error(perm.error ?? 'Insufficient permissions')

  const rowLimit = opts?.rowLimit ?? 500
  const offset = opts?.offset ?? 0

  const spec = await getMapTransformSpec(projectId)
  if (spec.length === 0) return []

  // Group spec rows by target table, preserving field order.
  const specByTable = new Map<string, MapTransformSpecRow[]>()
  for (const r of spec) {
    const arr = specByTable.get(r.targetTable) ?? []
    arr.push(r)
    specByTable.set(r.targetTable, arr)
  }

  // Resolve target-table name → table_mapping_id (staged_data_rows are keyed
  // by table_mapping_id). Two explicit queries — no FK-name-dependent embed.
  const { data: tmRows } = await supabaseAdmin
    .from('table_mappings')
    .select('id, target_table_id')
    .eq('project_id', projectId)
  const targetTableIds = [...new Set((tmRows ?? []).map((t) => t.target_table_id))]
  const { data: tblRows } = targetTableIds.length
    ? await supabaseAdmin.from('tables').select('id, name').in('id', targetTableIds)
    : { data: [] as { id: string; name: string }[] }
  const tableNameById = new Map((tblRows ?? []).map((t) => [t.id, t.name]))
  const tmIdByTableName = new Map<string, string>()
  for (const tm of tmRows ?? []) {
    const name = tableNameById.get(tm.target_table_id)
    if (name) tmIdByTableName.set(name, tm.id)
  }

  const out: ReadyToLoadTable[] = []
  for (const [targetTable, specForTable] of specByTable) {
    const { targetFields, sourceMapping } = buildHeaderRows(specForTable)

    let rows: Record<string, unknown>[] = []
    let totalRowCount = 0
    const tmId = tmIdByTableName.get(targetTable)
    if (tmId) {
      const { data: staged, count } = await supabaseAdmin
        .from('staged_data_rows')
        .select('transformed_row_data', { count: 'exact' })
        .eq('table_mapping_id', tmId)
        .order('row_number')
        .range(offset, offset + rowLimit - 1)
      rows = (staged ?? []).map((s) => s.transformed_row_data as Record<string, unknown>)
      totalRowCount = count ?? rows.length
    }

    out.push({
      targetTable,
      targetFields,
      sourceMapping,
      rows,
      rowCount: rows.length,
      totalRowCount,
      materialized: totalRowCount > 0,
    })
  }
  return out
}
