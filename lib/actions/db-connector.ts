'use server'

import { Client } from 'pg'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/utils/encryption'
import type { DBConnectionInfo } from '@/lib/types/database'
import { computeValueDistribution, computeMinMax, countFormatIssues } from '@/lib/utils/profiling'
import { logActivity } from '@/lib/actions/activity-log'

// ── Connection helpers ────────────────────────────────────────────────────────

interface PgParams {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
}

function buildPgClient(params: PgParams): Client {
  const sslEnabled = params.sslMode !== 'disable'
  return new Client({
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    ssl: sslEnabled
      ? { rejectUnauthorized: params.sslMode === 'verify-full' || params.sslMode === 'verify-ca' }
      : false,
  })
}

function mapPgError(err: unknown): string {
  if (!(err instanceof Error)) return 'An unexpected error occurred.'
  const msg = err.message ?? ''
  const code = (err as NodeJS.ErrnoException).code ?? ''
  const pgCode = (err as { code?: string }).code ?? ''

  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'Could not connect. Verify the host and port.'
  if (code === 'ETIMEDOUT' || msg.includes('timeout')) return 'Connection timed out. Verify the host is accessible.'
  if (pgCode === '28P01') return 'Authentication failed. Check username and password.'
  if (pgCode === '3D000') return 'Database not found. Check the database name.'
  if (msg.toLowerCase().includes('ssl')) return 'SSL connection failed. Try changing SSL mode.'
  return msg
}

// ── Type mapping ──────────────────────────────────────────────────────────────

function mapPgType(
  dataType: string,
  charMaxLength: number | null,
  numericPrecision: number | null,
  numericScale: number | null
): string {
  const t = dataType.toLowerCase()
  if (t === 'character varying' || t === 'varchar') return `VARCHAR(${charMaxLength || 255})`
  if (t === 'character' || t === 'char') return `CHAR(${charMaxLength || 1})`
  if (t === 'integer' || t === 'int4' || t === 'int') return 'INTEGER'
  if (t === 'bigint' || t === 'int8') return 'BIGINT'
  if (t === 'smallint' || t === 'int2') return 'SMALLINT'
  if (t === 'numeric' || t === 'decimal') return `DECIMAL(${numericPrecision || 18},${numericScale || 2})`
  if (t === 'real' || t === 'float4') return 'REAL'
  if (t === 'double precision' || t === 'float8') return 'DOUBLE PRECISION'
  if (t === 'text') return 'TEXT'
  if (t === 'boolean' || t === 'bool') return 'BOOLEAN'
  if (t === 'timestamp without time zone' || t === 'timestamp') return 'TIMESTAMP'
  if (t === 'timestamp with time zone' || t === 'timestamptz') return 'TIMESTAMPTZ'
  if (t === 'date') return 'DATE'
  if (t === 'time' || t === 'time without time zone') return 'TIME'
  if (t === 'uuid') return 'UUID'
  if (t === 'jsonb') return 'JSONB'
  if (t === 'json') return 'JSON'
  return dataType.toUpperCase()
}

function inferSemanticType(columnName: string, dataType: string): string | null {
  const n = columnName.toLowerCase()
  const t = dataType.toLowerCase()
  const isNumeric = ['integer', 'bigint', 'smallint', 'numeric', 'decimal', 'real', 'double precision', 'int4', 'int8', 'int2', 'float4', 'float8'].includes(t)

  if (n.includes('email') || n.includes('e_mail')) return 'email'
  if (n.includes('phone') || n.includes('mobile') || n.includes('fax')) return 'phone'
  if (n.includes('url') || n.includes('website') || n.includes('link')) return 'url'
  if (isNumeric && (n.includes('price') || n.includes('amount') || n.includes('cost') || n.includes('total') || n.includes('salary') || n.includes('revenue'))) return 'currency'
  if (n === 'id' || n.endsWith('_id')) return 'id'
  return null
}

// ── Value stringification ─────────────────────────────────────────────────────

function stringifyPgValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  // Binary columns (bytea): pg returns a Buffer — don't store raw binary in JSONB
  if (Buffer.isBuffer(value)) return '[binary data]'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Array columns: pg auto-parses to JS arrays; store as JSON string
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Safely quote a PostgreSQL identifier by doubling any embedded double-quotes
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// ── 2A: testConnection ────────────────────────────────────────────────────────

export async function testConnection(params: {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
}): Promise<{ success: boolean; error?: string; tableCount?: number }> {
  const client = buildPgClient(params)
  try {
    await client.connect()
    const result = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
    return { success: true, tableCount: result.rows[0].count }
  } catch (err) {
    return { success: false, error: mapPgError(err) }
  } finally {
    await client.end().catch(() => {})
  }
}

// ── 2B: listRemoteTables ──────────────────────────────────────────────────────

export async function listRemoteTables(params: {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
}): Promise<{ success: boolean; tables?: { name: string; estimatedRows: number }[]; error?: string }> {
  const client = buildPgClient(params)
  try {
    await client.connect()
    const result = await client.query<{ name: string; estimated_rows: string }>(
      `SELECT t.table_name AS name,
         COALESCE(
           (SELECT reltuples::bigint
            FROM pg_class
            WHERE relname = t.table_name
              AND relnamespace = 'public'::regnamespace),
           0
         ) AS estimated_rows
       FROM information_schema.tables t
       WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`
    )
    const tables = result.rows.map((r) => ({
      name: r.name,
      estimatedRows: Number(r.estimated_rows),
    }))
    return { success: true, tables }
  } catch (err) {
    return { success: false, error: mapPgError(err) }
  } finally {
    await client.end().catch(() => {})
  }
}

// ── Internal: import one table from an open pg.Client ────────────────────────

interface ImportTableParams {
  client: Client
  supabase: Awaited<ReturnType<typeof createClient>>
  projectId: string
  role: 'source' | 'target'
  datasetId: string
  tableName: string
}

