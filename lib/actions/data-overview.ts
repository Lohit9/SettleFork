'use server'

import { createClient } from '@/lib/supabase/server'

// ─── Types ────────────────────────────────────────────────────────────────────

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

  const { data: datasets, error } = await supabase
    .from('datasets')
    .select('id, name, role')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  if (!datasets?.length) return { source: [], target: [] }

  const datasetIds = datasets.map((d) => d.id)

  const { data: tables } = await supabase
    .from('tables')
    .select('id, dataset_id, name, row_count')
    .in('dataset_id', datasetIds)
    .order('created_at', { ascending: true })

  if (!tables?.length) {
    return {
      source: datasets
        .filter((d) => d.role === 'source')
        .map((d) => ({ ...d, role: 'source' as const, tables: [] })),
      target: datasets
        .filter((d) => d.role === 'target')
        .map((d) => ({ ...d, role: 'target' as const, tables: [] })),
    }
  }

  const tableIds = tables.map((t) => t.id)

  const { data: fields } = await supabase
    .from('fields')
    .select('id, table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position, schema_source')
    .in('table_id', tableIds)
    .order('ordinal_position', { ascending: true })

  const fieldsByTable = new Map<string, FieldData[]>()
  for (const f of fields || []) {
    const list = fieldsByTable.get(f.table_id) ?? []
    list.push({
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
    })
    fieldsByTable.set(f.table_id, list)
  }

  const tablesByDataset = new Map<string, TableData[]>()
  for (const t of tables) {
    const list = tablesByDataset.get(t.dataset_id) ?? []
    list.push({
      id: t.id,
      name: t.name,
      row_count: t.row_count ?? 0,
      fields: fieldsByTable.get(t.id) ?? [],
    })
    tablesByDataset.set(t.dataset_id, list)
  }

  const result = datasets.map((d) => ({
    id: d.id,
    name: d.name,
    role: d.role as 'source' | 'target',
    tables: tablesByDataset.get(d.id) ?? [],
  }))

  return {
    source: result.filter((d) => d.role === 'source'),
    target: result.filter((d) => d.role === 'target'),
  }
}

// ─── All tables for dropdown ──────────────────────────────────────────────────

export async function getAllTablesForProject(projectId: string): Promise<TableOption[]> {
  const supabase = await createClient()

  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, name, role')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (!datasets?.length) return []

  const datasetIds = datasets.map((d) => d.id)

  const { data: tables } = await supabase
    .from('tables')
    .select('id, dataset_id, name, row_count, friendly_name')
    .in('dataset_id', datasetIds)
    .order('name', { ascending: true })

  if (!tables?.length) return []

  const tableIds = tables.map((t) => t.id)

  const { data: fields } = await supabase
    .from('fields')
    .select('table_id, name')
    .in('table_id', tableIds)
    .order('ordinal_position', { ascending: true })

  const fieldNamesByTable = new Map<string, string[]>()
  for (const f of fields || []) {
    const list = fieldNamesByTable.get(f.table_id) ?? []
    list.push(f.name)
    fieldNamesByTable.set(f.table_id, list)
  }

  const datasetMap = new Map(datasets.map((d) => [d.id, d]))

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
