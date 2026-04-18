'use server'

import { Client } from 'pg'
import sql from 'mssql'
import mysql from 'mysql2/promise'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireProjectPermission } from '@/lib/actions/role-resolution'
import { encrypt, decrypt } from '@/lib/utils/encryption'
import type { DBConnectionInfo } from '@/lib/types/database'
import { computeValueDistribution, computeMinMax, countFormatIssues } from '@/lib/utils/profiling'
import { logActivity } from '@/lib/actions/activity-log'
import { parseCheckConstraint } from '@/lib/parsers/ddl-parser'

// ── PostgreSQL connection helpers ─────────────────────────────────────────────

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

// ── MS SQL connection helpers ─────────────────────────────────────────────────

interface MssqlParams {
  host: string
  port: number
  database: string
  username: string
  password: string
  encrypt: boolean
  trustServerCertificate: boolean
}

function buildMssqlConfig(params: MssqlParams): sql.config {
  return {
    server: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    connectionTimeout: 10000,
    requestTimeout: 30000,
    options: {
      encrypt: params.encrypt,
      trustServerCertificate: params.trustServerCertificate,
    },
  }
}

function mapMssqlError(error: unknown): string {
  if (!(error instanceof Error)) return 'An unexpected error occurred.'
  const msg = error.message || ''
  const code = (error as { code?: string | number; number?: number }).code
    ?? (error as { number?: number }).number
    ?? ''

  if (msg.includes('ECONNREFUSED') || msg.includes('ESOCKET') || msg.includes('Failed to connect'))
    return 'Could not connect. Verify the host and port are accessible.'
  if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo'))
    return 'Could not resolve host. Verify the hostname.'
  if (msg.includes('ETIMEDOUT') || msg.includes('Connection timeout'))
    return 'Connection timed out. Verify the host is accessible.'
  if (code === 18456 || msg.includes('Login failed'))
    return 'Authentication failed. Check username and password.'
  if (code === 4060 || msg.includes('Cannot open database'))
    return 'Database not found. Check the database name.'
  if (msg.includes('SSL') || msg.includes('encrypt') || msg.includes('certificate'))
    return 'Encryption error. Try toggling the encryption setting.'
  return msg || 'An unknown error occurred.'
}

// ── MySQL connection helpers ──────────────────────────────────────────────────

interface MysqlParams {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string  // 'require' | 'disable' | 'verify-ca' | 'verify-full'
}

async function buildMysqlConnection(params: MysqlParams): Promise<mysql.Connection> {
  const sslConfig = params.sslMode === 'disable'
    ? undefined
    : { rejectUnauthorized: params.sslMode === 'verify-full' || params.sslMode === 'verify-ca' }

  return mysql.createConnection({
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    ssl: sslConfig,
    connectTimeout: 10000,
  })
}

function mapMysqlError(error: unknown): string {
  if (!(error instanceof Error)) return 'An unexpected error occurred.'
  const err = error as Error & { code?: string; errno?: number }
  const code = err.code ?? ''
  const errno = err.errno ?? 0
  const msg = err.message ?? ''

  if (code === 'ECONNREFUSED' || code === 'ESOCKET')
    return 'Could not connect. Verify the host and port are accessible.'
  if (code === 'ENOTFOUND')
    return 'Could not resolve host. Verify the hostname.'
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST')
    return 'Connection timed out. Verify the host is accessible.'
  if (errno === 1045 || code === 'ER_ACCESS_DENIED_ERROR')
    return 'Authentication failed. Check username and password.'
  if (errno === 1049 || code === 'ER_BAD_DB_ERROR')
    return 'Database not found. Check the database name.'
  if (errno === 1251 || code === 'ER_NOT_SUPPORTED_AUTH_MODE')
    return 'Authentication method not supported. The server may require mysql_native_password.'
  if (msg.includes('SSL') || msg.includes('ssl') || msg.includes('certificate'))
    return 'SSL connection failed. Try changing the SSL mode.'
  return msg || 'An unknown error occurred.'
}

// ── PostgreSQL type mapping ───────────────────────────────────────────────────

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

// ── MS SQL type mapping ───────────────────────────────────────────────────────

