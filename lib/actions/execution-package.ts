'use server'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { callClaude, callClaudeStreaming } from '@/lib/ai/claude'
import { checkAIRateLimit } from '@/lib/ai/rate-limit'
import JSZip from 'jszip'
import type { SqlDialect, ExecutionPackageFormat } from '@/lib/types/database'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TargetFieldRow {
  id: string
  table_id: string
  name: string
  data_type: string
  is_nullable: boolean
  is_primary_key: boolean
  is_foreign_key: boolean
  fk_reference: string | null
  ordinal_position: number
}

interface FieldMappingRow {
  id: string
  table_mapping_id: string
  source_field_id: string | null
  target_field_id: string
  confidence: number | null
  needs_transformation: boolean | null
}

interface TransformationRow {
  id: string
  field_mapping_id: string
  status: string
  description: string | null
  generated_sql: string | null
}

interface QualityIssueRow {
  id: string
  severity: string
  status: string
  title: string
  description: string
  affected_records: number
  generated_sql: string | null
}

export interface ExecutionPackageResult {
  success: true
  sqlContent: string
  storagePath: string
  version: string
  dialect: SqlDialect
}

export interface ExecutionPackageError {
  success: false
  error: string
}

export interface CompartmentalizedFile {
  filename: string
  type: 'checklist' | 'table_script' | 'validation' | 'promote' | 'rollback'
  content: string
  table_name?: string
  load_order?: number
  dependencies?: string[]
  storagePath: string
}

