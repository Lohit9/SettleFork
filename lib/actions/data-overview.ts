'use server'

import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

export type CheckConstraint =
  | { type: 'in_list'; allowedValues: string[]; raw: string }
  | { type: 'regex'; pattern: string; raw: string }
  | { type: 'range'; min?: number; max?: number; raw: string }
  | { type: 'custom'; raw: string }

export interface FieldData {
  id: string
  name: string
  data_type: string
  inferred_type: string | null
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  ordinal_position: number
  schema_source: 'inferred' | 'doc_enriched' | 'manual'
  check_constraint: CheckConstraint | null
}

export interface TableData {
  id: string
  name: string
  row_count: number
  fields: FieldData[]
}

export interface DatasetSchemaData {
  id: string
  name: string
  role: 'source' | 'target'
  tables: TableData[]
}

export interface ProjectSchema {
  source: DatasetSchemaData[]
  target: DatasetSchemaData[]
}

export interface TableOption {
  id: string
  name: string
  friendlyName: string
  datasetId: string
  datasetName: string
  role: 'source' | 'target'
  row_count: number
  fieldNames: string[]
}

export interface ProfilingData {
  table: { id: string; name: string; row_count: number }
  fields: Array<{
    id: string
    name: string
    data_type: string
    null_percentage: number
    cardinality: number
    unique_percentage: number
    format_issues_count: number
    ordinal_position: number
  }>
  totalFormatIssues: number
}

// ─── Schema fetch ─────────────────────────────────────────────────────────────