function mapMssqlType(
  dataType: string,
  charMaxLength: number | null,
  numericPrecision: number | null,
  numericScale: number | null
): string {
  const t = dataType.toLowerCase()
  // String types
  if (t === 'nvarchar') return `NVARCHAR(${charMaxLength === -1 ? 'MAX' : charMaxLength || 255})`
  if (t === 'varchar') return `VARCHAR(${charMaxLength === -1 ? 'MAX' : charMaxLength || 255})`
  if (t === 'nchar') return `NCHAR(${charMaxLength || 1})`
  if (t === 'char') return `CHAR(${charMaxLength || 1})`
  if (t === 'ntext') return 'NTEXT'
  if (t === 'text') return 'TEXT'
  // Integer types
  if (t === 'int') return 'INT'
  if (t === 'bigint') return 'BIGINT'
  if (t === 'smallint') return 'SMALLINT'
  if (t === 'tinyint') return 'TINYINT'
  // Decimal / money
  if (t === 'decimal' || t === 'numeric') return `DECIMAL(${numericPrecision || 18},${numericScale || 2})`
  if (t === 'money') return 'MONEY'
  if (t === 'smallmoney') return 'SMALLMONEY'
  // Float types
  if (t === 'float') return 'FLOAT'
  if (t === 'real') return 'REAL'
  // Boolean
  if (t === 'bit') return 'BIT'
  // Date/time types
  if (t === 'datetime') return 'DATETIME'
  if (t === 'datetime2') return `DATETIME2(${numericScale || 7})`
  if (t === 'date') return 'DATE'
  if (t === 'time') return `TIME(${numericScale || 7})`
  if (t === 'datetimeoffset') return `DATETIMEOFFSET(${numericScale || 7})`
  if (t === 'smalldatetime') return 'SMALLDATETIME'
  // Other types
  if (t === 'uniqueidentifier') return 'UNIQUEIDENTIFIER'
  if (t === 'xml') return 'XML'
  if (t === 'varbinary') return `VARBINARY(${charMaxLength === -1 ? 'MAX' : charMaxLength || 50})`
  if (t === 'binary') return `BINARY(${charMaxLength || 50})`
  if (t === 'image') return 'IMAGE'
  if (t === 'sql_variant') return 'SQL_VARIANT'
  if (t === 'hierarchyid') return 'HIERARCHYID'
  if (t === 'geography') return 'GEOGRAPHY'
  if (t === 'geometry') return 'GEOMETRY'
  return dataType.toUpperCase()
}

// ── MySQL type mapping ────────────────────────────────────────────────────────

function mapMysqlType(
  dataType: string,
  charMaxLength: number | null,
  numericPrecision: number | null,
  numericScale: number | null
): string {
  const t = dataType.toLowerCase()
  // TINYINT(1) is MySQL's boolean — check before generic tinyint
  if (t === 'tinyint' && charMaxLength === 1) return 'BOOLEAN'
  // String types
  if (t === 'varchar') return `VARCHAR(${charMaxLength || 255})`
  if (t === 'char') return `CHAR(${charMaxLength || 1})`
  if (t === 'text') return 'TEXT'
  if (t === 'mediumtext') return 'MEDIUMTEXT'
  if (t === 'longtext') return 'LONGTEXT'
  if (t === 'tinytext') return 'TINYTEXT'
  if (t === 'enum') return 'ENUM'
  if (t === 'set') return 'SET'
  // Integer types
  if (t === 'int' || t === 'integer') return 'INT'
  if (t === 'bigint') return 'BIGINT'
  if (t === 'smallint') return 'SMALLINT'
  if (t === 'tinyint') return 'TINYINT'
  if (t === 'mediumint') return 'MEDIUMINT'
  // Decimal types
  if (t === 'decimal' || t === 'numeric') return `DECIMAL(${numericPrecision || 10},${numericScale || 0})`
  if (t === 'float') return 'FLOAT'
  if (t === 'double') return 'DOUBLE'
  // Date/time types
  if (t === 'datetime') return 'DATETIME'
  if (t === 'timestamp') return 'TIMESTAMP'
  if (t === 'date') return 'DATE'
  if (t === 'time') return 'TIME'
  if (t === 'year') return 'YEAR'
  // Binary types
  if (t === 'blob') return 'BLOB'
  if (t === 'mediumblob') return 'MEDIUMBLOB'
  if (t === 'longblob') return 'LONGBLOB'
  if (t === 'tinyblob') return 'TINYBLOB'
  if (t === 'varbinary') return `VARBINARY(${charMaxLength || 255})`
  if (t === 'binary') return `BINARY(${charMaxLength || 1})`
  // Other types
  if (t === 'json') return 'JSON'
  if (t === 'geometry') return 'GEOMETRY'
  if (t === 'point') return 'POINT'
  return dataType.toUpperCase()
}

// ── Semantic type inference (driver-agnostic) ─────────────────────────────────

function inferSemanticType(columnName: string, dataType: string): string | null {
  const n = columnName.toLowerCase()
  const t = dataType.toLowerCase()
  const isNumeric = ['integer', 'bigint', 'smallint', 'numeric', 'decimal', 'real', 'double precision', 'int4', 'int8', 'int2', 'float4', 'float8', 'int', 'tinyint', 'float', 'money', 'smallmoney'].includes(t)

  if (n.includes('email') || n.includes('e_mail')) return 'email'
  if (n.includes('phone') || n.includes('mobile') || n.includes('fax')) return 'phone'
  if (n.includes('url') || n.includes('website') || n.includes('link')) return 'url'
  if (isNumeric && (n.includes('price') || n.includes('amount') || n.includes('cost') || n.includes('total') || n.includes('salary') || n.includes('revenue'))) return 'currency'
  if (n === 'id' || n.endsWith('_id')) return 'id'
  return null
}