export interface CompartmentalizedPackageResult {
  success: true
  files: CompartmentalizedFile[]
  zipStoragePath: string
  version: string
  dialect: SqlDialect
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nextVersionStr(current: string): string {
  const parts = current.split('.')
  const minor = parseInt(parts[1] ?? '0', 10)
  return `${parts[0]}.${minor + 1}`
}

async function getNextVersionStr(projectId: string, type: string, format: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from('outputs')
    .select('version')
    .eq('project_id', projectId)
    .eq('type', type)
    .eq('format', format)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ? nextVersionStr(data.version) : '1.0'
}

/**
 * Returns true if the SQL content appears to use the expected dialect's identifier style.
 * Used to validate Claude's compartmentalized output before accepting it.
 */
function detectDialect(content: string, expected: SqlDialect): boolean {
  const hasBrackets = /\[[A-Za-z_]/.test(content)
  const hasBackticks = /`[A-Za-z_]/.test(content)
  const hasDoubleQuotes = /"[A-Za-z_]/.test(content)
  const hasPgCast = content.includes('::')
  const hasPgRegex = / ~ /.test(content) || / ~\* /.test(content)
  const hasPgFunctions = /\b(SPLIT_PART|TO_DATE|TO_CHAR|INITCAP|REGEXP_REPLACE)\b/.test(content)
  const hasTsqlFunctions = /\b(CHARINDEX|HASHBYTES|PATINDEX|ISNUMERIC|LEN|GETDATE)\b/.test(content)

  if (expected === 'tsql') {
    return hasBrackets && !hasPgCast && !hasPgRegex && !hasPgFunctions && !hasBackticks
  }
  if (expected === 'mysql') {
    return hasBackticks && !hasPgCast && !hasPgRegex && !hasPgFunctions && !hasBrackets && !hasTsqlFunctions
  }
  // postgresql
  return (hasDoubleQuotes || hasPgCast) && !hasBrackets && !hasBackticks
}

/**
 * Sanitize Claude's JSON response to fix unescaped characters inside string values.
 * Claude sometimes emits raw double quotes inside JSON "content" fields when generating
 * SQL with double-quoted identifiers (PostgreSQL) or comments containing quotes.
 *
 * Strategy: try parsing as-is first. If that fails, scan "content" field values
 * character by character, escaping any interior double quote that isn't the real
 * closing quote (identified by being followed by whitespace then , } or ]).
 */
function sanitizeClaudeJson(raw: string): string {
  try {
    JSON.parse(raw)
    return raw
  } catch {
    // Needs sanitization
  }

  let sanitized = ''
  let i = 0
  while (i < raw.length) {
    const contentMatch = raw.indexOf('"content"', i)
    if (contentMatch === -1) {
      sanitized += raw.slice(i)
      break
    }

    sanitized += raw.slice(i, contentMatch)
    i = contentMatch

    const colonPos = raw.indexOf(':', i + 9)
    if (colonPos === -1) { sanitized += raw.slice(i); break }
    const openQuote = raw.indexOf('"', colonPos + 1)
    if (openQuote === -1) { sanitized += raw.slice(i); break }

    sanitized += raw.slice(i, openQuote + 1)
    i = openQuote + 1

    let j = i
    while (j < raw.length) {
      if (raw[j] === '\\') {
        sanitized += raw[j] + (raw[j + 1] || '')
        j += 2
        continue
      }
      if (raw[j] === '"') {
        let k = j + 1
        while (k < raw.length && (raw[k] === ' ' || raw[k] === '\n' || raw[k] === '\r' || raw[k] === '\t')) k++
        if (k >= raw.length || raw[k] === ',' || raw[k] === '}' || raw[k] === ']') {
          sanitized += '"'
          i = j + 1
          break
        } else {
          sanitized += '\\"'
          j++
          continue
        }
      }
      sanitized += raw[j]
      j++
    }
  }

  try {
    JSON.parse(sanitized)
    console.log('[sanitizeClaudeJson] Successfully sanitized JSON')
    return sanitized
  } catch (e) {
    console.error('[sanitizeClaudeJson] Sanitization failed, returning original:', e)
    return raw
  }
}

/**
 * Splits a monolithic 6-section SQL script into per-table file content.
 * Anchors on SECTION N markers and INSERT INTO STG_ statements per table.
 */
function splitMonolithicSQL(
  sql: string,
  loadOrder: LoadOrderEntry[]
): { checklist: string; tableSections: Map<string, string>; validation: string; promote: string; rollback: string } {
  const tableSections = new Map<string, string>()

  // Locate section boundaries using "SECTION N" anywhere in a comment line
  const sectionBounds: Array<{ num: number; start: number }> = []
  const secRe = /--[^\n]*SECTION\s+(\d+)[^\n]*/gi
  let secMatch: RegExpExecArray | null
  while ((secMatch = secRe.exec(sql)) !== null) {
    const num = parseInt(secMatch[1])
    if (!sectionBounds.find((s) => s.num === num)) {
      sectionBounds.push({ num, start: secMatch.index })
    }
  }
  sectionBounds.sort((a, b) => a.start - b.start)

  const getSectionContent = (n: number): string => {
    const idx = sectionBounds.findIndex((s) => s.num === n)
    if (idx === -1) return ''
    const start = sectionBounds[idx].start
    const end = idx + 1 < sectionBounds.length ? sectionBounds[idx + 1].start : sql.length
    return sql.slice(start, end).trim()
  }

  const sec3 = getSectionContent(3)

  // Within section 3, split per table anchoring on INSERT INTO STG_<tableName> (any quoting style)
  for (let i = 0; i < loadOrder.length; i++) {
    const tableName = loadOrder[i].tableName
    const nextTableName = i + 1 < loadOrder.length ? loadOrder[i + 1].tableName : null

    // Match INSERT INTO STG_ with bracket, backtick, double-quote, or unquoted identifiers
    const esc = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const insertRe = new RegExp(
      `INSERT\\s+INTO\\s+(?:\\[STG_${esc}\\]|\`STG_${esc}\`|"STG_${esc}"|STG_${esc})(?:\\s|\\()`,
      'i'
    )
    const insertMatch = insertRe.exec(sec3)
    if (!insertMatch) {
      tableSections.set(tableName, `-- No staging script found for STG_${tableName} in fallback generation.\n`)
      continue
    }

    // Walk back from the INSERT to the nearest comment separator line
    const beforeInsert = sec3.slice(0, insertMatch.index)
    const lastCommentIdx = beforeInsert.lastIndexOf('\n--')
    const tableStart = lastCommentIdx > 0 ? lastCommentIdx + 1 : insertMatch.index

    let tableEnd = sec3.length
    if (nextTableName) {
      const escNext = nextTableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const nextInsertRe = new RegExp(
        `INSERT\\s+INTO\\s+(?:\\[STG_${escNext}\\]|\`STG_${escNext}\`|"STG_${escNext}"|STG_${escNext})(?:\\s|\\()`,
        'i'
      )
      const nextMatch = nextInsertRe.exec(sec3.slice(tableStart + 1))
      if (nextMatch) {
        const nextAbsolute = tableStart + 1 + nextMatch.index
        const beforeNext = sec3.slice(tableStart, nextAbsolute)
        const lastSepBeforeNext = beforeNext.lastIndexOf('\n--')
        tableEnd = lastSepBeforeNext > 0 ? tableStart + lastSepBeforeNext + 1 : nextAbsolute
      }
    }

    tableSections.set(tableName, sec3.slice(tableStart, tableEnd).trim())
  }

  return {
    checklist: getSectionContent(1),
    tableSections,
    validation: getSectionContent(4),
    promote: getSectionContent(5),
    rollback: getSectionContent(6),
  }
}

// ── FK Dependency Resolution ──────────────────────────────────────────────────

interface LoadOrderEntry {
  tableName: string
  tableId: string
  dependencies: string[]
}

/**
 * Topological sort of target tables based on FK references.
 * Tables that are referenced by others load first.
 * Falls back to alphabetical order if a circular dependency is detected.
 */
function computeLoadOrder(
  targetTables: Array<{ id: string; name: string }>,
  targetFields: TargetFieldRow[]
): LoadOrderEntry[] {
  const tableNames = new Map(targetTables.map((t) => [t.id, t.name]))
  // Map lowercase name → canonical name for case-insensitive FK parsing
  const tableByNameLower = new Map(targetTables.map((t) => [t.name.toLowerCase(), t.name]))

  // Build adjacency: tableName → Set of tables it depends on (FK targets)
  const deps = new Map<string, Set<string>>()
  for (const t of targetTables) {
    deps.set(t.name, new Set())
  }

  for (const field of targetFields) {
    if (!field.is_foreign_key || !field.fk_reference) continue
    const ownerTable = tableNames.get(field.table_id)
    if (!ownerTable) continue

    // fk_reference formats: "table", "table.field", "schema.table.field"
    // The referenced table is the second-to-last segment (before the field name)
    const parts = field.fk_reference.split('.')
    const refTableRaw = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
    const refTable = tableByNameLower.get(refTableRaw.toLowerCase())

    if (refTable && refTable !== ownerTable) {
      deps.get(ownerTable)?.add(refTable)
    }
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<string, number>()
  // reversed graph: refTable → [tables that depend on refTable]
  const dependents = new Map<string, string[]>()

  for (const [table, tableDeps] of deps) {
    inDegree.set(table, tableDeps.size)
    for (const dep of tableDeps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(table)
    }
  }

  // Start with tables that have no dependencies (stable sorted for determinism)
  const queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([t]) => t)
    .sort()

  const ordered: string[] = []
  while (queue.length > 0) {
    const table = queue.shift()!
    ordered.push(table)
    for (const dependent of dependents.get(table) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  // Circular dependency fallback — append remaining tables alphabetically
  if (ordered.length < targetTables.length) {
    const remaining = targetTables
      .map((t) => t.name)
      .filter((n) => !ordered.includes(n))
      .sort()
    ordered.push(...remaining)
  }

  return ordered.map((name) => ({
    tableName: name,
    tableId: targetTables.find((t) => t.name === name)?.id ?? '',
    dependencies: [...(deps.get(name) ?? [])],
  }))
}

// ── Dialect instructions ───────────────────────────────────────────────────────

function getDialectInstructions(dialect: SqlDialect): string {
  if (dialect === 'tsql') {
    return `SQL DIALECT: T-SQL (Microsoft SQL Server)
- Use [bracket] identifiers for table and column names: [table_name].[column_name]
- Use GETDATE() for current timestamp, SYSDATETIME() for high precision
- Use ISNULL() or COALESCE() for null handling
- Use + for string concatenation, or CONCAT()
- Use TOP N instead of LIMIT (place after SELECT: SELECT TOP 100 * FROM ...)
- Use IDENTITY(1,1) for auto-increment
- Use MERGE ... WHEN MATCHED THEN UPDATE WHEN NOT MATCHED THEN INSERT for upserts
- Use CAST(x AS NVARCHAR(MAX)), CAST(x AS INT), etc. for type casting (no :: syntax)
- Use BIT type (1/0) instead of BOOLEAN
- Use DATETIME2, DATETIMEOFFSET for datetime
- Use IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_name') CREATE INDEX ...
- Use INSERT INTO ... VALUES for data loading
- Use BEGIN TRANSACTION; ... COMMIT TRANSACTION; for transactions
- Use -- for single-line comments
- Use NVARCHAR instead of VARCHAR for Unicode text
- Use SET NOCOUNT ON at the start of scripts
- Use GO as batch separator between major sections`
  }

  if (dialect === 'mysql') {
    return `SQL DIALECT: MySQL
- Use backtick identifiers for table and column names: \`table_name\`.\`column_name\`
- Use NOW() for current timestamp
- Use COALESCE() or IFNULL() for null handling
- Use CONCAT() for string concatenation (|| is not supported by default)
- Use LIMIT N for row limiting
- Use AUTO_INCREMENT for auto-increment
- Use INSERT ... ON DUPLICATE KEY UPDATE for upserts
- Use CAST(x AS CHAR), CAST(x AS SIGNED), etc. for type casting (no :: syntax)
- Use TINYINT(1) for boolean (TRUE/FALSE are aliases for 1/0)
- Use DATETIME for datetime
- Use CREATE INDEX IF NOT EXISTS (MySQL 8.0+)
- Use INSERT INTO ... VALUES for data loading
- Use START TRANSACTION; ... COMMIT; for transactions
- Use -- for single-line comments (with space after --)
- Use utf8mb4 charset for Unicode text`
  }

  return `SQL DIALECT: PostgreSQL
- Use double-quoted identifiers for table and column names: "table_name"."column_name"
- Use NOW() for current timestamp
- Use COALESCE() for null handling
- Use || for string concatenation, or CONCAT()
- Use LIMIT N for row limiting
- Use SERIAL or GENERATED ALWAYS AS IDENTITY for auto-increment
- Use ON CONFLICT ... DO UPDATE for upserts
- Use CAST(x AS TEXT), field::integer, field::text, etc. for type casting
- Use BOOLEAN type (TRUE/FALSE)
- Use TIMESTAMP, TIMESTAMPTZ for datetime
- Use BEGIN; ... COMMIT; for transactions
- Use -- for single-line comments`
}

function getTransformAdaptationInstruction(dialect: SqlDialect): string {
  if (dialect === 'postgresql') return ''
  const concatExample = dialect === 'tsql'
    ? "field1 + '-' + field2 for T-SQL"
    : "CONCAT(field1, '-', field2) for MySQL"
  const castExample = dialect === 'tsql'
    ? 'CAST(field AS INT) for T-SQL'
    : 'CAST(field AS SIGNED) for MySQL'
  return `
IMPORTANT — TRANSFORM ADAPTATION REQUIRED: The transformation SQL expressions provided in the approved mappings below are written in PostgreSQL syntax (using ::type casting, || for concatenation, REGEXP_REPLACE, SUBSTRING(x FROM y FOR z), etc.). You MUST adapt them to the target dialect syntax when incorporating them into the migration script. Do NOT embed the PostgreSQL expressions verbatim. Translate to equivalent target dialect syntax. Examples:
- field::integer → ${castExample}
- field1 || '-' || field2 → ${concatExample}
- field::text → CAST(field AS NVARCHAR(MAX)) / CAST(field AS CHAR)
- REGEXP_REPLACE(field, pattern, repl) → REPLACE() chain or equivalent
- SUBSTRING(field FROM 1 FOR 10) → SUBSTRING(field, 1, 10)`
}

// ── System prompt ─────────────────────────────────────────────────────────────

const EXECUTION_PACKAGE_SYSTEM_PROMPT = `You are an expert data migration engineer generating a production-ready SQL migration execution package using a three-phase ETL pattern: Source → Staging → Target.

CRITICAL STAGING RULES:
- ALL transform-and-load scripts (Section 3) insert into STAGING tables (STG_ prefix), NEVER directly into target tables.
- Staging table names are ALWAYS STG_ + target table name (e.g., STG_TC_MATTERS for target TC_MATTERS).
- Staging tables mirror target schema exactly (same columns, same types, same NOT NULL) but WITHOUT foreign key constraints.
- The ONLY section that writes to target tables is Section 5 (Promote to Target).
- Section 5 uses INSERT INTO {target} SELECT * FROM STG_{target} — no transforms, no CASE statements.
- Dialect identifier quoting applies to staging tables identically.

OUTPUT FORMAT RULES:
- Output ONLY valid SQL with comments. No markdown, no code fences, no explanatory text outside SQL comments.
- Use standard SQL syntax. Note PostgreSQL-specific syntax in comments where used.
- Format all SQL with proper indentation and line breaks for readability.
- Each CASE WHEN clause MUST be on its own indented line. Never compress multiple WHEN clauses onto a single line.
- Maximum line width: 100 characters. Break long expressions across multiple lines.
- Use clear section headers as SQL block comments with === separator lines.

TRANSFORMATION RULES:
- Use the EXACT transformation SQL provided in the approved mappings when available. Do not rewrite or "improve" transformations that have been tested and approved — embed them verbatim as expressions in the SELECT clause.
- For fields WITHOUT explicit transformation SQL, generate appropriate conversion logic based on the source/target types and the business rules documentation.
- Every transformation expression MUST include a comment above it explaining what it does.

NULL SAFETY RULES:
- If a target field is NOT NULL and the source mapping can produce NULL values, you MUST either:
  (a) Provide an explicit DEFAULT value in the transformation (e.g., COALESCE(..., 'default')), OR
  (b) Add a WHERE clause that excludes rows where that field would be NULL, OR
  (c) Flag it as a blocking issue in Section 1 with specific field name and estimated affected row count.
- Never silently allow NULL into a NOT NULL target field.
- For every NOT NULL target field, the SELECT expression MUST use COALESCE with an explicit default. No exceptions. Even if Section 1 flags the issue, the SQL itself must still be safe to execute without errors.

FILTERING RULES:
- NEVER apply date or numeric filters on raw VARCHAR source fields using string comparison. Date/numeric filters must be applied AFTER type conversion, or within the INSERT...SELECT statement where the transformation has already been applied.
- Child table extracts and loads MUST account for parent table filters. If parent records are excluded (e.g., by status or date cutoff), their child records must ALSO be excluded — even if the child's FK value is technically valid in the source. Use subqueries: WHERE parent_fk IN (SELECT pk FROM parent_table WHERE <same parent filters>).

SECTION 1 SPECIFIC RULES:
- In addition to issue listing and risk assessment, include executable SQL to CREATE staging tables (CREATE TABLE IF NOT EXISTS STG_{target_table} mirroring target schema without FKs) and TRUNCATE them for idempotent re-runs.

SECTION 3 SPECIFIC RULES:
- Generate complete INSERT INTO STG_{target_table} (col1, col2, ...) SELECT expr1, expr2, ... FROM source_table WHERE ... statements.
- The INSERT target is ALWAYS the staging table (STG_ prefix), NEVER the target table directly.
- Each target table gets its own INSERT...SELECT block.
- Order the blocks by the FK-dependency load order provided.
- Align column expressions vertically for readability.
- Add a blank line between each column expression for visual clarity.
- Include a -- comment above each expression naming the source→target field mapping.

SECTION 4 SPECIFIC RULES:
- For record count reconciliation, use independent COUNT queries (one for source with filters, one for STG_{target_table}), presented side by side. Do NOT use JOINed reconciliation.
- For aggregate reconciliation (sums of amounts), use independent SUM queries on source vs STG_ tables. Do NOT join source and staging rows for comparison — this is fragile and error-prone.
- For FK integrity checks, use LEFT JOIN across STG_ tables: STG_{child} LEFT JOIN STG_{parent} WHERE STG_{parent}.pk IS NULL pattern.
- For CHECK constraint validation, use WHERE column NOT IN (...allowed values...) pattern on STG_ tables.
- End with: -- ⚠️ REVIEW ALL RESULTS ABOVE. DO NOT PROCEED TO PROMOTION (Section 5) UNLESS ALL CHECKS PASS.

SECTION 5 SPECIFIC RULES:
- Wrap all inserts in a single transaction (dialect-appropriate).
- For each target table in FK dependency order: INSERT INTO {target_table} SELECT * FROM STG_{target_table}.
- No transforms, no CASE statements — clean column-for-column copy from staging to target.
- After all inserts: post-promotion row count verification confirming target count = staging count for each table.
- Transaction ends with ROLLBACK by default — NOT COMMIT.
- Include: -- ⚠️ CHANGE ROLLBACK TO COMMIT ONLY AFTER VERIFYING ALL POST-PROMOTION COUNTS MATCH.

SECTION 6 SPECIFIC RULES:
- DELETE FROM all target tables in REVERSE FK dependency order.
- TRUNCATE all STG_ tables after target deletions.
- Post-rollback verification: confirm both target and staging tables are empty.
- Wrap in transaction with ROLLBACK (not COMMIT).`

// ── Monolithic fallback instructions (used when compartmentalized output has wrong dialect) ──────

const MONOLITHIC_FALLBACK_INSTRUCTIONS = `## Instructions
Generate a SQL migration execution package with exactly 6 sections using the Source → Staging → Target pattern.
Each section MUST start with a SQL block comment header that includes "SECTION N" (e.g., -- ===... SECTION 1 — PRE-MIGRATION CHECKLIST ===...).
Use exactly these section labels:

SECTION 1 — PRE-MIGRATION CHECKLIST
SECTION 2 — EXTRACT QUERIES
SECTION 3 — TRANSFORMATION & STAGING SCRIPTS
SECTION 4 — POST-STAGING VALIDATION
SECTION 5 — PROMOTE TO TARGET
SECTION 6 — ROLLBACK

In SECTION 1, include CREATE TABLE IF NOT EXISTS STG_{target_table} for every target table (mirroring target schema without FKs) and TRUNCATE all STG_ tables.
In SECTION 3, add a SQL comment header line containing the exact table name before each INSERT INTO STG_{target_table} block. ALL inserts go to staging tables (STG_ prefix), NEVER directly to target tables.
In SECTION 5, INSERT INTO {target_table} SELECT * FROM STG_{target_table} for each table in FK dependency order, wrapped in a transaction with ROLLBACK (not COMMIT).
In SECTION 6, DELETE from target tables in reverse FK order, then TRUNCATE all STG_ tables.
Generate one INSERT INTO block per target table in the FK-dependency load order listed above.
Output ONLY valid SQL with comments. No markdown, no code fences, no JSON.`

// ── Compartmentalized system prompt ───────────────────────────────────────────

const COMPARTMENTALIZED_SYSTEM_PROMPT = `You are an expert data migration engineer generating production-ready, compartmentalized SQL migration scripts using a three-phase ETL pattern: Source → Staging → Target.

CRITICAL STAGING RULES:
- NEVER insert directly into target tables in per-table scripts (files 01–N). ALL transforms write to STG_ staging tables.
- Staging table names are ALWAYS STG_ prefixed to the target table name (e.g., STG_TC_MATTERS for target TC_MATTERS).
- Staging tables mirror the target schema exactly (same columns, same types, same NOT NULL constraints) but WITHOUT foreign key constraints.
- The ONLY file that writes to target tables is the Promote file.
- The Promote file uses INSERT INTO {target} SELECT * FROM STG_{target} — no transforms, no CASE statements.
- Dialect identifier quoting applies to staging tables identically (T-SQL: [STG_TC_MATTERS], MySQL: \`STG_TC_MATTERS\`, PostgreSQL: "STG_TC_MATTERS").

OUTPUT FORMAT: Return ONLY a valid JSON object — no markdown fences, no preamble, no explanation outside the JSON.

JSON STRUCTURE:
{
  "files": [
    {
      "filename": "00_pre_migration_checklist.sql",
      "type": "checklist",
      "content": "-- SECTION 1: ISSUE REVIEW\\n-- [BLOCKING] ...\\n-- SOURCE COUNTS ...\\n\\n-- SECTION 2: CREATE STAGING TABLES\\nCREATE TABLE IF NOT EXISTS ...\\n\\n-- SECTION 3: TRUNCATE STAGING TABLES\\nTRUNCATE TABLE ..."
    },
    {
      "filename": "TABLE_PLACEHOLDER",
      "type": "table_script",
      "table_name": "ACTUAL_TABLE_NAME",
      "content": "-- SECTION A: EXTRACT QUERY\\n...\\n-- SECTION B: TRANSFORM & STAGE\\n...\\n-- SECTION C: STAGING VALIDATION\\n...\\n-- SECTION D: TABLE ROLLBACK\\n..."
    },
    {
      "filename": "VALIDATION_PLACEHOLDER",
      "type": "validation",
      "content": "-- POST-STAGING VALIDATION\\n..."
    },
    {
      "filename": "PROMOTE_PLACEHOLDER",
      "type": "promote",
      "content": "-- PROMOTE TO TARGET\\n..."
    },
    {
      "filename": "99_full_rollback.sql",
      "type": "rollback",
      "content": "-- FULL ROLLBACK\\n..."
    }
  ]
}

FILE NUMBERING: Use placeholder filenames for table scripts, the validation file, and the promote file — the caller assigns the numeric prefix (01_, 02_, etc.) based on FK dependency order. Use "00_pre_migration_checklist.sql" and "99_full_rollback.sql" as-is.

SQL FORMATTING RULES:
- Format all SQL with proper indentation and line breaks.
- Each CASE WHEN clause on its own indented line.
- Maximum line width: 100 characters.
- Use clear section headers as SQL block comments with === separator lines.
- Each file must be completely self-contained and independently executable.
- Do NOT reference variables, temp tables, or state from other files.

FILE 1 — Pre-Migration Checklist (00_pre_migration_checklist.sql):
This file has THREE distinct sections. Sections 2 and 3 contain EXECUTABLE SQL, not comments.

SECTION 1 — ISSUE REVIEW (SQL comments only, no executable statements):
- List all BLOCKING issues as SQL comments with fix SQL shown as commented-out code.
- The fix SQL examples MUST use the target SQL dialect syntax specified in the dialect rules below. Adapt any fix SQL to the target dialect — use dialect-appropriate identifier quoting, string functions, and operators. Do NOT use PostgreSQL-specific syntax (like "double quotes", TRIM(), ~, !~) when the target dialect is T-SQL or MySQL.
- List all WARNINGS as SQL comments.
- List accepted risks with notes as SQL comments.
- List SOURCE RECORD COUNTS as SQL comments (one per table).
- Check every NOT NULL target field: if any mapping could produce NULL for that field, flag it here.
- This section is informational only — everything is commented out.

SECTION 2 — CREATE STAGING TABLES (EXECUTABLE SQL — NOT comments):
⚠️ THIS SECTION MUST CONTAIN EXECUTABLE SQL STATEMENTS, NOT COMMENTS.
- Output one CREATE TABLE IF NOT EXISTS statement for EVERY target table's staging equivalent.
- Staging table name = STG_ + target table name (e.g., STG_TC_MATTERS for TC_MATTERS).
- Each CREATE TABLE must include ALL columns from the target schema with their exact data types and NOT NULL constraints.
- Do NOT include FOREIGN KEY constraints on staging tables.
- Do NOT include indexes, triggers, or defaults that reference other tables.
- Use dialect-appropriate CREATE TABLE IF NOT EXISTS syntax.
- Tables must be created in FK dependency order (parents before children).
- Example for PostgreSQL:
  CREATE TABLE IF NOT EXISTS "STG_TC_MATTERS" (
      "matter_id" VARCHAR(255) NOT NULL,
      "matter_name" VARCHAR(500) NOT NULL,
      "status_cd" VARCHAR(4),
      ...
  );

SECTION 3 — TRUNCATE STAGING TABLES (EXECUTABLE SQL — NOT comments):
⚠️ THIS SECTION MUST CONTAIN EXECUTABLE SQL STATEMENTS, NOT COMMENTS.
- Output one TRUNCATE TABLE statement for EVERY staging table.
- Truncate in REVERSE FK dependency order (children first, then parents).
- Use dialect-appropriate TRUNCATE syntax (PostgreSQL: TRUNCATE TABLE "STG_TC_MATTERS"; T-SQL: TRUNCATE TABLE [STG_TC_MATTERS]; MySQL: TRUNCATE TABLE \`STG_TC_MATTERS\`;).
- This ensures the migration scripts can be re-run without producing duplicates.

If Section 2 or Section 3 is empty or contains only comments, the output is INVALID.

FILE 2..N — Per-Table Scripts (one per target table, in FK dependency order provided):
Each table file has FOUR sections:

SECTION A — EXTRACT QUERY
- The SELECT query to extract source data for this table.
- Apply all business-rule filters (status exclusions, null PK exclusion).
- For child tables: include WHERE parent_fk IN (SELECT pk FROM parent WHERE <same parent filters>).
- Add a comment above each WHERE clause explaining the filter.

SECTION B — TRANSFORM & STAGE
- A complete INSERT INTO STG_{target_table} (cols) SELECT exprs FROM source WHERE <filters>.
- The INSERT target is the STAGING table (STG_ prefix), NEVER the target table directly.
- Use the EXACT approved transformation SQL verbatim for fields that have it.
- For fields without transform SQL: generate appropriate type casting or direct mapping.
- For NOT NULL target fields where source can be NULL: use COALESCE with a sensible default.
- Format each column expression on its own line with a comment.

SECTION C — STAGING VALIDATION
- Row count check: two independent SELECT COUNT(*) queries — one on source (same filters as Section B), one on STG_{target_table}.
- Sample spot-check: SELECT the first 5 rows from STG_{target_table} using the dialect-appropriate syntax (LIMIT 5 for PostgreSQL/MySQL, TOP 5 for T-SQL).
- Do NOT check FK integrity here — that is cross-table and belongs in the Post-Staging Validation file.

SECTION D — TABLE ROLLBACK
- A TRUNCATE TABLE STG_{target_table} statement (use dialect-appropriate identifier quoting).
- This rolls back staging only — target tables are untouched at this stage.

FILE N+1 — Post-Staging Validation (numbered after last table):
- Cross-table record count reconciliation: SELECT COUNT(*) source vs STG_{target_table} for every table.
- FK integrity checks across staging tables: LEFT JOIN STG_{parent} WHERE STG_{parent}.pk IS NULL pattern for every FK relationship (e.g., STG_TC_TIMEKEEPERS.org_id references STG_TC_ORGANIZATIONS.org_id).
- CHECK constraint validation: WHERE field NOT IN (...) pattern for every picklist field, querying STG_ tables.
- NOT NULL checks: SELECT COUNT(*) WHERE field IS NULL for every NOT NULL target field, querying STG_ tables.
- Aggregate reconciliation: independent SUM queries for key numeric fields, querying STG_ tables.
- End with a prominent comment: -- ⚠️ REVIEW ALL RESULTS ABOVE. DO NOT PROCEED TO PROMOTION (next file) UNLESS ALL CHECKS PASS.

FILE N+2 — Promote to Target (type: "promote"):
- Header comment block explaining this file promotes validated staging data to production target tables.
- Wrap ALL inserts in a single transaction (dialect-appropriate).
- For each target table in FK dependency order: INSERT INTO {target_table} SELECT * FROM STG_{target_table}.
- No transforms, no CASE statements, no WHERE clauses — just a clean column-for-column copy from staging to target.
- After all inserts: post-promotion row count verification — SELECT COUNT(*) from each target table and each STG_ table, confirming they match.
- Transaction ends with ROLLBACK by default — NOT COMMIT.
- Prominent comment: -- ⚠️ CHANGE ROLLBACK TO COMMIT ONLY AFTER VERIFYING ALL POST-PROMOTION COUNTS MATCH.

FILE 99 — Full Rollback (99_full_rollback.sql):
- DELETE FROM statements for ALL target tables in REVERSE FK dependency order (children first, then parents).
- Each DELETE on its own line with a comment identifying the table.
- After all target table deletions: TRUNCATE all STG_ tables in reverse dependency order.
- Post-rollback verification: SELECT COUNT(*) checks confirming BOTH target tables AND staging tables are empty.
- Wrap in a transaction (dialect-appropriate) with ROLLBACK not COMMIT — engineer must explicitly change to COMMIT.
- Include a prominent warning comment block at the top.

TRANSFORMATION RULES:
- Use the EXACT transformation SQL provided in the approved mappings when available. Do not rewrite or improve tested transforms.
- For fields without transform SQL: generate appropriate conversion logic based on types and business rules.
- Every transform expression must have a comment explaining what it does.

NULL SAFETY RULES:
- If a NOT NULL target field's source can produce NULL: use COALESCE with an explicit default.
- Never silently allow NULL into a NOT NULL field.`

// ── Main server action ────────────────────────────────────────────────────────

export async function generateExecutionPackage(
  projectId: string,
  dialect: SqlDialect = 'postgresql'
): Promise<ExecutionPackageResult | ExecutionPackageError> {
  try {
    // ── 1. Auth + ownership ──────────────────────────────────────────────────

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
    if (!(await checkProjectPermission(projectId, 'editor'))) {
      return { success: false, error: 'Insufficient permissions' }
    }

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) return { success: false, error: rateLimit.error ?? 'Rate limit exceeded' }

    const { data: project } = await supabase
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .single()
    if (!project) return { success: false, error: 'Access denied' }

    // ── 2. Fetch everything that only needs projectId (parallel) ─────────────

    const [
      { data: datasets },
      { data: approvedTMs },
      { data: qualityIssueRows },
      { data: validationRuleRows },
    ] = await Promise.all([
      supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId),
      supabaseAdmin
        .from('table_mappings')
        .select('id, source_table_id, target_table_id, confidence')
        .eq('project_id', projectId)
        .eq('status', 'approved'),
      supabaseAdmin
        .from('quality_issues')
        .select('id, severity, status, title, description, affected_records, generated_sql')
        .eq('project_id', projectId),
      supabaseAdmin
        .from('validation_rules')
        .select('id, name, description, rule_type, severity')
        .eq('project_id', projectId),
    ])

    const sourceDataset = datasets?.find((d) => d.role === 'source') ?? null
    const targetDataset = datasets?.find((d) => d.role === 'target') ?? null
    const allDatasetIds = (datasets ?? []).map((d) => d.id)
    const tmIds = (approvedTMs ?? []).map((tm) => tm.id)

    // ── 3. Fetch things that need dataset/TM IDs (parallel) ──────────────────

    const [
      { data: allTables },
      { data: fieldMappingRows },
      { data: schemaDocRows },
    ] = await Promise.all([
      supabaseAdmin
        .from('tables')
        .select('id, dataset_id, name, row_count')
        .in('dataset_id', allDatasetIds.length ? allDatasetIds : ['__none__']),
      tmIds.length > 0
        ? supabaseAdmin
            .from('field_mappings')
            .select('id, table_mapping_id, source_field_id, target_field_id, confidence, needs_transformation')
            .in('table_mapping_id', tmIds)
            .eq('status', 'approved')
            .or('is_contributing.is.null,is_contributing.eq.false')
        : Promise.resolve({ data: [] as FieldMappingRow[] }),
      // Schema docs scoped to datasets (schema type) OR to project (business_context type)
      allDatasetIds.length > 0
        ? supabaseAdmin
            .from('schema_documents')
            .select('dataset_id, project_id, doc_type, filename, extracted_text')
            .or(`project_id.eq.${projectId},dataset_id.in.(${allDatasetIds.join(',')})`)
            .not('extracted_text', 'is', null)
        : supabaseAdmin
            .from('schema_documents')
            .select('dataset_id, project_id, doc_type, filename, extracted_text')
            .eq('project_id', projectId)
            .eq('doc_type', 'business_context')
            .not('extracted_text', 'is', null),
    ])

    const sourceTables = (allTables ?? []).filter((t) => t.dataset_id === sourceDataset?.id)
    const targetTables = (allTables ?? []).filter((t) => t.dataset_id === targetDataset?.id)
    const sourceTableIds = sourceTables.map((t) => t.id)
    const targetTableIds = targetTables.map((t) => t.id)
    const fmIds = (fieldMappingRows ?? []).map((fm) => fm.id)

    // ── 4. Fetch field details + transformations (parallel) ───────────────────

    const [
      { data: sourceFieldRows },
      { data: targetFieldRows },
      { data: transformationRows },
    ] = await Promise.all([
      sourceTableIds.length > 0
        ? supabaseAdmin
            .from('fields')
            .select('id, table_id, name, data_type, inferred_type, ordinal_position')
            .in('table_id', sourceTableIds)
            .order('ordinal_position', { ascending: true })
        : Promise.resolve({ data: [] }),
      targetTableIds.length > 0
        ? supabaseAdmin
            .from('fields')
            .select('id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position')
            .in('table_id', targetTableIds)
            .order('ordinal_position', { ascending: true })
        : Promise.resolve({ data: [] }),
      fmIds.length > 0
        ? supabaseAdmin
            .from('transformations')
            .select('id, field_mapping_id, status, description, generated_sql')
            .in('field_mapping_id', fmIds)
        : Promise.resolve({ data: [] as TransformationRow[] }),
    ])

    // ── Build lookup maps ─────────────────────────────────────────────────────

    const sourceFieldMap = new Map((sourceFieldRows ?? []).map((f) => [f.id, f]))
    const targetFieldMap = new Map((targetFieldRows ?? []).map((f) => [f.id, f]))
    const sourceTableMap = new Map(sourceTables.map((t) => [t.id, t]))
    const targetTableMap = new Map(targetTables.map((t) => [t.id, t]))
    const tmMap = new Map((approvedTMs ?? []).map((tm) => [tm.id, tm]))

    // transformations keyed by field_mapping_id (take the latest/most relevant one)
    const transformByFMId = new Map<string, TransformationRow>()
    for (const tr of transformationRows ?? []) {
      const existing = transformByFMId.get(tr.field_mapping_id)
      // Prefer applied > tested > saved > draft
      const rank = (s: string) => ({ applied: 4, tested: 3, saved: 2, draft: 1 })[s] ?? 0
      if (!existing || rank(tr.status) > rank(existing.status)) {
        transformByFMId.set(tr.field_mapping_id, tr)
      }
    }

    // Source fields grouped by table
    const sourceFieldsByTable = new Map<string, typeof sourceFieldRows>()
    for (const f of sourceFieldRows ?? []) {
      const list = sourceFieldsByTable.get(f.table_id) ?? []
      list.push(f)
      sourceFieldsByTable.set(f.table_id, list)
    }

    // Target fields grouped by table
    const targetFieldsByTable = new Map<string, TargetFieldRow[]>()
    for (const f of (targetFieldRows ?? []) as TargetFieldRow[]) {
      const list = targetFieldsByTable.get(f.table_id) ?? []
      list.push(f)
      targetFieldsByTable.set(f.table_id, list)
    }

    // ── Compute load order ────────────────────────────────────────────────────

    const loadOrder = computeLoadOrder(
      targetTables.map((t) => ({ id: t.id, name: t.name })),
      (targetFieldRows ?? []) as TargetFieldRow[]
    )

    // ── Build document context string ─────────────────────────────────────────

    const sourceDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'schema' && d.dataset_id === sourceDataset?.id && d.extracted_text
    )
    const targetDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'schema' && d.dataset_id === targetDataset?.id && d.extracted_text
    )
    const bizDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'business_context' && d.extracted_text
    )

    const allDocParts: string[] = []
    for (const doc of [...sourceDocs, ...targetDocs, ...bizDocs]) {
      allDocParts.push(`--- ${doc.filename} (${doc.doc_type}) ---\n${(doc.extracted_text as string).slice(0, 12000)}`)
    }
    const docBlock = allDocParts.length > 0
      ? `<documentation>\n${allDocParts.join('\n\n')}\n</documentation>`
      : ''

    // ── Build quality issue sections ──────────────────────────────────────────

    const openBlocking = (qualityIssueRows ?? []).filter(
      (q) => q.severity === 'blocking' && q.status === 'open'
    )
    const openWarnings = (qualityIssueRows ?? []).filter(
      (q) => q.severity === 'warning' && q.status === 'open'
    )
    const fixedIssues = (qualityIssueRows ?? []).filter((q) => q.status === 'fixed')
    const acceptedRisks = (qualityIssueRows ?? []).filter((q) => q.status === 'accepted_risk')

    const blockingIssuesText = openBlocking.length > 0
      ? openBlocking.map((q) => {
          let line = `- [BLOCKING] ${q.title}: ${q.description} (${q.affected_records} records)`
          if (q.generated_sql) {
            line += `\n  Fix SQL (available, not yet applied): ${q.generated_sql.replace(/\n/g, ' ')}`
          }
          return line
        }).join('\n')
      : '  None.'

    const acceptedRisksText = acceptedRisks.length > 0
      ? acceptedRisks.map((q) =>
          `- ${q.title}: ${q.description} (${q.affected_records} records) — ACCEPTED`
        ).join('\n')
      : '  None.'

    // ── Build mapping sections ────────────────────────────────────────────────

    // Group field mappings by table mapping
    const fmsByTM = new Map<string, FieldMappingRow[]>()
    for (const fm of (fieldMappingRows ?? []) as FieldMappingRow[]) {
      const list = fmsByTM.get(fm.table_mapping_id) ?? []
      list.push(fm)
      fmsByTM.set(fm.table_mapping_id, list)
    }

    const mappingSections: string[] = []
    let totalFieldMappings = 0
    let totalTransformRules = 0

    for (const tm of approvedTMs ?? []) {
      const srcTable = sourceTableMap.get(tm.source_table_id)
      const tgtTable = targetTableMap.get(tm.target_table_id)
      if (!srcTable || !tgtTable) continue

      const fms = fmsByTM.get(tm.id) ?? []
      totalFieldMappings += fms.length

      const fieldLines: string[] = []
      for (const fm of fms) {
        const tgtField = targetFieldMap.get(fm.target_field_id) as TargetFieldRow | undefined
        if (!tgtField) continue

        const isValueAssignment = fm.source_field_id === null
        const srcField = fm.source_field_id ? sourceFieldMap.get(fm.source_field_id) : null
        if (!isValueAssignment && !srcField) continue

        const conf = fm.confidence != null ? ` [confidence: ${Math.round(fm.confidence * 100)}%]` : ''
        let line = isValueAssignment
          ? `  - [Value Assignment] → ${tgtField.name} (${tgtField.data_type})`
          : `  - ${srcField!.name} (${srcField!.data_type}) → ${tgtField.name} (${tgtField.data_type})${conf}`

        const transform = transformByFMId.get(fm.id)
        if (transform?.generated_sql) {
          totalTransformRules++
          line += `\n    Transform SQL: ${transform.generated_sql.replace(/\n/g, ' ')}`
          if (transform.description) {
            line += `\n    Description: ${transform.description}`
          }
        } else if (isValueAssignment) {
          line += `\n    ⚠ No value expression defined yet`
        } else if (fm.needs_transformation) {
          line += `\n    ⚠ Needs transformation (no SQL defined yet)`
        }

        fieldLines.push(line)
      }

      mappingSections.push(
        `### ${srcTable.name} → ${tgtTable.name}\n${fieldLines.join('\n') || '  (no approved field mappings)'}`
      )
    }

    // ── Build source tables section ───────────────────────────────────────────

    const sourceTablesText = sourceTables.map((t) => {
      const fields = sourceFieldsByTable.get(t.id) ?? []
      const fieldNames = fields.map((f) => f.name).join(', ')
      return `- ${t.name}: ${(t.row_count ?? 0).toLocaleString()} rows${fieldNames ? `, fields: ${fieldNames}` : ''}`
    }).join('\n') || '  (no source tables)'

    // ── Build target schema section ───────────────────────────────────────────

    const targetSchemaLines: string[] = []
    for (const entry of loadOrder) {
      const tgtTable = targetTables.find((t) => t.name === entry.tableName)
      if (!tgtTable) continue
      const fields = (targetFieldsByTable.get(tgtTable.id) ?? []) as TargetFieldRow[]
      targetSchemaLines.push(`### ${entry.tableName}`)
      targetSchemaLines.push('Fields:')
      for (const f of fields) {
        const flags: string[] = []
        if (!f.is_nullable) flags.push('NOT NULL')
        if (f.is_primary_key) flags.push('PK')
        if (f.is_foreign_key && f.fk_reference) flags.push(`FK→${f.fk_reference}`)
        targetSchemaLines.push(`  - ${f.name} ${f.data_type}${flags.length ? ' ' + flags.join(' ') : ''}`)
      }
    }

    // ── Build load order section ──────────────────────────────────────────────

    const loadOrderText = loadOrder.map((entry, i) => {
      const depNote = entry.dependencies.length > 0
        ? ` (depends on: ${entry.dependencies.join(', ')})`
        : ' (no dependencies)'
      return `${i + 1}. ${entry.tableName}${depNote}`
    }).join('\n') || '  (no target tables)'

    // ── Assemble the user prompt ──────────────────────────────────────────────

    const now = new Date().toISOString()

    const userMessage = `## Project
Migration: ${sourceDataset?.name ?? 'Unknown'} → ${targetDataset?.name ?? 'Unknown'}
Project: ${project.name}
Generated: ${now}

## Source Tables
${sourceTablesText}

## Target Schema
${targetSchemaLines.join('\n')}

## Approved Mappings
${mappingSections.join('\n\n') || '(no approved table mappings)'}

## Business Rules & Documentation
${docBlock || '(no documentation uploaded)'}

## Data Quality Summary
- Open blocking issues: ${openBlocking.length}
- Open warnings: ${openWarnings.length}
- Fixed issues: ${fixedIssues.length}
- Accepted risks: ${acceptedRisks.length}
- Active validation rules: ${(validationRuleRows ?? []).length}

### Open Blocking Issues
${blockingIssuesText}

### Accepted Risks
${acceptedRisksText}

## Load Order (FK-dependency resolved)
${loadOrderText}

## Instructions
Generate a SQL migration execution package with exactly 6 sections using the Source → Staging → Target pattern.
ALL transform-and-load scripts insert into STAGING tables (STG_ prefix), NEVER directly into target tables. The ONLY section that writes to target tables is Section 5 (Promote to Target).

SECTION 1 — PRE-MIGRATION CHECKLIST
- List all open blocking issues as SQL comments with severity and record counts.
- Include fix SQL for each issue if available (commented out with -- prefix, ready to uncomment and run).
- List all accepted risks as comments.
- Include a comment block with total source record counts per table.
- CRITICAL: Check every NOT NULL target field. If any source mapping or transformation could produce NULL for a NOT NULL target field, flag it here as a blocking issue with the specific field name and estimated affected row count.
- CREATE STAGING TABLES: Output CREATE TABLE IF NOT EXISTS STG_{target_table} for every target table. Schema mirrors target exactly (same columns, same types, same NOT NULL) but WITHOUT foreign key constraints.
- TRUNCATE STAGING TABLES: TRUNCATE all STG_ tables in reverse dependency order for idempotent re-runs.

SECTION 2 — EXTRACT QUERIES
- One SELECT query per source table.
- Apply filtering rules from the business rules documentation (e.g., status exclusions like excluding Archived records).
- Include WHERE clauses that exclude records with null or empty primary keys.
- DO NOT apply date-range or numeric-range filters here if the source field is VARCHAR — those filters belong in Section 3 after type conversion.
- For child tables, include a WHERE clause that filters to only records whose FK exists in the parent table AFTER the parent's own filters are applied. Example: WHERE customer_id IN (SELECT customer_id FROM Customers WHERE customer_id IS NOT NULL AND status != 'Archived')
- Add a comment above each WHERE clause explaining the filter criterion and which business rule it implements.

SECTION 3 — TRANSFORMATION & STAGING SCRIPTS
- Generate scripts in the load order specified above.
- For EACH target table, generate a complete:
    INSERT INTO STG_{target_table} (col1, col2, ...)
    SELECT
        -- source_field → target_field: description
        transform_expression AS col1,

        -- source_field → target_field: description
        transform_expression AS col2,
        ...
    FROM source_table
    WHERE <filters>;
- The INSERT target is ALWAYS the staging table (STG_ prefix), NEVER the target table directly.
- Use the EXACT approved transformation SQL for fields that have it — embed verbatim.
- For fields without explicit transforms, generate appropriate type casting or direct mapping.
- For NOT NULL target fields where the source can be NULL, use COALESCE with a sensible default.
- For unmapped target fields that have database DEFAULT values, omit them from the INSERT column list (let the database apply the default).
- Apply all filtering: null PK exclusion, business rule exclusions, parent-table existence checks for child tables.
- Date-range filters (e.g., close_date >= '2020-01-01') MUST be applied AFTER date parsing/conversion, not on the raw VARCHAR. Use a subquery or CTE if needed.
- Format each column expression on its own line with a descriptive comment.

SECTION 4 — POST-STAGING VALIDATION
Generate these validation queries against STAGING tables (STG_ prefix):
- Record count reconciliation: For each table mapping, generate TWO independent queries side by side:
    SELECT 'Source: table_name' AS label, COUNT(*) AS row_count FROM source_table WHERE <same filters as Section 3>;
    SELECT 'Staging: table_name' AS label, COUNT(*) AS row_count FROM STG_{target_table};
- FK integrity checks across staging tables: For every FK relationship:
    SELECT 'Orphaned records in STG_child.fk_field' AS check_name, COUNT(*) AS violations FROM STG_{child_table} c LEFT JOIN STG_{parent_table} p ON c.fk = p.pk WHERE p.pk IS NULL;
- CHECK constraint validation: For every picklist/code field with a CHECK constraint:
    SELECT 'Invalid values in STG_table.field' AS check_name, field_name, COUNT(*) AS violations FROM STG_{table} WHERE field NOT IN ('val1', 'val2', ...) GROUP BY field_name;
- NOT NULL checks: For every NOT NULL target field:
    SELECT 'NULL violations in STG_table.field' AS check_name, COUNT(*) AS violations FROM STG_{table} WHERE field IS NULL;
- Aggregate reconciliation: For key numeric fields (amounts, revenues), generate independent SUM queries:
    SELECT 'Source total: field' AS label, SUM(cleaned_expression) AS total FROM source_table WHERE <filters>;
    SELECT 'Staging total: field' AS label, SUM(field) AS total FROM STG_{target_table};
- End with: -- ⚠️ REVIEW ALL RESULTS ABOVE. DO NOT PROCEED TO PROMOTION (Section 5) UNLESS ALL CHECKS PASS.

SECTION 5 — PROMOTE TO TARGET
- Wrap all inserts in a single transaction (dialect-appropriate).
- For each target table in FK dependency order: INSERT INTO {target_table} SELECT * FROM STG_{target_table}.
- No transforms, no CASE statements — clean column-for-column copy from staging to target.
- After all inserts: post-promotion row count verification confirming target count = staging count for each table.
- Transaction ends with ROLLBACK by default — NOT COMMIT.
- Include: -- ⚠️ CHANGE ROLLBACK TO COMMIT ONLY AFTER VERIFYING ALL POST-PROMOTION COUNTS MATCH.

SECTION 6 — ROLLBACK
- Generate DELETE FROM statements for each target table in REVERSE load order (to respect FK constraints).
- After all target table deletions: TRUNCATE all STG_ tables in reverse dependency order.
- Post-rollback verification: SELECT COUNT(*) checks confirming both target and staging tables are empty.
- Wrap in BEGIN / ROLLBACK (not COMMIT) so the engineer must explicitly change ROLLBACK to COMMIT.
- Include a prominent warning comment block at the top of this section.`

    // ── Call Claude ───────────────────────────────────────────────────────────

    // Build dialect-aware system prompt
    const dialectSystemPrompt = EXECUTION_PACKAGE_SYSTEM_PROMPT
      + '\n\n'
      + getDialectInstructions(dialect)
      + getTransformAdaptationInstruction(dialect)

    let rawSql: string
    try {
      rawSql = await callClaude(dialectSystemPrompt, userMessage, 16000)
    } catch (err) {
      console.error('[generateExecutionPackage] Claude call failed:', err)
      return { success: false, error: 'Failed to generate execution package. Please try again.' }
    }

    if (!rawSql || rawSql.trim().length < 100) {
      return { success: false, error: 'Failed to generate execution package. Please try again.' }
    }

    // ── Post-process: prepend header ──────────────────────────────────────────

    const dialectLabels: Record<SqlDialect, string> = {
      postgresql: 'PostgreSQL',
      tsql: 'T-SQL (MS SQL Server)',
      mysql: 'MySQL',
    }

    const header = `-- ============================================================
-- MIGRATION EXECUTION PACKAGE
-- ${sourceDataset?.name ?? 'Source'} → ${targetDataset?.name ?? 'Target'}
-- Generated by Mine | ${now}
-- Project: ${project.name}
-- Dialect: ${dialectLabels[dialect]}
-- ============================================================
--
-- This package contains all SQL needed to execute the migration.
-- Review each section before executing. Sections should be run
-- in order. Section 3 scripts must be run in the load order shown.
--
-- Generated from ${(approvedTMs ?? []).length} approved table mappings,
-- ${totalFieldMappings} field mappings, and ${totalTransformRules} transformation rules.
-- ============================================================

`

    const finalSql = header + rawSql

    // ── Upload to storage + record in outputs table ───────────────────────────

    const version = await getNextVersionStr(projectId, 'execution_package', 'sql')
    const relativePath = `outputs/execution-package/migration_execution_package_v${version}_${dialect}.sql`
    const fullStoragePath = `${user.id}/${projectId}/${relativePath}`

    await supabaseAdmin.storage.from('project-files').upload(
      fullStoragePath,
      Buffer.from(finalSql, 'utf-8'),
      { contentType: 'text/plain; charset=utf-8', upsert: true }
    )

    await supabaseAdmin.from('outputs').insert({
      project_id: projectId,
      type: 'execution_package',
      format: 'sql',
      dialect,
      version,
      file_storage_path: fullStoragePath,
    })

    return {
      success: true,
      sqlContent: finalSql,
      storagePath: fullStoragePath,
      version,
      dialect,
    }
  } catch (err) {
    console.error('[generateExecutionPackage] Unexpected error:', err)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ── generateCompartmentalizedPackage ─────────────────────────────────────────

export async function generateCompartmentalizedPackage(
  projectId: string,
  dialect: SqlDialect = 'postgresql'
): Promise<CompartmentalizedPackageResult | ExecutionPackageError> {
  try {
    console.log('[COMPARTMENTALIZED] dialect received:', dialect)
    // ── 1. Auth + ownership ──────────────────────────────────────────────────

    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const { checkProjectPermission } = await import('@/lib/actions/role-resolution')
    if (!(await checkProjectPermission(projectId, 'editor'))) {
      return { success: false, error: 'Insufficient permissions' }
    }

    const rateLimit = checkAIRateLimit(user.id)
    if (!rateLimit.allowed) return { success: false, error: rateLimit.error ?? 'Rate limit exceeded' }

    const { data: project } = await supabase
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .single()
    if (!project) return { success: false, error: 'Access denied' }

    // ── 2. Fetch all data (same as monolithic generator) ────────────────────

    const [
      { data: datasets },
      { data: approvedTMs },
      { data: qualityIssueRows },
      { data: validationRuleRows },
    ] = await Promise.all([
      supabaseAdmin.from('datasets').select('id, role, name').eq('project_id', projectId),
      supabaseAdmin
        .from('table_mappings')
        .select('id, source_table_id, target_table_id, confidence')
        .eq('project_id', projectId)
        .eq('status', 'approved'),
      supabaseAdmin
        .from('quality_issues')
        .select('id, severity, status, title, description, affected_records, generated_sql')
        .eq('project_id', projectId),
      supabaseAdmin
        .from('validation_rules')
        .select('id, name, description, rule_type, severity')
        .eq('project_id', projectId),
    ])

    const sourceDataset = datasets?.find((d) => d.role === 'source') ?? null
    const targetDataset = datasets?.find((d) => d.role === 'target') ?? null
    const allDatasetIds = (datasets ?? []).map((d) => d.id)
    const tmIds = (approvedTMs ?? []).map((tm) => tm.id)

    const [
      { data: allTables },
      { data: fieldMappingRows },
      { data: schemaDocRows },
    ] = await Promise.all([
      supabaseAdmin
        .from('tables')
        .select('id, dataset_id, name, row_count')
        .in('dataset_id', allDatasetIds.length ? allDatasetIds : ['__none__']),
      tmIds.length > 0
        ? supabaseAdmin
            .from('field_mappings')
            .select('id, table_mapping_id, source_field_id, target_field_id, confidence, needs_transformation')
            .in('table_mapping_id', tmIds)
            .eq('status', 'approved')
            .or('is_contributing.is.null,is_contributing.eq.false')
        : Promise.resolve({ data: [] as FieldMappingRow[] }),
      allDatasetIds.length > 0
        ? supabaseAdmin
            .from('schema_documents')
            .select('dataset_id, project_id, doc_type, filename, extracted_text')
            .or(`project_id.eq.${projectId},dataset_id.in.(${allDatasetIds.join(',')})`)
            .not('extracted_text', 'is', null)
        : supabaseAdmin
            .from('schema_documents')
            .select('dataset_id, project_id, doc_type, filename, extracted_text')
            .eq('project_id', projectId)
            .eq('doc_type', 'business_context')
            .not('extracted_text', 'is', null),
    ])

    const sourceTables = (allTables ?? []).filter((t) => t.dataset_id === sourceDataset?.id)
    const targetTables = (allTables ?? []).filter((t) => t.dataset_id === targetDataset?.id)
    const sourceTableIds = sourceTables.map((t) => t.id)
    const targetTableIds = targetTables.map((t) => t.id)
    const fmIds = (fieldMappingRows ?? []).map((fm) => fm.id)

    const [
      { data: sourceFieldRows },
      { data: targetFieldRows },
      { data: transformationRows },
    ] = await Promise.all([
      sourceTableIds.length > 0
        ? supabaseAdmin
            .from('fields')
            .select('id, table_id, name, data_type, inferred_type, ordinal_position')
            .in('table_id', sourceTableIds)
            .order('ordinal_position', { ascending: true })
        : Promise.resolve({ data: [] }),
      targetTableIds.length > 0
        ? supabaseAdmin
            .from('fields')
            .select('id, table_id, name, data_type, is_nullable, is_primary_key, is_foreign_key, fk_reference, ordinal_position')
            .in('table_id', targetTableIds)
            .order('ordinal_position', { ascending: true })
        : Promise.resolve({ data: [] }),
      fmIds.length > 0
        ? supabaseAdmin
            .from('transformations')
            .select('id, field_mapping_id, status, description, generated_sql')
            .in('field_mapping_id', fmIds)
        : Promise.resolve({ data: [] as TransformationRow[] }),
    ])

    // ── Build lookup maps ─────────────────────────────────────────────────────

    const sourceFieldMap = new Map((sourceFieldRows ?? []).map((f) => [f.id, f]))
    const targetFieldMap = new Map((targetFieldRows ?? []).map((f) => [f.id, f]))
    const sourceTableMap = new Map(sourceTables.map((t) => [t.id, t]))
    const targetTableMap = new Map(targetTables.map((t) => [t.id, t]))

    const transformByFMId = new Map<string, TransformationRow>()
    for (const tr of transformationRows ?? []) {
      const existing = transformByFMId.get(tr.field_mapping_id)
      const rank = (s: string) => ({ applied: 4, tested: 3, saved: 2, draft: 1 })[s] ?? 0
      if (!existing || rank(tr.status) > rank(existing.status)) {
        transformByFMId.set(tr.field_mapping_id, tr)
      }
    }

    const sourceFieldsByTable = new Map<string, typeof sourceFieldRows>()
    for (const f of sourceFieldRows ?? []) {
      const list = sourceFieldsByTable.get(f.table_id) ?? []
      list.push(f)
      sourceFieldsByTable.set(f.table_id, list)
    }

    const targetFieldsByTable = new Map<string, TargetFieldRow[]>()
    for (const f of (targetFieldRows ?? []) as TargetFieldRow[]) {
      const list = targetFieldsByTable.get(f.table_id) ?? []
      list.push(f)
      targetFieldsByTable.set(f.table_id, list)
    }

    // ── Compute load order ────────────────────────────────────────────────────

    const loadOrder = computeLoadOrder(
      targetTables.map((t) => ({ id: t.id, name: t.name })),
      (targetFieldRows ?? []) as TargetFieldRow[]
    )

    // ── Build document context string ──────────────────────────────────────

    const sourceDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'schema' && d.dataset_id === sourceDataset?.id && d.extracted_text
    )
    const targetDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'schema' && d.dataset_id === targetDataset?.id && d.extracted_text
    )
    const bizDocs = (schemaDocRows ?? []).filter(
      (d) => d.doc_type === 'business_context' && d.extracted_text
    )

    const allDocParts: string[] = []
    for (const doc of [...sourceDocs, ...targetDocs, ...bizDocs]) {
      allDocParts.push(`--- ${doc.filename} (${doc.doc_type}) ---\n${(doc.extracted_text as string).slice(0, 12000)}`)
    }
    const docBlock = allDocParts.length > 0
      ? `<documentation>\n${allDocParts.join('\n\n')}\n</documentation>`
      : ''

    // ── Build quality issue sections ────────────────────────────────────────

    const openBlocking = (qualityIssueRows ?? []).filter(
      (q) => q.severity === 'blocking' && q.status === 'open'
    )
    const openWarnings = (qualityIssueRows ?? []).filter(
      (q) => q.severity === 'warning' && q.status === 'open'
    )
    const fixedIssues = (qualityIssueRows ?? []).filter((q) => q.status === 'fixed')
    const acceptedRisks = (qualityIssueRows ?? []).filter((q) => q.status === 'accepted_risk')

    const blockingIssuesText = openBlocking.length > 0
      ? openBlocking.map((q) => {
          let line = `- [BLOCKING] ${q.title}: ${q.description} (${q.affected_records} records)`
          if (q.generated_sql) {
            line += `\n  Fix SQL (PostgreSQL syntax — adapt to target dialect): ${q.generated_sql.replace(/\n/g, ' ')}`
          }
          return line
        }).join('\n')
      : '  None.'

    const acceptedRisksText = acceptedRisks.length > 0
      ? acceptedRisks.map((q) =>
          `- ${q.title}: ${q.description} (${q.affected_records} records) — ACCEPTED`
        ).join('\n')
      : '  None.'

    // ── Build mapping sections ──────────────────────────────────────────────

    const fmsByTM = new Map<string, FieldMappingRow[]>()
    for (const fm of (fieldMappingRows ?? []) as FieldMappingRow[]) {
      const list = fmsByTM.get(fm.table_mapping_id) ?? []
      list.push(fm)
      fmsByTM.set(fm.table_mapping_id, list)
    }

    const mappingSections: string[] = []
    let totalFieldMappings = 0
    let totalTransformRules = 0

    for (const tm of approvedTMs ?? []) {
      const srcTable = sourceTableMap.get(tm.source_table_id)
      const tgtTable = targetTableMap.get(tm.target_table_id)
      if (!srcTable || !tgtTable) continue

      const fms = fmsByTM.get(tm.id) ?? []
      totalFieldMappings += fms.length

      const fieldLines: string[] = []
      for (const fm of fms) {
        const tgtField = targetFieldMap.get(fm.target_field_id) as TargetFieldRow | undefined
        if (!tgtField) continue

        const isValueAssignment = fm.source_field_id === null
        const srcField = fm.source_field_id ? sourceFieldMap.get(fm.source_field_id) : null
        if (!isValueAssignment && !srcField) continue

        const conf = fm.confidence != null ? ` [confidence: ${Math.round(fm.confidence * 100)}%]` : ''
        let line = isValueAssignment
          ? `  - [Value Assignment] → ${tgtField.name} (${tgtField.data_type})`
          : `  - ${srcField!.name} (${srcField!.data_type}) → ${tgtField.name} (${tgtField.data_type})${conf}`

        const transform = transformByFMId.get(fm.id)
        if (transform?.generated_sql) {
          totalTransformRules++
          line += `\n    Transform SQL: ${transform.generated_sql.replace(/\n/g, ' ')}`
          if (transform.description) {
            line += `\n    Description: ${transform.description}`
          }
        } else if (isValueAssignment) {
          line += `\n    ⚠ No value expression defined yet`
        } else if (fm.needs_transformation) {
          line += `\n    ⚠ Needs transformation (no SQL defined yet)`
        }

        fieldLines.push(line)
      }

      mappingSections.push(
        `### ${srcTable.name} → ${tgtTable.name}\n${fieldLines.join('\n') || '  (no approved field mappings)'}`
      )
    }

    // ── Build source tables section ─────────────────────────────────────────

    const sourceTablesText = sourceTables.map((t) => {
      const fields = sourceFieldsByTable.get(t.id) ?? []
      const fieldNames = fields.map((f) => f.name).join(', ')
      return `- ${t.name}: ${(t.row_count ?? 0).toLocaleString()} rows${fieldNames ? `, fields: ${fieldNames}` : ''}`
    }).join('\n') || '  (no source tables)'

    // ── Build target schema section ─────────────────────────────────────────

    const targetSchemaLines: string[] = []
    for (const entry of loadOrder) {
      const tgtTable = targetTables.find((t) => t.name === entry.tableName)
      if (!tgtTable) continue
      const fields = (targetFieldsByTable.get(tgtTable.id) ?? []) as TargetFieldRow[]
      targetSchemaLines.push(`### ${entry.tableName}`)
      targetSchemaLines.push('Fields:')
      for (const f of fields) {
        const flags: string[] = []
        if (!f.is_nullable) flags.push('NOT NULL')
        if (f.is_primary_key) flags.push('PK')
        if (f.is_foreign_key && f.fk_reference) flags.push(`FK→${f.fk_reference}`)
        targetSchemaLines.push(`  - ${f.name} ${f.data_type}${flags.length ? ' ' + flags.join(' ') : ''}`)
      }
    }

    // ── Build load order section ────────────────────────────────────────────

    const loadOrderText = loadOrder.map((entry, i) => {
      const depNote = entry.dependencies.length > 0
        ? ` (depends on: ${entry.dependencies.join(', ')})`
        : ' (no dependencies)'
      return `${i + 1}. ${entry.tableName}${depNote}`
    }).join('\n') || '  (no target tables)'

    // ── Assemble the user prompt ────────────────────────────────────────────

    const now = new Date().toISOString()
    const dialectLabel = dialect === 'tsql' ? 'T-SQL (MS SQL Server)' : dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'
    const identifierStyle = dialect === 'tsql' ? '[bracket] identifiers' : dialect === 'mysql' ? 'backtick identifiers' : 'double-quote identifiers'

    const userMessage = `## Project
Migration: ${sourceDataset?.name ?? 'Unknown'} → ${targetDataset?.name ?? 'Unknown'}
Project: ${project.name}
Generated: ${now}

## Source Tables
${sourceTablesText}

## Target Schema
${targetSchemaLines.join('\n')}

## Approved Mappings
${mappingSections.join('\n\n') || '(no approved table mappings)'}

## Business Rules & Documentation
${docBlock || '(no documentation uploaded)'}

## Data Quality Summary
- Open blocking issues: ${openBlocking.length}
- Open warnings: ${openWarnings.length}
- Fixed issues: ${fixedIssues.length}
- Accepted risks: ${acceptedRisks.length}
- Active validation rules: ${(validationRuleRows ?? []).length}

### Open Blocking Issues
${blockingIssuesText}

### Accepted Risks
${acceptedRisksText}

## Load Order (FK-dependency resolved)
${loadOrderText}

## Total Counts
${(approvedTMs ?? []).length} approved table mappings, ${totalFieldMappings} field mappings, ${totalTransformRules} transformation rules.

## Instructions
⚠️ CRITICAL: ALL SQL in ALL files MUST use ${dialectLabel} syntax with ${identifierStyle} for ALL identifiers. Do NOT use PostgreSQL-specific syntax (::type casting, ~, ||, TRIM(), REGEXP_REPLACE, SPLIT_PART, TO_DATE, INITCAP) regardless of what syntax appears in the Transform SQL or Quality Issue examples above. Adapt ALL SQL expressions to ${dialectLabel}.

Generate the compartmentalized migration scripts using the Source → Staging → Target pattern, following the system prompt rules exactly.
ALL per-table INSERT statements MUST target STG_{target_table} staging tables, NEVER the target tables directly.
Return one entry per target table (in the load order listed above, using the table names exactly as listed).
The "files" array must contain entries in this order:
1. Pre-migration checklist with CREATE/TRUNCATE staging tables (type: "checklist")
2. One entry per target table in the order listed above (type: "table_script") — use the exact table name in "table_name". Section B inserts into STG_{target_table}.
3. Post-staging validation against STG_ tables (type: "validation")
4. Promote to target — INSERT INTO {target} SELECT * FROM STG_{target} for each table (type: "promote")
5. Full rollback — DELETE target tables + TRUNCATE staging tables (type: "rollback")`

    // ── Call Claude ───────────────────────────────────────────────────────────

    const dialectSystemPrompt = COMPARTMENTALIZED_SYSTEM_PROMPT
      + '\n\n'
      + getDialectInstructions(dialect)
      + getTransformAdaptationInstruction(dialect)

    let rawResponse: string
    console.log('[COMPARTMENTALIZED] dialectInstructions first 100 chars:', getDialectInstructions(dialect).slice(0, 100))
    console.log('[COMPARTMENTALIZED] CRITICAL reminder dialect:', dialectLabel)
    try {
      // Must use streaming — the Anthropic SDK refuses non-streaming calls when max_tokens is
      // large enough that estimated generation time could exceed 10 minutes.
      // 32000 tokens gives enough budget for 6-10 tables of JSON-wrapped SQL.
      rawResponse = await callClaudeStreaming(dialectSystemPrompt, userMessage, 64000)
    } catch (err) {
      console.error('[generateCompartmentalizedPackage] Claude call failed:', err)
      return { success: false, error: 'Failed to generate compartmentalized package. Please try again.' }
    }

    console.log('[generateCompartmentalizedPackage] Raw response (first 500 chars):', rawResponse.slice(0, 500))
    console.log('[generateCompartmentalizedPackage] Raw response length:', rawResponse.length)
    console.log('[generateCompartmentalizedPackage] Raw response (last 200 chars):', rawResponse.slice(-200))

    // ── Parse JSON response ───────────────────────────────────────────────────

    interface ClaudeFileEntry {
      filename: string
      type: string
      content: string
      table_name?: string
      load_order?: number
      dependencies?: string[]
    }

    let claudeFiles: ClaudeFileEntry[]
    try {
      // Strip markdown fences (handles ```json, ```, or bare fences anywhere in the string)
      let cleaned = rawResponse.trim()

      // Remove leading ```json or ``` fence
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '')
      // Remove trailing ``` fence
      cleaned = cleaned.replace(/\n?```\s*$/i, '')
      cleaned = cleaned.trim()

      // If there is preamble text before the opening {, strip it
      const braceIdx = cleaned.indexOf('{')
      if (braceIdx > 0) {
        console.log('[generateCompartmentalizedPackage] Stripping preamble, starts at index', braceIdx)
        cleaned = cleaned.slice(braceIdx)
      }

      // If the JSON appears to be truncated (doesn't end with }) try to recover by finding the last complete file entry
      if (!cleaned.trimEnd().endsWith('}')) {
        console.warn('[generateCompartmentalizedPackage] Response may be truncated — attempting recovery')
        // Find the last complete "content": "..." block by locating the last full object close
        const lastClose = cleaned.lastIndexOf('}')
        if (lastClose !== -1) {
          // Walk back to find the outermost '}' that closes the files array and root object
          // Simple strategy: truncate to last '}' and try to close the structure
          cleaned = cleaned.slice(0, lastClose + 1)
          // Attempt to close the files array and root object if open
          const openBrackets = (cleaned.match(/\[/g) ?? []).length - (cleaned.match(/\]/g) ?? []).length
          const openBraces = (cleaned.match(/\{/g) ?? []).length - (cleaned.match(/\}/g) ?? []).length
          for (let i = 0; i < openBrackets; i++) cleaned += ']'
          for (let i = 0; i < openBraces; i++) cleaned += '}'
          console.log('[generateCompartmentalizedPackage] Recovery attempt — added', openBrackets, 'brackets,', openBraces, 'braces')
        }
      }

      console.log('[generateCompartmentalizedPackage] Attempting JSON parse, length:', cleaned.length)
      const sanitized = sanitizeClaudeJson(cleaned)
      const parsed = JSON.parse(sanitized) as { files: ClaudeFileEntry[] }
      if (!Array.isArray(parsed.files)) throw new Error('Missing files array')
      claudeFiles = parsed.files
      console.log('[generateCompartmentalizedPackage] Parsed', claudeFiles.length, 'files successfully')
    } catch (parseErr) {
      console.error('[generateCompartmentalizedPackage] JSON parse failed:', parseErr)
      console.error('[generateCompartmentalizedPackage] Response was (first 1000 chars):', rawResponse.slice(0, 1000))
      return {
        success: false,
        error: 'Failed to parse structured output from AI. Try generating again, or use the single-file format.',
      }
    }

    // ── Assign filenames in code using the authoritative loadOrder ─────────────
    //
    // Claude returns table_script entries keyed by table_name.
    // We re-number them using computeLoadOrder's output, which is the source of truth.

    const tableFilesByName = new Map<string, ClaudeFileEntry>()
    for (const f of claudeFiles) {
      if (f.type === 'table_script' && f.table_name) {
        tableFilesByName.set(f.table_name.toUpperCase(), f)
      }
    }

    const checklist = claudeFiles.find((f) => f.type === 'checklist')
    const validation = claudeFiles.find((f) => f.type === 'validation')
    const promote = claudeFiles.find((f) => f.type === 'promote')
    const rollback = claudeFiles.find((f) => f.type === 'rollback')

    const orderedTableFiles: ClaudeFileEntry[] = []
    for (const entry of loadOrder) {
      const match =
        tableFilesByName.get(entry.tableName.toUpperCase()) ??
        // fuzzy fallback: find by partial name match
        [...tableFilesByName.entries()].find(([k]) => k.includes(entry.tableName.toUpperCase()) || entry.tableName.toUpperCase().includes(k))?.[1]
      if (match) {
        orderedTableFiles.push({
          ...match,
          table_name: entry.tableName,
          dependencies: entry.dependencies,
        })
      } else {
        // Table had no script from Claude — generate a placeholder
        orderedTableFiles.push({
          filename: '',
          type: 'table_script',
          table_name: entry.tableName,
          dependencies: entry.dependencies,
          content: `-- ${entry.tableName}\n-- Script not generated — no approved mappings found for this table.\n`,
        })
      }
    }

    // Assign numeric filenames
    const assembledFiles: Array<ClaudeFileEntry & { assignedFilename: string }> = []

    if (checklist) {
      assembledFiles.push({ ...checklist, assignedFilename: '00_pre_migration_checklist.sql' })
    }

    orderedTableFiles.forEach((f, idx) => {
      const num = String(idx + 1).padStart(2, '0')
      const safeName = (f.table_name ?? `table_${idx + 1}`).replace(/[^A-Za-z0-9_]/g, '_')
      assembledFiles.push({ ...f, assignedFilename: `${num}_STG_${safeName}_stage.sql` })
    })

    const validationNum = orderedTableFiles.length + 1
    if (validation) {
      assembledFiles.push({ ...validation, assignedFilename: `${String(validationNum).padStart(2, '0')}_post_staging_validation.sql` })
    }

    if (promote) {
      const promoteNum = String(validationNum + 1).padStart(2, '0')
      assembledFiles.push({ ...promote, assignedFilename: `${promoteNum}_promote_to_target.sql` })
    }

    if (rollback) {
      assembledFiles.push({ ...rollback, assignedFilename: '99_full_rollback.sql' })
    }

    if (assembledFiles.length === 0) {
      return { success: false, error: 'No files were generated. Please try again.' }
    }

    // ── Dialect validation + monolithic fallback ──────────────────────────────
    //
    // Check the first table file's content for the expected identifier style.
    // If Claude generated the wrong dialect (long-context attention decay),
    // re-generate using the proven monolithic generator and split the output
    // into per-table files in code.

    const tableFiles = assembledFiles.filter((f) => f.type === 'table_script')
    const failedCount = tableFiles.filter((f) => !detectDialect(f.content, dialect)).length
    if (failedCount > 0) {
      console.warn(
        `[generateCompartmentalizedPackage] Dialect validation failed: ${failedCount}/${tableFiles.length} files have wrong dialect (expected ${dialect}) — triggering monolithic fallback`
      )

      // Build a monolithic user message: reuse the assembled data sections,
      // swap the ## Instructions block for the 6-section monolithic format.
      const instructionIdx = userMessage.indexOf('## Instructions')
      const baseMessage = instructionIdx !== -1 ? userMessage.slice(0, instructionIdx) : userMessage
      const monoUserMessage = baseMessage + MONOLITHIC_FALLBACK_INSTRUCTIONS

      const monoDialectSystemPrompt = EXECUTION_PACKAGE_SYSTEM_PROMPT
        + '\n\n'
        + getDialectInstructions(dialect)
        + getTransformAdaptationInstruction(dialect)

      let monoSql = ''
      try {
        monoSql = await callClaude(monoDialectSystemPrompt, monoUserMessage, 16000)
        console.log('[generateCompartmentalizedPackage] Monolithic fallback SQL length:', monoSql.length)
      } catch (fallbackErr) {
        console.error('[generateCompartmentalizedPackage] Monolithic fallback call failed:', fallbackErr)
        return { success: false, error: 'Dialect conversion failed. Please try again or use Single File format.' }
      }

      if (monoSql && monoSql.trim().length > 100) {
        const split = splitMonolithicSQL(monoSql, loadOrder)

        // Replace assembledFiles contents with the split monolithic sections
        assembledFiles.splice(0)

        if (split.checklist) {
          assembledFiles.push({
            filename: '00_pre_migration_checklist.sql',
            type: 'checklist',
            content: split.checklist,
            assignedFilename: '00_pre_migration_checklist.sql',
          })
        }

        orderedTableFiles.forEach((f, idx) => {
          const num = String(idx + 1).padStart(2, '0')
          const safeName = (f.table_name ?? `table_${idx + 1}`).replace(/[^A-Za-z0-9_]/g, '_')
          const assignedFilename = `${num}_STG_${safeName}_stage.sql`
          const tableContent =
            split.tableSections.get(f.table_name ?? '') ??
            `-- No staging script found for STG_${f.table_name} in fallback generation.\n`
          assembledFiles.push({
            filename: assignedFilename,
            type: 'table_script',
            content: tableContent,
            table_name: f.table_name,
            dependencies: f.dependencies,
            assignedFilename,
          })
        })

        const fbValidationNum = orderedTableFiles.length + 1
        if (split.validation) {
          const vName = `${String(fbValidationNum).padStart(2, '0')}_post_staging_validation.sql`
          assembledFiles.push({
            filename: vName,
            type: 'validation',
            content: split.validation,
            assignedFilename: vName,
          })
        }

        if (split.promote) {
          const pName = `${String(fbValidationNum + 1).padStart(2, '0')}_promote_to_target.sql`
          assembledFiles.push({
            filename: pName,
            type: 'promote',
            content: split.promote,
            assignedFilename: pName,
          })
        }

        if (split.rollback) {
          assembledFiles.push({
            filename: '99_full_rollback.sql',
            type: 'rollback',
            content: split.rollback,
            assignedFilename: '99_full_rollback.sql',
          })
        }

        console.log(
          '[generateCompartmentalizedPackage] Fallback complete — rebuilt',
          assembledFiles.length, 'files from monolithic SQL'
        )
      }
    }

    // ── Upload to storage ─────────────────────────────────────────────────────

    const version = await getNextVersionStr(projectId, 'execution_package', 'per_table')
    const versionFolder = `${user.id}/${projectId}/outputs/execution-package-v${version}_${dialect}`

    const uploadedFiles: CompartmentalizedFile[] = []
    let tableScriptIndex = 0

    for (const f of assembledFiles) {
      const storagePath = `${versionFolder}/${f.assignedFilename}`
      await supabaseAdmin.storage.from('project-files').upload(
        storagePath,
        Buffer.from(f.content, 'utf-8'),
        { contentType: 'text/plain; charset=utf-8', upsert: true }
      )
      const isTable = f.type === 'table_script'
      if (isTable) tableScriptIndex++
      uploadedFiles.push({
        filename: f.assignedFilename,
        type: f.type as CompartmentalizedFile['type'],
        content: f.content,
        table_name: f.table_name,
        load_order: isTable ? tableScriptIndex : undefined,
        dependencies: f.dependencies,
        storagePath,
      })
    }

    // ── Create ZIP ────────────────────────────────────────────────────────────

    const zip = new JSZip()
    for (const f of uploadedFiles) {
      zip.file(f.filename, f.content)
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
    const zipFilename = `migration_scripts_v${version}_${dialect}.zip`
    const zipStoragePath = `${versionFolder}/${zipFilename}`

    await supabaseAdmin.storage.from('project-files').upload(
      zipStoragePath,
      zipBuffer,
      { contentType: 'application/zip', upsert: true }
    )

    // ── Record in outputs table ───────────────────────────────────────────────

    await supabaseAdmin.from('outputs').insert({
      project_id: projectId,
      type: 'execution_package',
      format: 'per_table',
      dialect,
      version,
      file_storage_path: zipStoragePath,
      metadata: {
        output_format: 'per_table',
        file_count: uploadedFiles.length,
        files: uploadedFiles.map((f) => ({
          filename: f.filename,
          type: f.type,
          table_name: f.table_name ?? null,
          load_order: f.load_order ?? null,
          storage_path: f.storagePath,
        })),
      },
    })

    return {
      success: true,
      files: uploadedFiles,
      zipStoragePath,
      version,
      dialect,
    }
  } catch (err) {
    console.error('[generateCompartmentalizedPackage] Unexpected error:', err)
    return { success: false, error: 'An unexpected error occurred. Please try again.' }
  }
}

// ── generateExecutionPackageWithFormat — dispatcher ───────────────────────────

export async function generateExecutionPackageWithFormat(
  projectId: string,
  dialect: SqlDialect = 'postgresql',
  format: ExecutionPackageFormat = 'single_file'
): Promise<ExecutionPackageResult | CompartmentalizedPackageResult | ExecutionPackageError> {
  if (format === 'per_table') {
    return generateCompartmentalizedPackage(projectId, dialect)
  }
  return generateExecutionPackage(projectId, dialect)
}

// ── getCompartmentalizedPackageUrls ──────────────────────────────────────────

export async function getCompartmentalizedPackageUrls(projectId: string): Promise<{
  zipUrl?: string
  version?: string
  dialect?: string
  files?: Array<{ filename: string; type: string; table_name?: string; url: string }>
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { error: 'Access denied' }

  const { data: output } = await supabaseAdmin
    .from('outputs')
    .select('file_storage_path, version, generated_at, dialect, metadata')
    .eq('project_id', projectId)
    .eq('type', 'execution_package')
    .eq('format', 'per_table')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!output) return { error: 'No compartmentalized package found' }

  // Generate signed URL for the ZIP
  const { data: zipSigned } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  // Generate signed URLs for each individual file from the metadata manifest
  const manifest = (output.metadata as { files?: Array<{ filename: string; type: string; table_name?: string; storage_path?: string }> } | null)
  const signedFiles: Array<{ filename: string; type: string; table_name?: string; url: string }> = []

  if (manifest?.files) {
    for (const f of manifest.files) {
      if (!f.storage_path) continue
      const { data: signed } = await supabaseAdmin.storage
        .from('project-files')
        .createSignedUrl(f.storage_path, 3600)
      if (signed?.signedUrl) {
        signedFiles.push({
          filename: f.filename,
          type: f.type,
          table_name: f.table_name ?? undefined,
          url: signed.signedUrl,
        })
      }
    }
  }

  return {
    zipUrl: zipSigned?.signedUrl,
    version: output.version,
    dialect: output.dialect ?? undefined,
    files: signedFiles.length > 0 ? signedFiles : undefined,
  }
}

// ── getExecutionPackageUrl ────────────────────────────────────────────────────

export async function getExecutionPackageUrl(projectId: string): Promise<{
  url?: string
  version?: string
  generatedAt?: string
  error?: string
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .single()
  if (!project) return { error: 'Access denied' }

  const { data: output } = await supabaseAdmin
    .from('outputs')
    .select('file_storage_path, version, generated_at')
    .eq('project_id', projectId)
    .eq('type', 'execution_package')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!output?.file_storage_path) return { error: 'No execution package found' }

  const { data: signed } = await supabaseAdmin.storage
    .from('project-files')
    .createSignedUrl(output.file_storage_path, 3600)

  if (!signed?.signedUrl) return { error: 'Failed to generate download URL' }

  return {
    url: signed.signedUrl,
    version: output.version,
    generatedAt: output.generated_at,
  }
}