async function importTableFromClient({
  client, supabase, projectId, role, datasetId, tableName,
}: ImportTableParams): Promise<boolean> {
  // Schema introspection
  const [colsResult, pksResult, fksResult, checksResult] = await Promise.all([
    client.query<{
      column_name: string
      data_type: string
      character_maximum_length: number | null
      numeric_precision: number | null
      numeric_scale: number | null
      is_nullable: string
      column_default: string | null
      ordinal_position: number
    }>(
      `SELECT column_name, data_type, character_maximum_length,
         numeric_precision, numeric_scale, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    ),
    client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'`,
      [tableName]
    ),
    client.query<{ column_name: string; foreign_table: string; foreign_column: string }>(
      `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
       WHERE tc.table_schema = 'public' AND tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
      [tableName]
    ),
    client.query<{ check_clause: string; column_name: string }>(
      `SELECT cc.check_clause, ccu.column_name
       FROM information_schema.check_constraints cc
       JOIN information_schema.constraint_column_usage ccu
         ON cc.constraint_name = ccu.constraint_name
       WHERE cc.constraint_schema = 'public' AND ccu.table_name = $1
         AND cc.check_clause NOT LIKE '%IS NOT NULL%'`,
      [tableName]
    ),
  ])

  const pkSet = new Set(pksResult.rows.map((r) => r.column_name))
  const fkMap = new Map(fksResult.rows.map((r) => [r.column_name, `${r.foreign_table}.${r.foreign_column}`]))
  const checkMap = new Map(checksResult.rows.map((r) => [r.column_name, r.check_clause]))

  const fields = colsResult.rows.map((col) => {
    const dataType = mapPgType(col.data_type, col.character_maximum_length, col.numeric_precision, col.numeric_scale)
    const inferredType = inferSemanticType(col.column_name, col.data_type)
    const checkClause = checkMap.get(col.column_name) ?? null
    return {
      name: col.column_name,
      data_type: dataType,
      inferred_type: inferredType,
      is_nullable: col.is_nullable === 'YES',
      is_primary_key: pkSet.has(col.column_name),
      is_foreign_key: fkMap.has(col.column_name),
      fk_reference: fkMap.get(col.column_name) ?? null,
      ordinal_position: col.ordinal_position,
      check_constraint: checkClause ? { raw: checkClause } : null,
    }
  })

  // Delete existing record (cascade)
  const { data: existingTable } = await supabase
    .from('tables')
    .select('id')
    .eq('dataset_id', datasetId)
    .eq('name', tableName)
    .maybeSingle()
  if (existingTable) {
    await supabase.from('tables').delete().eq('id', existingTable.id)
  }

  if (colsResult.rows.length > 200) {
    console.warn(`[db-connector] Table "${tableName}" has ${colsResult.rows.length} columns (>200). Import will proceed but may be slow.`)
  }

  // Pull data rows
  const quotedTable = quoteIdentifier(tableName)
  const dataResult = await client.query(`SELECT * FROM "public".${quotedTable} LIMIT 100000`)
  const rawRows = dataResult.rows as Record<string, unknown>[]

  // Insert table row
  const { data: newTable, error: tableErr } = await supabase
    .from('tables')
    .insert({ dataset_id: datasetId, name: tableName, row_count: rawRows.length, csv_storage_path: null })
    .select()
    .single()
  if (tableErr || !newTable) {
    console.warn(`[db-connector] Failed to insert table "${tableName}":`, tableErr?.message)
    return false
  }
  const tableId = newTable.id

  // Insert fields
  const { data: createdFields, error: fieldsErr } = await supabase
    .from('fields')
    .insert(fields.map((f) => ({ ...f, table_id: tableId })))
    .select()
  if (fieldsErr || !createdFields) {
    await supabase.from('tables').delete().eq('id', tableId)
    console.warn(`[db-connector] Failed to insert fields for "${tableName}":`, fieldsErr?.message)
    return false
  }

  // Stringify + batch insert data_rows
  const stringifiedRows: Record<string, string | null>[] = rawRows.map((row) => {
    const out: Record<string, string | null> = {}
    for (const [key, val] of Object.entries(row)) {
      out[key] = stringifyPgValue(val)
    }
    return out
  })
  const BATCH_SIZE = 1000
  for (let i = 0; i < stringifiedRows.length; i += BATCH_SIZE) {
    const batch = stringifiedRows.slice(i, i + BATCH_SIZE).map((row, idx) => ({
      table_id: tableId,
      row_number: i + idx + 1,
      row_data: row,
    }))
    const { error: rowsErr } = await supabase.from('data_rows').insert(batch)
    if (rowsErr) {
      console.warn(`[db-connector] Row insert batch failed for "${tableName}":`, rowsErr.message)
      break
    }
  }

  // Field profiles
  const profiles = createdFields.map((field) => {
    const fieldValues = stringifiedRows.map((r) => r[field.name] ?? '')
    const nonNull = fieldValues.filter((v): v is string => v !== '' && v !== null)
    const valueDistribution = computeValueDistribution(nonNull)
    const sampleValues = valueDistribution.slice(0, 10).map((d) => d.value)
    const { min: minValue, max: maxValue } = computeMinMax(nonNull, field.inferred_type ?? null)
    const formatIssues = countFormatIssues(nonNull, field.data_type, field.inferred_type ?? null, field.name)
    return {
      field_id: field.id,
      total_rows: stringifiedRows.length,
      null_count: stringifiedRows.length - nonNull.length,
      null_percentage: stringifiedRows.length > 0
        ? +((((stringifiedRows.length - nonNull.length) / stringifiedRows.length) * 100).toFixed(2))
        : 0,
      cardinality: new Set(nonNull).size,
      unique_percentage: nonNull.length > 0
        ? +((new Set(nonNull).size / nonNull.length) * 100).toFixed(2)
        : 0,
      format_issues_count: formatIssues,
      min_value: minValue,
      max_value: maxValue,
      sample_values: sampleValues,
      value_distribution: valueDistribution,
    }
  })
  await supabase.from('field_profiles').insert(profiles)

  // Auto quality checks (non-fatal)
  try {
    const { runSourceDataChecks } = await import('@/lib/quality/detection-engine')
    await runSourceDataChecks(projectId, tableId, 'auto')
  } catch (detectionErr) {
    console.warn('[db-connector] Auto detection failed (non-fatal):', detectionErr)
  }

  // AI schema enrichment (non-fatal)
  try {
    const { count: docCount } = await supabase
      .from('schema_documents')
      .select('id', { count: 'exact', head: true })
      .eq('dataset_id', datasetId)
      .not('extracted_text', 'is', null)
    if ((docCount ?? 0) > 0) {
      const { enrichSchemaFromDocs } = await import('@/lib/actions/schema-enrichment')
      const enrichResult = await enrichSchemaFromDocs(datasetId, tableId)
      if (enrichResult.correctedFields > 0) {
        console.log(`[db-connector] Schema enrichment: ${enrichResult.correctedFields} field(s) corrected for "${tableName}"`)
      }
    }
  } catch (enrichErr) {
    console.warn('[db-connector] Schema enrichment failed (non-fatal):', enrichErr)
  }

  // Activity log
  const actionType = role === 'source' ? 'source_uploaded' : 'target_uploaded'
  await logActivity(
    projectId,
    actionType,
    `${role === 'source' ? 'Source' : 'Target'} data imported from PostgreSQL: ${tableName} (${rawRows.length} rows, ${fields.length} fields)`,
    'data',
    { source: 'db_connector', db_type: 'postgresql', table_name: tableName, row_count: rawRows.length, field_count: fields.length }
  )

  return true
}

// ── 2C: saveConnectionAndIntrospect ──────────────────────────────────────────

export async function saveConnectionAndIntrospect(params: {
  projectId: string
  role: 'source' | 'target'
  datasetId: string
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
  selectedTables: string[]
}): Promise<{ success: boolean; error?: string; tablesImported?: number }> {
  const { projectId, role, datasetId, selectedTables, password } = params
  const supabase = await createClient()

  // ── Step 1: Auth check ────────────────────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  // ── Step 2: Save / update connection credentials ──────────────────────────
  const { error: upsertErr } = await supabase
    .from('db_connections')
    .upsert(
      {
        project_id: projectId,
        dataset_id: datasetId,
        db_type: 'postgresql',
        host: params.host,
        port: params.port,
        database_name: params.database,
        username: params.username,
        password_encrypted: encrypt(password),
        ssl_mode: params.sslMode,
        status: 'connected',
        last_connected_at: new Date().toISOString(),
      },
      { onConflict: 'dataset_id' }
    )

  if (upsertErr) {
    return { success: false, error: 'Failed to save connection: ' + upsertErr.message }
  }

  // ── Step 3: Connect to remote database ───────────────────────────────────
  const client = buildPgClient(params)
  try {
    await client.connect()
  } catch (connErr) {
    await supabase
      .from('db_connections')
      .update({ status: 'failed' })
      .eq('dataset_id', datasetId)
    return { success: false, error: mapPgError(connErr) }
  }

  let tablesImported = 0

  try {
    for (const tableName of selectedTables) {
      try {
        const ok = await importTableFromClient({ client, supabase, projectId, role, datasetId, tableName })
        if (ok) tablesImported++
      } catch (tableErr) {
        console.warn(`[db-connector] Failed to import table "${tableName}" (continuing):`, tableErr)
      }
    }
  } finally {
    await client.end().catch(() => {})
  }

  // ── Step 5: Update connection status + revalidate ─────────────────────────
  await supabase
    .from('db_connections')
    .update({ status: 'connected', last_connected_at: new Date().toISOString() })
    .eq('dataset_id', datasetId)

  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, tablesImported }
}

// ── listTablesForConnection ───────────────────────────────────────────────────
// Like listRemoteTables, but reads credentials from a stored db_connections row

export async function listTablesForConnection(
  connectionId: string
): Promise<{ success: boolean; tables?: { name: string; estimatedRows: number }[]; error?: string }> {
  const supabase = await createClient()

  const { data: conn } = await supabase
    .from('db_connections')
    .select('host, port, database_name, username, password_encrypted, ssl_mode')
    .eq('id', connectionId)
    .single()

  if (!conn) return { success: false, error: 'Connection not found.' }

  let password: string
  try {
    password = decrypt(conn.password_encrypted)
  } catch {
    return { success: false, error: 'Failed to decrypt stored credentials.' }
  }

  return listRemoteTables({
    host: conn.host,
    port: conn.port,
    database: conn.database_name,
    username: conn.username,
    password,
    sslMode: conn.ssl_mode,
  })
}

// ── getConnectionForDataset ───────────────────────────────────────────────────

export async function getConnectionForDataset(
  datasetId: string
): Promise<{ connection: DBConnectionInfo | null }> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('db_connections')
    .select('id, db_type, host, port, database_name, username, ssl_mode, status, last_connected_at')
    .eq('dataset_id', datasetId)
    .maybeSingle()

  if (!data) return { connection: null }
  return { connection: data as DBConnectionInfo }
}

// ── disconnectDatabase ────────────────────────────────────────────────────────

export async function disconnectDatabase(
  datasetId: string,
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  // Delete all tables for this dataset (cascades to fields, data_rows, field_profiles)
  const { error: tablesErr } = await supabase
    .from('tables')
    .delete()
    .eq('dataset_id', datasetId)

  if (tablesErr) {
    return { success: false, error: 'Failed to delete imported tables: ' + tablesErr.message }
  }

  // Delete the connection record
  const { error: connErr } = await supabase
    .from('db_connections')
    .delete()
    .eq('dataset_id', datasetId)

  if (connErr) {
    return { success: false, error: 'Failed to delete connection: ' + connErr.message }
  }

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true }
}

// ── resyncTables ──────────────────────────────────────────────────────────────

export async function resyncTables(params: {
  connectionId: string
  datasetId: string
  projectId: string
  role: 'source' | 'target'
  tableNames: string[]
}): Promise<{ success: boolean; error?: string; tablesImported?: number }> {
  const { connectionId, datasetId, projectId, role, tableNames } = params
  const supabase = await createClient()

  // Load stored credentials (with password)
  const { data: conn } = await supabase
    .from('db_connections')
    .select('host, port, database_name, username, password_encrypted, ssl_mode')
    .eq('id', connectionId)
    .single()

  if (!conn) return { success: false, error: 'Connection not found.' }

  let password: string
  try {
    password = decrypt(conn.password_encrypted)
  } catch {
    return { success: false, error: 'Failed to decrypt stored credentials.' }
  }

  const pgParams: PgParams = {
    host: conn.host,
    port: conn.port,
    database: conn.database_name,
    username: conn.username,
    password,
    sslMode: conn.ssl_mode,
  }

  const client = buildPgClient(pgParams)
  try {
    await client.connect()
  } catch (connErr) {
    await supabase
      .from('db_connections')
      .update({ status: 'failed' })
      .eq('id', connectionId)
    return { success: false, error: mapPgError(connErr) }
  }

  let tablesImported = 0
  try {
    for (const tableName of tableNames) {
      try {
        const ok = await importTableFromClient({ client, supabase, projectId, role, datasetId, tableName })
        if (ok) tablesImported++
      } catch (tableErr) {
        console.warn(`[db-connector] resync failed for "${tableName}" (continuing):`, tableErr)
      }
    }
  } finally {
    await client.end().catch(() => {})
  }

  await supabase
    .from('db_connections')
    .update({ status: 'connected', last_connected_at: new Date().toISOString() })
    .eq('id', connectionId)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true, tablesImported }
}
