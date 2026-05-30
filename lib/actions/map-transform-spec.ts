'use server'

/**
 * Map & Transform spec — the combined output of pipeline stage ③.
 *
 * One row per target field: source → target, the transformation, a plain-
 * English explanation, and confidence. Derived entirely from already-
 * persisted mapping data (no LLM call) via `hydrateProjectData`. This is the
 * 7-column spec that backs the Map page and matches the customer answer-key
 * format (Source Table · Source Field · Target Table · Target Field ·
 * Transformation · Explanation · Confidence).
 *
 * Mapping and transformation are one concept here: a mapping's transform
 * (coalesce / concat / custom SQL) is described inline, not in a separate
 * stage. See docs/proposals — stage ③ unifies Map & Transform.
 */

import { hydrateProjectData } from '@/lib/actions/_outputs-core'

export type SpecRowKind = 'mapped' | 'value_assignment' | 'acknowledged' | 'unmapped'

export interface MapTransformSpecRow {
  sourceTable: string | null
  sourceField: string | null
  targetTable: string
  targetField: string
  transformation: string
  explanation: string
  confidence: number | null
  kind: SpecRowKind
  /** Raw SQL behind `transformation`, for the UI's "show SQL" affordance. */
  transformSql: string | null
}

// ─── Pure shaping core (no I/O — unit-tested directly) ─────────────────────────

export interface SpecTfm {
  id: string
  target_field_id: string
  confidence: number | null
  ai_reasoning: string | null
  is_acknowledged: boolean | null
  acknowledgment_reason: string | null
  combination_type: string | null
  combination_sql: string | null
  needs_transformation: boolean | null
}
export interface SpecSource {
  target_field_mapping_id: string
  source_field_id: string
  source_table_id: string
  ordinal: number | null
}
export interface SpecField { id: string; table_id: string; name: string; ordinal_position: number | null }
export interface SpecTable { id: string; name: string }

interface SpecInput {
  targetTables: SpecTable[]
  targetFields: SpecField[]
  tfms: SpecTfm[]
  sources: SpecSource[]
  tableNameById: Map<string, string>
  fieldNameById: Map<string, string>
}

function humanizeTransform(tfm: SpecTfm, sourceExprs: string[]): string {
  if (tfm.is_acknowledged) return 'Acknowledged — no source (constant / supplied later)'
  const ct = tfm.combination_type
  const sql = tfm.combination_sql ?? null
  if (ct === 'concat_space') return `Concatenate (space): ${sourceExprs.join(' + ')}`
  if (ct === 'concat_comma') return `Concatenate (comma): ${sourceExprs.join(', ')}`
  if (ct === 'custom_sql' && sql) {
    if (/coalesce/i.test(sql)) return `Coalesce (primary, then fallback): ${sourceExprs.join(' | ')}`
    if (/case\s+when/i.test(sql)) return `Conditional rule: ${sourceExprs.join(', ')}`
    return `Custom transform: ${sourceExprs.join(', ')}`
  }
  if (tfm.needs_transformation) return sql ? `Transform: ${sourceExprs[0] ?? ''}` : 'Transform required'
  return 'Direct copy'
}

/** Build the spec rows from already-fetched, name-resolved inputs. Pure. */
export function buildSpecRows(input: SpecInput): MapTransformSpecRow[] {
  const tfmByTarget = new Map<string, SpecTfm>()
  for (const t of input.tfms) tfmByTarget.set(t.target_field_id, t)

  const sourcesByTfm = new Map<string, SpecSource[]>()
  for (const s of input.sources) {
    const arr = sourcesByTfm.get(s.target_field_mapping_id) ?? []
    arr.push(s)
    sourcesByTfm.set(s.target_field_mapping_id, arr)
  }

  const rows: MapTransformSpecRow[] = []
  const targetTableName = (id: string) => input.tableNameById.get(id) ?? 'unknown'

  const sortedTargets = [...input.targetFields].sort(
    (a, b) => (a.ordinal_position ?? 0) - (b.ordinal_position ?? 0),
  )

  for (const tf of sortedTargets) {
    const tfm = tfmByTarget.get(tf.id)
    const targetTable = targetTableName(tf.table_id)

    if (!tfm) {
      rows.push({
        sourceTable: null, sourceField: null, targetTable, targetField: tf.name,
        transformation: '—', explanation: 'No source mapped to this target field.',
        confidence: null, kind: 'unmapped', transformSql: null,
      })
      continue
    }

    const srcs = (sourcesByTfm.get(tfm.id) ?? []).sort(
      (a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0),
    )
    const sourceExprs = srcs.map((s) => {
      const fname = input.fieldNameById.get(s.source_field_id) ?? '?'
      const tname = input.tableNameById.get(s.source_table_id) ?? '?'
      return `${tname}.${fname}`
    })

    const kind: SpecRowKind =
      srcs.length > 0 ? 'mapped'
      : tfm.combination_type === 'custom_sql' ? 'value_assignment'
      : tfm.is_acknowledged ? 'acknowledged'
      : 'unmapped'

    const primary = srcs[0]
    const transformation = humanizeTransform(tfm, sourceExprs)
    const mappingReason = tfm.ai_reasoning ?? tfm.acknowledgment_reason ?? ''
    const explanation =
      transformation === 'Direct copy' || transformation === '—'
        ? mappingReason || 'Direct field mapping.'
        : `${mappingReason ? mappingReason + ' ' : ''}Transformation: ${transformation}.`.trim()

    rows.push({
      sourceTable: primary ? input.tableNameById.get(primary.source_table_id) ?? null : null,
      sourceField: srcs.length > 1 ? sourceExprs.join(' | ') : sourceExprs[0] ?? null,
      targetTable,
      targetField: tf.name,
      transformation,
      explanation,
      confidence: tfm.confidence,
      kind,
      transformSql: tfm.combination_sql,
    })
  }
  return rows
}

// ─── Server action ─────────────────────────────────────────────────────────────

export async function getMapTransformSpec(projectId: string): Promise<MapTransformSpecRow[]> {
  const data = await hydrateProjectData(projectId)
  if (!data) return []

  const targetDatasetIds = new Set(
    data.datasets.filter((d) => d.role === 'target').map((d) => d.id),
  )
  const targetTables = data.tables.filter((t) => targetDatasetIds.has(t.dataset_id))
  const targetTableIds = new Set(targetTables.map((t) => t.id))
  const targetFields = data.fields.filter((f) => targetTableIds.has(f.table_id))

  return buildSpecRows({
    targetTables: targetTables.map((t) => ({ id: t.id, name: t.name })),
    targetFields: targetFields.map((f) => ({
      id: f.id, table_id: f.table_id, name: f.name, ordinal_position: f.ordinal_position ?? null,
    })),
    tfms: data.targetFieldMappings.map((t) => ({
      id: t.id, target_field_id: t.target_field_id, confidence: t.confidence,
      ai_reasoning: t.ai_reasoning, is_acknowledged: t.is_acknowledged,
      acknowledgment_reason: t.acknowledgment_reason, combination_type: t.combination_type,
      combination_sql: t.combination_sql, needs_transformation: t.needs_transformation,
    })),
    sources: data.mappingSources
      .filter((s) => s.source_field_id && s.source_table_id)
      .map((s) => ({
        target_field_mapping_id: s.target_field_mapping_id,
        source_field_id: s.source_field_id as string,
        source_table_id: s.source_table_id as string,
        ordinal: s.ordinal,
      })),
    tableNameById: new Map(data.tables.map((t) => [t.id, t.name])),
    fieldNameById: new Map(data.fields.map((f) => [f.id, f.name])),
  })
}