// ── Value stringification (driver-agnostic) ───────────────────────────────────

function stringifyDbValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  // Binary columns (pg bytea / mssql varbinary): stored as Buffer — don't store raw binary in JSONB
  if (Buffer.isBuffer(value)) return '[binary data]'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Array columns (pg) or complex objects: store as JSON string
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ── Identifier quoting ────────────────────────────────────────────────────────

// PostgreSQL: double-quote identifiers, escape embedded double-quotes by doubling
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// MS SQL: bracket identifiers, escape embedded ] by doubling
function quoteMssqlIdentifier(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`
}

// MySQL: backtick identifiers, escape embedded backticks by doubling
function quoteMysqlIdentifier(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

// ── 2A: testConnection ────────────────────────────────────────────────────────

export async function testConnection(params: {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
  dbType?: 'postgresql' | 'mssql' | 'mysql'
}): Promise<{ success: boolean; error?: string; tableCount?: number }> {
  const dbType = params.dbType ?? 'postgresql'
  const schema = dbType === 'mssql' ? 'dbo' : 'public'

  if (dbType === 'postgresql') {
    const client = buildPgClient(params)
    try {
      await client.connect()
      const result = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [schema]
      )
      return { success: true, tableCount: result.rows[0].count }
    } catch (err) {
      return { success: false, error: mapPgError(err) }
    } finally {
      await client.end().catch(() => {})
    }
  }

  if (dbType === 'mysql') {
    let conn: mysql.Connection | null = null
    try {
      conn = await buildMysqlConnection(params)
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
        [params.database, 'BASE TABLE']
      )
      return { success: true, tableCount: rows[0].count as number }
    } catch (err) {
      return { success: false, error: mapMysqlError(err) }
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  // MS SQL path
  const mssqlParams: MssqlParams = {
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.username,
    password: params.password,
    encrypt: params.sslMode !== 'disable',
    trustServerCertificate: params.sslMode === 'disable' || params.sslMode === 'require',
  }
  const pool = new sql.ConnectionPool(buildMssqlConfig(mssqlParams))
  try {
    await pool.connect()
    const result = await pool.request()
      .input('schema', sql.NVarChar, schema)
      .query<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM information_schema.tables
         WHERE table_schema = @schema AND table_type = 'BASE TABLE'`
      )
    return { success: true, tableCount: result.recordset[0].count }
  } catch (err) {
    return { success: false, error: mapMssqlError(err) }
  } finally {
    await pool.close().catch(() => {})
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
  dbType?: 'postgresql' | 'mssql' | 'mysql'
  schema?: string
}): Promise<{ success: boolean; tables?: { name: string; estimatedRows: number }[]; error?: string }> {
  const dbType = params.dbType ?? 'postgresql'
  const schema = params.schema ?? (dbType === 'mssql' ? 'dbo' : 'public')

  if (dbType === 'mysql') {
    let conn: mysql.Connection | null = null
    try {
      conn = await buildMysqlConnection(params)
      // MySQL's INFORMATION_SCHEMA.TABLES has built-in TABLE_ROWS estimates
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(
        `SELECT TABLE_NAME AS name, COALESCE(TABLE_ROWS, 0) AS estimated_rows
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [params.database]
      )
      const tables = (rows as mysql.RowDataPacket[]).map((r) => ({
        name: r.name as string,
        estimatedRows: Number(r.estimated_rows),
      }))
      return { success: true, tables }
    } catch (err) {
      return { success: false, error: mapMysqlError(err) }
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  if (dbType === 'postgresql') {
    const client = buildPgClient(params)
    try {
      await client.connect()
      const result = await client.query<{ name: string; estimated_rows: string }>(
        `SELECT t.table_name AS name,
           COALESCE(
             (SELECT reltuples::bigint
              FROM pg_class
              WHERE relname = t.table_name
                AND relnamespace = $1::regnamespace),
             0
           ) AS estimated_rows
         FROM information_schema.tables t
         WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`,
        [schema]
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

  // MS SQL path
  const mssqlParams: MssqlParams = {
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.username,
    password: params.password,
    encrypt: params.sslMode !== 'disable',
    trustServerCertificate: params.sslMode === 'disable' || params.sslMode === 'require',
  }
  const pool = new sql.ConnectionPool(buildMssqlConfig(mssqlParams))
  try {
    await pool.connect()
    const result = await pool.request()
      .input('schema', sql.NVarChar, schema)
      .query<{ name: string; estimated_rows: number }>(
        `SELECT t.table_name AS name,
           COALESCE(p.rows, 0) AS estimated_rows
         FROM information_schema.tables t
         LEFT JOIN sys.partitions p
           ON p.object_id = OBJECT_ID(QUOTENAME(@schema) + '.' + QUOTENAME(t.table_name))
           AND p.index_id IN (0, 1)
         WHERE t.table_schema = @schema AND t.table_type = 'BASE TABLE'
         ORDER BY t.table_name`
      )
    const tables = result.recordset.map((r: { name: string; estimated_rows: number }) => ({
      name: r.name,
      estimatedRows: Number(r.estimated_rows),
    }))
    return { success: true, tables }
  } catch (err) {
    return { success: false, error: mapMssqlError(err) }
  } finally {
    await pool.close().catch(() => {})
  }
}

// ── Internal: shared field for table import params ────────────────────────────

interface ImportTableParams {
  // PostgreSQL path
  pgClient?: Client
  // MS SQL path
  mssqlPool?: sql.ConnectionPool
  // MySQL path
  mysqlConn?: mysql.Connection
  mysqlDatabase?: string  // MySQL uses database name as schema for INFORMATION_SCHEMA queries
  // Common
  dbType: 'postgresql' | 'mssql' | 'mysql'
  schema: string
  supabase: Awaited<ReturnType<typeof createClient>>
  projectId: string
  role: 'source' | 'target'
  datasetId: string
  tableName: string
}

// ── Internal: import one table ────────────────────────────────────────────────

async function importTableFromClient({
  pgClient, mssqlPool, mysqlConn, mysqlDatabase, dbType, schema,
  supabase, projectId, role, datasetId, tableName,
}: ImportTableParams): Promise<boolean> {

  // ── Schema introspection ─────────────────────────────────────────────────

  let columns: {
    column_name: string
    data_type: string
    character_maximum_length: number | null
    numeric_precision: number | null
    numeric_scale: number | null
    is_nullable: string
    column_default: string | null
    ordinal_position: number
  }[] = []

  let pkColumns: string[] = []
  let fkRows: { column_name: string; foreign_table: string; foreign_column: string }[] = []
  let checkRows: { check_clause: string; column_name: string }[] = []

  if (dbType === 'postgresql' && pgClient) {
    const [colsResult, pksResult, fksResult, checksResult] = await Promise.all([
      pgClient.query<{
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
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, tableName]
      ),
      pgClient.query<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`,
        [schema, tableName]
      ),
      pgClient.query<{ column_name: string; foreign_table: string; foreign_column: string }>(
        `SELECT kcu.column_name, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
        [schema, tableName]
      ),
      pgClient.query<{ check_clause: string; column_name: string }>(
        `SELECT cc.check_clause, ccu.column_name
         FROM information_schema.check_constraints cc
         JOIN information_schema.constraint_column_usage ccu
           ON cc.constraint_name = ccu.constraint_name
         WHERE cc.constraint_schema = $1 AND ccu.table_name = $2
           AND cc.check_clause NOT LIKE '%IS NOT NULL%'`,
        [schema, tableName]
      ),
    ])

    columns = colsResult.rows
    pkColumns = pksResult.rows.map((r) => r.column_name)
    fkRows = fksResult.rows
    checkRows = checksResult.rows
  } else if (dbType === 'mssql' && mssqlPool) {
    const req = () => mssqlPool.request()
      .input('schema', sql.NVarChar, schema)
      .input('tableName', sql.NVarChar, tableName)

    const [colsResult, pksResult, fksResult, checksResult] = await Promise.all([
      req().query<{
        column_name: string
        data_type: string
        character_maximum_length: number | null
        numeric_precision: number | null
        numeric_scale: number | null
        is_nullable: string
        column_default: string | null
        ordinal_position: number
      }>(
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
           CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
           NUMERIC_PRECISION AS numeric_precision,
           NUMERIC_SCALE AS numeric_scale,
           IS_NULLABLE AS is_nullable,
           COLUMN_DEFAULT AS column_default,
           ORDINAL_POSITION AS ordinal_position
         FROM information_schema.columns
         WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @tableName
         ORDER BY ORDINAL_POSITION`
      ),
      req().query<{ column_name: string }>(
        `SELECT kcu.COLUMN_NAME AS column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
         WHERE tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @tableName
           AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
      ),
      req().query<{ column_name: string; foreign_table: string; foreign_column: string }>(
        `SELECT kcu.COLUMN_NAME AS column_name,
           ccu.TABLE_NAME AS foreign_table,
           ccu.COLUMN_NAME AS foreign_column
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         JOIN information_schema.constraint_column_usage ccu
           ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
         JOIN information_schema.table_constraints tc
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @tableName`
      ),
      req().query<{ check_clause: string; column_name: string }>(
        `SELECT cc.CHECK_CLAUSE AS check_clause, ccu.COLUMN_NAME AS column_name
         FROM information_schema.check_constraints cc
         JOIN information_schema.constraint_column_usage ccu
           ON cc.CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
         JOIN information_schema.table_constraints tc
           ON tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
         WHERE tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @tableName
           AND cc.CHECK_CLAUSE NOT LIKE '%IS NOT NULL%'`
      ),
    ])

    columns = colsResult.recordset
    pkColumns = pksResult.recordset.map((r: { column_name: string }) => r.column_name)
    fkRows = fksResult.recordset
    checkRows = checksResult.recordset
  } else if (dbType === 'mysql' && mysqlConn) {
    const db = mysqlDatabase ?? schema

    const [colRows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
         CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
         NUMERIC_PRECISION AS numeric_precision,
         NUMERIC_SCALE AS numeric_scale,
         IS_NULLABLE AS is_nullable,
         COLUMN_DEFAULT AS column_default,
         ORDINAL_POSITION AS ordinal_position
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [db, tableName]
    )
    columns = colRows as typeof columns

    const [pkRows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
      `SELECT kcu.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
         AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
       WHERE tc.TABLE_SCHEMA = ?
         AND tc.TABLE_NAME = ?
         AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`,
      [db, tableName]
    )
    pkColumns = (pkRows as mysql.RowDataPacket[]).map((r) => r.column_name as string)

    const [fkRowsRaw] = await mysqlConn.execute<mysql.RowDataPacket[]>(
      `SELECT kcu.COLUMN_NAME AS column_name,
         kcu.REFERENCED_TABLE_NAME AS foreign_table,
         kcu.REFERENCED_COLUMN_NAME AS foreign_column
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       WHERE kcu.TABLE_SCHEMA = ?
         AND kcu.TABLE_NAME = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      [db, tableName]
    )
    fkRows = (fkRowsRaw as mysql.RowDataPacket[]).map((r) => ({
      column_name: r.column_name as string,
      foreign_table: r.foreign_table as string,
      foreign_column: r.foreign_column as string,
    }))

    // CHECK constraints available in MySQL 8.0.16+ — gracefully return empty for older versions
    try {
      const [checkRowsRaw] = await mysqlConn.execute<mysql.RowDataPacket[]>(
        `SELECT cc.CHECK_CLAUSE AS check_clause, cc.CONSTRAINT_NAME AS constraint_name
         FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
         JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           ON cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
           AND cc.CONSTRAINT_SCHEMA = tc.TABLE_SCHEMA
         WHERE cc.CONSTRAINT_SCHEMA = ?
           AND tc.TABLE_NAME = ?
           AND tc.CONSTRAINT_TYPE = 'CHECK'`,
        [db, tableName]
      )
      // MySQL CHECK constraints don't map directly to columns — store on a synthetic key
      checkRows = (checkRowsRaw as mysql.RowDataPacket[]).map((r) => ({
        column_name: '__table__',
        check_clause: r.check_clause as string,
      }))
    } catch {
      // MySQL < 8.0.16 doesn't support CHECK in INFORMATION_SCHEMA — safe to skip
      checkRows = []
    }
  }

  const pkSet = new Set(pkColumns)
  const fkMap = new Map(fkRows.map((r) => [r.column_name, `${r.foreign_table}.${r.foreign_column}`]))
  const checkMap = new Map(checkRows.map((r) => [r.column_name, r.check_clause]))

  const fields = columns.map((col) => {
    const dataType = dbType === 'mssql'
      ? mapMssqlType(col.data_type, col.character_maximum_length, col.numeric_precision, col.numeric_scale)
      : dbType === 'mysql'
        ? mapMysqlType(col.data_type, col.character_maximum_length, col.numeric_precision, col.numeric_scale)
        : mapPgType(col.data_type, col.character_maximum_length, col.numeric_precision, col.numeric_scale)
    const inferredType = inferSemanticType(col.column_name, col.data_type)
    const checkClause = checkMap.get(col.column_name) ?? null
    // Route through the same structured parser used by the DDL uploader so the
    // UI's ConstraintBadge receives a typed shape (in_list / regex / range /
    // custom) instead of the old untyped { raw } blob. Dialect quirks: Postgres
    // normalises `status IN ('A','B')` to `(status)::text = ANY (ARRAY[...])`
    // and MySQL prefixes string literals with charset hints (e.g. `_utf8mb4`);
    // both currently fall through to { type: 'custom', raw } — still strictly
    // better than an untyped blob, and leaves the door open to dialect-aware
    // normalisation later without having to change the downstream consumers.
    return {
      name: col.column_name,
      data_type: dataType,
      inferred_type: inferredType,
      is_nullable: col.is_nullable === 'YES',
      is_primary_key: pkSet.has(col.column_name),
      is_foreign_key: fkMap.has(col.column_name),
      fk_reference: fkMap.get(col.column_name) ?? null,
      ordinal_position: col.ordinal_position,
      check_constraint: checkClause ? parseCheckConstraint(checkClause) : null,
      // Introspected via information_schema — equivalent structural authority
      // to an uploaded DDL script, so we share the 'ddl_parsed' provenance
      // label rather than minting a new value. Requires migration 063.
      schema_source: 'ddl_parsed' as const,
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

  if (columns.length > 200) {
    console.warn(`[db-connector] Table "${tableName}" has ${columns.length} columns (>200). Import will proceed but may be slow.`)
  }

  // Pull data rows
  let rawRows: Record<string, unknown>[] = []

  if (dbType === 'postgresql' && pgClient) {
    const quotedTable = quoteIdentifier(tableName)
    const quotedSchema = quoteIdentifier(schema)
    const dataResult = await pgClient.query(`SELECT * FROM ${quotedSchema}.${quotedTable} LIMIT 100000`)
    rawRows = dataResult.rows as Record<string, unknown>[]
  } else if (dbType === 'mssql' && mssqlPool) {
    const quotedTable = quoteMssqlIdentifier(tableName)
    const quotedSchema = quoteMssqlIdentifier(schema)
    const dataResult = await mssqlPool.request()
      .query(`SELECT TOP 100000 * FROM ${quotedSchema}.${quotedTable}`)
    rawRows = dataResult.recordset as Record<string, unknown>[]
  } else if (dbType === 'mysql' && mysqlConn) {
    // No schema prefix for MySQL — already connected to the target database
    const quotedTable = quoteMysqlIdentifier(tableName)
    const [dataRows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM ${quotedTable} LIMIT 100000`
    )
    rawRows = dataRows as Record<string, unknown>[]
  }

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

  // ── Auto-seed validation rules from CHECK constraints ───────────────────
  // Mirrors the seeding loop in lib/actions/ddl-upload.ts (confirmDDLSchema).
  // rule_config keys MUST match the shapes read by executeCustomRules and
  // validateRuleConfig in lib/actions/validation-rules.ts. Canonical shapes:
  //   allowed_values → { values: string[] }
  //   regex          → { pattern: string }
  //   range          → { min: number, max: number }
  //   min_value      → { min: number }
  //   max_value      → { max: number }
  // We insert directly (bypassing addValidationRule) because this is a bulk
  // seed. The enclosing `importTableFromClient` drops the existing table row
  // before this call (see "Delete existing record (cascade)" above), and the
  // validation_rules FK cascades on field/table deletion, so no dedup query
  // is needed — old rules for this table are already gone.
  const fieldIdByName = new Map(createdFields.map((f) => [f.name, f.id]))
  const validationRuleInserts: Array<{
    project_id: string
    table_id: string
    field_id: string
    name: string
    rule_type: string
    rule_config: Record<string, unknown>
    severity: 'blocking'
    is_ai_generated: boolean
  }> = []

  for (const f of fields) {
    const constraint = f.check_constraint
    if (!constraint) continue
    const fieldId = fieldIdByName.get(f.name)
    if (!fieldId) continue

    if (constraint.type === 'in_list' && constraint.allowedValues.length > 0) {
      validationRuleInserts.push({
        project_id: projectId,
        table_id: tableId,
        field_id: fieldId,
        name: `${f.name}: allowed values (from DB)`,
        rule_type: 'allowed_values',
        rule_config: { values: constraint.allowedValues },
        severity: 'blocking',
        is_ai_generated: false,
      })
    } else if (constraint.type === 'regex' && constraint.pattern) {
      validationRuleInserts.push({
        project_id: projectId,
        table_id: tableId,
        field_id: fieldId,
        name: `${f.name}: format validation (from DB)`,
        rule_type: 'regex',
        rule_config: { pattern: constraint.pattern },
        severity: 'blocking',
        is_ai_generated: false,
      })
    } else if (constraint.type === 'range') {
      if (constraint.min !== undefined && constraint.max !== undefined) {
        validationRuleInserts.push({
          project_id: projectId,
          table_id: tableId,
          field_id: fieldId,
          name: `${f.name}: value range (from DB)`,
          rule_type: 'range',
          rule_config: { min: constraint.min, max: constraint.max },
          severity: 'blocking',
          is_ai_generated: false,
        })
      } else if (constraint.min !== undefined) {
        validationRuleInserts.push({
          project_id: projectId,
          table_id: tableId,
          field_id: fieldId,
          name: `${f.name}: minimum value (from DB)`,
          rule_type: 'min_value',
          rule_config: { min: constraint.min },
          severity: 'blocking',
          is_ai_generated: false,
        })
      } else if (constraint.max !== undefined) {
        validationRuleInserts.push({
          project_id: projectId,
          table_id: tableId,
          field_id: fieldId,
          name: `${f.name}: maximum value (from DB)`,
          rule_type: 'max_value',
          rule_config: { max: constraint.max },
          severity: 'blocking',
          is_ai_generated: false,
        })
      }
    }
    // 'custom' constraints aren't machine-checkable — skip seeding.
  }

  if (validationRuleInserts.length > 0) {
    const { error: rulesError } = await supabase
      .from('validation_rules')
      .insert(validationRuleInserts)
    if (rulesError) {
      console.warn(`[db-connector] Failed to auto-seed validation rules for "${tableName}":`, rulesError.message)
      // Non-blocking — import succeeds even if rule seeding fails
    } else {
      console.log(`[db-connector] Auto-seeded ${validationRuleInserts.length} validation rules from CHECK constraints for "${tableName}"`)
    }
  }

  // Stringify + batch insert data_rows
  const stringifiedRows: Record<string, string | null>[] = rawRows.map((row) => {
    const out: Record<string, string | null> = {}
    for (const [key, val] of Object.entries(row)) {
      out[key] = stringifyDbValue(val)
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
    `${role === 'source' ? 'Source' : 'Target'} data imported from ${dbType === 'mssql' ? 'MS SQL' : dbType === 'mysql' ? 'MySQL' : 'PostgreSQL'}: ${tableName} (${rawRows.length} rows, ${fields.length} fields)`,
    'data',
    { source: 'db_connector', db_type: dbType, table_name: tableName, row_count: rawRows.length, field_count: fields.length }
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
  dbType?: 'postgresql' | 'mssql' | 'mysql'
  schema?: string
}): Promise<{ success: boolean; error?: string; tablesImported?: number }> {
  const { projectId, role, datasetId, selectedTables, password } = params
  const dbType = params.dbType ?? 'postgresql'
  // MySQL: schema = database name (used for INFORMATION_SCHEMA queries)
  const schema = params.schema ?? (dbType === 'mssql' ? 'dbo' : dbType === 'mysql' ? params.database : 'public')
  const supabase = await createClient()

  // ── Step 1: Auth + permission check ──────────────────────────────────────
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }

  const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
  if (!(await checkProjectPermission(projectId, 'editor'))) {
    return { success: false, error: 'Insufficient permissions' }
  }

  // ── Step 2: Save / update connection credentials ──────────────────────────
  const { error: upsertErr } = await supabase
    .from('db_connections')
    .upsert(
      {
        project_id: projectId,
        dataset_id: datasetId,
        db_type: dbType,
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
  let tablesImported = 0

  if (dbType === 'postgresql') {
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

    try {
      for (const tableName of selectedTables) {
        try {
          const ok = await importTableFromClient({
            pgClient: client, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] Failed to import table "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await client.end().catch(() => {})
    }
  } else if (dbType === 'mssql') {
    const mssqlParams: MssqlParams = {
      host: params.host,
      port: params.port,
      database: params.database,
      username: params.username,
      password,
      encrypt: params.sslMode !== 'disable',
      trustServerCertificate: params.sslMode === 'disable' || params.sslMode === 'require',
    }
    const pool = new sql.ConnectionPool(buildMssqlConfig(mssqlParams))
    try {
      await pool.connect()
    } catch (connErr) {
      await supabase
        .from('db_connections')
        .update({ status: 'failed' })
        .eq('dataset_id', datasetId)
      return { success: false, error: mapMssqlError(connErr) }
    }

    try {
      for (const tableName of selectedTables) {
        try {
          const ok = await importTableFromClient({
            mssqlPool: pool, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] Failed to import table "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await pool.close().catch(() => {})
    }
  } else if (dbType === 'mysql') {
    let conn: mysql.Connection | null = null
    try {
      conn = await buildMysqlConnection(params)
    } catch (connErr) {
      await supabase
        .from('db_connections')
        .update({ status: 'failed' })
        .eq('dataset_id', datasetId)
      return { success: false, error: mapMysqlError(connErr) }
    }

    try {
      for (const tableName of selectedTables) {
        try {
          const ok = await importTableFromClient({
            mysqlConn: conn, mysqlDatabase: params.database, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] Failed to import table "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await conn?.end().catch(() => {})
    }
  }

  // ── Step 5: Update connection status + revalidate ─────────────────────────
  await supabase
    .from('db_connections')
    .update({ status: 'connected', last_connected_at: new Date().toISOString() })
    .eq('dataset_id', datasetId)

  revalidatePath(`/app/projects/${projectId}`, 'layout')

  return { success: true, tablesImported }
}

// ── listMssqlSchemas ──────────────────────────────────────────────────────────
// Returns user-visible schemas for an MS SQL database (excludes system schemas)

export async function listMssqlSchemas(params: {
  host: string
  port: number
  database: string
  username: string
  password: string
  sslMode: string
}): Promise<{ success: boolean; schemas?: string[]; error?: string }> {
  const mssqlParams: MssqlParams = {
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.username,
    password: params.password,
    encrypt: params.sslMode !== 'disable',
    trustServerCertificate: params.sslMode === 'disable' || params.sslMode === 'require',
  }
  const pool = new sql.ConnectionPool(buildMssqlConfig(mssqlParams))
  try {
    await pool.connect()
    const result = await pool.request()
      .query<{ name: string }>(
        `SELECT SCHEMA_NAME AS name
         FROM information_schema.schemata
         WHERE SCHEMA_NAME NOT IN (
           'information_schema', 'sys', 'guest',
           'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
           'db_backupoperator', 'db_datareader', 'db_datawriter',
           'db_denydatareader', 'db_denydatawriter'
         )
         ORDER BY SCHEMA_NAME`
      )
    const schemas = result.recordset.map((r: { name: string }) => r.name)
    return { success: true, schemas: schemas.length > 0 ? schemas : ['dbo'] }
  } catch (err) {
    return { success: false, error: mapMssqlError(err) }
  } finally {
    await pool.close().catch(() => {})
  }
}

// ── listTablesForConnection ───────────────────────────────────────────────────
// Like listRemoteTables, but reads credentials from a stored db_connections row

export async function listTablesForConnection(
  connectionId: string
): Promise<{ success: boolean; tables?: { name: string; estimatedRows: number }[]; error?: string }> {
  const supabase = await createClient()

  const { data: conn } = await supabase
    .from('db_connections')
    .select('host, port, database_name, username, password_encrypted, ssl_mode, db_type')
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
    dbType: conn.db_type as 'postgresql' | 'mssql' | 'mysql',
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
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }
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
  const perm = await requireProjectPermission(projectId, 'editor')
  if (!perm.allowed) return { success: false, error: perm.error }
  const supabase = await createClient()

  // Load stored credentials (with password)
  const { data: conn } = await supabase
    .from('db_connections')
    .select('host, port, database_name, username, password_encrypted, ssl_mode, db_type')
    .eq('id', connectionId)
    .single()

  if (!conn) return { success: false, error: 'Connection not found.' }

  let password: string
  try {
    password = decrypt(conn.password_encrypted)
  } catch {
    return { success: false, error: 'Failed to decrypt stored credentials.' }
  }

  const dbType = (conn.db_type as 'postgresql' | 'mssql' | 'mysql') ?? 'postgresql'
  const schema = dbType === 'mssql' ? 'dbo' : dbType === 'mysql' ? conn.database_name : 'public'

  let tablesImported = 0

  if (dbType === 'postgresql') {
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

    try {
      for (const tableName of tableNames) {
        try {
          const ok = await importTableFromClient({
            pgClient: client, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] resync failed for "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await client.end().catch(() => {})
    }
  } else if (dbType === 'mssql') {
    const mssqlParams: MssqlParams = {
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      username: conn.username,
      password,
      encrypt: conn.ssl_mode !== 'disable',
      trustServerCertificate: conn.ssl_mode === 'disable' || conn.ssl_mode === 'require',
    }
    const pool = new sql.ConnectionPool(buildMssqlConfig(mssqlParams))
    try {
      await pool.connect()
    } catch (connErr) {
      await supabase
        .from('db_connections')
        .update({ status: 'failed' })
        .eq('id', connectionId)
      return { success: false, error: mapMssqlError(connErr) }
    }

    try {
      for (const tableName of tableNames) {
        try {
          const ok = await importTableFromClient({
            mssqlPool: pool, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] resync failed for "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await pool.close().catch(() => {})
    }
  } else if (dbType === 'mysql') {
    const mysqlParams: MysqlParams = {
      host: conn.host,
      port: conn.port,
      database: conn.database_name,
      username: conn.username,
      password,
      sslMode: conn.ssl_mode,
    }
    let mysqlConn: mysql.Connection | null = null
    try {
      mysqlConn = await buildMysqlConnection(mysqlParams)
    } catch (connErr) {
      await supabase
        .from('db_connections')
        .update({ status: 'failed' })
        .eq('id', connectionId)
      return { success: false, error: mapMysqlError(connErr) }
    }

    try {
      for (const tableName of tableNames) {
        try {
          const ok = await importTableFromClient({
            mysqlConn, mysqlDatabase: conn.database_name, dbType, schema,
            supabase, projectId, role, datasetId, tableName,
          })
          if (ok) tablesImported++
        } catch (tableErr) {
          console.warn(`[db-connector] resync failed for "${tableName}" (continuing):`, tableErr)
        }
      }
    } finally {
      await mysqlConn?.end().catch(() => {})
    }
  }

  await supabase
    .from('db_connections')
    .update({ status: 'connected', last_connected_at: new Date().toISOString() })
    .eq('id', connectionId)

  revalidatePath(`/app/projects/${projectId}`, 'layout')
  return { success: true, tablesImported }
}