export async function getProjectSchema(projectId: string): Promise<ProjectSchema> {
  const supabase = await createClient()

  // Single nested query — 1 round trip instead of 3 sequential ones
  const { data: datasets, error } = await supabase
    .from('datasets')
    .select(`
      id, name, role,
      tables (
        id, dataset_id, name, row_count,
        fields (
          id, table_id, name, data_type, inferred_type,
          is_nullable, is_primary_key, is_foreign_key,
          fk_reference, ordinal_position, schema_source,
          check_constraint
        )
      )
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  if (!datasets?.length) return { source: [], target: [] }

  const result = datasets.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role as 'source' | 'target',
    tables: ((d.tables as Array<{
      id: string; dataset_id: string; name: string; row_count: number | null
      fields: Array<{
        id: string; table_id: string; name: string; data_type: string
        inferred_type: string | null; is_nullable: boolean; is_primary_key: boolean
        is_foreign_key: boolean; fk_reference: string | null; ordinal_position: number
        schema_source: string | null; check_constraint: CheckConstraint | null
      }>
    }>) ?? [])
      .map((t) => ({
        id: t.id,
        name: t.name,
        row_count: t.row_count ?? 0,
        fields: (t.fields ?? [])
          .sort((a, b) => a.ordinal_position - b.ordinal_position)
          .map((f) => ({
            id: f.id,
            name: f.name,
            data_type: f.data_type,
            inferred_type: f.inferred_type,
            is_nullable: f.is_nullable,
            is_primary_key: f.is_primary_key,
            is_foreign_key: f.is_foreign_key,
            fk_reference: f.fk_reference,
            ordinal_position: f.ordinal_position,
            schema_source: (f.schema_source as 'inferred' | 'doc_enriched' | 'manual') ?? 'inferred',
            check_constraint: (f.check_constraint as CheckConstraint | null) ?? null,
          })),
      })),
  }))

  return {
    source: result.filter((d) => d.role === 'source'),
    target: result.filter((d) => d.role === 'target'),
  }
}

// ─── All tables for dropdown ──────────────────────────────────────────────────

export async function getAllTablesForProject(projectId: string): Promise<TableOption[]> {
  const supabase = await createClient()

  // Single nested query — datasets → tables → fields in one round trip
  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, name, role, tables(id, dataset_id, name, row_count, friendly_name, fields(table_id, name, ordinal_position))')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (!datasets?.length) return []

  const datasetMap = new Map(datasets.map((d) => [d.id, d]))

  const tables = datasets.flatMap((d) =>
    (d.tables as Array<{ id: string; dataset_id: string; name: string; row_count: number | null; friendly_name: string | null; fields: Array<{ table_id: string; name: string; ordinal_position: number }> }>) ?? []
  )

  if (!tables.length) return []

  const fieldNamesByTable = new Map<string, string[]>()
  for (const t of tables) {
    const sortedFields = (t.fields ?? []).sort((a, b) => a.ordinal_position - b.ordinal_position)
    fieldNamesByTable.set(t.id, sortedFields.map((f) => f.name))
  }

  return tables.map((t) => {
    const ds = datasetMap.get(t.dataset_id)!
    const friendlyName =
      t.friendly_name ??
      `${ds.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.${t.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
    return {
      id: t.id,
      name: t.name,
      friendlyName,
      datasetId: t.dataset_id,
      datasetName: ds.name,
      role: ds.role as 'source' | 'target',
      row_count: t.row_count ?? 0,
      fieldNames: fieldNamesByTable.get(t.id) ?? [],
    }
  })
}

// ─── Data preview ─────────────────────────────────────────────────────────────

export async function getDataPreview(
  tableId: string,
  page: number = 1,
  pageSize: number = 10
): Promise<{ rows: Record<string, unknown>[]; totalRows: number }> {
  const supabase = await createClient()

  const { count } = await supabase
    .from('data_rows')
    .select('id', { count: 'exact', head: true })
    .eq('table_id', tableId)

  const offset = (page - 1) * pageSize
  const { data, error } = await supabase
    .from('data_rows')
    .select('row_data')
    .eq('table_id', tableId)
    .order('row_number', { ascending: true })
    .range(offset, offset + pageSize - 1)

  if (error) throw new Error(error.message)

  return {
    rows: (data || []).map((r) => r.row_data as Record<string, unknown>),
    totalRows: count ?? 0,
  }
}

// ─── Field profiles ───────────────────────────────────────────────────────────

export async function getFieldProfiles(tableId: string): Promise<ProfilingData | null> {
  const supabase = await createClient()

  const { data: table } = await supabase
    .from('tables')
    .select('id, name, row_count')
    .eq('id', tableId)
    .single()

  if (!table) return null

  const { data: fields } = await supabase
    .from('fields')
    .select('id, name, data_type, ordinal_position')
    .eq('table_id', tableId)
    .order('ordinal_position', { ascending: true })

  if (!fields?.length) return { table, fields: [], totalFormatIssues: 0 }

  const fieldIds = fields.map((f) => f.id)
  const { data: profiles } = await supabase
    .from('field_profiles')
    .select('field_id, null_percentage, cardinality, unique_percentage, format_issues_count')
    .in('field_id', fieldIds)

  const profileByFieldId = new Map((profiles || []).map((p) => [p.field_id, p]))

  const enriched = fields.map((f) => {
    const p = profileByFieldId.get(f.id)
    return {
      id: f.id,
      name: f.name,
      data_type: f.data_type,
      ordinal_position: f.ordinal_position,
      null_percentage: p?.null_percentage ?? 0,
      cardinality: p?.cardinality ?? 0,
      unique_percentage: p?.unique_percentage ?? 0,
      format_issues_count: p?.format_issues_count ?? 0,
    }
  })

  return {
    table,
    fields: enriched,
    totalFormatIssues: enriched.reduce((s, f) => s + f.format_issues_count, 0),
  }
}

// ─── Schema context for AI (includes sample values from profiles) ─────────────

export interface FieldWithSamples {
  name: string
  data_type: string
  inferred_type: string | null
  sample_values: unknown[]
}

export async function getTableSchemaContext(tableId: string): Promise<{
  tableName: string
  datasetName: string
  fields: FieldWithSamples[]
} | null> {
  const supabase = await createClient()

  const { data: table } = await supabase
    .from('tables')
    .select('id, name, dataset_id, datasets(name)')
    .eq('id', tableId)
    .single()

  if (!table) return null

  const { data: fields } = await supabase
    .from('fields')
    .select('id, name, data_type, inferred_type, ordinal_position')
    .eq('table_id', tableId)
    .order('ordinal_position', { ascending: true })

  if (!fields?.length) return null

  const fieldIds = fields.map((f) => f.id)
  const { data: profiles } = await supabase
    .from('field_profiles')
    .select('field_id, sample_values')
    .in('field_id', fieldIds)

  const samplesByField = new Map((profiles || []).map((p) => [p.field_id, p.sample_values]))

  const ds = table.datasets as unknown as { name: string } | null

  return {
    tableName: table.name,
    datasetName: ds?.name ?? 'Unknown',
    fields: fields.map((f) => ({
      name: f.name,
      data_type: f.data_type,
      inferred_type: f.inferred_type,
      sample_values: (samplesByField.get(f.id) as unknown[]) ?? [],
    })),
  }
}
